// Pure agent-pipeline rules (no I/O), so they can be tested with plain Node.
// Test: node --experimental-strip-types --test tests/agent-logic.test.ts

export type QuestionStatus = 'unanswered' | 'answered' | 'dismissed';
export type MemoryQuestion = {
  id: string; // short id the agents see ("q1"); stable for the whole consultation
  question_id: string; // suggestions.question_id
  text: string;
  source: 'patient' | 'ai';
  status: QuestionStatus;
  priority: number; // 1 (most urgent) .. 5
  reason?: string;
};
export type QuestionOut = { id: string; text: string; source?: string; status: string; priority?: number; reason?: string };

const MAX_NEW = 3;
const STATUSES: QuestionStatus[] = ['unanswered', 'answered', 'dismissed'];

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
  s === 'answered' ? 'resolved' : s === 'dismissed' ? 'dismissed' : 'approved';

// Applies an evaluator-approved Question Generation output to the stored list. The server, not
// the model, enforces the hard rules: question text never changes, answered never reverts,
// patient questions are never dismissed, at most 3 new questions, and no exact duplicates.
export function mergeQuestions(before: MemoryQuestion[], output: QuestionOut[], newId: () => string) {
  const next = before.map((q) => ({ ...q }));
  const byId = new Map(next.map((q) => [q.id, q]));
  const seen = new Set(next.map((q) => q.text.trim().toLowerCase()));
  const created: MemoryQuestion[] = [];
  const changed = new Set<MemoryQuestion>();

  for (const out of output) {
    const status = STATUSES.includes(out.status as QuestionStatus) ? (out.status as QuestionStatus) : 'unanswered';
    const existing = byId.get(out.id);
    if (existing) {
      let nextStatus = existing.status === 'answered' ? 'answered' : status;
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
    if (!out.id.startsWith('new-') || !text || created.length >= MAX_NEW || seen.has(text.toLowerCase())) continue;
    const q: MemoryQuestion = {
      id: `q${next.length + 1}`, question_id: newId(), text, source: 'ai',
      status: status === 'dismissed' ? 'unanswered' : status, priority: clampPriority(out.priority, 5), reason: out.reason,
    };
    seen.add(text.toLowerCase());
    next.push(q);
    created.push(q);
  }
  return { questions: next, created, changed: [...changed] };
}
