// `surface_triage_missing` — the save-time gate that requires every save
// to target a surface bound to a triage plan. Tier-agnostic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-surface-gate-'));
process.env.KLURA_HOME = TMP;

const { saveStrategyAudit } = await import('../dist/audit/save-strategy.js');
const { bindUrlsToSurface } = await import('../dist/phases/surface-binding.js');
const { loadLogbook, writeLogbook } = await import('../dist/working-dir/logbook.js');

// Bypass Stage 0 shape checks — detector behavior under test, fixtures are
// minimal by design.
const _origProcess = saveStrategyAudit.process.bind(saveStrategyAudit);
saveStrategyAudit.process = (data, ctx, input) =>
  _origProcess(data, ctx, { skipShapeChecks: true, ...(input ?? {}) });

function liftSession({ surfaceMap = new Map(), platform = 'gate-test' } = {}) {
  return {
    id: 'sess_gate',
    phase: 'lift',
    platform,
    intercepted: [],
    surfaceMap,
    lift: { handoffAt: 0, roundsSinceHandoff: 0, budget: 0, softBlockEngaged: false },
  };
}

function ctx(session) {
  return {
    sessionId: 'sess_gate',
    capability: 'send_message',
    session,
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
    observedUrls: [],
  };
}

function fetchStrategy() {
  return {
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'POST /api/messages',
    method: 'POST',
    body: { text: 'hi' },
  };
}

function pageScriptStrategy() {
  return {
    strategy: 'page-script',
    baseUrl: 'https://example.com',
    endpoint: 'POST /api/messages',
    method: 'POST',
    body: { text: 'hi' },
    notes: { anchor_type: 'module' },
  };
}

function recordedPathStrategy() {
  return {
    strategy: 'recorded-path',
    steps: [
      { action: 'navigate', url: 'https://example.com/compose' },
      { action: 'type', selector: 'input[name=text]', value: 'hi' },
      { action: 'click', selector: 'button[type=submit]' },
    ],
  };
}

function bindAndPersist(session, label, urls) {
  bindUrlsToSurface(session, label, urls);
  const logbook = loadLogbook(session.platform);
  logbook.per_capability['send_message'] = {
    sessions_contributed: 1,
    last_session_at: new Date().toISOString(),
    last_session_id: session.id,
    lift_attempts: [],
    strategy_events: [],
    current_tier: 'none',
    data_sufficiency: { captures_of_target_endpoint: 0, field_stability_confidence: 'low', known_rotating_fields: [], known_stable_fields: [], ambiguous_fields: [] },
    triage_plans_by_surface: {
      [label]: {
        recorded_at: new Date().toISOString(),
        session_id: session.id,
        surface_label: label,
        observed_at_urls: urls,
        defense_surface: { observed_origins: [], observed_scripts: [], cookies_set: [], request_patterns: [], mechanism_hypothesis: '' },
        expected_tier: 'fetch',
        tier_justification: 'cite',
        summary_for_user: 'ok',
      },
    },
  };
  writeLogbook(logbook);
}

test('surface_triage_missing fires when no surface is bound (fetch)', () => {
  const session = liftSession();
  const r = saveStrategyAudit.process(fetchStrategy(), ctx(session), {});
  assert.equal(r.status, 'rejected');
  const w = (r.rejection.warnings || []).find((x) => x.kind === 'surface_triage_missing');
  assert.ok(w, 'expected surface_triage_missing warning');
  assert.match(w.message, /doesn't match the `request_patterns` of any triaged surface/);
});

test('surface_triage_missing fires when no surface is bound (page-script)', () => {
  const session = liftSession();
  const r = saveStrategyAudit.process(pageScriptStrategy(), ctx(session), {});
  const w = (r.rejection.warnings || []).find((x) => x.kind === 'surface_triage_missing');
  assert.ok(w, 'tier-agnostic: page-script also gates');
});

test('surface_triage_missing fires when no surface is bound (recorded-path)', () => {
  const session = liftSession();
  const r = saveStrategyAudit.process(recordedPathStrategy(), ctx(session), {});
  const w = (r.rejection.warnings || []).find((x) => x.kind === 'surface_triage_missing');
  assert.ok(w, 'tier-agnostic: recorded-path also gates (firstObservableUrl from first navigate step)');
});

test('surface_triage_missing silent when phase is not lift/triage (programmatic save)', () => {
  const session = { id: 'sess_drive', phase: 'drive', platform: 'gate-test', intercepted: [] };
  const r = saveStrategyAudit.process(fetchStrategy(), ctx(session), {});
  const w = (r.rejection?.warnings || []).find((x) => x.kind === 'surface_triage_missing');
  assert.equal(w, undefined, 'drive-phase saves bypass the surface gate (admissibility blocks save in drive anyway)');
});

test('surface_triage_missing passes when the surface is bound + plan exists', () => {
  const session = liftSession({ platform: 'gate-test-pass' });
  bindAndPersist(session, 'messaging', ['https://example.com/api/messages']);
  const r = saveStrategyAudit.process(fetchStrategy(), { ...ctx(session), capability: 'send_message' }, {});
  const w = (r.rejection?.warnings || []).find((x) => x.kind === 'surface_triage_missing');
  assert.equal(w, undefined, 'no surface_triage_missing when surface + plan are present');
});
