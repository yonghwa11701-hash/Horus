import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import { useLayoutEffect, useMemo } from 'react';
import type { MicrophoneBuffer } from '@/lib/voice/pcm';
import { createNativeMicrophone } from '@/lib/voice/native-microphone';

export function useMicrophone(onBuffer: (buffer: MicrophoneBuffer) => void) {
  const { stream } = useAudioStream({
    sampleRate: 16000, channels: 1, encoding: 'int16',
    onBuffer: (buffer) => onBuffer({ ...buffer, encoding: 'int16' }),
  });
  const microphone = useMemo(() => createNativeMicrophone({
    stream,
    requestPermission: async () => (await requestRecordingPermissionsAsync()).granted,
    configureAudio: () => setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }),
  }), [stream]);
  useLayoutEffect(() => {
    microphone.mount();
    // Layout cleanup runs before useAudioStream's passive native release. The
    // consultation hook's later cleanup can safely call stop() again afterward.
    return microphone.dispose;
  }, [microphone]);
  return useMemo(() => ({ start: microphone.start, stop: microphone.stop }), [microphone]);
}
