// Unit tests for the shared login-wall URL detector.
//
// Used by both the warm-execute auth classifier and the save-time probe to
// detect 302-to-login redirects.

import test from 'node:test';
import assert from 'node:assert';

const { isLoginWallUrl } = await import('../dist/response/auth-wall.js');

test('matches /login at end of path', () => {
  assert.ok(isLoginWallUrl('https://example.com/login'));
  assert.ok(isLoginWallUrl('https://example.com/login/'));
  assert.ok(isLoginWallUrl('https://example.com/login?next=/foo'));
  assert.ok(isLoginWallUrl('https://example.com/login#section'));
});

test('matches each login-shaped path segment', () => {
  assert.ok(isLoginWallUrl('https://example.com/signin'));
  assert.ok(isLoginWallUrl('https://example.com/sign-in'));
  assert.ok(isLoginWallUrl('https://example.com/auth'));
  assert.ok(isLoginWallUrl('https://example.com/sessions/new'));
  assert.ok(isLoginWallUrl('https://example.com/account/login'));
});

test('matches login segment in the middle of a longer path', () => {
  assert.ok(isLoginWallUrl('https://example.com/oauth/login'));
  assert.ok(isLoginWallUrl('https://example.com/users/login?return_to=/'));
});

test('does not match non-login paths', () => {
  assert.strictEqual(isLoginWallUrl('https://example.com/'), false);
  assert.strictEqual(isLoginWallUrl('https://example.com/dashboard'), false);
  assert.strictEqual(isLoginWallUrl('https://example.com/api/messages'), false);
  // Substring of a longer segment — should not match (the regex requires
  // /login as a whole segment, not as a prefix of "/loginhelp").
  assert.strictEqual(isLoginWallUrl('https://example.com/loginhelp'), false);
});

test('handles empty or missing input', () => {
  assert.strictEqual(isLoginWallUrl(''), false);
  assert.strictEqual(isLoginWallUrl(undefined), false);
  assert.strictEqual(isLoginWallUrl(null), false);
});
