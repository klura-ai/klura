// C4d: the abort ledger is a replay surface, not an archive.
//
// It had no cap, no TTL and no dedupe: every abort_session appended forever,
// and the whole thing is replayed to future sessions. Bounding happens at
// write time — no background job, no timer.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-abort-bounded-'));
process.env.KLURA_HOME = TMP;

const { appendAbortEvent, readRecentAborts, loadLogbook, writeLogbook } = await import(
  '../dist/working-dir/logbook.js'
);

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function mkEvent(overrides = {}) {
  return {
    session_id: 'sess_test',
    reason: 'site is blocked — bot wall on every path tried',
    captured_actions_count: 0,
    phase_at_abort: 'drive',
    ...overrides,
  };
}

function events(platform) {
  return loadLogbook(platform).platform_wide.abort_events;
}

/** Rewrite persisted timestamps so age-dependent behavior can be exercised
 *  without waiting. */
function ageEvents(platform, daysOld) {
  const logbook = loadLogbook(platform);
  const at = new Date(Date.now() - daysOld * 24 * 3_600_000).toISOString();
  for (const e of logbook.platform_wide.abort_events) e.at = at;
  writeLogbook(logbook);
}

test('ring buffer: the ledger keeps the newest 200 entries', () => {
  const platform = 'ledger-cap';
  for (let i = 0; i < 260; i++) {
    appendAbortEvent(platform, mkEvent({ session_id: `sess_${i}` }));
  }
  const stored = events(platform);
  assert.equal(stored.length, 200);
  assert.equal(stored[0].session_id, 'sess_60', 'oldest survivor');
  assert.equal(stored.at(-1).session_id, 'sess_259', 'newest kept');
});

test('dedupe: an immediate repeat of session_id + kind + host is dropped', () => {
  const platform = 'ledger-dedupe';
  const entry = mkEvent({ session_id: 'sess_1', kind: 'anti_bot', host: 'shop.test' });
  appendAbortEvent(platform, entry);
  appendAbortEvent(platform, entry);
  appendAbortEvent(platform, entry);
  assert.equal(events(platform).length, 1);
});

test('dedupe: a different kind, host, or session from the same session still appends', () => {
  const platform = 'ledger-dedupe-distinct';
  appendAbortEvent(platform, mkEvent({ session_id: 's1', kind: 'anti_bot', host: 'shop.test' }));
  appendAbortEvent(platform, mkEvent({ session_id: 's1', kind: 'captcha', host: 'shop.test' }));
  appendAbortEvent(platform, mkEvent({ session_id: 's1', kind: 'captcha', host: 'other.test' }));
  appendAbortEvent(platform, mkEvent({ session_id: 's2', kind: 'captcha', host: 'other.test' }));
  assert.equal(events(platform).length, 4);
});

test('dedupe only looks at the newest entry, so an interleaved repeat still lands', () => {
  // A session that aborted, another session aborted, then the first aborted
  // again is a real sequence — only a back-to-back duplicate is noise.
  const platform = 'ledger-dedupe-interleaved';
  appendAbortEvent(platform, mkEvent({ session_id: 's1', kind: 'anti_bot', host: 'shop.test' }));
  appendAbortEvent(platform, mkEvent({ session_id: 's2', kind: 'anti_bot', host: 'shop.test' }));
  appendAbortEvent(platform, mkEvent({ session_id: 's1', kind: 'anti_bot', host: 'shop.test' }));
  assert.equal(events(platform).length, 3);
});

test('TTL: entries older than 30 days are pruned on the next write', () => {
  const platform = 'ledger-ttl';
  appendAbortEvent(platform, mkEvent({ session_id: 'old_1' }));
  appendAbortEvent(platform, mkEvent({ session_id: 'old_2' }));
  ageEvents(platform, 31);
  appendAbortEvent(platform, mkEvent({ session_id: 'fresh' }));
  const stored = events(platform);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].session_id, 'fresh');
});

test('TTL: entries inside the window survive', () => {
  const platform = 'ledger-ttl-keep';
  appendAbortEvent(platform, mkEvent({ session_id: 'recent' }));
  ageEvents(platform, 29);
  appendAbortEvent(platform, mkEvent({ session_id: 'fresh' }));
  assert.equal(events(platform).length, 2);
});

test('an unparseable timestamp is kept, not silently destroyed', () => {
  const platform = 'ledger-corrupt';
  appendAbortEvent(platform, mkEvent({ session_id: 'corrupt' }));
  const logbook = loadLogbook(platform);
  logbook.platform_wide.abort_events[0].at = 'not-a-timestamp';
  writeLogbook(logbook);
  appendAbortEvent(platform, mkEvent({ session_id: 'fresh' }));
  assert.equal(events(platform).length, 2);
});

test('provenance + signals round-trip through the ledger', () => {
  const platform = 'ledger-provenance';
  appendAbortEvent(
    platform,
    mkEvent({
      session_id: 's1',
      kind: 'anti_bot',
      host: 'shop.test',
      provenance: 'runtime_observed',
      signals: ['http_failure', 'block_page_shape'],
    }),
  );
  const [read] = readRecentAborts(platform);
  assert.equal(read.provenance, 'runtime_observed');
  assert.deepEqual(read.signals, ['http_failure', 'block_page_shape']);
});

test('an entry written without provenance reads as agent_asserted', () => {
  // The persisted field stays optional — historical ledgers have no such key
  // — and the reader supplies the only honest default: an unstamped entry is
  // a claim.
  const platform = 'ledger-legacy';
  appendAbortEvent(platform, mkEvent({ session_id: 's1', kind: 'anti_bot' }));
  assert.equal(events(platform)[0].provenance, undefined, 'nothing invented on disk');
  assert.equal(readRecentAborts(platform)[0].provenance, 'agent_asserted');
});

test('empty signals are not persisted', () => {
  const platform = 'ledger-empty-signals';
  appendAbortEvent(platform, mkEvent({ session_id: 's1', signals: [] }));
  assert.equal(events(platform)[0].signals, undefined);
  assert.equal(readRecentAborts(platform)[0].signals, undefined);
});
