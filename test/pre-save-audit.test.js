// Pre-save audit dimensions (literal_provenance, capability_name_justification,
// observed_siblings) tested through the consolidated saveStrategyAudit.
//
// Hardened capability_name_justification path: a lookup-implying slug
// (_by_/_for_/lookup_) paired with an inline lookup prereq (js-eval or
// fetch-extract fetching /search or /lookup) is rejected regardless of what
// the agent writes in the justification string — the correct fix is to split
// the lookup into its own capability, not to argue past the check. Other
// capability_name_justification paths (slug with no inline-lookup prereq)
// stay open.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { saveStrategyAudit } = await import('../dist/audit/save-strategy.js');
const {
  registerSaveConfirmationDecider,
  unregisterSaveConfirmationDecider,
} = await import('../dist/audit/save-confirmation-decider.js');

// Tests in this file exercise individual detectors / classifiers against
// minimal fixtures that aren't always production-shape-valid. Bypass Stage 0
// here so detector / classifier behavior stays under test even when the
// strategy is structurally trimmed; the production callers
// (`tools/save-strategy.ts`, `skills.saveStrategy`) leave `skipShapeChecks`
// unset so shape always runs.
const _origProcess = saveStrategyAudit.process.bind(saveStrategyAudit);
saveStrategyAudit.process = (data, ctx, input) =>
  _origProcess(data, ctx, { skipShapeChecks: true, ...(input ?? {}) });

// Register a default-approve user_confirmation decider so existing tests
// don't need per-test user_confirmation answers — they assert other
// classifier behavior. The dedicated user_confirmation tests near the
// bottom of this file unregister this default and exercise the rejection
// paths explicitly.
registerSaveConfirmationDecider({
  name: 'pre-save-audit-test-default-approve',
  decide() {
    return { decision: 'approve', quote: 'default-approve in tests' };
  },
});

// runAudit drives the audit through its Stage-1 → Stage-2 cycle, returning
// the final result. Mirrors the prior buildSaveAuditGate test helper but
// talks to the consolidated audit's two-stage pipeline:
//   Stage 1 (detectors) — if non-acked warnings fire, auto-ack any
//     ackReason: 'required' kinds (the agent's natural recovery path) so
//     the helper can drive into Stage 2. ackReason: 'none' detectors
//     can't be acked; if any fire, the test sees a real Stage-1 block.
//   Stage 2 (classifiers) — first call mints token, second call commits
//     the supplied answers.
// Tests pass `partialCtx` with only the fields they care about — the
// rest default to empty.
function runAudit(partialCtx, strategy, answers) {
  const ctx = {
    sessionId: 'sess_test',
    platform: partialCtx.platform ?? 'test_platform',
    capability: partialCtx.capability,
    observedSiblings: partialCtx.observedSiblings ?? [],
    observedParamValues: partialCtx.observedParamValues ?? {},
    capturedEndpointPaths: partialCtx.capturedEndpointPaths ?? new Set(),
  };
  // Stage 1 probe: discover which detectors fire and auto-ack required ones.
  // Some detectors carry a per-detector validateAck (anti-canned + anchor-
  // match for mutating_verification_required, anti-canned for
  // observed_property_keys / observed_literal_values). The default canned
  // reason is rejected by those validateAck hooks. Per-kind reasons below
  // satisfy each detector's structural check.
  const ACK_REASONS = {
    mutating_verification_required:
      'transaction-shape: response.extract grounds the verification (test default)',
    parameterization_disclosure_required:
      'method anchor — test strategy has no caller axis (parameterization gate not under test here)',
  };
  const acks = {};
  const probe = saveStrategyAudit.process(strategy, ctx, {});
  if (probe.status === 'rejected' && probe.rejection.reason === 'unacked_warnings') {
    for (const w of probe.rejection.warnings ?? []) {
      acks[w.kind] = ACK_REASONS[w.kind] ?? `test-runner pre-ack: incidental ${w.kind} warning`;
    }
  }
  // Stage 2 first call: mint token. If Stage 1 still blocks (hard
  // detector with ackReason 'none'), the assertion below surfaces it.
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.status, 'rejected', 'first call should issue a token');
  assert.equal(
    first.rejection.reason,
    'pending',
    `first rejection must be pending (got ${first.rejection.reason}; warnings: ${JSON.stringify((first.rejection.warnings ?? []).map((w) => w.kind))})`,
  );
  const token = first.rejection.token;
  return saveStrategyAudit.process(strategy, ctx, { token, answers, acks });
}

test('harden: justification rejected when slug has _by_ AND js-eval prereq fetches /search', () => {
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/messages',
    method: 'POST',
    headers: {},
    body: { text: '{{text}}', to: '{{member_id}}' },
    prerequisites: [
      {
        name: 'member_id',
        kind: 'js-eval',
        url: 'https://site.example.com/',
        expression:
          "(async()=>{ const r = await fetch('https://site.example.com/api/members/search?q=' + args.name); return (await r.json()).results[0].id; })()",
        binds: 'member_id',
        return_shape: { kind: 'string' },
        timeout_ms: 5000,
      },
    ],
    notes: {
      params: {
        text: { description: 'message body', kind: 'text', example: 'hi' },
        name: { description: 'recipient', kind: 'text', example: 'alice' },
      },
    },
  };
  const result = runAudit(
    {
      capability: 'send_message_by_name',
      observedSiblings: [],
      observedParamValues: {},
      capturedEndpointPaths: new Set(),
    },
    strategy,
    {
      literal_provenance: {
        'endpoint': 'static',
      },
      capability_name_justification: 'the name describes send-by-recipient',
      observed_siblings: {},
    },
  );
  assert.equal(result.status, 'rejected');
  const issues = result.rejection.classifier_issues || [];
  const hit = issues.find((i) => /Justification is not accepted/.test(i));
  assert.ok(hit, `expected harden reject, got: ${JSON.stringify(issues)}`);
  assert.match(hit, /send_message_by_name/);
  assert.match(hit, /\/api\/members\/search/);
});

