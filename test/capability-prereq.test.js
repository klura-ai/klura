// Unit tests for {kind: "capability"} prereq — the recursive
// execute() invocation primitive that makes chained strategies
// (lookup_X_by_Y → write using {{x_id}}) first-class.
//
// Covers: shape validation, self-loop rejection, nonexistent-target
// rejection, depth guard, walkJsonPath helper, draft bubble-up.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tmp KLURA_HOME before skills module loads — same pattern used by
// other save-path tests.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-capability-prereq-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { saveStrategy, validateStrategyShape } = await import('../dist/strategies/skills.js');
const { validatePrereqShape } = await import('../dist/strategies/validate/prereqs.js');
const { execute, walkJsonPath, MAX_PREREQ_DEPTH } = await import('../dist/execution/index.js');
const { execute: kluraExecute } = await import('../dist/index.js');
const { defaultCapabilityCache } = await import('../dist/cache/capability-cache.js');
const { setCapabilityPolicy, savePolicy } = await import('../dist/strategies/policy.js');
const { getHealth } = await import('../dist/strategies/health.js');

function expectRejectSave(platform, capability, data, matcher) {
  assert.throws(
    () => saveStrategy(platform, capability, data),
    (err) => {
      assert.match(err.message, /^invalid_strategy:/);
      if (matcher instanceof RegExp) assert.match(err.message, matcher);
      else if (typeof matcher === 'string') assert.ok(err.message.includes(matcher), err.message);
      return true;
    },
  );
}

// ---- walkJsonPath ----

test('walkJsonPath: extracts nested object path', () => {
  const tree = { data: { user: { id: '123', name: 'alice' } } };
  assert.strictEqual(walkJsonPath(tree, 'data.user.id'), '123');
});

test('walkJsonPath: array index', () => {
  const tree = { results: [{ id: 'a' }, { id: 'b' }] };
  assert.strictEqual(walkJsonPath(tree, 'results.0.id'), 'a');
  assert.strictEqual(walkJsonPath(tree, 'results.1.id'), 'b');
});

test('walkJsonPath: missing segment returns undefined', () => {
  const tree = { a: 1 };
  assert.strictEqual(walkJsonPath(tree, 'a.b'), undefined);
  assert.strictEqual(walkJsonPath(tree, 'nope'), undefined);
});

test('walkJsonPath: bracket array index (idiomatic JS) matches dot index', () => {
  // The LLM reaches for results[0].id (learned from fetch-extract / plain JS);
  // it must resolve identically to results.0.id, not silently return undefined.
  const tree = { results: [{ id: 'a' }, { id: 'b' }] };
  assert.strictEqual(walkJsonPath(tree, 'results[0].id'), 'a');
  assert.strictEqual(walkJsonPath(tree, 'results[1].id'), 'b');
  assert.strictEqual(walkJsonPath(tree, 'results[0].id'), walkJsonPath(tree, 'results.0.id'));
});

test('walkJsonPath: numeric bracket mixed with dot segments', () => {
  const tree = { data: { items: [{ node: { id: 'x' } }] } };
  assert.strictEqual(walkJsonPath(tree, 'data.items[0].node.id'), 'x');
});

test('walkJsonPath: empty path returns root', () => {
  const tree = { a: 1 };
  assert.strictEqual(walkJsonPath(tree, ''), tree);
});

test('walkJsonPath: null / undefined root is safe', () => {
  assert.strictEqual(walkJsonPath(null, 'anything'), undefined);
  assert.strictEqual(walkJsonPath(undefined, 'anything'), undefined);
});

// ---- Shape validation ----

test('capability prereq: shape requires capability + vars', () => {
  expectRejectSave(
    'test-platform',
    'write_op',
    {
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: '/write',
      prerequisites: [
        { name: 'thread', kind: 'capability' }, // missing capability
      ],
    },
    /capability.*\.capability is required/s,
  );
});

test('capability prereq: vars name must be an identifier', () => {
  expectRejectSave(
    'test-platform',
    'write_op2',
    {
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: '/write',
      prerequisites: [
        {
          name: 'thread',
          kind: 'capability',
          capability: 'lookup_thread_by_name',
          vars: { '99invalid': 'results.0.id' },
        },
      ],
    },
    /vars.*must be.*identifier|identifier/i,
  );
});

