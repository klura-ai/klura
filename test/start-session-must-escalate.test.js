// start_session.must_escalate: when aborts within 24h sharing one root cause
// (same kind + host) reach the weighted escalation threshold, the response
// surfaces an advisory so the agent reads the pattern before repeating it.
// Weighting (provenance × recency) is covered in depth by
// abort-escalation-provenance.test.js; these cases pin the threshold itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-must-escalate-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { appendAbortEvent } = await import('../dist/working-dir/logbook.js');
// Import the start-session module-internal computeAbortEscalation indirectly
// by checking the populated response on the public surface. start_session
// itself spins up a browser session — we don't want that — so test the
// helper via its public response shape: populatePlatformResponseFields
// runs from start_session at the point where the response object is built,
// and the helper is exported via the module's response shape contract.
// Easiest: drive via readRecentAborts + the exported escalation policy.
const logbook = await import('../dist/working-dir/logbook.js');

function makeAborts(platform, entries) {
  for (const e of entries) {
    appendAbortEvent(platform, {
      session_id: e.session_id ?? `sess_${Math.random().toString(36).slice(2, 10)}`,
      reason: e.reason ?? 'test abort',
      kind: e.kind,
      host: e.host,
      provenance: e.provenance,
      captured_actions_count: 0,
      phase_at_abort: 'drive',
    });
  }
}

test('readRecentAborts returns enriched entries with hours_since', () => {
  const platform = 'test-escalation-base';
  makeAborts(platform, [
    { kind: 'origin_blocked', host: 'example.com', session_id: 'sess_1' },
  ]);
  const aborts = logbook.readRecentAborts(platform, 10);
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0].kind, 'origin_blocked');
  assert.equal(aborts[0].host, 'example.com');
  assert.equal(typeof aborts[0].hours_since, 'number');
});

// Direct tests of the real helper. Ledger entries go in through the real
// appender so the shape the helper scores is the shape that is persisted.
const { computeAbortEscalation } = await import('../dist/tools/start-session.js');

test('ledger → helper: 2 same-cause aborts stay below the threshold', () => {
  const platform = 'test-escalation-below';
  makeAborts(platform, [
    { kind: 'origin_blocked', host: 'example.com', session_id: 's1', provenance: 'runtime_observed' },
    { kind: 'origin_blocked', host: 'example.com', session_id: 's2', provenance: 'runtime_observed' },
  ]);
  assert.equal(computeAbortEscalation(logbook.readRecentAborts(platform, 50)), undefined);
});

test('ledger → helper: 3 runtime-observed same-cause aborts within 24h escalate', () => {
  const platform = 'test-escalation-trigger';
  makeAborts(platform, [
    { kind: 'origin_blocked', host: 'example.com', session_id: 's1', provenance: 'runtime_observed' },
    { kind: 'origin_blocked', host: 'example.com', session_id: 's2', provenance: 'runtime_observed' },
    { kind: 'origin_blocked', host: 'example.com', session_id: 's3', provenance: 'runtime_observed' },
  ]);
  const result = computeAbortEscalation(logbook.readRecentAborts(platform, 50));
  assert.ok(result, 'three fresh runtime-observed aborts must escalate');
  assert.equal(result.same_root_cause_count, 3);
});

test('escalation: distinct kinds do not coalesce', () => {
  const platform = 'test-escalation-distinct';
  makeAborts(platform, [
    { kind: 'origin_blocked', host: 'example.com', session_id: 's1', provenance: 'runtime_observed' },
    { kind: 'origin_blocked', host: 'example.com', session_id: 's2', provenance: 'runtime_observed' },
    { kind: 'site_dead', host: 'example.com', session_id: 's3', provenance: 'runtime_observed' },
  ]);
  // Two origin_blocked + one site_dead — neither group reaches the threshold.
  assert.equal(computeAbortEscalation(logbook.readRecentAborts(platform, 50)), undefined);
});

