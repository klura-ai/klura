// discovered_from_url is stamped from evidence (the Referer of the captured
// request that fired the strategy's own endpoint) rather than from whatever page
// the browser sits on at save time — which is frequently a post-submit redirect
// landing, the start_session URL, or a templated-path instance, none of which a
// later resume / auth-probe can usefully re-open.

import test from 'node:test';
import assert from 'node:assert/strict';

const { discoveredFromUrlForStrategy, refererFromHeaders } = await import(
  '../dist/tools/save-strategy.js'
);

test('refererFromHeaders: case-insensitive, http(s) only', () => {
  assert.equal(refererFromHeaders({ Referer: 'https://x.test/form' }), 'https://x.test/form');
  assert.equal(refererFromHeaders({ referer: 'http://x.test/p' }), 'http://x.test/p');
  assert.equal(refererFromHeaders({ referer: 'about:blank' }), undefined);
  assert.equal(refererFromHeaders({}), undefined);
  assert.equal(refererFromHeaders(undefined), undefined);
});

test('form-POST: prefers the form page Referer over the post-submit landing', () => {
  // The bug: at save time the browser is on /thanks?id=1 (the redirect landing).
  // The captured POST /submit carries Referer = the form page (/).
  const strategy = { strategy: 'fetch', baseUrl: 'http://site.test', endpoint: '/submit' };
  const intercepted = [
    { url: 'http://site.test/submit', headers: { Referer: 'http://site.test/' } },
    { url: 'http://site.test/thanks?id=1', headers: { Referer: 'http://site.test/submit' } },
  ];
  assert.equal(discoveredFromUrlForStrategy(strategy, intercepted), 'http://site.test/');
});

test('templated endpoint: matches on the static path prefix before {{token}}', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'http://chat.test',
    endpoint: '/api/conversations/{{member_id}}/messages',
  };
  const intercepted = [
    { url: 'http://chat.test/api/members/search?query=Adam', headers: { Referer: 'http://chat.test/' } },
    { url: 'http://chat.test/api/conversations/93210/messages', headers: { Referer: 'http://chat.test/chat/adam' } },
  ];
  assert.equal(discoveredFromUrlForStrategy(strategy, intercepted), 'http://chat.test/chat/adam');
});

test('no matching captured request → undefined (caller falls back to current URL)', () => {
  const strategy = { strategy: 'fetch', baseUrl: 'http://site.test', endpoint: '/submit' };
  const intercepted = [{ url: 'http://other.test/submit', headers: { Referer: 'http://other.test/' } }];
  assert.equal(discoveredFromUrlForStrategy(strategy, intercepted), undefined);
});

test('matching capture but no usable Referer → undefined', () => {
  const strategy = { strategy: 'fetch', baseUrl: 'http://site.test', endpoint: '/submit' };
  const intercepted = [{ url: 'http://site.test/submit', headers: {} }];
  assert.equal(discoveredFromUrlForStrategy(strategy, intercepted), undefined);
});

test('missing baseUrl/endpoint → undefined, no throw', () => {
  assert.equal(discoveredFromUrlForStrategy({ strategy: 'recorded-path' }, []), undefined);
  assert.equal(discoveredFromUrlForStrategy({ baseUrl: 'http://x.test' }, []), undefined);
});

test('query-string on endpoint is ignored for matching', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'http://api.test',
    endpoint: '/search?q={{query}}',
  };
  const intercepted = [
    { url: 'http://api.test/search?q=thai', headers: { Referer: 'http://api.test/browse' } },
  ];
  assert.equal(discoveredFromUrlForStrategy(strategy, intercepted), 'http://api.test/browse');
});
