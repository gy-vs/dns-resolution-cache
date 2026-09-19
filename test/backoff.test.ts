import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelayMs, defaultBackoff } from '../src/backoff.js';

test('first failure waits initialMs', () => {
  assert.equal(backoffDelayMs(defaultBackoff, 1), 250);
});

test('delay grows geometrically', () => {
  assert.equal(backoffDelayMs(defaultBackoff, 2), 500);
  assert.equal(backoffDelayMs(defaultBackoff, 3), 1000);
  assert.equal(backoffDelayMs(defaultBackoff, 4), 2000);
});

test('delay is capped at maxMs', () => {
  assert.equal(backoffDelayMs(defaultBackoff, 100), defaultBackoff.maxMs);
});

test('failure counts below 1 are clamped to the first step', () => {
  assert.equal(backoffDelayMs(defaultBackoff, 0), 250);
  assert.equal(backoffDelayMs(defaultBackoff, -3), 250);
});

test('custom policy is honored', () => {
  const policy = { initialMs: 1000, maxMs: 5000, multiplier: 3 };
  assert.equal(backoffDelayMs(policy, 1), 1000);
  assert.equal(backoffDelayMs(policy, 2), 3000);
  assert.equal(backoffDelayMs(policy, 3), 5000);
});
