// C1: a declared collection that came back empty must never auto-promote.
//
// The assessor is strategy-aware and lives outside `classifyFactoryExecutionResult`
// on purpose — the six-state classifier is switched on by rediscover,
// start-session, the checkpoint API and the execute cascade, and a seventh state
// would silently change gate behavior at every one of them. These tests pin the
// assessor's declaration sources plus the two consumption sites.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-empty-collection-'));
process.env.KLURA_HOME = TMP;

const { assessDeclaredCollectionEmptiness, describeDeclaredCollectionEmptiness } = await import(
  '../dist/execution/collection-emptiness.js'
);
const { classifyFactoryExecutionResult } = await import(
  '../dist/execution/result-classification.js'
);
const skills = await import('../dist/strategies/skills.js');
const { verifySavedStrategy, verifyStrategyCandidate } = await import(
  '../dist/strategies/verify-saved-strategy.js'
);

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------- assessor: the declaration sources ----------

test('case 1: response.extract multiple:true + empty rows → declared_collection_empty', () => {
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://x.test',
    response: { format: 'html', extract: { rows: { selector: '.row', multiple: true } } },
  };
  const assessment = assessDeclaredCollectionEmptiness(strategy, { rows: [] });
  assert.equal(assessment.reason, 'declared_collection_empty');
  assert.equal(assessment.source, 'response_extract_multiple');
  assert.equal(assessment.result_shape, 'object');
  assert.deepEqual(assessment.keys, ['rows']);
  assert.match(describeDeclaredCollectionEmptiness(assessment), /multiple: true/);
});

test('case 2: response.extract multiple:true with rows present → no assessment', () => {
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://x.test',
    response: { format: 'html', extract: { rows: { selector: '.row', multiple: true } } },
  };
  assert.equal(assessDeclaredCollectionEmptiness(strategy, { rows: [{ title: 'a' }] }), null);
});

test('case 3: response.from → prereq return_shape kind "array", empty body → declared empty', () => {
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://x.test',
    prerequisites: [
      {
        name: 'listing',
        kind: 'js-eval',
        url: 'https://x.test/list',
        expression: 'JSON.parse(document.body.innerText)',
        binds: 'listing',
        return_shape: { kind: 'array' },
      },
    ],
    response: { from: 'listing', format: 'json' },
  };
  const assessment = assessDeclaredCollectionEmptiness(strategy, []);
  assert.equal(assessment.source, 'prereq_array_return_shape');
  assert.equal(assessment.result_shape, 'array');
  assert.deepEqual(assessment.keys, []);
});

test('case 4: same array-declaring prereq with items → no assessment', () => {
  const strategy = {
    strategy: 'page-script',
    baseUrl: 'https://x.test',
    prerequisites: [
      {
        name: 'listing',
        kind: 'js-eval',
        url: 'https://x.test/list',
        expression: 'JSON.parse(document.body.innerText)',
        binds: 'listing',
        return_shape: { kind: 'array' },
      },
    ],
    response: { from: 'listing', format: 'json' },
  };
  assert.equal(assessDeclaredCollectionEmptiness(strategy, [{ id: 1 }]), null);
});

test('case 5: derived fallback — hand-built {ok:true, items:[]} with no response.extract', () => {
  // The observed failure: a page-script assembles its own envelope, so neither
  // explicit declaration source exists.
  const strategy = { strategy: 'page-script', baseUrl: 'https://x.test', script: 'return {}' };
  const assessment = assessDeclaredCollectionEmptiness(strategy, { ok: true, items: [] });
  assert.equal(assessment.source, 'derived_empty_arrays');
  assert.deepEqual(assessment.keys, ['items']);
});

test('case 6: derived fallback requires EVERY array-valued property to be empty', () => {
  const strategy = { strategy: 'page-script', baseUrl: 'https://x.test', script: 'return {}' };
  assert.equal(
    assessDeclaredCollectionEmptiness(strategy, { ok: true, items: [], errors: [{ code: 'x' }] }),
    null,
  );
});

