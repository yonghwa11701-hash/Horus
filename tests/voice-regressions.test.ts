// Node 24: node --experimental-strip-types --test tests/voice-regressions.test.ts
// No network, Expo runtime, or provider credentials are used.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ScribeConnection, type ScribeFinal } from '../src/lib/voice/scribe.ts';
import { replayConsultationEvents } from '../src/lib/consultation-state.ts';
import type { Session, Suggestion, TranscriptSegment } from '../src/types/consultation.ts';

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
  const connection = new ScribeConnection({
    onPartial: () => {}, onFinal: (row) => finals.push(row), onError: (error) => errors.push(error),
  }, 0);
  const starting = connection.connect('synthetic-single-use-token');
  const socket = FakeSocket.instances.at(-1)!;
  socket.emit({ message_type: 'session_started' });
  await starting;
  return { connection, socket, finals, errors };
}
function audio(frames: number) {
  return { data: new Float32Array(frames).buffer, sampleRate: 16000, channels: 1, encoding: 'float32' as const };
}
function commit(socket: FakeSocket, text: string) {
  socket.emit({ message_type: 'committed_transcript_with_timestamps', text,
    words: text ? [{ start: 0, end: 0.5 }] : [] });
}

// The real resampler + transport state machine are exercised; only the external socket is fake.
test('finish waits for an earlier commit AND a separately acknowledged buffered tail', async (t) => {
  const { connection, socket, finals } = await connect(t);
  assert.equal(new URL(socket.url).searchParams.get('commit_strategy'), 'manual');
  connection.send(audio(80001)); // Five seconds start the first manual commit.
  connection.send(audio(16000)); // Audio captured while that commit is in flight is held locally.
  assert.equal(socket.sent.filter((packet) => packet.commit).length, 1);
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
