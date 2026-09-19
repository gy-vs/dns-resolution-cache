import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CacheEntry, decide } from '../src/entry.js';
import type { CachedValue } from '../src/entry.js';
import type { Flight } from '../src/flight.js';

const VALUE: CachedValue = {
  status: 'ok',
  answers: [],
  storedAtMs: 0,
  freshUntilMs: 100,
  staleUntilMs: 200,
};

function entryWithValue(value: CachedValue | null = VALUE): CacheEntry {
  const entry = new CacheEntry('A example.com', 'example.com', 'A', 0);
  entry.value = value;
  return entry;
}

/** decide() only inspects `flight === null`, so a stub object suffices. */
const fakeFlight = {} as Flight;

test('fresh value is a hit', () => {
  const entry = entryWithValue();
  const decision = decide(entry, 50);
  assert.equal(decision.kind, 'hit');
  assert.equal(entry.phaseAt(50), 'fresh');
});

test('boundary: exactly at freshUntil is stale, not fresh', () => {
  const entry = entryWithValue();
  assert.equal(decide(entry, 100).kind, 'stale');
});

test('stale value asks for a refresh when idle and out of backoff', () => {
  const entry = entryWithValue();
  const decision = decide(entry, 150);
  assert.deepEqual(decision, { kind: 'stale', value: VALUE, startRefresh: true });
  assert.equal(entry.phaseAt(150), 'stale');
});

test('stale value does not refresh while backoff is cooling down', () => {
  const entry = entryWithValue();
  entry.refreshNotBeforeMs = 180;
  const decision = decide(entry, 150);
  assert.deepEqual(decision, { kind: 'stale', value: VALUE, startRefresh: false });
});

test('stale value does not start a second refresh while one is in flight', () => {
  const entry = entryWithValue();
  entry.flight = fakeFlight;
  const decision = decide(entry, 150);
  assert.deepEqual(decision, { kind: 'stale', value: VALUE, startRefresh: false });
});

test('expired value with no flight is a miss', () => {
  const entry = entryWithValue();
  assert.equal(decide(entry, 250).kind, 'miss');
  assert.equal(entry.phaseAt(250), 'expired');
});

test('expired value with an in-flight refresh joins that flight', () => {
  const entry = entryWithValue();
  entry.flight = fakeFlight;
  const decision = decide(entry, 250);
  assert.deepEqual(decision, { kind: 'join', flight: fakeFlight });
});

test('no value: pending joins, empty misses', () => {
  const pending = entryWithValue(null);
  pending.flight = fakeFlight;
  assert.deepEqual(decide(pending, 10), { kind: 'join', flight: fakeFlight });
  assert.equal(pending.phaseAt(10), 'pending');

  const empty = entryWithValue(null);
  assert.equal(decide(empty, 10).kind, 'miss');
  assert.equal(empty.phaseAt(10), 'empty');
});

test('clock moving backwards makes a stale entry fresh again', () => {
  const entry = entryWithValue();
  assert.equal(decide(entry, 150).kind, 'stale');
  // Clock jumps back (NTP correction, VM snapshot restore, ...).
  const decision = decide(entry, 50);
  assert.equal(decision.kind, 'hit');
});

test('pinned iff a flight is attached', () => {
  const entry = entryWithValue();
  assert.equal(entry.pinned, false);
  entry.flight = fakeFlight;
  assert.equal(entry.pinned, true);
});
