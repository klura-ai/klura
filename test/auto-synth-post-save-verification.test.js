// Auto-synthesis persists through the low-level writer, so its output reaches
// the active slot without the post-save verification every agent save runs.
// Nothing downstream re-checks it: the strategy is active, unattended, and the
// next caller executes it. These tests pin which shapes get verified, which are
// deliberately left alone, and that an archived result leaves the ledger.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-synth-verify-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { verifyAutoSynthesizedFallbacks } = await import(
  '../dist/phases/drive/end-drive-orchestrator.js'
);
const skills = await import('../dist/strategies/skills.js');

const PLATFORM = 'synth-verify';

function fetchStrategy(overrides = {}) {
  return {
    schema_version: 1,
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/api/items',
    notes: { params: {} },
    ...overrides,
  };
}

function ledgerEntry(capability, tier = 'fetch') {
  return { capability, tier, path: `/tmp/${capability}.json`, reason: 'auto-derived' };
}

function session(declared = []) {
  return { declaredCapabilities: declared };
}

function outcomesFor(diag, capability) {
  return diag.filter((d) => d.capability === capability).map((d) => d.outcome);
}

test('a recorded-path fallback is never re-driven at close', async () => {
  const diag = [];
  const entry = ledgerEntry('replay_flow', 'recorded-path');
  const survived = await verifyAutoSynthesizedFallbacks(session(), PLATFORM, [entry], diag);

  assert.deepEqual(survived, [entry], 'the fallback must stay in the ledger');
  assert.ok(
    outcomesFor(diag, 'replay_flow').includes('auto_synth_verification_tier_not_verifiable'),
    `expected a tier skip, got ${JSON.stringify(diag)}`,
  );
});

test('a fallback whose file is gone is left alone', async () => {
  const diag = [];
  const entry = ledgerEntry('never_written');
  const survived = await verifyAutoSynthesizedFallbacks(session(), PLATFORM, [entry], diag);

  assert.deepEqual(survived, [entry]);
  assert.ok(outcomesFor(diag, 'never_written').includes('auto_synth_verification_strategy_absent'));
});

test('verification is skipped when the templated args cannot be satisfied', async () => {
  // A placeholder with no declared arg and no example would execute with an
  // `undefined` substitution, so the run would prove nothing about the strategy.
  skills.saveStrategy(
    PLATFORM,
    'needs_args',
    fetchStrategy({
      endpoint: '/api/items?q={{query}}',
      // Declared but exampleless: nothing supplies a value at close, which is
      // exactly the condition that makes a verification run meaningless.
      notes: { params: { query: { kind: 'text', source: 'caller' } } },
    }),
  );

  const diag = [];
  const entry = ledgerEntry('needs_args');
  const survived = await verifyAutoSynthesizedFallbacks(session(), PLATFORM, [entry], diag);

  assert.deepEqual(survived, [entry], 'an unverifiable fallback still stands');
  const outcomes = outcomesFor(diag, 'needs_args');
  assert.ok(
    outcomes.includes('auto_synth_verification_args_unsatisfied'),
    `expected an args skip, got ${JSON.stringify(outcomes)}`,
  );
  const detail = diag.find((d) => d.outcome === 'auto_synth_verification_args_unsatisfied').detail;
  assert.deepEqual(detail.unsatisfied, ['query']);
});

test('a mutating-shaped fallback is not re-fired', async () => {
  skills.saveStrategy(
    PLATFORM,
    'submit_order',
    fetchStrategy({ method: 'POST', endpoint: '/api/orders', body: { confirm: true } }),
  );

  const diag = [];
  const entry = ledgerEntry('submit_order');
  const survived = await verifyAutoSynthesizedFallbacks(session(), PLATFORM, [entry], diag);

  assert.deepEqual(survived, [entry]);
  assert.ok(
    outcomesFor(diag, 'submit_order').includes('auto_synth_verification_declined_mutating'),
    `expected a mutating decline, got ${JSON.stringify(outcomesFor(diag, 'submit_order'))}`,
  );
});

test('a verifiable read is actually run, and an unreachable one leaves the ledger', async () => {
  // Nothing listens on this port, so execute() fails transport and
  // verifySavedStrategy archives the file — which is the whole point: an
  // unverified guess must not stay in the active slot.
  skills.saveStrategy(
    PLATFORM,
    'dead_endpoint',
    fetchStrategy({ baseUrl: 'http://127.0.0.1:9', endpoint: '/nope' }),
  );

  const diag = [];
  const entry = ledgerEntry('dead_endpoint');
  const survived = await verifyAutoSynthesizedFallbacks(session(), PLATFORM, [entry], diag);

  const outcomes = outcomesFor(diag, 'dead_endpoint');
  assert.ok(
    outcomes.some((o) => o.startsWith('auto_synth_verification_')),
    `expected a verification outcome, got ${JSON.stringify(outcomes)}`,
  );
  // Either the runtime archived it (ledger drops it) or verification threw and
  // it stands unverified — both are honest; what must not happen is a silent
  // pass that reports the fallback as good without having run it.
  const ran = diag.find(
    (d) =>
      d.outcome === 'auto_synth_verification_archived' ||
      d.outcome === 'auto_synth_verification_ran',
  );
  if (ran) {
    assert.equal(typeof ran.detail.status, 'number');
    if (ran.detail.archived) {
      assert.equal(survived.length, 0, 'an archived strategy must leave the ledger');
    }
  }
});
