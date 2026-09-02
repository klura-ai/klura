// A strategy the runtime moves out of the active slot has to say why on the
// file itself. The event stream records the move, but the file is what someone
// opens when they find it — an agent resuming next session, a person reading
// the home — and neither of them necessarily knows a separate log exists.
//
// Observed: a reddit page-script archived to `.broken.json` whose `runtime_meta`
// held only `discovered_from_url`, leaving no way to tell why it stopped being
// used.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-provenance-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const skills = await import('../dist/strategies/skills.js');

function fetchStrategy(extra = {}) {
  return {
    schema_version: 1,
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/items',
    notes: { params: {} },
    ...extra,
  };
}

function readJson(...segments) {
  return JSON.parse(fs.readFileSync(path.join(TMP, 'skills', ...segments), 'utf8'));
}

test('an archived strategy records why it was archived', () => {
  skills.saveStrategy('prov-a', 'list_items', fetchStrategy());
  skills.archiveStrategy('prov-a', 'list_items', 'fetch', 'post-save validation failed: HTTP 403');

  const archived = readJson('prov-a', 'fetch', 'list_items.broken.json');
  assert.equal(archived.runtime_meta.archived_reason, 'post-save validation failed: HTTP 403');
  assert.equal(archived.runtime_meta.archived_from_tier, 'fetch');
  assert.equal(typeof archived.runtime_meta.archived_at, 'number');
  assert.ok(
    !fs.existsSync(path.join(TMP, 'skills', 'prov-a', 'fetch', 'list_items.json')),
    'the active slot must be empty after archival',
  );
});

test('archival preserves the strategy body and any prior runtime_meta', () => {
  skills.saveStrategy(
    'prov-b',
    'list_items',
    fetchStrategy({ runtime_meta: { discovered_from_url: 'http://example.test/page' } }),
  );
  skills.archiveStrategy('prov-b', 'list_items', 'fetch', 'broke');

  const archived = readJson('prov-b', 'fetch', 'list_items.broken.json');
  assert.equal(archived.endpoint, '/items', 'the strategy itself must survive archival intact');
  assert.equal(
    archived.runtime_meta.discovered_from_url,
    'http://example.test/page',
    'existing provenance must not be dropped by the archive stamp',
  );
  assert.equal(archived.runtime_meta.archived_reason, 'broke');
});

test('archival without an explicit detail still records a reason', () => {
  skills.saveStrategy('prov-c', 'list_items', fetchStrategy());
  skills.archiveStrategy('prov-c', 'list_items', 'fetch');

  const archived = readJson('prov-c', 'fetch', 'list_items.broken.json');
  assert.equal(archived.runtime_meta.archived_reason, 'archived as broken');
});

test('a demoted strategy records the tier it was demoted out of', () => {
  skills.saveStrategy('prov-d', 'list_items', fetchStrategy());
  skills.demoteFetchToPageScript('prov-d', 'list_items');

  const demoted = readJson('prov-d', 'scripts', 'list_items.json');
  assert.equal(demoted.strategy, 'page-script');
  assert.equal(
    demoted.runtime_meta.demoted_from_tier,
    'fetch',
    'without this the next author reads it as an ordinary page-script and sends it back to fetch',
  );
  assert.match(demoted.runtime_meta.demoted_reason, /Node-fire failures/);
  assert.equal(typeof demoted.runtime_meta.demoted_at, 'number');
});
