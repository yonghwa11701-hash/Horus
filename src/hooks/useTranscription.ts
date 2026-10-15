// MOCK — Kendrick owns this file (CLAUDE.md §9) and replaces it with the real mic/Scribe implementation.
// Interface is frozen; screens only call it.
import { useCallback, useState } from 'react';

import * as mock from '@/lib/mock';

type Status = 'idle' | 'connecting' | 'live' | 'paused' | 'error';

export function useTranscription({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<Status>('idle');

  const start = useCallback(async () => {
    setStatus('connecting');
    await new Promise((r) => setTimeout(r, 600));
    mock.play(sessionId);
    setStatus('live');
  }, [sessionId]);

  const pause = useCallback(async () => {
    mock.pause(sessionId);
    setStatus('paused');
  }, [sessionId]);

  const stop = useCallback(async () => {
    mock.pause(sessionId);
    setStatus('idle');
  }, [sessionId]);

  return {
    start,
    pause,
    stop,
    status,
    mode: 'chunked' as 'realtime' | 'chunked',
    lastSegmentSeq: mock.store(sessionId).segments.length,
    error: null as string | null,
  };
}
