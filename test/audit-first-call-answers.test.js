// Audit first-call answers — `Classifier.firstCallAnswerable` +
// `audit.firstCallAnswers`.
//
// A token-gated Classifier normally costs a round trip: call 1 mints a token
// and rejects `pending`, call 2 echoes the token with answers. When the answer
// classifies items the runtime derived from THIS call's payload, validate()
// cross-checks the answer against the very bytes it describes — there is no
// unbound-payload window for the token to close, so the round trip can be
// skipped. These tests pin the three modes:
//
//   'off'                      — shipped default. The flag is read and
//                                ignored; every shape behaves exactly as it
//                                did before the flag existed.
//   'safe_subset'              — only `firstCallAnswerable: true` classifiers.
//   'all_except_confirmation'  — everything that hasn't opted out with
//                                `firstCallAnswerable: false`.
//
// A call with NO answers always mints and rejects `pending`, whatever the
// mode — that is what keeps the bounce hazard away from the common case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-first-call-answers-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { Audit } = await import('../dist/audit/index.js');
// The token store is loaded through `createRequire` rather than `import` so
// `issueToken` can be swapped for a counting wrapper — an ESM namespace object
// is frozen, a CommonJS exports object is not. The audit calls it through the
// same exports object, so the wrapper observes every mint.
const store = createRequire(import.meta.url)('../dist/gate/store.js');
const { saveStrategyAudit } = await import('../dist/audit/lift/save-strategy.js');
const { registerSaveConfirmationDecider, unregisterSaveConfirmationDecider } = await import(
  '../dist/audit/lift/save-confirmation-decider.js'
);

/** Write `audit.<mode>` into the sandboxed config. `loadConfig()` re-reads the
 *  file on every call, so a mode set here applies to the next audit call. */
function setFirstCallAnswers(mode) {
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ audit: { firstCallAnswers: mode } }, null, 2),
  );
}

/** Count token mints across a block. The compiled audit calls
 *  `store.issueToken` through the module namespace, so replacing the export
 *  observes every mint the audit makes. */
function countingMints(fn) {
  const original = store.issueToken;
  let mints = 0;
  store.issueToken = (args) => {
    mints += 1;
    return original(args);
  };
  try {
    return { result: fn(), mints };
  } finally {
    store.issueToken = original;
  }
}

const NO_REMEDY = () => ({ kind: 'no_programmatic_remedy', reason: 'test fixture' });

/** A classifier whose single item is `payload.<field>` and whose answer must
 *  be the string `'ok'`. `answerable` maps straight onto
 *  `firstCallAnswerable` (pass `undefined` to leave it unassigned). */
function classifier(kind, field, answerable) {
  return {
    kind,
    ...(answerable === undefined ? {} : { firstCallAnswerable: answerable }),
    expectedAnswerShape: `${kind}: "ok"`,
    buildItems: (payload) => (payload[field] ? [payload[field]] : []),
    hashFields: (payload) => ({ [field]: payload[field] }),
    validate: (_payload, _ctx, answer) =>
      answer === 'ok' ? [] : [`${kind}: expected "ok", got ${JSON.stringify(answer)}`],
    remedy: NO_REMEDY,
  };
}

const auditWithAnswerables = new Audit({
  kind: 'first_call_test',
  detectors: [],
  classifiers: [classifier('alpha', 'a', true), classifier('beta', 'b', true)],
});

const auditWithDeferred = new Audit({
  kind: 'first_call_deferred_test',
  detectors: [],
  classifiers: [classifier('alpha', 'a', true), classifier('gamma', 'g', false)],
});

const auditWithUnassigned = new Audit({
  kind: 'first_call_unassigned_test',
  detectors: [],
  classifiers: [classifier('alpha', 'a', true), classifier('delta', 'd', undefined)],
});

const PAYLOAD = { a: 'A', b: 'B', g: 'G', d: 'D' };
const GOOD = { alpha: 'ok', beta: 'ok', gamma: 'ok', delta: 'ok' };
const BAD = { alpha: 'nope', beta: 'nope', gamma: 'nope', delta: 'nope' };
const MIXED = { alpha: 'ok', beta: 'nope', gamma: 'ok', delta: 'nope' };

