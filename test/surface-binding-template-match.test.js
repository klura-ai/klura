// surface_triage_missing was firing on saves whose endpoint expanded a
// templated request_pattern via notes.params.<id>.example. The bound
// surface map held the templated URL (`/channels/{id}/messages`) but
// the lookup used the expanded URL (`/channels/1412.../messages`) →
// string-equality miss → wrong rejection.
//
// lookupSurface now does template-aware unification: a `{name}` path
// segment in a bound URL matches any non-empty segment in the lookup URL.

import test from 'node:test';
import assert from 'node:assert';

const { bindUrlsToSurface, lookupSurface, urlKey } = await import(
  '../dist/phases/surface-binding.js'
);

function makeSession() {
  return { surfaceMap: undefined };
}

test('lookupSurface: exact-match path still wins (no regression)', () => {
  const s = makeSession();
  bindUrlsToSurface(s, 'messages', ['https://discord.com/api/v9/channels/1234/messages']);
  assert.strictEqual(
    lookupSurface(s, 'https://discord.com/api/v9/channels/1234/messages'),
    'messages',
  );
});

test('lookupSurface: templated pattern matches expanded URL', () => {
  const s = makeSession();
  bindUrlsToSurface(s, 'messages', ['https://discord.com/api/v9/channels/{id}/messages']);
  assert.strictEqual(
    lookupSurface(s, 'https://discord.com/api/v9/channels/1412262088631169024/messages'),
    'messages',
  );
});

test('lookupSurface: templated pattern matches even when example differs from captured', () => {
  // Session captured ?id=1234, save uses example=9999 — both unify against
  // the same template.
  const s = makeSession();
  bindUrlsToSurface(s, 'messages', [
    'https://discord.com/api/v9/channels/{id}/messages',
    'https://discord.com/api/v9/channels/1234/messages',
  ]);
  assert.strictEqual(
    lookupSurface(s, 'https://discord.com/api/v9/channels/9999/messages'),
    'messages',
  );
});

test('lookupSurface: template does NOT match cross-origin', () => {
  const s = makeSession();
  bindUrlsToSurface(s, 'messages', ['https://discord.com/api/v9/channels/{id}/messages']);
  assert.strictEqual(
    lookupSurface(s, 'https://evil.example.com/api/v9/channels/1234/messages'),
    undefined,
  );
});

test('lookupSurface: template does NOT match different segment count', () => {
  const s = makeSession();
  bindUrlsToSurface(s, 'messages', ['https://discord.com/api/v9/channels/{id}/messages']);
  assert.strictEqual(
    lookupSurface(s, 'https://discord.com/api/v9/channels/1234/messages/567'),
    undefined,
  );
  assert.strictEqual(
    lookupSurface(s, 'https://discord.com/api/v9/channels/1234'),
    undefined,
  );
});

test('lookupSurface: template does NOT match an empty segment (forces non-empty)', () => {
  const s = makeSession();
  bindUrlsToSurface(s, 'messages', ['https://discord.com/api/v9/channels/{id}/messages']);
  // A double slash collapses to two segments separated by empty in pathname
  // — should not match {id}.
  assert.strictEqual(
    lookupSurface(s, 'https://discord.com/api/v9/channels//messages'),
    undefined,
  );
});

test('lookupSurface: multiple templated keys, finds the right one', () => {
  const s = makeSession();
  bindUrlsToSurface(s, 'messages', ['https://discord.com/api/v9/channels/{id}/messages']);
  bindUrlsToSurface(s, 'members', ['https://discord.com/api/v9/guilds/{id}/members']);
  assert.strictEqual(
    lookupSurface(s, 'https://discord.com/api/v9/channels/1234/messages'),
    'messages',
  );
  assert.strictEqual(
    lookupSurface(s, 'https://discord.com/api/v9/guilds/9999/members'),
    'members',
  );
});

test('lookupSurface: literal-equal-to-template still works', () => {
  // Edge case: a pattern containing literal `{` chars that happen to be a
  // path segment of length 2 (just `{` and `}` adjacent). Should not match
  // arbitrary input because the template content is empty.
  const s = makeSession();
  bindUrlsToSurface(s, 's', ['https://x.test/{}/y']);
  assert.strictEqual(
    lookupSurface(s, 'https://x.test/anything/y'),
    undefined,
    'empty-named template should not match',
  );
  assert.strictEqual(
    lookupSurface(s, 'https://x.test/{}/y'),
    's',
    'exact literal still matches',
  );
});
