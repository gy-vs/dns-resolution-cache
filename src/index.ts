/**
 * Public package entry point.
 *
 * The state machine is split into small modules — {@link CacheEntry} /
 * {@link decide} (entry lifecycle), {@link Flight} (singleflight with
 * per-caller cancellation), {@link backoffDelayMs} (refresh backoff),
 * {@link normalizeName} / {@link normalizeType} (cache identity) — all
 * re-exported here so they can be unit-tested and reused directly.
 */

export { DnsCache } from './cache.js';
export type { EntrySnapshot } from './cache.js';

export {
  systemClock,
  DnsCacheError,
  CacheClosedError,
  QueryCancelledError,
} from './types.js';
export type {
  Clock,
  RecordType,
  DnsRecord,
  ResolveStatus,
  ResolverResponse,
  Resolver,
  BackoffOptions,
  DnsCacheOptions,
  ResolveOptions,
  ResolveResult,
} from './types.js';

export { normalizeName, normalizeType, cacheKey } from './normalize.js';

export { backoffDelayMs, defaultBackoff } from './backoff.js';
export type { BackoffPolicy } from './backoff.js';

export { CacheEntry, decide } from './entry.js';
export type { CachedValue, EntryPhase, Decision } from './entry.js';

export { Flight } from './flight.js';
export type { FlightOutcome, FlightOptions } from './flight.js';