/** Rejections carry a random token; normalize it so two rejections can be
 *  compared for structural identity. */
function normalize(result) {
  const clone = JSON.parse(JSON.stringify(result));
  if (clone.rejection?.token) clone.rejection.token = '<token>';
  return clone;
}

// ---------- mode 'off' — the shipped default is byte-identical ----------

test("off: no answers, good answers, bad answers and mixed answers all produce the identical `pending` rejection", () => {
  setFirstCallAnswers('off');
  store.__resetStore();
  const shapes = {
    'no answers': {},
    'good answers': { answers: GOOD },
    'bad answers': { answers: BAD },
    'mixed answers': { answers: MIXED },
  };
  const baseline = normalize(auditWithAnswerables.process(PAYLOAD, {}, {}));
  assert.equal(baseline.status, 'rejected');
  assert.equal(baseline.rejection.reason, 'pending');
  assert.deepEqual(Object.keys(baseline.rejection.items).sort(), ['alpha', 'beta']);
  assert.equal(baseline.rejection.classifier_issues, undefined);
  assert.equal(baseline.rejection.first_call_answers, undefined);
  for (const [name, input] of Object.entries(shapes)) {
    store.__resetStore();
    assert.deepEqual(
      normalize(auditWithAnswerables.process(PAYLOAD, {}, input)),
      baseline,
      `"${name}" must be indistinguishable from the no-answers first call under mode "off"`,
    );
  }
});

test('off: a first call carrying valid answers still mints exactly one token and stays rejected', () => {
  setFirstCallAnswers('off');
  store.__resetStore();
  const { result, mints } = countingMints(() =>
    auditWithAnswerables.process(PAYLOAD, {}, { answers: GOOD }),
  );
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'pending');
  assert.equal(mints, 1, 'mode "off" must keep the mint-then-echo round trip');
});

test('off: the minted token still commits on the second call, unchanged', () => {
  setFirstCallAnswers('off');
  store.__resetStore();
  const first = auditWithAnswerables.process(PAYLOAD, {}, {});
  const second = auditWithAnswerables.process(
    PAYLOAD,
    {},
    { token: first.rejection.token, answers: GOOD },
  );
  assert.equal(second.status, 'committed');
});

// ---------- mode 'safe_subset' ----------

test('safe_subset: every active classifier answerable and every answer valid → committed with NO mint', () => {
  setFirstCallAnswers('safe_subset');
  store.__resetStore();
  const { result, mints } = countingMints(() =>
    auditWithAnswerables.process(PAYLOAD, {}, { answers: GOOD }),
  );
  assert.equal(result.status, 'committed');
  assert.equal(mints, 0, 'a fully-answered first call must not mint a token');
});

test('safe_subset: an invalid answer → answers_inconsistent WITH a token and first_call_answers', () => {
  setFirstCallAnswers('safe_subset');
  store.__resetStore();
  const { result, mints } = countingMints(() =>
    auditWithAnswerables.process(PAYLOAD, {}, { answers: MIXED }),
  );
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'answers_inconsistent');
  assert.ok(result.rejection.token, 'the agent needs a token to retry with');
  assert.equal(result.rejection.first_call_answers, true);
  assert.deepEqual(result.rejection.classifier_issues, [
    'beta: expected "ok", got "nope"',
  ]);
  assert.equal(mints, 1);
  // The token the rejection handed back must be usable on the retry.
  const retry = auditWithAnswerables.process(
    PAYLOAD,
    {},
    { token: result.rejection.token, answers: GOOD },
  );
  assert.equal(retry.status, 'committed');
});

test('safe_subset: no answers → mint and `pending`, exactly as under "off"', () => {
  setFirstCallAnswers('safe_subset');
  store.__resetStore();
  const withFlag = normalize(auditWithAnswerables.process(PAYLOAD, {}, {}));
  setFirstCallAnswers('off');
  store.__resetStore();
  const withoutFlag = normalize(auditWithAnswerables.process(PAYLOAD, {}, {}));
  assert.deepEqual(withFlag, withoutFlag);
  assert.equal(withFlag.rejection.reason, 'pending');
});

