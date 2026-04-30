// observed_property_keys detector — flags expression bodies whose
// property-access chains include keys the agent observed at runtime in
// this session (Object.keys output, find_in_page match, etc). Same
// provenance check the legacy minified-offset gate ran; lives now as
// one Detector entry on saveStrategyAudit. Anti-canned-ack property
// preserved via the Detector's validateAck hook (ack must reference a
// flagged key).

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

test('detector fires when js-eval prereq bakes observed property keys', () => {
  const session = mkSession(['__app', 'me', 'o']);
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://x.test/',
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
  const observedKeysWarning = r.rejection.warnings.find(
    (w) => w.kind === 'observed_property_keys',
  );
  assert.ok(observedKeysWarning, 'expected observed_property_keys warning');
});

test('ack with valid reason (mentions a flagged key) commits', () => {
  const session = mkSession(['__app', 'me', 'o']);
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://x.test/',
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
  const acks = {
    observed_property_keys:
      'The keys "me" and "o" are intentional — frozen offsets in this dev fixture.',
  };
  // First call: pass acks so Stage 1 clears and Stage 2 mints a token.
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.status, 'rejected');
  assert.equal(first.rejection.reason, 'pending');

  // Provide audit answers + ack referencing the keys.
  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    answers: {
      literal_provenance: {
        'prerequisites[0].url': 'static',
      },
      observed_siblings: {},
    },
    acks,
  });
  assert.equal(
    second.status,
    'committed',
    `expected committed; got ${JSON.stringify(second.rejection)}`,
  );
});

test('ack with reason missing all flagged keys → ack_issue (anti-canned)', () => {
  const session = mkSession(['__app', 'me', 'o']);
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://x.test/',
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
      literal_provenance: { 'prerequisites[0].url': 'static' },
      observed_siblings: {},
    },
    acks: {
      observed_property_keys: 'this is intentional and I have my reasons for it being so',
    },
  });
  assert.equal(second.status, 'rejected');
  const ackIssue = (second.rejection.ack_issues || []).find((s) =>
    /must reference at least one flagged key/.test(s),
  );
  assert.ok(ackIssue, 'expected anti-canned-ack issue');
});

test('detector returns no issues when session has no observations recorded', () => {
  const session = mkSession([]);
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://x.test/',
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
  // No observations → observed_property_keys warning shouldn't fire.
  // (Other detectors may still fire; we only check this kind is absent.)
  const observedKeysWarning = (r.rejection?.warnings ?? []).find(
    (w) => w.kind === 'observed_property_keys',
  );
  assert.equal(observedKeysWarning, undefined);
});

test('detector: token invalidates when expression edited (observed_property_keys-relevant fields scoped via classifier hash)', () => {
  // The detector itself doesn't bind to tokens; that's the audit-level
  // behavior. The expression edit invalidates the literal_provenance
  // classifier's token — which is the correct scoping. This test pins
  // that the agent gets a fresh rejection (with the new flagged keys)
  // when the expression changes.
  const session = mkSession(['__app', 'me', 'o', 'xa', 'y']);
  const ctx = mkCtx(session);
  const s1 = {
    strategy: 'page-script',
    baseUrl: 'https://x.test/',
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
  const first = saveStrategyAudit.process(s1, ctx, {});
  // Edit expression → still flagged, but the keys differ.
  const s2 = {
    ...s1,
    prerequisites: [
      { ...s1.prerequisites[0], expression: 'window.__app.xa.y.nonce' },
    ],
  };
  const second = saveStrategyAudit.process(s2, ctx, {});
  assert.equal(second.status, 'rejected');
  const w = (second.rejection.warnings || []).find((x) => x.kind === 'observed_property_keys');
  assert.ok(w);
  // Flagged keys reflect the NEW expression, not the cached one.
  assert.match(w.message, /xa.*y|y.*xa/);
});