test('harden: justification accepted when slug has _by_ but prereq URL is not a lookup', () => {
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/messages',
    method: 'POST',
    headers: {},
    body: { text: '{{text}}' },
    prerequisites: [
      {
        name: 'csrf',
        kind: 'js-eval',
        url: 'https://site.example.com/',
        expression:
          "(async()=>{ const r = await fetch('https://site.example.com/api/nonsense'); return (await r.json()).token; })()",
        binds: 'csrf',
        return_shape: { kind: 'string' },
        timeout_ms: 5000,
      },
    ],
    notes: {
      params: {
        text: { description: 'message body', kind: 'text', example: 'hi' },
      },
    },
  };
  const result = runAudit(
    {
      capability: 'send_message_by_name',
      observedSiblings: [],
      observedParamValues: {},
      capturedEndpointPaths: new Set(),
    },
    strategy,
    {
      literal_provenance: {
        'endpoint': 'static',
      },
      capability_name_justification:
        'name is by-name but the prereq is infra, not a lookup',
      observed_siblings: {},
    },
  );
  // The harden path should not fire; any remaining issues (if any) must NOT be
  // the "Justification is not accepted" message.
  const issues = result.rejection?.issues || [];
  const hardenHit = issues.find((i) => /Justification is not accepted/.test(i));
  assert.equal(hardenHit, undefined, `harden should NOT fire; got: ${JSON.stringify(issues)}`);
});

test('harden: justification rejected when slug has _by_ AND page-script.script body fetches /search', () => {
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/messages',
    method: 'POST',
    headers: {},
    body: { text: '{{text}}' },
    // No prereq declared — the lookup is inlined in the page-script body.
    script:
      "(async()=>{ const r = await fetch('/api/members/search?q=' + args.name); const j = await r.json(); return j.results[0].id; })()",
    notes: {
      params: {
        text: { description: 'message body', kind: 'text', example: 'hi' },
        name: { description: 'recipient', kind: 'text', example: 'alice' },
      },
    },
  };
  const result = runAudit(
    {
      capability: 'send_message_by_name',
      observedSiblings: [],
      observedParamValues: {},
      capturedEndpointPaths: new Set(),
    },
    strategy,
    {
      literal_provenance: {
        'endpoint': 'static',
      },
      capability_name_justification: 'the name describes send-by-recipient',
      observed_siblings: {},
    },
  );
  assert.equal(result.status, 'rejected');
  const issues = result.rejection.classifier_issues || [];
  const hit = issues.find((i) => /Justification is not accepted/.test(i));
  assert.ok(hit, `expected harden reject for inline script body, got: ${JSON.stringify(issues)}`);
  assert.match(hit, /send_message_by_name/);
  assert.match(hit, /\/api\/members\/search/);
});

test('harden path: capability-method prereq (proper split) — no justification needed, commit passes', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages',
    method: 'POST',
    headers: {},
    body: { text: '{{text}}', to: '{{member_id}}' },
    prerequisites: [
      {
        name: 'member_id',
        kind: 'capability',
        capability: 'lookup_member_by_name',
        args: { name: '{{name}}' },
        vars: { member_id: 'results[0].id' },
      },
    ],
    notes: {
      params: {
        text: { description: 'message body', kind: 'text', example: 'hi' },
        name: { description: 'recipient', kind: 'text', example: 'alice' },
      },
    },
  };
  const result = runAudit(
    {
      capability: 'send_message_by_name',
      observedSiblings: [],
      observedParamValues: {},
      capturedEndpointPaths: new Set(),
    },
    strategy,
    {
      literal_provenance: {
        'endpoint': 'static',
      },
      observed_siblings: {},
    },
  );
  assert.equal(result.status, 'committed', `expected committed, got ${JSON.stringify(result)}`);
});

// === Hash scoping: the audit token must NOT cascade-invalidate when sibling
// gates mutate fields the audit doesn't classify ===
//
// Architectural note for future gate authors: do NOT pass the whole strategy
// object as the gate's payload when only a subset of fields are part of what
// the gate audits. Hashing the full strategy means any sibling gate (minified-
// offset rewrite, save_warnings_acked, etc.) that mutates an unrelated field
// invalidates THIS gate's token, forcing the agent to re-answer audits whose
// answers are still valid. Real consequence observed in
// llm-tests/scenarios/drift-offsets: a single save sequence bounced through
// the audit gate three times because rewriting prereq.expression to satisfy
// the minified-offset gate kept invalidating the literal_provenance audit,
// even though the literal fields (endpoint, prereq URL, header values, body
// keys) hadn't changed at all.
//
// Fix: every Level-3 gate uses TokenGateSpec.hashFields to project the
// payload to just the fields its answers cover. See save-audit.ts for the
// canonical example (`hashFields: literalItems`).

test('hash scoping: rewriting prereq.expression keeps the audit token valid', () => {
  // Same strategy with the SAME literal-bearing fields (endpoint, prereq.url,
  // body, headers) but a DIFFERENT prereq.expression — simulates the agent
  // rewriting the expression to a shape-walk after the minified-offset gate
  // fired. The audit token issued for v1 must still validate against v2.
  const baseStrategy = {
    strategy: 'page-script',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/send',
    method: 'POST',
    headers: { 'x-nonce': '{{nonce}}' },
    body: { text: '{{text}}' },
    prerequisites: [
      {
        name: 'get_nonce',
        kind: 'js-eval',
        url: 'https://site.example.com/',
        expression: 'window.__app.me.o.nonce',
        binds: 'nonce',
        return_shape: { kind: 'string' },
      },
    ],
    notes: { params: { text: { description: 'body', kind: 'text', example: 'hi' } } },
  };
  const rewrittenStrategy = {
    ...baseStrategy,
    prerequisites: [
      {
        ...baseStrategy.prerequisites[0],
        expression:
          'Object.values(window.__app).flatMap(v => v && typeof v === "object" ? Object.values(v) : []).find(x => typeof x?.nonce === "string")?.nonce',
      },
    ],
  };
  const ctx = {
    capability: 'send_message',
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
  };
  

  const verifyAcks = {
    mutating_verification_required:
      'transaction-shape: response.extract grounds the verification (test default)',
  };
  const first = saveStrategyAudit.process(baseStrategy, ctx, { acks: verifyAcks });
  assert.equal(first.status, 'rejected');
  assert.equal(first.rejection.reason, 'pending');
  const token = first.rejection.token;

  // Re-call with the rewritten strategy (same literals, different expression).
  // The audit answers from the first rejection remain valid because the
  // literal fields didn't change.
  const second = saveStrategyAudit.process(rewrittenStrategy, ctx, {
    token,
    acks: verifyAcks,
    answers: {
      literal_provenance: {
        endpoint: 'static',
        'prerequisites[0].url': 'static',
      },
      observed_siblings: {},
    },
  });
  assert.equal(
    second.status,
    'committed',
    `expected committed (literals unchanged); got ${JSON.stringify(second)}`,
  );
});

