// Three save-audit hardening riders that ship alongside the first-call-answers
// flag (they must be in every A/B arm, or the comparison is confounded):
//
//   (a) `validateCallerInputKindsAndEnums` seeds its iteration from the
//       strategy's DECLARED `notes.params`, not only from the params the
//       agent's answers pointed at. A blanket-"static" answer sheet no longer
//       empties the set and silently no-ops the kind / enum-grounding checks.
//   (b) `caller_arg_baked` is a Stage-1 Detector, not a `literal_provenance`
//       validation issue — it fires BEFORE any classifier token mints, so the
//       agent re-templates the field on a token-free rejection.
//   (c) `observed_siblings` has a live producer: the session's captured
//       endpoints that no saved strategy covers and that this strategy does
//       not itself target.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-audit-riders-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { saveStrategyAudit } = await import('../dist/audit/lift/save-strategy.js');
const { rejectionFamilyKey } = await import('../dist/audit/lift/save-rejection-bounce.js');
const { detectCallerArgBaked } = await import('../dist/gate/save-warnings-caller-arg.js');
const { collectObservedSiblingsForAudit } = await import('../dist/tools/save-strategy.js');
const { WARNING_KINDS } = await import('../dist/vocab/index.js');
const { registerSaveConfirmationDecider } = await import(
  '../dist/audit/lift/save-confirmation-decider.js'
);
const store = createRequire(import.meta.url)('../dist/gate/store.js');

// user_confirmation is not the subject here; auto-resolve it so the fixtures
// exercise the dimension under test.
registerSaveConfirmationDecider({
  name: 'audit-riders-approve',
  decide: () => ({ decision: 'approve', quote: 'approved in test' }),
});

function ctx(overrides = {}) {
  return {
    sessionId: 'sess_riders',
    platform: 'riders-test',
    capability: 'search_products',
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
    ...overrides,
  };
}

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

// ---------- (a) declared params are checked whatever the agent claimed ----------

// `query` is declared as a caller param but carries no `kind`, which is what
// the enum-grounding family requires before a caller_input param can be saved.
const DECLARED_PARAM_STRATEGY = {
  strategy: 'fetch',
  baseUrl: 'https://shop.test',
  endpoint: '/api/products?q={{query}}',
  method: 'GET',
  notes: { params: { query: { type: 'string', example: 'shoes', source: 'caller' } } },
};

/** Drive the audit's mint-then-answer cycle and return the second rejection. */
function auditWithAnswers(strategy, answers, ctxOverrides = {}) {
  store.__resetStore();
  const c = ctx(ctxOverrides);
  const first = saveStrategyAudit.process(strategy, c, { skipShapeChecks: true });
  assert.equal(first.status, 'rejected', 'first call must mint a token');
  return saveStrategyAudit.process(strategy, c, {
    skipShapeChecks: true,
    token: first.rejection.token,
    answers,
  });
}

test('a: a blanket-"static" answer sheet still trips the enum-grounding family', () => {
  const result = auditWithAnswers(DECLARED_PARAM_STRATEGY, {
    literal_provenance: { endpoint: 'static' },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'answers_inconsistent');
  assert.ok(
    result.rejection.classifier_issues.some((b) => b.startsWith('notes.params.query')),
    `expected a notes.params.query bullet, got ${JSON.stringify(result.rejection.classifier_issues)}`,
  );
});

test('a: the blanket-"static" rejection lands in the enum-grounding bounce family', () => {
  // The family key scopes to the strategy path, so the dead-end bounce and the
  // return-to-drive exit option both engage.
  const result = auditWithAnswers(DECLARED_PARAM_STRATEGY, {
    literal_provenance: { endpoint: 'static' },
  });
  assert.match(rejectionFamilyKey(result.rejection, 'fetch'), /notes\.params\.query/);
});

test('a: the same issue fires when the agent DOES admit the caller_input classification', () => {
  // The check is invariant to what the agent claimed — a param is a caller
  // param because the strategy declares it, not because the answer sheet
  // conceded it.
  const admitted = auditWithAnswers(DECLARED_PARAM_STRATEGY, {
    literal_provenance: { endpoint: { caller_input: 'query' } },
  });
  const denied = auditWithAnswers(DECLARED_PARAM_STRATEGY, {
    literal_provenance: { endpoint: 'static' },
  });
  const bullets = (r) => r.rejection.classifier_issues.filter((b) => b.startsWith('notes.params.'));
  assert.deepEqual(bullets(admitted), bullets(denied));
  assert.ok(bullets(admitted).length > 0);
});

test('a: declaring the param kind clears the family', () => {
  const fixed = {
    ...DECLARED_PARAM_STRATEGY,
    notes: {
      params: { query: { type: 'string', kind: 'text', example: 'shoes', source: 'caller' } },
    },
  };
  const result = auditWithAnswers(fixed, { literal_provenance: {} });
  assert.equal(result.status, 'committed', JSON.stringify(result.rejection ?? {}));
});

// ---------- (b) caller_arg_baked is a Stage-1 Detector ----------

const DECLARED = [{ capability: 'search_products', args: { query: 'wireless headphones' } }];

const BAKED_STRATEGY = {
  strategy: 'fetch',
  baseUrl: 'https://shop.test',
  endpoint: '/api/search',
  method: 'POST',
  body: { q: 'wireless headphones', page: 1 },
};

test('b: a whole field baked with a declared arg value is detected', () => {
  const warnings = detectCallerArgBaked(BAKED_STRATEGY, DECLARED);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, WARNING_KINDS.callerArgBaked);
  assert.equal(warnings[0].context.path, 'body.q');
  assert.equal(warnings[0].context.arg, 'query');
  assert.match(warnings[0].hint, /\{\{query\}\}/);
});

