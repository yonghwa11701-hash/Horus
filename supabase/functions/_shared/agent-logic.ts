// Pure agent-pipeline rules (no I/O), so they can be tested with plain Node.
// Test: node --experimental-strip-types --test tests/agent-logic.test.ts

export type QuestionStatus = 'unanswered' | 'asked' | 'answered' | 'dismissed';
export type AskedQuestionEvidence = { id: string; evidence: string; segment_ids: string[] };
export type MemoryQuestion = {
  id: string; // short id the agents see ("q1"); stable for the whole consultation
  question_id: string; // suggestions.question_id
  text: string;
  source: 'patient' | 'ai';
  status: QuestionStatus;
  priority: number; // 1 (most urgent) .. 5
  reason?: string;
  source_segment_ids?: string[]; // AI questions only: the transcript segments the question comes from
};
export type QuestionOut = {
  id: string; text: string; source?: string; status: string; priority?: number; reason?: string; source_segment_ids?: string[];
};

const MAX_NEW = 3;
const MAX_AI_QUESTION_WORDS = 15;
const STATUSES: QuestionStatus[] = ['unanswered', 'asked', 'answered', 'dismissed'];

// The prompts say "return only JSON"; tolerate a code fence anyway.
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

const clampPriority = (p: unknown, fallback: number) =>
  typeof p === 'number' && Number.isFinite(p) ? Math.min(5, Math.max(1, Math.round(p))) : fallback;

export const priorityLevel = (p: number) => (p <= 1 ? 'critical' : p === 2 ? 'high' : p === 3 ? 'medium' : 'low');
export const suggestionStatus = (s: QuestionStatus) =>
  s === 'answered' ? 'resolved' : s === 'asked' || s === 'dismissed' ? s : 'approved';

// Only called for evaluator-approved understanding. Require a real quote in cited
// current segments, or a previously approved asked record carried forward in memory.
export function groundedAskedQuestionIds(
  candidates: AskedQuestionEvidence[], segments: { id: string; text: string }[], prior: AskedQuestionEvidence[] = [],
): Set<string> {
  const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
  const transcript = new Map(segments.map((segment) => [segment.id, normalize(segment.text)]));
  const known = new Set(prior.map((q) => q.id));
  return new Set(candidates.filter((q) => {
    if (known.has(q.id)) return true;
    const quote = normalize(q.evidence);
    return quote.length > 0 && q.segment_ids.length > 0
      && q.segment_ids.every((id) => transcript.has(id))
      && q.segment_ids.map((id) => transcript.get(id)).join(' ').includes(quote);
  }).map((q) => q.id));
}

// Applies an evaluator-approved Question Generation output to the stored list. The server, not
// the model, enforces the hard rules: question text never changes, answered never reverts,
// patient questions are never dismissed, at most 3 new questions, no exact duplicates, and every
// new question is at most 15 words and cites at least one transcript segment (ids checked against the session).
export function mergeQuestions(
  before: MemoryQuestion[], output: QuestionOut[], newId: () => string, askedIds: ReadonlySet<string> = new Set(),
) {
  const next: MemoryQuestion[] = before.map((q) => ({
    ...q, status: q.status === 'unanswered' && askedIds.has(q.id) ? 'asked' : q.status,
  }));
  const byId = new Map(next.map((q) => [q.id, q]));
  const seen = new Set(next.map((q) => q.text.trim().toLowerCase()));
  const created: MemoryQuestion[] = [];
  const changed = new Set(next.filter((q, i) => q.status !== before[i].status));

  for (const out of output) {
    const status = STATUSES.includes(out.status as QuestionStatus) ? (out.status as QuestionStatus) : 'unanswered';
    const existing = byId.get(out.id);
    if (existing) {
      let nextStatus = existing.status === 'answered' ? 'answered' : status;
      if (existing.status === 'asked' && nextStatus !== 'answered') nextStatus = 'asked';
      if (nextStatus === 'asked' && existing.status !== 'asked' && !askedIds.has(existing.id)) nextStatus = existing.status;
      if (existing.source === 'patient' && nextStatus === 'dismissed') nextStatus = existing.status;
      const priority = clampPriority(out.priority, existing.priority);
      if (nextStatus !== existing.status || priority !== existing.priority) {
        existing.status = nextStatus;
        existing.priority = priority;
        changed.add(existing);
      }
      continue;
    }
    const text = out.text?.trim();
    const sources = out.source_segment_ids ?? [];
    if (!out.id.startsWith('new-') || !text || !sources.length || created.length >= MAX_NEW || seen.has(text.toLowerCase())) continue;
    // Drop, never truncate: cutting words can change clinical meaning. Existing questions stay intact.
    if (text.split(/\s+/).length > MAX_AI_QUESTION_WORDS) continue;
    const q: MemoryQuestion = {
      id: `q${next.length + 1}`, question_id: newId(), text, source: 'ai',
      status: status === 'dismissed' || status === 'asked' ? 'unanswered' : status, priority: clampPriority(out.priority, 5), reason: out.reason,
      source_segment_ids: sources,
    };
    seen.add(text.toLowerCase());
    next.push(q);
    created.push(q);
  }
  return { questions: next, created, changed: [...changed] };
}
