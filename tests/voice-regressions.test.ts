// Node 24: node --experimental-strip-types --test tests/voice-regressions.test.ts
// No network, Expo runtime, or provider credentials are used.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ScribeConnection, type ScribeDiagnostics, type ScribeFinal } from '../src/lib/voice/scribe.ts';
import { isConsultationId, replayConsultationEvents } from '../src/lib/consultation-state.ts';
import type { Session, Suggestion, TranscriptSegment } from '../src/types/consultation.ts';
import { validationMessage } from '../supabase/functions/_shared/validation-errors.ts';

class FakeSocket {
  static instances: FakeSocket[] = [];
  bufferedAmount = 0;
  sent: { commit: boolean }[] = [];
  url: string;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) { this.url = url; FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.onclose?.(); }
  emit(message: object) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

async function connect(t: TestContext) {
  t.mock.method(globalThis, 'WebSocket', FakeSocket as unknown as typeof WebSocket);
  const finals: ScribeFinal[] = [];
  const errors: Error[] = [];
  const events: { metrics: ScribeDiagnostics; text_chars: number }[] = [];
  const connection = new ScribeConnection({
    onPartial: () => {}, onFinal: (row) => finals.push(row), onError: (error) => errors.push(error),
    onEvent: (metrics, text_chars) => events.push({ metrics, text_chars }),
  }, 0);
  const starting = connection.connect('synthetic-single-use-token');
  const socket = FakeSocket.instances.at(-1)!;
  socket.emit({ message_type: 'session_started' });
  await starting;
  return { connection, socket, finals, errors, events };
}
function audio(frames: number) {
  return { data: new Float32Array(frames).buffer, sampleRate: 16000, channels: 1, encoding: 'float32' as const };
}
function commit(socket: FakeSocket, text: string) {
  socket.emit({ message_type: 'committed_transcript_with_timestamps', text,
    words: text ? [{ start: 0, end: 0.5 }] : [] });
}

test('validation feedback exposes fixed field names/codes, not submitted data or unknown keys', () => {
  const issues = [
    { path: ['session_id'], code: 'invalid_type', message: 'sensitive-id', input: 'sensitive-id' },
    { path: ['status'], code: 'invalid_value', message: 'sensitive-status' },
    { path: [], code: 'unrecognized_keys', keys: ['sensitive-key'] },
    { path: ['sensitive-field'], code: 'sensitive-code' },
  ];
  assert.equal(validationMessage(issues), 'Request fields are invalid (session_id: invalid_type; status: invalid_value; body: unrecognized_keys; body: invalid)');
  assert.doesNotMatch(validationMessage(issues), /sensitive/);
  assert.equal(validationMessage([]), 'Request fields are invalid');
  assert.ok(validationMessage(Array(1000).fill(issues[0])).length < 200);
});

test('consultation UUID boundary rejects missing, array and literal dynamic-route values', () => {
  for (const value of [undefined, null, '', 'undefined', '[id]', 'session/[id]', 'not-a-uuid', [], ['abcdef01-2345-4678-9abc-def012345678'], {}]) {
    assert.equal(isConsultationId(value), false);
  }
  for (const value of ['abcdef01-2345-4678-9abc-def012345678', 'ABCDEF01-2345-4678-9ABC-DEF012345678', '01998b60-0000-7000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff']) {
    assert.equal(isConsultationId(value), true);
  }
  assert.equal(isConsultationId('abcdef01-2345-0678-9abc-def012345678'), false, 'Unsupported UUID version');
  assert.equal(isConsultationId('abcdef01-2345-4678-0abc-def012345678'), false, 'Invalid UUID variant');
});

// The real resampler + transport state machine are exercised; only the external socket is fake.
test('finish waits for an earlier commit AND a separately acknowledged buffered tail', async (t) => {
  const { connection, socket, finals } = await connect(t);
  assert.equal(new URL(socket.url).searchParams.get('commit_strategy'), 'manual');
  assert.equal(connection.diagnostics.connected, true);
  assert.equal(connection.diagnostics.last_event, 'session_started');
  connection.send(audio(80001)); // Five seconds start the first manual commit.
  connection.send(audio(16000)); // Audio captured while that commit is in flight is held locally.
  assert.equal(socket.sent.filter((packet) => packet.commit).length, 1);
  assert.equal(connection.diagnostics.sent_ms, 5100);
  assert.equal(connection.diagnostics.buffered_ms, 1000);
  let finished = false;
  const finishing = connection.finish().then(() => { finished = true; });
  commit(socket, 'Earlier words');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false, 'Earlier result cannot confirm the buffered final words');
  assert.equal(socket.sent.filter((packet) => packet.commit).length, 2);
  socket.emit({ message_type: 'committed_transcript', text: 'Final words' });
  assert.equal(finished, false, 'The paired plain event is not a second acknowledgement');
  commit(socket, 'Final words');
  await finishing;
  assert.equal(connection.hasUnconfirmedAudio, false, 'Trailing silence is covered by the acknowledged boundary');
  assert.deepEqual(finals.map((row) => row.text), ['Earlier words', 'Final words']);
  assert.equal(connection.diagnostics.commit_confirmations, 2);
  assert.equal(connection.diagnostics.connected, false);
});

