// `notes.params.X.source: "capability:Y"` declares that X's allowed values
// come from a saved sibling capability Y. The runtime resolves prereqs by
// walking `prerequisites[]`; if the parent strategy doesn't include a
// matching `{kind: "capability", capability: Y, ...}` entry the source
// declaration is dead code — at warm-execute time the listing never
// fetches and the enum-grounding promise breaks silently.
//
// Surfaced live in v4 llm-tests/dynamic-enum/fresh-discovery — agent saved
// the parent + the listing capability separately, declared the source
// correctly, but forgot the matching prereq. The audit accepted the save.
// This detector closes that gap with ackReason: 'none' — there's no
// legitimate reason to leave a dangling declaration.

import test from 'node:test';
import assert from 'node:assert';

const saveWarnings = await import('../dist/gate/save-warnings.js');
const { detectCapabilitySourceMissingPrereq } = saveWarnings;

test('source: capability:Y + matching prereq → no warning', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    endpoint: '/api/restaurants?category={{cuisine}}',
    prerequisites: [
      {
        kind: 'capability',
        capability: 'list_restaurant_categories',
        args: {},
        vars: { categories: 'data[*].value' },
      },
    ],
    notes: {
      params: {
        cuisine: {
          kind: 'enum',
          source: 'capability:list_restaurant_categories',
        },
      },
    },
  };
  assert.deepEqual(detectCapabilitySourceMissingPrereq(strategy), []);
});

test('source: capability:Y without any prereq → warning fires (the dynamic-enum #12 repro)', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    endpoint: '/api/restaurants?category={{cuisine}}',
    // No prerequisites field at all.
    notes: {
      params: {
        cuisine: {
          kind: 'enum',
          source: 'capability:list_restaurant_categories',
        },
      },
    },
  };
  const warnings = detectCapabilitySourceMissingPrereq(strategy);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'capability_source_missing_prereq');
  assert.match(warnings[0].message, /list_restaurant_categories/);
  assert.match(warnings[0].message, /cosmetic/);
});

test('source: capability:Y + prereq pointing at DIFFERENT capability → warning fires', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    endpoint: '/api/x?p={{p}}',
    prerequisites: [
      { kind: 'capability', capability: 'something_else', args: {}, vars: {} },
    ],
    notes: { params: { p: { source: 'capability:list_p_values' } } },
  };
  const warnings = detectCapabilitySourceMissingPrereq(strategy);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /list_p_values/);
});

test('prereq with kind: capability but no source declaration → no warning (other direction is fine)', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    endpoint: '/api/x?p={{p}}',
    prerequisites: [
      { kind: 'capability', capability: 'lookup_p', args: {}, vars: { p_id: 'data.id' } },
    ],
    notes: { params: { p: { kind: 'text' } } }, // no source — totally allowed
  };
  assert.deepEqual(detectCapabilitySourceMissingPrereq(strategy), []);
});

test('multiple source declarations, only one missing prereq → only the orphan warns', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    endpoint: '/api/search',
    body: { category: '{{cat}}', author: '{{auth}}' },
    prerequisites: [
      // lookup_authors prereq present ↔ params.auth.source paired
      { kind: 'capability', capability: 'lookup_authors', args: {}, vars: {} },
      // list_categories prereq MISSING ↔ params.cat.source orphan
    ],
    notes: {
      params: {
        cat: { source: 'capability:list_categories' }, // ORPHAN
        auth: { source: 'capability:lookup_authors' }, // OK
      },
    },
  };
  const warnings = detectCapabilitySourceMissingPrereq(strategy);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /list_categories/);
  assert.doesNotMatch(warnings[0].message, /lookup_authors/);
});

test('source: not-capability prefix → no warning (only capability: sources are paired)', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    endpoint: '/api/x?p={{p}}',
    notes: { params: { p: { source: 'observed_values' } } }, // not a capability source
  };
  assert.deepEqual(detectCapabilitySourceMissingPrereq(strategy), []);
});

test('source: capability: with empty slug → no warning (malformed, ignored)', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    endpoint: '/api/x?p={{p}}',
    notes: { params: { p: { source: 'capability:' } } }, // empty slug
  };
  assert.deepEqual(detectCapabilitySourceMissingPrereq(strategy), []);
});

test('no notes.params at all → no warning', () => {
  const strategy = { strategy: 'fetch', method: 'GET', endpoint: '/api/x' };
  assert.deepEqual(detectCapabilitySourceMissingPrereq(strategy), []);
});
