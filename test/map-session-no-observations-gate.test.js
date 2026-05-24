// End-drive audit: map_session_no_observations Detector coverage.
//
// Map-graph sessions that recorded zero observations + saved zero
// strategies + did zero write-shaped actions + captured at least one
// HTTP failure (4xx/5xx) are DOA — typically anti-bot wall at landing.
// Closing via end_drive silently leaves no signal on the platform's
// recent_aborts ledger. Detector refuses close and points the agent at
// abort_session(kind) for machine-actionable cross-session signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { endDriveAudit, RE_CALL_THRESHOLD } = await import('../dist/audit/drive/end-drive.js');
const { __resetStore } = await import('../dist/gate/store.js');

const DISCOVER_THRESHOLD = { reCalls: RE_CALL_THRESHOLD, actions: 0 };

function makePayload(overrides = {}) {
  return {
    sessionId: 'sess-test',
    platform: 'p',
    endDriveAttempts: 0,
    declaredCapabilityCount: 0,
    writeActions: [],
    heavyReCallCount: 0,
    jsEvalCallCount: 0,
    persistCallCount: 0,
    actionCallCount: 1, // navigated once
    saveAttemptCount: 0,
    saveSuccessCount: 0,
    skipDeclarationGuard: true, // map graph
    rePersistenceThreshold: DISCOVER_THRESHOLD,
    triageWouldFire: false,
    observedNotLifted: [],
    graph: 'map',
    observedCapabilityCount: 0,
    httpFailureCount: 1, // origin returned 403/blocked
    ...overrides,
  };
}

test('map_session_no_observations: fires on DOA map session with http failure', () => {
  __resetStore();
  const result = endDriveAudit.process(makePayload(), {}, {});
  assert.equal(result.status, 'rejected');
  const warning = (result.rejection.warnings ?? []).find(
    (w) => w.kind === 'map_session_no_observations',
  );
  assert.ok(warning, 'detector must emit on DOA map session');
  assert.match(warning.message, /CANNOT CLOSE/);
  assert.match(warning.hint, /abort_session/);
  assert.match(warning.hint, /origin_blocked/);
});

test('map_session_no_observations: does NOT fire on non-map graph', () => {
  __resetStore();
  const result = endDriveAudit.process(makePayload({ graph: 'discover' }), {}, {});
  if (result.status === 'rejected') {
    const kinds = (result.rejection.warnings ?? []).map((w) => w.kind);
    assert.ok(!kinds.includes('map_session_no_observations'));
  }
});

test('map_session_no_observations: does NOT fire when observations recorded', () => {
  __resetStore();
  const result = endDriveAudit.process(makePayload({ observedCapabilityCount: 1 }), {}, {});
  if (result.status === 'rejected') {
    const kinds = (result.rejection.warnings ?? []).map((w) => w.kind);
    assert.ok(!kinds.includes('map_session_no_observations'));
  }
});

test('map_session_no_observations: does NOT fire when no http failures captured', () => {
  __resetStore();
  // Map session that explored normally and just found nothing observable
  // — still worth aborting eventually, but not the DOA pattern this
  // detector targets.
  const result = endDriveAudit.process(makePayload({ httpFailureCount: 0 }), {}, {});
  if (result.status === 'rejected') {
    const kinds = (result.rejection.warnings ?? []).map((w) => w.kind);
    assert.ok(!kinds.includes('map_session_no_observations'));
  }
});

test('map_session_no_observations: third-attempt force-tear-down releases', () => {
  __resetStore();
  const result = endDriveAudit.process(makePayload({ endDriveAttempts: 2 }), {}, {});
  if (result.status === 'rejected') {
    const kinds = (result.rejection.warnings ?? []).map((w) => w.kind);
    assert.ok(!kinds.includes('map_session_no_observations'));
  }
});

// ---- abort_session kind discriminator ----

const { ABORT_KIND_VALUES } = await import('../dist/tools/abort_session.js');

test('abort_session: ABORT_KIND_VALUES enum is exported with the five canonical kinds', () => {
  assert.deepStrictEqual([...ABORT_KIND_VALUES].sort(), [
    'existing_capability_covers',
    'origin_blocked',
    'other',
    'site_dead',
    'user_stop',
  ]);
});