test('capability prereq: shape rejects non-slug capability value', () => {
  expectRejectSave(
    'test-platform',
    'write_op3',
    {
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: '/write',
      prerequisites: [
        {
          name: 'thread',
          kind: 'capability',
          capability: 'INVALID CAPITALS',
          vars: { thread_id: 'results.0.id' },
        },
      ],
    },
    /capability/i,
  );
});

// ---- Self-loop rejection ----

test('capability prereq: self-loop (same platform+capability) rejected at save', () => {
  expectRejectSave(
    'test-platform',
    'cyclic',
    {
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: '/cycle',
      prerequisites: [
        {
          name: 'self',
          kind: 'capability',
          capability: 'cyclic', // points at the strategy being saved
          vars: { x: 'data.id' },
        },
      ],
    },
    /self-loop|recurse infinitely/,
  );
});

// ---- Nonexistent target rejection ----

test('capability prereq: nonexistent target rejected unless optional', () => {
  expectRejectSave(
    'test-platform',
    'needs_lookup',
    {
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'lookup',
          kind: 'capability',
          capability: 'lookup_that_does_not_exist_yet',
          vars: { x: 'data.id' },
        },
      ],
    },
    /no strategy with that slug is saved|Save the lookup strategy FIRST/,
  );
});

test('capability prereq: nonexistent target ACCEPTED when optional:true', () => {
  // Save a strategy that references a nonexistent capability with
  // optional:true. Save should succeed; warm execute would bind null.
  saveStrategy('test-platform', 'accepts_missing_lookup', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/x',
    body: { x: '{{x}}' },
    prerequisites: [
      {
        name: 'maybe',
        kind: 'capability',
        capability: 'maybe_lookup_exists',
        vars: { x: 'data.id' },
        optional: true,
      },
    ],
  });
  const filePath = path.join(
    TMP,
    'skills',
    'test-platform',
    'fetch',
    'accepts_missing_lookup.json',
  );
  assert.ok(fs.existsSync(filePath));
});

// ---- Valid capability prereq save ----

test('capability prereq: saves when target exists', () => {
  // First save the target
  saveStrategy('test-platform', 'lookup_user_by_name', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/users?q={{name}}',
    notes: { params: { name: { description: 'user name', kind: 'text', example: 'alice' } } },
  });
  // Then the write referencing it
  saveStrategy('test-platform', 'send_msg_to_user', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/messages/{{user_id}}',
    body: { text: '{{text}}' },
    prerequisites: [
      {
        name: 'user',
        kind: 'capability',
        capability: 'lookup_user_by_name',
        args: { name: '{{recipient_name}}' },
        vars: { user_id: 'user_id' },
      },
    ],
    notes: {
      params: {
        recipient_name: { description: 'recipient display name', kind: 'text', example: 'alice' },
        text: { description: 'message text', kind: 'text', example: 'hi' },
      },
    },
  });
  // Read back: both strategies exist. fetch lands in `api/`,
  // fetch lands in `assisted/` (skills.ts subdir map).
  assert.ok(
    fs.existsSync(path.join(TMP, 'skills', 'test-platform', 'fetch', 'lookup_user_by_name.json')),
  );
  assert.ok(
    fs.existsSync(path.join(TMP, 'skills', 'test-platform', 'fetch', 'send_msg_to_user.json')),
  );
});

test('capability prereq: cross-platform platform slug override is accepted', () => {
  // The prereq can point at a different platform's capability.
  // For the save-time check to pass, the target must exist on THAT
  // platform.
  saveStrategy('other-platform', 'lookup_thing', {
    strategy: 'fetch',
    baseUrl: 'https://api.other.com',
    endpoint: '/thing',
  });
  saveStrategy('test-platform', 'cross_platform_caller', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/x',
    prerequisites: [
      {
        name: 'thing',
        kind: 'capability',
        platform: 'other-platform',
        capability: 'lookup_thing',
        vars: { thing_id: 'data.id' },
      },
    ],
  });
});

// ---- MAX_PREREQ_DEPTH exported ----

