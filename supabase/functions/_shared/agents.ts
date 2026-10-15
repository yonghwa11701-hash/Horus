import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import { z } from 'npm:zod@4.1.12';
import type { Database, Json } from '../../../src/types/database.ts';
import type { RequestContext } from './http.ts';
import { adminClient, ApiError, databaseError } from './http.ts';
import { ownedSession, recordSystemEvent, saveJsonArtifact } from './artifacts.ts';
import { assertAgentConfigured, AGENT_MODEL, callAgent, REVIEW_MODEL } from './claude.ts';
import { mergeQuestions, priorityLevel, suggestionStatus, type MemoryQuestion, type QuestionOut } from './agent-logic.ts';
import { dispatchAgents } from './sessions.ts';

declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };

type Admin = SupabaseClient<Database>;
type Session = Database['public']['Tables']['sessions']['Row'];
type Memory = Database['public']['Tables']['consultation_memory']['Row'];

// Spec retry rule (.plans/patient-advocate-agents-spec.md): up to 2 retries with evaluator feedback.
const MAX_RETRIES = 2;
// Hosted Edge Functions stop at ~150 s wall clock. Every agent call is aborted at DEADLINE_MS, before
// the lease (claimed after the start) expires, so no worker writes once another can take over.
const LEASE_SECONDS = 140;
const DEADLINE_MS = 130_000;
// A batch starts only with this much time left; otherwise a fresh invocation takes the rest.
const MIN_BATCH_MS = 60_000;
const MAX_BATCH = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    source_segment_ids: z.array(z.string()).optional(),
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
  input: Record<string, unknown>, evalInput: Record<string, unknown>, context: { [key: string]: Json }, signal: AbortSignal,
) {
  const [producer, evaluator, model] = FILES[agent];
  const attempts: { output: T; verdict: Evaluation }[] = [];
  let feedback: string | null = null;
  for (let i = 1; i <= MAX_RETRIES + 1; i++) {
    const output: T = await callAgent(producer, model, { ...input, evaluator_feedback: feedback }, schema, signal);
    const verdict: Evaluation = await callAgent(evaluator, REVIEW_MODEL, { ...evalInput, output }, evaluation, signal);
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

// The model can cite ids that do not exist; keep only segments of this session.
async function withKnownSources(admin: Admin, sessionId: string, questions: QuestionOut[]) {
  const cited = [...new Set(questions.flatMap((q) => q.source_segment_ids ?? []))].filter((id) => UUID.test(id));
  if (!cited.length) return questions.map((q) => ({ ...q, source_segment_ids: [] }));
  const { data, error } = await admin.from('transcript_segments').select('id').eq('session_id', sessionId).in('id', cited);
  if (error) databaseError(error);
  const known = new Set(data.map((s) => s.id));
  return questions.map((q) => ({ ...q, source_segment_ids: (q.source_segment_ids ?? []).filter((id) => known.has(id)) }));
}

// One batch: Understanding -> Question Generation (each with its evaluator) -> prioritise/dedup,
// committed atomically by save_agent_batch. Returns the number of segments processed.
async function runBatch(admin: Admin, session: Session, memory: Memory, lockId: string, signal: AbortSignal) {
  const { data: segments, error } = await admin.from('transcript_segments').select('id, text')
    .eq('session_id', session.id).neq('processing_status', 'completed').order('sequence').limit(MAX_BATCH);
  if (error) databaseError(error);
  if (!segments.length) return 0;
  const segmentIds = segments.map((s) => s.id);
  const setStatus = async (processing_status: 'processing' | 'failed') => {
    const { error } = await admin.from('transcript_segments').update({ processing_status, processed_at: null }).in('id', segmentIds);
    if (error) databaseError(error);
  };
  await setStatus('processing');
  await recordSystemEvent(admin, session.id, 'agent.run.started', { segment_ids: segmentIds });
  try {
    const questions = memory.questions as MemoryQuestion[];
    const context = { segment_ids: segmentIds };
    const understandingInput = {
      prior_state: memory.understanding,
      chunk: segments.map((s) => ({ segment_id: s.id, text: s.text })),
      patient_questions: questions.filter((q) => q.status === 'unanswered').map(({ id, text, status }) => ({ id, text, status })),
    };
    const understanding = await produce(admin, session, 'understanding', understandingOutput,
      understandingInput, understandingInput, context, signal);
    await saveJsonArtifact(admin, session, 'understanding', { ...context, flagged: understanding.flagged, state: understanding.output as Json });

    // Only evaluator-approved output moves on (CLAUDE.md §3). A rejected understanding is neither
    // stored nor shown to Question Generation; the summary still reads the full transcript.
    const events: { event_type: string; metadata: Json }[] = [];
    let merged: ReturnType<typeof mergeQuestions> | null = null;
    let score = 0, attempts = 0;
    if (understanding.flagged) {
      events.push({ event_type: 'agent.understanding.rejected', metadata: { score: understanding.verdict.score } });
    } else {
      const before = forAgents(questions);
      const generated = await produce(admin, session, 'questions', questionsOutput,
        { understanding: understanding.output, questions: before },
        { understanding: understanding.output, questions_before: before }, context, signal);
      await saveJsonArtifact(admin, session, 'questions', { ...context, flagged: generated.flagged, output: generated.output as Json });
      // A flagged list is rejected whole; the next chunk tries again from the unchanged list.
      if (!generated.flagged) {
        merged = mergeQuestions(questions, await withKnownSources(admin, session.id, generated.output.questions), () => crypto.randomUUID());
      }
      score = generated.verdict.score;
      attempts = generated.attempts;
      events.push({ event_type: generated.flagged ? 'agent.questions.rejected' : 'agent.questions.approved', metadata: {
        score, created: merged?.created.length ?? 0, changed: merged?.changed.length ?? 0,
      } });
    }

    const resolvedAt = (q: MemoryQuestion) => (q.status === 'answered' ? new Date().toISOString() : null);
    const created = (merged?.created ?? []).map((q) => ({
      question_id: q.question_id, question: q.text, priority: priorityLevel(q.priority), status: suggestionStatus(q.status),
      source_segment_ids: q.source_segment_ids ?? [], resolved_at: resolvedAt(q),
      evaluation: { relevant: true, supported: true, advice_free: true, score, attempts, reason: q.reason ?? null },
    }));
    const changed = (merged?.changed ?? []).map((q) => ({
      question_id: q.question_id, priority: priorityLevel(q.priority), status: suggestionStatus(q.status), resolved_at: resolvedAt(q),
    }));
    for (const q of created) events.push({ event_type: 'suggestion.created', metadata: { question_id: q.question_id, priority: q.priority } });
    for (const q of changed) {
      if (q.status === 'resolved') events.push({ event_type: 'suggestion.resolved', metadata: { question_id: q.question_id } });
    }
    const { data: saved, error: saveError } = await admin.rpc('save_agent_batch', {
      p_session_id: session.id, p_lock_id: lockId,
      p_understanding: understanding.flagged ? memory.understanding : understanding.output as Json,
      p_questions: (merged?.questions ?? questions) as Json,
      p_created: created as Json, p_changed: changed as Json, p_segment_ids: segmentIds, p_events: events as Json,
    });
    if (saveError) databaseError(saveError);
    if (!saved) throw new ApiError(409, 'lease_lost', 'Another worker took over this consultation');
    return segments.length;
  } catch (error) {
    // After losing the lease, the rows belong to the new holder.
    if (!(error instanceof ApiError && error.code === 'lease_lost')) await setStatus('failed').catch(() => {});
    throw error;
  }
}

// A segment to hand to the next invocation, or null. Include failed batches so a
// repaired configuration/provider failure can be retried before finalization too.
async function nextUnprocessed(admin: Admin, sessionId: string) {
  const { data, error } = await admin.from('transcript_segments').select('id')
    .eq('session_id', sessionId).neq('processing_status', 'completed').order('sequence').limit(1);
  if (error) databaseError(error);
  return data[0]?.id ?? null;
}

async function claim(admin: Admin, sessionId: string, lockId: string) {
  const { data, error } = await admin.rpc('claim_agent_memory', {
    p_session_id: sessionId, p_lock_id: lockId, p_lease_seconds: LEASE_SECONDS,
  });
  if (error) databaseError(error);
  return data?.[0] ?? null;
}

const release = (admin: Admin, sessionId: string, lockId: string) =>
  admin.from('consultation_memory').update({ lock_id: null, locked_until: null }).eq('session_id', sessionId).eq('lock_id', lockId);

// Processes every unprocessed segment of the session in order, one worker per session.
// A dispatch that finds the lease taken returns at once; the holder re-checks for unprocessed
// segments after releasing, and hands leftovers to a fresh invocation when out of time.
async function drain(session: Session, authorization: string) {
  const admin = adminClient();
  const started = Date.now();
  const signal = AbortSignal.timeout(DEADLINE_MS);
  for (;;) {
    const { data: current, error: sessionError } = await admin.from('sessions').select('status').eq('id', session.id).maybeSingle();
    if (sessionError) databaseError(sessionError);
    // Keep going while ending: finalize-session waits for these questions.
    if (current?.status !== 'active' && current?.status !== 'paused' && current?.status !== 'ending') return;
    if (DEADLINE_MS - (Date.now() - started) < MIN_BATCH_MS) {
      const next = await nextUnprocessed(admin, session.id);
      if (next && !(await dispatchAgents(authorization, session.id, next))) {
        await recordSystemEvent(admin, session.id, 'agent.dispatch_pending', { segment_id: next });
      }
      return;
    }
    const lockId = crypto.randomUUID();
    const memory = await claim(admin, session.id, lockId);
    if (!memory) return;
    try {
      await runBatch(admin, session, memory, lockId, signal);
    } finally {
      await release(admin, session.id, lockId);
    }
    if (!(await nextUnprocessed(admin, session.id))) return;
  }
}

const logDrainFailure = (sessionId: string, traceId: string) => async (e: unknown) => {
  const code = e instanceof ApiError ? e.code : 'internal_error';
  console.error(JSON.stringify({ trace_id: traceId, code }));
  await recordSystemEvent(adminClient(), sessionId, 'agent.run.failed', { code }).catch(() => {});
};

export async function processSegment(body: { session_id: string; segment_id: string }, ctx: RequestContext) {
  const session = await ownedSession(ctx.db, ctx.userId, body.session_id);
  const { data: segment, error } = await ctx.db.from('transcript_segments').select('processing_status')
    .eq('id', body.segment_id).eq('session_id', session.id).maybeSingle();
  if (error) databaseError(error);
  if (!segment) throw new ApiError(404, 'segment_not_found', 'Segment not found');
  if (segment.processing_status === 'completed') return { status: 'not_needed' };
  assertAgentConfigured(); // Fail visibly before scheduling work with missing configuration.
  // The agents take longer than the caller's dispatch timeout; segment rows are the durable queue.
  EdgeRuntime.waitUntil(drain(session, ctx.authorization).catch(logDrainFailure(session.id, ctx.traceId)));
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
  assertAgentConfigured(); // A missing key is a configuration failure, not an agents_busy conflict.

  // The summary needs the questions from every segment; let the live agents finish first.
  if (await nextUnprocessed(admin, session.id)) {
    EdgeRuntime.waitUntil(drain(session, ctx.authorization).catch(logDrainFailure(session.id, ctx.traceId)));
    throw new ApiError(409, 'agents_busy', 'Still processing the transcript; try again shortly');
  }
  // The same lease serialises finalisation with agent batches and with a concurrent finalize call.
  const lockId = crypto.randomUUID();
  const memory = await claim(admin, session.id, lockId);
  if (!memory) throw new ApiError(409, 'agents_busy', 'The summary is already being written; try again shortly');
  try {
    const { data: current, error: statusError } = await admin.from('sessions').select('status').eq('id', session.id).single();
    if (statusError) databaseError(statusError);
    if (current.status === 'completed') return { summary_id: await existing(), status: 'completed' };

    const segments: { text: string }[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await admin.from('transcript_segments').select('text')
        .eq('session_id', session.id).order('sequence').range(offset, offset + 499);
      if (error) databaseError(error);
      segments.push(...data);
      if (data.length < 500) break;
    }

    await recordSystemEvent(admin, session.id, 'agent.summary.started', { segments: segments.length });
    const input = {
      transcript: segments.map((s) => s.text).join('\n'),
      understanding: memory.understanding,
      questions: forAgents(memory.questions as MemoryQuestion[]),
    };
    const summary = await produce(admin, session, 'summary', summaryOutput, input, input,
      { segments: segments.length }, AbortSignal.timeout(DEADLINE_MS));
    // Only an evaluator-approved summary is published (CLAUDE.md §3). The session stays `ending` so
    // the patient can try again; every rejected attempt is already saved as an evaluation artifact.
    if (summary.flagged) {
      await recordSystemEvent(admin, session.id, 'agent.summary.rejected', { score: summary.verdict.score, attempts: summary.attempts });
      throw new ApiError(502, 'summary_rejected', 'The summary did not pass its checks; try again');
    }
    // The app reads this envelope's payload directly as the summary (src/app/session/[id]/summary.tsx).
    const artifact = await saveJsonArtifact(admin, session, 'summary', summary.output as Json);
    await recordSystemEvent(admin, session.id, 'agent.summary.approved',
      { score: summary.verdict.score, attempts: summary.attempts }, artifact.id);
    const { error: completeError } = await admin.rpc('complete_consultation', { p_session_id: session.id });
    if (completeError) databaseError(completeError);
    return { summary_id: artifact.id, status: 'completed' };
  } finally {
    await release(admin, session.id, lockId);
  }
}
