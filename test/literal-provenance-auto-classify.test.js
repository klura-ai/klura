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

const { saveStrategyAudit } = await import('../dist/audit/lift/save-strategy.js');
const { registerSaveConfirmationDecider } = await import(
  '../dist/audit/lift/save-confirmation-decider.js'
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
  // collectScannedFields scans endpoint + body (object keys + JSON descent) +
  // headers + prereq URLs. We put the {{token}} placeholder in the endpoint
  // so the audit sees it.
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
  // First call mints token; classifiers (mutating_verification_required,
  // parameterization_disclosure_required, literal_provenance, ...) all
  // surface as items at Stage 2.
  const first = saveStrategyAudit.process(strategy, ctx, {});
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
  const first = saveStrategyAudit.process(strategy, baseCtx, {});
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

const descentCtx = {
  ...baseCtx,
  observedUrls: ['http://127.0.0.1:3315/', 'http://127.0.0.1:3315/api/x', 'http://127.0.0.1:3315/api/graphql'],
};

test('JSON descent: object body keys surface as literal_provenance items', () => {
  // body is an object — each key emits as a separate scanned-field path.
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'http://127.0.0.1:3315',
    endpoint: '/api/x',
    method: 'GET',
    body: { static_key: 'plain', templated_key: '{{query}}' },
    notes: { params: { query: { kind: 'text', example: 'thai' } } },
  };
  const result = saveStrategyAudit.process(strategy, descentCtx, {});
  assert.equal(result.status, 'rejected');
  const items = result.rejection.items.literal_provenance;
  const staticKey = items.find((i) => i.path === 'body.static_key');
  const templatedKey = items.find((i) => i.path === 'body.templated_key');
  assert.ok(staticKey, 'expected body.static_key in items');
  assert.equal(staticKey.value, 'plain');
  assert.ok(templatedKey, 'expected body.templated_key in items');
  assert.deepEqual(templatedKey.auto_classified, { caller_input: 'query' });
});

test('JSON descent: stringified-JSON body field exposes inner literals', () => {
  // The Facebook-discovery shape: body.variables is a JSON-stringified blob
  // hiding embedded literals (count, scale). Without descent, the agent can
  // classify body.variables as "static" and the inner numerics never surface.
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'http://127.0.0.1:3315',
    endpoint: '/api/graphql',
    method: 'GET',
    body: {
      doc_id: '7760990390645001',
      variables: '{"count":3,"scale":1}',
    },
  };
  const result = saveStrategyAudit.process(strategy, descentCtx, {});
  assert.equal(result.status, 'rejected');
  const items = result.rejection.items.literal_provenance;
  const wrapper = items.find((i) => i.path === 'body.variables');
  const innerCount = items.find((i) => i.path === 'body.variables.count');
  const innerScale = items.find((i) => i.path === 'body.variables.scale');
  assert.ok(wrapper, 'expected wrapper body.variables in items');
  assert.ok(innerCount, 'expected inner body.variables.count in items');
  assert.equal(innerCount.value, '3');
  assert.ok(innerScale, 'expected inner body.variables.scale in items');
  assert.equal(innerScale.value, '1');
});

test('JSON descent: headers keys surface as literal_provenance items', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'http://127.0.0.1:3315',
    endpoint: '/api/x',
    method: 'GET',
    headers: { 'x-version': '2', 'x-token': '{{token}}' },
    prerequisites: [
      {
        name: 'mint_token',
        kind: 'js-eval',
        url: 'http://127.0.0.1:3315/',
        expression: 'computeToken()',
        binds: 'token',
        return_shape: { kind: 'string', min_length: 8 },
      },
    ],
  };
  const result = saveStrategyAudit.process(strategy, descentCtx, {});
  assert.equal(result.status, 'rejected');
  const items = result.rejection.items.literal_provenance;
  const versionHeader = items.find((i) => i.path === 'headers.x-version');
  const tokenHeader = items.find((i) => i.path === 'headers.x-token');
  assert.ok(versionHeader, 'expected headers.x-version in items');
  assert.equal(versionHeader.value, '2');
  assert.ok(tokenHeader, 'expected headers.x-token in items');
  assert.deepEqual(tokenHeader.auto_classified, { prereq_output: 'token' });
});

test('JSON descent: malformed JSON string keeps wrapper, no inner literals', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'http://127.0.0.1:3315',
    endpoint: '/api/x',
    method: 'GET',
    body: {
      payload: '{not actually json',
    },
  };
  const result = saveStrategyAudit.process(strategy, descentCtx, {});
  assert.equal(result.status, 'rejected');
  const items = result.rejection.items.literal_provenance;
  const wrapper = items.find((i) => i.path === 'body.payload');
  assert.ok(wrapper, 'expected wrapper body.payload in items');
  const inner = items.filter((i) => i.path.startsWith('body.payload.'));
  assert.equal(inner.length, 0, `expected no inner descent, got: ${JSON.stringify(inner)}`);
});