test('safe_subset: an empty answers object counts as no answers', () => {
  setFirstCallAnswers('safe_subset');
  store.__resetStore();
  const { result, mints } = countingMints(() =>
    auditWithAnswerables.process(PAYLOAD, {}, { answers: {} }),
  );
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'pending');
  assert.equal(mints, 1);
});

test('safe_subset: a deferred classifier is active → `pending` even when every answer is valid', () => {
  setFirstCallAnswers('safe_subset');
  store.__resetStore();
  const { result, mints } = countingMints(() =>
    auditWithDeferred.process(PAYLOAD, {}, { answers: GOOD }),
  );
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'pending');
  assert.equal(result.rejection.first_call_answers, undefined);
  assert.deepEqual(Object.keys(result.rejection.items).sort(), ['alpha', 'gamma']);
  assert.equal(mints, 1);
});

test('safe_subset: a deferred classifier plus a bad answerable answer → answers_inconsistent carrying both', () => {
  // One round must fix everything: the rejection reports the answerable
  // subset's issue AND lists the deferred classifier's items.
  setFirstCallAnswers('safe_subset');
  store.__resetStore();
  const result = auditWithDeferred.process(PAYLOAD, {}, { answers: { ...GOOD, alpha: 'nope' } });
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'answers_inconsistent');
  assert.equal(result.rejection.first_call_answers, true);
  assert.deepEqual(result.rejection.classifier_issues, [
    'alpha: expected "ok", got "nope"',
  ]);
  assert.deepEqual(Object.keys(result.rejection.items).sort(), ['alpha', 'gamma']);
});

test('safe_subset: an unassigned classifier is NOT answerable', () => {
  setFirstCallAnswers('safe_subset');
  store.__resetStore();
  const result = auditWithUnassigned.process(PAYLOAD, {}, { answers: GOOD });
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'pending');
});

test('safe_subset: an inactive deferred classifier does not block the first-call accept', () => {
  // `gamma` builds no items for this payload, so it never enters the active
  // set and the answerable subset covers everything that fired.
  setFirstCallAnswers('safe_subset');
  store.__resetStore();
  const { result, mints } = countingMints(() =>
    auditWithDeferred.process({ ...PAYLOAD, g: '' }, {}, { answers: GOOD }),
  );
  assert.equal(result.status, 'committed');
  assert.equal(mints, 0);
});

// ---------- mode 'all_except_confirmation' ----------

test('all_except_confirmation: an unassigned classifier becomes answerable', () => {
  setFirstCallAnswers('all_except_confirmation');
  store.__resetStore();
  const { result, mints } = countingMints(() =>
    auditWithUnassigned.process(PAYLOAD, {}, { answers: GOOD }),
  );
  assert.equal(result.status, 'committed');
  assert.equal(mints, 0);
});

test('all_except_confirmation: an explicit `firstCallAnswerable: false` still defers', () => {
  setFirstCallAnswers('all_except_confirmation');
  store.__resetStore();
  const result = auditWithDeferred.process(PAYLOAD, {}, { answers: GOOD });
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'pending');
});

// ---------- Stage ordering is untouched ----------

