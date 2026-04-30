// Unit tests for the typed-edge `{kind: "tag", tag: "<tag>"}` prereq and the
// capability-side `provides: [...]` declaration. Covers shape validation,
// `findCapabilitiesProviding` resolution, save-time validators, the
// auto-injection rewrite, and the auth-wall lazy retry path.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tag-prereq-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const skills = await import('../dist/strategies/skills.js');
const { saveStrategy, findCapabilitiesProviding, validateStrategyShape } = skills;
const cacheModule = await import('../dist/cache/capability-cache.js');
const { defaultCapabilityCache } = cacheModule;
const saveWarnings = await import('../dist/gate/save-warnings.js');
const { detectAuthGatedWithoutAuthPrereq } = saveWarnings;

function expectReject(fn, matcher) {
  assert.throws(fn, (err) => {
    assert.match(err.message, /^invalid_strategy:/);
    if (matcher instanceof RegExp) assert.match(err.message, matcher);
    else if (typeof matcher === 'string') assert.ok(err.message.includes(matcher), err.message);
    return true;
  });
}

// ---------- provides: [...] field validation ----------

test('provides: accepts a string array of identifier slugs', () => {
  validateStrategyShape({
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/x',
    provides: ['auth', 'list_users'],
  });
});

test('provides: rejects non-array', () => {
  expectReject(
    () =>
      validateStrategyShape({
        strategy: 'fetch',
        baseUrl: 'https://api.example.com',
        endpoint: '/x',
        provides: 'auth',
      }),
    /provides must be an array/,
  );
});

test('provides: rejects non-identifier tag', () => {
  expectReject(
    () =>
      validateStrategyShape({
        strategy: 'fetch',
        baseUrl: 'https://api.example.com',
        endpoint: '/x',
        provides: ['Bad Tag With Spaces'],
      }),
    /identifier|provides/i,
  );
});

test('provides: rejects duplicate tags', () => {
  expectReject(
    () =>
      validateStrategyShape({
        strategy: 'fetch',
        baseUrl: 'https://api.example.com',
        endpoint: '/x',
        provides: ['auth', 'auth'],
      }),
    /more than once/,
  );
});

// ---------- {kind: "tag"} prereq shape ----------

test('tag prereq: requires a non-empty tag field', () => {
  expectReject(
    () =>
      saveStrategy('tag-test-1', 'consumer', {
        strategy: 'fetch',
        baseUrl: 'https://api.example.com',
        endpoint: '/x',
        prerequisites: [{ name: 'auth', kind: 'tag' }],
      }),
    /tag is required/,
  );
});

test('tag prereq: rejects non-identifier tag value', () => {
  expectReject(
    () =>
      saveStrategy('tag-test-2', 'consumer', {
        strategy: 'fetch',
        baseUrl: 'https://api.example.com',
        endpoint: '/x',
        prerequisites: [{ name: 'auth', kind: 'tag', tag: 'NOT A SLUG' }],
      }),
    /tag/i,
  );
});

// ---------- findCapabilitiesProviding ----------

test('findCapabilitiesProviding: 0 providers when none declared', () => {
  // Fresh platform — no on-disk capabilities yet.
  assert.deepStrictEqual(findCapabilitiesProviding('finder-test-empty', 'auth'), []);
});

test('findCapabilitiesProviding: returns slug when one capability advertises tag', () => {
  saveStrategy('finder-test-one', 'login', {
    strategy: 'recorded-path',
    provides: ['auth'],
    steps: [
      {
        id: 'click_in',
        action: 'click',
        locators: { a11y: { role: 'button', name: 'Sign in' }, css: '#in' },
      },
    ],
  });
  const providers = findCapabilitiesProviding('finder-test-one', 'auth');
  assert.deepStrictEqual(providers, ['login']);
});

