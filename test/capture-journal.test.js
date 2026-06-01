// Unit tests for the capture-journal snapshot I/O (pure layer).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-capture-journal-'));
process.env.KLURA_HOME = TMP;

const {
  journalsRoot,
  journalPath,
  writeJournalSnapshot,
  readJournalSnapshot,
  deleteJournal,
  listJournalSessionIds,
  journalAgeMs,
} = await import('../dist/working-dir/capture-journal.js');

function snap(sessionId, platform, events = []) {
  return { v: 1, sessionId, platform, startedAt: 1000, events };
}

function metaEvent(sessionId, platform) {
  return {
    at: 2000,
    session_id: sessionId,
    platform,
    kind: 'session_meta',
    payload: { started_at: 1000, ended_at: 2000, outcome: 'no_save' },
  };
}

test('write → read round-trips the snapshot with mixed kinds', () => {
  const sid = 'sess_round';
  const events = [
    metaEvent(sid, 'p1'),
    {
      at: 1,
      session_id: sid,
      platform: 'p1',
      kind: 'http_request',
      payload: { method: 'GET', url: 'https://x/a', headers: {}, postData: null, status: 200 },
    },
    {
      at: 2,
      session_id: sid,
      platform: 'p1',
      kind: 'dom_navigation',
      payload: { url: 'https://x/a', via: 'nav' },
    },
    {
      at: 3,
      session_id: sid,
      platform: 'p1',
      kind: 'dom_form_observed',
      payload: {
        url: 'https://x/a',
        action: '/search',
        method: 'get',
        fields: [{ name: 'q', type: 'text' }],
      },
    },
    {
      at: 4,
      session_id: sid,
      platform: 'p1',
      kind: 'perform_action',
      payload: { action: 'click', selector: '#go' },
    },
  ];
  writeJournalSnapshot(sid, snap(sid, 'p1', events));
  const got = readJournalSnapshot(sid);
  assert.ok(got);
  assert.equal(got.platform, 'p1');
  assert.equal(got.events.length, 5);
  assert.deepEqual(
    got.events.map((e) => e.kind),
    ['session_meta', 'http_request', 'dom_navigation', 'dom_form_observed', 'perform_action'],
  );
});

test('write is an atomic overwrite (latest snapshot wins, no .tmp left behind)', () => {
  const sid = 'sess_overwrite';
  writeJournalSnapshot(sid, snap(sid, 'p2', [metaEvent(sid, 'p2')]));
  writeJournalSnapshot(sid, snap(sid, 'p2', [metaEvent(sid, 'p2'), metaEvent(sid, 'p2')]));
  const got = readJournalSnapshot(sid);
  assert.equal(got.events.length, 2);
  assert.ok(!fs.existsSync(`${journalPath(sid)}.tmp`));
});

test('readJournalSnapshot returns null for absent / malformed / wrong-version files', () => {
  assert.equal(readJournalSnapshot('does_not_exist'), null);
  fs.mkdirSync(journalsRoot(), { recursive: true });
  fs.writeFileSync(journalPath('garbage'), 'not json {');
  assert.equal(readJournalSnapshot('garbage'), null);
  fs.writeFileSync(
    journalPath('v2'),
    JSON.stringify({ v: 2, sessionId: 'v2', platform: 'p', startedAt: 0, events: [] }),
  );
  assert.equal(readJournalSnapshot('v2'), null);
});

test('list / delete / age on present and absent files', () => {
  const sid = 'sess_lifecycle';
  writeJournalSnapshot(sid, snap(sid, 'p3', [metaEvent(sid, 'p3')]));
  assert.ok(listJournalSessionIds().includes(sid));
  // `now` a second ahead so the freshly-written file's age is unambiguously
  // positive (fs mtimeMs has sub-ms precision; Date.now() truncates to ms).
  const now = Date.now() + 1000;
  const age = journalAgeMs(sid, now);
  assert.ok(Number.isFinite(age) && age >= 0 && age < 60_000);
  assert.equal(journalAgeMs('nope', now), Infinity);
  deleteJournal(sid);
  assert.ok(!listJournalSessionIds().includes(sid));
  assert.equal(readJournalSnapshot(sid), null);
  // delete is force/no-throw on an already-absent file
  deleteJournal(sid);
});
