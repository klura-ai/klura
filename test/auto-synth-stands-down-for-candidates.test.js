// Auto-synth exists for the session where the agent drove the browser correctly
// but never saved. A capability whose saves landed as inactive candidates is not
// that session: the work is on disk awaiting a verdict, and synthesizing over it
// puts an unverified guess in the active slot that every caller then executes
// in preference to the audited candidate beside it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-synth-standdown-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { synthesizeFallbacksOnClose } = await import('../dist/strategies/synthesize-on-close/index.js');

function mkTypeThenClickHistory() {
  const now = Date.now() - 1000;
  return [
    { at: now, action: 'type', selector: 'input#q', value: 'museum' },
    { at: now + 100, action: 'click', selector: 'button#search' },
  ];
}

function mkSession(overrides = {}) {
  return {
    id: 'sess_standdown',
    platform: 'test-standdown',
    declaredCapabilities: [{ capability: 'search_places', args: { query: 'museum' } }],
    savedCapabilities: [],
    performActionHistory: mkTypeThenClickHistory(),
    intercepted: [],
    intercepting: false,
    visitedUrls: ['https://example.com/'],
    ...overrides,
  };
}

test('declared-only capability still synthesizes when nothing was saved', async () => {
  const session = mkSession();
  const diag = [];
  const out = await synthesizeFallbacksOnClose(session, session.platform, null, diag);
  assert.ok(
    out.length > 0,
    `expected a fallback for a declared-but-unsaved capability, got none (diag: ${JSON.stringify(diag)})`,
  );
});

test('a capability with a staged candidate is skipped', async () => {
  const session = mkSession({
    savedCandidates: [
      { capability: 'search_places', at: Date.now(), tier: 'page-script', candidateId: 'cand_abc' },
    ],
  });
  const diag = [];
  const out = await synthesizeFallbacksOnClose(session, session.platform, null, diag);

  assert.equal(
    out.filter((r) => r.capability === 'search_places').length,
    0,
    'auto-synth wrote over a capability that already had an audited candidate on disk',
  );
  assert.ok(
    diag.some((d) => d.outcome === 'no_save_markers'),
    `expected the pass to stand down with no save markers, got: ${JSON.stringify(diag)}`,
  );
});

test('a candidate for one capability does not suppress synthesis for another', async () => {
  const session = mkSession({
    declaredCapabilities: [
      { capability: 'search_places', args: { query: 'museum' } },
      { capability: 'get_place', args: { query: 'museum' } },
    ],
    savedCandidates: [
      { capability: 'search_places', at: Date.now(), tier: 'page-script', candidateId: 'cand_abc' },
    ],
  });
  const out = await synthesizeFallbacksOnClose(session, session.platform, null, []);
  const names = new Set(out.map((r) => r.capability));

  assert.ok(!names.has('search_places'), 'the staged capability should have been skipped');
  assert.ok(names.has('get_place'), 'the unstaged sibling capability should still get a fallback');
});

test('an explicit active save still wins over a same-name candidate marker', async () => {
  // savedCapabilities carries promoted saves; a capability present in both lists
  // keeps its real save marker, because the promoted file is the thing to extend.
  const session = mkSession({
    savedCapabilities: [{ capability: 'search_places', at: Date.now(), tier: 'fetch' }],
    savedCandidates: [
      { capability: 'search_places', at: Date.now(), tier: 'page-script', candidateId: 'cand_abc' },
    ],
  });
  const diag = [];
  await synthesizeFallbacksOnClose(session, session.platform, null, diag);

  const entry = diag.find((d) => d.phase === 'start' && d.outcome === 'entry');
  assert.equal(entry?.detail?.save_markers, 1, 'the explicit save marker should have survived');
});