test('b: it fires in Stage 1 — no classifier items, no token minted', () => {
  store.__resetStore();
  const { result, mints } = countingMints(() =>
    saveStrategyAudit.process(BAKED_STRATEGY, ctx({ session: { declaredCapabilities: DECLARED } }), {
      skipShapeChecks: true,
    }),
  );
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'unacked_warnings');
  assert.ok(result.rejection.warnings.some((w) => w.kind === WARNING_KINDS.callerArgBaked));
  assert.equal(result.rejection.items, undefined, 'Stage 2 must not run while Stage 1 blocks');
  assert.equal(mints, 0, 'a Stage-1 rejection must not mint a classifier token');
});

test('b: the ack channel is the escape hatch for a genuinely fixed value', () => {
  const result = saveStrategyAudit.process(
    BAKED_STRATEGY,
    ctx({ session: { declaredCapabilities: DECLARED } }),
    {
      skipShapeChecks: true,
      acks: {
        [WARNING_KINDS.callerArgBaked]:
          'the storefront only serves this one catalog segment; the value is fixed for every caller',
      },
    },
  );
  // Stage 1 cleared — whatever comes next is Stage 2, not this warning.
  const stillFlagged = (result.rejection?.warnings ?? []).some(
    (w) => w.kind === WARNING_KINDS.callerArgBaked && result.rejection.reason === 'unacked_warnings',
  );
  assert.equal(stillFlagged, false, JSON.stringify(result.rejection ?? {}));
});

test('b: a templated field does not fire', () => {
  const templated = { ...BAKED_STRATEGY, body: { q: '{{query}}', page: 1 } };
  assert.deepEqual(detectCallerArgBaked(templated, DECLARED), []);
});

test('b: a partial (substring) match does not fire — whole-field exact only', () => {
  const partial = { ...BAKED_STRATEGY, body: { q: 'wireless headphones black', page: 1 } };
  assert.deepEqual(detectCallerArgBaked(partial, DECLARED), []);
});

test('b: short arg values are below the evidence floor', () => {
  const shortArgs = [{ capability: 'list_products', args: { locale: 'en', page: '1' } }];
  const strategy = { ...BAKED_STRATEGY, body: { q: 'en', page: '1' } };
  assert.deepEqual(detectCallerArgBaked(strategy, shortArgs), []);
});

test('b: no declared capabilities → nothing to match against', () => {
  assert.deepEqual(detectCallerArgBaked(BAKED_STRATEGY, undefined), []);
  assert.deepEqual(detectCallerArgBaked(BAKED_STRATEGY, []), []);
});

// ---------- (c) observed_siblings has a producer ----------

const SIBLING_SESSION = {
  intercepted: [
    { url: 'https://shop.test/api/search?q=x', method: 'POST', status: 200 },
    { url: 'https://shop.test/api/reviews', method: 'GET', status: 200 },
    { url: 'https://shop.test/api/collect', method: 'POST', status: 200 },
    { url: 'https://shop.test/api/failing', method: 'GET', status: 500 },
  ],
  savedCapabilities: [],
};

test('c: the producer returns the captured endpoints the strategy does not target', () => {
  const siblings = collectObservedSiblingsForAudit(
    SIBLING_SESSION,
    'riders-test-siblings',
    BAKED_STRATEGY,
  );
  const keys = siblings.map((s) => s.key);
  assert.ok(keys.includes('GET /api/reviews'), `got ${JSON.stringify(keys)}`);
  assert.ok(!keys.includes('POST /api/search'), "the strategy's own endpoint is subtracted");
  assert.ok(!keys.some((k) => k.includes('/api/collect')), 'telemetry-shaped paths are filtered');
  assert.ok(!keys.some((k) => k.includes('/api/failing')), 'non-2xx captures are filtered');
});

test('c: a templated path segment on the strategy still subtracts the concrete capture', () => {
  const templated = {
    strategy: 'fetch',
    baseUrl: 'https://shop.test',
    endpoint: '/api/products/{{id}}',
    method: 'GET',
  };
  const session = {
    intercepted: [{ url: 'https://shop.test/api/products/42', method: 'GET', status: 200 }],
    savedCapabilities: [],
  };
  assert.deepEqual(
    collectObservedSiblingsForAudit(session, 'riders-test-siblings', templated),
    [],
  );
});

test('c: no session or no platform → no checklist', () => {
  assert.deepEqual(collectObservedSiblingsForAudit(null, 'riders-test-siblings', BAKED_STRATEGY), []);
  assert.deepEqual(collectObservedSiblingsForAudit(SIBLING_SESSION, '', BAKED_STRATEGY), []);
});

test('c: a produced checklist activates the observed_siblings classifier', () => {
  store.__resetStore();
  const siblings = collectObservedSiblingsForAudit(
    SIBLING_SESSION,
    'riders-test-siblings',
    BAKED_STRATEGY,
  );
  assert.ok(siblings.length > 0, 'fixture must produce at least one sibling');
  const result = saveStrategyAudit.process(
    { strategy: 'fetch', baseUrl: 'https://shop.test', endpoint: '/api/search', method: 'POST' },
    ctx({ observedSiblings: siblings }),
    { skipShapeChecks: true },
  );
  assert.equal(result.status, 'rejected');
  assert.deepEqual(result.rejection.items.observed_siblings, siblings);
});
