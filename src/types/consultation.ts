import type { Database, Json } from './database';

export type Session = Database['public']['Tables']['sessions']['Row'];
export type TranscriptSegment = Database['public']['Tables']['transcript_segments']['Row'];
export type Suggestion = Database['public']['Tables']['suggestions']['Row'];
export type SessionArtifact = Database['public']['Tables']['session_artifacts']['Row'];
export type AgentEvent = Database['public']['Tables']['agent_events']['Row'];
export type ArtifactKind = Database['public']['Enums']['artifact_kind'];
export type SessionTransition = Extract<Session['status'], 'active' | 'paused' | 'ending'>;
export type FinalTranscriptInput = Pick<TranscriptSegment,
  'id' | 'session_id' | 'sequence' | 'text' | 'start_ms' | 'end_ms' | 'source'>;

// All Edge Function requests use the caller's Supabase Auth JWT, including anonymous Auth users.
// Function names deliberately match the team's integration plan.
export type VoiceFunctions = {
  'create-session': { request: { session_id: string; consent: true }; response: { session: Session } };
  'get-scribe-token': { request: { session_id: string }; response: { token: string; expires_in: number } };
  'append-transcript': {
    request: FinalTranscriptInput;
    response: { segment: TranscriptSegment; agent_dispatch: 'delivered' | 'pending' | 'not_needed' };
  };
  'update-session': { request: { session_id: string; status: SessionTransition }; response: { session: Session } };
  'discard-session': { request: { session_id: string }; response: { discarded: true } };
};

// Person 3 implements these independently. process-segment MUST be idempotent by segment_id,
// load the transcript from Postgres, and set processing_status/processed_at after success.
// Failed dispatch never loses the durable transcript. Retry by resubmitting the same segment.
export type ProcessSegmentRequest = { session_id: string; segment_id: string };
export type FinalizeSessionRequest = { session_id: string };

// Save JSON artifacts, including rejected candidates/evaluation decisions, not hidden reasoning.
export type ArtifactEnvelope = {
  schema_version: 1;
  session_id: string;
  kind: ArtifactKind;
  created_at: string;
  payload: Json;
};

// Realtime contracts are Postgres row changes, not a separate broadcast protocol:
// transcript_segments INSERT -> transcript.final
// suggestions INSERT -> suggestion.created; UPDATE status=resolved -> suggestion.resolved
// sessions UPDATE status=completed -> summary.ready (summary artifact already persisted)
export const PATIENT_ARTIFACTS_BUCKET = 'patient-artifacts';
export const API_ACCEPT = 'application/json;version=1';
