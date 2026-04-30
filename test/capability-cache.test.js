// Capability return-value caching unit tests. Pure-shape coverage of the
// CapabilityCache primitive + the strategy-body schema validator. The
// load-bearing behavior (cache hit on a real `execute` round-trip) is
// verified manually per runtime/REFERENCE.md#capability-cache; unit-level
// coverage of the cache itself is enough for v1 — wiring through to the
// execute path is type-checked + the cache class is the one with branchy
// logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate KLURA_HOME so the user's local config (pool.driver references,
// identities.json, etc.) doesn't leak into these tests.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-capability-cache-'));
process.env.KLURA_HOME = TMP;
test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const { CapabilityCache, parseTtl, getCachedOrExecute } = await import(
  '../dist/cache/capability-cache.js'
);
const { validateCacheShape } = await import('../dist/strategies/validate/cache.js');

// ---------- TTL parser ----------

test('parseTtl: accepts seconds / minutes / hours', () => {
  assert.equal(parseTtl('30s'), 30_000);
  assert.equal(parseTtl('5m'), 300_000);
  assert.equal(parseTtl('1h'), 3_600_000);
  assert.equal(parseTtl('120s'), 120_000);
  assert.equal(parseTtl('90m'), 5_400_000);
});

test('parseTtl: rejects malformed', () => {
  for (const bad of ['', '30', '5min', '1d', '1w', 'm', '0s', '-5m', null, undefined, 30, '5.5m', '5 m']) {
    assert.throws(() => parseTtl(bad), /cache\.ttl/);
  }
});

// ---------- Cache get/set + identity scoping ----------

test('CapabilityCache: get/set roundtrip within TTL hits, beyond TTL misses', async () => {
  const cache = new CapabilityCache();
  const ok = cache.set('acme', undefined, 'whoami', { user: 'alice' }, 200, { id: 1 }, 50);
  assert.equal(ok, true);
  const hit = cache.get('acme', undefined, 'whoami', { user: 'alice' });
  assert.ok(hit, 'expected hit within TTL');
  assert.deepStrictEqual(hit.body, { id: 1 });
  await new Promise((r) => setTimeout(r, 60));
  const miss = cache.get('acme', undefined, 'whoami', { user: 'alice' });
  assert.equal(miss, null, 'expected miss after TTL elapsed');
});

test('CapabilityCache: stable arg hash — different key order, same hit', () => {
  const cache = new CapabilityCache();
  cache.set('acme', undefined, 'search_contact', { name: 'bob', limit: 1 }, 200, { id: 'A' }, 60_000);
  // Reverse-order keys should still hit — JSON.stringify with sorted keys
  // canonicalizes the inputs.
  const hit = cache.get('acme', undefined, 'search_contact', { limit: 1, name: 'bob' });
  assert.ok(hit, 'expected hit on reverse-order args');
  assert.deepStrictEqual(hit.body, { id: 'A' });
});

test('CapabilityCache: identity scoping isolates jars', () => {
  const cache = new CapabilityCache();
  cache.set('acme', 'work', 'whoami', {}, 200, { id: 'work' }, 60_000);
  cache.set('acme', 'personal', 'whoami', {}, 200, { id: 'personal' }, 60_000);
  cache.set('acme', undefined, 'whoami', {}, 200, { id: 'default' }, 60_000);
  assert.equal(cache.get('acme', 'work', 'whoami', {}).body.id, 'work');
  assert.equal(cache.get('acme', 'personal', 'whoami', {}).body.id, 'personal');
  assert.equal(cache.get('acme', undefined, 'whoami', {}).body.id, 'default');
  assert.equal(cache.get('acme', 'unknown', 'whoami', {}), null);
});

test('CapabilityCache: errors are not stored', () => {
  const cache = new CapabilityCache();
  // 5xx
  assert.equal(cache.set('a', undefined, 'c', {}, 500, { ok: false }, 60_000), false);
  // 4xx
  assert.equal(cache.set('a', undefined, 'c', {}, 401, { error: 'auth' }, 60_000), false);
  // 2xx with error body
  assert.equal(cache.set('a', undefined, 'c', {}, 200, { error: 'something' }, 60_000), false);
  // 2xx with needs_generation
  assert.equal(cache.set('a', undefined, 'c', {}, 200, { needs_generation: true }, 60_000), false);
  // 2xx with healable blocker
  assert.equal(
    cache.set('a', undefined, 'c', {}, 200, { blocker: { kind: 'auth' }, healable: true }, 60_000),
    false,
  );
  assert.equal(cache.size, 0);
  // Plain 2xx success body — caches normally.
  assert.equal(cache.set('a', undefined, 'c', {}, 200, { id: 1 }, 60_000), true);
  assert.equal(cache.size, 1);
});

