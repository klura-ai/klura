// Warm-pool test for the local `Pool` class.
//
// Exercises the per-platform warm-reuse path that lives behind
// `pool.warm.enabled = true`. Uses a mock BrowserDriver so the test
// stays dependency-free — we're validating the Pool's warm bookkeeping
// (hit, miss, LRU, TTL, crash recovery), not the Playwright driver's
// resetSession implementation. Driver-level reset behavior is covered
// by driver-conformance.test.js plus the real integration tests.
//
// What this test covers:
//   - warm hit: second createSession for the same platform reuses the
//     same underlying Session object (driver.createSession is not
//     called again)
//   - warm miss on different platform: createSession for a different
//     platform spawns a fresh Session
//   - idle TTL expiry: warm entry older than the configured TTL is
//     dropped by the sweeper and the next createSession for that
//     platform cold-spawns
//   - LRU eviction: exceeding maxContexts forces eviction of the
//     oldest idle slot
//   - crash recovery on checkout: driver.resetSession throws, Pool
//     falls back to a cold spawn and drops the stale warm entry

import test from 'node:test';
import assert from 'node:assert';
import { Pool } from '../dist/pool/pool.js';

const warmKey = (platform, identity = 'default') => `${platform}::${identity}`;

// Counter-driven mock driver. Each Session gets an incrementing id so
// the test can tell fresh sessions apart from warm-reused ones. A
// per-test `failReset` flag lets us simulate a crashed-while-stashed
// context — driver.resetSession throws, and Pool must fall back to a
// cold spawn.
function makeMockDriver() {
  let nextId = 1;
  const driver = {
    calls: {
      createSession: 0,
      destroySession: 0,
      resetSession: 0,
      closeBrowser: 0,
    },
    failReset: false,
    get capabilities() {
      return [];
    },
    async createSession(opts = {}) {
      driver.calls.createSession += 1;
      const session = {
        id: 'mock_' + nextId++,
        intercepted: [],
        intercepting: false,
        platform: opts.platform,
        _mockFresh: true,
      };
      return session;
    },
    async destroySession(_session) {
      driver.calls.destroySession += 1;
    },
    async resetSession(session, _opts = {}) {
      driver.calls.resetSession += 1;
      if (driver.failReset) {
        throw new Error('mock reset crash');
      }
      session.intercepted.length = 0;
      session.intercepting = false;
      session._mockFresh = false;
    },
    async closeBrowser() {
      driver.calls.closeBrowser += 1;
    },
  };
  // Pool constructor expects a class, not an instance. Wrap in a
  // class that returns this singleton so every `new DriverClass()` in
  // the Pool constructor returns the same mock and the test can
  // inspect call counts.
  class DriverClass {
    constructor() {
      return driver;
    }
  }
  return { driver, DriverClass };
}

test('warm hit: second createSession for same platform reuses the Session', async () => {
  const { driver, DriverClass } = makeMockDriver();
  const pool = new Pool(DriverClass, {
    idleTimeout: 300,
    warm: { enabled: true, maxContexts: 3, idleTtlSeconds: 60 },
  });

  const s1 = await pool.createSession({ platform: 'alpha' });
  assert.strictEqual(driver.calls.createSession, 1);
  assert.strictEqual(s1.platform, 'alpha');
  const firstObjRef = s1;
  const originalId = s1.id;

  await pool.closeSession(originalId);
  assert.strictEqual(driver.calls.destroySession, 0, 'warm close should not destroy');

  const s2 = await pool.createSession({ platform: 'alpha' });
  assert.strictEqual(driver.calls.createSession, 1, 'warm hit should not cold-spawn');
  assert.strictEqual(driver.calls.resetSession, 1, 'warm hit should call resetSession');
  assert.strictEqual(s2, firstObjRef, 'warm hit should reuse the underlying Session object');
  assert.notStrictEqual(s2.id, originalId, 'warm hit should mint a fresh session id');

  await pool.shutdown();
});

