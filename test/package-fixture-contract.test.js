import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assessPackageFixtureCoverage,
  PACKAGE_FIXTURE_COVERAGE_ISSUE_CODES,
  PACKAGE_FIXTURE_KINDS,
  packageFixtureFileName,
  parsePackageFixtureFileName,
  parsePublicPackageFixture,
  parsePublicPackageFixtureBytes,
  planPackageFixtureCoverage,
} = require('../dist/public/contracts/fixture.js');

function callFixture() {
  return {
    fixture_schema_version: 1,
    kind: 'call',
    version: '1.0.0',
    capability: 'lookup',
    input: { id: '42' },
    responses: [
      {
        strategy_id: 'lookup_request',
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          media_type: 'application/json',
          body_kind: 'json_object',
          body: { id: '42' },
          target_requests: 1,
        },
      },
    ],
    expected: { result: { id: '42' } },
    caller_bounds: null,
    input_mode_id: null,
  };
}

function runFixture() {
  const fixture = callFixture();
  fixture.kind = 'run';
  fixture.capability = 'list_items';
  fixture.caller_bounds = { max_items: 5 };
  fixture.input_mode_id = 'by_id';
  fixture.expected = { result: { stop: { kind: 'source_exhausted' } }, items: [{ id: '42' }] };
  return fixture;
}

test('call fixtures parse into their exact canonical shape', () => {
  assert.deepEqual(parsePublicPackageFixture(callFixture(), 'fixture'), callFixture());
});

test('run fixtures parse into their exact canonical shape', () => {
  assert.deepEqual(parsePublicPackageFixture(runFixture(), 'fixture'), runFixture());
});

test('fixture parsing rejects unknown keys, bad kinds, and mixed variants', () => {
  const unknownKey = callFixture();
  unknownKey.extra = true;
  assert.throws(() => parsePublicPackageFixture(unknownKey, 'fixture'), /extra: is not allowed/);

  const badKind = callFixture();
  badKind.kind = 'smoke';
  assert.throws(() => parsePublicPackageFixture(badKind, 'fixture'), /must be call or run/);

  const callWithRunValues = callFixture();
  callWithRunValues.input_mode_id = 'by_id';
  assert.throws(
    () => parsePublicPackageFixture(callWithRunValues, 'fixture'),
    /call fixtures must set caller_bounds and input_mode_id to null/,
  );

  const runWithoutItems = runFixture();
  runWithoutItems.expected = { result: {} };
  assert.throws(
    () => parsePublicPackageFixture(runWithoutItems, 'fixture'),
    /is missing required key "items"/,
  );

  const runWithBadItems = runFixture();
  runWithBadItems.expected.items = {};
  assert.throws(
    () => parsePublicPackageFixture(runWithBadItems, 'fixture'),
    /expected\.items: must be an array/,
  );
});

test('fixture parsing enforces the exact response shape', () => {
  const badStatus = callFixture();
  badStatus.responses[0].response.status = 99;
  assert.throws(() => parsePublicPackageFixture(badStatus, 'fixture'), /must be an HTTP status/);

  const badHeader = callFixture();
  badHeader.responses[0].response.headers = { 'Content-Type': 'application/json' };
  assert.throws(
    () => parsePublicPackageFixture(badHeader, 'fixture'),
    /must use lowercase string header values/,
  );

  const badBodyKind = callFixture();
  badBodyKind.responses[0].response.body_kind = 'html';
  assert.throws(
    () => parsePublicPackageFixture(badBodyKind, 'fixture'),
    /must be json_object or json_array/,
  );

  const mismatchedBody = callFixture();
  mismatchedBody.responses[0].response.body_kind = 'json_array';
  assert.throws(
    () => parsePublicPackageFixture(mismatchedBody, 'fixture'),
    /does not match body_kind/,
  );

  const badTargetRequests = callFixture();
  badTargetRequests.responses[0].response.target_requests = 0;
  assert.throws(
    () => parsePublicPackageFixture(badTargetRequests, 'fixture'),
    /must be a positive integer/,
  );

  const emptyResponses = callFixture();
  emptyResponses.responses = [];
  assert.throws(
    () => parsePublicPackageFixture(emptyResponses, 'fixture'),
    /must contain at least one response/,
  );
});

