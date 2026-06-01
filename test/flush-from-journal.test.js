// Unit tests for flushFromJournal — folding a capture snapshot into the logbook
// via the same ingestCaptureEvents end_drive uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-flush-journal-'));
process.env.KLURA_HOME = TMP;

const { writeJournalSnapshot, readJournalSnapshot } =
  await import('../dist/working-dir/capture-journal.js');
const { flushFromJournal } = await import('../dist/working-dir/flush-from-journal.js');
const { loadLogbook } = await import('../dist/working-dir/logbook.js');
const layout = await import('../dist/working-dir/layout.js');

function fullStream(sid, platform) {
  return [
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
      kind: 'http_request',
      payload: {
        method: 'GET',
        url: `https://${platform}/api/items`,
        headers: { 'content-type': 'application/json' },
        postData: null,
        status: 200,
        responseBody: '{"ok":true}',
      },
    },
    {
      at: 1002,
      session_id: sid,
      platform,
      kind: 'dom_navigation',
      payload: { url: `https://${platform}/`, via: 'nav' },
    },
    {
      at: 1003,
      session_id: sid,
      platform,
      kind: 'dom_navigation',
      payload: { url: `https://${platform}/products`, via: 'click' },
    },
    {
      at: 1004,
      session_id: sid,
      platform,
      kind: 'dom_form_observed',
      payload: {
        url: `https://${platform}/products`,
        action: '/search',
        method: 'get',
        fields: [{ name: 'q', type: 'text' }],
      },
    },
  ];
}

function snap(sid, platform, events) {
  return { v: 1, sessionId: sid, platform, startedAt: 900, events };
}

test('fold populates session archive + url_graph + forms_seen, then deletes the journal', () => {
  const platform = 'flush-p1';
  const sid = 'sess_f1';
  writeJournalSnapshot(sid, snap(sid, platform, fullStream(sid, platform)));

  const folded = flushFromJournal(sid, { inferCaps: true });
  assert.equal(folded, true);

  const lb = loadLogbook(platform);
  assert.ok(lb.url_graph.nodes.length >= 2, 'url_graph nodes folded');
  assert.ok(lb.url_graph.edges.length >= 1, 'url_graph edge folded');
  assert.equal(lb.forms_seen.length, 1, 'form folded');

  const archive = JSON.parse(
    fs.readFileSync(layout.sessionArchivePath(platform, sid, 'archive'), 'utf8'),
  );
  assert.equal(archive.http.length, 1, 'http captured in archive');

  // Journal deleted after the logbook write committed.
  assert.equal(readJournalSnapshot(sid), null);
});

test('re-fold is idempotent — counts stable (crash-between-commit-and-delete safe)', () => {
  const platform = 'flush-p2';
  const sid = 'sess_f2';
  const events = fullStream(sid, platform);

  writeJournalSnapshot(sid, snap(sid, platform, events));
  assert.equal(flushFromJournal(sid, { inferCaps: true }), true);
  const after1 = loadLogbook(platform);
  const nodes1 = after1.url_graph.nodes.length;
  const edges1 = after1.url_graph.edges.length;
  const forms1 = after1.forms_seen.length;

  // Re-create the same snapshot (simulating a crash that left the journal
  // behind after the logbook write) and fold again.
  writeJournalSnapshot(sid, snap(sid, platform, events));
  assert.equal(flushFromJournal(sid, { inferCaps: true }), true);
  const after2 = loadLogbook(platform);
  assert.equal(after2.url_graph.nodes.length, nodes1, 'nodes stable on re-fold');
  assert.equal(after2.url_graph.edges.length, edges1, 'edges stable on re-fold');
  assert.equal(after2.forms_seen.length, forms1, 'forms stable on re-fold');
});

test('absent snapshot → false, nothing folded', () => {
  assert.equal(flushFromJournal('no_such_session', { inferCaps: true }), false);
});

test('snapshot missing session_meta → synthesized, fold still succeeds (no infinite re-fold)', () => {
  const platform = 'flush-p3';
  const sid = 'sess_f3';
  // Hand-build a snapshot with NO session_meta event (e.g. a truncated build).
  const events = fullStream(sid, platform).filter((e) => e.kind !== 'session_meta');
  assert.ok(!events.some((e) => e.kind === 'session_meta'));
  writeJournalSnapshot(sid, snap(sid, platform, events));

  // Without the synthesize-meta guard, ingestCaptureEvents would throw and the
  // journal would never delete — folding here must succeed and delete.
  assert.equal(flushFromJournal(sid, { inferCaps: true }), true);
  assert.equal(readJournalSnapshot(sid), null);
  const lb = loadLogbook(platform);
  assert.ok(lb.url_graph.nodes.length >= 2);
});
