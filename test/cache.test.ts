import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DnsCache,
  DnsCacheClosedError,
  InvalidHostnameError,
  LookupCancelledError,
  ManualClock,
  type DnsCacheOptions,
  type ResolveOutcome,
} from '../src/index.js';
import { MockResolver, answer, nxdomain, tick } from './helpers.js';

const T0 = 1_000_000;

function makeCache(overrides: Partial<DnsCacheOptions> = {}) {
  const resolver = new MockResolver();
  const clock = new ManualClock(T0);
  const cache = new DnsCache({ resolver, clock, staleWindowMs: 0, ...overrides });
  return { resolver, clock, cache };
}

describe('caching', () => {
  it('caches positive answers for their TTL', async () => {
    const { resolver, clock, cache } = makeCache();

    const p1 = cache.lookup('example.com', 'A');
    await tick();
    resolver.lastCall().deferred.resolve(answer(100_000, ['192.0.2.1']));
    const outcome1 = await p1;
    assert.deepEqual(outcome1, answer(100_000, ['192.0.2.1']));

    clock.advance(99_999);
    assert.deepEqual(await cache.lookup('example.com', 'A'), outcome1);
    assert.equal(resolver.callCount, 1);

    clock.advance(1); // TTL exhausted (staleWindowMs = 0)
    const p2 = cache.lookup('example.com', 'A');
    await tick();
    assert.equal(resolver.callCount, 2);
    resolver.lastCall().deferred.resolve(answer(100_000, ['192.0.2.2']));
    assert.deepEqual(await p2, answer(100_000, ['192.0.2.2']));
  });

  it('caches NXDOMAIN by its own negative TTL', async () => {
    const { resolver, clock, cache } = makeCache();

    const p1 = cache.lookup('missing.example', 'A');
    await tick();
    resolver.lastCall().deferred.resolve(nxdomain(50_000));
    assert.deepEqual(await p1, nxdomain(50_000));

    clock.advance(49_999);
    assert.deepEqual(await cache.lookup('missing.example', 'A'), nxdomain(50_000));
    assert.equal(resolver.callCount, 1);

    clock.advance(1);
    const p2 = cache.lookup('missing.example', 'A');
    await tick();
    assert.equal(resolver.callCount, 2);
    resolver.lastCall().deferred.resolve(answer(100_000));
    assert.deepEqual(await p2, answer(100_000));
  });

  it('keeps positive and negative entries independent per name and type', async () => {
    const { resolver, cache } = makeCache();

    const nx = cache.lookup('a.example', 'A');
    const aaaa = cache.lookup('a.example', 'AAAA');
    await tick();
    assert.equal(resolver.callCount, 2);
    resolver.calls[0]!.deferred.resolve(nxdomain(10_000));
    resolver.calls[1]!.deferred.resolve(answer(10_000, ['::1']));
    assert.deepEqual(await nx, nxdomain(10_000));
    assert.deepEqual(await aaaa, answer(10_000, ['::1']));
  });

  it('never caches transient resolver errors', async () => {
    const { resolver, cache } = makeCache();
    const boom = new Error('ECONNRESET');

    const p1 = cache.lookup('flaky.example', 'A');
    await tick();
    resolver.lastCall().deferred.reject(boom);
    await assert.rejects(p1, (err) => err === boom);
    assert.equal(cache.size, 0);

    const p2 = cache.lookup('flaky.example', 'A');
    await tick();
    assert.equal(resolver.callCount, 2, 'transient error must not become a negative-cache entry');
    resolver.lastCall().deferred.resolve(answer(100_000));
    assert.deepEqual(await p2, answer(100_000));
  });

  it('treats malformed resolver outcomes as transient failures', async () => {
    const { resolver, cache } = makeCache();

    const p1 = cache.lookup('weird.example', 'A');
    await tick();
    resolver.lastCall().deferred.resolve({ nope: true } as unknown as ResolveOutcome);
    await assert.rejects(p1, TypeError);

    const p2 = cache.lookup('weird.example', 'A');
    await tick();
    assert.equal(resolver.callCount, 2);
    resolver.lastCall().deferred.resolve(answer(100_000));
    assert.deepEqual(await p2, answer(100_000));
  });
});