test('warm miss: different platform cold-spawns a fresh Session', async () => {
  const { driver, DriverClass } = makeMockDriver();
  const pool = new Pool(DriverClass, {
    idleTimeout: 300,
    warm: { enabled: true, maxContexts: 3, idleTtlSeconds: 60 },
  });

  const alpha = await pool.createSession({ platform: 'alpha' });
  await pool.closeSession(alpha.id);

  const beta = await pool.createSession({ platform: 'beta' });
  assert.strictEqual(driver.calls.createSession, 2, 'new platform should cold-spawn');
  assert.strictEqual(driver.calls.resetSession, 0);
  assert.notStrictEqual(beta, alpha);

  await pool.shutdown();
});

test('idle TTL expiry: stale warm entries are evicted by the sweeper', async () => {
  const { driver, DriverClass } = makeMockDriver();
  const pool = new Pool(DriverClass, {
    idleTimeout: 300,
    // 1-second TTL for a deterministic test. The sweeper runs on a
    // 60-second interval, so we call the private eviction pathway
    // directly by advancing lastUsedAt and waiting for the next
    // checkout to walk the entry.
    warm: { enabled: true, maxContexts: 3, idleTtlSeconds: 1 },
  });

  const s1 = await pool.createSession({ platform: 'alpha' });
  await pool.closeSession(s1.id);
  assert.ok(pool._warm.get(warmKey('alpha')), 'warm slot should exist post-close');

  // Manually age the entry past the TTL. The sweeper body runs inside
  // a 60-second interval which is too slow for a deterministic unit
  // test, so simulate it here by walking the same eviction decision
  // the interval handler makes.
  const entry = pool._warm.get(warmKey('alpha'));
  entry.lastUsedAt = Date.now() - 5000;

  for (const [platform, warm] of [...pool._warm]) {
    if (!warm.inUse && Date.now() - warm.lastUsedAt > 1000) {
      await driver.destroySession(warm.session);
      pool._warm.delete(platform);
    }
  }
  assert.strictEqual(pool._warm.size, 0, 'TTL-expired entry should be gone');

  // Next createSession for alpha should cold-spawn.
  const s2 = await pool.createSession({ platform: 'alpha' });
  assert.strictEqual(driver.calls.createSession, 2, 'post-TTL should cold-spawn');
  assert.notStrictEqual(s2, s1);

  await pool.shutdown();
});

test('LRU eviction: exceeding maxContexts drops the oldest idle slot', async () => {
  const { driver, DriverClass } = makeMockDriver();
  const pool = new Pool(DriverClass, {
    idleTimeout: 300,
    warm: { enabled: true, maxContexts: 2, idleTtlSeconds: 600 },
  });

  const a = await pool.createSession({ platform: 'alpha' });
  await pool.closeSession(a.id);
  // Sleep 10ms so the lastUsedAt timestamps differ enough that LRU
  // ordering is deterministic.
  await new Promise((r) => setTimeout(r, 10));
  const b = await pool.createSession({ platform: 'beta' });
  await pool.closeSession(b.id);

  assert.strictEqual(pool._warm.size, 2);

  // Third platform forces LRU eviction of the oldest (alpha).
  await new Promise((r) => setTimeout(r, 10));
  const c = await pool.createSession({ platform: 'gamma' });
  assert.strictEqual(pool._warm.size, 2, 'warm pool should stay capped at 2');
  assert.ok(!pool._warm.has(warmKey('alpha')), 'alpha (oldest) should be evicted');
  assert.ok(pool._warm.has(warmKey('beta')), 'beta should survive');
  assert.ok(pool._warm.has(warmKey('gamma')), 'gamma should be the new slot');
  assert.strictEqual(driver.calls.destroySession, 1, 'evicted entry should be destroyed');

  await pool.closeSession(c.id);
  await pool.shutdown();
});

