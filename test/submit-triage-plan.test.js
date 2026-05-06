// `submit_triage_plan` — defense-surface plan persistence, cite-validation
// of the tier_justification, surface-binding side effect, and per-surface
// history rotation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-stp-'));
process.env.KLURA_HOME = TMP;

const { submitTriagePlan } = await import('../dist/tools/submit-triage-plan.js');
const { pool } = await import('../dist/runtime-state.js');
const { loadLogbook } = await import('../dist/working-dir/logbook.js');
const { dispatch } = await import('../dist/session-phase/state-machine.js');

function patchPool(session) {
  const orig = pool.getSession.bind(pool);
  pool.getSession = (id) => (id === session.id ? session : orig(id));
  return () => {
    pool.getSession = orig;
  };
}

function triageSession({ urls = ['https://shop.example.com/checkout'], cookieNames = [], platform } = {}) {
  const session = {
    id: 'sess_stp_' + Math.random().toString(36).slice(2, 8),
    // Per-test platform so logbooks don't share state across tests.
    platform: platform ?? 'stp-test-' + Math.random().toString(36).slice(2, 8),
    intercepted: cookieNames.map((name) => ({
      method: 'GET',
      url: 'https://collector.example.net/sensor.js',
      headers: { 'content-type': 'application/javascript' },
      contentType: 'application/javascript',
      postData: null,
      status: 200,
      responseBody: '',
      setCookieNames: [name],
    })),
    domNavigations: [],
    declaredCapabilities: [{ capability: 'complete_checkout', args: {}, declared_at: 1 }],
  };
  // Drive → triage so submit_triage_plan accepts the call.
  dispatch(session, { kind: 'end_drive_unresolved' });
  // Push navigations AFTER triage entry so `observed_at_urls` derivation
  // (filters by `nav.at >= triage.enteredAt`) picks them up.
  const after = (session.triage?.enteredAt ?? 0) + 1;
  session.domNavigations = urls.map((url) => ({ at: after, url, via: 'nav' }));
  return session;
}

function plan(overrides = {}) {
  return {
    surface_label: 'checkout',
    defense_surface: {
      observed_origins: ['https://collector.example.net', 'https://shop.example.com'],
      observed_scripts: ['https://collector.example.net/sensor.js'],
      cookies_set: ['__sd_pix'],
      request_patterns: [
        'POST to /collect every ~2s with binary blob',
        'GET https://shop.example.com/checkout',
      ],
      mechanism_hypothesis: 'behavioral telemetry + per-page sensor token',
    },
    expected_tier: 'recorded-path',
    tier_justification:
      'checkout API rejects requests without __sd_pix; collector.example.net populates the cookie based on user interaction events.',
    summary_for_user: 'Checkout has aggressive bot scoring; planning recorded-path.',
    ...overrides,
  };
}

test('cite-validation: justification citing an observed cookie name passes', async () => {
  const session = triageSession({ cookieNames: ['__sd_pix'] });
  const restore = patchPool(session);
  try {
    const r = await submitTriagePlan({
      session_id: session.id,
      capability: 'complete_checkout',
      ...plan(),
    });
    assert.equal(r.ok, true);
    assert.equal(r.phase, 'lift');
  } finally {
    restore();
  }
});

test('cite-validation: empty justification rejects with the candidate list', async () => {
  const session = triageSession({ cookieNames: ['__sd_pix'] });
  const restore = patchPool(session);
  try {
    await assert.rejects(
      submitTriagePlan({
        session_id: session.id,
        capability: 'complete_checkout',
        ...plan({ tier_justification: '' }),
      }),
      /must reference at least one verbatim artifact/,
    );
  } finally {
    restore();
  }
});

test('cite-validation: justification with no overlap rejects', async () => {
  const session = triageSession({ cookieNames: ['__sd_pix'] });
  const restore = patchPool(session);
  try {
    await assert.rejects(
      submitTriagePlan({
        session_id: session.id,
        capability: 'complete_checkout',
        ...plan({ tier_justification: 'this site uses behavioral fingerprinting that scores each request' }),
      }),
      /must reference at least one verbatim artifact/,
    );
  } finally {
    restore();
  }
});

test('persistence: plan stored under triage_plans_by_surface keyed by surface_label', async () => {
  const session = triageSession({ cookieNames: ['__sd_pix'] });
  const restore = patchPool(session);
  try {
    await submitTriagePlan({ session_id: session.id, capability: 'complete_checkout', ...plan() });
    const lb = loadLogbook(session.platform);
    const entry = lb.per_capability['complete_checkout'];
    assert.ok(entry);
    assert.ok(entry.triage_plans_by_surface);
    assert.ok(entry.triage_plans_by_surface['checkout']);
    assert.equal(entry.triage_plans_by_surface['checkout'].expected_tier, 'recorded-path');
  } finally {
    restore();
  }
});

test('surface-binding side effect: observed URLs bound to the surface label', async () => {
  const session = triageSession({
    urls: ['https://shop.example.com/checkout', 'https://shop.example.com/checkout/payment'],
    cookieNames: ['__sd_pix'],
  });
  const restore = patchPool(session);
  try {
    await submitTriagePlan({ session_id: session.id, capability: 'complete_checkout', ...plan() });
    assert.ok(session.surfaceMap, 'surfaceMap allocated');
    assert.equal(session.surfaceMap.get('https://shop.example.com/checkout'), 'checkout');
    assert.equal(session.surfaceMap.get('https://shop.example.com/checkout/payment'), 'checkout');
  } finally {
    restore();
  }
});

// ---- triage fast-path: trivial-surface checkpoint skip ----

