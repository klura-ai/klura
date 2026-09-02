// Broken-tier probation: a `broken` tier is skipped by the executor, which
// means it never appends another outcome — so without a probe its record is
// frozen and the tier is quarantined forever, even after the site recovers.
// These tests pin the probation policy that unfreezes it, and the clock stamp
// that stops the probe re-firing on every call.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-broken-probation-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const health = await import('../dist/strategies/health.js');
const { execute } = await import('../dist/index.js');
const {
  markFailed,
  markHealed,
  getHealth,
  evaluateBrokenTierProbation,
  shouldSkipBrokenTier,
  describeBrokenTierSkip,
  markProbeAttempted,
} = health;

const HOUR = 3_600_000;

function breakTier(platform, capability, type) {
  for (let i = 0; i < 5; i++) markFailed(platform, capability, type, 'boom');
  assert.equal(getHealth(platform, capability, type).status, 'broken');
}

test('probation: a healthy tier always runs', () => {
  const status = { status: 'healthy', failureCount: 0 };
  assert.deepEqual(evaluateBrokenTierProbation(status, 6), { action: 'run' });
});

test('probation: a degraded tier always runs (only broken is gated)', () => {
  const status = { status: 'degraded', failureCount: 2, lastFailure: Date.now() };
  assert.deepEqual(evaluateBrokenTierProbation(status, 6), { action: 'run' });
});

test('probation: broken inside the window is skipped and names its next probe', () => {
  const now = Date.now();
  const status = { status: 'broken', failureCount: 5, lastFailure: now - 1 * HOUR };
  const decision = evaluateBrokenTierProbation(status, 6, now);
  assert.equal(decision.action, 'skip');
  assert.equal(decision.nextProbeAt, now - 1 * HOUR + 6 * HOUR);
  assert.match(describeBrokenTierSkip(decision), /next probation probe at \d{4}-/);
});

test('probation: broken past the window is probed', () => {
  const now = Date.now();
  const status = { status: 'broken', failureCount: 5, lastFailure: now - 7 * HOUR };
  const decision = evaluateBrokenTierProbation(status, 6, now);
  assert.equal(decision.action, 'probe');
  assert.equal(decision.sinceLastFailureMs, 7 * HOUR);
});

test('probation: lastProbeAt holds the clock even when lastFailure is stale', () => {
  // The failure is 3 days old but a probe ran an hour ago and returned a
  // health-silent outcome (not_run / delivery_unknown). Without lastProbeAt in
  // the max() the tier would be probed on every single call.
  const now = Date.now();
  const status = {
    status: 'broken',
    failureCount: 5,
    lastFailure: now - 72 * HOUR,
    lastProbeAt: now - 1 * HOUR,
  };
  const decision = evaluateBrokenTierProbation(status, 6, now);
  assert.equal(decision.action, 'skip');
  assert.equal(decision.nextProbeAt, now - 1 * HOUR + 6 * HOUR);
});

test('probation: 0 hours disables probation and says so', () => {
  const now = Date.now();
  const status = { status: 'broken', failureCount: 5, lastFailure: now - 999 * HOUR };
  const decision = evaluateBrokenTierProbation(status, 0, now);
  assert.equal(decision.action, 'skip');
  assert.equal(decision.nextProbeAt, null);
  assert.match(describeBrokenTierSkip(decision), /probation disabled/);
});

test('probation: a broken tier with no lastFailure is immediately probe-eligible', () => {
  // Hand-edited or migrated record. Treating "no clock" as "never eligible"
  // would be the freeze bug in a different costume.
  const decision = evaluateBrokenTierProbation({ status: 'broken', failureCount: 5 }, 6);
  assert.equal(decision.action, 'probe');
});

