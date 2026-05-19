export interface RetryPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  maxAttempts: number;
}

export const defaultRetryPolicy = (): RetryPolicy => ({
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  multiplier: 2.0,
  maxAttempts: 0,
});

export function delayForAttempt(policy: RetryPolicy, attempt: number): number {
  const exp = Math.max(0, attempt - 1);
  const base = policy.initialDelayMs * Math.pow(policy.multiplier, exp);
  const clamped = Math.min(base, policy.maxDelayMs);
  const jitter = Math.random() * clamped * 0.25;
  return Math.floor(clamped + jitter);
}

export function hasAttemptsLeft(policy: RetryPolicy, attempt: number): boolean {
  return policy.maxAttempts === 0 || attempt < policy.maxAttempts;
}