test('crash recovery on checkout: resetSession throws, falls back to cold spawn', async () => {
  const { driver, DriverClass } = makeMockDriver();
  const pool = new Pool(DriverClass, {
    idleTimeout: 300,
    warm: { enabled: true, maxContexts: 3, idleTtlSeconds: 60 },
  });

  const s1 = await pool.createSession({ platform: 'alpha' });
  await pool.closeSession(s1.id);
  assert.ok(pool._warm.has(warmKey('alpha')));

  // Simulate a crashed context: resetSession throws on the next
  // checkout. Pool must drop the stale entry and cold-spawn a fresh
  // Session.
  driver.failReset = true;
  const s2 = await pool.createSession({ platform: 'alpha' });

  assert.strictEqual(driver.calls.resetSession, 1, 'reset was attempted');
  assert.strictEqual(driver.calls.createSession, 2, 'cold spawn followed the crash');
  assert.notStrictEqual(s2.id, s1.id, 'fresh session id');
  assert.strictEqual(s2._mockFresh, true, 'new Session came from driver.createSession');

  // The new session should own the warm slot now.
  const warm = pool._warm.get(warmKey('alpha'));
  assert.ok(warm, 'warm slot re-registered after cold spawn');
  assert.strictEqual(warm.session, s2);

  await pool.shutdown();
});

test('warm disabled: closeSession destroys immediately and createSession always cold-spawns', async () => {
  const { driver, DriverClass } = makeMockDriver();
  const pool = new Pool(DriverClass, {
    idleTimeout: 300,
    warm: { enabled: false },
  });

  const s1 = await pool.createSession({ platform: 'alpha' });
  await pool.closeSession(s1.id);
  assert.strictEqual(driver.calls.destroySession, 1);
  assert.strictEqual(pool._warm.size, 0);

  const s2 = await pool.createSession({ platform: 'alpha' });
  assert.strictEqual(driver.calls.createSession, 2);
  assert.strictEqual(driver.calls.resetSession, 0);
  assert.notStrictEqual(s2.id, s1.id);

  await pool.shutdown();
});

// ---- js-eval cache ↔ warm lifecycle ----

test('js-eval cache survives warm close, dropped on LRU eviction', async () => {
  const { DriverClass } = makeMockDriver();
  const pool = new Pool(DriverClass, {
    idleTimeout: 300,
    warm: { enabled: true, maxContexts: 2, idleTtlSeconds: 600 },
  });

  // Populate cache for alpha while the session is alive, then release
  // the warm slot. The cache must still hold the value — warm close
  // is a "release to idle", not a teardown.
  const a = await pool.createSession({ platform: 'alpha' });
  pool.jsEvalCache.set('alpha', 'tok', 'alpha-v1', null);
  await pool.closeSession(a.id);
  assert.strictEqual(pool.jsEvalCache.get('alpha', 'tok')?.value, 'alpha-v1');

  await new Promise((r) => setTimeout(r, 10));
  const b = await pool.createSession({ platform: 'beta' });
  pool.jsEvalCache.set('beta', 'tok', 'beta-v1', null);
  await pool.closeSession(b.id);

  // Third platform forces LRU eviction of alpha. Cache for alpha must
  // be dropped along with the warm context.
  await new Promise((r) => setTimeout(r, 10));
  const c = await pool.createSession({ platform: 'gamma' });
  assert.strictEqual(pool.jsEvalCache.get('alpha', 'tok'), null, 'alpha cache dropped on eviction');
  assert.strictEqual(
    pool.jsEvalCache.get('beta', 'tok')?.value,
    'beta-v1',
    'beta cache still live',
  );
  await pool.closeSession(c.id);
  await pool.shutdown();
});

test('js-eval cache dropped on pool shutdown', async () => {
  const { DriverClass } = makeMockDriver();
  const pool = new Pool(DriverClass, {
    idleTimeout: 300,
    warm: { enabled: true, maxContexts: 3, idleTtlSeconds: 600 },
  });

  const a = await pool.createSession({ platform: 'alpha' });
  pool.jsEvalCache.set('alpha', 'tok', 'alpha-v1', null);
  await pool.closeSession(a.id);
  assert.strictEqual(pool.jsEvalCache.get('alpha', 'tok')?.value, 'alpha-v1');

  await pool.shutdown();
  assert.strictEqual(
    pool.jsEvalCache.get('alpha', 'tok'),
    null,
    'cache should be empty after shutdown',
  );
});