test('MAX_PREREQ_DEPTH is exported as 5', () => {
  assert.strictEqual(MAX_PREREQ_DEPTH, 5);
});

test('preflight policy and depth rejections are structurally not_run', async () => {
  const depthResult = await execute('preflight-state', 'anything', {}, null, null, {
    _depth: MAX_PREREQ_DEPTH + 1,
  });
  assert.equal(depthResult.executionState, 'not_run');

  saveStrategy('preflight-state', 'capped_read', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items',
    method: 'GET',
  });
  setCapabilityPolicy('preflight-state', 'capped_read', 'recorded-path');
  const capped = await execute('preflight-state', 'capped_read');
  assert.equal(capped.executionState, 'not_run');

  savePolicy('preflight-state', { forbid_capabilities: ['forbidden_read'] });
  const forbidden = await execute('preflight-state', 'forbidden_read');
  assert.equal(forbidden.executionState, 'not_run');
});

test('argument preflight rejections are structurally not_run', async () => {
  saveStrategy('argument-preflight-state', 'required_read', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items?q={{query}}',
    method: 'GET',
    notes: { params: { query: { kind: 'text' } } },
  });
  const missing = await execute('argument-preflight-state', 'required_read');
  assert.equal(missing.executionState, 'not_run');
  assert.equal(missing.body.error, 'missing_args');

  saveStrategy('argument-preflight-state', 'grounded_read', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items?category={{category}}',
    method: 'GET',
    notes: {
      params: {
        category: {
          kind: 'enum',
          observed_values: [
            { value: 'books', label: 'Books' },
            { value: 'music', label: 'Music' },
          ],
        },
      },
    },
  });
  const unobserved = await execute('argument-preflight-state', 'grounded_read', {
    category: 'games',
  });
  assert.equal(unobserved.executionState, 'not_run');
  assert.equal(unobserved.body.error, 'unobserved_enum_arg');
});

