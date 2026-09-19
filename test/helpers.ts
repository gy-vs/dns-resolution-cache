import type { Clock, RecordType, Resolver, ResolverResponse } from '../src/index.js';

/** Deterministic clock for tests: time only moves when told to. */
export class ManualClock implements Clock {
  private t: number;

  constructor(startMs = 1_000_000) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  set(ms: number): void {
    this.t = ms;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface InFlightCall {
  readonly name: string;
  readonly type: string;
  readonly signal: AbortSignal;
  readonly deferred: Deferred<ResolverResponse>;
}

export type ResolverHandler = (
  name: string,
  type: string,
  signal: AbortSignal,
) => Promise<ResolverResponse>;

/**
 * Test resolver. In deferred mode (default) every call is parked until the
 * test resolves/rejects it via {@link takeInFlight}; aborting the call's
 * signal rejects it, mimicking a well-behaved real resolver.
 */
export class FakeResolver implements Resolver {
  readonly calls: Array<{ name: string; type: RecordType }> = [];
  private readonly pending: InFlightCall[] = [];
  private handler: ResolverHandler | null = null;

  setHandler(handler: ResolverHandler | null): void {
    this.handler = handler;
  }

  resolve(name: string, type: RecordType, signal: AbortSignal): Promise<ResolverResponse> {
    this.calls.push({ name, type });
    if (this.handler !== null) {
      return this.handler(name, type, signal);
    }
    const d = deferred<ResolverResponse>();
    signal.addEventListener('abort', () => d.reject(signal.reason), { once: true });
    this.pending.push({ name, type, signal, deferred: d });
    return d.promise;
  }

  get inFlightCount(): number {
    return this.pending.length;
  }

  takeInFlight(): InFlightCall {
    const call = this.pending.shift();
    if (call === undefined) {
      throw new Error('no in-flight resolver call');
    }
    return call;
  }
}

export function okResponse(data: string, ttlSeconds: number, name = 'example.com'): ResolverResponse {
  return {
    status: 'ok',
    answers: [{ type: 'A', name, data, ttlSeconds }],
    ttlSeconds,
  };
}

export function nxdomainResponse(negativeTtlSeconds: number): ResolverResponse {
  return { status: 'nxdomain', answers: [], ttlSeconds: negativeTtlSeconds };
}

/** Flush the microtask queue and one macrotask turn. */
export function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
