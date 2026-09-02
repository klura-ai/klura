// Warm reuse = BrowserLease + fresh Session. The warm slot stashes only the
// driver-side browser-resource bundle; every checkout mints a brand-new
// Session object, so no logical field (phase bookkeeping, consent flags,
// action history, save records, byte counters) can survive from one klura
// session into the next. This file is the leak-regression net for that
// guarantee, plus the device-fingerprint gate on warm checkout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '../dist/pool/pool.js';

function makeMockDriver() {
  let nextId = 1;
  let nextLease = 1;
  const driver = {
    calls: { createSession: 0, destroySession: 0, resetSession: 0, destroyLease: 0 },
    leases: new Map(),
    get capabilities() {
      return [];
    },
    async createSession(opts = {}) {
      driver.calls.createSession += 1;
      return {
        id: 'mock_' + nextId++,
        intercepted: [],
        intercepting: false,
        platform: opts.platform,
        _guts: { contextId: nextId },
      };
    },
    detachLease(session) {
      if (!session._guts) return null;
      const leaseId = 'lease_' + nextLease++;
      driver.leases.set(leaseId, session._guts);
      session._guts = undefined;
      return { leaseId };
    },
    attachLease(session, lease) {
      const guts = driver.leases.get(lease.leaseId);
      if (!guts) throw new Error(`lease ${lease.leaseId} not held`);
      driver.leases.delete(lease.leaseId);
      session._guts = guts;
    },
    async destroyLease(lease) {
      driver.calls.destroyLease += 1;
      driver.leases.delete(lease.leaseId);
    },
    async destroySession() {
      driver.calls.destroySession += 1;
    },
    async resetSession(session) {
      driver.calls.resetSession += 1;
      session.intercepted.length = 0;
      session.intercepting = false;
    },
    async closeBrowser() {},
  };
  class DriverClass {
    constructor() {
      return driver;
    }
  }
  return { driver, DriverClass };
}

function mkPool(DriverClass) {
  return new Pool(DriverClass, {
    idleTimeout: 300,
    warm: { enabled: true, maxContexts: 3, idleTtlSeconds: 600 },
  });
}

// Logical Session fields that must NEVER survive a warm recycle. One entry
// per leak class from the field-by-field Session audit: phase machine,
// per-phase bookkeeping, consent flags, staged checkpoints, save records,
// capability declarations, capture-derived bookkeeping, close-attempt
// bookkeeping, RE accumulators.
const MUST_DIE_FIELDS = [
  'phase',
  'drive',
  'triage',
  'lift',
  'execute',
  'surfaceMap',
  'lastSurfaceUrl',
  'priorSurfaceHadMutation',
  'mapGateAcked',
  'sensitiveActionAcked',
  'pendingActionConsents',
  'pendingPostSaveValidation',
  'pendingAbort',
  'declaredCapabilities',
  'performActionHistory',
  'recentFailedSelectors',
  'domNavigations',
  'domFormsObserved',
  'savedCapabilities',
  'abandonedSaveAttempts',
  'saveAttemptCount',
  'extractedContentBytes',
  'staleStrategyCapabilities',
  'endDriveAttempts',
  'liftHandoffAt',
  'roundCountAtLastCloseAttempt',
  'artifactAccumulator',
  'getActionHistoryCallCount',
  'pinnedWsFrames',
  'wsIndexLog',
  'wsFramesCap',
  'accessibilitySnapshot',
  'visitedUrls',
  'device',
  'graph',
  'status',
];

