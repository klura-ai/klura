// observed_property_keys detector — flags expression bodies whose
// property-access chains include keys the agent observed at runtime in
// this session (Object.keys output, find_in_page match, etc). Same
// provenance check the legacy minified-offset gate ran; lives now as
// one Detector entry on saveStrategyAudit. Anti-canned-ack property
// preserved via the Detector's validateAck hook (ack must reference a
// flagged key).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { saveStrategyAudit } = await import('../dist/audit/lift/save-strategy.js');
const { recordObservations } = await import('../dist/observation-trace.js');
const { registerSaveConfirmationDecider } = await import(
  '../dist/audit/lift/save-confirmation-decider.js'
);

// Bypass Stage 0 shape checks — detector behavior under test, fixtures are
// minimal by design.
const _origProcess = saveStrategyAudit.process.bind(saveStrategyAudit);
saveStrategyAudit.process = (data, ctx, input) =>
  _origProcess(data, ctx, { skipShapeChecks: true, ...(input ?? {}) });

registerSaveConfirmationDecider({
  name: 'observed-property-keys-test-default-approve',
  decide() {
    return { decision: 'approve', quote: 'default-approve in tests' };
  },
});

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

test('classifier fires when js-eval prereq bakes observed property keys', () => {
  const session = mkSession(['__app', 'me', 'o']);
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://x.test/',
    endpoint: '/api/x',
    headers: { 'X-Nonce': '{{nonce}}' },
    prerequisites: [
      {
        name: 'p',
        kind: 'js-eval',
        url: 'https://x.test/',
        expression: 'window.__app.me.o.nonce',
        binds: 'nonce',
        return_shape: { kind: 'string' },
      },
    ],
  };
  const r = saveStrategyAudit.process(strategy, mkCtx(session), {});
  assert.equal(r.status, 'rejected');
  const item = r.rejection?.items?.observed_property_keys;
  assert.ok(item, 'expected observed_property_keys classifier item');
});

test('answer with valid reason (mentions a flagged key) commits', () => {
  const session = mkSession(['__app', 'me', 'o']);
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://x.test/',
    endpoint: '/api/x',
    headers: { 'X-Nonce': '{{nonce}}' },
    prerequisites: [
      {
        name: 'p',
        kind: 'js-eval',
        url: 'https://x.test/',
        expression: 'window.__app.me.o.nonce',
        binds: 'nonce',
        return_shape: { kind: 'string' },
      },
    ],
    notes: { params: { text: { description: 'msg', kind: 'text', example: 'hi' } } },
  };
  const ctx = mkCtx(session);
  const first = saveStrategyAudit.process(strategy, ctx, {});
  assert.equal(first.status, 'rejected');
  assert.equal(first.rejection.reason, 'pending');

  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    answers: {
      observed_property_keys:
        'The keys "me" and "o" are intentional — frozen offsets in this dev fixture.',
      literal_provenance: { 'prerequisites[0].url': 'static', endpoint: 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(
    second.status,
    'committed',
    `expected committed; got ${JSON.stringify(second.rejection)}`,
  );
});

test('answer with reason missing all flagged keys → classifier issue (anti-canned)', () => {
  const session = mkSession(['__app', 'me', 'o']);
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://x.test/',
    endpoint: '/api/x',
    headers: { 'X-Nonce': '{{nonce}}' },
    prerequisites: [
      {
        name: 'p',
        kind: 'js-eval',
        url: 'https://x.test/',
        expression: 'window.__app.me.o.nonce',
        binds: 'nonce',
        return_shape: { kind: 'string' },
      },
    ],
    notes: { params: { text: { description: 'msg', kind: 'text', example: 'hi' } } },
  };
  const ctx = mkCtx(session);
  const first = saveStrategyAudit.process(strategy, ctx, {});

  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    answers: {
      observed_property_keys: 'this is intentional and I have my reasons for it being so',
      literal_provenance: { 'prerequisites[0].url': 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'rejected');
  const issue = (second.rejection.classifier_issues || []).find((s) =>
    /must reference at least one flagged key/.test(s),
  );
  assert.ok(issue, `expected anti-canned classifier issue; got ${JSON.stringify(second.rejection.classifier_issues)}`);
});

test('classifier silent when session has no observations recorded', () => {
  const session = mkSession([]);
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://x.test/',
    endpoint: '/api/x',
    headers: { 'X-Nonce': '{{nonce}}' },
    prerequisites: [
      {
        name: 'p',
        kind: 'js-eval',
        url: 'https://x.test/',
        expression: 'window.__app.me.o.nonce',
        binds: 'nonce',
        return_shape: { kind: 'string' },
      },
    ],
  };
  const r = saveStrategyAudit.process(strategy, mkCtx(session), {});
  // No observations → observed_property_keys classifier should be inactive.
  assert.equal(r.rejection?.items?.observed_property_keys, undefined);
});

test('classifier item reflects edited expression keys', () => {
  // Edit expression → the new flagged keys surface in the classifier item,
  // and the hash binding cascades a fresh token via payload_changed.
  const session = mkSession(['__app', 'me', 'o', 'xa', 'y']);
  const ctx = mkCtx(session);
  const s1 = {
    strategy: 'page-script',
    baseUrl: 'https://x.test/',
    endpoint: '/api/x',
    headers: { 'X-Nonce': '{{nonce}}' },
    prerequisites: [
      {
        name: 'p',
        kind: 'js-eval',
        url: 'https://x.test/',
        expression: 'window.__app.me.o.nonce',
        binds: 'nonce',
        return_shape: { kind: 'string' },
      },
    ],
  };
  saveStrategyAudit.process(s1, ctx, {});
  const s2 = {
    ...s1,
    prerequisites: [
      { ...s1.prerequisites[0], expression: 'window.__app.xa.y.nonce' },
    ],
  };
  const second = saveStrategyAudit.process(s2, ctx, {});
  assert.equal(second.status, 'rejected');
  const item = second.rejection?.items?.observed_property_keys;
  assert.ok(item, 'expected observed_property_keys item on retry');
  // Flagged keys reflect the NEW expression.
  const flaggedKeys = item.flagged_keys ?? [];
  assert.ok(flaggedKeys.includes('xa') || flaggedKeys.includes('y'),
    `expected flagged_keys to include xa/y; got ${JSON.stringify(flaggedKeys)}`);
});
