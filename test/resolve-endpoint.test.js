// Unit tests for joinBaseAndPath — the WHATWG-URL resolution step used by
// resolveEndpoint in execution.ts + probe.ts's URL-build sites.

import test from 'node:test';
import assert from 'node:assert';

const { joinBaseAndPath } = await import('../dist/execution/vars.js');

test('joinBaseAndPath: rooted endpoint replaces base path', () => {
  // Base has a path ("/@user"); endpoint is rooted at
  // host ("/api/x"). WHATWG resolves to host + endpoint.
  assert.strictEqual(
    joinBaseAndPath('https://www.tiktok.com/@user', '/api/post/item_list/'),
    'https://www.tiktok.com/api/post/item_list/',
  );
});

test('joinBaseAndPath: absolute endpoint URL wins (no double-URL mangling)', () => {
  // URL resolution returns the absolute endpoint.
  assert.strictEqual(
    joinBaseAndPath('https://www.tiktok.com/@user', 'https://www.tiktok.com/api/x'),
    'https://www.tiktok.com/api/x',
  );
});

test('joinBaseAndPath: relative path resolves against base directory', () => {
  // No leading slash → relative to base's dir. WHATWG strips the last
  // segment of base path.
  assert.strictEqual(
    joinBaseAndPath('https://api.example.com/v1/', 'users'),
    'https://api.example.com/v1/users',
  );
  assert.strictEqual(
    joinBaseAndPath('https://api.example.com/v1', 'users'),
    'https://api.example.com/users',
  );
});

test('joinBaseAndPath: trailing-slash base + rooted endpoint', () => {
  // Common pre-existing shape. No change expected.
  assert.strictEqual(
    joinBaseAndPath('https://api.example.com/', '/foo'),
    'https://api.example.com/foo',
  );
});

test('joinBaseAndPath: trailing-slash base + bare path', () => {
  assert.strictEqual(
    joinBaseAndPath('https://api.example.com/', 'foo'),
    'https://api.example.com/foo',
  );
});

test('joinBaseAndPath: query-only endpoint merges with base path', () => {
  assert.strictEqual(
    joinBaseAndPath('https://api.example.com/search', '?q=1'),
    'https://api.example.com/search?q=1',
  );
});

test('joinBaseAndPath: empty endpoint returns base as-is', () => {
  assert.strictEqual(
    joinBaseAndPath('https://api.example.com/search', ''),
    'https://api.example.com/search',
  );
});

test('joinBaseAndPath: empty base returns endpoint as-is', () => {
  assert.strictEqual(joinBaseAndPath('', '/api/x'), '/api/x');
});

test('joinBaseAndPath: WHATWG fallback — unresolvable base keeps something sensible', () => {
  // Weird base that new URL can't parse shouldn't crash; the fallback
  // path concatenates defensively.
  const out = joinBaseAndPath('not-a-url', 'foo');
  assert.ok(typeof out === 'string' && out.length > 0);
});
