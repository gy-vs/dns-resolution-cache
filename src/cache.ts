import {
  CacheClosedError,
  QueryCancelledError,
  systemClock,
} from './types.js';
import type {
  Clock,
  DnsCacheOptions,
  RecordType,
  ResolveOptions,
  ResolveResult,
  Resolver,
} from './types.js';
import { cacheKey, normalizeName, normalizeType } from './normalize.js';
import { CacheEntry, decide } from './entry.js';
import type { CachedValue, EntryPhase } from './entry.js';
import { Flight } from './flight.js';
import type { FlightOutcome } from './flight.js';
import { backoffDelayMs, defaultBackoff } from './backoff.js';
import type { BackoffPolicy } from './backoff.js';

const DEFAULT_CAPACITY = 1024;
const DEFAULT_STALE_WINDOW_MS = 30_000;
const DEFAULT_MIN_TTL_MS = 0;
const DEFAULT_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** Diagnostic snapshot of one entry, as returned by {@link DnsCache.snapshot}. */
export interface EntrySnapshot {
  readonly key: string;
  readonly name: string;
  readonly type: string;
  readonly phase: EntryPhase;
  /** True while an underlying request (initial or refresh) is in flight. */
  readonly inFlight: boolean;
  /** True while a background refresh is in flight. */
  readonly refreshing: boolean;
  /** Number of callers currently waiting on the in-flight request. */
  readonly waiters: number;
  readonly consecutiveFailures: number;
  readonly refreshNotBeforeMs: number;
  readonly freshUntilMs: number | null;
  readonly staleUntilMs: number | null;
}

function checkUint(field: string, value: number, min: number): number {
  if (!Number.isFinite(value) || Math.floor(value) !== value || value < min) {
    throw new RangeError(`${field} must be an integer >= ${min}, got ${value}`);
  }
  return value;
}

function checkMultiplier(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(`backoff.multiplier must be >= 1, got ${value}`);
  }
  return value;
}

function ttlToMs(ttlSeconds: number, minMs: number, maxMs: number): number {
  const ms = Number.isFinite(ttlSeconds) ? ttlSeconds * 1000 : maxMs;
  return Math.min(maxMs, Math.max(minMs, ms));
}

function toResult(
  entry: CacheEntry,
  value: CachedValue,
  fromCache: boolean,
  stale: boolean,
): ResolveResult {
  return {
    name: entry.name,
    type: entry.type,
    status: value.status,
    answers: value.answers,
    cachedAtMs: value.storedAtMs,
    freshUntilMs: value.freshUntilMs,
    fromCache,
    stale,
  };
}

/**
 * Bounded, singleflight, stale-while-revalidate DNS resolution cache.
 *
 * Semantics in brief:
 * - concurrent queries for the same normalized (name, type) share one
 *   underlying request; each caller may cancel independently and the
 *   underlying request is cancelled only when its last waiter cancels;
 * - positive and NXDOMAIN responses are cached by their own TTLs; transient
 *   network errors are never negatively cached;
 * - expired values are served stale inside `staleWindowMs` while a
 *   singleflight background refresh runs; a failed refresh only extends the
 *   error backoff and never rewrites the stored value's expiry;
 * - eviction is capacity-driven and never removes entries with waiters or
 *   an in-flight refresh;
 * - `close()` rejects new queries, aborts every underlying request and
 *   rejects all waiters with one shared {@link CacheClosedError} instance.
 */
export class DnsCache {
  private readonly resolver: Resolver;
  private readonly clock: Clock;
  private readonly capacity: number;
  private readonly staleWindowMs: number;
  private readonly minTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly backoffPolicy: BackoffPolicy;
  private readonly entries = new Map<string, CacheEntry>();
  private closedError: CacheClosedError | null = null;
  private closedPromise: Promise<void> | null = null;

