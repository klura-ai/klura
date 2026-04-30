// Audit class — composable detector + classifier framework that absorbs
// the prior buildSaveAuditGate / runMinifiedOffsetGate / validateSaveWarningsAcked
// machinery. Tests cover: detector-only flows (Level 2 acked-warning),
// classifier-only flows (Level 3 token-gated), mixed flows, hash-scoping
// per classifier (no cascade-invalidation), and the rejection envelope shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Audit, rejectionToErrorMessage } = await import('../dist/audit/index.js');

// Test mocks satisfy the type-required Classifier fields with stub values.
// Production Classifiers carry real remedies + answer shapes (TS enforces);
// these mocks only exercise the framework, not the per-classifier semantics.
const NO_REMEDY = () => ({ kind: 'no_programmatic_remedy', reason: 'test mock' });
const TEST_SHAPE = '<test_kind>: <stub answer shape>';

// ---------- detectors only ----------

test('detector-only audit commits when no detector fires', () => {
  const audit = new Audit({
    kind: 'test',
    detectors: [
      { kind: 'flagger', detect: () => [], ackReason: 'required' },
    ],
    classifiers: [],
  });
  const r = audit.process({ x: 1 }, {}, {});
  assert.equal(r.status, 'committed');
});

test('detector emits issue → rejected with warning, no token', () => {
  const audit = new Audit({
    kind: 'test',
    detectors: [
      {
        kind: 'flagger',
        detect: () => [{ kind: 'flagger', message: 'flagged', hint: 'fix it' }],
        ackReason: 'required',
      },
    ],
    classifiers: [],
  });
  const r = audit.process({}, {}, {});
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejection.reason, 'unacked_warnings');
  assert.equal(r.rejection.token, undefined);
  assert.equal(r.rejection.warnings.length, 1);
  assert.equal(r.rejection.warnings[0].kind, 'flagger');
});

test('detector issue acked with reason → committed', () => {
  const audit = new Audit({
    kind: 'test',
    detectors: [
      { kind: 'flagger', detect: () => [{ kind: 'flagger', message: 'flagged' }], ackReason: 'required' },
    ],
    classifiers: [],
  });
  const r = audit.process({}, {}, { acks: { flagger: 'intentional override for X' } });
  assert.equal(r.status, 'committed');
});

test('detector ack with empty reason → ack_issue', () => {
  const audit = new Audit({
    kind: 'test',
    detectors: [
      { kind: 'flagger', detect: () => [{ kind: 'flagger', message: 'flagged' }], ackReason: 'required' },
    ],
    classifiers: [],
  });
  const r = audit.process({}, {}, { acks: { flagger: '' } });
  assert.equal(r.status, 'rejected');
  assert.match(r.rejection.ack_issues[0], /requires a non-empty reason/);
});

test('detector ack referencing unemitted kind → ack_issue', () => {
  const audit = new Audit({
    kind: 'test',
    detectors: [
      { kind: 'flagger', detect: () => [], ackReason: 'required' },
    ],
    classifiers: [],
  });
  const r = audit.process({}, {}, { acks: { typo: 'reason here' } });
  assert.equal(r.status, 'rejected');
  assert.match(r.rejection.ack_issues[0], /no detector emitted a warning with that kind/);
});

test('ackReason: "none" detector cannot be acked through', () => {
  // Detector with ackReason: 'none' is unconditional — agent must fix.
  const audit = new Audit({
    kind: 'test',
    detectors: [
      {
        kind: 'unfixable',
        detect: () => [{ kind: 'unfixable', message: 'must fix' }],
        ackReason: 'none',
      },
    ],
    classifiers: [],
  });
  const r = audit.process({}, {}, { acks: { unfixable: 'I really mean it' } });
  assert.equal(r.status, 'rejected');
});

// ---------- classifiers only ----------

test('classifier with no items → committed', () => {
  const audit = new Audit({
    kind: 'test',
    detectors: [],
    classifiers: [
      { kind: 'classify', buildItems: () => [], validate: () => [], remedy: NO_REMEDY, expectedAnswerShape: TEST_SHAPE },
    ],
  });
  const r = audit.process({}, {}, {});
  assert.equal(r.status, 'committed');
});

test('classifier with items → first call mints token + items', () => {
  const audit = new Audit({
    kind: 'test',
    detectors: [],
    classifiers: [
      {
        kind: 'classify',
        buildItems: () => ['itemA', 'itemB'],
        validate: () => [],
        remedy: NO_REMEDY,
        expectedAnswerShape: TEST_SHAPE,
      },
    ],
  });
  const r = audit.process({}, {}, {});
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejection.reason, 'pending');
  assert.ok(r.rejection.token);
  assert.deepEqual(r.rejection.items.classify, ['itemA', 'itemB']);
});

