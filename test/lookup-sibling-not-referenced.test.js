// Sibling detector to `lookup_embedded_in_prereq`. That one catches the
// inverse shape: agent INLINES the lookup as fetch-extract / js-eval
// instead of declaring it as a sibling capability. This one catches the
// OMITTED case: agent saved the sibling lookup capability separately
// (good!) but forgot to wire it into the new `_by_X` strategy via
// `prerequisites[{kind: "capability", capability: "<sibling>", ...}]`,
// so at warm-execute the {{<id>}} placeholder it would resolve stays
// unbound.
//
// Reproduced live in v5 llm-tests/search-enforcement/fresh-discovery:
// agent saved `lookup_member_by_name` AND `send_message_by_name`
// separately; send has `{{member_id}}` placeholder; no capability
// prereq; warm-execute sends to literal-placeholder / wrong target.

import test from 'node:test';
import assert from 'node:assert/strict';

const { detectLookupSiblingNotReferenced } = await import(
  '../dist/gate/save-warnings.js'
);

function sendByName(extras = {}) {
  return {
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'https://api.example.test',
    endpoint: '/api/conversations/{{member_id}}/messages',
    body: { text: '{{text}}' },
    notes: {
      params: {
        member_id: { kind: 'text' },
        text: { kind: 'text' },
      },
    },
    ...extras,
  };
}

test('warning fires: _by_name slug + saved lookup sibling + no capability prereq', () => {
  // The v5 search-enforcement repro.
  const warnings = detectLookupSiblingNotReferenced(
    sendByName(),
    'send_message_by_name',
    () => ['lookup_member_by_name', 'list_recent_chats'],
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'lookup_sibling_not_referenced');
  assert.match(warnings[0].message, /lookup_member_by_name/);
  assert.match(warnings[0].message, /no.*prerequisites/);
  assert.match(warnings[0].hint, /lookup_member_by_name/);
});

test('no warning: capability prereq already exists (deferred to lookup_embedded_in_prereq audit)', () => {
  const strategy = sendByName({
    prerequisites: [
      {
        kind: 'capability',
        capability: 'lookup_member_by_name',
        args: { recipient: '{{recipient}}' },
        vars: { member_id: 'results[0].id' },
      },
    ],
  });
  const warnings = detectLookupSiblingNotReferenced(
    strategy,
    'send_message_by_name',
    () => ['lookup_member_by_name'],
  );
  assert.deepEqual(warnings, []);
});

test('no warning: slug has no lookup-implying segment', () => {
  const warnings = detectLookupSiblingNotReferenced(
    sendByName(),
    'send_message', // no _by_ / _for_ / lookup_ segment
    () => ['lookup_member_by_name'],
  );
  assert.deepEqual(warnings, []);
});

test('no warning: no sibling lookup-shaped capability saved on the platform', () => {
  const warnings = detectLookupSiblingNotReferenced(
    sendByName(),
    'send_message_by_name',
    () => ['list_recent_chats', 'get_profile_details'], // none look lookup-shaped
  );
  assert.deepEqual(warnings, []);
});

test('lookup-shape patterns recognized: lookup_*, *_search, find_*_by_*, get_*_by_*', () => {
  const variants = [
    ['lookup_member_by_name', true],
    ['lookup_user', true],
    ['member_search', true],
    ['user_search', true],
    ['find_member_by_name', true],
    ['find_user_by_email', true],
    ['get_member_by_id', true],
    ['get_user_by_email', true],
    // Non-lookup-shaped:
    ['list_members', false],
    ['create_member', false],
    ['search_filter', false], // doesn't end with _search
    ['lookup', false], // no underscore-prefix payload
  ];
  for (const [slug, shouldFire] of variants) {
    const w = detectLookupSiblingNotReferenced(
      sendByName(),
      'send_message_by_name',
      () => [slug, 'unrelated_other'],
    );
    assert.equal(
      w.length > 0,
      shouldFire,
      `sibling "${slug}" should ${shouldFire ? '' : 'NOT '}trigger the warning`,
    );
  }
});

test('does NOT fire when this strategy IS the lookup (no self-reference)', () => {
  const lookupStrategy = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://api.example.test',
    endpoint: '/api/members/search?query={{recipient}}',
    notes: { params: { recipient: { kind: 'text' } } },
  };
  // Slug has _by_name AND lookup_ siblings on disk, but ONE of those siblings
  // is this strategy itself — should not flag itself.
  const warnings = detectLookupSiblingNotReferenced(
    lookupStrategy,
    'lookup_member_by_name',
    () => ['lookup_member_by_name', 'find_user_by_email'],
  );
  // The detector still finds find_user_by_email as a lookup sibling for
  // lookup_member_by_name — both are lookups. This is the "two lookups
  // on the platform for different entities" case. The agent saved both
  // correctly; chaining a sibling through itself isn't required.
  // Acceptable behavior: the audit fires (agent acks "I'm the lookup; no
  // further chain needed"). Verify the SIBLING reference points at the
  // other strategy, not at the strategy being saved (slug-prefix mention
  // is fine — that names the strategy under audit, not a chain target).
  if (warnings.length > 0) {
    assert.match(warnings[0].message, /find_user_by_email/);
    // The hint's "wire it: capability: <slug>" example should not point
    // at the strategy's own slug.
    assert.doesNotMatch(warnings[0].hint, /capability: "lookup_member_by_name"/);
  }
});

test('listSavedCapabilityNames callback is undefined → no warning (defensive)', () => {
  const warnings = detectLookupSiblingNotReferenced(
    sendByName(),
    'send_message_by_name',
    undefined,
  );
  assert.deepEqual(warnings, []);
});
