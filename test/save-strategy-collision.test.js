// Unit tests for the endpoint_collides_with_saved_capability detector
// (runtime/src/gate/save-warnings.ts:detectEndpointCollidesWithSavedCapability)
// and its registration on the save-strategy audit.
//
// Pinned behavior:
//   - Same canonical (path+query, method) + same HTTP method  → fires (ackable).
//   - Same canonical + different method                        → no fire.
//   - Different path                                           → no fire.
//   - Different static query params (GraphQL multiplexing)    → no fire —
//     the canonical key includes sorted query so /q?op=A and /q?op=B
//     diverge automatically.
//   - Same templated query param → fires (parallel-capability bake signal
//     preserved — both `/q?cat={{cat}}` saves still collide).
//   - Rejection message inlines the existing capability's shape
//     (name, tier, endpoint, args, observed_values, example).
//   - Hint surfaces the ack path for genuinely-different ops on
//     multiplexed gateways.

import test from 'node:test';
import assert from 'node:assert/strict';

const { detectEndpointCollidesWithSavedCapability } = await import(
  '../dist/gate/save-warnings.js'
);

function strategy({
  tier = 'fetch',
  baseUrl = 'http://api.example.com',
  endpoint = '/v1/list',
  method = 'GET',
  notesParams,
  exampleResponses,
} = {}) {
  const data = { strategy: tier, baseUrl, endpoint, method };
  const notes = {};
  if (notesParams) notes.params = notesParams;
  if (exampleResponses) notes.example_responses = exampleResponses;
  if (Object.keys(notes).length > 0) data.notes = notes;
  return data;
}

test('fires when endpoint + method match an existing saved capability', () => {
  const incoming = strategy({ endpoint: '/api/restaurants', method: 'GET' });
  const existing = strategy({ endpoint: '/api/restaurants', method: 'GET' });
  const issues = detectEndpointCollidesWithSavedCapability(
    incoming,
    'list_top_restaurants',
    () => [existing],
    () => ['find_top_restaurants'],
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'endpoint_collides_with_saved_capability');
  assert.match(issues[0].message, /SAVE BLOCKED/);
  assert.match(issues[0].message, /find_top_restaurants/);
});

test('does not fire when endpoint matches but method differs', () => {
  const incoming = strategy({ endpoint: '/api/resource', method: 'POST' });
  const existing = strategy({ endpoint: '/api/resource', method: 'GET' });
  const issues = detectEndpointCollidesWithSavedCapability(
    incoming,
    'create_resource',
    () => [existing],
    () => ['list_resources'],
  );
  assert.equal(issues.length, 0);
});

test('does not fire when endpoint is genuinely different', () => {
  const incoming = strategy({ endpoint: '/api/foo', method: 'GET' });
  const existing = strategy({ endpoint: '/api/bar', method: 'GET' });
  const issues = detectEndpointCollidesWithSavedCapability(
    incoming,
    'cap_a',
    () => [existing],
    () => ['cap_b'],
  );
  assert.equal(issues.length, 0);
});

test('rejection inlines existing capability params + observed values', () => {
  const incoming = strategy({ endpoint: '/api/restaurants', method: 'GET' });
  const existing = strategy({
    endpoint: '/api/restaurants',
    method: 'GET',
    notesParams: {
      cuisine: {
        kind: 'enum',
        observed_values: [
          { value: 'italian', label: 'Italian' },
          { value: 'mexican', label: 'Mexican' },
          { value: 'sushi' },
        ],
      },
    },
  });
  const issues = detectEndpointCollidesWithSavedCapability(
    incoming,
    'list_top_restaurants',
    () => [existing],
    () => ['find_top_restaurants'],
  );
  assert.equal(issues.length, 1);
  const message = issues[0].message;
  // Inlines the params line and the observed values
  assert.match(message, /cuisine: enum/);
  assert.match(message, /italian/);
  assert.match(message, /mexican/);
  assert.match(message, /sushi/);
  // Inlines the three branches (SAME / WRONG / DIFFERENT)
  assert.match(message, /SAME OPERATION/);
  assert.match(message, /STALE/);
  assert.match(message, /GENUINELY DIFFERENT/);
  // Hint surfaces the ack path for multiplexed-gateway cases.
  assert.match(issues[0].hint, /save_warnings_acked/);
  assert.match(issues[0].hint, /endpoint_collides_with_saved_capability/);
});

