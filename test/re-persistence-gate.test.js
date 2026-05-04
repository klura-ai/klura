// Close-session audit: re_persistence Classifier coverage.
//
// Sessions that made RE tool calls without persisting any findings must be
// blocked from end_drive until they either persist or echo the audit
// token + answers.re_persistence.acknowledge_no_progress = true. Tests
// exercise endDriveAudit.process() directly — pure pump, no driver.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { endDriveAudit, RE_CALL_THRESHOLD, ACTION_CALL_THRESHOLD } = await import(
  '../dist/audit/end-drive.js'
);
const { __resetStore } = await import('../dist/gate/store.js');

// Discover-graph default: re_persistence threshold of {reCalls: RE_CALL_THRESHOLD,
// actions: 0}. Map-graph fixture: {reCalls: RE_CALL_THRESHOLD, actions:
// ACTION_CALL_THRESHOLD}. Tests pick whichever fits the assertion.
const DISCOVER_THRESHOLD = { reCalls: RE_CALL_THRESHOLD, actions: 0 };
const MAP_THRESHOLD = { reCalls: RE_CALL_THRESHOLD, actions: ACTION_CALL_THRESHOLD };

function makePayload(overrides = {}) {
  return {
    sessionId: 'sess-test',
    platform: 'p',
    liftMode: undefined,
    endDriveAttempts: 0,
    declaredCapabilityCount: 1, // sidestep declaration detector
    writeActions: [],
    reCallCount: RE_CALL_THRESHOLD + 1,
    persistCallCount: 0,
    actionCallCount: 0,
    // Sidestep the save_attempted_none_landed detector unless a test
    // explicitly opts in via overrides — these tests target the
    // re_persistence Classifier, not the save-attempt detector.
    saveAttemptCount: 0,
    saveSuccessCount: 0,
    skipDeclarationGuard: false,
    rePersistenceThreshold: DISCOVER_THRESHOLD,
    // Sidestep the triage_acknowledgment classifier — these tests target
    // re_persistence specifically. Setting triageWouldFire: true tells the
    // audit "the triage handoff will fire after this audit passes," which
    // is the condition under which triage_acknowledgment doesn't gate.
    triageWouldFire: true,
    ...overrides,
  };
}

test('RE-without-persist → first close rejects with token + items', () => {
  __resetStore();
  const result = endDriveAudit.process(makePayload(), {}, {});
  assert.equal(result.status, 'rejected');
  const r = result.rejection;
  assert.equal(r.reason, 'pending');
  assert.ok(r.token);
  assert.ok(r.items?.re_persistence);
  const items = r.items.re_persistence;
  assert.equal(items.re_call_count, RE_CALL_THRESHOLD + 1);
  assert.equal(items.persist_call_count, 0);
  assert.match(items.prompt, /zero persistence calls/);
});

test('RE-then-persist → audit commits without classifier firing', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ persistCallCount: 1 }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('RE-below-threshold → audit commits without classifier firing', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ reCallCount: RE_CALL_THRESHOLD - 1 }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('valid token + acknowledge_no_progress: true → committed', () => {
  __resetStore();
  const payload = makePayload();
  const first = endDriveAudit.process(payload, {}, {});
  const second = endDriveAudit.process(payload, {}, {
    token: first.rejection.token,
    answers: { re_persistence: { acknowledge_no_progress: true } },
  });
  assert.equal(second.status, 'committed');
});

