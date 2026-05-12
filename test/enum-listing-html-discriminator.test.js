// `detectEnumParamListingUnfactored` looks at captured intercepted requests
// and flags ones whose response body contains every observed enum value —
// suggesting a "save as a sibling list_<entity> capability" rewrite.
//
// Before the fix the body-substring check matched on raw HTML attribute
// content too: a homepage with `data-category="italian"` etc. got flagged as
// the listing endpoint, even though it's a UI page, not a JSON listing the
// agent could meaningfully save as a `list_<entity>` capability. This left
// agents in a catch-22 (warning demands listing, no real listing exists,
// warning is ackable but adds round-trips).
//
// The discriminator: a real listing endpoint returns a JSON object/array;
// the homepage returns HTML. `bodyAsString` upstream JSON.stringifies object
// bodies, so checking `body.trimStart().startsWith('{' | '[')` cleanly
// separates the two. These tests pin that distinction.

import test from 'node:test';
import assert from 'node:assert';

const saveWarnings = await import('../dist/gate/save-warnings.js');
const { detectEnumParamListingUnfactored } = saveWarnings;

function makeStrategy() {
  return {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/api/restaurants?category={{cuisine}}',
    notes: {
      params: {
        cuisine: {
          kind: 'enum',
          observed_values: [
            { value: 'italian', label: 'Italian' },
            { value: 'sushi', label: 'Sushi' },
            { value: 'mexican', label: 'Mexican' },
          ],
        },
      },
    },
  };
}

const JSON_LISTING = {
  method: 'GET',
  url: 'http://example.test/api/categories',
  responseBody: {
    categories: [
      { value: 'italian', label: 'Italian' },
      { value: 'sushi', label: 'Sushi' },
      { value: 'mexican', label: 'Mexican' },
    ],
  },
};

const HTML_HOMEPAGE = {
  method: 'GET',
  url: 'http://example.test/',
  responseBody:
    '<!doctype html><html><body>' +
    '<a href="/top-restaurants?category=italian" data-category="italian">Italian</a>' +
    '<a href="/top-restaurants?category=sushi" data-category="sushi">Sushi</a>' +
    '<a href="/top-restaurants?category=mexican" data-category="mexican">Mexican</a>' +
    '</body></html>',
};

test('listing detector fires on a JSON listing response', () => {
  const warnings = detectEnumParamListingUnfactored(
    makeStrategy(),
    { intercepted: [JSON_LISTING] },
    'find_top_restaurants',
    undefined,
    undefined,
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'enum_param_listing_unfactored');
  assert.match(warnings[0].message, /api\/categories/);
});

test('listing detector does NOT fire on an HTML page that contains the values as attributes', () => {
  const warnings = detectEnumParamListingUnfactored(
    makeStrategy(),
    { intercepted: [HTML_HOMEPAGE] },
    'find_top_restaurants',
    undefined,
    undefined,
  );
  assert.equal(
    warnings.length,
    0,
    `HTML attribute matches should not be treated as a listing endpoint, ` +
      `got: ${JSON.stringify(warnings)}`,
  );
});

test('with both an HTML page and a JSON listing captured, only the JSON one is flagged', () => {
  const warnings = detectEnumParamListingUnfactored(
    makeStrategy(),
    { intercepted: [HTML_HOMEPAGE, JSON_LISTING] },
    'find_top_restaurants',
    undefined,
    undefined,
  );
  // Exactly one warning, and it names the JSON listing — not the HTML
  // homepage. The captured "http://example.test/" homepage must not appear
  // as a flagged listing target.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /api\/categories/);
  assert.doesNotMatch(warnings[0].message, /captured http:\/\/example\.test\/ whose/);
});

test('JSON array (not object) listing is also detected', () => {
  const arrayListing = {
    method: 'GET',
    url: 'http://example.test/api/cuisines',
    responseBody: [
      { value: 'italian' },
      { value: 'sushi' },
      { value: 'mexican' },
    ],
  };
  const warnings = detectEnumParamListingUnfactored(
    makeStrategy(),
    { intercepted: [arrayListing] },
    'find_top_restaurants',
    undefined,
    undefined,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /api\/cuisines/);
});

test('plain-text response that happens to contain the values is not treated as a listing', () => {
  const plainText = {
    method: 'GET',
    url: 'http://example.test/notes.txt',
    responseBody: 'today we feature: italian, sushi, mexican specials',
  };
  const warnings = detectEnumParamListingUnfactored(
    makeStrategy(),
    { intercepted: [plainText] },
    'find_top_restaurants',
    undefined,
    undefined,
  );
  assert.equal(warnings.length, 0);
});
