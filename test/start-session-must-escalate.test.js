// start_session.must_escalate: when ≥3 aborts within 24h share root cause
// (same kind + host), the response surfaces an advisory so the agent can't
// burn another session on the same wall.

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

test('escalation threshold: <3 same-cause aborts → no advisory (sanity)', () => {
  const platform = 'test-escalation-below';
  makeAborts(platform, [
    { kind: 'origin_blocked', host: 'example.com' },
    { kind: 'origin_blocked', host: 'example.com' },
  ]);
  const aborts = logbook.readRecentAborts(platform, 50);
  // Mirror the helper's logic inline for the assertion — the helper itself
  // is module-internal to start-session.ts. Counting same kind+host within
  // 24h must be < 3 here.
  const recent = aborts.filter((a) => a.hours_since <= 24);
  const sameCause = recent.filter(
    (a) => a.kind === 'origin_blocked' && a.host === 'example.com',
  );
  assert.ok(sameCause.length < 3);
});

test('escalation threshold: ≥3 same-cause aborts within 24h → triggers', () => {
  const platform = 'test-escalation-trigger';
  makeAborts(platform, [
    { kind: 'origin_blocked', host: 'example.com' },
    { kind: 'origin_blocked', host: 'example.com' },
    { kind: 'origin_blocked', host: 'example.com' },
  ]);
  const aborts = logbook.readRecentAborts(platform, 50);
  const recent = aborts.filter((a) => a.hours_since <= 24);
  const sameCause = recent.filter(
    (a) => a.kind === 'origin_blocked' && a.host === 'example.com',
  );
  assert.ok(sameCause.length >= 3, `expected ≥3 same-cause aborts, got ${sameCause.length}`);
});

test('escalation: distinct kinds do not coalesce', () => {
  const platform = 'test-escalation-distinct';
  makeAborts(platform, [
    { kind: 'origin_blocked', host: 'example.com' },
    { kind: 'origin_blocked', host: 'example.com' },
    { kind: 'site_dead', host: 'example.com' },
  ]);
  const aborts = logbook.readRecentAborts(platform, 50);
  const groups = new Map();
  for (const a of aborts.filter((a) => a.hours_since <= 24)) {
    const key = `${a.kind ?? 'other'}|${a.host ?? ''}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  // Two origin_blocked + one site_dead — no group hits 3.
  assert.ok([...groups.values()].every((c) => c < 3));
});

// Direct tests of the real helper (block-class filter). These exercise
// computeAbortEscalation itself, not a mirror of its logic.
const { computeAbortEscalation } = await import('../dist/tools/start-session.js');

test('escalation: 3x existing_capability_covers (benign reads) → no advisory', () => {
  const aborts = [
    { kind: 'existing_capability_covers', host: 'example.com', hours_since: 1 },
    { kind: 'existing_capability_covers', host: 'example.com', hours_since: 2 },
    { kind: 'existing_capability_covers', host: 'example.com', hours_since: 3 },
  ];
  assert.equal(
    computeAbortEscalation(aborts),
    undefined,
    'benign existing_capability_covers reads must not escalate',
  );
});

test('escalation: 3x origin_blocked → advisory fires (block class)', () => {
  const aborts = [
    { kind: 'origin_blocked', host: 'example.com', hours_since: 1 },
    { kind: 'origin_blocked', host: 'example.com', hours_since: 2 },
    { kind: 'origin_blocked', host: 'example.com', hours_since: 3 },
  ];
  const result = computeAbortEscalation(aborts);
  assert.ok(result, 'origin_blocked repeats must escalate');
  assert.equal(result.kind, 'origin_blocked');
  assert.equal(result.same_root_cause_count, 3);
});

test('escalation: benign kinds do not dilute / mask a real block', () => {
  // 3 benign + 3 blocks interleaved → still escalates on the blocks only.
  const aborts = [
    { kind: 'existing_capability_covers', host: 'example.com', hours_since: 1 },
    { kind: 'origin_blocked', host: 'example.com', hours_since: 2 },
    { kind: 'user_stop', host: 'example.com', hours_since: 3 },
    { kind: 'origin_blocked', host: 'example.com', hours_since: 4 },
    { kind: 'site_dead', host: 'example.com', hours_since: 5 },
    { kind: 'origin_blocked', host: 'example.com', hours_since: 6 },
  ];
  const result = computeAbortEscalation(aborts);
  assert.ok(result, 'three origin_blocked among benign kinds must still escalate');
  assert.equal(result.kind, 'origin_blocked');
  assert.equal(result.same_root_cause_count, 3);
});
