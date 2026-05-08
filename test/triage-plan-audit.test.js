// Unit tests for `triagePlanAudit` and `findObservedMatch`.
//
// `triagePlanAudit` composes two ackReason:'none' detectors:
//   - request_pattern_url_extractable: each entry must contain a URL or
//     absolute-path token.
//   - request_pattern_url_observed: each extracted URL must either match
//     a captured URL this session OR sit on an observed_origin.
//
// `findObservedMatch` is the shared URL-vs-captured-URL primitive. Both
// detectors and the save-time `unobservedUrlDetector` use the same shape;
// these tests pin its semantics: exact, parent-prefix, child-prefix, miss,
// cross-origin.

import test from 'node:test';
import assert from 'node:assert/strict';

const { findObservedMatch } = await import('../dist/strategies/verify-observed.js');
const { triagePlanAudit, extractUrlToken, resolveAgainstOrigin } = await import(
  '../dist/audit/triage/triage-plan.js'
);

// ---------- findObservedMatch ----------

test('findObservedMatch: exact origin+path match', () => {
  const result = findObservedMatch('http://x.com/api/send', ['http://x.com/api/send']);
  assert.equal(result, 'http://x.com/api/send');
});

test('findObservedMatch: query strings tolerated', () => {
  const result = findObservedMatch('http://x.com/api/send?a=1', [
    'http://x.com/api/send?b=2',
  ]);
  assert.equal(result, 'http://x.com/api/send?b=2');
});

test('findObservedMatch: candidate is parent-of-observed', () => {
  // Agent claims `/api`; runtime captured `/api/send` — claim is honored.
  const result = findObservedMatch('http://x.com/api', ['http://x.com/api/send']);
  assert.equal(result, 'http://x.com/api/send');
});

test('findObservedMatch: candidate is child-of-observed root', () => {
  // Agent triaged `/`; every same-origin path is a child.
  const result = findObservedMatch('http://x.com/api/categories', ['http://x.com/']);
  assert.equal(result, 'http://x.com/');
});

test('findObservedMatch: candidate is child-of-observed subpath', () => {
  // Agent claims `/search/api`; runtime triaged `/search` — child match.
  const result = findObservedMatch('http://x.com/search/api', ['http://x.com/search']);
  assert.equal(result, 'http://x.com/search');
});

test('findObservedMatch: cross-origin returns null', () => {
  const result = findObservedMatch('http://other.com/api/send', ['http://x.com/api/send']);
  assert.equal(result, null);
});

test('findObservedMatch: no overlap returns null', () => {
  const result = findObservedMatch('http://x.com/api/foo', ['http://x.com/api/bar']);
  assert.equal(result, null);
});

test('findObservedMatch: prefix-but-not-path-boundary returns null', () => {
  // `/searchresults` shouldn't match an observed `/search` — the boundary
  // matters (otherwise `/api/sendgrid` would falsely match `/api/send`).
  const result = findObservedMatch('http://x.com/searchresults', ['http://x.com/search']);
  assert.equal(result, null);
});

test('findObservedMatch: empty observed list returns null', () => {
  assert.equal(findObservedMatch('http://x.com/api/send', []), null);
});

// ---------- extractUrlToken ----------

test('extractUrlToken: METHOD URL form', () => {
  assert.equal(extractUrlToken('POST /api/send'), '/api/send');
  assert.equal(
    extractUrlToken('GET https://api.example.com/v1/list'),
    'https://api.example.com/v1/list',
  );
});

test('extractUrlToken: bare URL form', () => {
  assert.equal(extractUrlToken('/api/categories'), '/api/categories');
  assert.equal(extractUrlToken('http://x.com/y'), 'http://x.com/y');
});

test('extractUrlToken: prose-trailing form', () => {
  // The agent appended descriptive prose; the URL token is still extractable.
  assert.equal(
    extractUrlToken('POST http://127.0.0.1:3310/api/send with x-nonce header and JSON body'),
    'http://127.0.0.1:3310/api/send',
  );
});

test('extractUrlToken: pure prose returns null', () => {
  assert.equal(extractUrlToken('send the data securely'), null);
});

// ---------- resolveAgainstOrigin ----------

test('resolveAgainstOrigin: relative + first origin', () => {
  assert.equal(
    resolveAgainstOrigin('/api/send', ['http://x.com', 'http://other.com']),
    'http://x.com/api/send',
  );
});

test('resolveAgainstOrigin: absolute pass-through', () => {
  assert.equal(
    resolveAgainstOrigin('http://x.com/api/send', ['http://other.com']),
    'http://x.com/api/send',
  );
});

test('resolveAgainstOrigin: relative + no origins returns null', () => {
  assert.equal(resolveAgainstOrigin('/api/send', []), null);
});

// ---------- triagePlanAudit detectors ----------

function payload(overrides = {}) {
  return {
    surface_label: 'main',
    // tier_justification cites the default observed_origin so the
    // tier_justification_unciteable detector stays green by default.
    tier_justification: 'targets http://x.com on session-cookie auth',
    defense_surface: {
      observed_origins: ['http://x.com'],
      observed_scripts: [],
      cookies_set: [],
      request_patterns: [],
      mechanism_hypothesis: 'no auth',
      ...overrides.defense_surface,
    },
    ...overrides,
  };
}