test('rejection inlines example_response excerpt when present', () => {
  const incoming = strategy({ endpoint: '/api/x', method: 'GET' });
  const existing = strategy({
    endpoint: '/api/x',
    method: 'GET',
    exampleResponses: [
      {
        request_args: { id: '42' },
        response_excerpt: { restaurants: [{ name: "Nonna's", rating: 4.8 }] },
      },
    ],
  });
  const issues = detectEndpointCollidesWithSavedCapability(
    incoming,
    'cap_new',
    () => [existing],
    () => ['cap_old'],
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Nonna/);
});

test('skips comparing a capability against itself', () => {
  // Re-saving the same capability under its own slug is an overwrite, not a
  // collision — must not fire.
  const incoming = strategy({ endpoint: '/api/x' });
  const existing = strategy({ endpoint: '/api/x' });
  const issues = detectEndpointCollidesWithSavedCapability(
    incoming,
    'find_x',
    () => [existing],
    () => ['find_x'],
  );
  assert.equal(issues.length, 0);
});

test('canonical drops fragment + trailing slash (no-query baseline)', () => {
  // No query on either side → templated-vs-bare path collapses, fragment
  // is dropped. Same canonical → collision fires.
  const incoming = strategy({ endpoint: '/api/restaurants#anchor', method: 'GET' });
  const existing = strategy({ endpoint: '/api/restaurants/', method: 'GET' });
  const issues = detectEndpointCollidesWithSavedCapability(
    incoming,
    'list_top_restaurants',
    () => [existing],
    () => ['find_top_restaurants'],
  );
  assert.equal(issues.length, 1);
});

test('different static query params on same path do not collide (GraphQL multiplexing)', () => {
  // Two GraphQL operations on the same /frontend/query endpoint, distinguished
  // by a static `?operationName=...`. The canonical key includes the sorted
  // query string so they diverge → no collision. Without this, every GraphQL
  // capability past the first would be hard-blocked.
  const incoming = strategy({
    endpoint: '/frontend/query?fitlocale=sv-SE&operationName=updateCurrentStore',
    method: 'POST',
  });
  const existing = strategy({
    endpoint: '/frontend/query?fitlocale=sv-SE&operationName=marketModal',
    method: 'POST',
  });
  const issues = detectEndpointCollidesWithSavedCapability(
    incoming,
    'set_current_store',
    () => [existing],
    () => ['get_product_per_store_stock'],
  );
  assert.equal(issues.length, 0);
});

test('same templated query param still collides (parallel-capability bake)', () => {
  // The canonical-key logic must NOT relax the parallel-capability case:
  // two saves of `?category={{category}}` are saving the same operation
  // with different slugs — the bake anti-pattern. Templates round-trip
  // through searchParams unchanged, so canonicals match → collision fires.
  const incoming = strategy({
    endpoint: '/api/restaurants?category={{cuisine}}',
    method: 'GET',
  });
  const existing = strategy({
    endpoint: '/api/restaurants?category={{cuisine}}',
    method: 'GET',
  });
  const issues = detectEndpointCollidesWithSavedCapability(
    incoming,
    'list_top_restaurants',
    () => [existing],
    () => ['find_top_restaurants'],
  );
  assert.equal(issues.length, 1);
});

test('canonical sorts query params so order does not affect collision', () => {
  const incoming = strategy({
    endpoint: '/q?b=2&a=1',
    method: 'GET',
  });
  const existing = strategy({
    endpoint: '/q?a=1&b=2',
    method: 'GET',
  });
  const issues = detectEndpointCollidesWithSavedCapability(
    incoming,
    'cap_a',
    () => [existing],
    () => ['cap_b'],
  );
  assert.equal(issues.length, 1);
});
