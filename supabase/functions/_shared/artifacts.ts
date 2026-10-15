import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import type { Database, Json } from '../../../src/types/database.ts';
import { ApiError, databaseError } from './http.ts';

type Session = Database['public']['Tables']['sessions']['Row'];
type Kind = Database['public']['Enums']['artifact_kind'];
const BUCKET = 'patient-artifacts';

export async function ownedSession(db: SupabaseClient<Database>, userId: string, sessionId: string): Promise<Session> {
  const { data, error } = await db.from('sessions').select('*').eq('id', sessionId).eq('user_id', userId).maybeSingle();
  if (error) databaseError(error);
  if (!data) throw new ApiError(404, 'session_not_found', 'Session not found');
  return data;
}

// Person 3: use a session obtained via ownedSession, never one constructed from a request body.
// Store every structured output, including rejected candidates. Do not store hidden reasoning.
export async function saveJsonArtifact(
  admin: SupabaseClient<Database>, session: Session, kind: Kind, payload: Json,
) {
  const { data: current, error: sessionError } = await admin.from('sessions').select('status').eq('id', session.id).maybeSingle();
  if (sessionError) databaseError(sessionError);
  if (!current || current.status === 'discarding') throw new ApiError(409, 'session_unavailable', 'Session is unavailable for writes');
  const artifactId = crypto.randomUUID();
  const name = kind === 'transcript' || kind === 'summary' || kind === 'audit'
    ? `${kind}.json` : `agent-outputs/${kind}-${artifactId}.json`;
  const storagePath = `${session.user_id}/${session.id}/${name}`;
  const body = JSON.stringify({ schema_version: 1, session_id: session.id, kind, created_at: new Date().toISOString(), payload });
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, new TextEncoder().encode(body), {
    contentType: 'application/json', upsert: true,
  });
  if (uploadError) throw new ApiError(503, 'storage_unavailable', 'Could not save the JSON artifact');
  const { data, error } = await admin.from('session_artifacts').upsert({
    session_id: session.id, kind, storage_path: storagePath, schema_version: 1,
  }, { onConflict: 'storage_path' }).select('*').single();
  if (error) {
    // The DB guard rejects writes racing discard. Remove the late upload, too.
    const { data: latest } = await admin.from('sessions').select('status').eq('id', session.id).maybeSingle();
    if (!latest || latest.status === 'discarding') {
      const { error: removeError } = await admin.storage.from(BUCKET).remove([storagePath]);
      if (removeError) throw new ApiError(503, 'artifact_cleanup_failed', 'Artifact cleanup needs a retry');
    }
    databaseError(error);
  }
  await recordSystemEvent(admin, session.id, 'artifact.saved', { kind }, data.id);
  return data;
}

export async function recordSystemEvent(
  admin: SupabaseClient<Database>, sessionId: string, eventType: string,
  metadata: { [key: string]: Json | undefined } = {}, artifactId?: string,
) {
  const { error } = await admin.from('agent_events').insert({
    session_id: sessionId, event_type: eventType, actor: 'system',
    metadata, artifact_id: artifactId ?? null,
  });
  if (error) databaseError(error);
}

// Stable ordering + pagination avoids silently truncating appointments at the API row limit.
export async function saveSessionSnapshots(admin: SupabaseClient<Database>, session: Session) {
  const transcript: Database['public']['Tables']['transcript_segments']['Row'][] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await admin.from('transcript_segments').select('*')
      .eq('session_id', session.id).order('sequence').range(offset, offset + 499);
    if (error) databaseError(error);
    transcript.push(...data);
    if (data.length < 500) break;
  }
  await saveJsonArtifact(admin, session, 'transcript', { segments: transcript });
  const events: Database['public']['Tables']['agent_events']['Row'][] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await admin.from('agent_events').select('*').eq('session_id', session.id)
      .order('created_at').order('id').range(offset, offset + 499);
    if (error) databaseError(error);
    events.push(...data);
    if (data.length < 500) break;
  }
  await saveJsonArtifact(admin, session, 'audit', { events });
}

// Enumerate the actual prefix, not only metadata: failed uploads can leave untracked files.
// Mark discarding BEFORE calling this. Agents' DB guards and late-upload cleanup then apply.
export async function removeSessionFiles(admin: SupabaseClient<Database>, session: Session) {
  const files: string[] = [];
  async function collect(prefix: string) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin.storage.from(BUCKET).list(prefix, {
        limit: 1000, offset, sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw new ApiError(503, 'storage_unavailable', 'Could not list session files; retry discard');
      for (const entry of data) {
        const path = `${prefix}/${entry.name}`;
        if (entry.id) files.push(path); else await collect(path);
      }
      if (data.length < 1000) break;
    }
  }
  await collect(`${session.user_id}/${session.id}`);
  for (let offset = 0; offset < files.length; offset += 100) {
    const { error } = await admin.storage.from(BUCKET).remove(files.slice(offset, offset + 100));
    if (error) throw new ApiError(503, 'storage_unavailable', 'Could not remove all session files; retry discard');
  }
}
