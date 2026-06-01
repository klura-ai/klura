// Unit tests for the per-session lookup-candidate accumulator.

import test from 'node:test';
import assert from 'node:assert';

const {
  recordLookupCandidate,
  findCandidatesForLiteral,
  getAllCandidates,
  getCandidateCount,
  clearForSession,
  _resetForTests,
  deriveLinkUrlObservations,
  harvestLinkUrlObservations,
  getAllParamObservations,
} = await import('../dist/response/session-observations.js');

function candidate(overrides = {}) {
  return {
    request_i: 0,
    url: 'https://www.example.com/search',
    method: 'GET',
    input_shape: { query_keys: ['q'] },
    output_shape: {
      response_format: 'json',
      has_array_of_objects: true,
      id_fields: [{ field_path: 'data.0.id', value_shape: '10+ digit numeric id', sample_value: '156025504001094' }],
    },
    looks_like_lookup: true,
    lookup_confidence: 0.8,
    ...overrides,
  };
}

test('recordLookupCandidate: records a looks_like_lookup candidate', () => {
  _resetForTests();
  recordLookupCandidate('s1', candidate());
  assert.strictEqual(getCandidateCount('s1'), 1);
});

test('recordLookupCandidate: records non-lookup candidates with id_fields (for literal matching)', () => {
  _resetForTests();
  // A non-lookup candidate whose response still contains ids we might
  // need to match later. We accumulate anything with id_fields since the
  // save-time literal-match tightens the filter.
  recordLookupCandidate('s1', candidate({ looks_like_lookup: false }));
  assert.strictEqual(getCandidateCount('s1'), 1);
});

test('recordLookupCandidate: drops candidates with no id_fields and no lookup signal', () => {
  _resetForTests();
  recordLookupCandidate(
    's1',
    candidate({
      looks_like_lookup: false,
      output_shape: {
        response_format: 'json',
        has_array_of_objects: false,
        id_fields: [],
      },
    }),
  );
  assert.strictEqual(getCandidateCount('s1'), 0);
});

test('recordLookupCandidate: null candidate is a no-op', () => {
  _resetForTests();
  recordLookupCandidate('s1', null);
  assert.strictEqual(getCandidateCount('s1'), 0);
});

test('recordLookupCandidate: missing sessionId is a no-op', () => {
  _resetForTests();
  recordLookupCandidate('', candidate());
  assert.strictEqual(getCandidateCount(''), 0);
});

test('recordLookupCandidate: re-recording the same request_i replaces the entry', () => {
  _resetForTests();
  recordLookupCandidate('s1', candidate({ request_i: 5, lookup_confidence: 0.4 }));
  recordLookupCandidate('s1', candidate({ request_i: 5, lookup_confidence: 0.9 }));
  const all = getAllCandidates('s1');
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].lookup_confidence, 0.9);
});

test('findCandidatesForLiteral: returns matches sorted by confidence descending', () => {
  _resetForTests();
  recordLookupCandidate(
    's1',
    candidate({
      request_i: 1,
      lookup_confidence: 0.5,
      output_shape: {
        response_format: 'json',
        has_array_of_objects: true,
        id_fields: [{ field_path: 'id', value_shape: 'numeric', sample_value: '123456789012' }],
      },
    }),
  );
  recordLookupCandidate(
    's1',
    candidate({
      request_i: 2,
      lookup_confidence: 0.9,
      output_shape: {
        response_format: 'json',
        has_array_of_objects: true,
        id_fields: [{ field_path: 'user_id', value_shape: 'numeric', sample_value: '123456789012' }],
      },
    }),
  );
  const matches = findCandidatesForLiteral('s1', '123456789012');
  assert.strictEqual(matches.length, 2);
  assert.strictEqual(matches[0].lookup_confidence, 0.9);
  assert.strictEqual(matches[1].lookup_confidence, 0.5);
});

test('findCandidatesForLiteral: empty literal returns empty', () => {
  _resetForTests();
  recordLookupCandidate('s1', candidate());
  assert.deepStrictEqual(findCandidatesForLiteral('s1', ''), []);
});

test('findCandidatesForLiteral: literal not found returns empty', () => {
  _resetForTests();
  recordLookupCandidate('s1', candidate());
  assert.deepStrictEqual(findCandidatesForLiteral('s1', 'nope'), []);
});

test('findCandidatesForLiteral: literal exact-match only (no substring)', () => {
  _resetForTests();
  recordLookupCandidate(
    's1',
    candidate({
      output_shape: {
        response_format: 'json',
        has_array_of_objects: true,
        id_fields: [{ field_path: 'id', value_shape: 'numeric', sample_value: '156025504001094' }],
      },
    }),
  );
  // Substring of the sample should NOT match
  assert.deepStrictEqual(findCandidatesForLiteral('s1', '5025504001094'), []);
  // Exact match should
  const matches = findCandidatesForLiteral('s1', '156025504001094');
  assert.strictEqual(matches.length, 1);
});

