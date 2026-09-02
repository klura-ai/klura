// A collection can come back with rows whose every value matches the page
// character-for-character and still break its contract. Three structural checks
// catch the partially-broken cases the empty-collection assessor cannot see:
//
//   A. a declared item field that is null in EVERY row (dead extraction path),
//   B. two runs with identical args that disagree about rows (flaky feed),
//   C. page 1 and page 2 that share rows (the page param did nothing).
//
// These tests pin each assessor, the config knobs that disable the two checks
// that cost an extra execution, and the two post-save consumption sites. The
// empty-collection behavior they extend is pinned in empty-collection-review.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-collection-integrity-'));
process.env.KLURA_HOME = TMP;

const {
  advancePaginationValue,
  assessCollectionStability,
  assessDeclaredCollectionEmptiness,
  assessPaginationDisjointness,
  assessUniformNullFields,
  declaredPaginationParams,
  describeCollectionIntegrityFinding,
  locateDeclaredCollections,
  paginationCandidateParams,
} = await import('../dist/execution/collection-emptiness.js');
const { detectUnansweredPaginationQuestion } = await import(
  '../dist/gate/save-warnings-pagination.js'
);
const { saveStrategyAudit } = await import('../dist/audit/lift/save-strategy.js');
const skills = await import('../dist/strategies/skills.js');
const { verifySavedStrategy, verifyStrategyCandidate } = await import(
  '../dist/strategies/verify-saved-strategy.js'
);

const CONFIG_PATH = path.join(TMP, 'config.json');

function withAuditConfig(audit) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ audit }));
}

function clearConfig() {
  fs.rmSync(CONFIG_PATH, { force: true });
}

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// A page-script whose whole result is a `multiple: true` row list, so the
// explicit declaration source is exercised rather than the derived fallback.
function extractStrategy() {
  return {
    strategy: 'page-script',
    baseUrl: 'https://x.test',
    response: { format: 'html', extract: { rows: { selector: '.row', multiple: true } } },
  };
}

// ---------- check A: uniform-null declared field ----------

test('A: a field null in every row flags, and names the partial sibling as evidence', () => {
  const body = {
    rows: [
      { name: 'a', price: '$1', image_url: null },
      { name: 'b', price: null, image_url: null },
      { name: 'c', price: '$3', image_url: null },
    ],
  };
  const findings = assessUniformNullFields(extractStrategy(), body);
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding.reason, 'collection_field_uniformly_null');
  assert.equal(finding.field, 'image_url');
  assert.equal(finding.collection_key, 'rows');
  assert.equal(finding.row_count, 3);
  assert.deepEqual(finding.partial_null_siblings, ['price']);
  const prose = describeCollectionIntegrityFinding(finding);
  assert.match(prose, /image_url/);
  assert.match(prose, /all 3 rows/);
  assert.match(prose, /price/);
  assert.match(prose, /dead extraction path/);
});

test('A: an absent key counts the same as an explicit null', () => {
  const body = { rows: [{ name: 'a', price: '$1' }, { name: 'b' }, { name: 'c', price: '$3' }] };
  const findings = assessUniformNullFields(extractStrategy(), body);
  assert.deepEqual(findings, []);
});

test('A: no partial sibling still flags, but says the evidence is weaker', () => {
  const body = {
    rows: [
      { name: 'a', image_url: null },
      { name: 'b', image_url: null },
    ],
  };
  const findings = assessUniformNullFields(extractStrategy(), body);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, 'image_url');
  assert.deepEqual(findings[0].partial_null_siblings, []);
  const prose = describeCollectionIntegrityFinding(findings[0]);
  assert.match(prose, /no sibling field/);
  assert.match(prose, /weaker evidence/);
});

test('A: a single-row collection never flags — one null carries no signal', () => {
  const body = { rows: [{ name: 'a', image_url: null }] };
  assert.deepEqual(assessUniformNullFields(extractStrategy(), body), []);
});

test('A: a healthy multi-row collection with a legitimately-absent field flags nothing', () => {
  const body = {
    rows: [
      { name: 'a', price: '$1', image_url: 'https://x.test/a.png' },
      { name: 'b', price: null, image_url: 'https://x.test/b.png' },
      { name: 'c', price: '$3', image_url: null },
    ],
  };
  assert.deepEqual(assessUniformNullFields(extractStrategy(), body), []);
});

