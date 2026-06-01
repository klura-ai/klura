// Unit tests for recoverOrphanedJournals — folds orphans, skips live sessions,
// sweeps journals too old to ever be re-mapped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-recover-journal-'));
process.env.KLURA_HOME = TMP;

const { writeJournalSnapshot, readJournalSnapshot, journalPath } =
  await import('../dist/working-dir/capture-journal.js');
const { recoverOrphanedJournals, JOURNAL_SWEEP_MAX_AGE_MS } =
  await import('../dist/working-dir/recover-journals.js');
const { loadLogbook } = await import('../dist/working-dir/logbook.js');

function snap(sid, platform) {
  return {
    v: 1,
    sessionId: sid,
    platform,
    startedAt: 900,
    events: [
      {
        at: 1000,
        session_id: sid,
        platform,
        kind: 'session_meta',
        payload: { started_at: 900, ended_at: 1000, outcome: 'no_save' },
      },
      {
        at: 1001,
        session_id: sid,
        platform,
        kind: 'dom_navigation',
        payload: { url: `https://${platform}/`, via: 'nav' },
      },
    ],
  };
}

test('folds orphans, skips a still-live session', () => {
  writeJournalSnapshot('orphan_A', snap('orphan_A', 'recov-A'));
  writeJournalSnapshot('orphan_B', snap('orphan_B', 'recov-B'));
  writeJournalSnapshot('live_C', snap('live_C', 'recov-C'));

  recoverOrphanedJournals({ activeSessionIds: new Set(['live_C']) });

  // Orphans folded + deleted.
  assert.equal(readJournalSnapshot('orphan_A'), null);
  assert.equal(readJournalSnapshot('orphan_B'), null);
  assert.ok(loadLogbook('recov-A').url_graph.nodes.length >= 1);
  assert.ok(loadLogbook('recov-B').url_graph.nodes.length >= 1);

  // Live session's journal untouched, its platform never folded.
  assert.ok(readJournalSnapshot('live_C'));
  assert.equal(loadLogbook('recov-C').url_graph.nodes.length, 0);
});

test('sweeps a journal older than maxAgeMs without folding', () => {
  writeJournalSnapshot('stale_D', snap('stale_D', 'recov-D'));
  // Backdate the file mtime well past the sweep horizon.
  const old = (Date.now() - JOURNAL_SWEEP_MAX_AGE_MS - 60_000) / 1000;
  fs.utimesSync(journalPath('stale_D'), old, old);

  recoverOrphanedJournals({ activeSessionIds: new Set(), maxAgeMs: JOURNAL_SWEEP_MAX_AGE_MS });

  // Swept (deleted) but NOT folded.
  assert.equal(readJournalSnapshot('stale_D'), null);
  assert.equal(loadLogbook('recov-D').url_graph.nodes.length, 0);
});

test('fresh journal is folded under the same sweep call', () => {
  writeJournalSnapshot('fresh_E', snap('fresh_E', 'recov-E'));
  recoverOrphanedJournals({ activeSessionIds: new Set(), maxAgeMs: JOURNAL_SWEEP_MAX_AGE_MS });
  assert.equal(readJournalSnapshot('fresh_E'), null);
  assert.ok(loadLogbook('recov-E').url_graph.nodes.length >= 1);
});
