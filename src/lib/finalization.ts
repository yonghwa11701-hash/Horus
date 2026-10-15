const RETRY_DELAY_MS = 3000;
const MAX_BUSY_WAIT_MS = 180_000;
const MAX_BUSY_RETRIES = 60;

function agentsBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'status' in error && error.status === 409
    && 'code' in error && error.code === 'agents_busy';
}

// The backend uses a lease: 409 agents_busy is an expected handoff while live
// analysis finishes. Never retry arbitrary conflicts, missing services or AI failures.
export function createSessionFinalizer<T>(request: (sessionId: string) => Promise<T>) {
  const pending = new Map<string, Promise<T>>();

  return (sessionId: string): Promise<T> => {
    const current = pending.get(sessionId);
    if (current) return current;
    const run = async () => {
      const deadline = Date.now() + MAX_BUSY_WAIT_MS;
      for (let retries = 0; ; retries++) {
        try { return await request(sessionId); }
        catch (error) {
          const remaining = deadline - Date.now();
          if (!agentsBusy(error) || remaining <= 0 || retries >= MAX_BUSY_RETRIES) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(RETRY_DELAY_MS, remaining)));
          if (Date.now() >= deadline) throw error;
        }
      }
    };
    // A manual Try again while this is pending shares the same work rather than
    // issuing concurrent requests. Both success and failure release the entry.
    const result = run().finally(() => { pending.delete(sessionId); });
    pending.set(sessionId, result);
    return result;
  };
}
