// Synthetic consultation (no real patient data). Plays while the mock transcription is "live".
import type { Suggestion, Summary, TranscriptSegment } from '@/types/api';

type Step =
  | { t: number; say: string }
  | { t: number; suggest: Pick<Suggestion, 'id' | 'question' | 'priority' | 'source_segment_ids'> }
  | { t: number; set: { id: string } & Partial<Pick<Suggestion, 'status' | 'priority'>> };

const SCRIPT: Step[] = [
  { t: 1, say: "Thanks for coming in. I've got your blood test results back." },
  { t: 4, say: "Your HbA1c came back at 52, that's in the diabetes range." },
  { t: 7, suggest: { id: 'q1', question: 'What does an HbA1c of 52 mean for me?', priority: 'medium', source_segment_ids: [2] } },
  { t: 9, say: "I'd like to start you on metformin, 500mg once a day with food." },
  { t: 12, suggest: { id: 'q2', question: 'What side effects should I watch for with metformin?', priority: 'high', source_segment_ids: [3] } },
  { t: 15, say: "And we'll recheck your bloods in about three months." },
  { t: 18, suggest: { id: 'q3', question: 'Who books the three-month blood test?', priority: 'low', source_segment_ids: [4] } },
  { t: 22, say: 'What side effects should I watch for?' },
  { t: 25, say: 'Mostly an upset stomach at first, which usually settles. Taking it with food helps.' },
  { t: 27, set: { id: 'q2', status: 'answered' } },
  { t: 34, set: { id: 'q1', priority: 'high' } },
  { t: 38, say: 'Do you have any questions about that so far?' },
];

type Store = { elapsed: number; segments: TranscriptSegment[]; suggestions: Suggestion[]; listeners: Set<() => void> };

const stores = new Map<string, Store>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
const now = () => new Date().toISOString();

export function store(sessionId: string): Store {
  let s = stores.get(sessionId);
  if (!s) stores.set(sessionId, (s = { elapsed: 0, segments: [], suggestions: [], listeners: new Set() }));
  return s;
}

export function emit(sessionId: string) {
  store(sessionId).listeners.forEach((l) => l());
}

function tick(sessionId: string) {
  const s = store(sessionId);
  s.elapsed += 1;
  for (const step of SCRIPT.filter((x) => x.t === s.elapsed)) {
    if ('say' in step) {
      const seq = s.segments.length + 1;
      s.segments = [...s.segments, { id: seq, session_id: sessionId, seq, text: step.say, start_ms: step.t * 1000, created_at: now() }];
    } else if ('suggest' in step) {
      s.suggestions = [
        ...s.suggestions,
        { ...step.suggest, session_id: sessionId, status: 'active', evaluation: { relevant: true, supported: true, advice_free: true }, created_at: now() },
      ];
    } else {
      s.suggestions = s.suggestions.map((q) => (q.id === step.set.id ? { ...q, ...step.set } : q));
    }
  }
  emit(sessionId);
}

export function play(sessionId: string) {
  if (!timers.has(sessionId)) timers.set(sessionId, setInterval(() => tick(sessionId), 1000));
}

export function pause(sessionId: string) {
  clearInterval(timers.get(sessionId));
  timers.delete(sessionId);
}

export function buildSummary(sessionId: string): Summary {
  return {
    id: `sum-${sessionId}`,
    session_id: sessionId,
    created_at: now(),
    lines: [
      { kind: 'summary', text: 'Your HbA1c came back at 52, which the doctor said is in the diabetes range.', segment_ids: [2] },
      { kind: 'summary', text: 'The doctor suggested starting metformin, once a day with food.', segment_ids: [3] },
      { kind: 'summary', text: 'The doctor said side effects are mostly an upset stomach at first, which usually settles.', segment_ids: [6] },
      { kind: 'next_step', text: 'Start metformin 500mg once a day with food.', segment_ids: [3] },
      { kind: 'next_step', text: 'Blood test again in about 3 months.', segment_ids: [4] },
      { kind: 'outstanding', text: 'Who books the three-month blood test?', segment_ids: [4] },
    ],
  };
}
