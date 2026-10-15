// Node 24: node --experimental-strip-types --test tests/agent-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeQuestions, parseModelJson, priorityLevel, type MemoryQuestion } from '../supabase/functions/_shared/agent-logic.ts';

let n = 0;
const uuid = () => `uuid-${++n}`;
const q = (id: string, extra: Partial<MemoryQuestion> = {}): MemoryQuestion =>
  ({ id, question_id: `qid-${id}`, text: `text ${id}`, source: 'ai', status: 'unanswered', priority: 3, ...extra });

test('parseModelJson accepts raw and fenced JSON', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseModelJson('not json'));
});

test('new questions get server ids, capped at 3, exact duplicates dropped', () => {
  const before = [q('q1')];
  const out = [
    { id: 'q1', text: 'text q1', status: 'unanswered', priority: 3 },
    { id: 'new-1', text: 'TEXT Q1', status: 'unanswered', priority: 2 }, // duplicate of q1
    { id: 'new-2', text: 'A?', status: 'unanswered', priority: 1 },
    { id: 'new-3', text: 'B?', status: 'unanswered', priority: 9 },
    { id: 'new-4', text: 'C?', status: 'unanswered' },
    { id: 'new-5', text: 'D?', status: 'unanswered' },
    { id: 'q99', text: 'unknown id', status: 'unanswered' },
  ];
  const r = mergeQuestions(before, out, uuid);
  assert.deepEqual(r.created.map((x) => [x.id, x.text, x.priority]), [['q2', 'A?', 1], ['q3', 'B?', 5], ['q4', 'C?', 5]]);
  assert.equal(r.questions.length, 4);
  assert.ok(r.created.every((x) => x.source === 'ai' && x.question_id.startsWith('uuid-')));
});

test('existing text is never rewritten, answered never reverts, patient questions never dismissed', () => {
  const before = [q('q1', { status: 'answered' }), q('q2', { source: 'patient' }), q('q3')];
  const r = mergeQuestions(before, [
    { id: 'q1', text: 'rewritten', status: 'unanswered', priority: 1 },
    { id: 'q2', text: 'rewritten', status: 'dismissed', priority: 3 },
    { id: 'q3', text: 'text q3', status: 'answered', priority: 3 },
  ], uuid);
  assert.deepEqual(r.questions.map((x) => [x.text, x.status]), [['text q1', 'answered'], ['text q2', 'unanswered'], ['text q3', 'answered']]);
  assert.deepEqual(r.changed.map((x) => x.id), ['q1', 'q3']); // q1 changed priority only
  assert.equal(before[2].status, 'unanswered', 'input list is not mutated');
});

test('questions missing from the output are kept', () => {
  const r = mergeQuestions([q('q1'), q('q2')], [{ id: 'q2', text: 'text q2', status: 'unanswered', priority: 3 }], uuid);
  assert.deepEqual(r.questions.map((x) => x.id), ['q1', 'q2']);
});

test('priority maps to the suggestion enum', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(priorityLevel), ['critical', 'high', 'medium', 'low', 'low']);
});