  constructor(options: DnsCacheOptions) {
    if (options === null || typeof options !== 'object' || typeof options.resolver?.resolve !== 'function') {
      throw new TypeError('DnsCacheOptions.resolver with a resolve() method is required');
    }
    this.resolver = options.resolver;
    this.clock = options.clock ?? systemClock;
    this.capacity = checkUint('capacity', options.capacity ?? DEFAULT_CAPACITY, 1);
    this.staleWindowMs = checkUint('staleWindowMs', options.staleWindowMs ?? DEFAULT_STALE_WINDOW_MS, 0);
    this.minTtlMs = checkUint('minTtlMs', options.minTtlMs ?? DEFAULT_MIN_TTL_MS, 0);
    this.maxTtlMs = checkUint('maxTtlMs', options.maxTtlMs ?? DEFAULT_MAX_TTL_MS, 1);
    if (this.minTtlMs > this.maxTtlMs) {
      throw new RangeError('minTtlMs must be <= maxTtlMs');
    }
    const backoff = options.backoff ?? {};
    this.backoffPolicy = {
      initialMs: checkUint('backoff.initialMs', backoff.initialMs ?? defaultBackoff.initialMs, 1),
      maxMs: checkUint('backoff.maxMs', backoff.maxMs ?? defaultBackoff.maxMs, 1),
      multiplier: checkMultiplier(backoff.multiplier ?? defaultBackoff.multiplier),
    };
  }

  /** Number of entries currently held (including pinned ones). */
  get size(): number {
    return this.entries.size;
  }

  get isClosed(): boolean {
    return this.closedError !== null;
  }

  /**
   * Resolve `name`/`type`, coalescing with concurrent identical queries.
   *
   * The returned promise rejects with:
   * - the shared {@link CacheClosedError} after `close()`;
   * - the caller's abort reason when its own signal cancels the wait;
   * - the resolver's error on transient upstream failures (never cached).
   */
  async resolve(name: string, type: RecordType, options: ResolveOptions = {}): Promise<ResolveResult> {
    if (this.closedError !== null) {
      throw this.closedError;
    }
    const signal = options.signal;
    if (signal?.aborted) {
      throw signal.reason ?? new QueryCancelledError('query cancelled');
    }
    const normalizedName = normalizeName(name);
    const normalizedType = normalizeType(type);
    const key = cacheKey(normalizedName, normalizedType);
    const now = this.clock.now();

    let entry = this.entries.get(key);
    if (entry !== undefined) {
      entry.lastAccessMs = now;
      const decision = decide(entry, now);
      switch (decision.kind) {
        case 'hit':
          return toResult(entry, decision.value, true, false);
        case 'stale':
          if (decision.startRefresh) {
            this.startFlight(entry, true);
          }
          return toResult(entry, decision.value, true, true);
        case 'join':
          return this.awaitFlight(entry, decision.flight, signal);
        case 'miss':
          break;
      }
    } else {
      entry = new CacheEntry(key, normalizedName, normalizedType, now);
      this.entries.set(key, entry);
    }

    const flight = this.startFlight(entry, false);
    this.evictIfNeeded(now);
    return this.awaitFlight(entry, flight, signal);
  }

  /**
   * Close the cache: reject every future query, abort every in-flight
   * underlying request and reject all current waiters with one shared
   * {@link CacheClosedError} instance. Idempotent.
   *
   * The returned promise resolves once all in-flight requests have settled.
   */
  close(): Promise<void> {
    if (this.closedPromise !== null) {
      return this.closedPromise;
    }
    const error = new CacheClosedError('DnsCache is closed');
    this.closedError = error;
    const flights: Flight[] = [];
    for (const entry of this.entries.values()) {
      if (entry.flight !== null) {
        flights.push(entry.flight);
        entry.flight = null;
      }
    }
    this.entries.clear();
    for (const flight of flights) {
      flight.terminate(error);
    }
    this.closedPromise = Promise.all(flights.map((flight) => flight.settled())).then(() => undefined);
    return this.closedPromise;
  }

