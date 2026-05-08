// Surface-binding module — URL canonicalization, bind / lookup, and the
// path-distinct rule that gates the `surface_changed` checkpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { urlKey, bindUrlsToSurface, lookupSurface, isPathDistinct } = await import(
  '../dist/phases/surface-binding.js'
);

test('urlKey: origin + pathname; query and fragment stripped', () => {
  assert.equal(urlKey('https://shop.example.com/checkout?step=2#payment'), 'https://shop.example.com/checkout');
});

test('urlKey: host lowercased, trailing slash stripped (non-root)', () => {
  assert.equal(urlKey('https://Shop.Example.COM/Checkout/'), 'https://shop.example.com/Checkout');
});

test('urlKey: root path keeps the slash', () => {
  assert.equal(urlKey('https://example.com/'), 'https://example.com/');
});

test('urlKey: returns null on unparseable input', () => {
  assert.equal(urlKey('not-a-url'), null);
});

test('isPathDistinct: same path with different query is NOT distinct', () => {
  assert.equal(isPathDistinct('https://shop.example.com/search?q=foo', 'https://shop.example.com/search?q=bar'), false);
});

test('isPathDistinct: different path IS distinct', () => {
  assert.equal(isPathDistinct('https://shop.example.com/search', 'https://shop.example.com/checkout'), true);
});

test('isPathDistinct: undefined prev is treated as distinct', () => {
  assert.equal(isPathDistinct(undefined, 'https://shop.example.com/checkout'), true);
});

test('isPathDistinct: garbage URL returns false (don\'t fire on parse errors)', () => {
  assert.equal(isPathDistinct('https://shop.example.com/checkout', 'not-a-url'), false);
});

test('bindUrlsToSurface + lookupSurface: round-trip across query variants', () => {
  const session = { id: 'sess_t' };
  bindUrlsToSurface(session, 'checkout', [
    'https://shop.example.com/checkout',
    'https://shop.example.com/checkout/payment',
  ]);
  assert.equal(lookupSurface(session, 'https://shop.example.com/checkout?step=1'), 'checkout');
  assert.equal(lookupSurface(session, 'https://shop.example.com/checkout/payment#confirm'), 'checkout');
  assert.equal(lookupSurface(session, 'https://shop.example.com/cart'), undefined);
});

test('bindUrlsToSurface: skips entries that fail to parse', () => {
  const session = { id: 'sess_t2' };
  bindUrlsToSurface(session, 'search', ['https://example.com/search', 'garbage']);
  assert.equal(session.surfaceMap.size, 1);
});

test('lookupSurface: undefined when surfaceMap has not been allocated yet', () => {
  assert.equal(lookupSurface({ id: 'sess_empty' }, 'https://example.com/'), undefined);
});
