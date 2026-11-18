export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  jitterRatio?: number;
  random?: () => number;
};

export function backoffMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 30_000;
  const max = options.maxMs ?? 60 * 60 * 1000;
  const jitter = options.jitterRatio ?? 0.25;
  const random = options.random ?? Math.random;
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const spread = exponential * jitter * (random() * 2 - 1);
  return Math.max(base / 2, Math.round(exponential + spread));
}

export const shouldDeadLetter = (attempts: number, maxAttempts = 8) => attempts >= maxAttempts;