test('hash scoping: changing the endpoint DOES invalidate the audit token', () => {
  // Sanity check that scoping doesn't go too far the other way: a real
  // change to a literal field must still invalidate the token.
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/send',
    method: 'POST',
    headers: {},
    body: { text: '{{text}}' },
    prerequisites: [],
    notes: { params: { text: { description: 'body', kind: 'text', example: 'hi' } } },
  };
  const ctx = {
    capability: 'send_message',
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
  };
  

  const verifyAcks = {
    mutating_verification_required:
      'transaction-shape: response.extract grounds the verification (test default)',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks: verifyAcks });
  const token = first.rejection.token;

  const mutated = { ...strategy, endpoint: '/api/v2/send' };
  const second = saveStrategyAudit.process(mutated, ctx, {
    token,
    acks: verifyAcks,
    answers: {
      literal_provenance: { endpoint: 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'rejected');
  assert.equal(second.rejection.reason, 'payload_changed');
  assert.ok(
    Array.isArray(second.rejection.payload_diff) && second.rejection.payload_diff.length > 0,
    'payload_diff should name the changed field(s) so the agent does not have to play detective',
  );
  assert.ok(
    second.rejection.payload_diff.some((p) => p.includes('endpoint')),
    `payload_diff should reference the changed endpoint field, got: ${JSON.stringify(second.rejection.payload_diff)}`,
  );
});

test('hash scoping: adding notes.save_warnings_acked keeps the audit token valid', () => {
  // The agent appends notes.save_warnings_acked when ack'ing a Level-2
  // warning (e.g. prereq_bind_key_mismatch). That mutation is metadata
  // about THIS save attempt — not a substantive change to the literals
  // the audit classified. Token must remain valid.
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/send',
    method: 'POST',
    headers: { 'x-nonce': '{{nonce}}' },
    body: { text: '{{text}}' },
    prerequisites: [
      {
        name: 'get_nonce',
        kind: 'js-eval',
        url: 'https://site.example.com/',
        expression: 'document.querySelector("meta[name=nonce]").content',
        binds: 'nonce',
        return_shape: { kind: 'string' },
      },
    ],
    notes: { params: { text: { description: 'body', kind: 'text', example: 'hi' } } },
  };
  const ctx = {
    capability: 'send_message',
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
  };
  
  const verifyAcks = {
    mutating_verification_required:
      'transaction-shape: response.extract grounds the verification (test default)',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks: verifyAcks });
  const token = first.rejection.token;

  const ackedStrategy = {
    ...strategy,
    notes: {
      ...strategy.notes,
      save_warnings_acked: [{ kind: 'prereq_bind_key_mismatch', reason: 'header alias intentional' }],
    },
  };
  const second = saveStrategyAudit.process(ackedStrategy, ctx, {
    token,
    acks: verifyAcks,
    answers: {
      literal_provenance: {
        endpoint: 'static',
        'prerequisites[0].url': 'static',
      },
      observed_siblings: {},
    },
  });
  assert.equal(
    second.status,
    'committed',
    `expected committed (only metadata changed); got ${JSON.stringify(second)}`,
  );
});

// Static-on-click-observed: when a literal scanned-field value contains a
// substring that matches a ParamObservation with source.kind="ui_click", the
// agent cannot escape grounding by classifying the literal as "static". Forces
// the agent to template + ground in notes.params.<name>.observed_values.
test('static-on-click-observed: rejects "static" when literal matches a ui_click observation', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://example.test',
    endpoint: '/api/repos?lang=rust',
    method: 'GET',
    headers: {},
    notes: {
      save_warnings_acked: [
        {
          kind: 'parameterization_disclosure_required',
          reason:
            'endpoint /api/repos contains the lang literal — parameterization gate is the literal_provenance gate under test here',
        },
      ],
    },
  };
  const result = runAudit(
    {
      capability: 'list_repos_in_lang',
      observedSiblings: [],
      observedParamValues: {
        lang: [
          {
            param_name: 'lang',
            value: 'rust',
            source: { kind: 'ui_click', label: 'Memory-safe systems' },
            observed_at: 1,
          },
        ],
      },
      capturedEndpointPaths: new Set(),
    },
    strategy,
    {
      literal_provenance: { endpoint: 'static' },
      observed_siblings: {},
    },
  );
  assert.equal(result.status, 'rejected');
  const issues = result.rejection.classifier_issues || [];
  const hit = issues.find((i) => /static.*UI click/.test(i));
  assert.ok(hit, `expected static-on-click-observed reject, got: ${JSON.stringify(issues)}`);
  assert.match(hit, /rust/);
  assert.match(hit, /Memory-safe systems/);
  assert.match(hit, /\{\{lang\}\}/);
});

// text_kind_justification escape hatch is closed when every observation for
// the param is a UI click (no captured non-click traffic supports the
// "free-form text" claim). Forces kind:"enum" instead of "I'll just call it
// text and move on" — the canned-escape pattern that previously let the agent
// bypass enum-grounding under the rejection prompt.
test('text_kind_justification: closed when all observations are clicks', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://example.test',
    endpoint: '/api/repos?lang={{lang}}',
    method: 'GET',
    headers: {},
    notes: {
      params: {
        lang: {
          kind: 'text',
          text_kind_justification:
            'lang is a slug accepted as free-form text by the API; clicks are just navigation aids.',
        },
      },
    },
  };
  const result = runAudit(
    {
      capability: 'list_repos_in_lang',
      observedSiblings: [],
      observedParamValues: {
        lang: [
          { param_name: 'lang', value: 'rust', source: { kind: 'ui_click', label: 'Memory-safe systems' }, observed_at: 1 },
          { param_name: 'lang', value: 'go', source: { kind: 'ui_click', label: 'Concurrent at heart' }, observed_at: 2 },
        ],
      },
      capturedEndpointPaths: new Set(['https://example.test/api/repos']),
    },
    strategy,
    {
      literal_provenance: { endpoint: { caller_input: 'lang' } },
      observed_siblings: {},
    },
  );
  assert.equal(result.status, 'rejected');
  const issues = result.rejection.classifier_issues || [];
  const hit = issues.find((i) => /text_kind_justification escape hatch is NOT available|justification path is not available/.test(i));
  assert.ok(hit, `expected justification-path-closed reject, got: ${JSON.stringify(issues)}`);
});

