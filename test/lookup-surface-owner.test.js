import test from 'node:test';
import assert from 'node:assert/strict';

const { detectLookupEmbeddedInPrereq } = await import('../dist/gate/save-warnings.js');
const { validateLookupPrereqsAreCapabilities, validateNameJustification } =
  await import('../dist/gate/save-audit.js');
const { isLookupSurfaceOwnerCapability } = await import('../dist/gate/save-audit-lookup.js');
const { capabilityNameJustificationClassifier } =
  await import('../dist/audit/lift/save-strategy-classifiers.js');

function lookupPageScript() {
  return {
    strategy: 'page-script',
    baseUrl: 'https://example.test',
    response: { from: 'search_result', format: 'json' },
    prerequisites: [
      {
        name: 'search_result',
        kind: 'js-eval',
        url: 'https://example.test/maps/search/{{query}}+{{location}}',
        expression: 'document.querySelectorAll("[role=article]").length',
        binds: 'search_result',
        return_shape: { kind: 'number' },
      },
    ],
    notes: {
      params: {
        query: { kind: 'text', example: 'coffee' },
        location: { kind: 'text', example: 'Stockholm' },
      },
    },
  };
}

test('canonical retrieval capabilities may own a /search js-eval surface', () => {
  for (const capability of [
    'search_places',
    'lookup_place_by_name',
    'list_places',
    'place_search',
  ]) {
    assert.deepEqual(
      detectLookupEmbeddedInPrereq(lookupPageScript(), capability),
      [],
      `${capability} should own its lookup surface`,
    );
  }
});

test('retrieval-family matching is segment-boundary based', () => {
  for (const capability of [
    'search_places',
    'lookup_place_by_name',
    'list_places',
    'place_search',
  ]) {
    assert.equal(isLookupSurfaceOwnerCapability(capability), true);
  }
  for (const capability of ['search', 'lookup', 'list', 'research_places', 'get_place_by_name']) {
    assert.equal(isLookupSurfaceOwnerCapability(capability), false);
  }

  const warnings = detectLookupEmbeddedInPrereq(lookupPageScript(), 'research_places');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'lookup_embedded_in_prereq');
});

test('downstream capabilities must compose through a saved retrieval capability', () => {
  const warnings = detectLookupEmbeddedInPrereq(lookupPageScript(), 'get_place_contacts');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'lookup_embedded_in_prereq');
  assert.match(warnings[0].hint, /capability: prereq/);
});

test('all save-audit lookup layers exempt the retrieval capability itself', () => {
  const strategy = lookupPageScript();
  assert.deepEqual(validateNameJustification('lookup_place_by_name', strategy), []);
  assert.deepEqual(
    capabilityNameJustificationClassifier.buildItems(strategy, {
      capability: 'lookup_place_by_name',
    }),
    [],
  );

  const fetchExtractStrategy = {
    ...strategy,
    prerequisites: [
      {
        name: 'search_result',
        kind: 'fetch-extract',
        url: 'https://example.test/api/places/search?q={{query}}',
        vars: { search_result: '' },
      },
    ],
  };
  const captured = new Set(['https://example.test/api/places/search']);
  assert.deepEqual(
    validateLookupPrereqsAreCapabilities('lookup_place_by_name', fetchExtractStrategy, captured),
    [],
  );
  assert.equal(
    validateLookupPrereqsAreCapabilities('get_place_by_name', fetchExtractStrategy, captured)
      .length,
    1,
  );
});
