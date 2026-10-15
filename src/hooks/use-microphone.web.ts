import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { MicrophoneBuffer } from '@/lib/voice/pcm';

// expo-audio 57's web useAudioStream is a stub. Keep a working browser fallback.
// No MediaRecorder, audio files, uploads to Storage, or persistent audio buffers.
export function useMicrophone(onBuffer: (buffer: MicrophoneBuffer) => void) {
  const callback = useRef(onBuffer);
  callback.current = onBuffer;
  const resources = useRef<{
    media: MediaStream; context: AudioContext; source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode; mute: GainNode;
  } | null>(null);

  const stop = useCallback(() => {
    const current = resources.current;
    resources.current = null;
    if (!current) return;
    current.processor.onaudioprocess = null;
    current.processor.disconnect();
    current.source.disconnect();
    current.mute.disconnect();
    for (const track of current.media.getTracks()) track.stop();
    void current.context.close();
  }, []);

  const start = useCallback(async () => {
    if (resources.current) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture requires HTTPS or localhost.');
    const context = new AudioContext();
    let media: MediaStream | undefined;
    try {
      await context.resume();
      media = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      const source = context.createMediaStreamSource(media);
      // Deprecated but widely supported and sufficient for the time-boxed fallback demo.
      const processor = context.createScriptProcessor(2048, 1, 1);
      const mute = context.createGain();
      mute.gain.value = 0;
      processor.onaudioprocess = (event) => callback.current({
        data: event.inputBuffer.getChannelData(0).slice().buffer,
        sampleRate: event.inputBuffer.sampleRate, channels: 1, encoding: 'float32',
      });
      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
      resources.current = { media, context, source, processor, mute };
    } catch (error) {
      media?.getTracks().forEach((track) => track.stop());
      await context.close();
      throw error;
    }
  }, []);

  useEffect(() => stop, [stop]);
  return useMemo(() => ({ start, stop }), [start, stop]);
}
