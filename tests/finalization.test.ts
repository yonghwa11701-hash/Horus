// Node 24: node --experimental-strip-types --test tests/finalization.test.ts
// No Expo runtime, network, provider credentials or real retry delays.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createSessionFinalizer } from '../src/lib/finalization.ts';

const busy = { status: 409, code: 'agents_busy' };

test('agents_busy retries serially after a delay; concurrent callers share the wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const done = { status: 'completed', summary_id: 'synthetic-summary' };
  const finalize = createSessionFinalizer(async () => {
    calls++;
    if (calls < 3) throw busy;
    return done;
  });
  const result = finalize('session-a');
  await nextTurn();
  assert.equal(calls, 1);
  assert.equal(finalize('session-a'), result, 'Try again must not start another retry loop');
  t.mock.timers.tick(2999);
  await nextTurn();
  assert.equal(calls, 1, 'No immediate retry storm');
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(calls, 2);
  t.mock.timers.tick(3000);
  assert.equal(await result, done);
  assert.equal(calls, 3);
});

test('other conflicts, missing services and provider errors fail without retries', async () => {
  for (const failure of [
    { status: 409, code: 'session_not_ending' },
    { status: 409, code: 'lease_lost' },
    { status: 409 },
    { status: 404, code: 'function_not_deployed' },
    { status: 502, code: 'summary_rejected' },
    { status: 503, code: 'agents_busy' },
    new Error('Unexpected failure'),
  ]) {
    let calls = 0;
    const finalize = createSessionFinalizer(async () => { calls++; throw failure; });
    await assert.rejects(finalize('session-a'), (error) => error === failure);
    assert.equal(calls, 1);
  }
});

test('busy waiting is bounded and preserves the last API conflict', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const finalize = createSessionFinalizer(async () => { calls++; throw busy; });
  const rejected = assert.rejects(finalize('session-a'), (error) => error === busy);
  await nextTurn();
  for (let i = 0; i < 60; i++) {
    t.mock.timers.tick(3000);
    await nextTurn();
  }
  await rejected;
  assert.equal(calls, 60, 'No further request after the three-minute busy-wait deadline');
});

test('in-flight work is isolated by session and removed after success', async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const calls: string[] = [];
  const finalize = createSessionFinalizer(async (id) => { calls.push(id); await gate; return id; });
  const a = finalize('session-a');
  assert.equal(finalize('session-a'), a);
  const b = finalize('session-b');
  assert.notEqual(a, b);
  assert.deepEqual(calls, ['session-a', 'session-b']);
  finish();
  assert.deepEqual(await Promise.all([a, b]), ['session-a', 'session-b']);
  await finalize('session-a');
  assert.deepEqual(calls, ['session-a', 'session-b', 'session-a']);
});

test('a failed finalization can be explicitly retried later', async () => {
  let calls = 0;
  const failure = { status: 502, code: 'summary_rejected' };
  const finalize = createSessionFinalizer(async () => {
    if (++calls === 1) throw failure;
    return 'completed';
  });
  await assert.rejects(finalize('session-a'), (error) => error === failure);
  assert.equal(await finalize('session-a'), 'completed');
  assert.equal(calls, 2);
});
