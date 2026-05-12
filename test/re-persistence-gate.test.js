// Close-session audit: re_persistence Detector coverage.
//
// Sessions that did heavy reverse-engineering work without persisting any
// findings — and have no saved strategy that reflects it — must be blocked
// from end_drive until they either persist (state-fix) or call abort_session
// (orchestrator-side bypass — not exercised here). klura is
// always-save-by-default; there is NO agent-authored ack escape. `js_eval`
// alone never trips the gate. Tests exercise endDriveAudit.process() directly
// — pure pump, no driver.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { endDriveAudit, RE_CALL_THRESHOLD, ACTION_CALL_THRESHOLD } = await import(
  '../dist/audit/drive/end-drive.js'
);
const { __resetStore } = await import('../dist/gate/store.js');

const DISCOVER_THRESHOLD = { reCalls: RE_CALL_THRESHOLD, actions: 0 };
const MAP_THRESHOLD = { reCalls: RE_CALL_THRESHOLD, actions: ACTION_CALL_THRESHOLD };

function makePayload(overrides = {}) {
  return {
    sessionId: 'sess-test',
    platform: 'p',
    endDriveAttempts: 0,
    declaredCapabilityCount: 1, // sidestep declaration detector
    writeActions: [],
    heavyReCallCount: RE_CALL_THRESHOLD + 1,
    jsEvalCallCount: 0,
    persistCallCount: 0,
    actionCallCount: 0,
    saveAttemptCount: 0,
    saveSuccessCount: 0,
    skipDeclarationGuard: false,
    rePersistenceThreshold: DISCOVER_THRESHOLD,
    triageWouldFire: true, // some declared capability still unresolved
    ...overrides,
  };
}

test('heavy RE without persist → first close rejects with re_persistence warning', () => {
  __resetStore();
  const result = endDriveAudit.process(makePayload(), {}, {});
  assert.equal(result.status, 'rejected');
  const r = result.rejection;
  const w = (r.warnings || []).find((x) => x.kind === 're_persistence');
  assert.ok(w, `expected re_persistence warning, got ${JSON.stringify(r)}`);
  assert.match(w.message, /CANNOT CLOSE/);
  assert.match(w.message, /code-inspection \/ breakpoint call/);
  assert.match(w.message, /zero persistence calls/);
  assert.match(w.hint, /abort_session/);
});

test('heavy RE + js_eval → rejection message names both', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ heavyReCallCount: RE_CALL_THRESHOLD, jsEvalCallCount: 6 }),
    {},
    {},
  );
  assert.equal(result.status, 'rejected');
  const w = (result.rejection.warnings || []).find((x) => x.kind === 're_persistence');
  assert.ok(w);
  assert.match(w.message, /code-inspection \/ breakpoint calls? \(plus 6 js_eval calls\)/);
  assert.equal(w.context.heavy_re_call_count, RE_CALL_THRESHOLD);
  assert.equal(w.context.js_eval_call_count, 6);
  assert.equal(w.context.re_call_count, RE_CALL_THRESHOLD + 6);
});

test('js_eval-only session (no heavy RE) → audit commits — js_eval is not an RE signal alone', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ heavyReCallCount: 0, jsEvalCallCount: 10, persistCallCount: 0 }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('js_eval-only, nothing declared, nothing saved (mundane lookup) → audit commits', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      heavyReCallCount: 0,
      jsEvalCallCount: 8,
      declaredCapabilityCount: 0,
      writeActions: [],
      actionCallCount: 2,
      saveAttemptCount: 0,
    }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('all declared capabilities resolved (triageWouldFire false) → re_persistence skips even with heavy RE', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      heavyReCallCount: 5,
      jsEvalCallCount: 3,
      persistCallCount: 0,
      declaredCapabilityCount: 1,
      triageWouldFire: false,
    }),
    {},
    {},
  );
  // The all-saved case fires triage_acknowledgment instead; the only thing
  // asserted here is that re_persistence does NOT fire — the RE work is baked
  // into the saved strategies on disk.
  const reW = (result.rejection?.warnings || []).find((x) => x.kind === 're_persistence');
  assert.equal(reW, undefined, 're_persistence must not fire when every declared capability resolved');
});

