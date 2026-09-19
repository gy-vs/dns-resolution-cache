import { QueryCancelledError } from './types.js';
import type { ResolverResponse } from './types.js';

/** Terminal outcome of a flight, shared by every waiter. */
export type FlightOutcome =
  | { readonly ok: true; readonly response: ResolverResponse }
  | { readonly ok: false; readonly error: unknown };

interface Waiter {
  readonly resolve: (response: ResolverResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

export interface FlightOptions {
  /**
   * Refresh flights are retained: they belong to the cache, not to any
   * caller, so they keep running even with zero external waiters.
   */
  readonly isRefresh: boolean;
  readonly nowMs: number;
  readonly run: (signal: AbortSignal) => Promise<ResolverResponse>;
  /**
   * Called exactly once, synchronously, the moment the underlying request
   * settles — before any waiter is notified — so the cache can update its
   * bookkeeping first and callers always observe a consistent state.
   */
  readonly onSettled: (flight: Flight, outcome: FlightOutcome) => void;
}

function cancelReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return reason === undefined || reason === null
    ? new QueryCancelledError('query cancelled')
    : reason;
}

/**
 * One underlying resolution shared by any number of callers.
 *
 * - Each caller gets an independent promise via {@link wait} and may cancel
 *   it through its own AbortSignal without affecting the other waiters.
 * - The underlying request is aborted only when the last waiter of a
 *   non-retained (non-refresh) flight cancels.
 * - Settlement is idempotent: whichever of completion / failure /
 *   {@link terminate} happens first wins, latecomers are ignored. This makes
 *   the cancel-vs-complete race deterministic.
 */
export class Flight {
  readonly isRefresh: boolean;
  readonly startedAtMs: number;

  private readonly controller = new AbortController();
  private readonly waiters = new Set<Waiter>();
  private readonly onSettled: (flight: Flight, outcome: FlightOutcome) => void;
  private readonly settledPromise: Promise<void>;
  private outcome: FlightOutcome | null = null;
  private abortedByCache = false;

  constructor(options: FlightOptions) {
    this.isRefresh = options.isRefresh;
    this.startedAtMs = options.nowMs;
    this.onSettled = options.onSettled;
    const signal = this.controller.signal;
    const raw = Promise.resolve().then(() => options.run(signal));
    this.settledPromise = raw.then(
      (response) => {
        this.settle({ ok: true, response });
      },
      (error: unknown) => {
        this.settle({ ok: false, error });
      },
    );
    // settledPromise fulfills with void on any outcome; guard against
    // bookkeeping bugs ever surfacing as an unhandled rejection.
    this.settledPromise.then(undefined, () => undefined);
  }

  /** Abort signal handed to the underlying resolver call. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get waiterCount(): number {
    return this.waiters.size;
  }

  get isSettled(): boolean {
    return this.outcome !== null;
  }

  /**
   * True when the cache itself aborted the underlying request (every waiter
   * cancelled, or `close()` ran) — as opposed to a genuine upstream failure.
   */
  get wasAbortedByCache(): boolean {
    return this.abortedByCache;
  }

  /** Resolves once the underlying request has fully settled. Never rejects. */
  settled(): Promise<void> {
    return this.settledPromise;
  }

  /**
   * Attach a caller. The returned promise settles with the shared outcome,
   * or rejects early if the caller's own signal aborts first.
   */
  wait(callerSignal?: AbortSignal): Promise<ResolverResponse> {
    const outcome = this.outcome;
    if (outcome !== null) {
      return outcome.ok
        ? Promise.resolve(outcome.response)
        : Promise.reject(outcome.error);
    }
    if (callerSignal?.aborted) {
      return Promise.reject(cancelReason(callerSignal));
    }
    return new Promise<ResolverResponse>((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => {
          if (onAbort !== null && callerSignal !== undefined) {
            callerSignal.removeEventListener('abort', onAbort);
          }
        },
      };
      if (callerSignal !== undefined) {
        onAbort = () => {
          this.waiters.delete(waiter);
          waiter.cleanup();
          reject(cancelReason(callerSignal));
          this.maybeAbortUnderlying();
        };
        callerSignal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  /**
   * Reject every current waiter with the *same* error instance and abort the
   * underlying request. Used by `DnsCache.close()`. Idempotent.
   */
  terminate(error: unknown): void {
    if (this.outcome !== null) {
      return;
    }
    this.abortedByCache = true;
    this.controller.abort(error);
    this.settle({ ok: false, error });
  }

  private maybeAbortUnderlying(): void {
    if (this.isRefresh || this.outcome !== null) {
      return;
    }
    if (this.waiters.size === 0) {
      this.abortedByCache = true;
      this.controller.abort(new QueryCancelledError('all waiters cancelled'));
    }
  }

  private settle(outcome: FlightOutcome): void {
    if (this.outcome !== null) {
      return; // terminate() or an earlier settle already won the race
    }
    this.outcome = outcome;
    try {
      this.onSettled(this, outcome);
    } finally {
      const waiters = [...this.waiters];
      this.waiters.clear();
      for (const waiter of waiters) {
        waiter.cleanup();
        if (outcome.ok) {
          waiter.resolve(outcome.response);
        } else {
          waiter.reject(outcome.error);
        }
      }
    }
  }
}