test('text_kind_justification: rejected when too short or canned (no observed-label reference)', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://example.test',
    endpoint: '/api/search?q={{q}}',
    method: 'GET',
    headers: {},
    notes: {
      params: {
        q: {
          kind: 'text',
          text_kind_justification: 'free-form text', // too short + no label reference
        },
      },
    },
  };
  const result = runAudit(
    {
      capability: 'search_things',
      observedSiblings: [],
      observedParamValues: {
        // Mix: one click observation + one api_response observation (typed-input
        // signal) — opens the justification path but the canned excuse still
        // fails the substantive-justification bar.
        q: [
          { param_name: 'q', value: 'tagged-suggestion-1', source: { kind: 'ui_click', label: 'Suggested phrase one' }, observed_at: 1 },
          { param_name: 'q', value: 'arbitrary-typed-input', source: { kind: 'api_response', label: 'arbitrary-typed-input' }, observed_at: 2 },
        ],
      },
      capturedEndpointPaths: new Set(['https://example.test/api/search']),
    },
    strategy,
    {
      literal_provenance: { endpoint: { caller_input: 'q' } },
      observed_siblings: {},
    },
  );
  assert.equal(result.status, 'rejected');
  const issues = result.rejection.classifier_issues || [];
  const hit = issues.find((i) => /too short/.test(i));
  assert.ok(hit, `expected too-short reject, got: ${JSON.stringify(issues)}`);
});

test('text_kind_justification: accepted when substantive AND references an observed click label', () => {
  const just =
    'Search endpoint fires from typed input AND from clicking suggestion tiles; clicked tile labels include "Suggested phrase one" — the same param carries both literal user queries and selected-suggestion labels.';
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://example.test',
    endpoint: '/api/search?q={{q}}',
    method: 'GET',
    headers: {},
    notes: {
      params: {
        q: {
          kind: 'text',
          text_kind_justification: just,
        },
      },
    },
  };
  const result = runAudit(
    {
      capability: 'search_things',
      observedSiblings: [],
      observedParamValues: {
        q: [
          { param_name: 'q', value: 'tagged-suggestion-1', source: { kind: 'ui_click', label: 'Suggested phrase one' }, observed_at: 1 },
          { param_name: 'q', value: 'arbitrary-typed-input', source: { kind: 'api_response', label: 'arbitrary-typed-input' }, observed_at: 2 },
        ],
      },
      capturedEndpointPaths: new Set(['https://example.test/api/search']),
    },
    strategy,
    {
      literal_provenance: { endpoint: { caller_input: 'q' } },
      observed_siblings: {},
    },
  );
  assert.equal(
    result.status,
    'committed',
    `expected committed; got ${JSON.stringify(result.rejection || result)}`,
  );
});

test('static-on-click-observed: accepts templated endpoint with grounded observed_values', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://example.test',
    endpoint: '/api/repos?lang={{lang}}',
    method: 'GET',
    headers: {},
    notes: {
      params: {
        lang: {
          kind: 'enum',
          observed_values: [
            { value: 'rust', label: 'Memory-safe systems' },
          ],
        },
      },
    },
  };
  const result = runAudit(
    {
      capability: 'list_repos_in_lang',
      observedSiblings: [],
      observedParamValues: {
        lang: [
          {
            param_name: 'lang',
            value: 'rust',
            source: { kind: 'ui_click', label: 'Memory-safe systems' },
            observed_at: 1,
          },
        ],
      },
      capturedEndpointPaths: new Set(['https://example.test/api/repos']),
    },
    strategy,
    {
      literal_provenance: { endpoint: { caller_input: 'lang' } },
      observed_siblings: {},
    },
  );
  assert.equal(
    result.status,
    'committed',
    `expected committed; got ${JSON.stringify(result.rejection || result)}`,
  );
});

// ----------------------------------------------------------------------
// user_confirmation Classifier — separate suite. Unregisters the default-
// approve decider so the tests exercise the real audit-answer path.
// ----------------------------------------------------------------------

function minimalStrategy() {
  return {
    strategy: 'page-script',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/items',
    method: 'GET',
    notes: {
      params: { cursor: { description: 'pagination', kind: 'text', example: '' } },
      anchor_type: 'dom',
    },
  };
}

function minimalCtx() {
  return {
    sessionId: 'sess_uc',
    platform: 'site',
    capability: 'list_items',
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
    observedUrls: ['https://site.example.com/api/items'],
  };
}

function reRegisterDefaultApprove() {
  registerSaveConfirmationDecider({
    name: 'pre-save-audit-test-default-approve',
    decide() {
      return { decision: 'approve', quote: 'default-approve in tests' };
    },
  });
}

test('user_confirmation: first call without decider issues token + prompt_for_user', () => {
  unregisterSaveConfirmationDecider('pre-save-audit-test-default-approve');
  try {
    const result = saveStrategyAudit.process(minimalStrategy(), minimalCtx(), {});
    assert.equal(result.status, 'rejected');
    assert.equal(result.rejection.reason, 'pending');
    assert.ok(result.rejection.token, 'token issued on first call');
    const items = result.rejection.items?.user_confirmation;
    assert.ok(items, 'items.user_confirmation present');
    const prompt = Array.isArray(items) ? items[0]?.prompt_for_user : items.prompt_for_user;
    assert.ok(prompt && typeof prompt === 'string', 'prompt_for_user is a string');
    assert.match(prompt, /Save this strategy/);
  } finally {
    reRegisterDefaultApprove();
  }
});