test('A: every uniformly-null field gets its own finding', () => {
  const body = {
    rows: [
      { name: 'a', image_url: null, rating: null },
      { name: 'b', image_url: null, rating: null },
    ],
  };
  const findings = assessUniformNullFields(extractStrategy(), body);
  assert.deepEqual(
    findings.map((f) => f.field),
    ['image_url', 'rating'],
  );
});

test('A: scalar rows have no fields to assess', () => {
  assert.deepEqual(assessUniformNullFields(extractStrategy(), { rows: ['a', 'b', 'c'] }), []);
});

test('A: a body with no declared collection is out of scope', () => {
  assert.deepEqual(assessUniformNullFields(extractStrategy(), 'not json'), []);
  assert.deepEqual(assessUniformNullFields(undefined, { rows: [{ a: null }, { a: null }] }), []);
});

// ---------- check B: stability across two runs ----------

test('B: two identical runs pass', () => {
  const body = { rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] };
  assert.deepEqual(
    assessCollectionStability(extractStrategy(), body, JSON.parse(JSON.stringify(body))),
    [],
  );
});

test('B: row order alone is not instability — the comparison is a multiset', () => {
  const first = { rows: [{ id: 1 }, { id: 2 }] };
  const second = { rows: [{ id: 2 }, { id: 1 }] };
  assert.deepEqual(assessCollectionStability(extractStrategy(), first, second), []);
});

test('B: diverging row counts fail', () => {
  const first = { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] };
  const second = { rows: [{ id: 1 }, { id: 2 }] };
  const findings = assessCollectionStability(extractStrategy(), first, second);
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding.reason, 'collection_unstable_across_runs');
  assert.deepEqual(finding.row_counts, [3, 2]);
  assert.deepEqual(finding.diverged_fields, [{ field: 'id', differing_values: 1 }]);
  assert.match(describeCollectionIntegrityFinding(finding), /run 1 returned 3 rows/);
});

test('B: a same-count run whose values moved fails, and names the field', () => {
  const first = { rows: [{ id: 1, seen_at: 't0' }, { id: 2, seen_at: 't0' }] };
  const second = { rows: [{ id: 1, seen_at: 't1' }, { id: 2, seen_at: 't1' }] };
  const findings = assessCollectionStability(extractStrategy(), first, second);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].row_counts, [2, 2]);
  // Reported, never suppressed by name: a legitimately time-varying field is
  // the agent's call to ack, not a keyword bank's.
  assert.deepEqual(findings[0].diverged_fields, [{ field: 'seen_at', differing_values: 4 }]);
});

test('B: a second run with no locatable collection yields no finding', () => {
  const first = { rows: [{ id: 1 }] };
  assert.deepEqual(assessCollectionStability(extractStrategy(), first, 'not json'), []);
});

// ---------- check C: pagination proof ----------

test('C: disjoint pages pass', () => {
  const page1 = { rows: [{ id: 1 }, { id: 2 }] };
  const page2 = { rows: [{ id: 3 }, { id: 4 }] };
  assert.deepEqual(
    assessPaginationDisjointness(extractStrategy(), 'page', ['1', '2'], page1, page2),
    [],
  );
});

test('C: an empty second page is the end of the results, not an overlap', () => {
  const page1 = { rows: [{ id: 1 }, { id: 2 }] };
  assert.deepEqual(
    assessPaginationDisjointness(extractStrategy(), 'page', ['1', '2'], page1, { rows: [] }),
    [],
  );
});

test('C: overlapping pages fail and report the overlap size', () => {
  const page1 = { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] };
  const page2 = { rows: [{ id: 3 }, { id: 4 }] };
  const findings = assessPaginationDisjointness(
    extractStrategy(),
    'page',
    ['1', '2'],
    page1,
    page2,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, 'collection_pagination_unproven');
  assert.equal(findings[0].overlap_rows, 1);
  assert.equal(findings[0].param, 'page');
  assert.deepEqual(findings[0].values, ['1', '2']);
});

test('C: an identical page 2 is a full overlap — the param did nothing', () => {
  const page = { rows: [{ id: 1 }, { id: 2 }] };
  const findings = assessPaginationDisjointness(
    extractStrategy(),
    'page',
    ['1', '2'],
    page,
    JSON.parse(JSON.stringify(page)),
  );
  assert.equal(findings[0].overlap_rows, 2);
  assert.match(describeCollectionIntegrityFinding(findings[0]), /2 rows are present in both pages/);
});