test('capability prereq args omit an exact absent optional field before subexecute', async () => {
  const platform = 'optional-prereq-args';
  saveStrategy(platform, 'lookup_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/lookup?filter={{filter}}',
    method: 'GET',
    notes: { params: { filter: { kind: 'text', optional: true } } },
  });
  saveStrategy(platform, 'list_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items',
    method: 'GET',
    prerequisites: [
      {
        name: 'lookup',
        kind: 'capability',
        capability: 'lookup_items',
        args: { filter: '{{filter}}' },
        vars: {},
      },
    ],
    notes: { params: { filter: { kind: 'text', optional: true } } },
  });

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (requestUrl) => {
    calls.push(String(requestUrl));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await execute(platform, 'list_items');
    assert.equal(result.body.ok, true);
    assert.deepEqual(calls, ['https://api.example.com/lookup', 'https://api.example.com/items']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('capability prereq args omit an exact nested path from an absent or empty optional array', async () => {
  const platform = 'optional-nested-prereq-args';
  saveStrategy(platform, 'lookup_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/lookup?filter={{filter}}',
    method: 'GET',
    notes: { params: { filter: { kind: 'text', optional: true } } },
  });
  saveStrategy(platform, 'list_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items',
    method: 'GET',
    prerequisites: [
      {
        name: 'lookup',
        kind: 'capability',
        capability: 'lookup_items',
        args: { filter: '{{filters.0}}' },
        vars: {},
      },
    ],
    notes: { params: { filters: { kind: 'array', optional: true } } },
  });

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (requestUrl) => {
    calls.push(String(requestUrl));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    for (const args of [{}, { filters: [] }]) {
      const result = await execute(platform, 'list_items', args);
      assert.equal(result.body.ok, true);
    }
    assert.deepEqual(calls, [
      'https://api.example.com/lookup',
      'https://api.example.com/items',
      'https://api.example.com/lookup',
      'https://api.example.com/items',
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('capability prereq args reject an embedded absent optional field before subexecute', async () => {
  const platform = 'embedded-optional-prereq-args';
  saveStrategy(platform, 'lookup_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/lookup?filter={{filter}}',
    method: 'GET',
    notes: { params: { filter: { kind: 'text' } } },
  });
  saveStrategy(platform, 'list_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items',
    method: 'GET',
    prerequisites: [
      {
        name: 'lookup',
        kind: 'capability',
        capability: 'lookup_items',
        args: { filter: 'prefix:{{filter}}' },
        vars: {},
      },
    ],
    notes: { params: { filter: { kind: 'text', optional: true } } },
  });

  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const result = await execute(platform, 'list_items');
    assert.equal(result.executionState, 'not_run');
    assert.equal(result.body.error, 'unresolved_placeholders');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('dynamic enum source propagates not_run without firing the parent', async () => {
  const platform = 'dynamic-enum-neutral';
  saveStrategy(platform, 'list_categories', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/categories',
    method: 'GET',
    generated: {
      nonce: { instruction: 'Return the current request nonce.' },
    },
  });
  saveStrategy(platform, 'list_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items?category={{category}}',
    method: 'GET',
    notes: {
      params: {
        category: {
          kind: 'enum',
          source: 'capability:list_categories',
        },
      },
    },
  });

  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const result = await execute(platform, 'list_items', { category: 'books' });
    assert.equal(result.executionState, 'not_run');
    assert.equal(result.body.error, 'dynamic_enum_source_not_run');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('capability prereq: HTTP 200 with body.ok false blocks the parent request', async () => {
  const platform = 'explicit-failure-prereq';
  saveStrategy(platform, 'lookup_session', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/lookup',
    method: 'GET',
  });
  saveStrategy(platform, 'list_private_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items',
    method: 'GET',
    prerequisites: [
      {
        name: 'session',
        kind: 'capability',
        capability: 'lookup_session',
        vars: {},
      },
    ],
  });

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/lookup')) {
      return new Response(JSON.stringify({ ok: false, outcome: 'session_absent' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await execute(platform, 'list_private_items');
    assert.equal(result.status, 0);
    assert.equal(result.body.error, 'all_strategies_failed');
    assert.deepEqual(calls, ['https://api.example.com/lookup']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('optional capability prereq binds null on not_run and continues the parent', async () => {
  const platform = 'optional-not-run-prereq';
  saveStrategy(platform, 'optional_lookup', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/lookup?query={{query}}',
    method: 'GET',
    notes: {
      params: {
        query: { kind: 'text' },
      },
    },
  });
  saveStrategy(platform, 'list_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items',
    method: 'POST',
    body: { lookup_id: '{{lookup_id}}' },
    prerequisites: [
      {
        name: 'lookup',
        kind: 'capability',
        capability: 'optional_lookup',
        args: { query: '{{query}}' },
        vars: { lookup_id: 'id' },
        optional: true,
      },
    ],
    notes: {
      params: {
        query: { kind: 'text', optional: true },
      },
    },
  });

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, items: [{ id: 'one' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await execute(platform, 'list_items');
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.ok, true);
    assert.deepEqual(calls, [{ url: 'https://api.example.com/items', body: { lookup_id: null } }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('capability prereq preserves structured object bindings for the parent', async () => {
  const platform = 'structured-prereq-binding';
  saveStrategy(platform, 'search_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/search',
    method: 'GET',
  });
  saveStrategy(platform, 'consume_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/consume',
    method: 'POST',
    body: { search_result: '{{search_result}}' },
    prerequisites: [
      {
        name: 'search',
        kind: 'capability',
        capability: 'search_items',
        vars: { search_result: 'payload' },
      },
    ],
  });

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(url).endsWith('/search')) {
      return new Response(
        JSON.stringify({ ok: true, payload: { items: [{ id: 'one' }], next: null } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await execute(platform, 'consume_items');
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(calls, [
      { url: 'https://api.example.com/search', body: null },
      {
        url: 'https://api.example.com/consume',
        body: { search_result: { items: [{ id: 'one' }], next: null } },
      },
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('optional capability prereq does not skip delivery_unknown', async () => {
  const platform = 'optional-delivery-unknown-prereq';
  saveStrategy(platform, 'submit_lookup', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/lookup',
    method: 'POST',
    body: { action: 'lookup' },
  });
  saveStrategy(platform, 'list_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items',
    method: 'GET',
    prerequisites: [
      {
        name: 'lookup',
        kind: 'capability',
        capability: 'submit_lookup',
        vars: {},
        optional: true,
      },
    ],
  });

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const error = new Error('request connection closed');
    error.cause = { code: 'ECONNRESET' };
    throw error;
  };
  try {
    const result = await execute(platform, 'list_items');
    assert.equal(result.executionState, 'sent_unconfirmed');
    assert.equal(result.body.error, 'capability_prerequisite_delivery_unknown');
    assert.deepEqual(calls, ['https://api.example.com/lookup']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('suppressed strategy state propagates through capability prerequisites', async () => {
  const platform = 'suppressed-nested-prereq-state';
  saveStrategy(platform, 'unstable_lookup', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/lookup',
    method: 'GET',
  });
  saveStrategy(platform, 'list_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items',
    method: 'GET',
    prerequisites: [
      {
        name: 'lookup',
        kind: 'capability',
        capability: 'unstable_lookup',
        vars: { lookup_id: 'id' },
      },
    ],
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  try {
    for (let i = 0; i < 6; i += 1) {
      const result = await execute(platform, 'list_items', {}, null, null, {
        _suppressStrategyState: true,
      });
      assert.equal(result.status, 0);
    }
    assert.deepEqual(getHealth(platform, 'unstable_lookup', 'fetch'), {
      status: 'healthy',
      failureCount: 0,
    });
    assert.equal(
      fs.existsSync(path.join(TMP, 'skills', platform, 'fetch', 'unstable_lookup.json')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(TMP, 'skills', platform, 'fetch', 'unstable_lookup.broken.json')),
      false,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('public execute forwards suppressed strategy state to the execution core', async () => {
  const platform = 'public-suppressed-strategy-state';
  saveStrategy(platform, 'unstable_read', {
    strategy: 'fetch',
    baseUrl: 'https://unstable-public.example',
    endpoint: '/unstable',
    method: 'GET',
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'temporary_failure' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  try {
    for (let i = 0; i < 6; i += 1) {
      await kluraExecute(platform, 'unstable_read', {}, { _suppressStrategyState: true });
    }
    assert.deepEqual(getHealth(platform, 'unstable_read', 'fetch'), {
      status: 'healthy',
      failureCount: 0,
    });
    assert.equal(
      fs.existsSync(path.join(TMP, 'skills', platform, 'fetch', 'unstable_read.json')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(TMP, 'skills', platform, 'fetch', 'unstable_read.broken.json')),
      false,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('suppressed public execute bypasses prerequisite cache reads and writes', async () => {
  const platform = 'suppressed-prereq-cache';
  saveStrategy(platform, 'lookup_item', {
    strategy: 'fetch',
    baseUrl: 'https://suppressed-cache.example',
    endpoint: '/lookup',
    method: 'GET',
    cache: { ttl: '1h' },
  });
  saveStrategy(platform, 'read_item', {
    strategy: 'fetch',
    baseUrl: 'https://suppressed-cache.example',
    endpoint: '/items?lookup_id={{lookup_id}}',
    method: 'GET',
    prerequisites: [
      {
        name: 'lookup',
        kind: 'capability',
        capability: 'lookup_item',
        vars: { lookup_id: 'id' },
      },
    ],
  });

  defaultCapabilityCache.clearAll();
  const realFetch = globalThis.fetch;
  const calls = [];
  let liveLookupId = 'stale';
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    calls.push(requestedUrl);
    if (requestedUrl.endsWith('/lookup')) {
      return new Response(JSON.stringify({ id: liveLookupId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ requested_url: requestedUrl }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const initial = await kluraExecute(platform, 'read_item');
    assert.equal(initial.status, 200, JSON.stringify(initial));
    assert.deepEqual(calls, [
      'https://suppressed-cache.example/lookup',
      'https://suppressed-cache.example/items?lookup_id=stale',
    ]);

    calls.length = 0;
    liveLookupId = 'fresh';
    const suppressed = await kluraExecute(
      platform,
      'read_item',
      {},
      {
        _suppressStrategyState: true,
      },
    );
    assert.equal(suppressed.status, 200, JSON.stringify(suppressed));
    assert.deepEqual(calls, [
      'https://suppressed-cache.example/lookup',
      'https://suppressed-cache.example/items?lookup_id=fresh',
    ]);

    calls.length = 0;
    const ordinary = await kluraExecute(platform, 'read_item');
    assert.equal(ordinary.status, 200, JSON.stringify(ordinary));
    assert.deepEqual(
      calls,
      ['https://suppressed-cache.example/items?lookup_id=stale'],
      'suppressed verification must not replace the ordinary prerequisite cache entry',
    );
  } finally {
    defaultCapabilityCache.clearAll();
    globalThis.fetch = realFetch;
  }
});

test('optional capability prereq cannot turn a missing response.from path into empty success', async () => {
  const platform = 'optional-missing-direct-result';
  saveStrategy(platform, 'search_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/search',
    method: 'GET',
  });
  saveStrategy(platform, 'actor_result', {
    strategy: 'fetch',
    response: { from: 'actor_body', format: 'json' },
    prerequisites: [
      {
        name: 'search',
        kind: 'capability',
        capability: 'search_items',
        vars: { actor_body: 'body' },
        optional: true,
      },
    ],
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, items: [{ id: 'one' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  try {
    const result = await execute(platform, 'actor_result');
    assert.equal(result.status, 0);
    assert.equal(result.body.error, 'all_strategies_failed');
    assert.match(JSON.stringify(result.body), /empty value/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- optional prerequisites shape validation (page-script / fetch) ----

test('page-script page-extract prereq without "name" is rejected at save time', () => {
  expectRejectSave(
    'test-plat-validate-1',
    'cap_missing_name',
    {
      strategy: 'page-script',
      baseUrl: 'https://www.example.com/@{{user}}',
      endpoint: '/api/x?user={{slug}}',
      method: 'GET',
      prerequisites: [
        {
          kind: 'page-extract',
          url: 'https://www.example.com/@{{user}}',
          vars: { slug: { selector: 'meta[name=slug]', attr: 'content' } },
        },
      ],
      notes: { params: { user: { example: 'alice' } } },
    },
    /prerequisites\[0\].*name is required/s,
  );
});

test('cached prereq without "name" is rejected at save time — name is the token-cache key', () => {
  // Execution reads `prereq.name` as both the token-cache key and the binding
  // name, so a cached prereq without one can never resolve. The Zod schema
  // enforces the same contract at save time.
  expectRejectSave(
    'test-plat-validate-cached',
    'cap_cached_missing_name',
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/api/x',
      method: 'GET',
      prerequisites: [{ kind: 'cached' }],
    },
    /prerequisites\[0\].*name is required/s,
  );
});

test('cached prereq with extra bookkeeping fields is accepted (loose object)', () => {
  const prereq = { name: 'auth_token', kind: 'cached', key: 'auth:token', value: 'v' };
  // validatePrereqShape throws on rejection; no throw means the loose-object
  // contract holds for extra fields alongside the required name.
  validatePrereqShape('fetch', 0, prereq);
});

test('page-script page-extract prereq without "url" is rejected at save time', () => {
  expectRejectSave(
    'test-plat-validate-2',
    'cap_missing_url',
    {
      strategy: 'page-script',
      baseUrl: 'https://www.example.com/@{{user}}',
      endpoint: '/api/x?user={{slug}}',
      method: 'GET',
      prerequisites: [
        {
          name: 'load_slug',
          kind: 'page-extract',
          vars: { slug: { selector: 'meta[name=slug]', attr: 'content' } },
        },
      ],
      notes: { params: { user: { example: 'alice' } } },
    },
    /page-extract.*\.url is required/s,
  );
});

test('page-extract spec with unknown "jsonPath" key is rejected — pointer at js-eval', () => {
  expectRejectSave(
    'test-plat-validate-3',
    'cap_jsonpath',
    {
      strategy: 'page-script',
      baseUrl: 'https://www.example.com/@{{user}}',
      endpoint: '/api/x?slug={{slug}}',
      method: 'GET',
      prerequisites: [
        {
          name: 'load_slug',
          kind: 'page-extract',
          url: 'https://www.example.com/@{{user}}',
          vars: {
            slug: {
              selector: 'script#__DATA__',
              jsonPath: '$.user.slug',
            },
          },
        },
      ],
      notes: { params: { user: { example: 'alice' } } },
    },
    /unknown field.*"jsonPath".*js-eval/s,
  );
});
