// An exact `key={{x}}` query value may disappear only when notes.params
// explicitly declares x optional. Required and embedded refs remain loud.
// Exercised through prepareRequest, which calls the shared URL resolver.

import test from 'node:test';
import assert from 'node:assert/strict';

const { prepareRequest, resolveBrowserPrereqStep, resolveHeaders, resolveUrlTemplate } =
  await import('../dist/execution/vars.js');

function url(endpoint, args, extra = {}) {
  return prepareRequest({ baseUrl: 'https://api.example.com', endpoint, ...extra }, args).url;
}

function notes(params) {
  return { notes: { params } };
}

test('omitted optional query param is dropped (no literal {{}} left)', () => {
  const u = url(
    '/search?cuisine={{cuisine}}',
    {},
    notes({ cuisine: { kind: 'text', optional: true } }),
  );
  assert.equal(u, 'https://api.example.com/search');
  assert.doesNotMatch(u, /\{\{/);
  assert.doesNotMatch(u, /cuisine/);
});

test('empty-string optional query param is dropped', () => {
  const u = url(
    '/search?cuisine={{cuisine}}',
    { cuisine: '' },
    notes({ cuisine: { kind: 'text', optional: true } }),
  );
  assert.equal(u, 'https://api.example.com/search');
});

test('present optional query param is kept and encoded', () => {
  assert.equal(
    url(
      '/search?cuisine={{cuisine}}',
      { cuisine: 'thai food' },
      notes({ cuisine: { kind: 'text', optional: true } }),
    ),
    'https://api.example.com/search?cuisine=thai%20food',
  );
});

test('required param kept, optional dropped, in the same query', () => {
  assert.equal(
    url(
      '/search?q={{q}}&cuisine={{cuisine}}',
      { q: 'pizza', cuisine: '' },
      notes({
        q: { kind: 'text' },
        cuisine: { kind: 'text', optional: true },
      }),
    ),
    'https://api.example.com/search?q=pizza',
  );
});

test('static query params are always preserved', () => {
  assert.equal(
    url(
      '/search?format=json&cuisine={{cuisine}}',
      {},
      notes({ cuisine: { kind: 'text', optional: true } }),
    ),
    'https://api.example.com/search?format=json',
  );
});

test('intentional static empty param (no placeholder) is preserved', () => {
  assert.equal(url('/search?flag=', {}), 'https://api.example.com/search?flag=');
});

test('missing PATH param fails before transport', () => {
  assert.throws(
    () => url('/users/{{user_id}}/orders', {}),
    /unresolved_placeholders: request URL.*\{\{user_id\}\}.*request not sent/,
  );
});

test('missing REST-style path params fail before transport', () => {
  assert.throws(
    () => url('/users/:user_id/orders', {}),
    /unresolved_placeholders: request URL.*\{\{user_id\}\}.*request not sent/,
  );
});

test('an omitted optional REST-style query value is dropped', () => {
  assert.equal(
    url('/search?cursor=:cursor', {}, notes({ cursor: { kind: 'id', optional: true } })),
    'https://api.example.com/search',
  );
});

test('REST-style params match a complete name without prefix collisions', () => {
  assert.equal(
    url('/users/:identifier', { id: '123', identifier: 'abc' }),
    'https://api.example.com/users/abc',
  );
  assert.equal(
    url('/users/:identifier.json', { identifier: 'abc' }),
    'https://api.example.com/users/abc.json',
  );
  assert.throws(
    () => url('/users/:identifier', { id: '123' }),
    /unresolved_placeholders: request URL.*\{\{identifier\}\}/,
  );
});

test('a whole-value URL placeholder preserves its URL structure', () => {
  const target = 'https://example.com/entities/view?id=first&mode=full';
  assert.equal(
    resolveUrlTemplate('{{target_url}}', { target_url: target }, new Set(), 'URL'),
    target,
  );
});

test('all-optional query dropping leaves a clean path (no trailing ?)', () => {
  assert.equal(
    url(
      '/search?a={{a}}&b={{b}}',
      {},
      notes({
        a: { kind: 'text', optional: true },
        b: { kind: 'text', optional: true },
      }),
    ),
    'https://api.example.com/search',
  );
});

test('paramDocSchema accepts optional:true and rejects non-boolean', async () => {
  const { notesParamsSchema } = await import('../dist/strategies/schemas/notes.js');
  // optional:true validates
  assert.equal(
    notesParamsSchema.safeParse({ cuisine: { kind: 'text', optional: true } }).success,
    true,
  );
  // optional defaults to absent (required) — omitting it still validates
  assert.equal(notesParamsSchema.safeParse({ cuisine: { kind: 'text' } }).success, true);
  // non-boolean optional rejects
  assert.equal(
    notesParamsSchema.safeParse({ cuisine: { kind: 'text', optional: 'yes' } }).success,
    false,
  );
});

test('omitted optional whole-value body and header fields are removed structurally', () => {
  const strategy = {
    baseUrl: 'https://api.example.com',
    endpoint: '/search',
    method: 'POST',
    body: { query: '{{query}}', cursor: '{{cursor}}' },
    headers: { 'X-Query': '{{query}}', 'X-Cursor': '{{cursor}}' },
    notes: {
      params: {
        query: { kind: 'text' },
        cursor: { kind: 'id', optional: true },
      },
    },
  };
  const args = { query: 'books' };
  const prepared = prepareRequest(strategy, args);
  assert.deepEqual(prepared.bodyObj, { query: 'books' });
  assert.deepEqual(resolveHeaders(strategy.headers, args, new Set(['cursor'])), {
    'X-Query': 'books',
  });
});

test('an exact nested path from an omitted optional structured input is removed', () => {
  const strategy = {
    baseUrl: 'https://api.example.com',
    endpoint: '/search?query={{searches.0}}',
    method: 'POST',
    body: { query: '{{searches.0}}', limit: 3 },
    headers: { 'X-Query': '{{searches.0}}' },
    notes: {
      params: {
        searches: { kind: 'array', optional: true },
      },
    },
  };
  const prepared = prepareRequest(strategy, {});
  assert.equal(prepared.url, 'https://api.example.com/search');
  assert.deepEqual(prepared.bodyObj, { limit: 3 });
  assert.deepEqual(resolveHeaders(strategy.headers, {}, new Set(['searches'])), {});
});

test('an exact nested path from an explicitly empty optional array is removed', () => {
  const strategy = {
    baseUrl: 'https://api.example.com',
    endpoint: '/search?query={{searches.0}}',
    method: 'POST',
    body: { query: '{{searches.0}}', limit: 3 },
    headers: { 'X-Query': '{{searches.0}}' },
    notes: {
      params: {
        searches: { kind: 'array', optional: true },
      },
    },
  };
  const args = { searches: [] };
  const prepared = prepareRequest(strategy, args);
  assert.equal(prepared.url, 'https://api.example.com/search');
  assert.deepEqual(prepared.bodyObj, { limit: 3 });
  assert.deepEqual(resolveHeaders(strategy.headers, args, new Set(['searches'])), {});
});

test('an exact nested path from an explicitly empty optional object is removed', () => {
  const strategy = {
    baseUrl: 'https://api.example.com',
    endpoint: '/search?scope={{filter.scope}}',
    method: 'POST',
    body: { scope: '{{filter.scope}}', limit: 3 },
    notes: {
      params: {
        filter: { kind: 'object', optional: true },
      },
    },
  };
  const args = { filter: {} };
  const prepared = prepareRequest(strategy, args);
  assert.equal(prepared.url, 'https://api.example.com/search');
  assert.deepEqual(prepared.bodyObj, { limit: 3 });
});

test('an omitted optional embedded placeholder fails instead of changing meaning', () => {
  assert.throws(
    () =>
      prepareRequest(
        {
          baseUrl: 'https://api.example.com',
          endpoint: '/search',
          method: 'POST',
          body: { cursor_clause: 'after:{{cursor}}' },
          notes: { params: { cursor: { kind: 'id', optional: true } } },
        },
        {},
      ),
    /unresolved_placeholders: request body.*\{\{cursor\}\}.*request not sent/,
  );
});

test('missing required query refs fail instead of disappearing', () => {
  assert.throws(
    () => url('/search?cursor={{cursor}}', {}),
    /unresolved_placeholders: request URL.*\{\{cursor\}\}.*request not sent/,
  );
});

test('embedded optional query refs fail instead of becoming partial values', () => {
  assert.throws(
    () =>
      url('/search?cursor=after:{{cursor}}', {}, notes({ cursor: { kind: 'id', optional: true } })),
    /unresolved_placeholders: request URL.*\{\{cursor\}\}.*request not sent/,
  );
});

test('required null and empty query refs fail consistently', () => {
  for (const value of [null, '']) {
    assert.throws(
      () => url('/search?query={{query}}', { query: value }, notes({ query: { kind: 'text' } })),
      /unresolved_placeholders: request URL.*\{\{query\}\}.*request not sent/,
    );
  }
});

test('optional null and empty body/header refs are omitted consistently', () => {
  const strategy = {
    baseUrl: 'https://api.example.com',
    endpoint: '/search',
    method: 'POST',
    body: { cursor: '{{cursor}}' },
    headers: { 'X-Cursor': '{{cursor}}' },
    ...notes({ cursor: { kind: 'id', optional: true } }),
  };
  for (const cursor of [null, '']) {
    const args = { cursor };
    assert.deepEqual(prepareRequest(strategy, args).bodyObj, {});
    assert.deepEqual(resolveHeaders(strategy.headers, args, new Set(['cursor'])), {});
  }
});

test('optional array elements fail instead of shifting positional meaning', () => {
  assert.throws(
    () =>
      prepareRequest(
        {
          baseUrl: 'https://api.example.com',
          endpoint: '/batch',
          method: 'POST',
          body: { values: ['first', '{{cursor}}', 'third'] },
          ...notes({ cursor: { kind: 'id', optional: true } }),
        },
        {},
      ),
    /unresolved_placeholders: request body.*\{\{cursor\}\}/,
  );
});

test('optional prerequisite query refs use the same exact-value omission rule', () => {
  const resolved = resolveBrowserPrereqStep(
    {
      action: 'navigate',
      url: 'https://api.example.com/bootstrap?cursor={{cursor}}',
    },
    {},
    new Set(['cursor']),
  );
  assert.equal(resolved.url, 'https://api.example.com/bootstrap');
  assert.throws(
    () =>
      resolveBrowserPrereqStep(
        {
          action: 'navigate',
          url: 'https://api.example.com/bootstrap?cursor=after:{{cursor}}',
        },
        {},
        new Set(['cursor']),
      ),
    /unresolved_placeholders: browser prerequisite url.*\{\{cursor\}\}/,
  );
});