test('markProbeAttempted: stamps the clock on disk and flips probe → skip', () => {
  const platform = 'probation-stamp';
  breakTier(platform, 'read_items', 'fetch');
  // Age the failure past the window so the tier is probe-eligible.
  const decisionBefore = shouldSkipBrokenTier(platform, 'read_items', 'fetch', {
    probationHours: 6,
    now: Date.now() + 7 * HOUR,
  });
  assert.equal(decisionBefore.action, 'probe');

  markProbeAttempted(platform, 'read_items', 'fetch');
  assert.equal(typeof getHealth(platform, 'read_items', 'fetch').lastProbeAt, 'number');

  // One hour after the stamp the tier is quiet again even though the failure
  // is older than the window — that is the whole point of the stamp.
  const decisionAfter = shouldSkipBrokenTier(platform, 'read_items', 'fetch', {
    probationHours: 6,
    now: Date.now() + 1 * HOUR,
  });
  assert.equal(
    decisionAfter.action,
    'skip',
    'a stamped probe must not re-fire until the next window elapses',
  );

  // A full window after the stamp it gets another shot.
  const decisionNextWindow = shouldSkipBrokenTier(platform, 'read_items', 'fetch', {
    probationHours: 6,
    now: Date.now() + 7 * HOUR,
  });
  assert.equal(decisionNextWindow.action, 'probe');
});

test('markProbeAttempted: preserves the rest of the record', () => {
  const platform = 'probation-preserve';
  breakTier(platform, 'read_items', 'page-script');
  const before = getHealth(platform, 'read_items', 'page-script');
  markProbeAttempted(platform, 'read_items', 'page-script');
  const after = getHealth(platform, 'read_items', 'page-script');
  assert.equal(after.status, 'broken');
  assert.equal(after.failureCount, before.failureCount);
  assert.equal(after.lastError, before.lastError);
  assert.deepEqual(after.recent, before.recent);
});

test('markProbeAttempted: no-op on a tier with no health record', () => {
  markProbeAttempted('probation-unknown', 'nothing', 'fetch');
  assert.equal(getHealth('probation-unknown', 'nothing', 'fetch').lastProbeAt, undefined);
});

test('shouldSkipBrokenTier: reads pool.brokenProbationHours from config', () => {
  const platform = 'probation-config';
  breakTier(platform, 'read_items', 'fetch');
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ pool: { brokenProbationHours: 0 } }),
  );
  const disabled = shouldSkipBrokenTier(platform, 'read_items', 'fetch', {
    now: Date.now() + 999 * HOUR,
  });
  assert.equal(disabled.action, 'skip');
  assert.equal(disabled.nextProbeAt, null, 'config 0 restores permanent quarantine');

  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ pool: { brokenProbationHours: 1 } }),
  );
  const enabled = shouldSkipBrokenTier(platform, 'read_items', 'fetch', {
    now: Date.now() + 2 * HOUR,
  });
  assert.equal(enabled.action, 'probe');
  fs.rmSync(path.join(TMP, 'config.json'), { force: true });
});

test('markHealed clears the probation clock', () => {
  const platform = 'probation-heal';
  breakTier(platform, 'read_items', 'fetch');
  markProbeAttempted(platform, 'read_items', 'fetch');
  assert.equal(typeof getHealth(platform, 'read_items', 'fetch').lastProbeAt, 'number');
  markHealed(platform, 'read_items', 'fetch');
  const healed = getHealth(platform, 'read_items', 'fetch');
  assert.equal(healed.status, 'healthy');
  assert.equal(healed.lastProbeAt, undefined);
});

test('get_strategy_health: exposes quarantined + probe_eligible_at', async () => {
  const platform = 'probation-surface';
  breakTier(platform, 'read_items', 'fetch');
  const { getStrategyHealth } = await import('../dist/tools/health.js');
  const row = getStrategyHealth({ platform }).entries.find((e) => e.capability === 'read_items');
  assert.ok(row);
  assert.equal(row.status, 'broken');
  assert.equal(row.quarantined, true, 'a freshly-broken tier is inside its probation window');
  assert.equal(typeof row.probe_eligible_at, 'number');
  assert.ok(row.probe_eligible_at > Date.now(), 'next probe is in the future');
});