/** Runtime-corroborated abort event — full weight, so three of them sit
 *  exactly on the threshold. */
function observed(overrides) {
  return {
    kind: 'origin_blocked',
    host: 'example.com',
    provenance: 'runtime_observed',
    ...overrides,
  };
}

test('escalation: 3x existing_capability_covers (benign reads) → no advisory', () => {
  const aborts = [
    observed({ kind: 'existing_capability_covers', hours_since: 1, session_id: 's1' }),
    observed({ kind: 'existing_capability_covers', hours_since: 2, session_id: 's2' }),
    observed({ kind: 'existing_capability_covers', hours_since: 3, session_id: 's3' }),
  ];
  assert.equal(
    computeAbortEscalation(aborts),
    undefined,
    'benign existing_capability_covers reads must not escalate',
  );
});

test('escalation: 3x runtime-observed origin_blocked → advisory fires (block class)', () => {
  const aborts = [
    observed({ hours_since: 1, session_id: 's1' }),
    observed({ hours_since: 2, session_id: 's2' }),
    observed({ hours_since: 3, session_id: 's3' }),
  ];
  const result = computeAbortEscalation(aborts);
  assert.ok(result, 'origin_blocked repeats must escalate');
  assert.equal(result.kind, 'origin_blocked');
  assert.equal(result.same_root_cause_count, 3);
  assert.equal(result.runtime_observed_count, 3);
  assert.equal(result.agent_asserted_count, 0);
  assert.equal(result.score, 3);
});

test('escalation: 3x agent-asserted origin_blocked → below threshold, no advisory', () => {
  // Same count, same kind, same host — but nothing corroborated them. Three
  // claims are 1.2, not 3.
  const aborts = [
    { kind: 'origin_blocked', host: 'example.com', hours_since: 1, session_id: 's1' },
    { kind: 'origin_blocked', host: 'example.com', hours_since: 2, session_id: 's2' },
    { kind: 'origin_blocked', host: 'example.com', hours_since: 3, session_id: 's3' },
  ];
  assert.equal(computeAbortEscalation(aborts), undefined);
});

test('escalation: benign kinds do not dilute / mask a real block', () => {
  // 3 benign + 3 blocks interleaved → still escalates on the blocks only.
  const aborts = [
    observed({ kind: 'existing_capability_covers', hours_since: 1, session_id: 's1' }),
    observed({ hours_since: 2, session_id: 's2' }),
    observed({ kind: 'user_stop', hours_since: 3, session_id: 's3' }),
    observed({ hours_since: 4, session_id: 's4' }),
    observed({ kind: 'site_dead', hours_since: 5, session_id: 's5' }),
    observed({ hours_since: 6, session_id: 's6' }),
  ];
  const result = computeAbortEscalation(aborts);
  assert.ok(result, 'three origin_blocked among benign kinds must still escalate');
  assert.equal(result.kind, 'origin_blocked');
  assert.equal(result.same_root_cause_count, 3);
});

test('escalation advisory: states the provenance mix, never asserts the site is still blocking', () => {
  const result = computeAbortEscalation([
    observed({ hours_since: 1, session_id: 's1' }),
    observed({ hours_since: 2, session_id: 's2' }),
    { kind: 'origin_blocked', host: 'example.com', hours_since: 3, session_id: 's3' },
    observed({ hours_since: 4, session_id: 's4' }),
  ]);
  assert.ok(result);
  assert.equal(result.runtime_observed_count, 3);
  assert.equal(result.agent_asserted_count, 1);
  assert.match(result.advisory, /3 corroborated by the runtime's own origin-blocked detector/);
  assert.match(result.advisory, /1 agent-asserted/);
  assert.match(result.advisory, /CLAIM a prior session recorded, not an observation/);
  assert.doesNotMatch(result.advisory, /will not work/);
  assert.doesNotMatch(result.advisory, /underlying gate has not changed/);
});
