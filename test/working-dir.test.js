// Unit tests for the platform working dir — capture-event model,
// session archive writer, logbook upsert, bundle content-addressability.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-working-dir-'));
process.env.KLURA_HOME = TMP;

const { ingestCaptureEvents } = await import('../dist/working-dir/writer.js');
const { archiveBundle, readArchivedBundle, listArchivedBundles, sha256 } =
  await import('../dist/working-dir/bundle-archive.js');
const { loadLogbook, appendStrategyEvent, readStrategyEvents } =
  await import('../dist/working-dir/logbook.js');
const layout = await import('../dist/working-dir/layout.js');

function baseEvent(overrides = {}) {
  return {
    at: Date.now(),
    session_id: 'sess_A',
    platform: 'test-p',
    kind: 'session_meta',
    payload: {
      started_at: Date.now() - 10_000,
      ended_at: Date.now(),
      capability: 'list_x',
      args: { username: 'alice' },
      outcome: 'no_save',
    },
    ...overrides,
  };
}

test('ingestCaptureEvents writes session archive + logbook', () => {
  const platform = 'ingest-test-1';
  const sessionId = 'sess_abc';
  const events = [
    baseEvent({ platform, session_id: sessionId }),
    {
      at: Date.now(),
      session_id: sessionId,
      platform,
      kind: 'http_request',
      payload: {
        method: 'GET',
        url: 'https://api.example.com/items?q=alice',
        headers: { 'content-type': 'application/json' },
        postData: null,
        status: 200,
      },
    },
    {
      at: Date.now(),
      session_id: sessionId,
      platform,
      capability: 'list_x',
      kind: 'lift_attempt',
      payload: {
        outcome: 'page_script_saved',
        rounds_spent: 30,
        notes: 'found signer at window.acme.sign',
      },
    },
  ];

  ingestCaptureEvents(platform, sessionId, events);

  const archivePath = layout.sessionArchivePath(platform, sessionId, 'archive');
  assert.ok(fs.existsSync(archivePath), 'archive.json written');
  const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  assert.equal(archive.session_id, sessionId);
  assert.equal(archive.http.length, 1);
  assert.equal(archive.http[0].url, 'https://api.example.com/items?q=alice');

  const logbook = loadLogbook(platform);
  assert.equal(logbook.sessions_total, 1);
  const cap = logbook.per_capability['list_x'];
  assert.ok(cap, 'capability entry created');
  assert.equal(cap.sessions_contributed, 1);
  assert.equal(cap.lift_attempts.length, 1);
  assert.equal(cap.lift_attempts[0].outcome, 'page_script_saved');
  assert.equal(cap.lift_attempts[0].rounds_spent, 30);
});

test('ingestCaptureEvents rejects cross-session events in one call', () => {
  assert.throws(() => {
    ingestCaptureEvents('ingest-test-2', 'sess_A', [
      baseEvent({ platform: 'ingest-test-2', session_id: 'sess_A' }),
      baseEvent({ platform: 'ingest-test-2', session_id: 'sess_B' }),
    ]);
  }, /session_id\/platform mismatch/);
});

test('ingestCaptureEvents requires a session_meta event', () => {
  assert.throws(() => {
    ingestCaptureEvents('ingest-test-3', 'sess_X', [
      {
        at: Date.now(),
        session_id: 'sess_X',
        platform: 'ingest-test-3',
        kind: 'perform_action',
        payload: { action: 'click', selector: 'button' },
      },
    ]);
  }, /must include one session_meta event/);
});

test('multiple sessions accumulate in logbook', () => {
  const platform = 'ingest-test-4';
  for (let i = 0; i < 3; i++) {
    const sid = `sess_${i}`;
    ingestCaptureEvents(platform, sid, [
      baseEvent({
        platform,
        session_id: sid,
        payload: {
          started_at: Date.now(),
          ended_at: Date.now(),
          capability: 'list_x',
          args: { q: `q${i}` },
          outcome: i === 2 ? 'fetch_saved' : 'no_save',
        },
      }),
    ]);
  }
  const logbook = loadLogbook(platform);
  assert.equal(logbook.sessions_total, 3);
  assert.equal(logbook.per_capability['list_x'].sessions_contributed, 3);
});

test('bundle archive is content-addressable and dedupes across calls', () => {
  const platform = 'bundle-test';
  const bytes = 'function hello(){return 42;}';
  const sha = sha256(bytes);
  const p1 = archiveBundle(platform, sha, bytes);
  const p2 = archiveBundle(platform, sha, bytes); // same SHA — no rewrite
  assert.equal(p1, p2, 'returns same path');
  assert.ok(fs.existsSync(p1));
  const read = readArchivedBundle(platform, sha);
  assert.equal(read, bytes);
  const list = listArchivedBundles(platform);
  assert.ok(list.includes(sha));
});

test('bundle_seen event with bytes writes to archive', () => {
  const platform = 'bundle-event-test';
  const sessionId = 'sess_with_bundle';
  const bundleBytes = 'var ACME_SIGN = 1;';
  const bundleSha = sha256(bundleBytes);
  ingestCaptureEvents(platform, sessionId, [
    baseEvent({
      platform,
      session_id: sessionId,
      payload: {
        started_at: Date.now(),
        ended_at: Date.now(),
        outcome: 'no_save',
      },
    }),
    {
      at: Date.now(),
      session_id: sessionId,
      platform,
      kind: 'bundle_seen',
      payload: {
        url: 'https://cdn.example.com/main.js',
        sha256: bundleSha,
        size: bundleBytes.length,
        bytes: bundleBytes,
      },
    },
  ]);
  const archived = readArchivedBundle(platform, bundleSha);
  assert.equal(archived, bundleBytes);
});

test('loadLogbook on missing platform returns empty (not throws)', () => {
  const logbook = loadLogbook('never-written-platform');
  assert.equal(logbook.sessions_total, 0);
  assert.deepEqual(logbook.per_capability, {});
});

test('loadLogbook rejects invalid schema and returns empty', () => {
  const platform = 'bad-schema-test';
  fs.mkdirSync(path.dirname(layout.logbookPath(platform)), { recursive: true });
  fs.writeFileSync(layout.logbookPath(platform), '{"totally": "wrong shape"}');
  const logbook = loadLogbook(platform);
  assert.equal(logbook.sessions_total, 0, 'empty logbook, not the garbage on disk');
});
