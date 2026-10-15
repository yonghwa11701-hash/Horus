import { FunctionsHttpError } from '@supabase/supabase-js';
import { randomUUID } from 'expo-crypto';
import { ensureAnonymousSession, getSupabase } from './supabase';
import { voiceDebug } from './voice/debug';
import { API_ACCEPT, PATIENT_ARTIFACTS_BUCKET } from '@/types/consultation';
import type {
  ArtifactEnvelope, FinalTranscriptInput, Session, SessionArtifact,
  SessionTransition, Suggestion, TranscriptSegment, VoiceFunctions,
} from '@/types/consultation';

export class ConsultationApiError extends Error {
  constructor(message: string, public status?: number, public code?: string) { super(message); }
}

async function invoke<Response>(name: string, body: Record<string, unknown>): Promise<Response> {
  const startedAt = Date.now();
  voiceDebug('request', { function_name: name, outcome: 'requested' });
  try {
    const data = await invokeResponse<Response>(name, body);
    voiceDebug('request', { function_name: name, outcome: 'success', duration_ms: Date.now() - startedAt });
    return data;
  } catch (error) {
    voiceDebug('request', {
      function_name: name, outcome: 'failure', duration_ms: Date.now() - startedAt,
      status: error instanceof ConsultationApiError ? error.status : undefined,
    });
    throw error;
  }
}

async function invokeResponse<Response>(name: string, body: Record<string, unknown>): Promise<Response> {
  await ensureAnonymousSession();
  const { data, error } = await getSupabase().functions.invoke<Response>(name, {
    body, headers: { Accept: API_ACCEPT },
  });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const problem = await error.context.json().catch(() => null);
      if (error.context.status === 404 && problem?.code === 'NOT_FOUND') {
        throw new ConsultationApiError(`Supabase Edge Function "${name}" is not deployed. Deploy the functions to the project configured in Horus/.env.`, 404, 'function_not_deployed');
      }
      throw new ConsultationApiError(problem?.detail ?? problem?.message ?? 'The consultation request failed.', error.context.status, problem?.code);
    }
    // Browsers also report failed preflights (including undeployed functions) as fetch failures.
    throw new ConsultationApiError(`Could not reach Supabase function "${name}". Check Edge Function deployment, the browser ALLOWED_ORIGINS setting, and network access.`, undefined, 'service_unreachable');
  }
  if (!data) throw new ConsultationApiError('The consultation service returned an empty response.');
  return data;
}

export function invokeVoiceFunction<Name extends keyof VoiceFunctions>(
  name: Name, body: VoiceFunctions[Name]['request'],
): Promise<VoiceFunctions[Name]['response']> {
  return invoke(name, body);
}

// Retain sessionId if retrying a failed creation; a new id means a new consultation.
export function createConsultation(consent: boolean, sessionId = randomUUID()) {
  if (consent !== true) throw new Error('All speakers must consent before starting a consultation.');
  return invokeVoiceFunction('create-session', { session_id: sessionId, consent: true });
}
export const getScribeToken = (sessionId: string) => invokeVoiceFunction('get-scribe-token', { session_id: sessionId });
export const appendFinalTranscript = (segment: FinalTranscriptInput) => invokeVoiceFunction('append-transcript', segment);
export const setSessionStatus = (sessionId: string, status: SessionTransition) =>
  invokeVoiceFunction('update-session', { session_id: sessionId, status });
export const discardConsultation = (sessionId: string) => invokeVoiceFunction('discard-session', { session_id: sessionId });

// Person 3 owns this implementation. Call only after voice.stop() and update-session ending.
export const finalizeConsultation = (sessionId: string) => invoke<unknown>('finalize-session', { session_id: sessionId });

