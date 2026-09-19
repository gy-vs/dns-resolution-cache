# async-dns-cache

Embeddable asynchronous DNS resolution cache for Node.js 20+. Library only — no CLI, no UI, no DNS client. The underlying resolver and the clock are injected, so tests never touch the network or the system clock.

## Features

- **Single-flight coalescing** — concurrent lookups for the same normalized `(hostname, recordType)` share one underlying request.
- **Independent cancellation** — each caller cancels via its own `AbortSignal`; the underlying request is aborted only when its *last* waiter cancels. A completion that races the cancellation is still cached.
- **Per-outcome TTLs** — positive answers and NXDOMAIN are cached by their own TTLs. Transient resolver rejections are never cached.
- **Stale-while-revalidate** — expired entries are served inside a stale window while a single-flight refresh runs in the background. A failed refresh only extends the error backoff; the original expiry is never rewritten.
- **Bounded capacity** — LRU eviction that never removes entries with waiters or an in-flight refresh (capacity is a soft bound while everything is pinned).
- **Deterministic close** — `close()` rejects new lookups, aborts all in-flight requests and delivers one shared `DnsCacheClosedError` instance to every waiter.
- **Monotonic time** — a backwards clock can never resurrect expired entries or extend TTLs.

## Install / build / test

```sh
npm install
npm run build   # compiles src/ -> dist/ (ESM + .d.ts)
npm test        # compiles src+test -> .build/ and runs node --test
```

The package entry is `dist/index.js` (`import { DnsCache } from 'async-dns-cache'`).

## Usage

```ts
import { DnsCache } from 'async-dns-cache';
import dns from 'node:dns/promises';

const cache = new DnsCache<string>({
  // You inject the resolver. Resolve with { kind: 'nxdomain', ttlMs } for
  // NXDOMAIN (cacheable); reject for transient errors (never cached).
  resolver: {
    async resolve(hostname, type, signal) {
      try {
        const records = await dns.resolve(hostname, type);
        return { kind: 'answer', records, ttlMs: 60_000 };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOTFOUND') {
          return { kind: 'nxdomain', ttlMs: 30_000 };
        }
        throw err; // transient: propagated to waiters, not cached
      }
    },
  },
  capacity: 1024,          // soft bound; pinned entries are never evicted
  staleWindowMs: 30_000,   // serve expired values this long while refreshing
  minTtlMs: 0,
  maxTtlMs: 86_400_000,
  // clock: new ManualClock(0),               // tests
  // refreshBackoffMs: (failures) => 1000 * failures,
});

const outcome = await cache.lookup('example.com', 'A', { signal: abortController.signal });
if (outcome.kind === 'answer') {
  console.log(outcome.records);
}

cache.close();
```

## API

### `new DnsCache<T>(options)`

| option | default | meaning |
| --- | --- | --- |
| `resolver` | — | injected async resolver (required) |
| `clock` | `Date.now()` | time source (`ManualClock` for tests) |
| `capacity` | `1024` | max entries; `0` disables caching |
| `staleWindowMs` | `30_000` | stale-while-revalidate window; `0` disables |
| `minTtlMs` / `maxTtlMs` | `0` / 24h | clamps for resolver-provided TTLs |
| `refreshBackoffMs` | 1s→5min exp. | delay before retrying a failed refresh |

### `cache.lookup(hostname, type, { signal? }): Promise<ResolveOutcome<T>>`

- Hostnames are normalized (lowercase, trailing root dot stripped) before coalescing and before being handed to the resolver. Invalid names throw `InvalidHostnameError` synchronously.
- Rejects with `LookupCancelledError` when `signal` fires (other waiters unaffected), with the shared `DnsCacheClosedError` after `close()`, and with the resolver's own error on transient failures.
- `ResolveOutcome` is `{ kind: 'answer', records, ttlMs } | { kind: 'nxdomain', ttlMs }`.

### `cache.close(): void`

Idempotent. Aborts every in-flight request and rejects all current and future waiters with the same `DnsCacheClosedError` instance.

### `cache.inspect(hostname, type): EntryInspection | undefined`, `cache.size`, `cache.closed`

Observability hooks (also used by the tests).

## Internals

| module | role |
| --- | --- |
| `src/entry.ts` | pure per-key state machine (no I/O, `now` injected) — hit/stale/wait decisions, abort decision, backoff transitions |
| `src/cache.ts` | orchestration: waiter sets, `AbortController`s, LRU map, eviction, close |
| `src/normalize.ts` | hostname/record-type canonicalization |
| `src/policy.ts` | TTL clamping, default refresh backoff |
| `src/clock.ts` | `Clock` interface, `systemClock`, `ManualClock` |
| `src/types.ts` / `src/errors.ts` | public types and error classes |

The state machine performs no I/O: `DnsCache` feeds it a monotonic `now` and executes its decisions, which is what makes the cancellation/expiry races deterministically testable.
