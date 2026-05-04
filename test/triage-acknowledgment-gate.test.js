// End-drive audit: triage_acknowledgment Classifier coverage.
//
// Sessions that would otherwise skip triage entirely (every declared
// capability already saved, no stale strategies) must be blocked from
// end_drive teardown until the agent either (a) submits a triage_plan
// (covered elsewhere), or (b) echoes the audit_token + answers.
// triage_acknowledgment.{acknowledged: true, reason: "<≥20 chars>"}.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { endDriveAudit, RE_CALL_THRESHOLD } = await import('../dist/audit/end-drive.js');
const { __resetStore } = await import('../dist/gate/store.js');

const DISCOVER_THRESHOLD = { reCalls: RE_CALL_THRESHOLD, actions: 0 };

function makePayload(overrides = {}) {
  return {
    sessionId: 'sess-test',
    platform: 'p',
    liftMode: undefined,
    endDriveAttempts: 0,
    declaredCapabilityCount: 1,
    writeActions: [],
    // Sidestep re_persistence by not having any RE calls.
    reCallCount: 0,
    persistCallCount: 0,
    actionCallCount: 0,
    saveAttemptCount: 0,
    saveSuccessCount: 1, // capability saved
    skipDeclarationGuard: false,
    rePersistenceThreshold: DISCOVER_THRESHOLD,
    triageWouldFire: false, // every cap is already saved → handoff would skip triage
    ...overrides,
  };
}

test('triage_acknowledgment: fires when triage would skip and capability declared', () => {
  __resetStore();
  const result = endDriveAudit.process(makePayload(), {}, {});
  assert.equal(result.status, 'rejected');
  const r = result.rejection;
  assert.equal(r.reason, 'pending');
  assert.ok(r.token);
  assert.ok(r.items?.triage_acknowledgment);
  assert.match(r.items.triage_acknowledgment.prompt, /ALWAYS goes through triage/);
});

test('triage_acknowledgment: does NOT fire when triageWouldFire (handoff covers it)', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ triageWouldFire: true }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('triage_acknowledgment: does NOT fire when liftMode === "skip" (caller opt-out)', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ liftMode: 'skip' }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('triage_acknowledgment: does NOT fire when no capability declared (exploration)', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ declaredCapabilityCount: 0, saveSuccessCount: 0 }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('triage_acknowledgment: third end_drive attempt → guard releases (force-tear-down)', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ endDriveAttempts: 2 }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('triage_acknowledgment: invalid answer (not object) rejected with shape hint', () => {
  __resetStore();
  const first = endDriveAudit.process(makePayload(), {}, {});
  assert.equal(first.status, 'rejected');
  const second = endDriveAudit.process(makePayload(), {}, {
    token: first.rejection.token,
    answers: { triage_acknowledgment: 'just-a-string' },
  });
  assert.equal(second.status, 'rejected');
  const r = second.rejection;
  assert.match(r.message ?? JSON.stringify(r), /must be an object/);
});

test('triage_acknowledgment: acknowledged: false rejected', () => {
  __resetStore();
  const first = endDriveAudit.process(makePayload(), {}, {});
  const second = endDriveAudit.process(makePayload(), {}, {
    token: first.rejection.token,
    answers: { triage_acknowledgment: { acknowledged: false, reason: 'long enough reason here' } },
  });
  assert.equal(second.status, 'rejected');
  assert.match(
    JSON.stringify(second.rejection),
    /acknowledged must be `true`/,
  );
});

test('triage_acknowledgment: short reason rejected', () => {
  __resetStore();
  const first = endDriveAudit.process(makePayload(), {}, {});
  const second = endDriveAudit.process(makePayload(), {}, {
    token: first.rejection.token,
    answers: { triage_acknowledgment: { acknowledged: true, reason: 'no' } },
  });
  assert.equal(second.status, 'rejected');
  assert.match(JSON.stringify(second.rejection), /non-trivial string/);
});

test('triage_acknowledgment: valid token + ack + non-trivial reason → committed', () => {
  __resetStore();
  const first = endDriveAudit.process(makePayload(), {}, {});
  const second = endDriveAudit.process(makePayload(), {}, {
    token: first.rejection.token,
    answers: {
      triage_acknowledgment: {
        acknowledged: true,
        reason: 'all caps fetch-tier saved, captures showed no graduation candidate',
      },
    },
  });
  assert.equal(second.status, 'committed');
});

test('triage_acknowledgment: hashFields scope — endDriveAttempts bump invalidates token', () => {
  __resetStore();
  const payload = makePayload();
  const first = endDriveAudit.process(payload, {}, {});
  // Second attempt with bumped count: token bound to {sessionId,
  // declaredCapabilityCount, saveSuccessCount, endDriveAttempts} so a bump
  // invalidates the prior token.
  const bumped = makePayload({ endDriveAttempts: 1 });
  const second = endDriveAudit.process(bumped, {}, {
    token: first.rejection.token,
    answers: {
      triage_acknowledgment: {
        acknowledged: true,
        reason: 'sufficient reason that meets the twenty-char minimum',
      },
    },
  });
  // Token should be rejected (payload changed) — agent must re-read.
  assert.equal(second.status, 'rejected');
});