describe('single-flight coalescing', () => {
  it('merges concurrent lookups for the same name and type', async () => {
    const { resolver, cache } = makeCache();

    const p1 = cache.lookup('example.com', 'A');
    const p2 = cache.lookup('example.com', 'A');
    const p3 = cache.lookup('example.com', 'AAAA'); // different type: not merged
    await tick();
    assert.equal(resolver.callCount, 2);

    resolver.calls[0]!.deferred.resolve(answer(100_000, ['192.0.2.1']));
    resolver.calls[1]!.deferred.resolve(answer(100_000, ['::1']));
    assert.deepEqual(await p1, answer(100_000, ['192.0.2.1']));
    assert.deepEqual(await p2, answer(100_000, ['192.0.2.1']));
    assert.deepEqual(await p3, answer(100_000, ['::1']));
  });

  it('normalizes case and trailing dots before coalescing', async () => {
    const { resolver, cache } = makeCache();

    const p1 = cache.lookup('ExAmPle.COM.', 'A');
    const p2 = cache.lookup('example.com', 'a');
    const p3 = cache.lookup('EXAMPLE.COM..', 'A');
    await tick();
    assert.equal(resolver.callCount, 1);
    assert.equal(resolver.lastCall().hostname, 'example.com', 'resolver receives the normalized name');
    assert.equal(resolver.lastCall().type, 'A');

    resolver.lastCall().deferred.resolve(answer(100_000));
    assert.deepEqual(await p1, answer(100_000));
    assert.deepEqual(await p2, answer(100_000));
    assert.deepEqual(await p3, answer(100_000));
  });
});

describe('cancellation', () => {
  it('cancels callers independently; the request survives until the last waiter cancels', async () => {
    const { resolver, cache } = makeCache();
    const c1 = new AbortController();
    const c2 = new AbortController();
    const c3 = new AbortController();

    const p1 = cache.lookup('example.com', 'A', { signal: c1.signal });
    const p2 = cache.lookup('example.com', 'A', { signal: c2.signal });
    const p3 = cache.lookup('example.com', 'A', { signal: c3.signal });
    await tick();
    assert.equal(resolver.callCount, 1);

    const cancelled1 = assert.rejects(p1, LookupCancelledError);
    c1.abort();
    await cancelled1;
    assert.equal(resolver.lastCall().signal.aborted, false, 'underlying request must survive while waiters remain');

    const cancelled2 = assert.rejects(p2, LookupCancelledError);
    c2.abort();
    await cancelled2;
    assert.equal(resolver.lastCall().signal.aborted, false);

    const cancelled3 = assert.rejects(p3, LookupCancelledError);
    c3.abort();
    await cancelled3;
    assert.equal(resolver.lastCall().signal.aborted, true, 'underlying request is aborted once all waiters cancelled');
  });

  it('drops the entry when the aborted request fails; nothing is cached', async () => {
    const { resolver, cache } = makeCache();
    const controller = new AbortController();

    const p1 = cache.lookup('example.com', 'A', { signal: controller.signal });
    await tick();
    const cancelled = assert.rejects(p1, LookupCancelledError);
    controller.abort();
    await cancelled;
    resolver.lastCall().deferred.reject(new Error('aborted'));
    await tick();
    assert.equal(cache.size, 0);

    const p2 = cache.lookup('example.com', 'A');
    await tick();
    assert.equal(resolver.callCount, 2, 'a cancelled-then-failed request leaves no cache entry');
    resolver.lastCall().deferred.resolve(answer(100_000));
    await p2;
  });

  it('cancel vs complete race: a late completion is still cached, the cancelled waiter stays cancelled', async () => {
    const { resolver, cache } = makeCache();
    const controller = new AbortController();

    const p1 = cache.lookup('example.com', 'A', { signal: controller.signal });
    await tick();
    const cancelled = assert.rejects(p1, LookupCancelledError);
    controller.abort(); // cancel and completion happen in the same turn
    resolver.lastCall().deferred.resolve(answer(100_000, ['192.0.2.9']));
    await cancelled;
    await tick();

    // The value was valid, so it is cached despite the cancellation.
    assert.deepEqual(await cache.lookup('example.com', 'A'), answer(100_000, ['192.0.2.9']));
    assert.equal(resolver.callCount, 1);
  });

  it('complete vs cancel race: a completed waiter keeps its value, the later abort is a no-op', async () => {
    const { resolver, cache } = makeCache();
    const controller = new AbortController();

    const p1 = cache.lookup('example.com', 'A', { signal: controller.signal });
    await tick();
    resolver.lastCall().deferred.resolve(answer(100_000));
    await tick(); // let the completion land first
    controller.abort();
    assert.deepEqual(await p1, answer(100_000));
  });

  it('rejects immediately for an already-aborted signal without starting a request', async () => {
    const { resolver, cache } = makeCache();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(cache.lookup('example.com', 'A', { signal: controller.signal }), LookupCancelledError);
    assert.equal(resolver.callCount, 0);
    assert.equal(cache.size, 0);
  });
});

