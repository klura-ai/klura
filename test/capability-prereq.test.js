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

const { saveStrategy, validateStrategyShape } = await import(
  '../dist/strategies/skills.js'
);
const { walkJsonPath, MAX_PREREQ_DEPTH } = await import(
  '../dist/execution.js'
);

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
  saveStrategy(
    'test-platform',
    'accepts_missing_lookup',
    {
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
    },
  );
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
    fs.existsSync(
      path.join(TMP, 'skills', 'test-platform', 'fetch', 'lookup_user_by_name.json'),
    ),
  );
  assert.ok(
    fs.existsSync(
      path.join(TMP, 'skills', 'test-platform', 'fetch', 'send_msg_to_user.json'),
    ),
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
    /prerequisites\[0\].*missing required.*"name"/,
  );
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
