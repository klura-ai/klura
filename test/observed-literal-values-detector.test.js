// observed_literal_values detector — flags strategy header values, body
// values, and recorded-path step values that exactly match strings the
// agent observed via tool responses during this session. Same provenance
// shape as observed_property_keys but applied to value slots rather than
// expression-key slots. Catches the canonical regression: agent bakes a
// rotating nonce / signed token into a header instead of templating it
// via a prereq.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { saveStrategyAudit } = await import('../dist/audit/save-strategy.js');
const { recordObservations } = await import('../dist/observation-trace.js');
const { registerSaveConfirmationDecider } = await import(
  '../dist/audit/save-confirmation-decider.js'
);

// Bypass Stage 0 shape checks — detector behavior under test, fixtures are
// minimal by design.
const _origProcess = saveStrategyAudit.process.bind(saveStrategyAudit);
saveStrategyAudit.process = (data, ctx, input) =>
  _origProcess(data, ctx, { skipShapeChecks: true, ...(input ?? {}) });

registerSaveConfirmationDecider({
  name: 'observed-literal-values-test-default-approve',
  decide() {
    return { decision: 'approve', quote: 'default-approve in tests' };
  },
});

const VERIFY_ACK =
  'transaction-shape: response.extract grounds the verification (test default)';

const BAKED = 'c958faf6168bed67ea86dabacee3f5b7';

function mkSession(observed = []) {
  const s = { id: 'sess_test', intercepted: [], intercepting: false };
  recordObservations(s, observed);
  return s;
}

function mkCtx(session) {
  return {
    sessionId: 'sess_test',
    platform: 'test_platform',
    capability: 'send_message',
    session,
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
  };
}

function findClassifierItem(rej, kind) {
  return rej?.items?.[kind];
}

test('fires when a header value matches an observed string', () => {
  const session = mkSession([BAKED]);
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://x.test/',
    endpoint: '/send',
    method: 'POST',
    headers: { 'x-nonce': BAKED },
    body: { text: '{{text}}' },
    notes: { params: { text: { description: 'msg', kind: 'text', example: 'hi' } } },
  };
  const r = saveStrategyAudit.process(strategy, mkCtx(session), {});
  assert.equal(r.status, 'rejected');
  const item = findClassifierItem(r.rejection, 'observed_literal_values');
  assert.ok(item, 'expected observed_literal_values classifier item');
  const occurrence = (item.occurrences ?? []).find((o) => /headers\["x-nonce"\]/.test(o.location));
  assert.ok(occurrence, 'expected headers["x-nonce"] occurrence');
});

test('fires for body JSON leaf values (recursive walk)', () => {
  const session = mkSession([BAKED]);
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://x.test/',
    endpoint: '/send',
    method: 'POST',
    headers: {},
    body: { text: '{{text}}', meta: { token: BAKED } },
    notes: { params: { text: { description: 'msg', kind: 'text', example: 'hi' } } },
  };
  const r = saveStrategyAudit.process(strategy, mkCtx(session), {});
  const item = findClassifierItem(r.rejection, 'observed_literal_values');
  assert.ok(item);
  const occurrence = (item.occurrences ?? []).find((o) => /body\.meta\.token/.test(o.location));
  assert.ok(occurrence, 'expected body.meta.token occurrence');
});

test('fires for recorded-path step values', () => {
  const session = mkSession([BAKED]);
  const strategy = {
    strategy: 'recorded-path',
    baseUrl: 'https://x.test/',
    steps: [
      { action: 'navigate', url: 'https://x.test/' },
      { action: 'type', selector: 'input[name=token]', value: BAKED },
    ],
    notes: { params: { text: { description: 'msg', kind: 'text', example: 'hi' } } },
  };
  const r = saveStrategyAudit.process(strategy, mkCtx(session), {});
  const item = findClassifierItem(r.rejection, 'observed_literal_values');
  assert.ok(item);
  const occurrence = (item.occurrences ?? []).find((o) => /steps\[1\]\.value/.test(o.location));
  assert.ok(occurrence, 'expected steps[1].value occurrence');
});

