// Unit tests for `composeTriageAuthoringContract`.
//
// The contract is composed at TRIAGE entry from session state. It must
// teach the agent every Detector on `triagePlanAudit` upfront, with the
// per-constraint evidence already substituted, so the agent can author
// `submit_triage_plan` correctly on the first attempt.

import test from 'node:test';
import assert from 'node:assert/strict';

const { composeTriageAuthoringContract } = await import(
  '../dist/phases/triage/triage-authoring-contract.js'
);
const { triagePlanAudit } = await import('../dist/audit/triage/triage-plan.js');

function session(overrides = {}) {
  return {
    intercepted: [],
    declaredCapabilities: [],
    domNavigations: [],
    ...overrides,
  };
}

// ---------- shape ----------

test('contract: empty session → empty samples but all 6 constraints listed', () => {
  const c = composeTriageAuthoringContract(session());
  assert.deepEqual(c.captured_urls_sample, []);
  assert.deepEqual(c.distinct_origins, []);
  assert.equal(c.valid_request_pattern_examples.length, 3);
  const kinds = c.constraints.map((k) => k.kind);
  assert.deepEqual(
    kinds.sort(),
    [
      'capability_must_be_declared',
      'recorded_path_navigate_url_in_patterns',
      'slug_must_not_bake_query_value',
      'tier_justification_must_cite_artifact',
      'url_grounded_in_captures_or_origins',
      'url_token_extractable',
    ],
  );
});

test('contract: every constraint references a live triagePlanAudit detector kind', () => {
  // Derived from the audit instance itself — a detector kind rename or a
  // dead constraint reference fails here without a hand-maintained list.
  const c = composeTriageAuthoringContract(session());
  const live = new Set(triagePlanAudit.detectorKinds());
  for (const constraint of c.constraints) {
    assert.ok(
      live.has(constraint.detector_kind),
      `unknown detector_kind: ${constraint.detector_kind} (live: ${[...live].join(', ')})`,
    );
  }
});

// ---------- captured URLs / origins ----------

test('contract: captured URLs deduplicate by origin+path', () => {
  const c = composeTriageAuthoringContract(
    session({
      intercepted: [
        { url: 'https://x.com/api/send' },
        { url: 'https://x.com/api/send?b=1' }, // same path, different query → dedup
        { url: 'https://x.com/api/list' },
      ],
    }),
  );
  assert.equal(c.captured_urls_sample.length, 2);
  assert.deepEqual(c.distinct_origins, ['https://x.com']);
});

// ---------- capability_must_be_declared ----------

test('contract: capability_must_be_declared echoes session.declaredCapabilities', () => {
  const c = composeTriageAuthoringContract(
    session({
      declaredCapabilities: [
        { capability: 'send_message', args: {}, declared_at: 0 },
        { capability: 'list_threads', args: {}, declared_at: 0 },
      ],
    }),
  );
  const constraint = c.constraints.find((k) => k.kind === 'capability_must_be_declared');
  assert.ok(constraint);
  assert.deepEqual(constraint.declared_capabilities.sort(), ['list_threads', 'send_message']);
});

// ---------- tier_justification_must_cite_artifact ----------

test('contract: citeable_artifacts_sample includes hosts + cookies + script filenames', () => {
  const c = composeTriageAuthoringContract(
    session({
      intercepted: [
        {
          url: 'https://api.x.com/v1/send',
          contentType: 'application/json',
          setCookieNames: ['session_id'],
        },
        {
          url: 'https://x.com/static/app-1234.js',
          contentType: 'application/javascript',
        },
      ],
    }),
  );
  const constraint = c.constraints.find(
    (k) => k.kind === 'tier_justification_must_cite_artifact',
  );
  assert.ok(constraint);
  const sample = constraint.citeable_artifacts_sample;
  assert.ok(sample.includes('api.x.com'), 'host extracted');
  assert.ok(sample.includes('x.com'), 'second host');
  assert.ok(sample.includes('session_id'), 'cookie name');
  assert.ok(sample.includes('app-1234.js'), 'JS filename');
});

