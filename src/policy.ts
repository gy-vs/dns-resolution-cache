/**
 * Pure tuning knobs and helpers. No I/O, no state — everything here is
 * trivially unit-testable.
 */

export const DEFAULT_CAPACITY = 1024;
export const DEFAULT_STALE_WINDOW_MS = 30_000;
export const DEFAULT_MIN_TTL_MS = 0;
export const DEFAULT_MAX_TTL_MS = 86_400_000; // 24h
export const DEFAULT_BACKOFF_CAP_MS = 300_000; // 5min

/**
 * Default delay before a failed background refresh may be retried:
 * 1s, 2s, 4s, ... capped at 5 minutes. `consecutiveFailures` starts at 1.
 */
export function defaultRefreshBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(30, Math.floor(consecutiveFailures) - 1));
  return Math.min(DEFAULT_BACKOFF_CAP_MS, 1000 * 2 ** exponent);
}

/**
 * Clamp a resolver-provided TTL into [minTtlMs, maxTtlMs].
 * NaN collapses to the minimum, +/-Infinity saturate.
 */
export function clampTtlMs(ttlMs: number, minTtlMs: number, maxTtlMs: number): number {
  if (Number.isNaN(ttlMs)) {
    return minTtlMs;
  }
  return Math.min(maxTtlMs, Math.max(minTtlMs, ttlMs));
}
