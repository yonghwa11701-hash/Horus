import type { Session, Suggestion, TranscriptSegment } from '../types/consultation.ts';

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