test('case 7: an object body with no array-valued property is not a collection', () => {
  const strategy = { strategy: 'page-script', baseUrl: 'https://x.test', script: 'return {}' };
  assert.equal(assessDeclaredCollectionEmptiness(strategy, { ok: true, count: 0 }), null);
});

// ---------- assessor: shapes that must never downgrade ----------

test('a compacted / truncated string body is not inspectable and never downgrades', () => {
  const strategy = { strategy: 'page-script', baseUrl: 'https://x.test', script: 'return {}' };
  assert.equal(
    assessDeclaredCollectionEmptiness(strategy, '<truncated string body: 900000 chars>'),
    null,
  );
});

test('a bare empty array with no array declaration does not downgrade', () => {
  const strategy = { strategy: 'fetch', baseUrl: 'https://x.test', endpoint: '/api' };
  assert.equal(assessDeclaredCollectionEmptiness(strategy, []), null);
});

test('nested arrays are out of scope — only own properties are read', () => {
  const strategy = { strategy: 'page-script', baseUrl: 'https://x.test', script: 'return {}' };
  assert.equal(assessDeclaredCollectionEmptiness(strategy, { ok: true, data: { items: [] } }), null);
});

test('a missing or non-object strategy never downgrades', () => {
  assert.equal(assessDeclaredCollectionEmptiness(undefined, { ok: true, items: [] }), null);
  assert.equal(assessDeclaredCollectionEmptiness('page-script', { ok: true, items: [] }), null);
});

test('classifyFactoryExecutionResult is untouched by the assessor', () => {
  assert.equal(
    classifyFactoryExecutionResult({ status: 200, body: { ok: true, items: [] } }),
    'explicit_success',
  );
});

// ---------- consumption: post-save verification ----------

function emptyCollectionStrategy() {
  return {
    strategy: 'page-script',
    baseUrl: 'https://example.test',
    prerequisites: [
      {
        name: 'result',
        kind: 'js-eval',
        url: 'https://example.test/list',
        expression: 'JSON.stringify({ ok: true, items: [] })',
        binds: 'result',
        return_shape: { kind: 'string' },
      },
    ],
    response: { from: 'result', format: 'json' },
  };
}

function populatedCollectionStrategy() {
  return {
    strategy: 'page-script',
    baseUrl: 'https://example.test',
    prerequisites: [
      {
        name: 'result',
        kind: 'js-eval',
        url: 'https://example.test/list',
        expression: 'JSON.stringify({ ok: true, items: [{ id: 1 }] })',
        binds: 'result',
        return_shape: { kind: 'string' },
      },
    ],
    response: { from: 'result', format: 'json' },
  };
}

function makePool(payload) {
  const urls = new Map();
  const ended = [];
  let nextSession = 0;
  const driver = {
    async getUrl(session) {
      return urls.get(session.id) ?? 'about:blank';
    },
    async navigate(session, url) {
      urls.set(session.id, url);
    },
    async evaluateExpression() {
      return JSON.stringify(payload);
    },
  };
  return {
    ended,
    pool: {
      async createSession() {
        const session = { id: `s-${++nextSession}`, intercepted: [], intercepting: false };
        urls.set(session.id, 'about:blank');
        return session;
      },
      createNodeOnlySession() {
        throw new Error('unexpected node-only session');
      },
      async endDrive(sessionId) {
        ended.push(sessionId);
      },
      getSession(sessionId) {
        return { id: sessionId, intercepted: [], intercepting: false };
      },
      driverFor() {
        return driver;
      },
      async shutdown() {},
      get activeSessions() {
        return 0;
      },
      get activeSessionIds() {
        return [];
      },
      get idleSince() {
        return 0;
      },
      get connectEnabled() {
        return false;
      },
    },
  };
}