describe('stale-while-revalidate', () => {
  const TTL = 100_000;
  const STALE = 60_000;

  it('serves stale values inside the window and refreshes once in the background', async () => {
    const { resolver, clock, cache } = makeCache({ staleWindowMs: STALE });

    const p1 = cache.lookup('example.com', 'A');
    await tick();
    resolver.lastCall().deferred.resolve(answer(TTL, ['192.0.2.1']));
    assert.deepEqual(await p1, answer(TTL, ['192.0.2.1']));

    clock.advance(TTL + 1); // expired, inside the stale window
    const staleResults = await Promise.all([
      cache.lookup('example.com', 'A'),
      cache.lookup('example.com', 'A'),
      cache.lookup('example.com', 'A'),
    ]);
    for (const result of staleResults) {
      assert.deepEqual(result, answer(TTL, ['192.0.2.1']), 'stale value served synchronously');
    }
    await tick();
    assert.equal(resolver.callCount, 2, 'exactly one background refresh (single-flight)');
    assert.equal(cache.inspect('example.com', 'A')?.inflight, 'refresh');

    resolver.lastCall().deferred.resolve(answer(TTL, ['192.0.2.2']));
    await tick();
    assert.deepEqual(await cache.lookup('example.com', 'A'), answer(TTL, ['192.0.2.2']));
    assert.equal(resolver.callCount, 2);
  });

  it('failed refresh extends the error backoff and never rewrites the original expiry', async () => {
    const { resolver, clock, cache } = makeCache({ staleWindowMs: STALE });

    const p1 = cache.lookup('example.com', 'A');
    await tick();
    resolver.lastCall().deferred.resolve(answer(TTL, ['192.0.2.1']));
    await p1;
    const before = cache.inspect('example.com', 'A');
    assert.ok(before);

    clock.advance(TTL + 1);
    assert.deepEqual(await cache.lookup('example.com', 'A'), answer(TTL, ['192.0.2.1']));
    await tick();
    assert.equal(resolver.callCount, 2);

    resolver.lastCall().deferred.reject(new Error('SERVFAIL'));
    await tick();

    const after = cache.inspect('example.com', 'A');
    assert.ok(after);
    assert.equal(after.freshUntil, before.freshUntil, 'expiry must not be rewritten by a failed refresh');
    assert.equal(after.staleUntil, before.staleUntil);
    assert.equal(after.consecutiveRefreshFailures, 1);
    assert.equal(after.nextRefreshAt, clock.now() + 1000);

    // Still stale-servable, but backoff suppresses an immediate retry.
    assert.deepEqual(await cache.lookup('example.com', 'A'), answer(TTL, ['192.0.2.1']));
    await tick();
    assert.equal(resolver.callCount, 2);

    clock.advance(1000); // backoff elapsed, still inside the stale window
    assert.deepEqual(await cache.lookup('example.com', 'A'), answer(TTL, ['192.0.2.1']));
    await tick();
    assert.equal(resolver.callCount, 3, 'refresh retried after backoff');
    resolver.lastCall().deferred.resolve(answer(TTL, ['192.0.2.2']));
    await tick();
    assert.deepEqual(await cache.lookup('example.com', 'A'), answer(TTL, ['192.0.2.2']));
  });

  it('re-expiry during refresh: late lookups join the in-flight refresh instead of querying again', async () => {
    const { resolver, clock, cache } = makeCache({ staleWindowMs: 10_000 });

    const p1 = cache.lookup('example.com', 'A');
    await tick();
    resolver.lastCall().deferred.resolve(answer(TTL, ['192.0.2.1']));
    await p1;

    clock.advance(TTL + 1); // stale: triggers the background refresh
    assert.deepEqual(await cache.lookup('example.com', 'A'), answer(TTL, ['192.0.2.1']));
    await tick();
    assert.equal(resolver.callCount, 2);

    clock.advance(20_000); // stale window (10s) is now exhausted mid-refresh
    const late = cache.lookup('example.com', 'A');
    await tick();
    assert.equal(resolver.callCount, 2, 'no second request; the lookup joined the refresh');

    resolver.lastCall().deferred.resolve(answer(TTL, ['192.0.2.2']));
    assert.deepEqual(await late, answer(TTL, ['192.0.2.2']), 'joined waiter receives the refreshed value');
  });

  it('a failed refresh with joined waiters rejects them but keeps the old entry', async () => {
    const { resolver, clock, cache } = makeCache({ staleWindowMs: 10_000 });

    const p1 = cache.lookup('example.com', 'A');
    await tick();
    resolver.lastCall().deferred.resolve(answer(TTL, ['192.0.2.1']));
    await p1;

    clock.advance(TTL + 1);
    await cache.lookup('example.com', 'A'); // trigger refresh
    await tick();
    clock.advance(20_000); // re-expire mid-refresh
    const late = cache.lookup('example.com', 'A');
    await tick();

    const boom = new Error('SERVFAIL');
    resolver.lastCall().deferred.reject(boom);
    await assert.rejects(late, (err) => err === boom);
    assert.equal(cache.inspect('example.com', 'A')?.consecutiveRefreshFailures, 1);
  });
});

