// End-drive audit: triage_acknowledgment coverage, both shapes.
//
// Sessions that would otherwise skip triage entirely (every declared
// capability already saved, no stale strategies) must be blocked from
// end_drive teardown until the agent either (a) submits a triage_plan
// (covered elsewhere), or (b) acknowledges that triage was considered.
//
// The gate fires at most once per session, which is the Level-2-vs-Level-3
// criterion in gates.md: there is no prior firing within the session to draw a
// canned answer from, so the tamper-evident reason field is the whole
// enforcement and the token round-trip buys nothing. `audit.triageAckAsDetector`
// selects the shape — default `true` (Detector, answered via `acks`), `false`
// (Classifier, answered via `audit_token` + `audit_answers`). Exactly one is
// live per call; these tests pin both plus the switch between them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-triage-ack-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { endDriveAudit, RE_CALL_THRESHOLD } = await import('../dist/audit/drive/end-drive.js');
const { __resetStore } = await import('../dist/gate/store.js');
const { AUDIT_KINDS } = await import('../dist/vocab/index.js');

const DISCOVER_THRESHOLD = { reCalls: RE_CALL_THRESHOLD, actions: 0 };

const ACK_KIND = AUDIT_KINDS.triageAcknowledgment;
const GOOD_REASON = 'all caps fetch-tier saved, captures showed no graduation candidate';

/** `loadConfig()` re-reads the file on every call, so the shape selected here
 *  applies to the next audit call. */
function useDetectorShape(enabled) {
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ audit: { triageAckAsDetector: enabled } }, null, 2),
  );
  __resetStore();
}

function makePayload(overrides = {}) {
  return {
    sessionId: 'sess-test',
    platform: 'p',
    endDriveAttempts: 0,
    declaredCapabilityCount: 1,
    writeActions: [],
    // Sidestep re_persistence by not having any RE calls.
    heavyReCallCount: 0,
    jsEvalCallCount: 0,
    persistCallCount: 0,
    actionCallCount: 0,
    saveAttemptCount: 0,
    saveSuccessCount: 1, // capability saved
    skipDeclarationGuard: false,
    rePersistenceThreshold: DISCOVER_THRESHOLD,
    triageWouldFire: false, // every cap is already saved → handoff would skip triage
    observedNotLifted: [],
    graph: 'discover',
    observedCapabilityCount: 0,
    httpFailureCount: 0,
    ...overrides,
  };
}

// ---------- Detector shape (default) ----------

test('detector: fires when triage would skip and a capability is declared', () => {
  useDetectorShape(true);
  const result = endDriveAudit.process(makePayload(), {}, {});
  assert.equal(result.status, 'rejected');
  const r = result.rejection;
  assert.equal(r.reason, 'unacked_warnings');
  assert.equal(r.token, undefined, 'a Level-2 warning must not mint a token');
  const warning = r.warnings.find((w) => w.kind === ACK_KIND);
  assert.ok(warning, `triage_acknowledgment warning missing from ${JSON.stringify(r.warnings)}`);
  assert.match(warning.message, /ALWAYS goes through triage/);
});

test('detector: the hint names the acks channel and says the reason IS the acknowledgment', () => {
  useDetectorShape(true);
  const result = endDriveAudit.process(makePayload(), {}, {});
  const warning = result.rejection.warnings.find((w) => w.kind === ACK_KIND);
  assert.match(warning.hint, /acks/);
  assert.match(warning.hint, new RegExp(ACK_KIND));
  assert.match(warning.hint, /reason IS the acknowledgment/i);
  // No separate flag to set — `acknowledged: true` is gone with the classifier.
  assert.doesNotMatch(warning.hint, /acknowledged/);
});

test('detector: prose does NOT promise submit_triage_plan as an alternative path', () => {
  // submit_triage_plan is admissibility-blocked from the drive phase, so an
  // "Either submit a triage_plan OR acknowledge" framing would be a lie: the
  // agent follows the hint, hits tool_not_admissible, falls back to the ack
  // and loses their work. The prose offers the ack path only, and explains
  // why submit_triage_plan isn't available from here.
  useDetectorShape(true);
  const result = endDriveAudit.process(makePayload(), {}, {});
  const message = result.rejection.warnings.find((w) => w.kind === ACK_KIND).message;
  assert.doesNotMatch(
    message,
    /Either submit a triage_plan/i,
    'message must not present submit_triage_plan as an alternative path',
  );
  assert.match(message, /admissible from drive only when work is still unresolved/);
});

test('detector: an ack with a non-trivial reason commits, with no token anywhere', () => {
  useDetectorShape(true);
  const result = endDriveAudit.process(makePayload(), {}, { acks: { [ACK_KIND]: GOOD_REASON } });
  assert.equal(result.status, 'committed', JSON.stringify(result.rejection ?? {}));
});

test('detector: a short reason is rejected', () => {
  useDetectorShape(true);
  const result = endDriveAudit.process(makePayload(), {}, { acks: { [ACK_KIND]: 'no' } });
  assert.equal(result.status, 'rejected');
  assert.match(JSON.stringify(result.rejection), /non-trivial string/);
});

test('detector: an empty reason is rejected', () => {
  useDetectorShape(true);
  const result = endDriveAudit.process(makePayload(), {}, { acks: { [ACK_KIND]: '   ' } });
  assert.equal(result.status, 'rejected');
});

test('detector: does NOT fire when triageWouldFire (the handoff covers it)', () => {
  useDetectorShape(true);
  assert.equal(
    endDriveAudit.process(makePayload({ triageWouldFire: true }), {}, {}).status,
    'committed',
  );
});