test('user_confirmation: second call with approve answer commits', () => {
  unregisterSaveConfirmationDecider('pre-save-audit-test-default-approve');
  try {
    const ctx = minimalCtx();
    const strategy = minimalStrategy();
    const first = saveStrategyAudit.process(strategy, ctx, {});
    const token = first.rejection.token;
    const result = saveStrategyAudit.process(strategy, ctx, {
      token,
      answers: {
        literal_provenance: { endpoint: 'static' },
        observed_siblings: {},
        user_confirmation: { user_decision: 'approve', user_quote: 'looks good, save it' },
      },
    });
    assert.equal(
      result.status,
      'committed',
      `expected committed; got ${JSON.stringify(result.rejection || result)}`,
    );
  } finally {
    reRegisterDefaultApprove();
  }
});

test('user_confirmation: reject decision rejects with go-back-to-LIFT prose', () => {
  unregisterSaveConfirmationDecider('pre-save-audit-test-default-approve');
  try {
    const ctx = minimalCtx();
    const strategy = minimalStrategy();
    const first = saveStrategyAudit.process(strategy, ctx, {});
    const token = first.rejection.token;
    const result = saveStrategyAudit.process(strategy, ctx, {
      token,
      answers: {
        literal_provenance: { endpoint: 'static' },
        observed_siblings: {},
        user_confirmation: {
          user_decision: 'reject',
          user_quote: 'no, I want a fetch tier instead',
        },
      },
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.rejection.reason, 'answers_inconsistent');
    const issues = result.rejection.classifier_issues || [];
    const userConfIssue = issues.find((i) => /user_confirmation/.test(i));
    assert.ok(userConfIssue, 'classifier_issues mentions user_confirmation');
    assert.match(userConfIssue, /Go back to LIFT/);
  } finally {
    reRegisterDefaultApprove();
  }
});

test('user_confirmation: missing answer with no decider rejects with shape error', () => {
  unregisterSaveConfirmationDecider('pre-save-audit-test-default-approve');
  try {
    const ctx = minimalCtx();
    const strategy = minimalStrategy();
    const first = saveStrategyAudit.process(strategy, ctx, {});
    const token = first.rejection.token;
    const result = saveStrategyAudit.process(strategy, ctx, {
      token,
      answers: {
        literal_provenance: { endpoint: 'static' },
        observed_siblings: {},
      },
    });
    assert.equal(result.status, 'rejected');
    const issues = result.rejection.classifier_issues || [];
    assert.ok(
      issues.some((i) => /audit_answers\.user_confirmation is required/.test(i)),
      'rejection mentions missing user_confirmation answer',
    );
  } finally {
    reRegisterDefaultApprove();
  }
});

test('user_confirmation: malformed answer (empty user_quote) rejects with shape error', () => {
  unregisterSaveConfirmationDecider('pre-save-audit-test-default-approve');
  try {
    const ctx = minimalCtx();
    const strategy = minimalStrategy();
    const first = saveStrategyAudit.process(strategy, ctx, {});
    const token = first.rejection.token;
    const result = saveStrategyAudit.process(strategy, ctx, {
      token,
      answers: {
        literal_provenance: { endpoint: 'static' },
        observed_siblings: {},
        user_confirmation: { user_decision: 'approve', user_quote: '' },
      },
    });
    assert.equal(result.status, 'rejected');
    const issues = result.rejection.classifier_issues || [];
    assert.ok(
      issues.some((i) => /user_quote/.test(i)),
      'rejection mentions empty user_quote',
    );
  } finally {
    reRegisterDefaultApprove();
  }
});

test('user_confirmation: composeUserPrompt covers recorded-path tier (forward-compat)', async () => {
  // Tier-agnostic prompt composition: even though recorded-path saves are
  // currently blocked at the LIFT layer, the prompt should still cover
  // recorded-path mechanically. When the LIFT block relaxes later, no
  // gate changes are needed.
  const { composeUserPrompt } = await import('../dist/audit/save-confirmation-prompt.js');
  const recordedPathStrategy = {
    strategy: 'recorded-path',
    steps: [
      { id: 's1', action: 'click', locators: { a11y: { role: 'textbox', name: 'Search' } } },
      { id: 's2', action: 'type', value: '{{q}}', locators: { a11y: { role: 'textbox', name: 'Search' } } },
      { id: 's3', action: 'click', locators: { a11y: { role: 'button', name: 'Submit' } } },
    ],
  };
  const prompt = composeUserPrompt(recordedPathStrategy, { capability: 'search' });
  assert.match(prompt, /recorded-path/);
  assert.match(prompt, /3 steps/);
  assert.match(prompt, /a11y-anchored locators/);
  assert.match(prompt, /Save this strategy/);
});

test('user_confirmation: hash binds to whole strategy — mutation invalidates token', () => {
  unregisterSaveConfirmationDecider('pre-save-audit-test-default-approve');
  try {
    const ctx = minimalCtx();
    const strategy = minimalStrategy();
    const first = saveStrategyAudit.process(strategy, ctx, {});
    const token = first.rejection.token;
    strategy.notes.anchor_type = 'module';
    const result = saveStrategyAudit.process(strategy, ctx, {
      token,
      answers: {
        literal_provenance: { endpoint: 'static' },
        observed_siblings: {},
        user_confirmation: { user_decision: 'approve', user_quote: 'fine' },
      },
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.rejection.reason, 'payload_changed');
    assert.ok(
      Array.isArray(result.rejection.payload_diff) &&
        result.rejection.payload_diff.some((p) => p.includes('anchor_type')),
      `payload_diff should name the anchor_type change, got: ${JSON.stringify(result.rejection.payload_diff)}`,
    );
  } finally {
    reRegisterDefaultApprove();
  }
});

// ----------------------------------------------------------------------
// mutating_verification_required Detector — every mutating-shaped save
// must declare a verification approach. Tests both anti-canned-ack and
// anchor-match cross-checks. Default-approve decider stays registered so
// the user_confirmation classifier auto-resolves; these tests focus on
// the verification detector's Stage-1 behavior.
// ----------------------------------------------------------------------

function verifyCtx(overrides = {}) {
  return {
    sessionId: 'sess_verify',
    platform: overrides.platform ?? 'site',
    capability: overrides.capability ?? 'send_message',
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
    observedUrls: overrides.observedUrls ?? ['https://site.example.com/api/send'],
  };
}

function mutatingPostStrategy(extras = {}) {
  // Default to fetch — mutating-verification detector fires on both fetch
  // and page-script for HTTP mutating verbs. Tests that need page-script
  // (e.g. frameFromPage) pass `tier: 'page-script'` and avoid `response`.
  const tier = extras.tier ?? 'fetch';
  const strategy = {
    strategy: tier,
    baseUrl: 'https://site.example.com',
    endpoint: '/api/send',
    method: 'POST',
    headers: {},
    body: { text: '{{text}}' },
    notes: {
      params: { text: { description: 'body', kind: 'text', example: 'hi' } },
      anchor_type: extras.anchor_type ?? 'unknown',
    },
  };
  if (tier !== 'page-script') {
    strategy.response = { extract: { message_id: 'data.message_id' } };
  }
  if (extras.frameFromPage) strategy.frameFromPage = extras.frameFromPage;
  return strategy;
}

test('verify-required: GET fetch is read-only — detector does not fire', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/items',
    method: 'GET',
    notes: {
      params: {},
      anchor_type: 'protocol',
      save_warnings_acked: [
        {
          kind: 'parameterization_disclosure_required',
          reason:
            'endpoint /api/items: GET-only listing for the verify-required detector test, no caller axis',
        },
      ],
    },
  };
  const result = saveStrategyAudit.process(strategy, verifyCtx({ observedUrls: ['https://site.example.com/api/items'] }), {});
  // First call may still mint token for classifiers (literal_provenance),
  // but the warnings list should not include mutating_verification_required.
  const warnings = result.rejection?.warnings ?? [];
  assert.equal(
    warnings.find((w) => w.kind === 'mutating_verification_required'),
    undefined,
    'GET strategy must not trip verification detector',
  );
});