function ctx(intercepted = [], overrides = {}) {
  return {
    session: {
      id: 'sess',
      platform: 'p',
      intercepted,
      declaredCapabilities: [
        { capability: 'send_message', args: {}, declared_at: 0 },
      ],
      domNavigations: [],
      ...overrides.session,
    },
    capability: overrides.capability ?? 'send_message',
  };
}

test('audit: passes when request_pattern is observed', () => {
  const result = triagePlanAudit.process(
    payload({
      defense_surface: {
        observed_origins: ['http://x.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: ['POST /api/send'],
        mechanism_hypothesis: 'no auth',
      },
    }),
    ctx([{ url: 'http://x.com/api/send' }]),
    {},
  );
  assert.equal(result.status, 'committed');
});

test('audit: passes when URL is on observed_origin even without prior capture', () => {
  // Forward-claim case: the agent triages an endpoint they expect but
  // haven't yet exercised. As long as the origin is in observed_origins,
  // the claim stands.
  const result = triagePlanAudit.process(
    payload({
      defense_surface: {
        observed_origins: ['http://x.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: ['POST /api/future-endpoint'],
        mechanism_hypothesis: 'no auth',
      },
    }),
    ctx([]),
    {},
  );
  assert.equal(result.status, 'committed');
});

test('audit: rejects when no URL token extractable', () => {
  const result = triagePlanAudit.process(
    payload({
      defense_surface: {
        observed_origins: ['http://x.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: ['send the data securely'],
        mechanism_hypothesis: 'no auth',
      },
    }),
    ctx([{ url: 'http://x.com/api/send' }]),
    {},
  );
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.warnings[0].kind, 'request_pattern_url_extractable');
});

test('audit: rejects when URL is not on observed_origin and not captured', () => {
  const result = triagePlanAudit.process(
    payload({
      defense_surface: {
        observed_origins: ['http://x.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: ['POST http://other.com/api/send'],
        mechanism_hypothesis: 'no auth',
      },
    }),
    ctx([{ url: 'http://x.com/api/send' }]),
    {},
  );
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejection.warnings[0].kind, 'request_pattern_url_observed');
  // The hint surfaces the captured URL sample so the agent can self-correct.
  assert.match(result.rejection.warnings[0].hint, /http:\/\/x\.com\/api\/send/);
});

test('audit: batches multiple bad patterns into one rejection', () => {
  const result = triagePlanAudit.process(
    payload({
      defense_surface: {
        observed_origins: ['http://x.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: [
          'send the data',
          'POST http://other.com/api/send',
          'POST /api/send',
        ],
        mechanism_hypothesis: 'no auth',
      },
    }),
    ctx([{ url: 'http://x.com/api/send' }]),
    {},
  );
  assert.equal(result.status, 'rejected');
  // First two entries fail (one per detector); third passes.
  const kinds = result.rejection.warnings.map((w) => w.kind).sort();
  assert.deepEqual(kinds, ['request_pattern_url_extractable', 'request_pattern_url_observed']);
});

test('audit: prose-trailing pattern with valid URL passes', () => {
  // The agent's prose ("with JSON body...") doesn't break the URL check —
  // extractUrlToken pulls the URL, and it's on an observed_origin.
  const result = triagePlanAudit.process(
    payload({
      defense_surface: {
        observed_origins: ['http://x.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: ['POST http://x.com/api/send with x-nonce header'],
        mechanism_hypothesis: 'has nonce',
      },
    }),
    ctx([{ url: 'http://x.com/api/send' }]),
    {},
  );
  assert.equal(result.status, 'committed');
});

// ---------- capability_not_declared ----------

test('audit: rejects when capability is not in session.declaredCapabilities', () => {
  const result = triagePlanAudit.process(
    payload({
      defense_surface: {
        observed_origins: ['http://x.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: ['POST http://x.com/api/send'],
        mechanism_hypothesis: 'no auth',
      },
    }),
    ctx([{ url: 'http://x.com/api/send' }], { capability: 'send_dm' }),
    {},
  );
  assert.equal(result.status, 'rejected');
  const kinds = result.rejection.warnings.map((w) => w.kind);
  assert.ok(kinds.includes('capability_not_declared'));
});

test('audit: passes when capability is declared', () => {
  const result = triagePlanAudit.process(
    payload({
      defense_surface: {
        observed_origins: ['http://x.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: ['POST http://x.com/api/send'],
        mechanism_hypothesis: 'no auth',
      },
    }),
    ctx([{ url: 'http://x.com/api/send' }]),
    {},
  );
  assert.equal(result.status, 'committed');
});

// ---------- tier_justification_unciteable ----------

test('audit: rejects when tier_justification cites no captured artifact', () => {
  const result = triagePlanAudit.process(
    payload({
      tier_justification: 'looks like a clean fetch — no signs of CSRF or signed bodies',
      defense_surface: {
        observed_origins: ['http://x.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: ['POST http://x.com/api/send'],
        mechanism_hypothesis: 'no auth',
      },
    }),
    ctx([{ url: 'http://x.com/api/send' }]),
    {},
  );
  assert.equal(result.status, 'rejected');
  const kinds = result.rejection.warnings.map((w) => w.kind);
  assert.ok(kinds.includes('tier_justification_unciteable'));
});

test('audit: passes when tier_justification quotes an observed origin host', () => {
  const result = triagePlanAudit.process(
    payload({
      tier_justification: 'targets x.com via session cookie — no nonce in captured headers',
      defense_surface: {
        observed_origins: ['http://x.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: ['POST http://x.com/api/send'],
        mechanism_hypothesis: 'session cookie',
      },
    }),
    ctx([{ url: 'http://x.com/api/send' }]),
    {},
  );
  assert.equal(result.status, 'committed');
});

// ---------- enum_value_baked_into_slug ----------

test('audit: enum_value_baked_into_slug fires for slug-baked query value', () => {
  const result = triagePlanAudit.process(
    payload({
      defense_surface: {
        observed_origins: ['http://x.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: ['POST http://x.com/api/list?category=italian'],
        mechanism_hypothesis: 'no auth',
      },
    }),
    ctx([{ url: 'http://x.com/api/list?category=italian' }], {
      capability: 'find_top_italian_restaurants',
      session: {
        id: 'sess',
        platform: 'p',
        intercepted: [{ url: 'http://x.com/api/list?category=italian' }],
        declaredCapabilities: [
          { capability: 'find_top_italian_restaurants', args: {}, declared_at: 0 },
        ],
        domNavigations: [],
      },
    }),
    {},
  );
  assert.equal(result.status, 'rejected');
  const warning = result.rejection.warnings.find(
    (w) => w.kind === 'enum_value_baked_into_slug',
  );
  assert.ok(warning, 'expected enum_value_baked_into_slug warning');
  assert.match(warning.message, /italian/);
});

test('audit: enum_value_baked_into_slug does NOT fire when slug-token only appears in session capture (Option A)', () => {
  // Regression case from the field-report run:
  // capability=create_issue, request_patterns target /api/_graphql (clean),
  // but the session also captured a settings page ?context=issue. With the
  // pre-Option-A scope (capturedUrls included), the detector false-positives.
  // Post-Option-A: slug overlap with captured-only URLs is ignored; only the
  // declared request_patterns are checked.
  const result = triagePlanAudit.process(
    payload({
      tier_justification: 'targets x.com /api/_graphql via session cookie',
      defense_surface: {
        observed_origins: ['http://x.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: ['POST http://x.com/api/_graphql'],
        mechanism_hypothesis: 'persisted query, session cookie',
      },
    }),
    ctx(
      [
        { url: 'http://x.com/api/_graphql' },
        { url: 'http://x.com/settings/replies?context=issue' },
      ],
      {
        capability: 'create_issue',
        session: {
          id: 'sess',
          platform: 'p',
          intercepted: [
            { url: 'http://x.com/api/_graphql' },
            { url: 'http://x.com/settings/replies?context=issue' },
          ],
          declaredCapabilities: [
            { capability: 'create_issue', args: {}, declared_at: 0 },
          ],
          domNavigations: [],
        },
      },
    ),
    {},
  );
  assert.equal(result.status, 'committed');
});

test('audit: enum_value_baked_into_slug commits when acked', () => {
  // The acked-warning path: agent admits the slug overlaps with a query
  // value but argues the overlap is incidental (canonical noun for the
  // entity, not a parameter the user picks). Audit commits with the
  // warning echoed in `warnings`.
  const baseCtx = ctx([{ url: 'http://x.com/api/list?category=italian' }], {
    capability: 'find_top_italian_restaurants',
    session: {
      id: 'sess',
      platform: 'p',
      intercepted: [{ url: 'http://x.com/api/list?category=italian' }],
      declaredCapabilities: [
        { capability: 'find_top_italian_restaurants', args: {}, declared_at: 0 },
      ],
      domNavigations: [],
    },
  });
  const basePayload = payload({
    defense_surface: {
      observed_origins: ['http://x.com'],
      observed_scripts: [],
      cookies_set: [],
      request_patterns: ['POST http://x.com/api/list?category=italian'],
      mechanism_hypothesis: 'no auth',
    },
  });
  // First call: rejection mints a token and surfaces the warning.
  const first = triagePlanAudit.process(basePayload, baseCtx, {});
  assert.equal(first.status, 'rejected');
  // Second call: ack the warning; audit commits.
  const second = triagePlanAudit.process(basePayload, baseCtx, {
    acks: { enum_value_baked_into_slug: 'italian is the canonical noun for the entity, not a parameter' },
  });
  assert.equal(second.status, 'committed');
  const warningKinds = second.warnings.map((w) => w.kind);
  assert.ok(warningKinds.includes('enum_value_baked_into_slug'));
});
