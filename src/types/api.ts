// Shared API types — mirror CLAUDE.md §8. Do not redefine elsewhere.

export type Session = {
  id: string;
  user_id: string;
  started_at: string;
  ended_at?: string;
  status: 'live' | 'paused' | 'ended' | 'saved' | 'discarded';
};

export type TranscriptSegment = {
  id: number;
  session_id: string;
  seq: number;
  text: string;
  start_ms?: number;
  end_ms?: number;
  created_at: string;
};

export type Suggestion = {
  id: string;
  session_id: string;
  question: string;
  priority: 'high' | 'medium' | 'low';
  status: 'active' | 'asked' | 'answered' | 'dismissed' | 'flagged' | 'rejected';
  source_segment_ids: number[];
  evaluation: { relevant: boolean; supported: boolean; advice_free: boolean; reason?: string };
  created_at: string;
};

export type SummaryLine = { text: string; segment_ids: number[]; kind: 'summary' | 'next_step' | 'outstanding' };

export type Summary = { id: string; session_id: string; lines: SummaryLine[]; created_at: string };

export type AgentEvent = {
  id: number;
  session_id: string;
  agent: 'transcriber' | 'understanding' | 'question_generation' | 'evaluation' | 'prioritisation' | 'resolution' | 'summary';
  type: 'started' | 'output' | 'approved' | 'rejected' | 'retry' | 'error';
  payload: unknown;
  cost_usd?: number;
  created_at: string;
};
