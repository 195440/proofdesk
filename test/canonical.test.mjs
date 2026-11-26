import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalize, hashOf, getPath, clone } from '../src/canonical.mjs';
import { sha256Text } from '../src/sha256.mjs';

test('canonicalize is independent of key order and drops undefined keys', () => {
  const a = { b: 1, a: [3, { y: 1, x: 2 }], c: undefined };
  const b = { a: [3, { x: 2, y: 1 }], b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(canonicalize(a), '{"a":[3,{"x":2,"y":1}],"b":1}');
});

test('canonicalize rejects NaN and Infinity so they cannot hide in a hash', () => {
  assert.throws(() => canonicalize({ x: NaN }), /non-finite/);
  assert.throws(() => canonicalize([Infinity]), /non-finite/);
});

test('hashOf changes when any value changes', () => {
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
  assert.notEqual(hashOf([1, 2]), hashOf([2, 1]));
});

test('getPath resolves dotted keys and array indexes, undefined when missing', () => {
  const o = { sodex: { klines: { vBTC_vUSDC: [{ c: '61873' }] } }, a: [[5, 6]] };
  assert.equal(getPath(o, 'sodex.klines.vBTC_vUSDC[0].c'), '61873');
  assert.equal(getPath(o, 'a[0][1]'), 6);
  assert.equal(getPath(o, 'sodex.nope.x'), undefined);
  assert.equal(getPath(o, 'a[3][0]'), undefined);
});

test('clone returns an independent copy', () => {
  const o = { a: { b: 1 } };
  const c = clone(o);
  c.a.b = 2;
  assert.equal(o.a.b, 1);
});

test('sha256: FIPS 180-4 test vectors', () => {
  assert.equal(sha256Text(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Text('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('sha256: matches node:crypto across padding boundaries and unicode', () => {
  const lengths = [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000, 65537];
  for (const n of lengths) {
    const s = 'x'.repeat(n);
    assert.equal(sha256Text(s), createHash('sha256').update(s, 'utf8').digest('hex'), `length ${n}`);
  }
  for (const s of ['中文测试 — ✓', '𝒳𝒴𝒵 😀', '\u0000\u0001', 'é'.repeat(100)]) {
    assert.equal(sha256Text(s), createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});
