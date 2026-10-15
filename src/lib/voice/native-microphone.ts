type Dependencies = {
  stream: { start(): Promise<void>; stop(): void };
  requestPermission(): Promise<boolean>;
  configureAudio(): Promise<void>;
};

// Expo owns/release()s the shared object. This controller only starts/stops it
// while mounted; never inspect native properties after the owning hook releases it.
export function createNativeMicrophone({ stream, requestPermission, configureAudio }: Dependencies) {
  let mounted = false;
  let active = false;
  let starting = false;
  let generation = 0;
  const cancelled = () => new Error('Microphone start cancelled.');
  const isCurrent = (version: number) => mounted && generation === version;

  const stop = () => {
    generation++;
    if (!mounted || !active) return;
    // Clear BEFORE entering native code: repeated cleanup must never call it twice.
    active = false;
    stream.stop();
  };

  const start = async () => {
    if (!mounted) throw cancelled();
    if (starting || active) throw new Error('Microphone is already starting or running.');
    const version = ++generation;
    starting = true;
    try {
      const granted = await requestPermission();
      if (!isCurrent(version)) throw cancelled();
      if (!granted) throw new Error('Microphone permission is required to transcribe.');
      await configureAudio();
      if (!isCurrent(version)) throw cancelled();
      active = true;
      await stream.start();
      if (!isCurrent(version)) {
        // A stop can race the async native start. Stop a late start only while the
        // shared object is still owned; after unmount Expo's release stops it.
        if (mounted) { active = true; stop(); }
        throw cancelled();
      }
    } catch (error) {
      stop();
      throw error;
    } finally { starting = false; }
  };

  return {
    start, stop,
    mount: () => { mounted = true; },
    dispose: () => {
      try { stop(); }
      finally { mounted = false; }
    },
  };
}
