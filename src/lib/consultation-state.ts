import type { Session, Suggestion, TranscriptSegment } from '../types/consultation.ts';

// Match the server's z.uuid() boundary; do not coerce missing or array route params.
export function isConsultationId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(value);
}

export type ConsultationSnapshot = { session: Session; segments: TranscriptSegment[]; suggestions: Suggestion[] };
export type ConsultationEvent =
  | { kind: 'session'; row: Session }
  | { kind: 'transcript'; row: TranscriptSegment }
  | { kind: 'suggestion'; row: Suggestion };

// Replay events received DURING a snapshot request, in arrival order, after loading
// the snapshot. A simple merge of the old arrays cannot distinguish stale row versions.
export function replayConsultationEvents(snapshot: ConsultationSnapshot, events: ConsultationEvent[]): ConsultationSnapshot {
  let session = snapshot.session;
  const segments = new Map(snapshot.segments.map((row) => [row.id, row]));
  const suggestions = new Map(snapshot.suggestions.map((row) => [row.question_id, row]));
  for (const event of events) {
    if (event.kind === 'session') session = event.row;
    else if (event.kind === 'transcript') segments.set(event.row.id, event.row);
    else suggestions.set(event.row.question_id, event.row);
  }
  return {
    session,
    segments: [...segments.values()].sort((a, b) => a.sequence - b.sequence),
    suggestions: [...suggestions.values()],
  };
}
