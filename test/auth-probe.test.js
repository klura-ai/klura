// auth-probe — crisp HTTP-status + final-URL classifier that replaces
// the earlier fuzzy keyword regex against response body.
//
// The narrow URL-pathname-segment heuristic is the only fuzzy bit, and
// it's small and structural (a fixed list of well-defined web
// conventions: /login, /signin, /sign-in, /auth/). Tests pin its behavior
// — false positives or new sites that need additional segments would
// surface here first.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pickProbeUrl } = await import('../dist/auth/probe.js');
const { isLoginWallUrl } = await import('../dist/response/auth-wall.js');

test('isLoginWallUrl: positive cases', () => {
  assert.equal(isLoginWallUrl('http://x.test/login'), true);
  assert.equal(isLoginWallUrl('https://x.test/login?next=/feed'), true);
  assert.equal(isLoginWallUrl('https://x.test/signin'), true);
  assert.equal(isLoginWallUrl('https://x.test/sign-in?return=foo'), true);
  assert.equal(isLoginWallUrl('https://x.test/sign_in'), true);
  assert.equal(isLoginWallUrl('https://x.test/auth/login'), true);
  assert.equal(isLoginWallUrl('https://accounts.x.test/auth/?continue=/'), true);
});

test('isLoginWallUrl: negative cases (logged-in URLs should not match)', () => {
  assert.equal(isLoginWallUrl('https://x.test/'), false);
  assert.equal(isLoginWallUrl('https://x.test/feed'), false);
  assert.equal(isLoginWallUrl('https://x.test/t/12345'), false);
  assert.equal(isLoginWallUrl('https://x.test/users/alice/inbox'), false);
  assert.equal(isLoginWallUrl('https://x.test/api/send'), false);
});

test('isLoginWallUrl: handles invalid URLs without throwing', () => {
  assert.equal(isLoginWallUrl(''), false);
  assert.equal(isLoginWallUrl(null), false);
  assert.equal(isLoginWallUrl('not a url'), false);
});

test('pickProbeUrl: prefers runtime_meta.discovered_from_url', () => {
  const strategy = {
    baseUrl: 'https://x.test',
    runtime_meta: { discovered_from_url: 'https://x.test/t/abc' },
  };
  assert.equal(pickProbeUrl(strategy), 'https://x.test/t/abc');
});

test('pickProbeUrl: falls back to baseUrl when no discovered_from_url', () => {
  const strategy = { baseUrl: 'https://x.test' };
  assert.equal(pickProbeUrl(strategy), 'https://x.test');
});

test('pickProbeUrl: returns null when neither is present', () => {
  assert.equal(pickProbeUrl({}), null);
  assert.equal(pickProbeUrl(null), null);
  assert.equal(pickProbeUrl({ runtime_meta: { foo: 'bar' } }), null);
});

test('pickProbeUrl: empty-string fields are treated as missing', () => {
  const strategy = { baseUrl: '', runtime_meta: { discovered_from_url: '' } };
  assert.equal(pickProbeUrl(strategy), null);
});