test('per-session isolation: session A does not leak into session B', () => {
  _resetForTests();
  recordLookupCandidate('s1', candidate({ request_i: 0 }));
  recordLookupCandidate('s2', candidate({ request_i: 0 }));
  assert.strictEqual(getCandidateCount('s1'), 1);
  assert.strictEqual(getCandidateCount('s2'), 1);
  clearForSession('s1');
  assert.strictEqual(getCandidateCount('s1'), 0);
  assert.strictEqual(getCandidateCount('s2'), 1);
});

test('clearForSession: clears only the named session', () => {
  _resetForTests();
  recordLookupCandidate('keep', candidate());
  recordLookupCandidate('drop', candidate());
  clearForSession('drop');
  assert.strictEqual(getCandidateCount('keep'), 1);
  assert.strictEqual(getCandidateCount('drop'), 0);
});

test('per-session cap: evicts oldest beyond 500', () => {
  _resetForTests();
  for (let i = 0; i < 520; i += 1) {
    recordLookupCandidate('s1', candidate({ request_i: i }));
  }
  assert.strictEqual(getCandidateCount('s1'), 500);
  // Oldest (request_i: 0..19) should be evicted; newest (500..519) survive
  const all = getAllCandidates('s1');
  const indices = all.map((c) => c.request_i);
  assert.ok(!indices.includes(0));
  assert.ok(!indices.includes(19));
  assert.ok(indices.includes(519));
});

// ---- deriveLinkUrlObservations (page_link source) ----

const ENUM_TREE = [
  '- document:',
  '  - heading "Hungry?" [level=1]',
  '  - link "Taste the pride of Napoli":',
  '    - /url: /top-restaurants?category=italian',
  '  - link "Taco Tuesdays":',
  '    - /url: /top-restaurants?category=mexican',
  '  - link "Fresh from the sea":',
  '    - /url: /top-restaurants?category=sushi',
  '  - link "About us":',
  '    - /url: /about',
].join('\n');

test('deriveLinkUrlObservations: harvests ?param=value from link targets with the link name as label', () => {
  const obs = deriveLinkUrlObservations(ENUM_TREE, 'http://127.0.0.1:5000/');
  const cat = obs.filter((o) => o.param_name === 'category');
  assert.equal(cat.length, 3, JSON.stringify(obs));
  const pair = (v) => cat.find((o) => o.value === v);
  assert.equal(pair('italian').source.kind, 'page_link');
  assert.equal(pair('italian').source.label, 'Taste the pride of Napoli');
  assert.equal(pair('mexican').source.label, 'Taco Tuesdays');
  // The /about link has no query → no observation.
  assert.ok(!obs.some((o) => o.value === 'about'));
});

test('deriveLinkUrlObservations: resolves relative hrefs against the base; absolute too', () => {
  const tree = [
    '- link "Rel":',
    '  - /url: /x?k=rel',
    '- link "Abs":',
    '  - /url: https://other.test/y?k=abs',
  ].join('\n');
  const obs = deriveLinkUrlObservations(tree, 'http://base.test/');
  assert.deepEqual(
    obs.map((o) => `${o.param_name}=${o.value}`).sort(),
    ['k=abs', 'k=rel'],
  );
});

test('deriveLinkUrlObservations: link with two query params → two observations', () => {
  const tree = ['- link "Both":', '  - /url: /s?a=1&b=2'].join('\n');
  const obs = deriveLinkUrlObservations(tree, 'http://base.test/');
  assert.deepEqual(obs.map((o) => `${o.param_name}=${o.value}`).sort(), ['a=1', 'b=2']);
});

test('deriveLinkUrlObservations: javascript:/fragment/relative-without-base are skipped, no crash', () => {
  const tree = [
    '- link "JS":',
    '  - /url: javascript:void(0)',
    '- link "Frag":',
    '  - /url: #section',
    '- link "Malformed name has no url child"',
  ].join('\n');
  assert.deepEqual(deriveLinkUrlObservations(tree, ''), []);
});

test('deriveLinkUrlObservations: empty / non-string tree → []', () => {
  assert.deepEqual(deriveLinkUrlObservations('', 'http://b/'), []);
  assert.deepEqual(deriveLinkUrlObservations(undefined, 'http://b/'), []);
});

test('harvestLinkUrlObservations: records page_link obs; idempotent across repeated harvests', () => {
  _resetForTests?.();
  const sid = 'sess-pagelink';
  harvestLinkUrlObservations(sid, ENUM_TREE, 'http://127.0.0.1:5000/');
  harvestLinkUrlObservations(sid, ENUM_TREE, 'http://127.0.0.1:5000/'); // again
  const all = getAllParamObservations(sid);
  assert.equal((all.category ?? []).length, 3, 'deduped to 3 distinct (value,label,kind)');
  clearForSession(sid);
});

test('harvestLinkUrlObservations: page_link + url_variance for same value both kept (distinct kinds)', () => {
  _resetForTests?.();
  const sid = 'sess-mixed';
  harvestLinkUrlObservations(sid, '- link "Italian":\n  - /url: /r?category=italian', 'http://b/');
  harvestLinkUrlObservations(sid, '- link "Mexican":\n  - /url: /r?category=mexican', 'http://b/');
  const cat = getAllParamObservations(sid).category ?? [];
  assert.equal(cat.length, 2);
  assert.ok(cat.every((o) => o.source.kind === 'page_link'));
  clearForSession(sid);
});
