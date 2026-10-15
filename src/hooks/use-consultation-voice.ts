import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  appendFinalTranscript, discardConsultation, getScribeToken, loadTranscriptCursor, setSessionStatus,
} from '@/lib/consultations';
import { EMPTY_SCRIBE_DIAGNOSTICS, ScribeConnection } from '@/lib/voice/scribe';
import { voiceDebug } from '@/lib/voice/debug';
import type { MicrophoneBuffer } from '@/lib/voice/pcm';
import type { FinalTranscriptInput, TranscriptSegment } from '@/types/consultation';
import { useMicrophone } from './use-microphone';

type VoicePhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'error';
type Options = {
  sessionId: string;
  onSegment?: (segment: TranscriptSegment) => void;
  onError?: (error: Error) => void;
};

// Person 1: mount once per consultation (key={sessionId}), after createConsultation(consent).
// start/resume -> pause or end. end returns an ending session; then call Person 3's
// finalizeConsultation. Never finalize while pendingCount > 0 or after a failed end.
export function useConsultationVoice(options: Options) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [unconfirmedAudio, setUnconfirmedAudio] = useState(false);
  const unconfirmed = useRef(false);
  const connection = useRef<ScribeConnection | null>(null);
  const queue = useRef<FinalTranscriptInput[]>([]);
  const draining = useRef<Promise<void> | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const stopMicrophone = useRef<() => void>(() => {});
  const diagnosticSource = useRef<ScribeConnection | null>(null);
  const lastDebugAt = useRef(0);
  const microphoneStats = useRef({ captured_ms: 0, level: 0, max_level: 0, sample_rate: 0, last_buffer: 0 });
  const [diagnostics, setDiagnostics] = useState({
    ...EMPTY_SCRIBE_DIAGNOSTICS, captured_ms: 0, level_percent: 0, max_level_percent: 0, sample_rate: 0,
  });

  useEffect(() => {
    voiceDebug('state', { phase });
    const update = () => {
      const mic = microphoneStats.current;
      const snapshot = {
        ...(diagnosticSource.current?.diagnostics ?? EMPTY_SCRIBE_DIAGNOSTICS),
        captured_ms: Math.round(mic.captured_ms), sample_rate: mic.sample_rate,
        level_percent: Date.now() - mic.last_buffer < 1000 ? Math.round(mic.level * 10000) / 100 : 0,
        max_level_percent: Math.round(mic.max_level * 10000) / 100,
      };
      setDiagnostics(snapshot);
      if (phase !== 'idle' && Date.now() - lastDebugAt.current >= 1000) {
        lastDebugAt.current = Date.now();
        voiceDebug('audio', { ...snapshot, phase });
      }
    };
    update();
    if (phase !== 'starting' && phase !== 'recording' && phase !== 'stopping') return;
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [phase]);

  const markUnconfirmed = useCallback(() => {
    unconfirmed.current = true;
    setUnconfirmedAudio(true);
  }, []);

  const reportError = useCallback((value: unknown) => {
    const error = value instanceof Error ? value : new Error('Voice capture failed.');
    voiceDebug('error', { stage: 'voice', outcome: 'failure', ...(diagnosticSource.current?.diagnostics ?? {}) });
    if (connection.current?.hasUnconfirmedAudio) markUnconfirmed();
    stopMicrophone.current();
    connection.current?.close();
    connection.current = null;
    setPhase('error');
    callbacks.current.onError?.(error);
    return error;
  }, [markUnconfirmed]);

  const onBuffer = useCallback((buffer: MicrophoneBuffer) => {
    try {
      if (buffer.sampleRate <= 0 || buffer.channels <= 0) throw new Error('Invalid microphone format.');
      const width = buffer.encoding === 'int16' ? 2 : 4;
      const samples = Math.floor(buffer.data.byteLength / width);
      const view = new DataView(buffer.data);
      let peak = 0;
      for (let index = 0; index < samples; index++) {
        const value = buffer.encoding === 'int16' ? view.getInt16(index * width, true) / 32768 : view.getFloat32(index * width, true);
        if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
      }
      const mic = microphoneStats.current;
      mic.captured_ms += samples / buffer.channels / buffer.sampleRate * 1000;
      mic.level = Math.min(1, peak);
      mic.max_level = Math.max(mic.max_level, mic.level);
      mic.sample_rate = buffer.sampleRate;
      mic.last_buffer = Date.now();
      connection.current?.send(buffer);
    }
    catch (error) {
      stopMicrophone.current();
      connection.current?.close();
      reportError(error);
    }
  }, [reportError]);
  const microphone = useMicrophone(onBuffer);
  stopMicrophone.current = microphone.stop;

  const flush = useCallback((): Promise<void> => {
    if (draining.current) return draining.current;
    draining.current = (async () => {
      while (queue.current.length) {
        // Shift only after acknowledgement. Retry uses the SAME id and sequence.
        const pending = queue.current[0];
        voiceDebug('save', { stage: 'transcript', outcome: 'requested', sequence: pending.sequence, text_chars: pending.text.length });
        const { segment } = await appendFinalTranscript(pending);
        voiceDebug('save', { stage: 'transcript', outcome: 'success', sequence: segment.sequence, text_chars: segment.text.length });
        queue.current.shift();
        setPendingCount(queue.current.length);
        callbacks.current.onSegment?.(segment);
      }
    })().finally(() => { draining.current = null; });
    return draining.current;
  }, []);

  const start = useCallback(async () => {
    if (unconfirmed.current) throw new Error('Review and explicitly acknowledge the unconfirmed audio before resuming.');
    if (busy.current || connection.current) throw new Error('Voice is already starting or running.');
    busy.current = true;
    const version = generation.current;
    setPhase('starting');
    voiceDebug('start', { stage: 'voice', outcome: 'requested' });
    microphoneStats.current = { captured_ms: 0, level: 0, max_level: 0, sample_rate: 0, last_buffer: 0 };
    diagnosticSource.current = null;
    try {
      // Invoke capture inside the click, before ANY await/network work. Otherwise
      // browser autoplay policy can leave AudioContext.resume() waiting indefinitely.
      // Do not speak until recording: buffers are ignored while Scribe is connecting.
      await microphone.start();
      voiceDebug('start', { stage: 'microphone', outcome: 'success' });
      if (version !== generation.current) throw new Error('Voice start cancelled.');
      await flush();
      await setSessionStatus(options.sessionId, 'active');
      const cursor = await loadTranscriptCursor(options.sessionId);
      let sequence = cursor.sequence;
      if (version !== generation.current) throw new Error('Voice start cancelled.');
      const { token } = await getScribeToken(options.sessionId);
      if (version !== generation.current) throw new Error('Voice start cancelled.');
      const scribe = new ScribeConnection({
        onPartial: setPartialTranscript,
        onFinal: (segment) => {
          queue.current.push({ ...segment, id: randomUUID(), session_id: options.sessionId, sequence: sequence++, source: 'elevenlabs' });
          setPendingCount(queue.current.length);
          void flush().catch(reportError);
        },
        onError: reportError,
        onEvent: (metrics, textCharacters) => voiceDebug('scribe', { ...metrics, text_chars: textCharacters }),
      }, cursor.offsetMs);
      connection.current = scribe;
      diagnosticSource.current = scribe;
      await scribe.connect(token);
      if (version !== generation.current) throw new Error('Voice start cancelled.');
      setPhase('recording');
    } catch (error) {
      microphone.stop();
      connection.current?.close();
      connection.current = null;
      if (version === generation.current) reportError(error);
      throw error;
    } finally { busy.current = false; }
  }, [flush, microphone, options.sessionId, reportError]);

  const stop = useCallback(async () => {
    if (unconfirmed.current) throw new Error('Final audio is unconfirmed. Review the transcript and explicitly acknowledge missing audio before ending.');
    if (busy.current) throw new Error('Wait for the current voice operation to finish.');
    busy.current = true;
    setPhase('stopping');
    voiceDebug('stop', { stage: 'voice', outcome: 'requested' });
    microphone.stop();
    try {
      if (connection.current) {
        try { await connection.current.finish(); }
        catch (error) { markUnconfirmed(); throw error; }
      }
      connection.current = null;
      await flush();
      setPhase('idle');
      setPartialTranscript('');
    } catch (error) {
      connection.current?.close();
      connection.current = null;
      reportError(error);
      throw error;
    } finally { busy.current = false; }
  }, [flush, markUnconfirmed, microphone, reportError]);

  const pause = useCallback(async () => {
    await stop();
    return setSessionStatus(options.sessionId, 'paused');
  }, [options.sessionId, stop]);
  const end = useCallback(async () => {
    await stop();
    return setSessionStatus(options.sessionId, 'ending');
  }, [options.sessionId, stop]);
  const discard = useCallback(async () => {
    if (busy.current) throw new Error('Wait for the current voice operation to finish.');
    busy.current = true;
    microphone.stop();
    connection.current?.close();
    connection.current = null;
    queue.current = [];
    try {
      await draining.current?.catch(() => {});
      await discardConsultation(options.sessionId);
      voiceDebug('discard', { outcome: 'success' });
      setPendingCount(0);
      unconfirmed.current = false;
      setUnconfirmedAudio(false);
      setPartialTranscript('');
      setPhase('idle');
    } catch (error) { reportError(error); throw error; }
    finally { busy.current = false; }
  }, [microphone, options.sessionId, reportError]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        // Privacy: never keep the microphone running in the background.
        generation.current++;
        microphone.stop();
        if (connection.current?.hasUnconfirmedAudio) markUnconfirmed();
        connection.current?.close();
        connection.current = null;
        setPhase(unconfirmed.current ? 'error' : 'idle');
      }
    });
    return () => {
      generation.current++;
      subscription.remove();
      microphone.stop();
      connection.current?.close();
      connection.current = null;
    };
  }, [markUnconfirmed, microphone]);

  const acknowledgeUnconfirmedAudio = useCallback(() => {
    if (busy.current || connection.current) throw new Error('Stop voice capture before acknowledging missing audio.');
    // Explicit user decision, never an automatic recovery or a side effect of retrying End.
    voiceDebug('acknowledge', { stage: 'voice', outcome: 'success' });
    unconfirmed.current = false;
    setUnconfirmedAudio(false);
    setPartialTranscript('');
    setPhase('idle');
  }, []);

  return { phase, partialTranscript, pendingCount, diagnostics, unconfirmedAudio, acknowledgeUnconfirmedAudio, start, stop, pause, end, discard, flush };
}
