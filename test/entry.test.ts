import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CacheEntry } from '../src/index.js';
import { answer } from './helpers.js';

const TTL = 100;
const STALE = 50;

function freshEntry(now = 0): CacheEntry {
  const entry = new CacheEntry();
  entry.onRequestStarted('query');
  entry.onSuccess(answer(TTL), now, TTL, STALE);
  return entry;
}

describe('CacheEntry state machine', () => {
  it('starts as a miss requiring a new query', () => {
    const entry = new CacheEntry();
    assert.deepEqual(entry.decideLookup(0), { kind: 'wait', startQuery: true });
    assert.equal(entry.hasValue, false);
    assert.equal(entry.pinned, false);
  });

  it('serves hits until freshUntil, then stale until staleUntil, then waits', () => {
    const entry = freshEntry(0);

    const hit = entry.decideLookup(99);
    assert.equal(hit.kind, 'hit');

    const stale = entry.decideLookup(100);
    assert.equal(stale.kind, 'stale');
    assert.equal(stale.kind === 'stale' && stale.shouldRefresh, true);

    const stillStale = entry.decideLookup(149);
    assert.equal(stillStale.kind, 'stale');

    assert.deepEqual(entry.decideLookup(150), { kind: 'wait', startQuery: true });
  });

  it('does not start a second refresh while one is in flight (single-flight)', () => {
    const entry = freshEntry(0);
    entry.onRequestStarted('refresh');
    const decision = entry.decideLookup(120);
    assert.equal(decision.kind, 'stale');
    assert.equal(decision.kind === 'stale' && decision.shouldRefresh, false);
    assert.equal(entry.pinned, true);
  });

  it('joins an in-flight refresh instead of querying when the value re-expires mid-refresh', () => {
    const entry = freshEntry(0);
    entry.onRequestStarted('refresh');
    // Past staleUntil (150) while the refresh is still running.
    assert.deepEqual(entry.decideLookup(200), { kind: 'wait', startQuery: false });
  });

  it('suppresses refresh retries during error backoff', () => {
    // Stale window (5s) must outlast the backoff (1s) so the retried decision
    // is still inside the window.
    const entry = new CacheEntry();
    entry.onRequestStarted('query');
    entry.onSuccess(answer(TTL), 0, TTL, 5000);

    entry.onRequestStarted('refresh');
    const effect = entry.onFailure(120, 1000);
    assert.deepEqual(effect, { kind: 'backoff', nextRefreshAt: 1120 });

    const duringBackoff = entry.decideLookup(120);
    assert.equal(duringBackoff.kind, 'stale');
    assert.equal(duringBackoff.kind === 'stale' && duringBackoff.shouldRefresh, false);

    const afterBackoff = entry.decideLookup(1120);
    assert.equal(afterBackoff.kind, 'stale');
    assert.equal(afterBackoff.kind === 'stale' && afterBackoff.shouldRefresh, true);
  });

  it('failed refresh keeps the original expiry untouched and counts failures', () => {
    const entry = freshEntry(0);
    const before = entry.timings;
    entry.onRequestStarted('refresh');
    entry.onFailure(120, 1000);
    const after = entry.timings;

    assert.equal(after.freshUntil, before.freshUntil);
    assert.equal(after.staleUntil, before.staleUntil);
    assert.equal(entry.consecutiveRefreshFailures, 1);

    entry.onRequestStarted('refresh');
    entry.onFailure(130, 2000);
    assert.equal(entry.consecutiveRefreshFailures, 2);
    assert.equal(entry.timings.nextRefreshAt, 2130);
  });

  it('failed query without a cached value drops the entry', () => {
    const entry = new CacheEntry();
    entry.onRequestStarted('query');
    assert.deepEqual(entry.onFailure(0, 1000), { kind: 'drop' });
    assert.equal(entry.hasValue, false);
  });

  it('success resets failure count, waiters and inflight state', () => {
    const entry = freshEntry(0);
    entry.onRequestStarted('refresh');
    entry.onFailure(120, 1000);
    entry.onRequestStarted('refresh');
    entry.onWaiterAdded();
    entry.onSuccess(answer(200), 130, 200, STALE);

    assert.equal(entry.consecutiveRefreshFailures, 0);
    assert.equal(entry.waiters, 0);
    assert.equal(entry.inflight, 'none');
    assert.equal(entry.timings.freshUntil, 330);
    assert.equal(entry.timings.staleUntil, 380);
  });

  it('aborts the underlying request only when the last waiter of a query leaves', () => {
    const entry = new CacheEntry();
    entry.onRequestStarted('query');
    entry.onWaiterAdded();
    entry.onWaiterAdded();

    assert.equal(entry.onWaiterRemoved(), false); // one waiter remains
    assert.equal(entry.onWaiterRemoved(), true); // last waiter of a query
    // The request is still in flight until it settles; the cache layer
    // detaches the entry from the map when aborting.
    assert.equal(entry.inflight, 'query');
    assert.equal(entry.pinned, true);
    assert.deepEqual(entry.onFailure(0, 1000), { kind: 'drop' });
    assert.equal(entry.pinned, false);
  });

  it('never aborts a background refresh when its waiters leave', () => {
    const entry = freshEntry(0);
    entry.onRequestStarted('refresh');
    entry.onWaiterAdded(); // expired-during-refresh: a waiter joined
    assert.equal(entry.onWaiterRemoved(), false);
    assert.equal(entry.inflight, 'refresh');
  });

  it('onWaiterRemoved is robust against over-removal', () => {
    const entry = new CacheEntry();
    assert.equal(entry.onWaiterRemoved(), false);
    assert.equal(entry.waiters, 0);
  });
});