// ---------- check C: the declaration-derived trigger ----------

function paginatingStrategy(extra = {}) {
  return {
    strategy: 'fetch',
    baseUrl: 'https://x.test',
    endpoint: '/api/list?page={{page}}',
    response: { format: 'json', extract: { rows: { path: 'rows', multiple: true } } },
    notes: { params: { page: { kind: 'text', paginates: true } } },
    ...extra,
  };
}

test('trigger: a paginates-declared param templated into the request is a candidate', () => {
  assert.deepEqual(declaredPaginationParams(paginatingStrategy()), ['page']);
});

test('trigger: a paginates-declared param the strategy never templates cannot paginate', () => {
  const strategy = paginatingStrategy({ endpoint: '/api/list' });
  assert.deepEqual(declaredPaginationParams(strategy), []);
});

test('trigger: an undeclared param is never a candidate, whatever it is called', () => {
  const strategy = paginatingStrategy({ notes: { params: { page: { kind: 'text' } } } });
  assert.deepEqual(declaredPaginationParams(strategy), []);
  assert.deepEqual(declaredPaginationParams({ strategy: 'fetch', endpoint: '/x?page={{page}}' }), []);
});

test('trigger: a declaration inside notes alone does not count as templating', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://x.test',
    endpoint: '/api/list',
    notes: { params: { page: { kind: 'text', paginates: true, example: '{{page}}' } } },
  };
  assert.deepEqual(declaredPaginationParams(strategy), []);
});

// ---------- check C: the save-time requirement that gives it coverage ----------
//
// An opt-in flag reports full coverage over an empty set: an absent declaration
// and "no param paginates" are the same bytes. These pin the candidate set the
// save audit demands an answer for, and that an explicit `false` is an answer.

function candidateStrategy(params, extra = {}) {
  return {
    strategy: 'fetch',
    baseUrl: 'https://x.test',
    endpoint: '/api/list?q={{query}}&page={{page}}',
    response: { format: 'json', extract: { rows: { path: 'rows', multiple: true } } },
    notes: { params },
    ...extra,
  };
}

test('candidate: templated with an integer example is what check C could settle', () => {
  const strategy = candidateStrategy({
    query: { kind: 'text', example: 'bakery' },
    page: { kind: 'text', example: '1' },
  });
  assert.deepEqual(paginationCandidateParams(strategy), ['page']);
});

test('candidate: a cursor example cannot be stepped, so nothing is demanded of it', () => {
  const strategy = candidateStrategy({ page: { kind: 'text', example: 'eyJjdXJzb3IiOjF9' } });
  assert.deepEqual(paginationCandidateParams(strategy), []);
  assert.deepEqual(detectUnansweredPaginationQuestion(strategy), []);
});

test('candidate: an integer example the request never templates cannot advance anything', () => {
  const strategy = candidateStrategy({ offset: { kind: 'text', example: '20' } });
  assert.deepEqual(paginationCandidateParams(strategy), []);
});

test('candidate: a string-form param doc carries no example to read', () => {
  const strategy = candidateStrategy({ page: 'which page to load' });
  assert.deepEqual(paginationCandidateParams(strategy), []);
});

test('requirement: a candidate with no paginates key fails the save', () => {
  const warnings = detectUnansweredPaginationQuestion(
    candidateStrategy({
      query: { kind: 'text', example: 'bakery' },
      page: { kind: 'text', example: '1' },
    }),
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'unanswered_pagination_question');
  assert.deepEqual(warnings[0].context.unanswered, ['page']);
  assert.match(warnings[0].hint, /notes\.params\.page\.paginates/);
});

test('requirement: an explicit false is an answer — only silence is rejected', () => {
  for (const paginates of [true, false]) {
    const strategy = candidateStrategy({ page: { kind: 'text', example: '1', paginates } });
    assert.deepEqual(detectUnansweredPaginationQuestion(strategy), []);
  }
});

