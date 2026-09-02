// C4b: the escalation score, not the raw count.
//
// `origin_blocked` on the abort ledger is never a runtime detection — it is
// the `kind` an agent handed to abort_session, persisted and replayed to every
// later session as if it were a measurement. Weighting each entry by
// provenance and recency is what keeps three claims from reading like three
// observations, and deduping by session_id is what keeps one stuck session
// from manufacturing a pattern by itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-abort-escalation-'));
process.env.KLURA_HOME = TMP;

const { computeAbortEscalation } = await import('../dist/tools/start-session.js');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function abort(overrides = {}) {
  return {
    session_id: `s_${Math.random().toString(36).slice(2, 10)}`,
    kind: 'anti_bot',
    host: 'shop.test',
    hours_since: 1,
    provenance: 'agent_asserted',
    ...overrides,
  };
}

function observed(overrides = {}) {
  return abort({ provenance: 'runtime_observed', ...overrides });
}

test('three runtime-observed aborts escalate at full strength', () => {
  const result = computeAbortEscalation([observed(), observed(), observed()]);
  assert.ok(result);
  assert.equal(result.score, 3);
  assert.equal(result.runtime_observed_count, 3);
  assert.equal(result.agent_asserted_count, 0);
});

test('three agent-asserted aborts score 1.2 and do not escalate', () => {
  assert.equal(computeAbortEscalation([abort(), abort(), abort()]), undefined);
});

test('even seven agent-asserted aborts stay under the threshold at the default weight', () => {
  const seven = Array.from({ length: 7 }, () => abort());
  assert.equal(computeAbortEscalation(seven), undefined);
});

test('an unstamped historical entry weighs as a claim, not an observation', () => {
  // Entries written before provenance existed carry no field. Defaulting them
  // to `runtime_observed` would re-create the bug on old ledgers.
  const legacy = [
    { session_id: 's1', kind: 'anti_bot', host: 'shop.test', hours_since: 1 },
    { session_id: 's2', kind: 'anti_bot', host: 'shop.test', hours_since: 1 },
    { session_id: 's3', kind: 'anti_bot', host: 'shop.test', hours_since: 1 },
  ];
  assert.equal(computeAbortEscalation(legacy), undefined);
});

test('a mixed ledger reaches the threshold on real observations plus claims', () => {
  const result = computeAbortEscalation([observed(), observed(), abort(), abort(), abort()]);
  // 2 × 1.0 + 3 × 0.4 = 3.2
  assert.ok(result);
  assert.equal(result.score, 3.2);
  assert.equal(result.runtime_observed_count, 2);
  assert.equal(result.agent_asserted_count, 3);
  assert.equal(result.same_root_cause_count, 5);
});

test('recency decay halves an entry per half-life', () => {
  // Default half-life is 12h: 13h old → 0.5, 25h old → outside the window.
  const stale = computeAbortEscalation([
    observed({ hours_since: 13 }),
    observed({ hours_since: 13 }),
    observed({ hours_since: 13 }),
  ]);
  assert.equal(stale, undefined, '3 × 0.5 = 1.5 is below the threshold');

  const fresh = computeAbortEscalation([
    observed({ hours_since: 1 }),
    observed({ hours_since: 11 }),
    observed({ hours_since: 11.9 }),
  ]);
  assert.ok(fresh, 'entries inside one half-life all count fully');
  assert.equal(fresh.score, 3);
});

test('aborts older than the 24h window are ignored entirely', () => {
  assert.equal(
    computeAbortEscalation([
      observed({ hours_since: 25 }),
      observed({ hours_since: 30 }),
      observed({ hours_since: 100 }),
      observed({ hours_since: 1 }),
    ]),
    undefined,
  );
});

test('one session that aborted repeatedly cannot stack into a pattern', () => {
  const result = computeAbortEscalation([
    observed({ session_id: 'stuck', hours_since: 1 }),
    observed({ session_id: 'stuck', hours_since: 2 }),
    observed({ session_id: 'stuck', hours_since: 3 }),
    observed({ session_id: 'stuck', hours_since: 4 }),
  ]);
  assert.equal(result, undefined, 'four aborts from one session are one experience');
});

test('dedupe keeps the freshest entry per session', () => {
  const result = computeAbortEscalation([
    observed({ session_id: 'a', hours_since: 20 }),
    observed({ session_id: 'a', hours_since: 1 }),
    observed({ session_id: 'b', hours_since: 1 }),
    observed({ session_id: 'c', hours_since: 1 }),
  ]);
  assert.ok(result);
  assert.equal(result.same_root_cause_count, 3);
  assert.equal(result.score, 3, 'the 20h-old duplicate must not drag the fresh entry down');
});

test('entries without a session_id are each counted (nothing to attribute them to)', () => {
  const result = computeAbortEscalation([
    { kind: 'anti_bot', host: 'shop.test', hours_since: 1, provenance: 'runtime_observed' },
    { kind: 'anti_bot', host: 'shop.test', hours_since: 1, provenance: 'runtime_observed' },
    { kind: 'anti_bot', host: 'shop.test', hours_since: 1, provenance: 'runtime_observed' },
  ]);
  assert.ok(result);
  assert.equal(result.same_root_cause_count, 3);
});

test('different hosts do not share a root cause', () => {
  assert.equal(
    computeAbortEscalation([
      observed({ host: 'a.test' }),
      observed({ host: 'b.test' }),
      observed({ host: 'c.test' }),
    ]),
    undefined,
  );
});

test('the highest-scoring group wins when several qualify', () => {
  const result = computeAbortEscalation([
    observed({ kind: 'anti_bot', host: 'a.test' }),
    observed({ kind: 'anti_bot', host: 'a.test' }),
    observed({ kind: 'anti_bot', host: 'a.test' }),
    observed({ kind: 'captcha', host: 'b.test' }),
    observed({ kind: 'captcha', host: 'b.test' }),
    observed({ kind: 'captcha', host: 'b.test' }),
    observed({ kind: 'captcha', host: 'b.test' }),
  ]);
  assert.ok(result);
  assert.equal(result.kind, 'captcha');
  assert.equal(result.score, 4);
});

test('weights are configurable without a code change', () => {
  const three = [abort(), abort(), abort()];
  assert.equal(computeAbortEscalation(three), undefined);
  assert.ok(
    computeAbortEscalation(three, { agentAssertedWeight: 1 }),
    'weighting agent claims at parity restores the old raw-count behavior',
  );
  assert.equal(
    computeAbortEscalation([observed(), observed(), observed()], { halfLifeHours: 1 }),
    undefined,
    'a 1h half-life decays even fresh observations below the threshold',
  );
});

test('config drives the default weighting', async () => {
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ drive: { abort_escalation: { agent_asserted_weight: 1 } } }),
  );
  try {
    const result = computeAbortEscalation([abort(), abort(), abort()]);
    assert.ok(result, 'pool config must reach the scorer without an explicit override');
    assert.equal(result.score, 3);
  } finally {
    fs.rmSync(path.join(TMP, 'config.json'), { force: true });
  }
});
