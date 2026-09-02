import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-read-candidate-eligibility-'));
process.env.KLURA_HOME = TMP;

const {
  assessReadCandidateEligibility,
  findUnsatisfiedReadCandidatePlaceholders,
  proveReadCandidateSafe,
} = await import('../dist/strategies/read-candidate-eligibility.js');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function writeActive(platform, capability, strategy) {
  const subdir =
    strategy.strategy === 'fetch'
      ? 'fetch'
      : strategy.strategy === 'page-script'
        ? 'scripts'
        : 'recorded';
  const filePath = path.join(TMP, 'skills', platform, subdir, `${capability}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(strategy, null, 2));
}

function readStrategy(overrides = {}) {
  return {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://example.test',
    endpoint: '/items',
    ...overrides,
  };
}

test('a mutating capability or fetch-extract anywhere in the prereq graph is not a candidate', () => {
  writeActive(
    'mutating-graph',
    'write_lookup',
    readStrategy({ method: 'POST', endpoint: '/lookup-and-write' }),
  );
  const viaCapability = readStrategy({
    prerequisites: [
      {
        name: 'lookup',
        kind: 'capability',
        capability: 'write_lookup',
        vars: { item_id: 'id' },
      },
    ],
  });
  assert.equal(proveReadCandidateSafe(viaCapability, 'mutating-graph', 'list_items'), false);

  const inlineMutation = readStrategy({
    prerequisites: [
      {
        name: 'lookup',
        kind: 'fetch-extract',
        method: 'POST',
        url: 'https://example.test/lookup',
        vars: { item_id: 'id' },
      },
    ],
  });
  assert.equal(proveReadCandidateSafe(inlineMutation, 'mutating-graph', 'list_items'), false);

  const opaqueBrowserAction = {
    strategy: 'page-script',
    method: 'GET',
    baseUrl: 'https://example.test',
    endpoint: '/items',
    prerequisites: [
      {
        name: 'advance',
        kind: 'browser',
        steps: [{ action: 'click', selector: '[data-next]' }],
      },
    ],
  };
  assert.equal(proveReadCandidateSafe(opaqueBrowserAction, 'mutating-graph', 'list_items'), false);
});

test('cross-platform transitive auth dependencies fail closed', () => {
  writeActive(
    'auth-target',
    'establish_session',
    readStrategy({ endpoint: '/session', provides: ['auth'] }),
  );
  writeActive('auth-bridge', 'establish_session', readStrategy({ endpoint: '/public-session' }));
  writeActive(
    'auth-bridge',
    'load_profile',
    readStrategy({
      prerequisites: [
        {
          name: 'session',
          kind: 'capability',
          platform: 'auth-target',
          capability: 'establish_session',
        },
      ],
    }),
  );
  const root = readStrategy({
    prerequisites: [
      {
        name: 'profile',
        kind: 'capability',
        platform: 'auth-bridge',
        capability: 'load_profile',
        vars: { profile_id: 'id' },
      },
    ],
  });
  assert.equal(proveReadCandidateSafe(root, 'caller-platform', 'list_profiles'), false);
});

test('canonical template inventory catches prereq fields omitted by audit scanning', () => {
  const strategy = readStrategy({
    prerequisites: [
      {
        name: 'lookup',
        kind: 'fetch-extract',
        url: 'https://example.test/lookup',
        headers_map: { 'x-scope': '{{missing_scope}}' },
        vars: { item_id: 'id' },
      },
    ],
  });
  const result = assessReadCandidateEligibility(strategy, 'template-inventory', 'list_items', {});
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'unsatisfied_placeholders');
  assert.deepEqual(result.unsatisfied_placeholders, ['missing_scope']);
});

test('missing optional values are satisfiable only in exact omittable slots', () => {
  const exact = readStrategy({
    prerequisites: [
      {
        name: 'lookup',
        kind: 'fetch-extract',
        url: 'https://example.test/lookup?cursor={{cursor}}',
        headers_map: { 'x-cursor': '{{cursor}}' },
        vars: { item_id: 'id' },
      },
    ],
    notes: { params: { cursor: { kind: 'text', optional: true } } },
  });
  assert.deepEqual([...findUnsatisfiedReadCandidatePlaceholders(exact, {})], []);

  const restStyle = readStrategy({
    endpoint: '/items?cursor=:cursor&scope=:scope',
    notes: {
      params: {
        cursor: { kind: 'text', optional: true },
        scope: { kind: 'text' },
      },
    },
  });
  assert.deepEqual([...findUnsatisfiedReadCandidatePlaceholders(restStyle, {})], ['scope']);

  const embedded = structuredClone(exact);
  embedded.prerequisites[0].headers_map['x-cursor'] = 'after:{{cursor}}';
  assert.deepEqual([...findUnsatisfiedReadCandidatePlaceholders(embedded, {})], ['cursor']);

  const nestedOptional = readStrategy({
    prerequisites: [
      {
        name: 'lookup',
        kind: 'capability',
        capability: 'optional_lookup',
        args: { query: '{{searches.0}}' },
        vars: { item_id: 'id' },
        optional: true,
      },
    ],
    notes: { params: { searches: { kind: 'array', optional: true } } },
  });
  assert.deepEqual([...findUnsatisfiedReadCandidatePlaceholders(nestedOptional, {})], []);
});

test('a page-script with only structurally read-only prerequisites remains candidate eligible', () => {
  const strategy = {
    strategy: 'page-script',
    method: 'GET',
    baseUrl: 'https://example.test',
    endpoint: '/search?q={{query}}',
    prerequisites: [
      {
        name: 'page_data',
        kind: 'page-extract',
        url: 'https://example.test/search?q={{query}}',
        vars: { result_count: { selector: '[data-count]', attr: 'data-count' } },
      },
      {
        name: 'visible_data',
        kind: 'browser',
        steps: [
          { action: 'navigate', url: 'https://example.test/search?q={{query}}' },
          { action: 'extract', selector: '[data-id]', attribute: 'data-id', as: 'item_id' },
        ],
      },
    ],
    notes: { params: { query: { kind: 'text' } } },
  };
  const result = assessReadCandidateEligibility(strategy, 'safe-page-script', 'search_items', {
    query: 'lamp',
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'eligible');
});

test('a read-shaped js-eval compositor remains candidate eligible', () => {
  writeActive('js-eval-read', 'search_items', {
    strategy: 'page-script',
    origin: 'https://example.test',
    response: { from: 'search_result', format: 'json' },
    prerequisites: [
      {
        name: 'search',
        kind: 'js-eval',
        expression: '({ok:true,items:[]})',
        binds: 'search_result',
      },
    ],
  });
  const strategy = {
    strategy: 'page-script',
    origin: 'https://example.test',
    response: { from: 'actor_body', format: 'json' },
    prerequisites: [
      {
        name: 'search_feed',
        kind: 'capability',
        capability: 'search_items',
        args: { query: '{{query}}' },
        vars: { actor_body: 'body' },
      },
    ],
    notes: { params: { query: { kind: 'text' } } },
  };

  const result = assessReadCandidateEligibility(
    strategy,
    'js-eval-read',
    'scrape_items_actor',
    { query: 'lamp' },
  );
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'eligible');
});

test('cycles and ambiguous tag providers cannot establish a safe-read proof', () => {
  writeActive(
    'cycle-graph',
    'first',
    readStrategy({
      prerequisites: [
        { name: 'second', kind: 'capability', capability: 'second', vars: { id: 'id' } },
      ],
    }),
  );
  writeActive(
    'cycle-graph',
    'second',
    readStrategy({
      prerequisites: [
        { name: 'first', kind: 'capability', capability: 'first', vars: { id: 'id' } },
      ],
    }),
  );
  const cyclicRoot = readStrategy({
    prerequisites: [{ name: 'first', kind: 'capability', capability: 'first', vars: { id: 'id' } }],
  });
  assert.equal(proveReadCandidateSafe(cyclicRoot, 'cycle-graph', 'root'), false);

  writeActive('ambiguous-tag', 'provider_one', readStrategy({ provides: ['lookup'] }));
  writeActive('ambiguous-tag', 'provider_two', readStrategy({ provides: ['lookup'] }));
  const ambiguous = readStrategy({
    prerequisites: [{ name: 'lookup', kind: 'tag', tag: 'lookup', vars: { id: 'id' } }],
  });
  assert.equal(proveReadCandidateSafe(ambiguous, 'ambiguous-tag', 'root'), false);
});