test('classifier with items → second call with valid answers commits', () => {
  const audit = new Audit({
    kind: 'test',
    detectors: [],
    classifiers: [
      {
        kind: 'classify',
        buildItems: () => ['itemA'],
        validate: (_p, _c, ans) => (ans === 'good' ? [] : ['answer is wrong']),
        remedy: NO_REMEDY,
        expectedAnswerShape: TEST_SHAPE,
      },
    ],
  });
  const first = audit.process({}, {}, {});
  const r = audit.process({}, {}, { token: first.rejection.token, answers: { classify: 'good' } });
  assert.equal(r.status, 'committed');
});

test('classifier validate returning issues → rejected with classifier_issues', () => {
  const audit = new Audit({
    kind: 'test',
    detectors: [],
    classifiers: [
      {
        kind: 'classify',
        buildItems: () => ['itemA'],
        validate: () => ['inconsistent'],
        remedy: NO_REMEDY,
        expectedAnswerShape: TEST_SHAPE,
      },
    ],
  });
  const first = audit.process({}, {}, {});
  const r = audit.process({}, {}, { token: first.rejection.token, answers: { classify: 'whatever' } });
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejection.reason, 'answers_inconsistent');
  assert.deepEqual(r.rejection.classifier_issues, ['inconsistent']);
});

// ---------- hash scoping ----------

test('hashFields scope: edits to UNRELATED fields don\'t invalidate token', () => {
  // Two classifiers, each scoped to a disjoint slice of the payload.
  // Editing field NOT in the active classifier's hash slice should keep
  // its token valid.
  const audit = new Audit({
    kind: 'test',
    detectors: [],
    classifiers: [
      {
        kind: 'firstClassifier',
        buildItems: () => ['only-active-when-firstField-present'],
        validate: () => [],
        hashFields: (p) => ({ first: p.firstField }),
        remedy: NO_REMEDY,
        expectedAnswerShape: TEST_SHAPE,
      },
    ],
  });
  const p1 = { firstField: 'A', unrelated: 'X' };
  const first = audit.process(p1, {}, {});
  const token = first.rejection.token;

  // Edit unrelated field. Token should still be valid.
  const p2 = { firstField: 'A', unrelated: 'Y' };
  const r = audit.process(p2, {}, {
    token,
    answers: { firstClassifier: 'ok' },
  });
  assert.equal(r.status, 'committed');
});

test('hashFields scope: edits to in-scope fields DO invalidate token', () => {
  const audit = new Audit({
    kind: 'test',
    detectors: [],
    classifiers: [
      {
        kind: 'classifier',
        buildItems: () => ['present'],
        validate: () => [],
        hashFields: (p) => ({ critical: p.critical }),
        remedy: NO_REMEDY,
        expectedAnswerShape: TEST_SHAPE,
      },
    ],
  });
  const p1 = { critical: 'A' };
  const first = audit.process(p1, {}, {});
  const token = first.rejection.token;

  const p2 = { critical: 'B' }; // changed in-scope field
  const r = audit.process(p2, {}, { token, answers: { classifier: 'ok' } });
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejection.reason, 'payload_changed');
});

// ---------- mixed flow ----------

test('Stage 1: detector fires + classifier active → Stage-1 rejection (no token, no items)', () => {
  // The audit runs detectors first. If any emit a non-acked blocking
  // issue, return a detector-only rejection — classifier work doesn't
  // run, no token is minted. The agent fixes shape on a token-free
  // rejection so body mutations don't invalidate anything.
  const audit = new Audit({
    kind: 'test',
    detectors: [
      { kind: 'detector', detect: () => [{ kind: 'detector', message: 'fired' }], ackReason: 'required' },
    ],
    classifiers: [
      {
        kind: 'classifier',
        buildItems: () => ['question'],
        validate: () => [],
        remedy: NO_REMEDY,
        expectedAnswerShape: TEST_SHAPE,
      },
    ],
  });
  const r = audit.process({}, {}, {});
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejection.reason, 'unacked_warnings');
  assert.equal(r.rejection.warnings.length, 1);
  assert.equal(r.rejection.token, undefined, 'Stage 1 must NOT mint a token');
  assert.equal(r.rejection.items, undefined, 'Stage 1 must NOT surface classifier items');
  assert.equal(r.rejection.classifier_remedies, undefined);
  assert.equal(r.rejection.classifier_answer_shapes, undefined);
});

