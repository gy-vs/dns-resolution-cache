import type { RecordType, ResolveOutcome, Resolver } from '../src/index.js';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
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

export interface ResolverCall {
  readonly hostname: string;
  readonly type: string;
  readonly signal: AbortSignal;
  readonly deferred: Deferred<ResolveOutcome>;
}

/** Resolver whose every call is driven manually by the test. */
export class MockResolver implements Resolver {
  readonly calls: ResolverCall[] = [];

  resolve(hostname: string, type: RecordType, signal: AbortSignal): Promise<ResolveOutcome> {
    const call: ResolverCall = { hostname, type, signal, deferred: deferred<ResolveOutcome>() };
    this.calls.push(call);
    return call.deferred.promise;
  }

  get callCount(): number {
    return this.calls.length;
  }

  lastCall(): ResolverCall {
    const call = this.calls[this.calls.length - 1];
    if (call === undefined) {
      throw new Error('MockResolver: no calls recorded');
    }
    return call;
  }
}

/** Flush microtasks (promise continuations scheduled by the cache). */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function answer(ttlMs: number, records: readonly unknown[] = ['192.0.2.1']): ResolveOutcome {
  return { kind: 'answer', records, ttlMs };
}

export function nxdomain(ttlMs: number): ResolveOutcome {
  return { kind: 'nxdomain', ttlMs };
}
