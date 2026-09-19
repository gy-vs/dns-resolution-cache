/**
 * Public types for the async DNS resolution cache.
 *
 * The library never touches the network or the system clock directly:
 * both are injected by the embedder, which keeps tests free of real
 * DNS and real time.
 */

/**
 * Wall-clock source. Implementations return milliseconds since the Unix
 * epoch (the same domain as `Date.now()`).
 */
export interface Clock {
  now(): number;
}

/** Default clock backed by `Date.now()`. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * DNS record type, e.g. `"A"`, `"AAAA"`, `"MX"`, `"SRV"`.
 * Compared case-insensitively; normalized to upper case internally.
 */
export type RecordType = string;

/** A single parsed DNS answer record produced by the injected resolver. */
export interface DnsRecord {
  readonly type: string;
  readonly name: string;
  readonly data: string;
  readonly ttlSeconds: number;
}

/**
 * Outcome classification of a resolution:
 * - `"ok"`: NOERROR, including NODATA (empty `answers`).
 * - `"nxdomain"`: name does not exist; cached with its own (negative) TTL.
 */
export type ResolveStatus = 'ok' | 'nxdomain';

/** Raw response returned by the injected {@link Resolver}. */
export interface ResolverResponse {
  readonly status: ResolveStatus;
  readonly answers: readonly DnsRecord[];
  /**
   * Cache lifetime in seconds: the minimum answer TTL for positive answers,
   * or the SOA-derived negative TTL for NXDOMAIN / NODATA responses.
   * The cache clamps this value into `[minTtlMs, maxTtlMs]`.
   */
  readonly ttlSeconds: number;
}

/**
 * Pluggable asynchronous resolver. This is the only network-touching seam.
 *
 * Contract:
 * - MUST reject transient network errors with an `Error`; such failures are
 *   never stored in the negative cache.
 * - SHOULD honor `signal` and reject promptly when it aborts.
 * - MUST eventually settle (resolve or reject) every call.
 */
export interface Resolver {
  resolve(name: string, type: RecordType, signal: AbortSignal): Promise<ResolverResponse>;
}

/** Exponential backoff tuning for failed background refreshes. */
export interface BackoffOptions {
  /** Delay after the first consecutive failure. Default 250 ms. */
  readonly initialMs?: number;
  /** Upper bound for any single delay. Default 30_000 ms. */
  readonly maxMs?: number;
  /** Growth factor per consecutive failure. Default 2. */
  readonly multiplier?: number;
}

export interface DnsCacheOptions {
  /** Injected async resolver (required). */
  readonly resolver: Resolver;
  /** Injected clock. Defaults to {@link systemClock}. */
  readonly clock?: Clock;
  /**
   * Maximum number of cached entries. Entries with an in-flight underlying
   * request (initial or refresh) are never evicted, so the cache may
   * temporarily exceed the capacity while entries are pinned. Default 1024.
   */
  readonly capacity?: number;
  /**
   * How long (ms) an expired value may still be served as stale while a
   * background refresh runs. Default 30_000 ms.
   */
  readonly staleWindowMs?: number;
  /** Lower clamp for upstream TTLs. Default 0 ms. */
  readonly minTtlMs?: number;
  /** Upper clamp for upstream TTLs. Default 86_400_000 ms (24 h). */
  readonly maxTtlMs?: number;
  /** Backoff tuning for failed background refreshes. */
  readonly backoff?: BackoffOptions;
}

export interface ResolveOptions {
  /**
   * Per-caller cancellation. Aborting only detaches this caller; the
   * underlying request is cancelled only once every waiter has cancelled.
   */
  readonly signal?: AbortSignal;
}

/** Immutable result handed to callers. */
export interface ResolveResult {
  /** Normalized (lower-cased, no trailing dot) host name. */
  readonly name: string;
  /** Normalized (upper-cased) record type. */
  readonly type: string;
  readonly status: ResolveStatus;
  readonly answers: readonly DnsRecord[];
  /** When the value was stored, in clock milliseconds. */
  readonly cachedAtMs: number;
  /** When the value stops being fresh, in clock milliseconds. */
  readonly freshUntilMs: number;
  /** True when served from the cache (including stale hits). */
  readonly fromCache: boolean;
  /** True when the value was past its TTL but inside the stale window. */
  readonly stale: boolean;
}

/** Base class for every error raised by this library. */
export class DnsCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Rejects in-flight waiters and every query issued after `close()`.
 * A single instance is shared per cache so callers can compare by identity.
 */
export class CacheClosedError extends DnsCacheError {}

/**
 * Fallback rejection for caller-side cancellation when the abort signal
 * carries no reason of its own.
 */
export class QueryCancelledError extends DnsCacheError {}
