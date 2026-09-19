/**
 * Public types for the DNS cache.
 *
 * The cache is payload-agnostic: the injected {@link Resolver} decides what a
 * "record" is (string, structured object, ...). Use `DnsCache<T>` to thread
 * the record type through lookups.
 */

/** DNS record type. Well-known values are "A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "PTR", "SRV", "CAA"; any string is accepted. */
export type RecordType = string;

/** Positive answer. `ttlMs` is the remaining TTL at resolution time, in milliseconds. */
export interface AnswerOutcome<T = unknown> {
  readonly kind: 'answer';
  readonly records: readonly T[];
  readonly ttlMs: number;
}

/**
 * Authoritative name-error (NXDOMAIN). This is a *cacheable outcome*, not an
 * exception: it is stored in the negative cache for `ttlMs` (typically the
 * SOA negative-cache TTL).
 */
export interface NxdomainOutcome {
  readonly kind: 'nxdomain';
  readonly ttlMs: number;
}

export type ResolveOutcome<T = unknown> = AnswerOutcome<T> | NxdomainOutcome;

/**
 * Underlying asynchronous DNS resolver, injected by the embedder.
 *
 * Contract:
 * - `hostname` is already normalized (lowercase, no trailing dot).
 * - Must settle the returned promise; `signal` is aborted when every waiter
 *   cancelled or the cache was closed. Implementations should honor it
 *   promptly, but late settlements are handled safely (a late success is
 *   still cached, a late failure is dropped).
 * - Resolve with `{ kind: 'nxdomain' }` for NXDOMAIN so it can be
 *   negative-cached. Reject for transient failures (timeouts, network
 *   errors, SERVFAIL, ...); rejections are never cached.
 */
export interface Resolver<T = unknown> {
  resolve(hostname: string, type: RecordType, signal: AbortSignal): Promise<ResolveOutcome<T>>;
}
