// Unit tests for JsEvalCacheImpl — the in-memory cache + refresh scheduler
// that sits inside Pool and backs js-eval prereqs.
//
// No browser, no playwright — we drive the cache directly and assert on
// get/set/schedule/cancel semantics. Integration with the real pool is
// covered by pool-conformance / pool-warm tests.

import test from 'node:test';
import assert from 'node:assert';
import { JsEvalCacheImpl } from '../dist/strategies/js-eval-cache.js';

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('get returns null when nothing is cached', () => {
  const c = new JsEvalCacheImpl();
  assert.strictEqual(c.get('p', 'x'), null);
});

test('set + get returns the cached value with its expiresAt', () => {
  const c = new JsEvalCacheImpl();
  const exp = Date.now() + 60_000;
  c.set('p', 'tok', 'secret-v1', exp);
  const entry = c.get('p', 'tok');
  assert.ok(entry);
  assert.strictEqual(entry.value, 'secret-v1');
  assert.strictEqual(entry.expiresAt, exp);
  assert.ok(entry.mintedAt <= Date.now());
});

test('per-platform isolation — different platforms do not see each other', () => {
  const c = new JsEvalCacheImpl();
  c.set('pa', 'tok', 'va', null);
  c.set('pb', 'tok', 'vb', null);
  assert.strictEqual(c.get('pa', 'tok').value, 'va');
  assert.strictEqual(c.get('pb', 'tok').value, 'vb');
});

test('cancel(platform) drops every binding for that platform', () => {
  const c = new JsEvalCacheImpl();
  c.set('p', 'a', 'av', null);
  c.set('p', 'b', 'bv', null);
  c.set('q', 'a', 'qav', null);
  c.cancel('p');
  assert.strictEqual(c.get('p', 'a'), null);
  assert.strictEqual(c.get('p', 'b'), null);
  assert.strictEqual(c.get('q', 'a').value, 'qav');
});

test('cancel(platform, bindsTo) drops just that binding', () => {
  const c = new JsEvalCacheImpl();
  c.set('p', 'a', 'av', null);
  c.set('p', 'b', 'bv', null);
  c.cancel('p', 'a');
  assert.strictEqual(c.get('p', 'a'), null);
  assert.strictEqual(c.get('p', 'b').value, 'bv');
});

test('schedule + tick runs the refresh function and caches the result', async () => {
  const c = new JsEvalCacheImpl();
  let calls = 0;
  c.schedule({
    platform: 'p',
    bindsTo: 'tok',
    intervalMs: 40,
    jitterMs: 0,
    refresh: async () => {
      calls += 1;
      return `v${calls}`;
    },
  });
  await waitMs(70);
  const entry = c.get('p', 'tok');
  assert.ok(entry, 'cache entry should exist after first tick');
  assert.strictEqual(entry.value, 'v1');
  assert.ok(calls >= 1);
  // Let at least one more tick run, confirm re-arming worked
  await waitMs(60);
  assert.ok(calls >= 2);
  assert.ok(/^v\d+$/.test(c.get('p', 'tok').value));
  c.shutdown();
});

test('schedule is idempotent: second call is a no-op while the first is active', async () => {
  const c = new JsEvalCacheImpl();
  let calls = 0;
  const refresh = async () => {
    calls += 1;
    return `v${calls}`;
  };
  c.schedule({ platform: 'p', bindsTo: 't', intervalMs: 50, jitterMs: 0, refresh });
  c.schedule({ platform: 'p', bindsTo: 't', intervalMs: 50, jitterMs: 0, refresh });
  c.schedule({ platform: 'p', bindsTo: 't', intervalMs: 50, jitterMs: 0, refresh });
  await waitMs(80);
  // Only one timer should be active — calls should be ~1 at this point, not 3
  assert.ok(calls <= 2, `expected <= 2 calls, got ${calls}`);
  c.shutdown();
});

test('cancel stops an in-flight schedule from rearming', async () => {
  const c = new JsEvalCacheImpl();
  let calls = 0;
  c.schedule({
    platform: 'p',
    bindsTo: 't',
    intervalMs: 30,
    jitterMs: 0,
    refresh: async () => {
      calls += 1;
      return `v${calls}`;
    },
  });
  await waitMs(50);
  const before = calls;
  c.cancel('p');
  await waitMs(80);
  assert.ok(calls <= before + 1, `expected refresh to stop rearming; calls went ${before} → ${calls}`);
});

test('refresh failure keeps the previous cached value', async () => {
  const c = new JsEvalCacheImpl();
  c.set('p', 't', 'old', null);
  // Silence the console.warn the cache logs on refresh failure so the test
  // output stays clean. node:test pipes stderr; we don't want a warning
  // line inside a test that is *asserting* the failure path.
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    c.schedule({
      platform: 'p',
      bindsTo: 't',
      intervalMs: 30,
      jitterMs: 0,
      refresh: async () => {
        throw new Error('boom');
      },
    });
    await waitMs(60);
    const entry = c.get('p', 't');
    assert.ok(entry);
    assert.strictEqual(entry.value, 'old');
  } finally {
    console.warn = origWarn;
    c.shutdown();
  }
});

test('shutdown clears all state', () => {
  const c = new JsEvalCacheImpl();
  c.set('p', 't', 'v', null);
  c.schedule({
    platform: 'p',
    bindsTo: 't2',
    intervalMs: 100_000,
    jitterMs: 0,
    refresh: async () => 'never-runs',
  });
  c.shutdown();
  assert.strictEqual(c.get('p', 't'), null);
  assert.strictEqual(c.get('p', 't2'), null);
});

test('jitter keeps the scheduled delay positive', async () => {
  const c = new JsEvalCacheImpl();
  // intervalMs 20 + jitterMs 100 makes the math want to sometimes go negative
  // (20 - 100). The scheduler should clamp to 1, not produce a hang.
  let calls = 0;
  c.schedule({
    platform: 'p',
    bindsTo: 't',
    intervalMs: 20,
    jitterMs: 100,
    refresh: async () => {
      calls += 1;
      return `v${calls}`;
    },
  });
  await waitMs(200);
  assert.ok(calls >= 1, 'refresh should run at least once even with large jitter');
  c.shutdown();
});
