// Node 24: node --experimental-strip-types --test tests/native-microphone.test.ts
// Pure lifecycle regression tests: no Expo runtime, devices, network or credentials.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeMicrophone } from '../src/lib/voice/native-microphone.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function setup(overrides: {
  permission?: () => Promise<boolean>; configure?: () => Promise<void>;
  start?: () => Promise<void>; stop?: () => void;
} = {}) {
  let released = false;
  const calls = { start: 0, stop: 0, configure: 0 };
  const microphone = createNativeMicrophone({
    stream: {
      async start() {
        assert.equal(released, false, 'Cannot start a released shared object');
        calls.start++;
        await overrides.start?.();
      },
      stop() {
        assert.equal(released, false, 'Cannot stop a released shared object');
        calls.stop++;
        overrides.stop?.();
      },
    },
    requestPermission: overrides.permission ?? (async () => true),
    configureAudio: async () => { calls.configure++; await overrides.configure?.(); },
  });
  microphone.mount();
  return { microphone, calls, release: () => { released = true; } };
}

test('End followed by unmount and later consultation cleanup stops native capture once', async () => {
  const { microphone, calls, release } = setup();
  await microphone.start();
  microphone.stop();
  microphone.dispose(); // Layout cleanup, before Expo's passive shared-object release.
  release();
  assert.doesNotThrow(() => microphone.stop()); // Consultation passive cleanup.
  assert.doesNotThrow(() => microphone.dispose());
  assert.equal(calls.stop, 1);
});

test('unmount during recording stops before release; pause/resume remains supported', async () => {
  const { microphone, calls, release } = setup();
  await microphone.start();
  microphone.stop();
  await microphone.start();
  microphone.dispose();
  release();
  microphone.stop();
  assert.equal(calls.start, 2);
  assert.equal(calls.stop, 2);
});

test('permission resolving after unmount never configures audio or starts the released stream', async () => {
  const permission = deferred<boolean>();
  const { microphone, calls, release } = setup({ permission: () => permission.promise });
  const rejected = assert.rejects(microphone.start(), /cancelled/);
  microphone.dispose();
  release();
  permission.resolve(true);
  await rejected;
  assert.deepEqual(calls, { start: 0, stop: 0, configure: 0 });
});

test('audio configuration resolving after unmount never starts the released stream', async () => {
  const configured = deferred<void>();
  const entered = deferred<void>();
  const { microphone, calls, release } = setup({ configure: () => { entered.resolve(); return configured.promise; } });
  const rejected = assert.rejects(microphone.start(), /cancelled/);
  await entered.promise;
  microphone.dispose();
  release();
  configured.resolve();
  await rejected;
  assert.equal(calls.start, 0);
  assert.equal(calls.stop, 0);
});

test('a late native start is stopped again after cancellation while still mounted', async () => {
  const started = deferred<void>();
  const entered = deferred<void>();
  const { microphone, calls } = setup({ start: () => { entered.resolve(); return started.promise; } });
  const rejected = assert.rejects(microphone.start(), /cancelled/);
  await entered.promise;
  microphone.stop();
  started.resolve();
  await rejected;
  assert.equal(calls.stop, 2, 'The async native start may have completed after the first stop');
  microphone.dispose();
  assert.equal(calls.stop, 2);
});

test('a native start completing after release never calls back into the released object', async () => {
  const started = deferred<void>();
  const entered = deferred<void>();
  const { microphone, calls, release } = setup({ start: () => { entered.resolve(); return started.promise; } });
  const rejected = assert.rejects(microphone.start(), /cancelled/);
  await entered.promise;
  microphone.dispose();
  release();
  started.resolve();
  await rejected;
  microphone.stop();
  assert.equal(calls.stop, 1);
});

test('real native stop errors still propagate instead of being silently swallowed', async () => {
  const { microphone, calls } = setup({ stop: () => { throw new Error('Native recording failure'); } });
  await microphone.start();
  assert.throws(() => microphone.stop(), /Native recording failure/);
  microphone.dispose();
  assert.equal(calls.stop, 1);
});