test('CapabilityCache: sweep evicts expired entries, leaves live ones', async () => {
  const cache = new CapabilityCache();
  cache.set('a', undefined, 'short', {}, 200, { v: 1 }, 30);
  cache.set('a', undefined, 'long', {}, 200, { v: 2 }, 60_000);
  await new Promise((r) => setTimeout(r, 40));
  cache.sweep();
  assert.equal(cache.get('a', undefined, 'short', {}), null, 'short-TTL entry should be evicted');
  const longHit = cache.get('a', undefined, 'long', {});
  assert.ok(longHit, 'long-TTL entry should survive the sweep');
});

// ---------- getCachedOrExecute helper ----------

test('getCachedOrExecute: ttlMs=0 always misses (no caching)', async () => {
  const cache = new CapabilityCache();
  let calls = 0;
  const exec = async () => ({ status: 200, body: { hit: ++calls } });
  const r1 = await getCachedOrExecute(cache, 'a', undefined, 'c', {}, 0, exec);
  const r2 = await getCachedOrExecute(cache, 'a', undefined, 'c', {}, 0, exec);
  assert.equal(r1.body.hit, 1);
  assert.equal(r2.body.hit, 2, 'no cache → exec runs each call');
  assert.equal(r1._cache_hit, undefined);
  assert.equal(r2._cache_hit, undefined);
});

test('getCachedOrExecute: second call within TTL returns _cache_hit', async () => {
  const cache = new CapabilityCache();
  let calls = 0;
  const exec = async () => ({ status: 200, body: { hit: ++calls, value: 'x' } });
  const r1 = await getCachedOrExecute(cache, 'a', undefined, 'c', {}, 60_000, exec);
  const r2 = await getCachedOrExecute(cache, 'a', undefined, 'c', {}, 60_000, exec);
  assert.equal(r1.body.hit, 1);
  assert.equal(r1._cache_hit, undefined, 'first call is fresh');
  assert.equal(calls, 1, 'exec called only once');
  assert.equal(r2._cache_hit, true);
  assert.equal(typeof r2._cache_age_ms, 'number');
  assert.equal(r2.body.value, 'x', 'cached body preserved');
  assert.equal(r2.body._cache_hit, true, 'object body folded with cache hint');
});

test('getCachedOrExecute: errors not cached, next call runs fresh', async () => {
  const cache = new CapabilityCache();
  let calls = 0;
  const exec = async () => {
    calls += 1;
    if (calls === 1) return { status: 500, body: { error: 'flake' } };
    return { status: 200, body: { ok: true } };
  };
  const r1 = await getCachedOrExecute(cache, 'a', undefined, 'c', {}, 60_000, exec);
  assert.equal(r1.status, 500);
  const r2 = await getCachedOrExecute(cache, 'a', undefined, 'c', {}, 60_000, exec);
  assert.equal(r2.status, 200, 'error did not pollute the cache');
  assert.equal(calls, 2);
  // r2 should be the freshly-cached success now.
  const r3 = await getCachedOrExecute(cache, 'a', undefined, 'c', {}, 60_000, exec);
  assert.equal(r3._cache_hit, true);
  assert.equal(calls, 2, 'r3 served from cache, no extra exec');
});

// ---------- Schema validator ----------

test('validateCacheShape: absent block is fine', () => {
  assert.doesNotThrow(() => validateCacheShape({ strategy: 'fetch' }));
  assert.doesNotThrow(() => validateCacheShape({ strategy: 'fetch', cache: undefined }));
  assert.doesNotThrow(() => validateCacheShape({ strategy: 'fetch', cache: null }));
});

test('validateCacheShape: accepts well-formed ttl', () => {
  for (const ttl of ['30s', '5m', '1h', '120s']) {
    assert.doesNotThrow(() =>
      validateCacheShape({ strategy: 'fetch', cache: { ttl } }),
      `expected ttl ${JSON.stringify(ttl)} to validate`,
    );
  }
});

test('validateCacheShape: rejects malformed ttl', () => {
  for (const ttl of ['1d', '5min', '30', '', '0s']) {
    assert.throws(
      () => validateCacheShape({ strategy: 'fetch', cache: { ttl } }),
      /invalid_strategy: cache\.ttl/,
      `expected ttl ${JSON.stringify(ttl)} to reject`,
    );
  }
});

test('validateCacheShape: rejects unknown keys (closed schema)', () => {
  assert.throws(
    () => validateCacheShape({ strategy: 'fetch', cache: { ttl: '5m', extra: true } }),
    /invalid_strategy: cache\.extra/,
  );
  assert.throws(
    () => validateCacheShape({ strategy: 'fetch', cache: { scope: 'session' } }),
    /invalid_strategy: cache\.scope/,
  );
});

test('validateCacheShape: rejects empty cache object (no ttl)', () => {
  assert.throws(
    () => validateCacheShape({ strategy: 'fetch', cache: {} }),
    /invalid_strategy: cache requires "ttl"/,
  );
});

test('validateCacheShape: rejects non-object cache value', () => {
  assert.throws(
    () => validateCacheShape({ strategy: 'fetch', cache: '5m' }),
    /invalid_strategy: cache must be a plain object/,
  );
  assert.throws(
    () => validateCacheShape({ strategy: 'fetch', cache: 300 }),
    /invalid_strategy: cache must be a plain object/,
  );
});