test('contract: citeable_artifacts_sample falls through to navigation URLs when little XHR', () => {
  const c = composeTriageAuthoringContract(
    session({
      intercepted: [],
      domNavigations: [
        { url: 'https://x.com/welcome', at: 1 },
        { url: 'https://x.com/account', at: 2 },
      ],
    }),
  );
  const constraint = c.constraints.find(
    (k) => k.kind === 'tier_justification_must_cite_artifact',
  );
  assert.ok(constraint.citeable_artifacts_sample.includes('https://x.com/welcome'));
});

// ---------- slug_must_not_bake_query_value ----------

test('contract: slug-collision pre-fires for declared capabilities whose tokens collide with captured query values', () => {
  // Canonical positive: declared slug `find_top_italian_restaurants`,
  // session captured /api/list?category=italian → would-fire entry.
  const c = composeTriageAuthoringContract(
    session({
      declaredCapabilities: [
        { capability: 'find_top_italian_restaurants', args: {}, declared_at: 0 },
      ],
      intercepted: [{ url: 'https://x.com/api/list?category=italian' }],
    }),
  );
  const constraint = c.constraints.find((k) => k.kind === 'slug_must_not_bake_query_value');
  assert.ok(constraint);
  assert.equal(constraint.would_fire_for.length, 1);
  assert.equal(constraint.would_fire_for[0].capability, 'find_top_italian_restaurants');
  assert.equal(constraint.would_fire_for[0].token, 'italian');
  assert.equal(constraint.would_fire_for[0].param_name, 'category');
});

test('contract: slug-collision empty when no overlap', () => {
  const c = composeTriageAuthoringContract(
    session({
      declaredCapabilities: [
        { capability: 'create_issue', args: {}, declared_at: 0 },
      ],
      intercepted: [{ url: 'https://github.com/_graphql' }],
    }),
  );
  const constraint = c.constraints.find((k) => k.kind === 'slug_must_not_bake_query_value');
  assert.ok(constraint);
  assert.deepEqual(constraint.would_fire_for, []);
});

test('contract: slug-collision surfaces the github false-positive shape (canonical noun)', () => {
  // Field-report regression: capability `create_issue`, session captured
  // a settings page with `?context=issue`. The would-fire surfaces this
  // BEFORE the agent writes a triage plan, with enough context for the
  // agent to either re-declare under a clean slug OR ack it as
  // incidental noun-overlap (canonical noun for the entity).
  const c = composeTriageAuthoringContract(
    session({
      declaredCapabilities: [
        { capability: 'create_issue', args: {}, declared_at: 0 },
      ],
      intercepted: [
        { url: 'https://github.com/_graphql' },
        { url: 'https://github.com/settings/replies?context=issue' },
      ],
    }),
  );
  const constraint = c.constraints.find((k) => k.kind === 'slug_must_not_bake_query_value');
  assert.ok(constraint);
  assert.equal(constraint.would_fire_for.length, 1);
  assert.equal(constraint.would_fire_for[0].token, 'issue');
  // The rule mentions the ack path so the agent has a recovery option.
  assert.match(constraint.rule, /Ackable/);
  assert.match(constraint.rule, /enum_value_baked_into_slug/);
});

// ---------- recorded_path_navigate_url_in_patterns ----------

test('contract: captured_nav_url_keys canonicalizes and dedupes session navigations', () => {
  const c = composeTriageAuthoringContract(
    session({
      domNavigations: [
        { url: 'https://x.com/compose?draft=1', at: 1 },
        { url: 'https://x.com/compose', at: 2 }, // same urlKey → dedup
        { url: 'https://x.com/inbox/', at: 3 }, // trailing slash stripped
      ],
    }),
  );
  const constraint = c.constraints.find(
    (k) => k.kind === 'recorded_path_navigate_url_in_patterns',
  );
  assert.ok(constraint);
  assert.deepEqual(constraint.captured_nav_url_keys.sort(), [
    'https://x.com/compose',
    'https://x.com/inbox',
  ]);
  // The rule names the ack path so the agent has a recovery option.
  assert.match(constraint.rule, /recorded_path_navigate_url_unbound/);
});
