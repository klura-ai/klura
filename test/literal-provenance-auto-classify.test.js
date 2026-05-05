// Gap 2: literal_provenance auto-classification.
//
// When a templated field has a single distinct placeholder name, the runtime
// can derive whether it's caller_input or prereq_output by checking whether
// the name matches a declared prereq.binds. The agent shouldn't have to
// classify these — the audit fills the answer in.
//
// Surfaced by llm-tests/scenarios/platform-map warm/task: r12 (audit pending)
// → r13 (agent answered "static" for /search?q={{query}} — wrong) → r14
// (after fixing, kind issue surfaced) → r15 (committed). With auto-class,
// the agent can omit the answer and the kind issue surfaces in the SAME
// retry that they fix it on.
//
// These tests drive saveStrategyAudit.process directly to assert the merge
// behavior at the audit boundary.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { saveStrategyAudit } = await import('../dist/audit/save-strategy.js');
const { registerSaveConfirmationDecider } = await import(
  '../dist/audit/save-confirmation-decider.js'
);

registerSaveConfirmationDecider({
  name: 'literal-provenance-test-default-approve',
  decide() {
    return { decision: 'approve', quote: 'default-approve in tests' };
  },
});

const baseCtx = {
  sessionId: 'sess_test',
  platform: 'test_platform',
  capability: 'search_restaurants',
  observedSiblings: [],
  observedParamValues: {},
  capturedEndpointPaths: new Set(),
  observedUrls: ['http://127.0.0.1:3315/search'],
};

function fetchStrategy(overrides = {}) {
  return {
    strategy: 'fetch',
    baseUrl: 'http://127.0.0.1:3315',
    endpoint: '/search?q={{query}}',
    response: { format: 'html', extract: { items: { selector: 'a', multiple: true } } },
    notes: {
      params: { query: { kind: 'text', example: 'thai' } },
    },
    ...overrides,
  };
}

test('first save: items expose auto_classified for templated fields', () => {
  const result = saveStrategyAudit.process(fetchStrategy(), baseCtx, {});
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'pending');
  const items = result.rejection.items.literal_provenance;
  const endpoint = items.find((i) => i.path === 'endpoint');
  assert.ok(endpoint, 'expected endpoint item');
  assert.deepEqual(endpoint.auto_classified, { caller_input: 'query' });
});

test('agent can omit literal_provenance for auto-classified items', () => {
  // Mint token first.
  const first = saveStrategyAudit.process(fetchStrategy(), baseCtx, {});
  assert.equal(first.status, 'rejected');
  const token = first.rejection.token;
  // Agent submits empty literal_provenance — auto-class fills in.
  const second = saveStrategyAudit.process(fetchStrategy(), baseCtx, {
    token,
    answers: {
      literal_provenance: {},
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'committed');
});

test('placeholder matching prereq.binds → auto-classified as prereq_output', () => {
  // collectScannedFields scans endpoint + (string-only) body + prereq URLs.
  // We put the {{token}} placeholder in the endpoint so the audit sees it.
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'http://127.0.0.1:3311',
    endpoint: '/api/send?token={{token}}',
    method: 'POST',
    prerequisites: [
      {
        name: 'sign',
        kind: 'js-eval',
        url: 'http://127.0.0.1:3311/',
        expression: 'computeToken()',
        binds: 'token',
        return_shape: { kind: 'string', min_length: 8 },
      },
    ],
  };
  const ctx = {
    ...baseCtx,
    observedUrls: ['http://127.0.0.1:3311/', 'http://127.0.0.1:3311/api/send'],
  };
  // Strategy is mutating-shaped (POST) — Stage 1 demands a verification ack
  // before classifiers run. Supply one so Stage 2 fires and exposes the
  // auto_classified items being asserted.
  const acks = {
    mutating_verification_required:
      'transaction-shape: response.extract grounds the verification (test default)',
    parameterization_disclosure_required:
      'prereq sign covers the only varying value (token); endpoint anchor /api/send has no caller axis beyond the prereq output',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.status, 'rejected');
  const items = first.rejection.items.literal_provenance;
  const endpoint = items.find((i) => i.path === 'endpoint');
  assert.ok(endpoint, 'expected endpoint item carrying {{token}}');
  assert.deepEqual(endpoint.auto_classified, { prereq_output: 'token' });
});

test('static fields stay unclassified — agent must answer', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'http://127.0.0.1:3315',
    endpoint: '/search', // no placeholder
  };
  const acks = {
    parameterization_disclosure_required:
      'endpoint /search: degenerate test fixture; literal_provenance is the gate under test',
  };
  const first = saveStrategyAudit.process(strategy, baseCtx, { acks });
  assert.equal(first.status, 'rejected');
  const items = first.rejection.items.literal_provenance;
  const endpoint = items.find((i) => i.path === 'endpoint');
  assert.ok(endpoint);
  assert.equal(endpoint.auto_classified, undefined);
});

test('kind issue surfaces on first retry when auto-class fills caller_input', () => {
  // Strategy missing notes.params.query.kind — should fire the kind issue
  // even though the agent never classified the placeholder.
  const broken = fetchStrategy({
    notes: { params: { query: { example: 'thai' } } }, // .kind missing
  });
  const first = saveStrategyAudit.process(broken, baseCtx, {});
  const second = saveStrategyAudit.process(broken, baseCtx, {
    token: first.rejection.token,
    answers: { literal_provenance: {}, observed_siblings: {} },
  });
  assert.equal(second.status, 'rejected');
  assert.equal(second.rejection.reason, 'answers_inconsistent');
  const issues = second.rejection.classifier_issues || [];
  const kindIssue = issues.find((i) => i.includes('notes.params.query.kind is required'));
  assert.ok(kindIssue, `expected kind issue, got: ${JSON.stringify(issues)}`);
});

test('agent override wins over auto-classification', () => {
  // Agent insists on classifying the field as static — runtime still rejects
  // because the field is templated, just like the pre-Gap-2 behavior. The
  // override shouldn't cause auto-class to silently take precedence.
  const first = saveStrategyAudit.process(fetchStrategy(), baseCtx, {});
  const second = saveStrategyAudit.process(fetchStrategy(), baseCtx, {
    token: first.rejection.token,
    answers: {
      literal_provenance: { endpoint: 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'rejected');
  const issues = second.rejection.classifier_issues || [];
  assert.ok(
    issues.some((i) => i.includes('static') && i.includes('placeholder')),
    `expected static-vs-placeholder issue, got: ${JSON.stringify(issues)}`,
  );
});
