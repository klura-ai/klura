// End-drive audit: save_attempted_none_landed Detector coverage.
//
// The Detector guards one failure mode: the agent hammered save_strategy,
// nothing reached disk, and closing would silently leave the prior (often
// buggy) strategy in place for warm callers. Its predicate is therefore
// "did anything land", not "did save_strategy return ok" — for a verifiable
// tier the save path ends at review_strategy_candidate promoting an inactive
// candidate on a typed verdict, and that call holds no session handle, so
// the candidate write is what close-time can see.

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
    declaredCapabilityCount: 1,
    writeActions: [],
    heavyReCallCount: 0,
    jsEvalCallCount: 0,
    persistCallCount: 0,
    actionCallCount: 0,
    saveAttemptCount: 0,
    saveSuccessCount: 0,
    saveCandidateCount: 0,
    skipDeclarationGuard: false,
    rePersistenceThreshold: DISCOVER_THRESHOLD,
    triageWouldFire: false,
    observedNotLifted: [],
    graph: 'discover',
    observedCapabilityCount: 0,
    httpFailureCount: 0,
    unsavedHotXhrEndpoints: [],
    abandonedSaveAttemptsNotRetried: [],
    ...overrides,
  };
}

function fires(result) {
  if (result?.status !== 'rejected') return false;
  const warnings = result.rejection?.warnings ?? [];
  return warnings.some((w) => w.kind === 'save_attempted_none_landed');
}

test('attempts with nothing on disk → fires (the guard still works)', () => {
  __resetStore();
  const result = endDriveAudit.process(makePayload({ saveAttemptCount: 7 }), {}, {});
  assert.equal(fires(result), true);
});

test('attempts with an active save → does not fire', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ saveAttemptCount: 7, saveSuccessCount: 1 }),
    {},
    {},
  );
  assert.equal(fires(result), false);
});

// The regression this file exists for: a session that saved a candidate and
// promoted it via review_strategy_candidate reported saveSuccessCount 0,
// so the Detector blocked close on a session whose capability was already
// active on disk — and it is ackReason 'none', leaving abort or a forced
// teardown as the only exits.
test('attempts with an inactive candidate on disk → does not fire', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ saveAttemptCount: 7, saveSuccessCount: 0, saveCandidateCount: 1 }),
    {},
    {},
  );
  assert.equal(fires(result), false);
});

test('no save attempts at all → does not fire regardless of candidates', () => {
  __resetStore();
  const result = endDriveAudit.process(makePayload({ saveAttemptCount: 0 }), {}, {});
  assert.equal(fires(result), false);
});

test('third close attempt still releases the gate', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ saveAttemptCount: 7, endDriveAttempts: 2 }),
    {},
    {},
  );
  assert.equal(fires(result), false);
});
