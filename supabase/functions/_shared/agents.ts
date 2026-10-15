import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import { z } from 'npm:zod@4.1.12';
import type { Database, Json } from '../../../src/types/database.ts';
import type { RequestContext } from './http.ts';
import { adminClient, ApiError, databaseError } from './http.ts';
import { ownedSession, recordSystemEvent, saveJsonArtifact } from './artifacts.ts';
import { AGENT_MODEL, callAgent, REVIEW_MODEL } from './claude.ts';
import { mergeQuestions, priorityLevel, suggestionStatus, type MemoryQuestion } from './agent-logic.ts';

declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };

type Admin = SupabaseClient<Database>;
type Session = Database['public']['Tables']['sessions']['Row'];
type Memory = Database['public']['Tables']['consultation_memory']['Row'];

// Spec retry rule (.plans/patient-advocate-agents-spec.md): up to 2 retries with evaluator feedback.
const MAX_RETRIES = 2;
// Hosted Edge Functions stop at ~150 s wall clock. The lease outlives one run; the budget stops
// starting new batches well before the limit. Leftover segments stay pending for the next dispatch.
const LEASE_SECONDS = 140;
const BUDGET_MS = 60_000;
const MAX_BATCH = 20;

const evaluation = z.object({
  pass: z.boolean(),
  score: z.number(),
  issues: z.array(z.looseObject({ check: z.string().optional() })).default([]),
  feedback: z.string().default(''),
});
type Evaluation = z.infer<typeof evaluation>;
const understandingOutput = z.looseObject({
  facts: z.array(z.unknown()),
  answered_questions: z.array(z.looseObject({ id: z.string() })),
  unclear: z.array(z.unknown()),
  red_flags: z.array(z.unknown()),
  open_topics: z.array(z.unknown()),
});
const questionsOutput = z.object({
  questions: z.array(z.looseObject({
    id: z.string(), text: z.string(), status: z.string(),
    source: z.string().optional(), priority: z.number().optional(), reason: z.string().optional(),
  })),
});
const summaryOutput = z.looseObject({
  headline: z.string(),
  important: z.array(z.string()).default([]),
  what_the_doctor_found: z.array(z.string()).default([]),
  medications: z.array(z.looseObject({ name: z.string() })).default([]),
  next_steps: z.array(z.string()).default([]),
  answered_questions: z.array(z.looseObject({ question: z.string(), answer: z.string() })).default([]),
  still_to_ask: z.array(z.string()).default([]),
  unclear: z.array(z.string()).default([]),
});

type Agent = 'understanding' | 'questions' | 'summary';
const FILES: Record<Agent, [producer: string, evaluator: string, model: string]> = {
  understanding: ['understanding.md', 'understanding-evaluator.md', AGENT_MODEL],
  questions: ['question-generation.md', 'question-evaluator.md', AGENT_MODEL],
  summary: ['summary.md', 'summary-evaluator.md', REVIEW_MODEL],
};

// Producer -> evaluator -> retry with feedback. Every attempt's output and verdict is saved as an
// `evaluation` artifact and logged; after the last retry the best-scoring attempt is kept, flagged.
async function produce<T>(
  admin: Admin, session: Session, agent: Agent, schema: z.ZodType<T>,
  input: Record<string, unknown>, evalInput: Record<string, unknown>, context: { [key: string]: Json },
) {
  const [producer, evaluator, model] = FILES[agent];
  const attempts: { output: T; verdict: Evaluation }[] = [];
  let feedback: string | null = null;
  for (let i = 1; i <= MAX_RETRIES + 1; i++) {
    const output: T = await callAgent(producer, model, { ...input, evaluator_feedback: feedback }, schema);
    const verdict: Evaluation = await callAgent(evaluator, REVIEW_MODEL, { ...evalInput, output }, evaluation);
    attempts.push({ output, verdict });
    const artifact = await saveJsonArtifact(admin, session, 'evaluation', {
      agent, attempt: i, ...context, output: output as Json, evaluation: verdict as Json,
    });
    await recordSystemEvent(admin, session.id, `agent.${agent}.evaluated`, {
      attempt: i, pass: verdict.pass, score: verdict.score,
      failed_checks: verdict.issues.flatMap((issue) => (issue.check ? [issue.check] : [])),
    }, artifact.id);
    if (verdict.pass) return { output, verdict, attempts: i, flagged: false };
    if (i <= MAX_RETRIES) await recordSystemEvent(admin, session.id, `agent.${agent}.retry`, { attempt: i + 1 });
    feedback = verdict.feedback;
  }
  const best = attempts.reduce((a, b) => (b.verdict.score > a.verdict.score ? b : a));
  await recordSystemEvent(admin, session.id, `agent.${agent}.flagged`, { attempts: attempts.length, score: best.verdict.score });
  return { ...best, attempts: attempts.length, flagged: true };
}

