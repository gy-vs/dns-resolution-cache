/** Error thrown (synchronously) when a hostname cannot be normalized. */
export class InvalidHostnameError extends Error {
  override readonly name = 'InvalidHostnameError';
  constructor(hostname: string) {
    super(`Invalid hostname: ${JSON.stringify(hostname)}`);
  }
}

/**
 * Rejection delivered to a single waiter whose own `AbortSignal` fired.
 * Other waiters of the same query are unaffected.
 */
export class LookupCancelledError extends Error {
  override readonly name = 'LookupCancelledError';
  constructor(message = 'DNS lookup was cancelled') {
    super(message);
  }
}

/**
 * Rejection delivered to every pending waiter when the cache is closed, and
 * to every lookup attempted afterwards. All of them receive the *same*
 * error instance.
 */
export class DnsCacheClosedError extends Error {
  override readonly name = 'DnsCacheClosedError';
  constructor(message = 'DNS cache is closed') {
    super(message);
  }
}