test('verify-required: mutating POST with no ack → Stage-1 rejection with the warning', () => {
  const strategy = mutatingPostStrategy();
  const result = saveStrategyAudit.process(strategy, verifyCtx(), {});
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'unacked_warnings');
  const w = (result.rejection.warnings ?? []).find(
    (x) => x.kind === 'mutating_verification_required',
  );
  assert.ok(w, 'mutating_verification_required warning fires on POST');
  // Stage-1 rejection: no token, no items.
  assert.equal(result.rejection.token, undefined);
  assert.equal(result.rejection.items, undefined);
});

test('verify-required: ack with response.extract.message_id (path exists) → save commits', () => {
  const strategy = mutatingPostStrategy();
  const ctx = verifyCtx();
  const acks = {
    mutating_verification_required:
      'response.extract.message_id pulls server-issued id; absence = failure',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.rejection.reason, 'pending');
  const token = first.rejection.token;
  const second = saveStrategyAudit.process(strategy, ctx, {
    token,
    acks,
    answers: {
      literal_provenance: { endpoint: 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'committed', JSON.stringify(second));
});

test('verify-required: ack referencing fabricated path → ack rejected', () => {
  // Strategy intentionally has NO response.extract so no `response.*`
  // tokens land in valid_paths. The reason names a fabricated path AND
  // has no shape tag → fails the anti-canned check.
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/send',
    method: 'POST',
    headers: {},
    body: { text: '{{text}}' },
    notes: {
      params: { text: { description: 'body', kind: 'text', example: 'hi' } },
      anchor_type: 'unknown',
    },
  };
  const ctx = verifyCtx();
  const acks = {
    mutating_verification_required: 'totally.unrelated.path proves it',
  };
  const result = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'unacked_warnings');
  const ackIssues = result.rejection.ack_issues ?? [];
  assert.ok(
    ackIssues.some((i) => /reason must name the verification approach/.test(i)),
    `expected anti-canned rejection; got ${JSON.stringify(ackIssues)}`,
  );
});

test('verify-required: ack with transaction-shape literal tag → save commits', () => {
  const strategy = mutatingPostStrategy();
  const ctx = verifyCtx();
  const acks = {
    mutating_verification_required: 'transaction-shape: server returns confirmation',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.rejection.reason, 'pending');
  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    acks,
    answers: {
      literal_provenance: { endpoint: 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'committed', JSON.stringify(second));
});

test('verify-required: ack with fire-and-forget + telemetry noun → save commits', () => {
  const strategy = mutatingPostStrategy();
  const ctx = verifyCtx();
  const acks = {
    mutating_verification_required:
      'fire-and-forget — analytics telemetry beacon, idempotent on the server',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.rejection.reason, 'pending');
  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    acks,
    answers: {
      literal_provenance: { endpoint: 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'committed', JSON.stringify(second));
});

test('verify-required: ack with rpc-read tag → save commits (POST envelope, read operation)', () => {
  const strategy = mutatingPostStrategy();
  const ctx = verifyCtx();
  const acks = {
    mutating_verification_required:
      'rpc-read: GraphQL query, response.data is the payload — no side effect to verify',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.rejection.reason, 'pending');
  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    acks,
    answers: {
      literal_provenance: { endpoint: 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'committed', JSON.stringify(second));
});

test('verify-required: ack with fire-and-forget but no justifying noun → ack rejected', () => {
  const strategy = mutatingPostStrategy();
  const ctx = verifyCtx();
  const acks = {
    mutating_verification_required: 'fire-and-forget — no verification needed',
  };
  const result = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(result.status, 'rejected');
  const ackIssues = result.rejection.ack_issues ?? [];
  assert.ok(
    ackIssues.some((i) => /fire-and-forget tag requires a justifying noun/.test(i)),
    `expected fire-and-forget noun rejection; got ${JSON.stringify(ackIssues)}`,
  );
});

test('verify-required: ack with prose-only reason → ack rejected', () => {
  const strategy = mutatingPostStrategy();
  const ctx = verifyCtx();
  const acks = {
    mutating_verification_required: 'looks fine to me, intentional',
  };
  const result = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(result.status, 'rejected');
  const ackIssues = result.rejection.ack_issues ?? [];
  assert.ok(
    ackIssues.some((i) => /reason must name the verification approach/.test(i)),
    `expected prose-only rejection; got ${JSON.stringify(ackIssues)}`,
  );
});

test('verify-required: recorded-path with type+submit and no ack → warning fires', () => {
  const strategy = {
    strategy: 'recorded-path',
    steps: [
      { id: 's1', action: 'click', locators: { a11y: { role: 'textbox', name: 'Box' } } },
      { id: 's2', action: 'type', value: '{{text}}', locators: { a11y: { role: 'textbox', name: 'Box' } } },
      { id: 's3', action: 'submit', locators: { a11y: { role: 'button', name: 'Send' } } },
    ],
    notes: { params: { text: { description: 'body', kind: 'text', example: 'hi' } }, anchor_type: 'dom' },
  };
  const result = saveStrategyAudit.process(strategy, verifyCtx(), {});
  const w = (result.rejection.warnings ?? []).find(
    (x) => x.kind === 'mutating_verification_required',
  );
  assert.ok(w, 'recorded-path with type/submit must trip the detector');
});

test('verify-required: recorded-path acked with steps[N] reference → save commits', () => {
  const strategy = {
    strategy: 'recorded-path',
    steps: [
      { id: 's1', action: 'click', locators: { a11y: { role: 'textbox', name: 'Box' } } },
      { id: 's2', action: 'type', value: '{{text}}', locators: { a11y: { role: 'textbox', name: 'Box' } } },
      { id: 's3', action: 'submit', locators: { a11y: { role: 'button', name: 'Send' } } },
      { id: 's4', action: 'click', locators: { a11y: { role: 'button', name: 'Confirm' } } },
      { id: 's5', action: 'click', locators: { a11y: { role: 'button', name: 'Done' } } },
      { id: 's6', action: 'click', locators: { a11y: { role: 'status', name: 'Sent' } } },
    ],
    notes: { params: { text: { description: 'body', kind: 'text', example: 'hi' } }, anchor_type: 'dom' },
  };
  const ctx = verifyCtx({ observedUrls: [] });
  const acks = {
    mutating_verification_required: 'dom-poll: steps[5] confirms the "Sent" status element appears',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.rejection.reason, 'pending', JSON.stringify(first.rejection));
  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    acks,
    answers: { literal_provenance: {}, observed_siblings: {} },
  });
  assert.equal(second.status, 'committed', JSON.stringify(second));
});

test('verify-required: page-script with .publish( + ack referencing frameFromPage.expression → save commits', () => {
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/ws_send',
    method: 'POST',
    frameFromPage: {
      expression: 'window.__chan.publish({to: args.thread, text: args.text})',
    },
    notes: { params: { text: { description: 'body', kind: 'text', example: 'hi' } }, anchor_type: 'module' },
  };
  const ctx = verifyCtx({ observedUrls: ['https://site.example.com/api/ws_send'] });
  const acks = {
    mutating_verification_required:
      'chat-shape: frameFromPage.expression awaits publish ack via window.require module before returning',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.rejection.reason, 'pending', JSON.stringify(first.rejection));
  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    acks,
    answers: { literal_provenance: { endpoint: 'static' }, observed_siblings: {} },
  });
  assert.equal(second.status, 'committed', JSON.stringify(second));
});