test('fixture responses carry optional selector evidence for html_selector_exists replay', () => {
  const withSelectors = callFixture();
  withSelectors.responses[0].response.selector_matches = { 'main > h1': true, '#missing': false };
  assert.deepEqual(parsePublicPackageFixture(withSelectors, 'fixture'), withSelectors);

  const emptySelectors = callFixture();
  emptySelectors.responses[0].response.selector_matches = {};
  assert.throws(
    () => parsePublicPackageFixture(emptySelectors, 'fixture'),
    /must contain at least one selector/,
  );

  const nonBoolean = callFixture();
  nonBoolean.responses[0].response.selector_matches = { 'main > h1': 'yes' };
  assert.throws(
    () => parsePublicPackageFixture(nonBoolean, 'fixture'),
    /must map every selector to a boolean/,
  );

  const notObject = callFixture();
  notObject.responses[0].response.selector_matches = ['main > h1'];
  assert.throws(() => parsePublicPackageFixture(notObject, 'fixture'), /must be an object/);

  const oversizedSelector = callFixture();
  oversizedSelector.responses[0].response.selector_matches = { ['x'.repeat(513)]: true };
  assert.throws(
    () => parsePublicPackageFixture(oversizedSelector, 'fixture'),
    /selector keys must be 1 to 512 characters/,
  );

  const tooManySelectors = callFixture();
  tooManySelectors.responses[0].response.selector_matches = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [`.selector-${index}`, true]),
  );
  assert.throws(
    () => parsePublicPackageFixture(tooManySelectors, 'fixture'),
    /must contain at most 32 selectors/,
  );
});

test('fixture bytes parse under the shared byte and depth bounds', () => {
  const parsed = parsePublicPackageFixtureBytes(
    `${JSON.stringify(callFixture(), null, 2)}\n`,
    'fixture',
  );
  assert.equal(parsed.kind, 'call');
  assert.throws(() => parsePublicPackageFixtureBytes('not json', 'fixture'), /fixture/);
});

test('fixture file names derive from fixture identifiers and kinds', () => {
  assert.equal(packageFixtureFileName('list_products', PACKAGE_FIXTURE_KINDS.run), 'list-products.run.json');
  assert.equal(packageFixtureFileName('lookup', PACKAGE_FIXTURE_KINDS.call), 'lookup.call.json');
  assert.throws(() => packageFixtureFileName('Not-An-Id', PACKAGE_FIXTURE_KINDS.call), /snake_case/);
  assert.throws(() => packageFixtureFileName('lookup', 'smoke'), /must be call or run/);
});

test('fixture file names parse into their stem and kind', () => {
  assert.deepEqual(parsePackageFixtureFileName('lookup.call.json', 'name'), {
    stem: 'lookup',
    kind: 'call',
  });
  assert.deepEqual(parsePackageFixtureFileName('search-stories.no-results.call.json', 'name'), {
    stem: 'search-stories.no-results',
    kind: 'call',
  });
  assert.deepEqual(parsePackageFixtureFileName('list-releases.run.json', 'name'), {
    stem: 'list-releases',
    kind: 'run',
  });
  assert.throws(
    () => parsePackageFixtureFileName('lookup.json', 'name'),
    /must end with \.call\.json or \.run\.json/,
  );
  assert.throws(
    () => parsePackageFixtureFileName('Lookup.call.json', 'name'),
    /lowercase dot- or hyphen-separated/,
  );
  assert.throws(
    () => parsePackageFixtureFileName('.call.json', 'name'),
    /lowercase dot- or hyphen-separated/,
  );
});

test('coverage planning requires a call fixture everywhere and a run fixture per collection', () => {
  assert.deepEqual(
    planPackageFixtureCoverage({
      list_items: { collection: { collection_schema_version: 1 } },
      lookup: { collection: null },
    }),
    [
      { capability: 'list_items', required_kinds: ['call', 'run'] },
      { capability: 'lookup', required_kinds: ['call'] },
    ],
  );
});

test('coverage assessment batches every issue in one pass', () => {
  const plan = planPackageFixtureCoverage({
    list_items: { collection: { collection_schema_version: 1 } },
    lookup: { collection: null },
  });
  assert.deepEqual(
    assessPackageFixtureCoverage(plan, [
      { capability: 'lookup', kind: 'call' },
      { capability: 'lookup', kind: 'run' },
      { capability: 'phantom', kind: 'call' },
    ]).map((issue) => ({ code: issue.code, capability: issue.capability, kind: issue.kind })),
    [
      {
        code: PACKAGE_FIXTURE_COVERAGE_ISSUE_CODES.kindNotAllowed,
        capability: 'lookup',
        kind: 'run',
      },
      {
        code: PACKAGE_FIXTURE_COVERAGE_ISSUE_CODES.unknownCapability,
        capability: 'phantom',
        kind: 'call',
      },
      {
        code: PACKAGE_FIXTURE_COVERAGE_ISSUE_CODES.missingFixture,
        capability: 'list_items',
        kind: 'call',
      },
      {
        code: PACKAGE_FIXTURE_COVERAGE_ISSUE_CODES.missingFixture,
        capability: 'list_items',
        kind: 'run',
      },
    ],
  );
  assert.deepEqual(
    assessPackageFixtureCoverage(plan, [
      { capability: 'list_items', kind: 'call' },
      { capability: 'list_items', kind: 'run' },
      { capability: 'lookup', kind: 'call' },
    ]),
    [],
  );
});
