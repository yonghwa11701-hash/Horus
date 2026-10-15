import { z } from 'npm:zod@4.1.12';
import type { Database } from '../../../src/types/database.ts';

export const sessionRequest = z.object({ session_id: z.uuid() }).strict();
export const createSessionRequest = sessionRequest.extend({ consent: z.literal(true) });
export const updateSessionRequest = sessionRequest.extend({ status: z.enum(['active', 'paused', 'ending']) });
const transcriptSources = ['elevenlabs', 'manual_demo'] as const satisfies readonly Database['public']['Enums']['transcript_source'][];
export const transcriptRequest = sessionRequest.extend({
  id: z.uuid(),
  sequence: z.number().int().min(0).max(2147483647),
  text: z.string().trim().min(1).max(16000),
  start_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  end_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  source: z.enum(transcriptSources),
}).refine((value) => value.end_ms >= value.start_ms);
export const processSegmentRequest = sessionRequest.extend({ segment_id: z.uuid() });