test('wrong token → re-mints fresh token', () => {
  __resetStore();
  endDriveAudit.process(makePayload(), {}, {});
  const result = endDriveAudit.process(makePayload(), {}, {
    token: 'NOT_A_REAL_TOKEN',
    answers: { re_persistence: { acknowledge_no_progress: true } },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'token_unknown_or_expired');
  assert.ok(result.rejection.token);
});

test('valid token but answer missing acknowledge_no_progress → answers_inconsistent', () => {
  __resetStore();
  const payload = makePayload();
  const first = endDriveAudit.process(payload, {}, {});
  const second = endDriveAudit.process(payload, {}, {
    token: first.rejection.token,
    answers: { re_persistence: {} },
  });
  assert.equal(second.status, 'rejected');
  assert.equal(second.rejection.reason, 'answers_inconsistent');
  const issues = second.rejection.classifier_issues || [];
  assert.ok(issues.some((s) => /acknowledge_no_progress/.test(s)));
});

test('hashFields scoping: endDriveAttempts bump does NOT invalidate re_persistence token', () => {
  __resetStore();
  const payload = makePayload();
  const first = endDriveAudit.process(payload, {}, {});
  const second = endDriveAudit.process(
    { ...payload, endDriveAttempts: 1 },
    {},
    {
      token: first.rejection.token,
      answers: { re_persistence: { acknowledge_no_progress: true } },
    },
  );
  assert.equal(
    second.status,
    'committed',
    `expected committed (re/persist counts unchanged); got ${JSON.stringify(second.rejection)}`,
  );
});

test('hashFields scoping: a fresh RE call DOES invalidate the token', () => {
  __resetStore();
  const payload = makePayload();
  const first = endDriveAudit.process(payload, {}, {});
  const second = endDriveAudit.process(
    { ...payload, reCallCount: payload.reCallCount + 1 },
    {},
    {
      token: first.rejection.token,
      answers: { re_persistence: { acknowledge_no_progress: true } },
    },
  );
  assert.equal(second.status, 'rejected');
  assert.equal(second.rejection.reason, 'payload_changed');
});

// --- Map-graph action-call threshold ---

test('map graph: actionCallCount above threshold + zero persist → fires', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      rePersistenceThreshold: MAP_THRESHOLD,
      reCallCount: 0,
      actionCallCount: ACTION_CALL_THRESHOLD,
    }),
    {},
    {},
  );
  assert.equal(result.status, 'rejected');
  const items = result.rejection.items.re_persistence;
  assert.equal(items.action_call_count, ACTION_CALL_THRESHOLD);
  assert.match(items.prompt, /perform_actions/);
});

test('map graph: below action threshold and below RE threshold → no fire', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      rePersistenceThreshold: MAP_THRESHOLD,
      reCallCount: 0,
      actionCallCount: ACTION_CALL_THRESHOLD - 1,
    }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

// --- Detector: capability_declaration_required ---

test('declaration_required: write actions + no declared capability + attempt 0 → fires', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      declaredCapabilityCount: 0,
      writeActions: [{ action: 'type', value_preview: 'hello' }],
      // Mirror the writeActions count — the detector gates on
      // actionCallCount > 0 (any perform_action), not on writeActions
      // alone, since read-only navigations also deserve a save opportunity.
      actionCallCount: 1,
      reCallCount: 0, // suppress re_persistence
    }),
    {},
    {},
  );
  assert.equal(result.status, 'rejected');
  const w = result.rejection.warnings.find(
    (x) => x.kind === 'capability_declaration_required',
  );
  assert.ok(w);
  assert.match(w.message, /CANNOT CLOSE/);
});

test('declaration_required: ackReason "none" — no ack-through path', () => {
  __resetStore();
  const payload = makePayload({
    declaredCapabilityCount: 0,
    writeActions: [{ action: 'type', value_preview: 'hi' }],
    reCallCount: 0,
  });
  const result = endDriveAudit.process(payload, {}, {
    acks: { capability_declaration_required: 'I have my reasons' },
  });
  // Even with an ack, the detector blocks because ackReason: 'none'.
  assert.equal(result.status, 'rejected');
  const ackIssue = (result.rejection.ack_issues || []).find((s) =>
    /capability_declaration_required/.test(s),
  );
  // Either rejected due to unacked-warning shape, or the ack is recorded as
  // an issue. Both indicate the ack didn't unblock — the test asserts the
  // save did not commit.
  assert.ok(true, ackIssue ? `ack issue: ${ackIssue}` : 'rejected as expected');
});

test('declaration_required: endDriveAttempts >= 2 → guard releases (force-tear-down attempt)', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      declaredCapabilityCount: 0,
      writeActions: [{ action: 'type' }],
      reCallCount: 0,
      endDriveAttempts: 2,
    }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('declaration_required: liftMode "skip" → guard releases', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      declaredCapabilityCount: 0,
      writeActions: [{ action: 'type' }],
      reCallCount: 0,
      liftMode: 'skip',
    }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('declaration_required: skipDeclarationGuard set (e.g. map graph) → guard releases', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      declaredCapabilityCount: 0,
      writeActions: [{ action: 'type' }],
      reCallCount: 0,
      skipDeclarationGuard: true,
    }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('declaration_required: navigation/click without write actions → guard skips', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      declaredCapabilityCount: 0,
      writeActions: [],
      reCallCount: 0,
    }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});
