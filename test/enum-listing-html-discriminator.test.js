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

test('C1: single-value enum does NOT fire — a real enum needs ≥2 distinct observed values', () => {
  // The repro from llm-tests/search-enforcement v7b: agent classified the
  // message body param as kind:"enum" with a single observed value (the
  // user-typed text). Pre-C1, the listing detector then matched that single
  // value against ANY captured response containing the substring (including
  // the chat-history endpoint that echoes the just-sent message), producing
  // a false listing flag. The structural fix: a listing factor needs ≥2
  // distinct values; on length 1 the detector can't tell "real enum
  // candidate" from "free-form text that happens to be observable in some
  // response."
  const strategy = makeStrategy();
  strategy.notes.params.cuisine.observed_values = [{ value: 'italian', label: 'Italian' }];
  const warnings = detectEnumParamListingUnfactored(
    strategy,
    { intercepted: [JSON_LISTING] },
    'find_top_restaurants',
    undefined,
    undefined,
  );
  assert.deepEqual(
    warnings,
    [],
    'single-value enum must not trigger the listing detector — got: ' + JSON.stringify(warnings),
  );
});

test('C2: caller-declared arg value filtered before counting (would otherwise be ≥2 → fires)', () => {
  // The 2-value edge case C2 closes: agent typed "pizza" as a recipe filter
  // AND clicked "italian" on the cuisine tile. observed_values gets both
  // entries. C1 alone would count 2 → fire (listing detected, "italian" is
  // in the response, "pizza" is — coincidentally — also in the response
  // because the listing names some pizza variant). Caller-typed "pizza" must
  // be dropped before the listing match runs, leaving only ["italian"] —
  // length 1, C1 skips. The agent's `declaredCapabilities.args.cuisine =
  // "pizza"` carries that signal: the value originated in the caller, not
  // from a server enumeration.
  const strategy = makeStrategy();
  strategy.notes.params.cuisine.observed_values = [
    { value: 'italian', label: 'Italian' },
    { value: 'pizza', label: 'Pizza' }, // caller-typed
  ];
  const sessionWithCallerArg = {
    intercepted: [
      {
        method: 'GET',
        url: 'http://example.test/api/categories',
        responseBody: {
          // The listing happens to contain both values — pre-C2 this would
          // fire; C2 drops "pizza" first because the caller declared it.
          categories: [
            { value: 'italian', label: 'Italian' },
            { value: 'pizza', label: 'Pizza' },
          ],
        },
      },
    ],
    declaredCapabilities: [
      {
        capability: 'find_top_restaurants',
        args: { cuisine: 'pizza' },
        declared_at: 1_000_000,
      },
    ],
  };
  const warnings = detectEnumParamListingUnfactored(
    strategy,
    sessionWithCallerArg,
    'find_top_restaurants',
    undefined,
    undefined,
  );
  assert.deepEqual(
    warnings,
    [],
    'caller-declared value must be filtered before the C1 ≥2 count — got: ' +
      JSON.stringify(warnings),
  );
});

test('C2: real 2-value enum (neither caller-declared) still fires', () => {
  // Negative case: when both observed values come from real clicks and
  // neither matches a caller arg, the detector fires as before. This pins
  // that C2 doesn't break the legitimate listing-factor signal.
  const strategy = makeStrategy();
  strategy.notes.params.cuisine.observed_values = [
    { value: 'italian', label: 'Italian' },
    { value: 'sushi', label: 'Sushi' },
  ];
  const session = {
    intercepted: [JSON_LISTING],
    declaredCapabilities: [
      {
        capability: 'find_top_restaurants',
        args: { other_arg: 'mexican' }, // declared, but for a different param
        declared_at: 1_000_000,
      },
    ],
  };
  const warnings = detectEnumParamListingUnfactored(
    strategy,
    session,
    'find_top_restaurants',
    undefined,
    undefined,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /api\/categories/);
});

test('hint names the structural remedy without advertising an ack path that policy denies', () => {
  // The detector at the audit layer has ackReason: 'none' (no ack-through —
  // the listing belongs as its own capability, period). Earlier the hint
  // ended with `ack via save_warnings_acked: [{...}]`, sending the agent
  // off to construct an ack the audit would then refuse. Live trace (v7b
  // llm-tests/search-enforcement/fresh-discovery): agent followed the hint,
  // burned 20 rounds. The hint must name the structural remedy only.
  const warnings = detectEnumParamListingUnfactored(
    makeStrategy(),
    { intercepted: [JSON_LISTING] },
    'find_top_restaurants',
    undefined,
    undefined,
  );
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0].hint, /save_warnings_acked/);
  // No imperative ack instruction. The old hint ended with "ack via ..." or
  // "ack this warning ..."; either form steers the agent at a slot the
  // detector's ackReason: 'none' will then refuse.
  assert.doesNotMatch(warnings[0].hint, /\back via\b/i);
  assert.doesNotMatch(warnings[0].hint, /\back this warning\b/i);
  assert.match(warnings[0].hint, /no ack path/);
  // Real remedy still surfaced: "save listing as its own capability".
  assert.match(warnings[0].hint, /save_strategy on .+ as its own capability/);
});