test('Stage 1 → Stage 2: ack clears detectors, Stage 2 mints token + items', () => {
  // Three-call sequence:
  //   1. No ack, no answer → Stage 1 rejection (warning only).
  //   2. Ack supplied → Stage 2 first rejection (token minted, items
  //      surfaced for the active classifier).
  //   3. Ack + token + answer → committed.
  const audit = new Audit({
    kind: 'test',
    detectors: [
      { kind: 'detector', detect: () => [{ kind: 'detector', message: 'fired' }], ackReason: 'required' },
    ],
    classifiers: [
      {
        kind: 'classifier',
        buildItems: () => ['question'],
        validate: (_p, _c, ans) => (ans === 'good' ? [] : ['bad']),
        remedy: NO_REMEDY,
        expectedAnswerShape: TEST_SHAPE,
      },
    ],
  });

  const r1 = audit.process({}, {}, {});
  assert.equal(r1.status, 'rejected');
  assert.equal(r1.rejection.token, undefined);

  const r2 = audit.process({}, {}, { acks: { detector: 'intentional' } });
  assert.equal(r2.status, 'rejected');
  assert.equal(r2.rejection.reason, 'pending');
  assert.ok(r2.rejection.token, 'Stage 2 mints a token after Stage 1 clears');
  assert.deepEqual(r2.rejection.items.classifier, ['question']);

  const r3 = audit.process({}, {}, {
    token: r2.rejection.token,
    answers: { classifier: 'good' },
    acks: { detector: 'intentional' },
  });
  assert.equal(r3.status, 'committed');
});

test('Stage 1: ackReason "none" detector blocks even with ack supplied', () => {
  // ackReason: 'none' means there's no exception path. An ack referencing
  // such a detector is a no-op — Stage 1 still rejects. Classifier work
  // never runs.
  const audit = new Audit({
    kind: 'test',
    detectors: [
      { kind: 'hard', detect: () => [{ kind: 'hard', message: 'must fix' }], ackReason: 'none' },
    ],
    classifiers: [
      { kind: 'classifier', buildItems: () => ['q'], validate: () => [], remedy: NO_REMEDY, expectedAnswerShape: TEST_SHAPE },
    ],
  });
  const r = audit.process({}, {}, { acks: { hard: 'try to ack a hard detector' } });
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejection.token, undefined);
  assert.equal(r.rejection.items, undefined);
});

// ---------- rejection formatter ----------

test('rejectionToErrorMessage: Stage-1 rejection renders warnings + hint, no token line', () => {
  // Stage-1 rejection: warnings only, no token, no items.
  const audit = new Audit({
    kind: 'save_strategy',
    detectors: [
      { kind: 'flagger', detect: () => [{ kind: 'flagger', message: 'flagged thing', hint: 'do X' }], ackReason: 'required' },
    ],
    classifiers: [
      { kind: 'classify', buildItems: () => ['itemA'], validate: () => [], remedy: NO_REMEDY, expectedAnswerShape: TEST_SHAPE },
    ],
  });
  const r = audit.process({}, {}, {});
  const msg = rejectionToErrorMessage('save_strategy', r.rejection);
  assert.match(msg, /invalid_strategy: save_strategy/);
  assert.match(msg, /flagger.*flagged thing/);
  assert.match(msg, /hint: do X/);
  assert.match(msg, /klura:\/\/reference#save-strategy-audit/);
});

test('rejectionToErrorMessage: Stage-2 rejection renders audit_token + how_to_respond', () => {
  // Stage-2 rejection (after Stage 1 cleared via ack): token minted,
  // items surfaced, formatter renders the audit_token line.
  const audit = new Audit({
    kind: 'save_strategy',
    detectors: [
      { kind: 'flagger', detect: () => [{ kind: 'flagger', message: 'flagged', hint: 'do X' }], ackReason: 'required' },
    ],
    classifiers: [
      { kind: 'classify', buildItems: () => ['itemA'], validate: () => [], remedy: NO_REMEDY, expectedAnswerShape: TEST_SHAPE },
    ],
  });
  const r = audit.process({}, {}, { acks: { flagger: 'intentional' } });
  const msg = rejectionToErrorMessage('save_strategy', r.rejection);
  assert.match(msg, /invalid_strategy: save_strategy/);
  assert.match(msg, /audit_token:/);
  assert.match(msg, /classify/);
  assert.match(msg, /how_to_respond:/);
});
