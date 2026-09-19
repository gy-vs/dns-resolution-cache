/**
 * Pure exponential-backoff calculation for failed background refreshes.
 * Deterministic (no jitter) so tests need no random source.
 */

export interface BackoffPolicy {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly multiplier: number;
}

export const defaultBackoff: BackoffPolicy = {
  initialMs: 250,
  maxMs: 30_000,
  multiplier: 2,
};

/**
 * Delay before the next refresh attempt after `consecutiveFailures`
 * consecutive failures (1-based; values below 1 are clamped to 1).
 */
export function backoffDelayMs(policy: BackoffPolicy, consecutiveFailures: number): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  const delay = policy.initialMs * Math.pow(policy.multiplier, n - 1);
  return Math.min(policy.maxMs, Math.round(delay));
}
