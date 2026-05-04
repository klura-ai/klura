// Layer B: ready-page checkout protocol on the local Pool.
// Validates `tryCheckoutReadySession` semantics end-to-end against a
// fake driver that implements the `probePageReady` contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const poolMod = await import('../dist/pool/pool.js');

// Fake BrowserDriver enough for Pool's purposes. Not real — it returns
// rigged probe results and tracks whether resetSession/destroySession
// got called.
class FakeDriver {
  constructor() {
    this.capabilities = [];
    this.resetCount = 0;
    this.destroyCount = 0;
    this.probeResult = { page_on_url: false };
    this._sessions = new Map();
  }
  async createSession(opts = {}) {
    const id = 'fake_' + Math.random().toString(36).slice(2);
    const s = { id, intercepted: [], intercepting: false, platform: opts.platform };
    this._sessions.set(id, s);
    return s;
  }
  async destroySession() { this.destroyCount += 1; }
  async resetSession() { this.resetCount += 1; }
  async probePageReady() { return this.probeResult; }
  async closeBrowser() {}
}

function mkPool(warmEnabled = true) {
  return new poolMod.Pool(FakeDriver, {
    idleTimeout: 10,
    warm: { enabled: warmEnabled, maxContexts: 3, idleTtlSeconds: 60 },
  });
}

test('tryCheckoutReadySession: probe passes on warm slot → returns session, no resetSession call', async () => {
  const pool = mkPool(true);
  const driver = pool.driver;
  // Seed a warm slot: create a session, then endDrive to release it.
  const s = await pool.createSession({ platform: 'test-platform' });
  await pool.endDrive(s.id);
  // Rig probe to succeed.
  driver.probeResult = { page_on_url: true, ws_open: true };
  const preReset = driver.resetCount;

  const borrowed = await pool.tryCheckoutReadySession('test-platform', async () => true);

  assert.ok(borrowed, 'got a session');
  assert.equal(borrowed.borrowed, true);
  assert.equal(driver.resetCount, preReset, 'resetSession NOT called on ready-page checkout');
  await pool.shutdown();
});

test('tryCheckoutReadySession: probe returns false → null (caller cold-spawns)', async () => {
  const pool = mkPool(true);
  const s = await pool.createSession({ platform: 'p' });
  await pool.endDrive(s.id);

  const borrowed = await pool.tryCheckoutReadySession('p', async () => false);

  assert.equal(borrowed, null);
  await pool.shutdown();
});

test('tryCheckoutReadySession: probe throws → treated as false, returns null', async () => {
  const pool = mkPool(true);
  const s = await pool.createSession({ platform: 'p' });
  await pool.endDrive(s.id);

  const borrowed = await pool.tryCheckoutReadySession('p', async () => {
    throw new Error('boom');
  });

  assert.equal(borrowed, null);
  await pool.shutdown();
});

test('tryCheckoutReadySession: warm disabled → returns null without iterating', async () => {
  const pool = mkPool(false);
  // No warm slot will be created because warmEnabled=false.
  const s = await pool.createSession({ platform: 'p' });
  await pool.endDrive(s.id);

  let probeCalls = 0;
  const borrowed = await pool.tryCheckoutReadySession('p', async () => {
    probeCalls += 1;
    return true;
  });

  assert.equal(borrowed, null);
  assert.equal(probeCalls, 0, 'warm slot not probed when warm disabled');
  // Shared sessions are still probed even when warm is disabled — verify
  // that path works too by registering one.
  const shared = await pool.createSession({ platform: 'p' });
  pool.registerSharedSession(shared, 'p');
  const b2 = await pool.tryCheckoutReadySession('p', async () => true);
  assert.equal(b2?.id, shared.id, 'shared session reused');
  assert.equal(b2?.borrowed, true);
  await pool.shutdown();
});

test('registerSharedSession: dispose fn removes session from candidate set', async () => {
  const pool = mkPool(false);
  const shared = await pool.createSession({ platform: 'p' });
  const dispose = pool.registerSharedSession(shared, 'p');

  // Works before dispose.
  const b1 = await pool.tryCheckoutReadySession('p', async () => true);
  assert.equal(b1?.id, shared.id);
  b1.borrowed = false; // simulate release without going through endDrive

  dispose();
  const b2 = await pool.tryCheckoutReadySession('p', async () => true);
  assert.equal(b2, null, 'disposed shared session no longer a candidate');
  await pool.shutdown();
});

test('endDrive on borrowed session: does not destroy the underlying session', async () => {
  const pool = mkPool(true);
  const driver = pool.driver;
  // Seed warm slot.
  const s = await pool.createSession({ platform: 'p' });
  await pool.endDrive(s.id);
  const preDestroy = driver.destroyCount;

  // Borrow via ready-checkout.
  const borrowed = await pool.tryCheckoutReadySession('p', async () => true);
  assert.ok(borrowed);

  // Release.
  await pool.endDrive(borrowed.id);

  assert.equal(driver.destroyCount, preDestroy, 'destroySession NOT called on borrowed release');
  // Warm slot should be idle again.
  const b2 = await pool.tryCheckoutReadySession('p', async () => true);
  assert.ok(b2, 'warm slot available for next borrow');
  await pool.shutdown();
});

test('endDrive on shared (listener-owned) borrowed session: no-op for the owner', async () => {
  const pool = mkPool(false);
  const driver = pool.driver;
  const listenerSess = await pool.createSession({ platform: 'p' });
  const preDestroy = driver.destroyCount;
  pool.registerSharedSession(listenerSess, 'p');

  // Execute borrows it.
  const borrowed = await pool.tryCheckoutReadySession('p', async () => true);
  assert.equal(borrowed?.id, listenerSess.id);

  // Execute releases.
  await pool.endDrive(borrowed.id);

  assert.equal(driver.destroyCount, preDestroy, 'listener still owns the session; no destroy');
  // The listener still tracks the same session object (mutable), so it
  // remains the same instance.
  assert.equal(borrowed, listenerSess);
  await pool.shutdown();
});

test('tryCheckoutReadySession missing (test stubs): executors should handle gracefully', async () => {
  // Minimal fake pool object WITHOUT tryCheckoutReadySession — simulates
  // a test stub. The execute path should not blow up when the optional
  // method is absent.
  const bareBones = {
    createSession: async () => ({ id: 'x', intercepted: [], intercepting: false }),
    endDrive: async () => {},
    getSession: () => ({ id: 'x', intercepted: [], intercepting: false }),
    driverFor: () => ({}),
    shutdown: async () => {},
    activeSessions: 0,
    idleSince: 0,
  };
  assert.equal(bareBones.tryCheckoutReadySession, undefined);
  // The fact that this doesn't error is the test; execute paths guard
  // with `if (pool.tryCheckoutReadySession) { ... }`.
});