const forAgents = (questions: MemoryQuestion[]) =>
  questions.map(({ id, text, source, status, priority }) => ({ id, text, source, status, priority }));

// One batch: Understanding -> Question Generation (each with its evaluator) -> prioritise/dedup
// -> memory + suggestions. Returns the number of segments processed.
async function runBatch(admin: Admin, session: Session, memory: Memory, lockId: string) {
  const { data: segments, error } = await admin.from('transcript_segments').select('id, text')
    .eq('session_id', session.id).neq('processing_status', 'completed').order('sequence').limit(MAX_BATCH);
  if (error) databaseError(error);
  if (!segments.length) return 0;
  const segmentIds = segments.map((s) => s.id);
  const setStatus = async (processing_status: 'processing' | 'completed' | 'failed') => {
    const { error } = await admin.from('transcript_segments').update({
      processing_status, processed_at: processing_status === 'completed' ? new Date().toISOString() : null,
    }).in('id', segmentIds);
    if (error) databaseError(error);
  };
  await setStatus('processing');
  await recordSystemEvent(admin, session.id, 'agent.run.started', { segment_ids: segmentIds });
  try {
    const questions = memory.questions as MemoryQuestion[];
    const context = { segment_ids: segmentIds };
    const understandingInput = {
      prior_state: memory.understanding,
      chunk: segments.map((s) => s.text).join('\n'),
      patient_questions: questions.filter((q) => q.status === 'unanswered').map(({ id, text, status }) => ({ id, text, status })),
    };
    const understanding = await produce(admin, session, 'understanding', understandingOutput,
      understandingInput, understandingInput, context);
    await saveJsonArtifact(admin, session, 'understanding', { ...context, flagged: understanding.flagged, state: understanding.output as Json });
    if (understanding.flagged) throw new ApiError(502, 'understanding_rejected', 'Understanding failed evaluation');

    const before = forAgents(questions);
    const generated = await produce(admin, session, 'questions', questionsOutput,
      { understanding: understanding.output, questions: before },
      { understanding: understanding.output, questions_before: before }, context);
    await saveJsonArtifact(admin, session, 'questions', { ...context, flagged: generated.flagged, output: generated.output as Json });

    // Only evaluator-approved questions reach the patient (CLAUDE.md §3). A flagged list is rejected
    // whole; the next chunk tries again from the unchanged list.
    const merged = generated.flagged ? null : mergeQuestions(questions, generated.output.questions, () => crypto.randomUUID());
    await recordSystemEvent(admin, session.id, generated.flagged ? 'agent.questions.rejected' : 'agent.questions.approved', {
      score: generated.verdict.score, created: merged?.created.length ?? 0, changed: merged?.changed.length ?? 0,
    });

    // Memory first, guarded by the lease: if another worker took over, stop without side effects.
    const { data: saved, error: saveError } = await admin.from('consultation_memory').update({
      understanding: understanding.output as Json, questions: (merged?.questions ?? questions) as Json, updated_at: new Date().toISOString(),
    }).eq('session_id', session.id).eq('lock_id', lockId).select('session_id');
    if (saveError) databaseError(saveError);
    if (!saved.length) throw new ApiError(409, 'lease_lost', 'Another worker took over this consultation');

    if (merged?.created.length) {
      const { error } = await admin.from('suggestions').upsert(merged.created.map((q) => ({
        question_id: q.question_id, session_id: session.id, question: q.text,
        priority: priorityLevel(q.priority), status: suggestionStatus(q.status), source_segment_ids: segmentIds,
        evaluation: { relevant: true, supported: true, advice_free: true, score: generated.verdict.score, attempts: generated.attempts, reason: q.reason ?? null },
        resolved_at: q.status === 'answered' ? new Date().toISOString() : null,
      })), { onConflict: 'question_id', ignoreDuplicates: true });
      if (error) databaseError(error);
      for (const q of merged.created) {
        await recordSystemEvent(admin, session.id, 'suggestion.created', { question_id: q.question_id, priority: priorityLevel(q.priority) });
      }
    }
    for (const q of merged?.changed ?? []) {
      const { error } = await admin.from('suggestions').update({
        priority: priorityLevel(q.priority), status: suggestionStatus(q.status),
        resolved_at: q.status === 'answered' ? new Date().toISOString() : null,
      }).eq('question_id', q.question_id);
      if (error) databaseError(error);
      if (q.status === 'answered') await recordSystemEvent(admin, session.id, 'suggestion.resolved', { question_id: q.question_id });
    }
    await setStatus('completed');
    return segments.length;
  } catch (error) {
    await setStatus('failed').catch(() => {});
    throw error;
  }
}