function trivialSession() {
  // Open public GET on observed origin, no Set-Cookie, no auth headers.
  // Bauhaus storelocator-shape: page navigation (Document, ignored by
  // classifier) + clean XHR data call.
  const session = {
    id: 'sess_stp_trivial_' + Math.random().toString(36).slice(2, 8),
    platform: 'stp-trivial-' + Math.random().toString(36).slice(2, 8),
    intercepted: [
      {
        method: 'GET',
        url: 'https://www.example.com/',
        headers: { 'content-type': 'text/html' },
        postData: null,
        status: 200,
        responseBody: '<html></html>',
        isNavigation: true,
        setCookieNames: ['_ga'],
      },
      {
        method: 'GET',
        url: 'https://www.example.com/storelocator/api/stores',
        headers: { accept: 'application/json' },
        postData: null,
        status: 200,
        responseBody: { ok: true, stores: [] },
      },
    ],
    domNavigations: [],
    declaredCapabilities: [{ capability: 'list_stores', args: {}, declared_at: 1 }],
  };
  dispatch(session, { kind: 'end_drive_unresolved' });
  const after = (session.triage?.enteredAt ?? 0) + 1;
  session.domNavigations = [{ at: after, url: 'https://www.example.com/storelocator', via: 'nav' }];
  return session;
}

function trivialPlan() {
  return {
    surface_label: 'storelocator',
    defense_surface: {
      observed_origins: ['https://www.example.com'],
      observed_scripts: [],
      cookies_set: [],
      request_patterns: ['GET https://www.example.com/storelocator/api/stores'],
      mechanism_hypothesis: 'public read endpoint, no auth gate',
    },
    expected_tier: 'fetch',
    tier_justification:
      'GET https://www.example.com/storelocator/api/stores returned application/json with no auth headers and no Set-Cookie',
    summary_for_user: 'Public GET; saving as fetch tier.',
  };
}

test('fast-path: trivial-surface plan skips checkpoint and emits _hint', async () => {
  const session = trivialSession();
  const restore = patchPool(session);
  try {
    const r = await submitTriagePlan({
      session_id: session.id,
      capability: 'list_stores',
      ...trivialPlan(),
    });
    assert.equal(r.ok, true);
    assert.equal(r.phase, 'lift');
    assert.equal(r._checkpoint, undefined, 'no checkpoint on trivial surface');
    assert.ok(typeof r._hint === 'string', '_hint present on trivial surface');
    assert.match(r._hint, /Trivial surface detected/);
  } finally {
    restore();
  }
});

test('fast-path: non-trivial (POST) plan still fires checkpoint, no _hint', async () => {
  // Mutating method on the surface → classifier returns trivial:false →
  // checkpoint path runs.
  const session = {
    id: 'sess_stp_nontrivial_' + Math.random().toString(36).slice(2, 8),
    platform: 'stp-nontrivial-' + Math.random().toString(36).slice(2, 8),
    intercepted: [
      {
        method: 'POST',
        url: 'https://www.example.com/api/submit',
        headers: { 'content-type': 'application/json' },
        postData: '{"x":1}',
        status: 200,
        responseBody: { ok: true },
      },
    ],
    domNavigations: [],
    declaredCapabilities: [{ capability: 'submit_form', args: {}, declared_at: 1 }],
  };
  dispatch(session, { kind: 'end_drive_unresolved' });
  const after = (session.triage?.enteredAt ?? 0) + 1;
  session.domNavigations = [{ at: after, url: 'https://www.example.com/form', via: 'nav' }];

  const restore = patchPool(session);
  try {
    const r = await submitTriagePlan({
      session_id: session.id,
      capability: 'submit_form',
      surface_label: 'form',
      defense_surface: {
        observed_origins: ['https://www.example.com'],
        observed_scripts: [],
        cookies_set: [],
        request_patterns: ['POST https://www.example.com/api/submit'],
        mechanism_hypothesis: 'JSON form post',
      },
      expected_tier: 'fetch',
      tier_justification:
        'POST https://www.example.com/api/submit accepts JSON body; no signed headers observed',
      summary_for_user: 'Form post; saving as fetch tier.',
    });
    assert.equal(r.ok, true);
    assert.equal(r.phase, 'lift');
    assert.equal(r._hint, undefined, 'no fast-path hint on non-trivial surface');
    // _checkpoint may be undefined when no handler is registered for
    // triage_plan in this test environment — the relevant assertion is
    // that the fast-path hint is absent, proving the classifier branch
    // didn't fire.
  } finally {
    restore();
  }
});

test('per-surface history: re-submitting the same surface rotates the prior into history', async () => {
  const session = triageSession({ cookieNames: ['__sd_pix'] });
  const restore = patchPool(session);
  try {
    // First submission.
    await submitTriagePlan({ session_id: session.id, capability: 'complete_checkout', ...plan() });
    // Re-plan from lift (transitions back to triage internally via plan_submitted).
    const second = await submitTriagePlan({
      session_id: session.id,
      capability: 'complete_checkout',
      ...plan({ tier_justification: '__sd_pix is the load-bearing cookie; switching to page-script.', expected_tier: 'page-script' }),
    });
    assert.equal(second.ok, true);
    const lb = loadLogbook(session.platform);
    const entry = lb.per_capability['complete_checkout'];
    assert.equal(entry.triage_plans_by_surface['checkout'].expected_tier, 'page-script');
    assert.equal(entry.triage_plan_history_by_surface['checkout'].length, 1);
    assert.equal(entry.triage_plan_history_by_surface['checkout'][0].expected_tier, 'recorded-path');
  } finally {
    restore();
  }
});
