// Every backend call goes through here (CLAUDE.md §10).
// ponytail: mock-only; wire Supabase (anon key + Realtime) once Angelika's schema lands.
import { USE_MOCKS } from '@/lib/config';
import * as mock from '@/lib/mock';
import type { Suggestion, Summary, TranscriptSegment } from '@/types/api';

const delay = (ms = 300) => new Promise((r) => setTimeout(r, ms));

function mocksOnly() {
  if (!USE_MOCKS) throw new Error('Supabase not wired yet: set USE_MOCKS in lib/config.ts');
}

export async function createSession(): Promise<{ session_id: string }> {
  mocksOnly();
  await delay();
  return { session_id: `demo-${Date.now().toString(36)}` };
}

/** Calls back with the full list on every change (initial fetch + Realtime), so reconnects reconcile for free. */
export function subscribeSuggestions(sessionId: string, cb: (s: Suggestion[]) => void): () => void {
  mocksOnly();
  const s = mock.store(sessionId);
  const l = () => cb(s.suggestions);
  s.listeners.add(l);
  l();
  return () => s.listeners.delete(l);
}

export function subscribeSegments(sessionId: string, cb: (s: TranscriptSegment[]) => void): () => void {
  mocksOnly();
  const s = mock.store(sessionId);
  const l = () => cb(s.segments);
  s.listeners.add(l);
  l();
  return () => s.listeners.delete(l);
}

/** update-suggestion. The app only ever sends "dismissed". */
export async function dismissSuggestion(sessionId: string, suggestionId: string): Promise<void> {
  mocksOnly();
  await delay(200);
  const s = mock.store(sessionId);
  s.suggestions = s.suggestions.map((q) => (q.id === suggestionId ? { ...q, status: 'dismissed' } : q));
  mock.emit(sessionId);
}

export async function finalizeSession(sessionId: string): Promise<{ summary_id: string }> {
  mocksOnly();
  mock.pause(sessionId);
  await delay(2500);
  return { summary_id: `sum-${sessionId}` };
}

export async function getSummary(sessionId: string, _summaryId: string): Promise<Summary> {
  mocksOnly();
  await delay();
  return mock.buildSummary(sessionId);
}

export async function getSegments(sessionId: string): Promise<TranscriptSegment[]> {
  mocksOnly();
  return mock.store(sessionId).segments;
}

export async function retainSession(_sessionId: string, _keep: boolean): Promise<void> {
  mocksOnly();
  await delay();
}