test('requirement: every unanswered candidate is named in one rejection', () => {
  const warnings = detectUnansweredPaginationQuestion(
    candidateStrategy(
      { page: { kind: 'text', example: '1' }, size: { kind: 'text', example: '20' } },
      { endpoint: '/api/list?page={{page}}&size={{size}}' },
    ),
  );
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].context.unanswered, ['page', 'size']);
});

test('requirement: the save audit composes it, and blocks with no ack path', () => {
  assert.ok(saveStrategyAudit.detectorKinds().includes('unanswered_pagination_question'));
  const strategy = candidateStrategy({ page: { kind: 'text', example: '1' } });
  const ctx = { capability: 'list_things', sessionId: null, observedParamValues: {} };
  // Acking it is a no-op: the detector emits regardless, so the save stays
  // rejected until the boolean is actually written.
  const result = saveStrategyAudit.process(strategy, ctx, {
    skipShapeChecks: true,
    acks: { unanswered_pagination_question: 'the page param is fine as is' },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.reason, 'unacked_warnings');
  assert.ok(
    result.rejection.non_ackable_warning_kinds.includes('unanswered_pagination_question'),
    'must be marked non-ackable so the envelope does not offer a bypass',
  );
});

test('requirement: an unattended producer keeps its fallback and carries the advisory', () => {
  const strategy = candidateStrategy({ page: { kind: 'text', example: '1' } });
  const ctx = { capability: 'list_things', sessionId: null, observedParamValues: {} };
  const { blocking, warnings } = saveStrategyAudit.runUnattended(strategy, ctx);
  const kinds = (issues) => issues.map((i) => i.kind);
  assert.ok(!kinds(blocking).includes('unanswered_pagination_question'));
  assert.ok(kinds(warnings).includes('unanswered_pagination_question'));
});

test('advance: only an integer-valued argument can be advanced without a cursor grammar', () => {
  assert.deepEqual(advancePaginationValue('1'), { from: '1', to: '2' });
  assert.deepEqual(advancePaginationValue(7), { from: '7', to: '8' });
  assert.equal(advancePaginationValue('eyJjdXJzb3IiOjF9'), null);
  assert.equal(advancePaginationValue(undefined), null);
  assert.equal(advancePaginationValue({ page: 1 }), null);
});

// ---------- the shared locator the empty-collection assessor also uses ----------

test('locator: the same declaration sources serve populated collections', () => {
  const located = locateDeclaredCollections(extractStrategy(), { rows: [{ id: 1 }] });
  assert.equal(located.source, 'response_extract_multiple');
  assert.deepEqual(located.collections, [{ key: 'rows', rows: [{ id: 1 }] }]);
});

test('locator: emptiness is still exactly "every located collection has no rows"', () => {
  const strategy = extractStrategy();
  assert.equal(assessDeclaredCollectionEmptiness(strategy, { rows: [] }).source, 'response_extract_multiple');
  assert.equal(assessDeclaredCollectionEmptiness(strategy, { rows: [{ id: 1 }] }), null);
});

// ---------- consumption: post-save verification ----------

// Serves each navigated URL its own payload, and records every evaluation so a
// test can assert how many executions the verification actually cost.
function makePool(payloadFor) {
  const urls = new Map();
  const evaluated = [];
  const created = [];
  let nextSession = 0;
  const driver = {
    async getUrl(session) {
      return urls.get(session.id) ?? 'about:blank';
    },
    async navigate(session, url) {
      urls.set(session.id, url);
    },
    async evaluateExpression(session, expression) {
      // The executor's page-settled probe, not a strategy execution.
      if (expression === 'document.readyState') return 'complete';
      const url = urls.get(session.id) ?? 'about:blank';
      evaluated.push(url);
      return JSON.stringify(payloadFor(url, evaluated.length - 1));
    },
  };
  return {
    evaluated,
    created,
    pool: {
      async createSession() {
        const session = { id: `s-${++nextSession}`, intercepted: [], intercepting: false };
        created.push(session.id);
        urls.set(session.id, 'about:blank');
        return session;
      },
      createNodeOnlySession() {
        throw new Error('unexpected node-only session');
      },
      async endDrive() {},
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

// `response.from` over a js-eval prereq: the prereq's value IS the result, so
// the executor re-evaluates it per call rather than serving a cached binding.
function listStrategy(url, notes) {
  return {
    strategy: 'page-script',
    baseUrl: 'https://example.test',
    prerequisites: [
      {
        name: 'result',
        kind: 'js-eval',
        url,
        expression: 'document.body.innerText',
        binds: 'result',
        return_shape: { kind: 'string' },
      },
    ],
    response: { from: 'result', format: 'json' },
    ...(notes ? { notes } : {}),
  };
}

test('active save: a uniformly-null field stamps transport_passed and carries its evidence', async () => {
  const platform = 'integrity-uniform-null';
  const capability = 'list_things';
  skills.commitValidatedStrategy(platform, capability, listStrategy('https://example.test/list'));
  const state = makePool(() => ({
    ok: true,
    items: [
      { name: 'a', price: '$1', image_url: null },
      { name: 'b', price: null, image_url: null },
    ],
  }));

  const result = await verifySavedStrategy(platform, capability, {}, state.pool);

  assert.equal(result.ok, false);
  assert.equal(result.classification, 'transport_accepted');
  assert.equal(result.semantic_review_reason, 'collection_field_uniformly_null');
  assert.equal(result.collection_integrity.length, 1);
  assert.equal(result.collection_integrity[0].field, 'image_url');
  assert.deepEqual(result.collection_integrity[0].partial_null_siblings, ['price']);
  assert.match(result.message, /post_save_validation_collection_integrity/);
  assert.match(result.message, /collection_field_uniformly_null/);
  assert.equal(result.collection_keys, undefined);

  const saved = skills.loadStrategy(platform, capability);
  assert.equal(saved.runtime_meta.post_save_validation, 'transport_passed');
});

test('active save: a stable, healthy multi-row collection still stamps passed', async () => {
  const platform = 'integrity-healthy';
  const capability = 'list_things';
  skills.commitValidatedStrategy(platform, capability, listStrategy('https://example.test/list'));
  const state = makePool(() => ({
    ok: true,
    items: [
      { name: 'a', price: '$1', image_url: 'https://x/a.png' },
      { name: 'b', price: null, image_url: 'https://x/b.png' },
    ],
  }));

  const result = await verifySavedStrategy(platform, capability, {}, state.pool);

  assert.equal(result.ok, true);
  assert.equal(result.classification, 'explicit_success');
  assert.equal(result.semantic_review_reason, undefined);
  assert.equal(result.collection_integrity, undefined);
  // Two executions — the original plus the stability re-run — and both reused
  // the one run-scoped context.
  assert.equal(state.evaluated.length, 2);
  assert.equal(state.created.length, 1);

  const saved = skills.loadStrategy(platform, capability);
  assert.equal(saved.runtime_meta.post_save_validation, 'passed');
});

test('active save: a feed that returns a different row count on re-run goes to review', async () => {
  const platform = 'integrity-unstable';
  const capability = 'list_things';
  skills.commitValidatedStrategy(platform, capability, listStrategy('https://example.test/list'));
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const state = makePool((_url, call) => ({ ok: true, items: call === 0 ? rows : rows.slice(0, 2) }));

  const result = await verifySavedStrategy(platform, capability, {}, state.pool);

  assert.equal(result.ok, false);
  assert.equal(result.classification, 'transport_accepted');
  assert.equal(result.semantic_review_reason, 'collection_unstable_across_runs');
  assert.deepEqual(result.collection_integrity[0].row_counts, [3, 2]);
  assert.match(result.message, /two back-to-back runs/);

  const saved = skills.loadStrategy(platform, capability);
  assert.equal(saved.runtime_meta.post_save_validation, 'transport_passed');
});

test('config: audit.verifyCollectionStability=false skips the second run entirely', async () => {
  withAuditConfig({ verifyCollectionStability: false });
  try {
    const platform = 'integrity-stability-off';
    const capability = 'list_things';
    skills.commitValidatedStrategy(platform, capability, listStrategy('https://example.test/list'));
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const state = makePool((_url, call) => ({
      ok: true,
      items: call === 0 ? rows : rows.slice(0, 2),
    }));

    const result = await verifySavedStrategy(platform, capability, {}, state.pool);

    assert.equal(result.ok, true);
    assert.equal(result.classification, 'explicit_success');
    assert.equal(state.evaluated.length, 1);
  } finally {
    clearConfig();
  }
});

test('candidate: overlapping pages keep the candidate inactive and reach the review gate', async () => {
  const platform = 'integrity-pagination';
  const capability = 'search_places';
  const strategy = listStrategy('https://example.test/list?page={{page}}', {
    params: { page: { kind: 'text', paginates: true, example: '1' } },
  });
  const ref = skills.stageValidatedStrategyCandidate(platform, capability, strategy);
  const pages = {
    1: [{ id: 1 }, { id: 2 }],
    2: [{ id: 2 }, { id: 3 }],
  };
  const state = makePool((url) => ({
    ok: true,
    items: pages[new URL(url).searchParams.get('page')] ?? [],
  }));

  const result = await verifyStrategyCandidate(ref, { page: '1' }, state.pool);

  assert.equal(result.ok, false);
  assert.equal(result.active, false);
  assert.equal(result.state, 'candidate');
  assert.equal(result.classification, 'transport_accepted');
  assert.equal(result.semantic_review_required, true);
  assert.equal(result.semantic_review_reason, 'collection_pagination_unproven');
  assert.equal(result.collection_integrity[0].overlap_rows, 1);
  assert.match(result.message, /strategy_candidate_semantic_review_required/);
  assert.match(result.message, /collection_pagination_unproven/);
  // Page 1, the stability re-run of page 1, and page 2 — three executions, one
  // run-scoped context.
  assert.equal(state.evaluated.length, 3);
  assert.equal(state.created.length, 1);

  const { reviewStrategyCandidate } = await import('../dist/tools/review-strategy-candidate.js');
  const review = reviewStrategyCandidate({
    platform,
    capability,
    candidate_id: ref.candidate_id,
    evidence_digest: result.evidence_digest,
  });
  assert.equal(review.review_required, true);
  assert.equal(review.semantic_review_reason, 'collection_pagination_unproven');
  assert.match(review.semantic_review_detail, /pagination over/);
});

test('config: audit.verifyPaginationDisjointness=false skips the page-2 run', async () => {
  withAuditConfig({ verifyPaginationDisjointness: false });
  try {
    const platform = 'integrity-pagination-off';
    const capability = 'search_places';
    const strategy = listStrategy('https://example.test/list?page={{page}}', {
      params: { page: { kind: 'text', paginates: true, example: '1' } },
    });
    skills.commitValidatedStrategy(platform, capability, strategy);
    const state = makePool(() => ({ ok: true, items: [{ id: 1 }, { id: 2 }] }));

    const result = await verifySavedStrategy(platform, capability, { page: '1' }, state.pool);

    assert.equal(result.ok, true);
    assert.equal(result.classification, 'explicit_success');
    // The stability re-run still fires; only page 2 is skipped.
    assert.equal(state.evaluated.length, 2);
  } finally {
    clearConfig();
  }
});

test('candidate: a uniformly-null field is re-derived at the review gate from stored evidence', async () => {
  const platform = 'integrity-candidate-null';
  const capability = 'list_things';
  const ref = skills.stageValidatedStrategyCandidate(
    platform,
    capability,
    listStrategy('https://example.test/list'),
  );
  const state = makePool(() => ({
    ok: true,
    items: [
      { name: 'a', price: '$1', image_url: null },
      { name: 'b', price: null, image_url: null },
    ],
  }));

  const verified = await verifyStrategyCandidate(ref, {}, state.pool);
  assert.equal(verified.semantic_review_reason, 'collection_field_uniformly_null');

  const { reviewStrategyCandidate } = await import('../dist/tools/review-strategy-candidate.js');
  const review = reviewStrategyCandidate({
    platform,
    capability,
    candidate_id: ref.candidate_id,
    evidence_digest: verified.evidence_digest,
  });
  assert.equal(review.review_required, true);
  assert.equal(review.semantic_review_reason, 'collection_field_uniformly_null');
  assert.equal(review.collection_integrity[0].field, 'image_url');
  assert.match(review.semantic_review_detail, /image_url/);
});

test('describe_config surfaces both extra-execution knobs, defaulted on', async () => {
  const { describeConfig } = await import('../dist/config/handler.js');
  const fields = describeConfig().fields;
  for (const path of ['audit.verifyCollectionStability', 'audit.verifyPaginationDisjointness']) {
    const spec = fields.find((f) => f.path === path);
    assert.ok(spec, `${path} must be described`);
    assert.equal(spec.type, 'boolean');
    assert.equal(spec.default, true);
  }
});
