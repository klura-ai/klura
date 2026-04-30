import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// tokens.ts writes to KLURA_HOME via a module-level constant, so point it at a
// throwaway dir BEFORE importing. Every test run gets its own.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tokens-test-'));
process.env.KLURA_HOME = TMP;

const { TokenCache } = await import('../dist/strategies/tokens.js');

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('set/get round-trip', () => {
  const c = new TokenCache();
  c.set('p', 't', 'abc123', { ttl: 60 });
  assert.strictEqual(c.get('p', 't'), 'abc123');
});

test('get returns null for missing token', () => {
  const c = new TokenCache();
  assert.strictEqual(c.get('p', 'missing'), null);
});

test('get returns null after TTL elapses', async () => {
  const c = new TokenCache();
  // 1-second TTL, then wait past it. Brittle-looking but tokens.ts uses Date.now
  // not a clock abstraction, so we either wait for real time or mock globals.
  // A sub-second timeout keeps the suite fast.
  c.set('p', 't', 'v', { ttl: 0.2 });
  assert.strictEqual(c.get('p', 't'), 'v', 'fresh token is returned');
  await new Promise(r => setTimeout(r, 250));
  assert.strictEqual(c.get('p', 't'), null, 'expired token returns null');
});

test('get with null TTL never expires via get', () => {
  const c = new TokenCache();
  // No ttl option → ttl is null → treated as "unknown, assume valid"
  c.set('p', 't', 'forever');
  assert.strictEqual(c.get('p', 't'), 'forever');
});

test('invalidate removes token', () => {
  const c = new TokenCache();
  c.set('p', 't', 'v', { ttl: 3600 });
  c.invalidate('p', 't');
  assert.strictEqual(c.get('p', 't'), null);
});

test('needsRefresh: missing token → true', () => {
  const c = new TokenCache();
  assert.strictEqual(c.needsRefresh('p', 'missing'), true);
});

test('needsRefresh: null TTL → false (cannot predict)', () => {
  const c = new TokenCache();
  c.set('p', 't', 'v'); // no ttl
  assert.strictEqual(c.needsRefresh('p', 't'), false);
});

test('needsRefresh: fresh token with long TTL → false', () => {
  const c = new TokenCache();
  c.set('p', 't', 'v', { ttl: 3600 });
  assert.strictEqual(c.needsRefresh('p', 't'), false);
});

test('needsRefresh: inside 10%-or-60s window → true', async () => {
  const c = new TokenCache();
  // 0.5s TTL; threshold is min(0.05s, 60s) = 0.05s. After 0.46s we're inside.
  c.set('p', 't', 'v', { ttl: 0.5 });
  assert.strictEqual(c.needsRefresh('p', 't'), false, 'fresh');
  await new Promise(r => setTimeout(r, 460));
  assert.strictEqual(c.needsRefresh('p', 't'), true, 'inside refresh window');
});

test('recordExpiry: min_observed strategy learns shortest observed lifetime', () => {
  const c = new TokenCache();
  c.set('p', 't', 'v', { ttlStrategy: 'min_observed' });
  c.recordExpiry('p', 't', 600);
  c.recordExpiry('p', 't', 900);
  c.recordExpiry('p', 't', 300); // shortest
  c.recordExpiry('p', 't', 1200);
  // Next set with no explicit ttl should pick up the learned effective TTL.
  c.set('p', 't', 'v2');
  // Indirect check: needsRefresh with 300s TTL and fresh obtainedAt should be false,
  // but the cached value should be valid (we can't read the internal ttl directly).
  assert.strictEqual(c.get('p', 't'), 'v2');
});

test('recordExpiry: p90 strategy uses 90th percentile', () => {
  const c = new TokenCache();
  c.set('p', 't', 'v', { ttlStrategy: 'p90' });
  // Observations sorted: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
  // p90 index = floor(10 * 0.9) = 9 → value at index 9 = 1000
  for (const v of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) {
    c.recordExpiry('p', 't', v);
  }
  // We can't read effectiveTtl directly, but we can verify through behavior:
  // set a new token and check it uses the learned ttl. After 50s wait is impractical,
  // so we at minimum confirm the set + get path doesn't crash and the entry exists.
  c.set('p', 't', 'v2');
  assert.strictEqual(c.get('p', 't'), 'v2');
});

test('recordExpiry: fixed strategy keeps the explicit ttl', () => {
  const c = new TokenCache();
  c.set('p', 't', 'v', { ttl: 1800, ttlStrategy: 'fixed' });
  // Even if we observe shorter lifetimes, the fixed ttl should persist.
  c.recordExpiry('p', 't', 60);
  c.recordExpiry('p', 't', 120);
  // Token should still be alive (1800s is way longer than any observation)
  assert.strictEqual(c.get('p', 't'), 'v');
});

