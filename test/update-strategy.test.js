// update_strategy — the amend verb. Covers the logic unique to update_strategy
// (the pre-existence precondition + delegation to the audited save path). The
// full save-time audit is exercised by save-strategy's own tests; update_strategy
// delegates to the same saveStrategy() function, so an amend clears the same bar
// a create does by construction.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-update-strategy-'));
process.env.KLURA_HOME = tmp;
process.on('exit', () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const skills = await import('../dist/strategies/skills.js');
const { SaveStrategyRejection, updateStrategy } = await import('../dist/tools/save-strategy.js');

function fakeStrategy(endpoint = '/api/messages') {
  return {
    schema_version: 1,
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint,
    notes: { params: {} },
  };
}

test('update_strategy: rejects when no saved strategy exists, points at save_strategy', async () => {
  await assert.rejects(
    () => updateStrategy('site-none', 'list_items', fakeStrategy(), 'changelog', undefined),
    /no_saved_strategy_to_update/,
  );
});

test('update_strategy: amends an existing strategy in place (delegates to the save path)', async () => {
  // Seed an existing strategy via the low-level writer.
  skills.saveStrategy('site-amend', 'list_items', fakeStrategy('/api/v1/messages'));
  const filePath = path.join(tmp, 'skills', 'site-amend', 'fetch', 'list_items.json');
  assert.ok(fs.existsSync(filePath), 'seed strategy written');
  const before = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(before.endpoint, '/api/v1/messages');

  // Amend the endpoint. No session_id → programmatic path (same path auto-synth
  // and tests use); proves the precondition passes and the commit overwrites.
  const result = await updateStrategy(
    'site-amend',
    'list_items',
    fakeStrategy('/api/v2/messages'),
    'bump to v2',
    undefined,
  );
  assert.equal(result.ok, true);

  const after = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(after.endpoint, '/api/v2/messages', 'amend overwrote the saved strategy');
});

test('update_strategy: ignores runtime-owned metadata from a get_strategy round trip', async () => {
  skills.saveStrategy('site-round-trip', 'list_items', fakeStrategy('/api/v1/items'));
  const filePath = path.join(tmp, 'skills', 'site-round-trip', 'fetch', 'list_items.json');
  const roundTripped = {
    ...JSON.parse(fs.readFileSync(filePath, 'utf8')),
    endpoint: '/api/v2/items',
    runtime_meta: {
      discovered_from_url: 'http://untrusted.test/agent-value',
      post_save_validation: 'passed',
    },
  };

  const result = await updateStrategy(
    'site-round-trip',
    'list_items',
    roundTripped,
    'round-trip amend',
    undefined,
  );
  assert.equal(result.ok, true);
  const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(saved.endpoint, '/api/v2/items');
  assert.notEqual(
    saved.runtime_meta?.discovered_from_url,
    'http://untrusted.test/agent-value',
  );
});

test('update_strategy: preserves existing notes when the amendment omits notes', async () => {
  skills.saveStrategy('site-preserve-notes', 'list_items', {
    ...fakeStrategy('/api/v1/items'),
    notes: {
      params: {
        query: { kind: 'text', optional: true },
      },
      description: 'Caller contract',
    },
  });
  const amendment = fakeStrategy('/api/v2/items');
  delete amendment.notes;

  const result = await updateStrategy(
    'site-preserve-notes',
    'list_items',
    amendment,
    'body-only amend',
    undefined,
  );
  assert.equal(result.ok, true);

  const filePath = path.join(
    tmp,
    'skills',
    'site-preserve-notes',
    'fetch',
    'list_items.json',
  );
  const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(saved.notes, {
    params: {
      query: { kind: 'text', optional: true },
    },
    description: 'Caller contract',
  });
});

test('update_strategy: multi-tier amend inherits notes from the same-tier file', async () => {
  const platform = 'site-two-tier-notes';
  const pageScript = (headers = {}) => ({
    schema_version: 1,
    strategy: 'page-script',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/api/items/search',
    headers,
  });
  // Seed both tiers with distinct notes. loadStrategies sorts fetch first,
  // so a tier-blind default would inherit the FETCH file's notes onto a
  // page-script amend.
  skills.saveStrategy(platform, 'list_items', {
    ...fakeStrategy('/api/v1/items'),
    notes: { params: {}, description: 'fetch-tier contract' },
  });
  skills.saveStrategy(platform, 'list_items', {
    ...pageScript(),
    notes: { params: {}, description: 'page-script-tier contract' },
  });

  // Amendment omits `notes` entirely — the fallback must read the
  // page-script file, not the tier-priority head.
  const amendment = pageScript({ accept: 'application/json' });
  const result = await updateStrategy(platform, 'list_items', amendment, 'add header', undefined);
  assert.equal(result.ok, true);

  const saved = JSON.parse(
    fs.readFileSync(path.join(tmp, 'skills', platform, 'scripts', 'list_items.json'), 'utf8'),
  );
  assert.equal(saved.notes.description, 'page-script-tier contract');
});

test('update_strategy: audit rejection names the tool the caller can retry in-place', async () => {
  skills.saveStrategy('site-audit-label', 'list_items', fakeStrategy('/api/v1/items'));
  const { pool } = await import('../dist/runtime-state/index.js');
  const originalGetSession = pool.getSession;
  pool.getSession = () => ({
    id: 'sess-update-audit-label',
    platform: 'site-audit-label',
    phase: 'drive',
    graph: 'discover',
    declaredCapabilities: [{ capability: 'list_items', args: {}, declared_at: Date.now() }],
    intercepted: [],
    visitedUrls: [],
  });
  try {
    await assert.rejects(
      () =>
        updateStrategy(
          'site-audit-label',
          'list_items',
          fakeStrategy('/api/v2/items'),
          'exercise audit label',
          'sess-update-audit-label',
        ),
      (err) => {
        assert.ok(err instanceof SaveStrategyRejection);
        assert.match(err.message, /update_strategy_rejected/);
        assert.match(err.message, /call update_strategy again/);
        assert.doesNotMatch(err.message, /call save_strategy again/);
        return true;
      },
    );
  } finally {
    pool.getSession = originalGetSession;
  }
});

test('existing capability saves inherit grounding only for unchanged URL fields', () => {
  const platform = 'site-save-grounding';
  const capability = 'list_items';
  skills.saveStrategy(platform, capability, fakeStrategy('/api/v1/items'));
  const audit = {
    observedUrls: [],
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
    session: null,
  };

  assert.throws(
    () =>
      skills.saveStrategy(
        platform,
        capability,
        {
          ...fakeStrategy('/api/v1/items'),
          headers: { accept: 'application/json' },
        },
        'same URL',
        'sess_same_url',
        audit,
      ),
    (err) => {
      assert.doesNotMatch(err.message, /unobserved_url/);
      return true;
    },
  );

  assert.throws(
    () =>
      skills.saveStrategy(
        platform,
        capability,
        fakeStrategy('/api/v2/items'),
        'changed URL',
        'sess_changed_url',
        audit,
      ),
    /unobserved_url/,
  );
});

test('multi-tier capability: unchanged URLs stay grounded against the SAME-tier file', () => {
  // The unobserved_url grandfather set keys on tier-prefixed structural
  // paths (`fetch.endpoint` vs `page-script.endpoint`), so an amend must
  // compare against the file on the submitted tier — the fetch file (tier
  // priority head) can never ground a page-script endpoint.
  const platform = 'site-two-tier-grounding';
  const capability = 'list_items';
  const pageScript = (headers = {}) => ({
    schema_version: 1,
    strategy: 'page-script',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/api/items/search',
    headers,
    notes: { params: {} },
  });
  skills.saveStrategy(platform, capability, fakeStrategy('/api/v1/items'));
  skills.saveStrategy(platform, capability, pageScript());
  const audit = {
    observedUrls: [],
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
    session: null,
  };

  assert.throws(
    () =>
      skills.saveStrategy(
        platform,
        capability,
        pageScript({ accept: 'application/json' }),
        'same URL, page-script tier',
        'sess_two_tier_same_url',
        audit,
      ),
    (err) => {
      assert.doesNotMatch(err.message, /unobserved_url/);
      return true;
    },
  );
});