test('verify-required: anchor-match — module-anchored + dom-poll only → ack rejected', () => {
  const strategy = mutatingPostStrategy({ anchor_type: 'module' });
  const ctx = verifyCtx();
  const acks = {
    mutating_verification_required: 'dom-poll: verify_sent js-eval polls .toast for 2s',
  };
  const result = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(result.status, 'rejected');
  const ackIssues = result.rejection.ack_issues ?? [];
  assert.ok(
    ackIssues.some((i) => /anchor mismatch/.test(i)),
    `expected anchor-mismatch rejection; got ${JSON.stringify(ackIssues)}`,
  );
});

test('verify-required: anchor-match — module-anchored + transaction-shape with response.extract.id → save commits', () => {
  const strategy = mutatingPostStrategy({ anchor_type: 'module' });
  const ctx = verifyCtx();
  const acks = {
    mutating_verification_required:
      'transaction-shape: response.extract.message_id grounds the verification',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.rejection.reason, 'pending', JSON.stringify(first.rejection));
  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    acks,
    answers: {
      literal_provenance: { endpoint: 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'committed', JSON.stringify(second));
});

test('verify-required: anchor-match — module-anchored + chat-shape with window.require readback → save commits', () => {
  const strategy = mutatingPostStrategy({ anchor_type: 'module' });
  const ctx = verifyCtx();
  const acks = {
    mutating_verification_required:
      'chat-shape: window.require("ChatStore") page-global readback after publish',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.rejection.reason, 'pending', JSON.stringify(first.rejection));
  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    acks,
    answers: {
      literal_provenance: { endpoint: 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'committed', JSON.stringify(second));
});

test('verify-required: fetch with protocol="websocket" → detector fires (binary WS publish)', () => {
  const strategy = {
    strategy: 'fetch',
    origin: 'https://site.example.com',
    protocol: 'websocket',
    wsUrl: 'wss://site.example.com/chat',
    frameEncoding: 'binary',
    generated: { frame: { code: '() => Buffer.from([0x32])' } },
    notes: { params: { text: { description: 'msg', kind: 'text', example: 'hi' } }, anchor_type: 'protocol' },
  };
  const ctx = verifyCtx({ observedUrls: ['wss://site.example.com/chat'] });
  const result = saveStrategyAudit.process(strategy, ctx, {});
  const w = (result.rejection.warnings ?? []).find(
    (x) => x.kind === 'mutating_verification_required',
  );
  assert.ok(w, 'fetch+protocol:websocket must trip the detector');
  assert.match(w.message, /fetch with protocol="websocket"/);
});

test('verify-required: anchor-match — protocol-anchored + dom-poll only → ack rejected', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/send',
    method: 'POST',
    headers: {},
    body: { text: '{{text}}' },
    notes: { params: { text: { description: 'body', kind: 'text', example: 'hi' } }, anchor_type: 'protocol' },
  };
  const ctx = verifyCtx();
  const acks = {
    mutating_verification_required: 'dom-poll: js-eval polls toast indicator',
  };
  const result = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(result.status, 'rejected');
  const ackIssues = result.rejection.ack_issues ?? [];
  assert.ok(
    ackIssues.some((i) => /anchor mismatch/.test(i)),
    `expected anchor-mismatch on protocol-anchored fetch; got ${JSON.stringify(ackIssues)}`,
  );
});

