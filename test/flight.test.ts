import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Flight } from '../src/flight.js';
import type { FlightOutcome } from '../src/flight.js';
import { QueryCancelledError } from '../src/types.js';
import type { ResolverResponse } from '../src/types.js';
import { deferred, okResponse, tick } from './helpers.js';

interface Harness {
  flight: Flight;
  runSignal: () => AbortSignal;
  complete: (response?: ResolverResponse) => void;
  fail: (error: unknown) => void;
  outcomes: FlightOutcome[];
}

function makeFlight(isRefresh = false): Harness {
  const d = deferred<ResolverResponse>();
  const outcomes: FlightOutcome[] = [];
  let signal: AbortSignal | null = null;
  const flight = new Flight({
    isRefresh,
    nowMs: 0,
    run: (s) => {
      signal = s;
      return d.promise;
    },
    onSettled: (_flight, outcome) => {
      outcomes.push(outcome);
    },
  });
  return {
    flight,
    runSignal: () => {
      if (signal === null) throw new Error('run() not called yet');
      return signal;
    },
    complete: (response = okResponse('1.2.3.4', 60)) => d.resolve(response),
    fail: (error) => d.reject(error),
    outcomes,
  };
}

test('all waiters share the underlying response', async () => {
  const h = makeFlight();
  const p1 = h.flight.wait();
  const p2 = h.flight.wait();
  assert.equal(h.flight.waiterCount, 2);
  h.complete();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.answers[0]?.data, '1.2.3.4');
  assert.equal(r2.answers[0]?.data, '1.2.3.4');
  assert.equal(h.outcomes.length, 1);
  assert.equal(h.outcomes[0]?.ok, true);
});

test('one caller cancelling leaves the others and the underlying request alone', async () => {
  const h = makeFlight();
  await tick(); // let run() execute
  const ac = new AbortController();
  const p1 = h.flight.wait(ac.signal);
  const p2 = h.flight.wait();
  const cancelled = assert.rejects(p1, (err: unknown) => (err as { name: string }).name === 'AbortError');
  ac.abort();
  await cancelled;
  assert.equal(h.flight.waiterCount, 1);
  assert.equal(h.runSignal().aborted, false);
  h.complete();
  const r2 = await p2;
  assert.equal(r2.status, 'ok');
});

test('cancelling the last waiter aborts the underlying request', async () => {
  const h = makeFlight();
  await tick();
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  const p1 = h.flight.wait(ac1.signal);
  const p2 = h.flight.wait(ac2.signal);
  const r1 = assert.rejects(p1);
  const r2 = assert.rejects(p2);
  ac1.abort();
  assert.equal(h.runSignal().aborted, false, 'still one waiter left');
  ac2.abort();
  assert.equal(h.runSignal().aborted, true, 'no waiters left -> abort underlying');
  assert.ok(h.runSignal().reason instanceof QueryCancelledError);
  assert.equal(h.flight.wasAbortedByCache, true);
  await r1;
  await r2;
});

test('refresh flights are retained: zero waiters does not abort them', async () => {
  const h = makeFlight(true);
  await tick();
  const ac = new AbortController();
  const p = h.flight.wait(ac.signal);
  const cancelled = assert.rejects(p);
  ac.abort();
  await cancelled;
  assert.equal(h.runSignal().aborted, false);
  h.complete();
  await h.flight.settled();
  assert.equal(h.outcomes[0]?.ok, true);
});

test('race: cancel wins when it happens before completion', async () => {
  const h = makeFlight();
  const ac = new AbortController();
  const p = h.flight.wait(ac.signal);
  const cancelled = assert.rejects(p, (err: unknown) => (err as { name: string }).name === 'AbortError');
  ac.abort();
  h.complete(); // completion arrives after the cancel: caller stays cancelled
  await cancelled;
  await h.flight.settled();
  // ...but the (valid) outcome is still reported to the cache for storage.
  assert.equal(h.outcomes[0]?.ok, true);
});

test('race: completion wins when it happens before cancel', async () => {
  const h = makeFlight();
  const ac = new AbortController();
  const p = h.flight.wait(ac.signal);
  h.complete();
  const response = await p;
  ac.abort(); // too late: waiter already settled
  assert.equal(response.status, 'ok');
});

test('underlying rejection reaches every waiter with the same error', async () => {
  const h = makeFlight();
  const p1 = h.flight.wait();
  const p2 = h.flight.wait();
  const boom = new Error('ECONNRESET');
  const r1 = assert.rejects(p1, (err: unknown) => err === boom);
  const r2 = assert.rejects(p2, (err: unknown) => err === boom);
  h.fail(boom);
  await r1;
  await r2;
  assert.deepEqual(h.outcomes[0], { ok: false, error: boom });
});

test('wait() after settlement returns the stored outcome', async () => {
  const h = makeFlight();
  h.complete();
  await h.flight.settled();
  const response = await h.flight.wait();
  assert.equal(response.status, 'ok');
});

test('wait() on an already-aborted caller signal rejects immediately', async () => {
  const h = makeFlight();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(h.flight.wait(ac.signal));
  assert.equal(h.flight.waiterCount, 0);
});

test('terminate rejects every waiter with the same error instance and aborts', async () => {
  const h = makeFlight();
  await tick();
  const p1 = h.flight.wait();
  const p2 = h.flight.wait();
  const err1 = p1.catch((e: unknown) => e);
  const err2 = p2.catch((e: unknown) => e);
  const closed = new Error('closed');
  h.flight.terminate(closed);
  assert.strictEqual(await err1, closed);
  assert.strictEqual(await err2, closed);
  assert.equal(h.runSignal().aborted, true);
  assert.equal(h.flight.wasAbortedByCache, true);
  // A late underlying completion is ignored.
  h.complete();
  await h.flight.settled();
  assert.equal(h.outcomes.length, 1);
  assert.deepEqual(h.outcomes[0], { ok: false, error: closed });
});
