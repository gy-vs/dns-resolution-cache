import type { ResolveOutcome } from './types.js';

/** What the underlying request currently in flight is for. */
export type InflightKind = 'none' | 'query' | 'refresh';

/**
 * Decision returned by {@link CacheEntry.decideLookup}:
 * - `hit`: serve the fresh value.
 * - `stale`: serve the stale value now; the caller should start a background
 *   refresh iff `shouldRefresh` (single-flight: false while one is running
 *   or while error backoff is still cooling down).
 * - `wait`: nothing servable; attach a waiter and, iff `startQuery`, start
 *   an underlying request. If a request is already in flight (initial query
 *   or a refresh that outlived the stale window) the waiter simply joins it.
 */
export type LookupDecision<T = unknown> =
  | { readonly kind: 'hit'; readonly value: ResolveOutcome<T> }
  | { readonly kind: 'stale'; readonly value: ResolveOutcome<T>; readonly shouldRefresh: boolean }
  | { readonly kind: 'wait'; readonly startQuery: boolean };

/**
 * Effect of a failed underlying request:
 * - `drop`: nothing was ever cached — the entry must be removed so transient
 *   errors never become negative-cache entries.
 * - `backoff`: a previous value survives untouched (its expiry is NOT
 *   rewritten); only the refresh-retry timer moved to `nextRefreshAt`.
 */
export type FailureEffect =
  | { readonly kind: 'drop' }
  | { readonly kind: 'backoff'; readonly nextRefreshAt: number };

export interface EntryTimings {
  readonly freshUntil: number;
  readonly staleUntil: number;
  readonly nextRefreshAt: number;
}

/**
 * Pure per-key state machine. It performs no I/O and owns no timers: the
 * caller supplies `now` (already clamped monotonic) and executes the
 * returned decisions. This is what makes cancellation/expiry races
 * deterministically testable.
 *
 * Lifecycle: (no value) --query--> cached --TTL--> stale --refresh--> cached
 * A failed query drops the entry; a failed refresh only backs off.
 */
export class CacheEntry<T = unknown> {
  private value: ResolveOutcome<T> | undefined;
  private freshUntil = Number.NEGATIVE_INFINITY;
  private staleUntil = Number.NEGATIVE_INFINITY;
  private nextRefreshAt = Number.NEGATIVE_INFINITY;
  private waiterCount = 0;
  private inflightKind: InflightKind = 'none';
  private refreshFailures = 0;

  get hasValue(): boolean {
    return this.value !== undefined;
  }

  /** Entries with waiters or an in-flight request must never be evicted. */
  get pinned(): boolean {
    return this.waiterCount > 0 || this.inflightKind !== 'none';
  }

  get inflight(): InflightKind {
    return this.inflightKind;
  }

  get waiters(): number {
    return this.waiterCount;
  }

  get consecutiveRefreshFailures(): number {
    return this.refreshFailures;
  }

  get timings(): EntryTimings {
    return {
      freshUntil: this.freshUntil,
      staleUntil: this.staleUntil,
      nextRefreshAt: this.nextRefreshAt,
    };
  }

  decideLookup(now: number): LookupDecision<T> {
    if (this.value !== undefined) {
      if (now < this.freshUntil) {
        return { kind: 'hit', value: this.value };
      }
      if (now < this.staleUntil) {
        return {
          kind: 'stale',
          value: this.value,
          shouldRefresh: this.inflightKind === 'none' && now >= this.nextRefreshAt,
        };
      }
      // Fully expired. If a background refresh is still running, callers
      // join it instead of firing a second request.
    }
    return { kind: 'wait', startQuery: this.inflightKind === 'none' };
  }

  onWaiterAdded(): void {
    this.waiterCount += 1;
  }

  /**
   * A waiter cancelled. Returns true iff the underlying request should be
   * aborted: that is exactly when the last waiter of a caller-driven `query`
   * left. Background refreshes keep running with zero waiters.
   */
  onWaiterRemoved(): boolean {
    if (this.waiterCount > 0) {
      this.waiterCount -= 1;
    }
    return this.waiterCount === 0 && this.inflightKind === 'query';
  }

  onRequestStarted(kind: 'query' | 'refresh'): void {
    this.inflightKind = kind;
  }

  /** Success always settles every waiter and (re)arms the TTL window. */
  onSuccess(outcome: ResolveOutcome<T>, now: number, ttlMs: number, staleWindowMs: number): void {
    this.value = outcome;
    this.freshUntil = now + ttlMs;
    this.staleUntil = this.freshUntil + staleWindowMs;
    this.nextRefreshAt = Number.NEGATIVE_INFINITY;
    this.refreshFailures = 0;
    this.inflightKind = 'none';
    this.waiterCount = 0;
  }

  /**
   * Failure settles every waiter with the error. A cached value — including
   * its original `freshUntil`/`staleUntil` — is preserved; only the error
   * backoff advances.
   */
  onFailure(now: number, backoffMs: number): FailureEffect {
    this.inflightKind = 'none';
    this.waiterCount = 0;
    if (this.value === undefined) {
      return { kind: 'drop' };
    }
    this.refreshFailures += 1;
    this.nextRefreshAt = now + backoffMs;
    return { kind: 'backoff', nextRefreshAt: this.nextRefreshAt };
  }
}