test('STABLE_LITERAL_VALUES allowlist is not flagged', () => {
  const session = mkSession(['application/json']);
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://x.test/',
    endpoint: '/send',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { text: '{{text}}' },
    notes: { params: { text: { description: 'msg', kind: 'text', example: 'hi' } } },
  };
  const r = saveStrategyAudit.process(strategy, mkCtx(session), {});
  assert.equal(findClassifierItem(r.rejection, 'observed_literal_values'), undefined);
});

test('templated-only values are not scanned', () => {
  const session = mkSession(['{{nonce}}']);
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://x.test/',
    endpoint: '/send',
    method: 'POST',
    headers: { 'x-nonce': '{{nonce}}' },
    body: { text: '{{text}}' },
    notes: { params: { text: { description: 'msg', kind: 'text', example: 'hi' } } },
  };
  const r = saveStrategyAudit.process(strategy, mkCtx(session), {});
  assert.equal(findClassifierItem(r.rejection, 'observed_literal_values'), undefined);
});

test('strings under 8 chars are not scanned', () => {
  const session = mkSession(['short1']);
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://x.test/',
    endpoint: '/send',
    method: 'POST',
    headers: { 'x-tag': 'short1' },
    body: { text: '{{text}}' },
    notes: { params: { text: { description: 'msg', kind: 'text', example: 'hi' } } },
  };
  const r = saveStrategyAudit.process(strategy, mkCtx(session), {});
  assert.equal(findClassifierItem(r.rejection, 'observed_literal_values'), undefined);
});

test('classifier silent when session has no observations', () => {
  const session = mkSession([]);
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://x.test/',
    endpoint: '/send',
    method: 'POST',
    headers: { 'x-nonce': BAKED },
    body: { text: '{{text}}' },
    notes: { params: { text: { description: 'msg', kind: 'text', example: 'hi' } } },
  };
  const r = saveStrategyAudit.process(strategy, mkCtx(session), {});
  assert.equal(findClassifierItem(r.rejection, 'observed_literal_values'), undefined);
});

test('answer with reason referencing flagged value commits', () => {
  const session = mkSession([BAKED]);
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://x.test/',
    endpoint: '/send',
    method: 'POST',
    headers: { 'x-nonce': BAKED },
    body: { text: '{{text}}' },
    notes: { params: { text: { description: 'msg', kind: 'text', example: 'hi' } } },
  };
  const ctx = mkCtx(session);
  const first = saveStrategyAudit.process(strategy, ctx, {});
  assert.equal(first.status, 'rejected');

  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    answers: {
      observed_literal_values: `the value ${BAKED} is a frozen fixture in this dev environment, not a rotating token`,
      mutating_verification_required: VERIFY_ACK,
      literal_provenance: { endpoint: 'static', 'headers.x-nonce': 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(
    second.status,
    'committed',
    `expected committed; got ${JSON.stringify(second.rejection)}`,
  );
});

test('anti-canned: answer missing all flagged values → classifier rejected', () => {
  const session = mkSession([BAKED]);
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://x.test/',
    endpoint: '/send',
    method: 'POST',
    headers: { 'x-nonce': BAKED },
    body: { text: '{{text}}' },
    notes: { params: { text: { description: 'msg', kind: 'text', example: 'hi' } } },
  };
  const ctx = mkCtx(session);
  const first = saveStrategyAudit.process(strategy, ctx, {});

  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    answers: {
      observed_literal_values: 'this is intentional, trust me, it is fine',
      mutating_verification_required: VERIFY_ACK,
      literal_provenance: { endpoint: 'static', 'headers.x-nonce': 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'rejected');
  const issue = (second.rejection.classifier_issues || []).find((s) =>
    /must reference at least one flagged literal value/.test(s),
  );
  assert.ok(issue, `expected anti-canned classifier issue; got ${JSON.stringify(second.rejection)}`);
});
