import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidHostnameError, normalizeHostname, normalizeRecordType } from '../src/index.js';

describe('normalizeHostname', () => {
  it('lowercases', () => {
    assert.equal(normalizeHostname('ExAmPle.COM'), 'example.com');
    assert.equal(normalizeHostname('WWW.Example.Org'), 'www.example.org');
  });

  it('strips the trailing root dot (and repeated dots)', () => {
    assert.equal(normalizeHostname('example.com.'), 'example.com');
    assert.equal(normalizeHostname('example.com..'), 'example.com');
  });

  it('combines case and trailing-dot normalization', () => {
    assert.equal(normalizeHostname('EXAMPLE.com.'), 'example.com');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(normalizeHostname('  example.com  '), 'example.com');
  });

  it('rejects empty and root-only names', () => {
    assert.throws(() => normalizeHostname(''), InvalidHostnameError);
    assert.throws(() => normalizeHostname('.'), InvalidHostnameError);
    assert.throws(() => normalizeHostname('...'), InvalidHostnameError);
    assert.throws(() => normalizeHostname('   '), InvalidHostnameError);
  });

  it('rejects non-strings', () => {
    assert.throws(() => normalizeHostname(undefined as unknown as string), InvalidHostnameError);
    assert.throws(() => normalizeHostname(42 as unknown as string), InvalidHostnameError);
  });
});

describe('normalizeRecordType', () => {
  it('uppercases', () => {
    assert.equal(normalizeRecordType('a'), 'A');
    assert.equal(normalizeRecordType('aaaa'), 'AAAA');
  });

  it('rejects empty types', () => {
    assert.throws(() => normalizeRecordType(''), TypeError);
    assert.throws(() => normalizeRecordType('  '), TypeError);
  });
});