describe('capacity and eviction', () => {
  it('evicts least-recently-used entries beyond capacity', async () => {
    const { resolver, cache } = makeCache({ capacity: 2 });

    for (const name of ['a.example', 'b.example']) {
      const p = cache.lookup(name, 'A');
      await tick();
      resolver.lastCall().deferred.resolve(answer(100_000, [name]));
      await p;
    }
    await cache.lookup('a.example', 'A'); // bump a.example; b.example is now the LRU entry

    const pc = cache.lookup('c.example', 'A');
    await tick();
    resolver.lastCall().deferred.resolve(answer(100_000, ['c.example']));
    await pc;
    assert.equal(cache.size, 2);

    const callsBefore = resolver.callCount;
    await cache.lookup('a.example', 'A'); // still cached
    await cache.lookup('c.example', 'A'); // still cached
    assert.equal(resolver.callCount, callsBefore);

    const pb = cache.lookup('b.example', 'A'); // evicted -> new request
    await tick();
    assert.equal(resolver.callCount, callsBefore + 1);
    resolver.lastCall().deferred.resolve(answer(100_000, ['b.example']));
    await pb;
  });

  it('never evicts entries with waiters, allowing a transient overflow', async () => {
    const { resolver, cache } = makeCache({ capacity: 1 });

    const pa = cache.lookup('a.example', 'A'); // stays in flight: pinned
    await tick();
    const pb = cache.lookup('b.example', 'A');
    await tick();
    assert.equal(cache.size, 2, 'pinned entry cannot be evicted, so capacity is exceeded');

    resolver.calls[1]!.deferred.resolve(answer(100_000, ['b']));
    assert.deepEqual(await pb, answer(100_000, ['b']));
    // a.example is still pinned; b.example settles unpinned and is evicted.
    assert.equal(cache.inspect('b.example', 'A'), undefined);

    resolver.calls[0]!.deferred.resolve(answer(100_000, ['a']));
    assert.deepEqual(await pa, answer(100_000, ['a']));
    assert.equal(cache.size, 1);
    assert.deepEqual(await cache.lookup('a.example', 'A'), answer(100_000, ['a']));
    assert.equal(resolver.callCount, 2);
  });

  it('never evicts entries with an in-flight refresh', async () => {
    const { resolver, clock, cache } = makeCache({ capacity: 2, staleWindowMs: 1_000_000 });

    for (const name of ['a.example', 'b.example']) {
      const p = cache.lookup(name, 'A');
      await tick();
      resolver.lastCall().deferred.resolve(answer(100_000, [name]));
      await p;
    }

    clock.advance(100_001); // both stale; refresh a.example
    assert.deepEqual(await cache.lookup('a.example', 'A'), answer(100_000, ['a.example']));
    await tick();
    assert.equal(cache.inspect('a.example', 'A')?.inflight, 'refresh');

    const pc = cache.lookup('c.example', 'A'); // forces an eviction pass
    await tick();
    resolver.lastCall().deferred.resolve(answer(100_000, ['c.example']));
    await pc;

    assert.ok(cache.inspect('a.example', 'A'), 'refreshing entry survives eviction');
    assert.equal(cache.inspect('b.example', 'A'), undefined, 'unpinned LRU entry is evicted instead');

    resolver.calls[2]!.deferred.resolve(answer(100_000, ['a2']));
    await tick();
    assert.deepEqual(await cache.lookup('a.example', 'A'), answer(100_000, ['a2']));
  });
});

