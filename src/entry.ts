import type { DnsRecord, ResolveStatus } from './types.js';
import type { Flight } from './flight.js';

/** A cached resolution with its freshness boundaries (clock milliseconds). */
export interface CachedValue {
  readonly status: ResolveStatus;
  readonly answers: readonly DnsRecord[];
  readonly storedAtMs: number;
  /** Serve from cache without refreshing while `now < freshUntilMs`. */
  readonly freshUntilMs: number;
  /** Serve stale while `now < staleUntilMs`; beyond that the value is dead. */
  readonly staleUntilMs: number;
}

/**
 * Lifecycle of an entry, derived from its value and the current time:
 *
 * ```
 *            store value
 *   empty ───────────────► fresh ──TTL──► stale ──staleWindow──► expired
 *     │                      ▲               │                      │
 *     │ start flight         │ refresh ok    │ refresh (singleflight)│
 *     ▼                      └───────────────┘                      ▼
 *   pending ──fail──► (entry dropped)                    miss → new flight
 * ```
 *
 * `expired` entries keep their (dead) value until evicted; a query against
 * them is a miss but still coalesces onto an in-flight refresh.
 */
export type EntryPhase = 'empty' | 'pending' | 'fresh' | 'stale' | 'expired';

/**
 * Mutable state for one (name, type) pair. All transitions go through
 * {@link decide} (read path) and `DnsCache.handleSettled` (write path), so
 * the state machine stays directly unit-testable.
 */
export class CacheEntry {
  value: CachedValue | null = null;
  /** In-flight underlying request (initial or background refresh), if any. */
  flight: Flight | null = null;
  /** Consecutive refresh failures, feeding the backoff schedule. */
  consecutiveFailures = 0;
  /** Background refreshes are suppressed until this instant (clock ms). */
  refreshNotBeforeMs = 0;
  /** Last time a query touched this entry (clock ms), for LRU eviction. */
  lastAccessMs: number;

  constructor(
    readonly key: string,
    readonly name: string,
    readonly type: string,
    nowMs: number,
  ) {
    this.lastAccessMs = nowMs;
  }

  /**
   * Pinned entries — those with an in-flight request, including detached
   * background refreshes — must never be evicted.
   */
  get pinned(): boolean {
    return this.flight !== null;
  }

  phaseAt(nowMs: number): EntryPhase {
    const value = this.value;
    if (value !== null) {
      if (nowMs < value.freshUntilMs) return 'fresh';
      if (nowMs < value.staleUntilMs) return 'stale';
      return 'expired';
    }
    return this.flight !== null ? 'pending' : 'empty';
  }
}

/** Read-path decision for one entry at one instant. */
export type Decision =
  | { readonly kind: 'hit'; readonly value: CachedValue }
  | { readonly kind: 'stale'; readonly value: CachedValue; readonly startRefresh: boolean }
  | { readonly kind: 'join'; readonly flight: Flight }
  | { readonly kind: 'miss' };

/**
 * Pure state-machine transition for a lookup. Ordering matters:
 *
 * 1. fresh value → serve it (a refresh may still be running from before a
 *    backwards clock jump; it will simply overwrite the value when done);
 * 2. stale value → serve it, and ask for a background refresh unless one is
 *    already running or the failure backoff is still cooling down;
 * 3. anything else with an in-flight request → coalesce onto it (this also
 *    covers "expired again while a refresh is still running");
 * 4. otherwise → miss, the caller starts a new flight.
 */
export function decide(entry: CacheEntry, nowMs: number): Decision {
  const value = entry.value;
  if (value !== null && nowMs < value.freshUntilMs) {
    return { kind: 'hit', value };
  }
  if (value !== null && nowMs < value.staleUntilMs) {
    return {
      kind: 'stale',
      value,
      startRefresh: entry.flight === null && nowMs >= entry.refreshNotBeforeMs,
    };
  }
  if (entry.flight !== null) {
    return { kind: 'join', flight: entry.flight };
  }
  return { kind: 'miss' };
}