test('detector: does NOT fire when no capability was declared (exploration)', () => {
  useDetectorShape(true);
  assert.equal(
    endDriveAudit.process(makePayload({ declaredCapabilityCount: 0, saveSuccessCount: 0 }), {}, {})
      .status,
    'committed',
  );
});

test('detector: third end_drive attempt → the guard releases (force-tear-down)', () => {
  useDetectorShape(true);
  assert.equal(
    endDriveAudit.process(makePayload({ endDriveAttempts: 2 }), {}, {}).status,
    'committed',
  );
});

test('detector: unattended runs skip it — an agent-workflow obligation with no agent', () => {
  useDetectorShape(true);
  const { blocking, warnings } = endDriveAudit.runUnattended(makePayload(), {});
  assert.ok(!blocking.some((i) => i.kind === ACK_KIND));
  assert.ok(!warnings.some((i) => i.kind === ACK_KIND));
});

test('detector: the classifier stays silent — exactly one shape is live per call', () => {
  useDetectorShape(true);
  const result = endDriveAudit.process(makePayload(), {}, {});
  assert.equal(result.rejection.items, undefined, 'no classifier items in the Detector shape');
});

// ---------- Classifier shape (audit.triageAckAsDetector: false) ----------

test('classifier: fires with a token + items when the Detector shape is disabled', () => {
  useDetectorShape(false);
  const result = endDriveAudit.process(makePayload(), {}, {});
  assert.equal(result.status, 'rejected');
  const r = result.rejection;
  assert.equal(r.reason, 'pending');
  assert.ok(r.token);
  assert.ok(r.items?.[ACK_KIND]);
  assert.match(r.items[ACK_KIND].prompt, /ALWAYS goes through triage/);
  assert.ok(
    !r.warnings.some((w) => w.kind === ACK_KIND),
    'the Detector must stay silent when the Classifier owns the concern',
  );
});

test('classifier: prose directs the agent to the token round trip', () => {
  useDetectorShape(false);
  const result = endDriveAudit.process(makePayload(), {}, {});
  const prompt = result.rejection.items[ACK_KIND].prompt;
  assert.doesNotMatch(prompt, /Either submit a triage_plan/i);
  assert.match(prompt, /Echo the audit_token \+ acknowledge/);
});

test('classifier: remedy lists the ack as the only achievable choice', () => {
  useDetectorShape(false);
  const result = endDriveAudit.process(makePayload(), {}, {});
  const remedy = result.rejection.classifier_remedies?.[ACK_KIND];
  assert.ok(remedy, 'triage_acknowledgment remedy missing');
  assert.equal(remedy.kind, 'classification_options');
  assert.equal(remedy.options.length, 1, 'remedy must list exactly one achievable choice');
  assert.match(remedy.options[0].choice, /triage_acknowledgment.*acknowledged: true/);
  assert.match(
    remedy.options[0].rationale,
    /submit_triage_plan is admissibility-blocked|admissibility-blocked from drive/i,
  );
});

test('classifier: invalid answer (not an object) rejected with a shape hint', () => {
  useDetectorShape(false);
  const first = endDriveAudit.process(makePayload(), {}, {});
  const second = endDriveAudit.process(
    makePayload(),
    {},
    { token: first.rejection.token, answers: { [ACK_KIND]: 'just-a-string' } },
  );
  assert.equal(second.status, 'rejected');
  assert.match(JSON.stringify(second.rejection), /must be an object/);
});

test('classifier: acknowledged: false rejected', () => {
  useDetectorShape(false);
  const first = endDriveAudit.process(makePayload(), {}, {});
  const second = endDriveAudit.process(
    makePayload(),
    {},
    {
      token: first.rejection.token,
      answers: { [ACK_KIND]: { acknowledged: false, reason: 'long enough reason here' } },
    },
  );
  assert.equal(second.status, 'rejected');
  assert.match(JSON.stringify(second.rejection), /acknowledged must be `true`/);
});

test('classifier: short reason rejected', () => {
  useDetectorShape(false);
  const first = endDriveAudit.process(makePayload(), {}, {});
  const second = endDriveAudit.process(
    makePayload(),
    {},
    {
      token: first.rejection.token,
      answers: { [ACK_KIND]: { acknowledged: true, reason: 'no' } },
    },
  );
  assert.equal(second.status, 'rejected');
  assert.match(JSON.stringify(second.rejection), /non-trivial string/);
});

test('classifier: valid token + ack + non-trivial reason → committed', () => {
  useDetectorShape(false);
  const first = endDriveAudit.process(makePayload(), {}, {});
  const second = endDriveAudit.process(
    makePayload(),
    {},
    {
      token: first.rejection.token,
      answers: { [ACK_KIND]: { acknowledged: true, reason: GOOD_REASON } },
    },
  );
  assert.equal(second.status, 'committed');
});

test('classifier: hashFields scope — an endDriveAttempts bump invalidates the token', () => {
  useDetectorShape(false);
  const first = endDriveAudit.process(makePayload(), {}, {});
  // The token binds {sessionId, declaredCapabilityCount, saveSuccessCount,
  // endDriveAttempts}, so a bump forces the agent to re-read.
  const second = endDriveAudit.process(
    makePayload({ endDriveAttempts: 1 }),
    {},
    {
      token: first.rejection.token,
      answers: {
        [ACK_KIND]: {
          acknowledged: true,
          reason: 'sufficient reason that meets the twenty-char minimum',
        },
      },
    },
  );
  assert.equal(second.status, 'rejected');
});
