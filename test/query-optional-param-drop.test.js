// Empty / omitted OPTIONAL query params drop out of the resolved URL instead
// of being left as a literal `{{x}}` (broken) or an empty `key=` the server may
// reject. A query param is droppable by construction; a path param is not.
// Exercised through prepareRequest, which calls the internal resolveEndpoint.

import test from 'node:test';
import assert from 'node:assert/strict';

const { prepareRequest } = await import('../dist/execution/vars.js');

function url(endpoint, args, extra = {}) {
  return prepareRequest({ baseUrl: 'https://api.example.com', endpoint, ...extra }, args).url;
}

test('omitted optional query param is dropped (no literal {{}} left)', () => {
  const u = url('/search?cuisine={{cuisine}}', {});
  assert.equal(u, 'https://api.example.com/search');
  assert.doesNotMatch(u, /\{\{/);
  assert.doesNotMatch(u, /cuisine/);
});

test('empty-string optional query param is dropped', () => {
  const u = url('/search?cuisine={{cuisine}}', { cuisine: '' });
  assert.equal(u, 'https://api.example.com/search');
});

test('present optional query param is kept and encoded', () => {
  assert.equal(
    url('/search?cuisine={{cuisine}}', { cuisine: 'thai food' }),
    'https://api.example.com/search?cuisine=thai%20food',
  );
});

test('required param kept, optional dropped, in the same query', () => {
  assert.equal(
    url('/search?q={{q}}&cuisine={{cuisine}}', { q: 'pizza', cuisine: '' }),
    'https://api.example.com/search?q=pizza',
  );
});

test('static query params are always preserved', () => {
  assert.equal(
    url('/search?format=json&cuisine={{cuisine}}', {}),
    'https://api.example.com/search?format=json',
  );
});

test('intentional static empty param (no placeholder) is preserved', () => {
  assert.equal(url('/search?flag=', {}), 'https://api.example.com/search?flag=');
});

test('missing PATH param stays loud (not silently dropped)', () => {
  // Path params are not droppable — a missing one leaves the unresolved token
  // in the path (percent-encoded by path-segment encoding) so the failure is
  // visible rather than producing a wrong URL.
  const u = url('/users/{{user_id}}/orders', {});
  assert.match(u, /user_id/);
  assert.notEqual(u, 'https://api.example.com/users/orders');
});

test('all-optional query dropping leaves a clean path (no trailing ?)', () => {
  assert.equal(
    url('/search?a={{a}}&b={{b}}', {}),
    'https://api.example.com/search',
  );
});
