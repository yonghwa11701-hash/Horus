import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { MicrophoneBuffer } from '@/lib/voice/pcm';
import { voiceDebug } from '@/lib/voice/debug';

// expo-audio 57's web useAudioStream is a stub. Keep a working browser fallback.
// No MediaRecorder, audio files, uploads to Storage, or persistent audio buffers.
export function useMicrophone(onBuffer: (buffer: MicrophoneBuffer) => void) {
  const callback = useRef(onBuffer);
  callback.current = onBuffer;
  const resources = useRef<{
    media: MediaStream; context: AudioContext; source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode; removeListeners: () => void;
  } | null>(null);

  const stop = useCallback(() => {
    const current = resources.current;
    resources.current = null;
    if (!current) return;
    current.removeListeners();
    current.processor.onaudioprocess = null;
    current.processor.disconnect();
    current.source.disconnect();
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
      const track = media.getAudioTracks()[0];
      if (!track || !track.enabled || track.readyState !== 'live') {
        throw new Error('The selected microphone is not active. Check the browser input device and microphone permissions.');
      }
      const source = context.createMediaStreamSource(media);
      // Deprecated but widely supported and sufficient for the time-boxed fallback demo.
      const processor = context.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        // Silence the OUTPUT, not the capture graph. Never play microphone audio.
        event.outputBuffer.getChannelData(0).fill(0);
        callback.current({
          data: event.inputBuffer.getChannelData(0).slice().buffer,
          sampleRate: event.inputBuffer.sampleRate, channels: 1, encoding: 'float32',
        });
      };
      source.connect(processor);
      processor.connect(context.destination);
      const reportInput = () => voiceDebug('input', {
        stage: 'microphone', input_enabled: track.enabled, input_muted: track.muted,
        input_live: track.readyState === 'live', context_running: context.state === 'running',
        input_channels: track.getSettings().channelCount, sample_rate: context.sampleRate,
      });
      const events = ['mute', 'unmute', 'ended'] as const;
      for (const event of events) track.addEventListener(event, reportInput);
      context.addEventListener('statechange', reportInput);
      resources.current = { media, context, source, processor, removeListeners: () => {
        for (const event of events) track.removeEventListener(event, reportInput);
        context.removeEventListener('statechange', reportInput);
      } };
      reportInput();
    } catch (error) {
      media?.getTracks().forEach((track) => track.stop());
      await context.close();
      throw error;
    }
  }, []);

  useEffect(() => stop, [stop]);
  return useMemo(() => ({ start, stop }), [start, stop]);
}