  /** Diagnostic snapshot of every entry, in insertion order. */
  snapshot(): EntrySnapshot[] {
    const now = this.clock.now();
    const snapshots: EntrySnapshot[] = [];
    for (const entry of this.entries.values()) {
      snapshots.push({
        key: entry.key,
        name: entry.name,
        type: entry.type,
        phase: entry.phaseAt(now),
        inFlight: entry.flight !== null,
        refreshing: entry.flight !== null && entry.flight.isRefresh,
        waiters: entry.flight?.waiterCount ?? 0,
        consecutiveFailures: entry.consecutiveFailures,
        refreshNotBeforeMs: entry.refreshNotBeforeMs,
        freshUntilMs: entry.value?.freshUntilMs ?? null,
        staleUntilMs: entry.value?.staleUntilMs ?? null,
      });
    }
    return snapshots;
  }

  private startFlight(entry: CacheEntry, isRefresh: boolean): Flight {
    const flight = new Flight({
      isRefresh,
      nowMs: this.clock.now(),
      run: (signal) => this.resolver.resolve(entry.name, entry.type, signal),
      onSettled: (settledFlight, outcome) => this.handleSettled(entry, settledFlight, outcome),
    });
    entry.flight = flight;
    return flight;
  }

  private handleSettled(entry: CacheEntry, flight: Flight, outcome: FlightOutcome): void {
    if (entry.flight === flight) {
      entry.flight = null;
    }
    if (this.closedError !== null) {
      return; // close() already tore everything down
    }
    if (outcome.ok) {
      const now = this.clock.now();
      const ttlMs = ttlToMs(outcome.response.ttlSeconds, this.minTtlMs, this.maxTtlMs);
      entry.value = {
        status: outcome.response.status,
        answers: outcome.response.answers,
        storedAtMs: now,
        freshUntilMs: now + ttlMs,
        staleUntilMs: now + ttlMs + this.staleWindowMs,
      };
      entry.consecutiveFailures = 0;
      entry.refreshNotBeforeMs = 0;
      this.evictIfNeeded(now);
      return;
    }
    if (!flight.wasAbortedByCache) {
      // Genuine upstream failure: only extend the error backoff. The stored
      // value's expiry (freshUntilMs / staleUntilMs) is left untouched, and
      // the error itself is never written into the cache.
      entry.consecutiveFailures += 1;
      entry.refreshNotBeforeMs =
        this.clock.now() + backoffDelayMs(this.backoffPolicy, entry.consecutiveFailures);
    }
    if (entry.value === null && entry.flight === null && this.entries.get(entry.key) === entry) {
      // Cold miss with nothing cached: the entry carries no information, so
      // drop it. The next query starts a brand-new flight (transient errors
      // are not negatively cached).
      this.entries.delete(entry.key);
    }
  }

  private async awaitFlight(
    entry: CacheEntry,
    flight: Flight,
    signal: AbortSignal | undefined,
  ): Promise<ResolveResult> {
    const response = await flight.wait(signal);
    const value = entry.value;
    const now = this.clock.now();
    return {
      name: entry.name,
      type: entry.type,
      status: response.status,
      answers: response.answers,
      cachedAtMs: value?.storedAtMs ?? now,
      freshUntilMs: value?.freshUntilMs ?? now,
      fromCache: false,
      stale: false,
    };
  }

  /**
   * Trim the cache to capacity. Entries with an in-flight request (waiters
   * or a detached background refresh) are never evicted; if everything is
   * pinned the cache simply stays over capacity until flights settle.
   * Expired entries go first, then stale, then least-recently-used fresh.
   */
  private evictIfNeeded(now: number): void {
    if (this.entries.size <= this.capacity) {
      return;
    }
    const phaseRank = (entry: CacheEntry): number => {
      const phase = entry.phaseAt(now);
      if (phase === 'expired' || phase === 'empty') return 0;
      if (phase === 'stale') return 1;
      return 2;
    };
    const candidates = [...this.entries.values()]
      .filter((entry) => !entry.pinned)
      .sort((a, b) => {
        const rankDiff = phaseRank(a) - phaseRank(b);
        return rankDiff !== 0 ? rankDiff : a.lastAccessMs - b.lastAccessMs;
      });
    for (const entry of candidates) {
      if (this.entries.size <= this.capacity) {
        break;
      }
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key);
      }
    }
  }
}
