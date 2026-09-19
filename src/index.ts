export { DnsCache } from './cache.js';
export type { DnsCacheOptions, EntryInspection, LookupOptions } from './cache.js';

export { CacheEntry } from './entry.js';
export type { EntryTimings, FailureEffect, InflightKind, LookupDecision } from './entry.js';

export { ManualClock, systemClock } from './clock.js';
export type { Clock } from './clock.js';

export { normalizeHostname, normalizeRecordType } from './normalize.js';

export {
  DEFAULT_BACKOFF_CAP_MS,
  DEFAULT_CAPACITY,
  DEFAULT_MAX_TTL_MS,
  DEFAULT_MIN_TTL_MS,
  DEFAULT_STALE_WINDOW_MS,
  clampTtlMs,
  defaultRefreshBackoffMs,
} from './policy.js';

export { DnsCacheClosedError, InvalidHostnameError, LookupCancelledError } from './errors.js';

export type {
  AnswerOutcome,
  NxdomainOutcome,
  RecordType,
  ResolveOutcome,
  Resolver,
} from './types.js';
