import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey, normalizeName, normalizeType } from '../src/normalize.js';

test('normalizeName folds case', () => {
  assert.equal(normalizeName('ExAmPle.COM'), 'example.com');
  assert.equal(normalizeName('WWW.Example.Com'), 'www.example.com');
});

test('normalizeName strips trailing root dots', () => {
  assert.equal(normalizeName('example.com.'), 'example.com');
  assert.equal(normalizeName('example.com..'), 'example.com');
  assert.equal(normalizeName('example.com...'), 'example.com');
});

test('normalizeName trims surrounding whitespace', () => {
  assert.equal(normalizeName('  example.com  '), 'example.com');
});

test('normalizeName treats case and trailing dot variants as identical', () => {
  const variants = ['Example.COM.', 'example.com', 'EXAMPLE.COM..', ' example.Com. '];
  const normalized = variants.map(normalizeName);
  for (const n of normalized) {
    assert.equal(n, 'example.com');
  }
});

test('normalizeName rejects empty and root-only names', () => {
  assert.throws(() => normalizeName(''), TypeError);
  assert.throws(() => normalizeName('   '), TypeError);
  assert.throws(() => normalizeName('.'), TypeError);
  assert.throws(() => normalizeName('...'), TypeError);
});

test('normalizeName rejects over-long names', () => {
  const label = 'a'.repeat(63);
  const tooLong = `${label}.${label}.${label}.${label}.com`; // 257 chars
  assert.throws(() => normalizeName(tooLong), TypeError);
  const justFits = 'a'.repeat(253);
  assert.equal(normalizeName(justFits), justFits);
});

test('normalizeType upper-cases and trims', () => {
  assert.equal(normalizeType('a'), 'A');
  assert.equal(normalizeType(' aaaa '), 'AAAA');
  assert.equal(normalizeType('Txt'), 'TXT');
});

test('normalizeType rejects malformed types', () => {
  assert.throws(() => normalizeType(''), TypeError);
  assert.throws(() => normalizeType('   '), TypeError);
  assert.throws(() => normalizeType('A B'), TypeError);
  assert.throws(() => normalizeType('A/B'), TypeError);
});

test('cacheKey distinguishes types but not name cosmetics', () => {
  assert.equal(cacheKey(normalizeName('Example.com.'), normalizeType('a')), cacheKey('example.com', 'A'));
  assert.notEqual(cacheKey('example.com', 'A'), cacheKey('example.com', 'AAAA'));
  assert.notEqual(cacheKey('example.com', 'A'), cacheKey('example.com.e', 'A'));
});
