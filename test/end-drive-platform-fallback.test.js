// Regression: end_drive must fall back to session.platform when the caller
// omits opts.platform, so an agent who forgets to re-pass the platform on
// end_drive doesn't get silently routed past the LIFT handoff into terminal
// close. The platform-dependent branches (triage handoff predicate, LIFT
// handoff, capability inference, storage-state save) all read from a single
// normalized binding now; this test pins the behavior that exposed the bug.
//
// Hornbach repro shape: start_session(platform: "hornbach", capability: ...)
// → drive UI → end_drive(session_id, audit_token, audit_answers) — note: no
// platform — used to return ok:true with no phase, terminating the session.
// With the fallback in place, the session correctly hands off to LIFT.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-edrive-platform-fallback-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const { endDrive } = await import('../dist/end-drive/orchestrator.js');
const { pool } = await import('../dist/runtime-state.js');

function fakeSessionShell({ sessionId, platform, capability }) {
  return {
    id: sessionId,
    graph: 'discover',
    platform,
    declaredCapabilities: capability
      ? [{ capability, args: {}, declared_at: Date.now() }]
      : [],
    savedCapabilities: [],
    performActionHistory: [],
    artifactAccumulator: undefined,
    endDriveAttempts: 0,
    domNavigations: [],
    domFormsObserved: [],
    intercepted: [],
  };
}

function patchPool(session) {
  const fakeDriver = {
    cleanupDebuggerState: async () => {},
    getInterceptedRequests: async () => [],
    getInterceptedWebSocketFrames: async () => [],
    getDebuggerPauseState: () => null,
    saveStorageState: async () => {},
  };
  const origGet = pool.getSession;
  const origDriver = pool.driverFor;
  const origClose = pool.endDrive;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  pool.driverFor = (id) => (id === session.id ? fakeDriver : origDriver.call(pool, id));
  pool.endDrive = async (id) => {
    if (id === session.id) return;
    return origClose.call(pool, id);
  };
  return () => {
    pool.getSession = origGet;
    pool.driverFor = origDriver;
    pool.endDrive = origClose;
  };
}

test('end_drive without opts.platform falls back to session.platform → LIFT handoff fires', async () => {
  const session = fakeSessionShell({
    sessionId: 'sess_fallback_1',
    platform: 'fallback-test',
    capability: 'get_product_per_store_stock',
  });
  const restore = patchPool(session);
  try {
    // Note: NO platform in opts — exact shape from the hornbach transcript.
    const result = await endDrive(session.id, {});

    // Pre-fix: result.ok=true, no phase field, session terminates. Post-fix:
    // the session still has an unresolved declared capability, so the
    // orchestrator must fire computeReverseEngineerHandoff. The handoff
    // shape carries phase:"lift" + unresolved_capabilities; assert both.
    assert.equal(
      result.phase,
      'lift',
      `expected phase:"lift" handoff, got ${JSON.stringify(result)}`,
    );
    assert.ok(
      Array.isArray(result.unresolved_capabilities) && result.unresolved_capabilities.length > 0,
      `expected unresolved_capabilities[], got ${JSON.stringify(result.unresolved_capabilities)}`,
    );
    assert.equal(
      result.unresolved_capabilities[0].capability,
      'get_product_per_store_stock',
    );
  } finally {
    restore();
  }
});

test('end_drive with explicit opts.platform still wins (override path preserved)', async () => {
  // Session is bound to platform A, but caller passes platform B. The
  // documented contract is "explicit opts.platform wins" — this test pins
  // the override semantics so the fallback fix doesn't accidentally remove
  // it. Both platforms have no saved strategies, so the LIFT handoff fires
  // regardless; what we assert is that the orchestrator didn't crash and
  // the response shape matches the override platform.
  const session = fakeSessionShell({
    sessionId: 'sess_override_1',
    platform: 'platform-a',
    capability: 'list_things',
  });
  const restore = patchPool(session);
  try {
    const result = await endDrive(session.id, { platform: 'platform-b' });
    assert.equal(result.phase, 'lift', `expected phase:"lift", got ${JSON.stringify(result)}`);
    // The handoff response carries `platform` reflecting the resolved
    // value; with explicit override it must match opts.platform, not
    // session.platform.
    assert.equal(result.platform, 'platform-b');
  } finally {
    restore();
  }
});

test('end_drive without platform on a no-platform session terminates cleanly (no false handoff)', async () => {
  // Defensive: when the session itself has no platform AND the caller
  // doesn't pass one, the fallback is `undefined` and the orchestrator
  // skips the LIFT handoff path entirely. End-drive returns the
  // bookkeeping success shape, not a phantom handoff.
  const session = fakeSessionShell({
    sessionId: 'sess_noplat_1',
    platform: undefined,
    capability: undefined,
  });
  const restore = patchPool(session);
  try {
    const result = await endDrive(session.id, {});
    assert.equal(result.ok, true, `expected ok:true, got ${JSON.stringify(result)}`);
    assert.equal(
      result.phase,
      undefined,
      'no LIFT handoff when neither caller nor session names a platform',
    );
  } finally {
    restore();
  }
});