test('verify-required: anchor-match — dom-anchored + dom-poll → save commits (DOM is the floor)', () => {
  const strategy = mutatingPostStrategy({ anchor_type: 'dom' });
  const ctx = verifyCtx();
  const acks = {
    mutating_verification_required: 'dom-poll: verify_sent js-eval polls .toast-success after publish',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.rejection.reason, 'pending', JSON.stringify(first.rejection));
  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    acks,
    answers: {
      literal_provenance: { endpoint: 'static' },
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'committed', JSON.stringify(second));
});

// ----------------------------------------------------------------------
// parameterization_disclosure_required Detector — every saved strategy
// must declare notes.params or ack with a structurally-grounded reason.
// ----------------------------------------------------------------------

function paramlessGetStrategy(extras = {}) {
  return {
    strategy: 'fetch',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/feed',
    method: 'GET',
    headers: {},
    notes: {
      anchor_type: 'unknown',
      ...extras.notes,
    },
  };
}

test('parameterization: notes.params absent + no ack → warning fires', () => {
  const strategy = paramlessGetStrategy();
  const result = saveStrategyAudit.process(strategy, verifyCtx({ observedUrls: ['https://site.example.com/api/feed'] }), {});
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'unacked_warnings');
  const w = (result.rejection.warnings ?? []).find(
    (x) => x.kind === 'parameterization_disclosure_required',
  );
  assert.ok(w, 'parameterization warning must fire on paramless strategy');
});

test('parameterization: notes.params empty object + no ack → warning fires', () => {
  const strategy = paramlessGetStrategy({ notes: { params: {} } });
  const result = saveStrategyAudit.process(strategy, verifyCtx({ observedUrls: ['https://site.example.com/api/feed'] }), {});
  const w = (result.rejection.warnings ?? []).find(
    (x) => x.kind === 'parameterization_disclosure_required',
  );
  assert.ok(w, 'parameterization warning must fire on empty notes.params');
});

test('parameterization: notes.params populated → detector silent', () => {
  const strategy = paramlessGetStrategy({
    notes: { params: { count: { description: 'limit', kind: 'text', example: '10' } } },
  });
  const result = saveStrategyAudit.process(strategy, verifyCtx({ observedUrls: ['https://site.example.com/api/feed'] }), {});
  const w = (result.rejection?.warnings ?? []).find(
    (x) => x.kind === 'parameterization_disclosure_required',
  );
  assert.equal(w, undefined, 'detector must not fire when params declared');
});

test('parameterization: ack referencing endpoint anchor → save commits', () => {
  const strategy = paramlessGetStrategy();
  const ctx = verifyCtx({ observedUrls: ['https://site.example.com/api/feed'] });
  const acks = {
    parameterization_disclosure_required:
      'endpoint /api/feed: GET viewer-scoped feed with no caller axis',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.rejection.reason, 'pending', JSON.stringify(first.rejection));
  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    acks,
    answers: { literal_provenance: { endpoint: 'static' }, observed_siblings: {} },
  });
  assert.equal(second.status, 'committed', JSON.stringify(second));
});

test('parameterization: ack referencing prereq name → save commits', () => {
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/whoami',
    method: 'GET',
    headers: { 'x-csrf': '{{csrf}}' },
    prerequisites: [
      {
        name: 'csrf',
        kind: 'js-eval',
        url: 'https://site.example.com/',
        expression: 'document.cookie',
        binds: 'csrf',
        return_shape: { kind: 'string', min_length: 4 },
      },
    ],
    notes: { anchor_type: 'dom' },
  };
  const ctx = verifyCtx({ observedUrls: ['https://site.example.com/api/whoami', 'https://site.example.com/'] });
  const acks = {
    parameterization_disclosure_required:
      'prereq csrf covers the only varying header value; endpoint /api/whoami is viewer-scoped, no body, no caller axis',
  };
  const first = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(first.rejection.reason, 'pending', JSON.stringify(first.rejection));
  const second = saveStrategyAudit.process(strategy, ctx, {
    token: first.rejection.token,
    acks,
    answers: {
      literal_provenance: {
        endpoint: 'static',
        'prerequisites[0].url': 'static',
      },
      observed_siblings: {},
    },
  });
  assert.equal(second.status, 'committed', JSON.stringify(second));
});

test('parameterization: bare-prose ack with no structural anchor → ack rejected', () => {
  const strategy = paramlessGetStrategy();
  const ctx = verifyCtx({ observedUrls: ['https://site.example.com/api/feed'] });
  const acks = {
    parameterization_disclosure_required: 'this capability is intentionally parameterless',
  };
  const result = saveStrategyAudit.process(strategy, ctx, { acks });
  assert.equal(result.status, 'rejected');
  const ackIssues = result.rejection.ack_issues ?? [];
  assert.ok(
    ackIssues.some((i) => /must reference at least one structural anchor/.test(i)),
    `expected anti-canned rejection; got ${JSON.stringify(ackIssues)}`,
  );
});

test('parameterization: hash-scope — adding notes.params clears warning without re-acking siblings', () => {
  // Stage 1: paramless — warning fires, ack with structural anchor commits.
  const paramless = paramlessGetStrategy();
  const ctx = verifyCtx({ observedUrls: ['https://site.example.com/api/feed'] });
  const acks = {
    parameterization_disclosure_required: 'endpoint /api/feed: viewer-scoped',
  };
  const first = saveStrategyAudit.process(paramless, ctx, { acks });
  assert.equal(first.rejection.reason, 'pending');

  // Stage 2: agent declares params — detector silent now. Re-call without
  // any ack; the warning shouldn't fire so the ack list isn't needed.
  const parameterized = paramlessGetStrategy({
    notes: { params: { count: { description: 'limit', kind: 'text', example: '10' } } },
  });
  const after = saveStrategyAudit.process(parameterized, ctx, {});
  const w = (after.rejection?.warnings ?? []).find(
    (x) => x.kind === 'parameterization_disclosure_required',
  );
  assert.equal(w, undefined, 'detector silent after params declared');
});
