// Node 24: node --experimental-strip-types --test tests/agent-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groundedAskedQuestionIds, mergeQuestions, parseModelJson, priorityLevel, suggestionStatus, type MemoryQuestion } from '../supabase/functions/_shared/agent-logic.ts';

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
  ].map((x) => ({ ...x, source_segment_ids: ['seg-1'] }));
  const r = mergeQuestions(before, out, uuid);
  assert.deepEqual(r.created.map((x) => [x.id, x.text, x.priority]), [['q2', 'A?', 1], ['q3', 'B?', 5], ['q4', 'C?', 5]]);
  assert.equal(r.questions.length, 4);
  assert.ok(r.created.every((x) => x.source === 'ai' && x.question_id.startsWith('uuid-')));
});

test('new questions without a cited segment are dropped', () => {
  const r = mergeQuestions([], [
    { id: 'new-1', text: 'Uncited?', status: 'unanswered' },
    { id: 'new-2', text: 'Cited?', status: 'unanswered', source_segment_ids: ['seg-2'] },
  ], uuid);
  assert.deepEqual(r.created.map((x) => [x.text, x.source_segment_ids]), [['Cited?', ['seg-2']]]);
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

test('new AI questions have a hard 15-word limit without truncating meaning', () => {
  const text = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
  const r = mergeQuestions([], [
    { id: 'new-1', text: text(16), status: 'unanswered', source_segment_ids: ['seg-1'] },
    { id: 'new-2', text: `  ${text(15).replaceAll(' ', '\t\n')}  `, status: 'unanswered', source_segment_ids: ['seg-1'] },
    { id: 'new-3', text: 'When should I get the results?', status: 'unanswered', source_segment_ids: ['seg-1'] },
  ], uuid);
  assert.equal(r.created.length, 2);
  assert.equal(r.created[0].text.split(/\s+/).length, 15);
  assert.equal(r.created[1].text, 'When should I get the results?');
  assert.ok(!r.questions.some((x) => x.text === text(16)));
});

test('the new-question word limit never rewrites existing AI or patient questions', () => {
  const long = 'Please explain in detail what I should ask about the timing of the next planned follow up appointment?';
  const before = [q('q1', { text: long, source: 'patient' }), q('q2', { text: long })];
  const r = mergeQuestions(before, [
    { id: 'q1', text: 'Shortened?', status: 'unanswered' },
    { id: 'q2', text: 'Shortened?', status: 'answered' },
  ], uuid);
  assert.deepEqual(r.questions.map((x) => x.text), [long, long]);
  assert.equal(r.questions[1].status, 'answered');
});

test('asked detection requires a real quote in known transcript segments', () => {
  const ids = groundedAskedQuestionIds([
    { id: 'q1', evidence: 'when will my results be ready?', segment_ids: ['seg-1'] },
    { id: 'q2', evidence: 'Invented quote', segment_ids: ['seg-1'] },
    { id: 'q3', evidence: 'When will my results be ready?', segment_ids: ['other-session'] },
    { id: 'q4', evidence: '', segment_ids: ['seg-1'] },
    { id: 'q5', evidence: 'When will my results be ready?', segment_ids: [] },
  ], [{ id: 'seg-1', text: 'Patient: When will my results   be ready?' }]);
  assert.deepEqual([...ids], ['q1']);
});

test('approved prior asked evidence survives unrelated later chunks', () => {
  const prior = [{ id: 'q1', evidence: 'When will my results be ready?', segment_ids: ['old-segment'] }];
  assert.deepEqual([...groundedAskedQuestionIds(prior, [{ id: 'new-segment', text: 'Patient: Okay.' }], prior)], ['q1']);
});

test('grounded asked status is committed even without a generated question update', () => {
  const before = [q('q1'), q('q2', { status: 'answered' })];
  const r = mergeQuestions(before, [], uuid, new Set(['q1', 'q2']));
  assert.deepEqual(r.questions.map((x) => x.status), ['asked', 'answered']);
  assert.deepEqual(r.changed.map((x) => x.id), ['q1']);
  assert.equal(before[0].status, 'unanswered');
  assert.equal(suggestionStatus(r.questions[0].status), 'asked');
});

test('ungrounded generated asked statuses are ignored; new questions cannot start asked', () => {
  const r = mergeQuestions([q('q1')], [
    { id: 'q1', text: 'text q1', status: 'asked' },
    { id: 'new-1', text: 'When should I return?', status: 'asked', source_segment_ids: ['seg-1'] },
  ], uuid);
  assert.deepEqual(r.questions.map((x) => x.status), ['unanswered', 'unanswered']);
});

test('asked never reverts but can become answered when the doctor answers later', () => {
  const before = [q('q1', { status: 'asked' }), q('q2', { status: 'asked' }), q('q3', { status: 'asked' })];
  const r = mergeQuestions(before, [
    { id: 'q1', text: 'text q1', status: 'unanswered' },
    { id: 'q2', text: 'text q2', status: 'dismissed' },
    { id: 'q3', text: 'text q3', status: 'answered' },
  ], uuid);
  assert.deepEqual(r.questions.map((x) => x.status), ['asked', 'asked', 'answered']);
  assert.deepEqual(r.changed.map((x) => x.id), ['q3']);
  assert.equal(suggestionStatus(r.questions[2].status), 'resolved');
});

test('priority maps to the suggestion enum', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(priorityLevel), ['critical', 'high', 'medium', 'low', 'low']);
});