test('provider error code is visible without exposing provider error body', async (t) => {
  const { connection, socket, errors } = await connect(t);
  socket.emit({ message_type: 'quota_exceeded', error: 'synthetic sensitive request details' });
  assert.match(errors[0].message, /quota_exceeded/);
  assert.doesNotMatch(errors[0].message, /sensitive request/);
  assert.equal(connection.diagnostics.last_event, 'quota_exceeded');
  assert.equal(connection.diagnostics.connected, false);
});

test('event diagnostics retain input strength and character counts without transcript content', async (t) => {
  const { connection, socket, events } = await connect(t);
  connection.send({ ...audio(16001), data: new Float32Array(16001).fill(0.25).buffer });
  socket.emit({ message_type: 'partial_transcript', text: 'Synthetic private words' });
  assert.equal(connection.diagnostics.pcm_peak_percent, 25);
  assert.equal(events.at(-1)?.text_chars, 'Synthetic private words'.length);
  assert.doesNotMatch(JSON.stringify(events), /Synthetic private words/);
  connection.close();
  assert.equal(connection.diagnostics.pcm_peak_percent, 25, 'Signal peak remains visible after stopping');
});

test('missing confirmation fails even without a partial; repeated finish cannot bypass the failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { connection } = await connect(t);
  connection.send(audio(16001));
  const rejected = assert.rejects(connection.finish(), /not confirmed/);
  t.mock.timers.tick(10000);
  await rejected;
  assert.equal(connection.hasUnconfirmedAudio, true);
  await assert.rejects(connection.finish(), /not confirmed/);
});

test('an explicit empty committed result confirms silence, not the passage of time', async (t) => {
  const { connection, socket, finals } = await connect(t);
  connection.send(audio(16001));
  const finishing = connection.finish();
  commit(socket, '');
  await finishing;
  assert.equal(connection.hasUnconfirmedAudio, false);
  assert.equal(finals.length, 0);
});

test('closing an unconfirmed connection does not turn it into a successful finish', async (t) => {
  const { connection } = await connect(t);
  connection.send(audio(16001));
  connection.close();
  await assert.rejects(connection.finish(), /not confirmed/);
});

const session: Session = {
  id: 'session', user_id: 'user', status: 'active', consented_at: '2026-07-17T12:00:00Z',
  created_at: '2026-07-17T12:00:00Z', updated_at: '2026-07-17T12:00:00Z', ended_at: null,
};
const segment: TranscriptSegment = {
  id: 'segment-0', session_id: session.id, sequence: 0, text: 'Synthetic text', start_ms: 0, end_ms: 1000,
  source: 'manual_demo', processing_status: 'pending', processed_at: null, created_at: session.created_at,
};
const suggestion: Suggestion = {
  question_id: 'question', session_id: session.id, question: 'What are the side effects?', priority: 'medium',
  status: 'approved', source_segment_ids: [segment.id], evaluation: { relevant: true, supported: true },
  created_at: session.created_at, updated_at: session.updated_at, resolved_at: null,
};

test('snapshot replay retains new inserts and newer versions of all three live row types', () => {
  const state = replayConsultationEvents({ session, segments: [segment], suggestions: [suggestion] }, [
    { kind: 'transcript', row: { ...segment, id: 'segment-1', sequence: 1 } },
    { kind: 'session', row: { ...session, status: 'ending' } },
    { kind: 'transcript', row: { ...segment, processing_status: 'processing' } },
    { kind: 'transcript', row: { ...segment, processing_status: 'completed' } },
    { kind: 'suggestion', row: { ...suggestion, status: 'resolved' } },
  ]);
  assert.equal(state.session.status, 'ending');
  assert.deepEqual(state.segments.map((row) => row.id), ['segment-0', 'segment-1']);
  assert.equal(state.segments[0].processing_status, 'completed');
  assert.equal(state.suggestions[0].status, 'resolved');
});