test('get_strategy_health: a healthy tier is never quarantined', async () => {
  const platform = 'probation-surface-healthy';
  health.markHealthy(platform, 'read_items', 'fetch');
  const { getStrategyHealth } = await import('../dist/tools/health.js');
  const row = getStrategyHealth({ platform }).entries.find((e) => e.capability === 'read_items');
  assert.ok(row);
  assert.equal(row.quarantined, false);
  assert.equal(row.probe_eligible_at, null);
});

// --- executor end-to-end: the frozen record actually thaws ---------------
//
// The bug lives in the cascade: a broken tier is skipped BEFORE it runs, so
// no outcome is ever appended and the record can never change. These drive
// the real `execute()` over a mocked Node fetch.

const skillsMod = await import('../dist/strategies/skills.js');
const runtimeState = await import('../dist/runtime-state/index.js');
const { healthPath } = await import('../dist/working-dir/layout.js');

const realFetch = globalThis.fetch;
let fetchCalls = [];

function installMockFetch() {
  fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), method: init.method ?? 'GET' });
    return new Response(JSON.stringify({ ok: true, items: [{ id: 1 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function restoreFetch() {
  globalThis.fetch = realFetch;
  fetchCalls = [];
}

test.after(async () => {
  restoreFetch();
  await runtimeState.pool.shutdown();
});

function seedFetchStrategy(platform, capability) {
  skillsMod.saveStrategy(platform, capability, {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://api.example.com',
    endpoint: '/search?q={{query}}',
    headers: {},
    notes: { params: { query: { description: 'search string', kind: 'text', example: 'hi' } } },
  });
}

/** Rewrite the persisted lastFailure so the tier's probation window has
 *  already elapsed. Cheaper and more honest than waiting six hours. */
function ageLastFailure(platform, capability, type, hours) {
  const file = healthPath(platform);
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  data[`${capability}/${type}`].lastFailure = Date.now() - hours * HOUR;
  fs.writeFileSync(file, JSON.stringify(data));
}

test('execute: a broken tier inside probation is skipped, and the trail names the next probe', async () => {
  const platform = 'probation-exec-skip';
  installMockFetch();
  try {
    seedFetchStrategy(platform, 'search');
    breakTier(platform, 'search', 'fetch');
    const result = await execute(platform, 'search', { query: 'hello' });
    assert.equal(fetchCalls.length, 0, 'the tier must not fire inside its probation window');
    const errors = JSON.stringify(result.body);
    assert.match(errors, /broken \(skipped/);
    assert.match(errors, /next probation probe at/);
  } finally {
    restoreFetch();
  }
});

test('execute: a broken tier past probation runs, and a clean outcome unfreezes the record', async () => {
  const platform = 'probation-exec-thaw';
  installMockFetch();
  try {
    seedFetchStrategy(platform, 'search');
    breakTier(platform, 'search', 'fetch');
    ageLastFailure(platform, 'search', 'fetch', 7);

    const result = await execute(platform, 'search', { query: 'hello' });
    assert.equal(result.status, 200);
    assert.equal(fetchCalls.length, 1, 'the probation probe must actually fire the request');
    const after = getHealth(platform, 'search', 'fetch');
    assert.equal(after.status, 'healthy', 'the probe outcome re-decides health');
    assert.equal(after.failureCount, 0);
  } finally {
    restoreFetch();
  }
});

test('execute: probation disabled (0) keeps the tier quarantined forever', async () => {
  const platform = 'probation-exec-disabled';
  installMockFetch();
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ pool: { brokenProbationHours: 0 } }),
  );
  try {
    seedFetchStrategy(platform, 'search');
    breakTier(platform, 'search', 'fetch');
    ageLastFailure(platform, 'search', 'fetch', 999);
    const result = await execute(platform, 'search', { query: 'hello' });
    assert.equal(fetchCalls.length, 0);
    assert.match(JSON.stringify(result.body), /probation disabled/);
  } finally {
    restoreFetch();
    fs.rmSync(path.join(TMP, 'config.json'), { force: true });
  }
});