export async function loadConsultation(sessionId: string) {
  await ensureAnonymousSession();
  const db = getSupabase();
  const { data: session, error } = await db.from('sessions').select('*').eq('id', sessionId).single();
  if (error) throw new ConsultationApiError('Could not load this consultation.');
  const segments: TranscriptSegment[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await db.from('transcript_segments').select('*').eq('session_id', sessionId)
      .order('sequence').range(offset, offset + 499);
    if (result.error) throw new ConsultationApiError('Could not load the transcript.');
    segments.push(...result.data);
    if (result.data.length < 500) break;
  }
  const suggestions: Suggestion[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await db.from('suggestions').select('*').eq('session_id', sessionId)
      .order('created_at').order('question_id').range(offset, offset + 499);
    if (result.error) throw new ConsultationApiError('Could not load suggestions.');
    suggestions.push(...result.data);
    if (result.data.length < 500) break;
  }
  return { session, segments, suggestions };
}

export async function loadTranscriptCursor(sessionId: string) {
  await ensureAnonymousSession();
  const { data, error } = await getSupabase().from('transcript_segments').select('sequence, end_ms')
    .eq('session_id', sessionId).order('sequence', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new ConsultationApiError('Could not resume the transcript.');
  return { sequence: (data?.sequence ?? -1) + 1, offsetMs: data?.end_ms ?? 0 };
}

export async function retryPendingSegments(sessionId: string) {
  await ensureAnonymousSession();
  // Bounded batches. Person 3 owns recovering stale processing leases, not this client.
  const { data, error } = await getSupabase().from('transcript_segments').select('*')
    .eq('session_id', sessionId).in('processing_status', ['pending', 'failed']).order('sequence').limit(20);
  if (error) throw new ConsultationApiError('Could not load pending segments.');
  for (const segment of data) {
    await appendFinalTranscript({
      id: segment.id, session_id: segment.session_id, sequence: segment.sequence, text: segment.text,
      start_ms: segment.start_ms, end_ms: segment.end_ms, source: segment.source,
    });
  }
  return data.length;
}

export type ConsultationListeners = {
  onSession?: (session: Session) => void;
  onTranscript?: (segment: TranscriptSegment) => void;
  onSuggestion?: (suggestion: Suggestion) => void;
  onArtifact?: (artifact: SessionArtifact) => void;
  onStatus?: (status: string) => void;
};

// Subscribe first, then loadConsultation on SUBSCRIBED and each reconnect. Merge by row id
// (question_id for suggestions), not append-only: this closes initial-load/reconnect gaps.
export async function subscribeToConsultation(sessionId: string, listeners: ConsultationListeners) {
  await ensureAnonymousSession();
  const db = getSupabase();
  const filter = `session_id=eq.${sessionId}`;
  const channel = db.channel(`consultation:${sessionId}:${randomUUID()}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
      (event) => listeners.onSession?.(event.new as Session))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transcript_segments', filter },
      (event) => listeners.onTranscript?.(event.new as TranscriptSegment))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'transcript_segments', filter },
      (event) => listeners.onTranscript?.(event.new as TranscriptSegment))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'suggestions', filter },
      (event) => listeners.onSuggestion?.(event.new as Suggestion))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'suggestions', filter },
      (event) => listeners.onSuggestion?.(event.new as Suggestion))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'session_artifacts', filter },
      (event) => listeners.onArtifact?.(event.new as SessionArtifact))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'session_artifacts', filter },
      (event) => listeners.onArtifact?.(event.new as SessionArtifact))
    .subscribe((status) => listeners.onStatus?.(status));
  return () => { void db.removeChannel(channel); };
}

export async function loadSummary(sessionId: string): Promise<ArtifactEnvelope> {
  await ensureAnonymousSession();
  const db = getSupabase();
  const { data: artifact, error } = await db.from('session_artifacts').select('*')
    .eq('session_id', sessionId).eq('kind', 'summary').single();
  if (error) throw new ConsultationApiError('The summary is not ready yet.');
  const signed = await db.storage.from(PATIENT_ARTIFACTS_BUCKET).createSignedUrl(artifact.storage_path, 60);
  if (signed.error) throw new ConsultationApiError('Could not open the private summary.');
  // Fetching JSON works on native as well as web; Blob.text is not universal on RN.
  const response = await fetch(signed.data.signedUrl);
  if (!response.ok) throw new ConsultationApiError('Could not download the summary.');
  return response.json();
}

