import { fromByteArray } from 'base64-js';
import { Pcm16Resampler, type MicrophoneBuffer } from './pcm';

export type ScribeFinal = { text: string; start_ms: number; end_ms: number };
type Callbacks = {
  onPartial: (text: string) => void;
  onFinal: (segment: ScribeFinal) => void;
  onError: (error: Error) => void;
};

export class ScribeConnection {
  private socket?: WebSocket;
  private ready = false;
  private closing = false;
  private resampler = new Pcm16Resampler();
  private sentSamples = 0;
  private uncommittedSamples = 0;
  private partial = '';
  private lastEndMs = 0;
  private drain?: () => void;
  private failDrain?: (error: Error) => void;
  private cancelConnect?: () => void;

  constructor(private callbacks: Callbacks, private offsetMs: number) {}

  async connect(token: string): Promise<void> {
    // ElevenLabs explicitly requires the short-lived single-use token in this query.
    // Never log this URL. The long-lived provider API key stays server-side.
    const query = new URLSearchParams({
      token, model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000',
      commit_strategy: 'vad', include_timestamps: 'true',
    });
    const socket = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${query}`);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let started = false;
      const fail = (error: Error) => {
        clearTimeout(timer);
        this.cancelConnect = undefined;
        if (!started) reject(error);
        else if (!this.closing) this.callbacks.onError(error);
        this.failDrain?.(error);
      };
      const timer = setTimeout(() => { fail(new Error('Transcription connection timed out.')); this.close(); }, 15000);
      this.cancelConnect = () => { clearTimeout(timer); reject(new Error('Transcription connection cancelled.')); };
      socket.onmessage = (event) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(String(event.data)); }
        catch { fail(new Error('Transcription returned an invalid message.')); return; }
        if (message.message_type === 'session_started') {
          clearTimeout(timer);
          started = true;
          this.cancelConnect = undefined;
          this.ready = true;
          resolve();
        } else if (message.message_type === 'partial_transcript' && typeof message.text === 'string') {
          this.partial = message.text;
          this.callbacks.onPartial(message.text);
        } else if (message.message_type === 'committed_transcript_with_timestamps' && typeof message.text === 'string') {
          // Ignore the plain committed_transcript event to avoid persisting each segment twice.
          const words = Array.isArray(message.words) ? message.words.filter((word: unknown): word is { start: number; end: number } =>
            !!word && typeof word === 'object' && 'start' in word && 'end' in word &&
            typeof word.start === 'number' && Number.isFinite(word.start) &&
            typeof word.end === 'number' && Number.isFinite(word.end)) : [];
          const start = words.length ? words[0].start * 1000 : this.lastEndMs;
          const end = words.length ? words[words.length - 1].end * 1000 : this.sentSamples / 16;
          const startMs = Math.max(this.lastEndMs, Math.round(start));
          const endMs = Math.max(startMs, Math.round(end));
          if (message.text.trim()) this.callbacks.onFinal({
            text: message.text.trim(), start_ms: this.offsetMs + startMs, end_ms: this.offsetMs + endMs,
          });
          this.lastEndMs = endMs;
          this.uncommittedSamples = Math.max(0, this.sentSamples - Math.round(endMs * 16));
          this.partial = '';
          this.callbacks.onPartial('');
          this.drain?.();
        } else if ('error' in message || String(message.message_type).endsWith('_error')) {
          // Provider error bodies can contain request details; surface only a generic message.
          fail(new Error('Transcription stopped. Check microphone access, connectivity and provider quota.'));
        }
      };
      socket.onerror = () => fail(new Error('Could not connect to the transcription service.'));
      socket.onclose = () => {
        this.ready = false;
        if (!this.closing) fail(new Error('Transcription disconnected. Resume to reconnect with a fresh token.'));
      };
    });
  }

  send(buffer: MicrophoneBuffer) {
    if (!this.ready || !this.socket) return;
    if (this.socket.bufferedAmount > 512 * 1024) {
      throw new Error('Audio upload cannot keep up. Pause and check your connection.');
    }
    const bytes = this.resampler.convert(buffer);
    if (!bytes.length) return;
    this.sentSamples += bytes.length / 2;
    this.uncommittedSamples += bytes.length / 2;
    this.socket.send(JSON.stringify({
      message_type: 'input_audio_chunk', audio_base_64: fromByteArray(bytes), commit: false, sample_rate: 16000,
    }));
  }

  // Caller stops the microphone first. Do not transition the session until this and
  // the persistence queue finish, otherwise the final words would be rejected.
  async finish(): Promise<void> {
    if (!this.ready || !this.socket) { this.close(); return; }
    if (this.uncommittedSamples > 0) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (this.partial.trim()) reject(new Error('Final words were not confirmed. Keep the session open and retry.'));
            else resolve(); // Silence may not produce a final transcript.
          }, 5000);
          this.drain = () => { clearTimeout(timer); resolve(); };
          this.failDrain = (error) => { clearTimeout(timer); reject(error); };
          this.socket?.send(JSON.stringify({
            message_type: 'input_audio_chunk', audio_base_64: fromByteArray(new Uint8Array(3200)),
            commit: true, sample_rate: 16000,
          }));
        });
      } finally {
        this.drain = undefined;
        this.failDrain = undefined;
        this.close();
      }
    } else this.close();
  }

  close() {
    this.closing = true;
    this.ready = false;
    this.cancelConnect?.();
    this.cancelConnect = undefined;
    this.failDrain?.(new Error('Transcription was interrupted before final words were confirmed.'));
    this.socket?.close();
    this.socket = undefined;
  }
}
