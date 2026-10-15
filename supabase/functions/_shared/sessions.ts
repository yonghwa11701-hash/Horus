import type { RequestContext } from './http.ts';
import { adminClient, ApiError, databaseError, env } from './http.ts';
import { ownedSession, recordSystemEvent, removeSessionFiles, saveSessionSnapshots } from './artifacts.ts';
import type { Database } from '../../../src/types/database.ts';

// Supabase keeps short background tasks alive after the HTTP response; the DB row
// remains the durable retry source if a task is interrupted.
declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };

type SegmentInput = {
  id: string; session_id: string; sequence: number; text: string;
  start_ms: number; end_ms: number; source: Database['public']['Enums']['transcript_source'];
};

export async function createSession(body: { session_id: string; consent: true }, ctx: RequestContext) {
  const { data, error } = await ctx.db.rpc('create_consultation', { p_id: body.session_id, p_consent: body.consent }).single();
  if (error) databaseError(error);
  return { session: data };
}

export async function getScribeToken(body: { session_id: string }, ctx: RequestContext) {
  const key = env('ELEVENLABS_API_KEY');
  const { error } = await ctx.db.rpc('reserve_scribe_token', { p_session_id: body.session_id });
  if (error) databaseError(error);
  let response: Response;
  try {
    response = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
      method: 'POST', headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10000),
    });
  } catch { throw new ApiError(502, 'scribe_unavailable', 'Transcription authentication is temporarily unavailable'); }
  if (!response.ok) throw new ApiError(502, 'scribe_unavailable', 'Transcription authentication is temporarily unavailable');
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('token' in result) || typeof result.token !== 'string') {
    throw new ApiError(502, 'scribe_invalid_response', 'Transcription authentication returned an invalid response');
  }
  // Single use, expires after 15 minutes. Do not persist or log it.
  return { token: result.token, expires_in: 900 };
}

export async function appendTranscript(body: SegmentInput, ctx: RequestContext) {
  const { data: segment, error } = await ctx.db.rpc('append_transcript', {
    p_id: body.id, p_session_id: body.session_id, p_sequence: body.sequence, p_text: body.text,
    p_start_ms: body.start_ms, p_end_ms: body.end_ms, p_source: body.source,
  }).single();
  if (error) databaseError(error);
  if (segment.processing_status === 'completed') return { segment, agent_dispatch: 'not_needed' };
  // Persistence is the durable handoff. No agent deployment is required to transcribe.
  // Person 3 must make processing idempotent and update processing_status after success.
  if (Deno.env.get('ENABLE_AGENT_DISPATCH') !== 'true') return { segment, agent_dispatch: 'pending' };
  EdgeRuntime.waitUntil((async () => {
    let delivered = false;
    try {
      const response = await fetch(`${env('SUPABASE_URL')}/functions/v1/process-segment`, {
        method: 'POST',
        headers: {
          Authorization: ctx.authorization, apikey: env('SUPABASE_ANON_KEY'),
          'Content-Type': 'application/json', Accept: 'application/json;version=1',
        },
        body: JSON.stringify({ session_id: segment.session_id, segment_id: segment.id }),
        signal: AbortSignal.timeout(20000),
      });
      delivered = response.ok;
      await response.body?.cancel();
    } catch { /* The segment remains pending and can be retried with its original id. */ }
    // Record dispatch state without transcript/response content or credentials.
    try {
      await recordSystemEvent(adminClient(), segment.session_id, delivered ? 'agent.dispatch_delivered' : 'agent.dispatch_pending', {
        segment_id: segment.id,
      });
    } catch { /* Discard may already have removed this session. Never log its contents. */ }
  })());
  return { segment, agent_dispatch: 'scheduled' };
}

export async function updateSession(
  body: { session_id: string; status: 'active' | 'paused' | 'ending' }, ctx: RequestContext,
) {
  const { data: session, error } = await ctx.db.rpc('transition_consultation', {
    p_session_id: body.session_id, p_status: body.status,
  }).single();
  if (error) databaseError(error);
  // Stop/drain microphone and persist final segments BEFORE transitioning to ending.
  // Retry this request if snapshots fail; the ending transition is idempotent.
  if (session.status === 'ending') await saveSessionSnapshots(adminClient(), session);
  return { session };
}

export async function discardSession(body: { session_id: string }, ctx: RequestContext) {
  const { data: existing, error: lookupError } = await ctx.db.from('sessions').select('id')
    .eq('id', body.session_id).eq('user_id', ctx.userId).maybeSingle();
  if (lookupError) databaseError(lookupError);
  // Idempotent retry after a successful deletion; never reveals another user's session.
  if (!existing) return { discarded: true };
  await ownedSession(ctx.db, ctx.userId, body.session_id);
  const { data: session, error } = await ctx.db.rpc('transition_consultation', {
    p_session_id: body.session_id, p_status: 'discarding',
  }).single();
  if (error) databaseError(error);
  const admin = adminClient();
  await removeSessionFiles(admin, session);
  const { error: deleteError } = await admin.rpc('delete_discarded_consultation', { p_session_id: session.id });
  if (deleteError) databaseError(deleteError);
  // Cascades remove transcripts, questions, artifacts metadata and session audit data.
  return { discarded: true };
}
