/**
 * Replaceable time source. Tests inject {@link ManualClock} so no test ever
 * depends on the real clock.
 */
export interface Clock {
  /** Current time in milliseconds (any epoch; only differences matter). */
  now(): number;
}

/** Default clock backed by `Date.now()`. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * Deterministic clock for tests. `set()` may move time backwards on purpose;
 * the cache clamps its view of time monotonically, so a backwards clock never
 * resurrects expired entries nor extends TTLs.
 */
export class ManualClock implements Clock {
  private current: number;

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
