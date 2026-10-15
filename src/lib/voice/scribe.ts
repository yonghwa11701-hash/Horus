import { fromByteArray } from 'base64-js';
import { Pcm16Resampler, type MicrophoneBuffer } from './pcm.ts';

export type ScribeFinal = { text: string; start_ms: number; end_ms: number };
export type ScribeDiagnostics = {
  connected: boolean;
  sent_ms: number;
  buffered_ms: number;
  commit_requests: number;
  commit_confirmations: number;
  partial_events: number;
  final_events: number;
  last_event: string;
};
export const EMPTY_SCRIBE_DIAGNOSTICS: ScribeDiagnostics = {
  connected: false, sent_ms: 0, buffered_ms: 0, commit_requests: 0,
  commit_confirmations: 0, partial_events: 0, final_events: 0, last_event: 'not_connected',
};
type Callbacks = {
  onPartial: (text: string) => void;
  onFinal: (segment: ScribeFinal) => void;
  onError: (error: Error) => void;
};
type PendingCommit = {
  boundary: number;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const COMMIT_SAMPLES = 5 * 16000;
const MAX_BUFFERED_BYTES = 512 * 1024;

export class ScribeConnection {
  private socket?: WebSocket;
  private ready = false;
  private closing = false;
  private finishing = false;
  private failure?: Error;
  private resampler = new Pcm16Resampler();
  private sentSamples = 0;
  private confirmedSamples = 0;
  private queued: Uint8Array[] = [];
  private queuedBytes = 0;
  private lastEndMs = 0;
  private commit?: PendingCommit;
  private cancelConnect?: () => void;
  private callbacks: Callbacks;
  private offsetMs: number;
  private commitRequests = 0;
  private commitConfirmations = 0;
  private partialEvents = 0;
  private finalEvents = 0;
  private lastEvent = 'not_connected';

  constructor(callbacks: Callbacks, offsetMs: number) {
    this.callbacks = callbacks;
    this.offsetMs = offsetMs;
  }

  get hasUnconfirmedAudio() { return this.sentSamples > this.confirmedSamples || this.queuedBytes > 0; }

  get diagnostics(): ScribeDiagnostics {
    return {
      connected: this.ready, sent_ms: Math.round(this.sentSamples / 16), buffered_ms: this.closing ? 0 : Math.round(this.queuedBytes / 32),
      commit_requests: this.commitRequests, commit_confirmations: this.commitConfirmations,
      partial_events: this.partialEvents, final_events: this.finalEvents, last_event: this.lastEvent,
    };
  }

  async connect(token: string): Promise<void> {
    if (this.socket || this.closing) throw new Error('Create a fresh transcription connection to reconnect.');
    // Single-use token only; never log this URL. Manual commits are serialized because
    // Scribe does not echo a commit id: VAD events cannot prove our final commit completed.
    const query = new URLSearchParams({
      token, model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000',
      commit_strategy: 'manual', include_timestamps: 'true',
    });
    this.lastEvent = 'connecting';
    const socket = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${query}`);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Transcription connection timed out.'));
        this.close();
      }, 15000);
      this.cancelConnect = () => { clearTimeout(timer); reject(this.failure ?? new Error('Transcription connection cancelled.')); };
      socket.onmessage = (event) => {
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(String(event.data));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
          message = parsed as Record<string, unknown>;
        } catch { this.fail(new Error('Transcription returned an invalid message.')); return; }
        if (this.closing) return;
        const eventType = typeof message.message_type === 'string' && /^[a-z_]{1,64}$/.test(message.message_type)
          ? message.message_type : 'unknown_event';
        this.lastEvent = eventType;
        if (message.message_type === 'session_started') {
          clearTimeout(timer);
          this.cancelConnect = undefined;
          this.ready = true;
          resolve();
        } else if (message.message_type === 'partial_transcript' && typeof message.text === 'string') {
          this.partialEvents++;
          this.callbacks.onPartial(message.text);
        } else if (message.message_type === 'committed_transcript_with_timestamps' && typeof message.text === 'string') {
          this.confirmCommit(message);
        } else if ('error' in message || String(message.message_type).endsWith('_error')) {
          this.fail(new Error(`Transcription provider returned ${eventType}. Check ElevenLabs permissions, connectivity and provider quota.`));
        }
        // Plain committed_transcript is paired with the timestamped event; ignore it.
      };
      socket.onerror = () => this.fail(new Error('Could not connect to the transcription service.'));
      socket.onclose = () => {
        this.ready = false;
        if (!this.closing) this.fail(new Error('Transcription disconnected. Some audio may be unconfirmed.'));
      };
    });
  }

  send(buffer: MicrophoneBuffer) {
    if (!this.ready || this.finishing) return;
    const bytes = this.resampler.convert(buffer);
    if (!bytes.length) return;
    if ((this.socket?.bufferedAmount ?? 0) + this.queuedBytes + bytes.length > MAX_BUFFERED_BYTES) {
      throw new Error('Audio upload cannot keep up. Pause and check your connection.');
    }
    this.queued.push(bytes);
    this.queuedBytes += bytes.length;
    this.flushQueued();
  }

  private flushQueued() {
    // No subsequent audio reaches Scribe while a commit is awaiting confirmation.
    // This also keeps each window below Scribe's automatic ~36-second commit limit.
    while (!this.commit && this.queued.length) {
      const bytes = this.queued.shift()!;
      this.queuedBytes -= bytes.length;
      try { this.transmit(bytes, false); }
      catch (error) { this.fail(error instanceof Error ? error : new Error('Audio upload failed.')); return; }
      if (this.sentSamples - this.confirmedSamples >= COMMIT_SAMPLES) {
        void this.requestCommit().catch((error: Error) => this.fail(error));
      }
    }
  }

  private transmit(bytes: Uint8Array, commit: boolean) {
    if (!this.ready || !this.socket) throw new Error('Transcription is not connected.');
    this.sentSamples += bytes.length / 2;
    this.socket.send(JSON.stringify({
      message_type: 'input_audio_chunk', audio_base_64: fromByteArray(bytes), commit, sample_rate: 16000,
    }));
  }

  private requestCommit(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.ready) return Promise.reject(new Error('Transcription is not connected.'));
    if (this.commit) return this.commit.completion;
    // Scribe starts processing after ~2 seconds. Include known silence for short tails.
    // Acknowledgement covers this entire boundary, NOT merely the final word timestamp.
    const paddingSamples = Math.max(1600, 32000 - (this.sentSamples - this.confirmedSamples));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => this.fail(new Error('Final audio was not confirmed. Review and acknowledge any missing words before ending.')), 10000);
    this.commit = { boundary: this.sentSamples + paddingSamples, completion, resolve, reject, timer };
    this.commitRequests++;
    try { this.transmit(new Uint8Array(paddingSamples * 2), true); }
    catch (error) { this.fail(error instanceof Error ? error : new Error('Could not commit final audio.')); }
    return completion;
  }

  private confirmCommit(message: Record<string, unknown>) {
    const pending = this.commit;
    if (!pending) {
      this.fail(new Error('An unexpected transcription commit could not be matched to its audio.'));
      return;
    }
    const words = Array.isArray(message.words) ? message.words.filter((word: unknown): word is { start: number; end: number } =>
      !!word && typeof word === 'object' && 'start' in word && 'end' in word &&
      typeof word.start === 'number' && Number.isFinite(word.start) && word.start >= 0 &&
      typeof word.end === 'number' && Number.isFinite(word.end) && word.end >= word.start) : [];
    const start = words.length ? words[0].start * 1000 : this.lastEndMs;
    const end = words.length ? words[words.length - 1].end * 1000 : pending.boundary / 16;
    const startMs = Math.max(this.lastEndMs, Math.round(Math.min(start, pending.boundary / 16)));
    const endMs = Math.max(startMs, Math.round(Math.min(end, pending.boundary / 16)));
    this.commitConfirmations++;
    this.finalEvents++;
    this.confirmedSamples = pending.boundary;
    this.commit = undefined;
    clearTimeout(pending.timer);
    const text = String(message.text).trim();
    if (text) this.callbacks.onFinal({ text, start_ms: this.offsetMs + startMs, end_ms: this.offsetMs + endMs });
    this.lastEndMs = endMs;
    this.callbacks.onPartial('');
    pending.resolve();
    if (!this.finishing && !this.closing) this.flushQueued();
  }

  // Stop capture first, await EVERY serialized commit including the buffered tail,
  // then flush persistence. A timeout is never interpreted as silence/success.
  async finish(): Promise<void> {
    this.finishing = true;
    try {
      if (this.failure) throw this.failure;
      if (!this.ready && this.hasUnconfirmedAudio) throw new Error('Final audio was not confirmed.');
      while (this.hasUnconfirmedAudio || this.commit) {
        if (this.failure) throw this.failure;
        if (this.commit) { await this.commit.completion; continue; }
        this.flushQueued();
        if (this.failure) throw this.failure;
        if (!this.commit && this.sentSamples > this.confirmedSamples) await this.requestCommit();
      }
    } finally { this.close(); }
  }

  private fail(error: Error) {
    if (this.failure || this.closing) return;
    this.failure = error;
    this.close();
    this.callbacks.onError(error);
  }

  close() {
    this.closing = true;
    this.ready = false;
    this.cancelConnect?.();
    this.cancelConnect = undefined;
    if (this.commit) {
      clearTimeout(this.commit.timer);
      this.commit.reject(this.failure ?? new Error('Transcription was interrupted before final audio was confirmed.'));
      this.commit = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    // Audio never persists beyond the live connection, including failure/discard.
    // Keep queuedBytes as an uncertainty marker after releasing the buffers.
    this.queued = [];
    this.resampler = new Pcm16Resampler();
  }
}
