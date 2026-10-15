import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import { useCallback, useMemo } from 'react';
import type { MicrophoneBuffer } from '@/lib/voice/pcm';

export function useMicrophone(onBuffer: (buffer: MicrophoneBuffer) => void) {
  const { stream } = useAudioStream({
    sampleRate: 16000, channels: 1, encoding: 'int16',
    onBuffer: (buffer) => onBuffer({ ...buffer, encoding: 'int16' }),
  });
  const start = useCallback(async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error('Microphone permission is required to transcribe.');
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await stream.start();
  }, [stream]);
  const stop = useCallback(() => { stream.stop(); }, [stream]);
  return useMemo(() => ({ start, stop }), [start, stop]);
}