describe('close', () => {
  it('rejects new lookups, aborts in-flight requests and delivers one shared error to all waiters', async () => {
    const { resolver, cache } = makeCache({ staleWindowMs: 60_000 });

    const p1 = cache.lookup('a.example', 'A');
    const p2 = cache.lookup('a.example', 'A'); // coalesced waiter
    const p3 = cache.lookup('b.example', 'A');
    await tick();
    assert.equal(resolver.callCount, 2);

    cache.close();
    assert.equal(cache.closed, true);
    assert.equal(cache.size, 0);

    const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);
    assert.equal(r1.status, 'rejected');
    assert.equal(r2.status, 'rejected');
    assert.equal(r3.status, 'rejected');
    if (r1.status !== 'rejected' || r2.status !== 'rejected' || r3.status !== 'rejected') {
      assert.fail('unreachable');
    }
    assert.ok(r1.reason instanceof DnsCacheClosedError);
    assert.strictEqual(r1.reason, r2.reason, 'every waiter receives the same error instance');
    assert.strictEqual(r1.reason, r3.reason);

    assert.equal(resolver.calls[0]!.signal.aborted, true, 'in-flight query aborted');
    assert.equal(resolver.calls[1]!.signal.aborted, true);

    await assert.rejects(cache.lookup('c.example', 'A'), (err) => {
      assert.strictEqual(err, r1.reason, 'post-close lookups reject with the same instance');
      return true;
    });

    cache.close(); // idempotent
    assert.equal(resolver.callCount, 2, 'no new requests after close');
  });

  it('aborts an in-flight background refresh on close', async () => {
    const { resolver, clock, cache } = makeCache({ staleWindowMs: 60_000 });

    const p1 = cache.lookup('example.com', 'A');
    await tick();
    resolver.lastCall().deferred.resolve(answer(100_000));
    await p1;

    clock.advance(100_001);
    await cache.lookup('example.com', 'A'); // triggers background refresh
    await tick();
    assert.equal(resolver.callCount, 2);

    cache.close();
    assert.equal(resolver.lastCall().signal.aborted, true, 'refresh request aborted on close');
  });
});

describe('clock handling', () => {
  it('a backwards clock never resurrects expired entries nor extends TTLs', async () => {
    const { resolver, clock, cache } = makeCache();

    const p1 = cache.lookup('example.com', 'A');
    await tick();
    resolver.lastCall().deferred.resolve(answer(100_000));
    await p1;

    clock.advance(50_000);
    clock.set(T0); // rewind before the cache observed the advance: harmless
    assert.deepEqual(await cache.lookup('example.com', 'A'), answer(100_000));
    assert.equal(resolver.callCount, 1);

    clock.advance(100_001); // past the 100s TTL in cache-observed time
    const p2 = cache.lookup('example.com', 'A'); // samples the clock: entry expired
    await tick();
    assert.equal(resolver.callCount, 2, 'entry expired on schedule');

    clock.set(0); // rewind far into the past while the re-query is in flight
    const p3 = cache.lookup('example.com', 'A');
    await tick();
    assert.equal(
      resolver.callCount,
      2,
      'rewind neither resurrects the expired entry nor starts another request',
    );

    resolver.lastCall().deferred.resolve(answer(100_000, ['192.0.2.2']));
    assert.deepEqual(await p2, answer(100_000, ['192.0.2.2']));
    assert.deepEqual(await p3, answer(100_000, ['192.0.2.2']));

    // The new TTL is anchored at cache time 1_100_001, not at the rewound clock.
    assert.equal(cache.inspect('example.com', 'A')?.freshUntil, T0 + 100_001 + 100_000);
    clock.set(0);
    assert.deepEqual(await cache.lookup('example.com', 'A'), answer(100_000, ['192.0.2.2']));
    assert.equal(resolver.callCount, 2, 'rewind does not extend the fresh period either');
  });
});

describe('input validation', () => {
  it('throws synchronously on invalid hostnames', async () => {
    const { resolver, cache } = makeCache();
    assert.throws(() => cache.lookup('', 'A'), InvalidHostnameError);
    assert.throws(() => cache.lookup('.', 'A'), InvalidHostnameError);
    assert.throws(() => cache.lookup('...', 'A'), InvalidHostnameError);
    assert.equal(resolver.callCount, 0);
  });

  it('validates constructor options', () => {
    const resolver = new MockResolver();
    assert.throws(() => new DnsCache({} as DnsCacheOptions), TypeError);
    assert.throws(() => new DnsCache({ resolver, capacity: -1 }), RangeError);
    assert.throws(() => new DnsCache({ resolver, capacity: 1.5 }), RangeError);
    assert.throws(() => new DnsCache({ resolver, staleWindowMs: -1 }), RangeError);
    assert.throws(() => new DnsCache({ resolver, minTtlMs: 1000, maxTtlMs: 10 }), RangeError);
  });
});