test('a Stage-1 detector issue still short-circuits before any classifier runs, answers or not', () => {
  setFirstCallAnswers('safe_subset');
  store.__resetStore();
  const audit = new Audit({
    kind: 'first_call_stage_order_test',
    detectors: [
      {
        kind: 'noisy',
        ackReason: 'required',
        detect: () => [{ kind: 'noisy', message: 'fix me', hint: 'do the thing' }],
      },
    ],
    classifiers: [classifier('alpha', 'a', true)],
  });
  const { result, mints } = countingMints(() => audit.process(PAYLOAD, {}, { answers: GOOD }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'unacked_warnings');
  assert.equal(result.rejection.items, undefined, 'no classifier items before Stage 1 clears');
  assert.equal(mints, 0, 'no token mints while a detector still blocks');
});

test('a Stage-0 shape failure still short-circuits before any classifier runs', () => {
  setFirstCallAnswers('safe_subset');
  store.__resetStore();
  const audit = new Audit({
    kind: 'first_call_shape_order_test',
    shapeChecks: [
      {
        kind: 'always_fails',
        check: () => {
          throw new Error('invalid_strategy: the shape is wrong');
        },
      },
    ],
    detectors: [],
    classifiers: [classifier('alpha', 'a', true)],
  });
  const { result, mints } = countingMints(() => audit.process(PAYLOAD, {}, { answers: GOOD }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'invalid_shape');
  assert.deepEqual(result.rejection.shape_issues, ['the shape is wrong']);
  assert.equal(mints, 0);
});

// ---------- the save audit's assignment table ----------

const ANSWERABLE_FIXTURE = {
  strategy: 'fetch',
  baseUrl: 'https://shop.test',
  endpoint: '/api/products?q={{query}}',
  method: 'GET',
  notes: {
    params: { query: { type: 'string', kind: 'text', example: 'shoes', source: 'caller' } },
  },
};

const ANSWERABLE_CTX = {
  sessionId: 'sess_first_call',
  platform: 'shop-test',
  capability: 'list_products',
  observedSiblings: [],
  observedParamValues: {},
  capturedEndpointPaths: new Set(),
};

const ANSWERABLE_ANSWERS = {
  literal_provenance: { endpoint: { caller_input: 'query' } },
};

/** Drive the real save audit's first call with `input`, resolving whatever
 *  answers the live classifier set asks for. Returns the audit result plus the
 *  mint count. */
function saveAuditFirstCall(answers) {
  return countingMints(() =>
    saveStrategyAudit.process(ANSWERABLE_FIXTURE, ANSWERABLE_CTX, {
      skipShapeChecks: true,
      answers,
    }),
  );
}

const APPROVE_DECIDER_NAME = 'first-call-answers-test-approve';

test('save audit: with user_confirmation pre-resolved, an all-answerable first call commits without a mint', () => {
  registerSaveConfirmationDecider({
    name: APPROVE_DECIDER_NAME,
    decide: () => ({ decision: 'approve', quote: 'approved in test' }),
  });
  try {
    setFirstCallAnswers('safe_subset');
    store.__resetStore();
    // Establish which classifiers the fixture activates, so a future
    // classifier addition fails here loudly instead of silently weakening
    // the assertion below.
    const probe = saveStrategyAudit.process(ANSWERABLE_FIXTURE, ANSWERABLE_CTX, {
      skipShapeChecks: true,
    });
    assert.equal(probe.status, 'rejected');
    assert.deepEqual(
      Object.keys(probe.rejection.items ?? {}).sort(),
      ['literal_provenance'],
      'fixture must activate exactly the answerable classifier under test',
    );
    store.__resetStore();
    const { result, mints } = saveAuditFirstCall(ANSWERABLE_ANSWERS);
    assert.equal(
      result.status,
      'committed',
      `expected a first-call commit, got ${JSON.stringify(result.rejection ?? {})}`,
    );
    assert.equal(mints, 0);
  } finally {
    unregisterSaveConfirmationDecider(APPROVE_DECIDER_NAME);
  }
});

test('save audit: user_confirmation is NOT first-call answerable — its round trip survives', () => {
  // No decider registered, so user_confirmation activates. Its hash binds the
  // strategy identity the user approved, so the approval must be composed
  // against a payload a token already bound.
  setFirstCallAnswers('all_except_confirmation');
  store.__resetStore();
  const { result, mints } = saveAuditFirstCall({
    ...ANSWERABLE_ANSWERS,
    user_confirmation: {
      user_decision: 'approve',
      user_quote: 'yes, save it',
      agent_prompt: 'save list_products?',
    },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'pending');
  assert.ok(result.rejection.items?.user_confirmation, 'user_confirmation must be active');
  assert.equal(mints, 1);
});