test('leak regression: no logical field survives a warm recycle', async () => {
  const { driver, DriverClass } = makeMockDriver();
  const pool = mkPool(DriverClass);

  const s1 = await pool.createSession({ platform: 'alpha' });
  const s1StartedAt = s1.startedAt;

  // Poison every logical field the way a full discover session would.
  s1.graph = 'discover';
  s1.status = 'active';
  s1.phase = 'lift';
  s1.device = 'iphone-15';
  s1.drive = { enteredAt: 1, roundsSinceEntry: 9, budget: 0, softBlockEngaged: false };
  s1.triage = { enteredAt: 2, roundsSinceEntry: 4, budget: 10, softBlockEngaged: true };
  s1.lift = { handoffAt: 3, roundsSinceHandoff: 12, budget: 5, softBlockEngaged: true };
  s1.execute = { enteredAt: 4, roundsSinceEntry: 1, budget: 0, softBlockEngaged: false };
  s1.surfaceMap = new Map([['https://a.test/x', 'surface-1']]);
  s1.lastSurfaceUrl = 'https://a.test/x';
  s1.priorSurfaceHadMutation = true;
  s1.mapGateAcked = true;
  s1.sensitiveActionAcked = true;
  s1.pendingActionConsents = new Map([['abcd', { action: 'click', selector: 'button' }]]);
  s1.pendingAbort = {
    reason: 'x'.repeat(24),
    kind: 'user_stop',
    phase_at_abort: 'lift',
    captured_actions_count: 3,
  };
  s1.declaredCapabilities = [{ capability: 'send_message', args: { text: 'hi' }, declared_at: 5 }];
  s1.performActionHistory = [{ at: 6, action: 'click', selector: 'button' }];
  s1.recentFailedSelectors = [{ action: 'click', selector: '#gone', at: 7 }];
  s1.domNavigations = [{ at: 8, url: 'https://a.test/x', via: 'nav' }];
  s1.domFormsObserved = [
    { at: 9, url: 'https://a.test/x', action: '/post', method: 'POST', fields: [] },
  ];
  s1.savedCapabilities = [{ capability: 'send_message', at: 10, tier: 'fetch' }];
  s1.abandonedSaveAttempts = [{ capability: 'send_message', kind: 'declined', at: 11 }];
  s1.saveAttemptCount = 4;
  s1.extractedContentBytes = 123456;
  s1.staleStrategyCapabilities = new Set(['send_message']);
  s1.endDriveAttempts = 3;
  s1.liftHandoffAt = 12;
  s1.roundCountAtLastCloseAttempt = 40;
  s1.artifactAccumulator = { notes: {}, verifiedExpressions: {} };
  s1.getActionHistoryCallCount = 2;
  s1.pinnedWsFrames = new Map();
  s1.wsIndexLog = new Map();
  s1.wsFramesCap = 10000;
  s1.accessibilitySnapshot = { source: 'unavailable', at: 13 };
  s1.visitedUrls = ['https://a.test/x'];

  await pool.endDrive(s1.id);

  const s2 = await pool.createSession({ platform: 'alpha' });
  assert.equal(driver.calls.createSession, 1, 'warm reuse actually happened');
  assert.equal(driver.calls.resetSession, 1);
  assert.notEqual(s2, s1, 'fresh Session object');
  assert.notEqual(s2.id, s1.id);

  for (const field of MUST_DIE_FIELDS) {
    assert.equal(
      s2[field],
      undefined,
      `logical field '${field}' leaked across the warm recycle`,
    );
  }
  // Fresh capture plumbing and fresh provenance stamps.
  assert.deepEqual(s2.intercepted, []);
  assert.equal(s2.intercepting, false);
  assert.deepEqual(s2.wsFrames, []);
  assert.deepEqual(s2.subPages, []);
  assert.equal(s2.platform, 'alpha');
  assert.ok(typeof s2.origin === 'string', 'origin re-derived at checkout');
  assert.ok(
    typeof s2.startedAt === 'number' && s2.startedAt >= s1StartedAt,
    'startedAt re-stamped at checkout',
  );

  await pool.shutdown();
});

test('device-fingerprint mismatch: warm lease evicted, checkout cold-spawns', async () => {
  const { driver, DriverClass } = makeMockDriver();
  const pool = mkPool(DriverClass);

  const desktop = await pool.createSession({ platform: 'alpha' });
  await pool.endDrive(desktop.id);
  assert.ok(pool._warm.get('alpha::default').lease, 'desktop lease stashed');

  const mobile = await pool.createSession({
    platform: 'alpha',
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  assert.equal(driver.calls.destroyLease, 1, 'mismatched lease destroyed');
  assert.equal(driver.calls.createSession, 2, 'mobile request cold-spawned');
  assert.equal(driver.calls.resetSession, 0, 'no reset against the wrong-device context');

  // The slot now belongs to the mobile session; its fingerprint reflects
  // the new profile so a matching follow-up reuses it.
  const entry = pool._warm.get('alpha::default');
  assert.equal(entry.sessionId, mobile.id);
  assert.equal(JSON.parse(entry.deviceFingerprint).isMobile, true);

  await pool.endDrive(mobile.id);
  const mobileAgain = await pool.createSession({
    platform: 'alpha',
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  assert.equal(driver.calls.createSession, 2, 'matching fingerprint reuses warm lease');
  assert.equal(driver.calls.resetSession, 1);
  assert.equal(mobileAgain.isMobile, true, 'minted session carries the requested profile');

  await pool.shutdown();
});
