// Unit tests for the endpoint_collides_with_saved_capability detector
// (runtime/src/gate/save-warnings.ts:detectEndpointCollidesWithSavedCapability)
// and its registration on the save-strategy audit.
//
// Pinned behavior:
//   - Same canonical endpoint + same HTTP method  → fires (unackable).
//   - Same canonical endpoint + different method   → no fire.
//   - Different endpoint                           → no fire.
//   - Rejection message inlines the existing capability's shape
//     (name, tier, endpoint, args, observed_values, example).

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
  // Hints that this is unackable
  assert.match(issues[0].hint, /unackable|no "save anyway"/i);
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

test('canonicalizes URL — query strings and trailing slashes ignored', () => {
  const incoming = strategy({
    endpoint: '/api/restaurants?category={{cuisine}}',
    method: 'GET',
  });
  const existing = strategy({
    endpoint: '/api/restaurants/',
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
