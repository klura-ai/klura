// user_confirmation classifier: map-graph sessions skip the gate entirely.
//
// Map-mode is user-pre-authorized exploration ("map this site and save
// every safe read-only capability"). Per-capability re-confirmation is
// friction without value in attended mode; in unattended runs (the loop's
// primary use case) agents end up recycling task prompts as user_quote
// and stalling on freshness rejection. Skip via buildItems → null.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { userConfirmationClassifier } = await import(
  '../dist/audit/lift/save-strategy-classifiers.js'
);

function makeStrategy() {
  return {
    schema_version: 1,
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://example.test',
    endpoint: '/api/items',
    notes: { params: {} },
  };
}

function makeCtx(overrides = {}) {
  return {
    sessionId: 'sess-test',
    platform: 'p',
    capability: 'list_items',
    session: {
      id: 'sess-test',
      platform: 'p',
      graph: 'discover',
      ...((overrides.session ?? {})),
    },
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
    observedUrls: [],
    ...overrides,
  };
}

test('user_confirmation: map-graph session → buildItems returns null (classifier skipped)', () => {
  const ctx = makeCtx({ session: { id: 'sess', platform: 'p', graph: 'map' } });
  const items = userConfirmationClassifier.buildItems(makeStrategy(), ctx);
  assert.equal(items, null, 'map-graph must skip user_confirmation entirely');
});

test('user_confirmation: discover-graph session → buildItems returns required_facts', () => {
  const ctx = makeCtx({ session: { id: 'sess', platform: 'p', graph: 'discover' } });
  const items = userConfirmationClassifier.buildItems(makeStrategy(), ctx);
  assert.ok(items, 'discover-graph must still emit items');
  assert.ok(typeof items === 'object' && 'required_facts' in items);
});

test('user_confirmation: ctx.session undefined → still emits (defensive, attended)', () => {
  const ctx = makeCtx();
  delete ctx.session;
  const items = userConfirmationClassifier.buildItems(makeStrategy(), ctx);
  assert.ok(items, 'missing session info defaults to emitting (safe fallback)');
});

test('user_confirmation: agent_note leads with UNATTENDED-FIRST', () => {
  const ctx = makeCtx();
  const items = userConfirmationClassifier.buildItems(makeStrategy(), ctx);
  assert.ok(items && typeof items === 'object');
  const note = items.agent_note;
  assert.match(note, /^UNATTENDED-FIRST/, 'agent_note must lead with unattended path');
  assert.match(
    note,
    /SaveConfirmationDecider/,
    'agent_note must mention the decider mechanism',
  );
});

test('user_confirmation: missing-answer validation prose mentions unattended path', () => {
  const ctx = makeCtx();
  const issues = userConfirmationClassifier.validate(makeStrategy(), ctx, undefined);
  assert.ok(issues.length > 0);
  const combined = issues.join(' ');
  assert.match(combined, /UNATTENDED RUNS/, 'rejection prose must surface unattended path');
  assert.match(
    combined,
    /do NOT compose a prompt and recycle the task prompt/i,
    'rejection prose must call out the specific failure mode (recycled prompt)',
  );
});
