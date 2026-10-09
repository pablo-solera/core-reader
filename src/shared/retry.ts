export class RequestAbortedError extends Error {
  constructor() { super("Request aborted"); this.name = "RequestAbortedError"; }
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RequestAbortedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new RequestAbortedError()); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function exponentialRetryDelay(elapsedMs: number, attempt: number, windowMs: number, retryAfterMs = 0, jitterMs = 0, ceilingMs = 60_000): number | null {
  if (elapsedMs >= windowMs) return null;
  const fallback = Math.min(ceilingMs, 1_000 * 2 ** Math.min(attempt, 6)) + jitterMs;
  return Math.min(windowMs - elapsedMs, retryAfterMs > 0 ? retryAfterMs : fallback);
}