async function hasPending(admin: Admin, sessionId: string) {
  const { count, error } = await admin.from('transcript_segments').select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId).eq('processing_status', 'pending');
  if (error) databaseError(error);
  return (count ?? 0) > 0;
}

// Processes every unprocessed segment of the session in order, one worker per session.
// A dispatch that finds the lease taken returns at once; the holder re-checks for pending
// segments after releasing, so a segment that arrives mid-run is never stranded.
async function drain(session: Session) {
  const admin = adminClient();
  const started = Date.now();
  while (Date.now() - started < BUDGET_MS) {
    const { data: current, error: sessionError } = await admin.from('sessions').select('status').eq('id', session.id).maybeSingle();
    if (sessionError) databaseError(sessionError);
    // After the patient ends the session, the summary reads the full transcript instead.
    if (current?.status !== 'active' && current?.status !== 'paused') return;
    const lockId = crypto.randomUUID();
    const { data: claimed, error } = await admin.rpc('claim_agent_memory', {
      p_session_id: session.id, p_lock_id: lockId, p_lease_seconds: LEASE_SECONDS,
    });
    if (error) databaseError(error);
    if (!claimed?.length) return;
    try {
      await runBatch(admin, session, claimed[0], lockId);
    } finally {
      await admin.from('consultation_memory').update({ lock_id: null, locked_until: null })
        .eq('session_id', session.id).eq('lock_id', lockId);
    }
    if (!(await hasPending(admin, session.id))) return;
  }
}

export async function processSegment(body: { session_id: string; segment_id: string }, ctx: RequestContext) {
  const session = await ownedSession(ctx.db, ctx.userId, body.session_id);
  const { data: segment, error } = await ctx.db.from('transcript_segments').select('processing_status')
    .eq('id', body.segment_id).eq('session_id', session.id).maybeSingle();
  if (error) databaseError(error);
  if (!segment) throw new ApiError(404, 'segment_not_found', 'Segment not found');
  if (segment.processing_status === 'completed') return { status: 'not_needed' };
  // The agents take longer than the caller's dispatch timeout; segment rows are the durable queue.
  EdgeRuntime.waitUntil(drain(session).catch(async (e) => {
    const code = e instanceof ApiError ? e.code : 'internal_error';
    console.error(JSON.stringify({ trace_id: ctx.traceId, code }));
    await recordSystemEvent(adminClient(), session.id, 'agent.run.failed', { code }).catch(() => {});
  }));
  return { status: 'scheduled' };
}

// Call after update-session `ending`. Idempotent: a completed session returns its existing summary.
export async function finalizeSession(body: { session_id: string }, ctx: RequestContext) {
  const session = await ownedSession(ctx.db, ctx.userId, body.session_id);
  const admin = adminClient();
  const existing = async () => {
    const { data, error } = await admin.from('session_artifacts').select('id')
      .eq('session_id', session.id).eq('kind', 'summary').maybeSingle();
    if (error) databaseError(error);
    return data?.id ?? null;
  };
  if (session.status === 'completed') return { summary_id: await existing(), status: 'completed' };
  if (session.status !== 'ending') throw new ApiError(409, 'session_not_ending', 'End the consultation before writing the summary');

  const segments: { text: string }[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await admin.from('transcript_segments').select('text')
      .eq('session_id', session.id).order('sequence').range(offset, offset + 499);
    if (error) databaseError(error);
    segments.push(...data);
    if (data.length < 500) break;
  }
  const { data: memory, error } = await admin.from('consultation_memory').select('understanding, questions')
    .eq('session_id', session.id).maybeSingle();
  if (error) databaseError(error);

  await recordSystemEvent(admin, session.id, 'agent.summary.started', { segments: segments.length });
  const input = {
    transcript: segments.map((s) => s.text).join('\n'),
    understanding: memory?.understanding ?? null,
    questions: forAgents((memory?.questions ?? []) as MemoryQuestion[]),
  };
  const summary = await produce(admin, session, 'summary', summaryOutput, input, input, { segments: segments.length });
  // The app reads this envelope's payload directly as the summary (src/app/session/[id]/summary.tsx).
  const artifact = await saveJsonArtifact(admin, session, 'summary', summary.output as Json);
  await recordSystemEvent(admin, session.id, summary.flagged ? 'agent.summary.flagged_saved' : 'agent.summary.approved',
    { score: summary.verdict.score, attempts: summary.attempts }, artifact.id);
  const { error: completeError } = await admin.rpc('complete_consultation', { p_session_id: session.id });
  if (completeError) databaseError(completeError);
  return { summary_id: artifact.id, status: 'completed', flagged: summary.flagged };
}