test('heavy RE, no persist, exploration bail (no declared capability) → rejects', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      heavyReCallCount: RE_CALL_THRESHOLD,
      jsEvalCallCount: 0,
      declaredCapabilityCount: 0,
      writeActions: [],
      actionCallCount: 0, // suppress declaration_required
      saveAttemptCount: 0,
    }),
    {},
    {},
  );
  assert.equal(result.status, 'rejected');
  const w = (result.rejection.warnings || []).find((x) => x.kind === 're_persistence');
  assert.ok(w, 'a session that poked the bundle and bailed still owes a breadcrumb');
});

test('heavy-RE-then-persist → audit commits without detector firing', () => {
  __resetStore();
  const result = endDriveAudit.process(makePayload({ persistCallCount: 1 }), {}, {});
  assert.equal(result.status, 'committed');
});

test('heavy RE below threshold → audit commits without detector firing', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({ heavyReCallCount: RE_CALL_THRESHOLD - 1 }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('re_persistence is a Detector — ackReason "none", no audit_answers escape', () => {
  // Even passing audit_answers shaped like the old Classifier path
  // {acknowledge_no_progress: true} doesn't unblock the gate. State-fix
  // (persistCallCount > 0) or abort_session are the only ways out.
  __resetStore();
  const payload = makePayload();
  const first = endDriveAudit.process(payload, {}, {});
  assert.equal(first.status, 'rejected');
  const second = endDriveAudit.process(
    payload,
    {},
    {
      token: first.rejection.token,
      answers: { re_persistence: { acknowledge_no_progress: true } },
    },
  );
  assert.equal(
    second.status,
    'rejected',
    'detector must still fire — no agent-authored ack escape',
  );
  const w = (second.rejection.warnings || []).find((x) => x.kind === 're_persistence');
  assert.ok(w, 're_persistence detector should still emit a warning on retry');
});

// --- Map-graph action-call threshold ---

test('map graph: actionCallCount above threshold + zero persist → fires (regardless of RE calls)', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      rePersistenceThreshold: MAP_THRESHOLD,
      heavyReCallCount: 0,
      jsEvalCallCount: 0,
      actionCallCount: ACTION_CALL_THRESHOLD,
      declaredCapabilityCount: 0, // map sessions don't declare capabilities
    }),
    {},
    {},
  );
  assert.equal(result.status, 'rejected');
  const w = (result.rejection.warnings || []).find((x) => x.kind === 're_persistence');
  assert.ok(w);
  assert.match(w.message, /perform_action call/);
});

test('map graph: below action threshold and below RE threshold → no fire', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      rePersistenceThreshold: MAP_THRESHOLD,
      heavyReCallCount: 0,
      jsEvalCallCount: 0,
      actionCallCount: ACTION_CALL_THRESHOLD - 1,
      declaredCapabilityCount: 0,
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
      actionCallCount: 1,
      heavyReCallCount: 0, // suppress re_persistence
      jsEvalCallCount: 0,
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
    heavyReCallCount: 0,
    jsEvalCallCount: 0,
  });
  const result = endDriveAudit.process(payload, {}, {
    acks: { capability_declaration_required: 'I have my reasons' },
  });
  assert.equal(result.status, 'rejected');
});

test('declaration_required: endDriveAttempts >= 2 → guard releases (force-tear-down attempt)', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      declaredCapabilityCount: 0,
      writeActions: [{ action: 'type' }],
      heavyReCallCount: 0,
      jsEvalCallCount: 0,
      endDriveAttempts: 2,
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
      heavyReCallCount: 0,
      jsEvalCallCount: 0,
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
      heavyReCallCount: 0,
      jsEvalCallCount: 0,
    }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('declaration_required: exploration session (clicks, no writes, no saves) → guard skips', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      declaredCapabilityCount: 0,
      writeActions: [],
      actionCallCount: 1,
      saveAttemptCount: 0,
      heavyReCallCount: 0,
      jsEvalCallCount: 0,
    }),
    {},
    {},
  );
  assert.equal(result.status, 'committed');
});

test('declaration_required: exploration with save attempt → guard fires (commitment signal)', () => {
  __resetStore();
  const result = endDriveAudit.process(
    makePayload({
      declaredCapabilityCount: 0,
      writeActions: [],
      actionCallCount: 1,
      saveAttemptCount: 1,
      heavyReCallCount: 0,
      jsEvalCallCount: 0,
    }),
    {},
    {},
  );
  assert.equal(result.status, 'rejected');
  const w = result.rejection.warnings.find(
    (x) => x.kind === 'capability_declaration_required',
  );
  assert.ok(w);
});