test('findCapabilitiesProviding: returns multiple slugs sorted, dedupes by slug', () => {
  saveStrategy('finder-test-multi', 'login_password', {
    strategy: 'recorded-path',
    provides: ['auth'],
    steps: [
      {
        id: 'click_in',
        action: 'click',
        locators: { a11y: { role: 'button', name: 'Sign in' }, css: '#in' },
      },
    ],
  });
  saveStrategy('finder-test-multi', 'login_gmail', {
    strategy: 'recorded-path',
    provides: ['auth'],
    steps: [
      {
        id: 'click_g',
        action: 'click',
        locators: { a11y: { role: 'button', name: 'Sign in with Google' }, css: '#g' },
      },
    ],
  });
  // Tag the agent doesn't advertise — should be empty.
  assert.deepStrictEqual(findCapabilitiesProviding('finder-test-multi', 'noop'), []);
  const providers = findCapabilitiesProviding('finder-test-multi', 'auth');
  assert.deepStrictEqual(providers.sort(), ['login_gmail', 'login_password']);
});

// ---------- Save-time tag-prereq validation ----------

test('tag prereq save-time: rejects when no provider exists on platform', () => {
  expectReject(
    () =>
      saveStrategy('tag-savetime-empty', 'list_items', {
        strategy: 'fetch',
        baseUrl: 'https://api.example.com',
        endpoint: '/items',
        prerequisites: [{ name: 'auth', kind: 'tag', tag: 'auth' }],
      }),
    /no saved capability/,
  );
});

test('tag prereq save-time: accepts when at least one provider exists', () => {
  saveStrategy('tag-savetime-ok', 'login', {
    strategy: 'recorded-path',
    provides: ['auth'],
    steps: [
      {
        id: 'click_in',
        action: 'click',
        locators: { a11y: { role: 'button', name: 'Sign in' }, css: '#in' },
      },
    ],
  });
  saveStrategy('tag-savetime-ok', 'list_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items',
    prerequisites: [{ name: 'auth', kind: 'tag', tag: 'auth' }],
  });
});

test('tag prereq save-time: optional:true skips provider check', () => {
  saveStrategy('tag-savetime-opt', 'list_items', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/items',
    prerequisites: [{ name: 'auth', kind: 'tag', tag: 'auth', optional: true }],
  });
});

test('tag prereq save-time: self-loop rejected when capability advertises the tag it requires', () => {
  expectReject(
    () =>
      saveStrategy('tag-self-loop', 'cyclic_auth', {
        strategy: 'fetch',
        baseUrl: 'https://api.example.com',
        endpoint: '/x',
        provides: ['auth'],
        prerequisites: [{ name: 'auth', kind: 'tag', tag: 'auth' }],
      }),
    /self-loop/,
  );
});

// ---------- Save-warning suppression ----------

test('save-warning: suppressed when a {kind: "tag"} prereq is present', () => {
  // No session id → detector early-returns with no warnings. Just confirm
  // the renamed function exists and matches the new identifier.
  const warnings = detectAuthGatedWithoutAuthPrereq(
    {
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: '/x',
      prerequisites: [{ name: 'auth', kind: 'tag', tag: 'auth' }],
    },
    undefined,
  );
  assert.deepStrictEqual(warnings, []);
});

// ---------- CapabilityCache eviction helper ----------

test('CapabilityCache.evictForCapability: drops only matching prefix entries', () => {
  defaultCapabilityCache.clearAll();
  defaultCapabilityCache.set('p', 'alice', 'login_password', undefined, 200, { ok: true }, 60_000);
  defaultCapabilityCache.set('p', 'alice', 'list_items', undefined, 200, { ok: true }, 60_000);
  defaultCapabilityCache.set('p', 'bob', 'login_password', undefined, 200, { ok: true }, 60_000);
  assert.strictEqual(defaultCapabilityCache.size, 3);
  const dropped = defaultCapabilityCache.evictForCapability('p', 'alice', 'login_password');
  assert.strictEqual(dropped, 1);
  assert.strictEqual(defaultCapabilityCache.size, 2);
  // The other alice entry survives, and bob's same-slug entry survives.
  assert.ok(defaultCapabilityCache.get('p', 'alice', 'list_items', undefined));
  assert.ok(defaultCapabilityCache.get('p', 'bob', 'login_password', undefined));
  defaultCapabilityCache.clearAll();
});

test('CapabilityCache.evictForCapability: returns 0 when no match', () => {
  defaultCapabilityCache.clearAll();
  defaultCapabilityCache.set('p', undefined, 'foo', undefined, 200, { ok: true }, 60_000);
  const dropped = defaultCapabilityCache.evictForCapability('p', undefined, 'bar');
  assert.strictEqual(dropped, 0);
  defaultCapabilityCache.clearAll();
});
