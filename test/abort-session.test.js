// abort_session contract: ledger round-trip + arg validation.
//
// abort_session is the honest non-save exit. End-to-end teardown (pool
// cleanup, storage state persistence) needs a live driver and is covered
// by integration runs; these tests cover the surfaces that are pure
// runtime: the abort_events ledger (append + read + cap + sort) and the
// argument validators that reject bad calls before pool access.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-abort-session-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const { appendAbortEvent, readRecentAborts, writeLogbook, loadLogbook } = await import(
  '../dist/working-dir/logbook.js'
);
const { abortSession } = await import('../dist/tools/abort_session.js');

function mkEvent(overrides = {}) {
  return {
    session_id: 'sess_test',
    reason: 'existing capability search_threads covers this — using execute',
    captured_actions_count: 0,
    phase_at_abort: 'drive',
    ...overrides,
  };
}

test('appendAbortEvent → readRecentAborts round-trip', () => {
  const platform = 'abort-roundtrip';
  appendAbortEvent(platform, mkEvent({ session_id: 'sess_1' }));
  const aborts = readRecentAborts(platform);
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0].session_id, 'sess_1');
  assert.equal(aborts[0].phase_at_abort, 'drive');
  assert.ok(aborts[0].at, 'at timestamp set by appender');
});

test('readRecentAborts: newest-first ordering', async () => {
  const platform = 'abort-order';
  appendAbortEvent(platform, mkEvent({ session_id: 'sess_old' }));
  // Force a newer timestamp on the second event.
  await new Promise((r) => setTimeout(r, 10));
  appendAbortEvent(platform, mkEvent({ session_id: 'sess_new' }));
  const aborts = readRecentAborts(platform);
  assert.equal(aborts.length, 2);
  assert.equal(aborts[0].session_id, 'sess_new', 'newest first');
  assert.equal(aborts[1].session_id, 'sess_old');
});

test('readRecentAborts: cap parameter trims to N most recent', async () => {
  const platform = 'abort-cap';
  for (let i = 0; i < 8; i++) {
    appendAbortEvent(platform, mkEvent({ session_id: `sess_${i}` }));
    await new Promise((r) => setTimeout(r, 2));
  }
  const top3 = readRecentAborts(platform, 3);
  assert.equal(top3.length, 3);
  assert.equal(top3[0].session_id, 'sess_7', 'newest first under cap');
  assert.equal(top3[2].session_id, 'sess_5');
});

test('readRecentAborts: defaults to 10', async () => {
  const platform = 'abort-default-cap';
  for (let i = 0; i < 15; i++) {
    appendAbortEvent(platform, mkEvent({ session_id: `sess_${i}` }));
    await new Promise((r) => setTimeout(r, 2));
  }
  const aborts = readRecentAborts(platform);
  assert.equal(aborts.length, 10);
});

test('readRecentAborts: empty platform → []', () => {
  const aborts = readRecentAborts('never-aborted-platform');
  assert.deepEqual(aborts, []);
});

test('appendAbortEvent: defensive-init upgrades pre-existing logbook missing abort_events', () => {
  const platform = 'abort-defensive-init';
  // Write a logbook shape that predates abort_events (no field at all).
  writeLogbook({
    schema_version: 1,
    platform,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sessions_total: 0,
    per_capability: {},
    platform_wide: { signer_functions_seen: [], bundle_drift_events: [] },
    observed_capabilities: [],
    url_graph: { nodes: [], edges: [] },
    forms_seen: [],
  });
  // Append should upgrade in place rather than blow up.
  appendAbortEvent(platform, mkEvent({ session_id: 'sess_after_upgrade' }));
  const logbook = loadLogbook(platform);
  assert.ok(Array.isArray(logbook.platform_wide.abort_events));
  assert.equal(logbook.platform_wide.abort_events.length, 1);
  assert.equal(logbook.platform_wide.abort_events[0].session_id, 'sess_after_upgrade');
});

test('readRecentAborts: defensive read on logbook missing abort_events returns []', () => {
  const platform = 'abort-read-defensive';
  writeLogbook({
    schema_version: 1,
    platform,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sessions_total: 0,
    per_capability: {},
    platform_wide: { signer_functions_seen: [], bundle_drift_events: [] },
    observed_capabilities: [],
    url_graph: { nodes: [], edges: [] },
    forms_seen: [],
  });
  const aborts = readRecentAborts(platform);
  assert.deepEqual(aborts, []);
});

test('abortSession: missing session_id rejected with invalid_args', async () => {
  await assert.rejects(
    () => abortSession({ session_id: '', reason: 'long enough reason for validation' }),
    /invalid_args.*session_id/,
  );
  await assert.rejects(
    () => abortSession({ reason: 'long enough reason for validation' }),
    /invalid_args.*session_id/,
  );
});

test('abortSession: reason < 20 chars rejected with invalid_args', async () => {
  await assert.rejects(
    () => abortSession({ session_id: 'sess_x', reason: 'too short' }),
    /invalid_args.*reason.*≥20 chars/s,
  );
});

test('abortSession: missing reason rejected with invalid_args', async () => {
  await assert.rejects(
    () => abortSession({ session_id: 'sess_x' }),
    /invalid_args.*reason/,
  );
});

test('abortSession: rejection message warns against "one-off task" reason', async () => {
  // The validator's own message is the teaching surface — agents who pass
  // a too-short reason should learn that "this is a one-off task" isn't
  // a legitimate reason either, before they retry with a 20-char version
  // of the same wrong idea.
  await assert.rejects(
    () => abortSession({ session_id: 'sess_x', reason: 'short' }),
    /one-off task.*isn't the agent's to make/s,
  );
});
