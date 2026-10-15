import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  appendFinalTranscript, discardConsultation, getScribeToken, loadTranscriptCursor, setSessionStatus,
} from '@/lib/consultations';
import { ScribeConnection } from '@/lib/voice/scribe';
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
  const connection = useRef<ScribeConnection | null>(null);
  const queue = useRef<FinalTranscriptInput[]>([]);
  const draining = useRef<Promise<void> | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const stopMicrophone = useRef<() => void>(() => {});

  const reportError = useCallback((value: unknown) => {
    const error = value instanceof Error ? value : new Error('Voice capture failed.');
    stopMicrophone.current();
    connection.current?.close();
    connection.current = null;
    setPhase('error');
    callbacks.current.onError?.(error);
    return error;
  }, []);

  const onBuffer = useCallback((buffer: MicrophoneBuffer) => {
    try { connection.current?.send(buffer); }
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
        const { segment } = await appendFinalTranscript(queue.current[0]);
        queue.current.shift();
        setPendingCount(queue.current.length);
        callbacks.current.onSegment?.(segment);
      }
    })().finally(() => { draining.current = null; });
    return draining.current;
  }, []);

  const start = useCallback(async () => {
    if (busy.current || connection.current) throw new Error('Voice is already starting or running.');
    busy.current = true;
    const version = generation.current;
    setPhase('starting');
    try {
      await flush();
      await setSessionStatus(options.sessionId, 'active');
      const cursor = await loadTranscriptCursor(options.sessionId);
      let sequence = cursor.sequence;
      // Start capture before network work to preserve the browser's user gesture.
      // Buffers are ignored until the authenticated Scribe session is ready.
      await microphone.start();
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
        onError: (error) => {
          microphone.stop();
          connection.current?.close();
          connection.current = null;
          reportError(error);
        },
      }, cursor.offsetMs);
      connection.current = scribe;
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
    if (busy.current) throw new Error('Wait for the current voice operation to finish.');
    busy.current = true;
    setPhase('stopping');
    microphone.stop();
    try {
      await connection.current?.finish();
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
  }, [flush, microphone, reportError]);

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
      setPendingCount(0);
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
        connection.current?.close();
        connection.current = null;
        setPhase('idle');
      }
    });
    return () => {
      generation.current++;
      subscription.remove();
      microphone.stop();
      connection.current?.close();
      connection.current = null;
    };
  }, [microphone]);

  return { phase, partialTranscript, pendingCount, start, stop, pause, end, discard, flush };
}