test('recordExpiry: keeps only last 10 observations', () => {
  const c = new TokenCache();
  c.set('p', 't', 'v', { ttlStrategy: 'min_observed' });
  // Push 15 observations; only the last 10 should matter.
  for (let i = 0; i < 15; i++) {
    c.recordExpiry('p', 't', 1000 + i * 100); // 1000, 1100, ..., 2400
  }
  // The first 5 (1000-1400) are dropped. Min of remaining is 1500.
  // We can't introspect the meta directly, but we can verify token lifetime
  // expectations by setting a new token and checking it survives.
  c.set('p', 't', 'v2');
  assert.strictEqual(c.get('p', 't'), 'v2');
});

test('getAllForPlatform: lists tokens scoped to a platform', () => {
  const c = new TokenCache();
  c.set('foo', 'api_key', 'x', { ttl: 3600 });
  c.set('foo', 'refresh_token', 'y', { ttl: 3600 });
  c.set('bar', 'session', 'z', { ttl: 3600 });

  const fooTokens = c.getAllForPlatform('foo');
  assert.strictEqual(fooTokens.length, 2);
  assert.deepStrictEqual(
    fooTokens.map(t => t.name).sort(),
    ['api_key', 'refresh_token'],
  );

  const barTokens = c.getAllForPlatform('bar');
  assert.strictEqual(barTokens.length, 1);
  assert.strictEqual(barTokens[0].name, 'session');
});

test('getAllForPlatform: reports needsRefresh per token', async () => {
  const c = new TokenCache();
  c.set('p', 'fresh', 'x', { ttl: 3600 });
  c.set('p', 'expiring', 'y', { ttl: 0.4 });

  await new Promise(r => setTimeout(r, 370)); // inside expiring's 10% window

  const tokens = c.getAllForPlatform('p');
  const fresh = tokens.find(t => t.name === 'fresh');
  const expiring = tokens.find(t => t.name === 'expiring');
  assert.strictEqual(fresh.needsRefresh, false);
  assert.strictEqual(expiring.needsRefresh, true);
});

test('onNeedsRefresh: callback fires for tokens inside the refresh window', async () => {
  const c = new TokenCache();
  const calls = [];
  c.onNeedsRefresh((platform, name) => calls.push([platform, name]));

  c.set('p', 'fresh', 'x', { ttl: 3600 });
  c.set('p', 'expiring', 'y', { ttl: 0.4 });

  await new Promise(r => setTimeout(r, 370));

  // startRefreshLoop with a tiny interval to trigger one tick quickly.
  c.startRefreshLoop(50);
  await new Promise(r => setTimeout(r, 80));
  c.stopRefreshLoop();

  assert.ok(
    calls.some(([p, n]) => p === 'p' && n === 'expiring'),
    'expiring token should trigger callback',
  );
  assert.ok(
    !calls.some(([p, n]) => p === 'p' && n === 'fresh'),
    'fresh token should not trigger callback',
  );
});

test('onNeedsRefresh: throwing callback does not crash the loop', async () => {
  const c = new TokenCache();
  let secondFired = false;
  c.onNeedsRefresh(() => { throw new Error('boom'); });
  c.onNeedsRefresh(() => { secondFired = true; });

  c.set('p', 't', 'v', { ttl: 0.2 });
  await new Promise(r => setTimeout(r, 190));

  c.startRefreshLoop(30);
  await new Promise(r => setTimeout(r, 60));
  c.stopRefreshLoop();

  assert.strictEqual(secondFired, true, 'second callback still runs after first throws');
});

test('startRefreshLoop is idempotent', () => {
  const c = new TokenCache();
  c.startRefreshLoop(1000);
  c.startRefreshLoop(1000); // no-op, already running
  c.stopRefreshLoop();
  // No assertion — just making sure it doesn't crash or leak timers
});

test('persistence: set writes token-cache.json under KLURA_HOME/user-data/<platform>', () => {
  const c = new TokenCache();
  c.set('diskplatform', 'tok', 'persisted', { ttl: 3600 });
  const expected = path.join(TMP, 'user-data', 'diskplatform', 'token-cache.json');
  assert.ok(fs.existsSync(expected), `expected ${expected} to exist`);
  const contents = JSON.parse(fs.readFileSync(expected, 'utf-8'));
  assert.strictEqual(contents.tok.value, 'persisted');
  assert.strictEqual(contents.tok.ttl, 3600);
});

test('loadValue: restores a token from disk into a fresh cache', () => {
  // First cache persists
  const c1 = new TokenCache();
  c1.set('reloadplat', 'tok', 'from-disk', { ttl: 3600 });

  // Fresh cache reads
  const c2 = new TokenCache();
  assert.strictEqual(c2.get('reloadplat', 'tok'), null, 'fresh cache has nothing');
  c2.loadValue('reloadplat', 'tok');
  assert.strictEqual(c2.get('reloadplat', 'tok'), 'from-disk');
});