test('active save: ok:true over an empty declared collection stamps transport_passed, not passed', async () => {
  const platform = 'empty-active';
  const capability = 'list_things';
  skills.commitValidatedStrategy(platform, capability, emptyCollectionStrategy());
  const state = makePool({ ok: true, items: [] });

  const result = await verifySavedStrategy(platform, capability, {}, state.pool);

  assert.equal(result.ok, false);
  assert.equal(result.classification, 'transport_accepted');
  assert.equal(result.semantic_review_reason, 'declared_collection_empty');
  assert.deepEqual(result.collection_keys, ['items']);
  assert.match(result.message, /post_save_validation_empty_collection/);
  // The bare-transport wording is factually wrong for a body that DID carry ok.
  assert.doesNotMatch(result.message, /no explicit boolean body\.ok/);

  const saved = skills.loadStrategy(platform, capability);
  assert.equal(saved.runtime_meta.post_save_validation, 'transport_passed');
});

test('active save: a populated collection still stamps passed', async () => {
  const platform = 'populated-active';
  const capability = 'list_things';
  skills.commitValidatedStrategy(platform, capability, populatedCollectionStrategy());
  const state = makePool({ ok: true, items: [{ id: 1 }] });

  const result = await verifySavedStrategy(platform, capability, {}, state.pool);

  assert.equal(result.ok, true);
  assert.equal(result.classification, 'explicit_success');
  assert.equal(result.semantic_review_reason, undefined);

  const saved = skills.loadStrategy(platform, capability);
  assert.equal(saved.runtime_meta.post_save_validation, 'passed');
});

test('candidate: an empty declared collection stays inactive and goes to semantic review', async () => {
  const platform = 'empty-candidate';
  const capability = 'list_things';
  const ref = skills.stageValidatedStrategyCandidate(
    platform,
    capability,
    emptyCollectionStrategy(),
  );
  const state = makePool({ ok: true, items: [] });

  const result = await verifyStrategyCandidate(ref, {}, state.pool);

  assert.equal(result.ok, false);
  assert.equal(result.active, false);
  assert.equal(result.state, 'candidate');
  assert.equal(result.classification, 'transport_accepted');
  assert.equal(result.semantic_review_required, true);
  assert.equal(result.semantic_review_reason, 'declared_collection_empty');
  assert.deepEqual(result.collection_keys, ['items']);
  assert.match(result.message, /strategy_candidate_semantic_review_required/);
  assert.doesNotMatch(result.message, /no explicit boolean body\.ok/);
});

test('candidate: review_strategy_candidate renders why the verdict is needed', async () => {
  const platform = 'empty-candidate-review';
  const capability = 'list_things';
  const ref = skills.stageValidatedStrategyCandidate(
    platform,
    capability,
    emptyCollectionStrategy(),
  );
  const state = makePool({ ok: true, items: [] });
  const verified = await verifyStrategyCandidate(ref, {}, state.pool);

  const { reviewStrategyCandidate } = await import('../dist/tools/review-strategy-candidate.js');
  const review = reviewStrategyCandidate({
    platform,
    capability,
    candidate_id: ref.candidate_id,
    evidence_digest: verified.evidence_digest,
  });

  assert.equal(review.review_required, true);
  assert.equal(review.semantic_review_reason, 'declared_collection_empty');
  assert.deepEqual(review.collection_keys, ['items']);
  assert.match(review.semantic_review_detail, /zero rows/);
});

test('candidate: a populated collection promotes as before', async () => {
  const platform = 'populated-candidate';
  const capability = 'list_things';
  const ref = skills.stageValidatedStrategyCandidate(
    platform,
    capability,
    populatedCollectionStrategy(),
  );
  const state = makePool({ ok: true, items: [{ id: 1 }] });

  const result = await verifyStrategyCandidate(ref, {}, state.pool);

  assert.equal(result.ok, true);
  assert.equal(result.active, true);
  assert.equal(result.classification, 'explicit_success');
  assert.equal(result.semantic_review_reason, undefined);
});
