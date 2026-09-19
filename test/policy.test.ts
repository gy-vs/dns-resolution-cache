import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampTtlMs, defaultRefreshBackoffMs } from '../src/index.js';

describe('clampTtlMs', () => {
  it('clamps into [min, max]', () => {
    assert.equal(clampTtlMs(50, 100, 1000), 100);
    assert.equal(clampTtlMs(5000, 100, 1000), 1000);
    assert.equal(clampTtlMs(500, 100, 1000), 500);
  });

  it('handles degenerate inputs', () => {
    assert.equal(clampTtlMs(Number.NaN, 100, 1000), 100);
    assert.equal(clampTtlMs(Number.POSITIVE_INFINITY, 100, 1000), 1000);
    assert.equal(clampTtlMs(Number.NEGATIVE_INFINITY, 100, 1000), 100);
    assert.equal(clampTtlMs(-5, 0, 1000), 0);
  });
});

describe('defaultRefreshBackoffMs', () => {
  it('grows exponentially from 1s', () => {
    assert.equal(defaultRefreshBackoffMs(1), 1000);
    assert.equal(defaultRefreshBackoffMs(2), 2000);
    assert.equal(defaultRefreshBackoffMs(3), 4000);
    assert.equal(defaultRefreshBackoffMs(4), 8000);
  });

  it('is capped at 5 minutes', () => {
    assert.equal(defaultRefreshBackoffMs(100), 300_000);
  });
});
