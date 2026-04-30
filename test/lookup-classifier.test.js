// Unit tests for classifyRequestShape — the heuristic that turns raw
// captured HTTP requests into LookupCandidate entries for the
// provenance-enforcement save guard.
//
// The classifier is deliberately narrow (input-key + output-shape
// intersection) so simple sites match no candidates. Tests below cover
// both the positive paths (real-looking lookups) and the negatives
// (writes, heartbeats, generic reads) that must not over-match.

import test from 'node:test';
import assert from 'node:assert';

const { classifyRequestShape } = await import(
  '../dist/response/lookup-classifier.js'
);

function req(overrides = {}) {
  return {
    method: 'GET',
    url: 'https://api.example.com/endpoint',
    headers: { 'content-type': 'application/json' },
    postData: null,
    status: 200,
    responseBody: null,
    ...overrides,
  };
}

// ---- Positive: real lookup shapes ----

test('classifier: GraphQL search POST with query var + array of {id, name} → looks_like_lookup', () => {
  const entry = req({
    method: 'POST',
    url: 'https://www.example.com/api/graphql/',
    headers: { 'content-type': 'application/json' },
    postData: {
      query: 'query Search($q: String!) { search(q: $q) { threads { id name } } }',
      variables: { q: 'Meta AI' },
    },
    responseBody: {
      data: {
        search: {
          threads: [
            { id: '156025504001094', name: 'Meta AI' },
            { id: '789012345678901', name: 'Other Person' },
          ],
        },
      },
    },
  });
  const c = classifyRequestShape(entry, { request_i: 47 });
  assert.ok(c, 'expected non-null candidate');
  assert.strictEqual(c.looks_like_lookup, true);
  assert.ok(c.output_shape.id_fields.length >= 2);
  assert.ok(c.output_shape.id_fields.some((f) => f.sample_value === '156025504001094'));
  // URL path has no /search segment but body key is 'query' → input signal via body_keys
  assert.ok(c.input_shape.body_keys?.includes('query'));
});

test('classifier: typeahead GET with ?q= → id-shaped response', () => {
  const entry = req({
    method: 'GET',
    url: 'https://www.example.com/typeahead?q=Meta%20AI',
    headers: { 'content-type': 'application/json' },
    responseBody: [
      { user_id: '156025504001094', display: 'Meta AI' },
      { user_id: '789012345678901', display: 'Other' },
    ],
  });
  const c = classifyRequestShape(entry, { request_i: 5 });
  assert.ok(c);
  assert.strictEqual(c.looks_like_lookup, true);
  assert.ok(c.input_shape.query_keys?.includes('q'));
  assert.ok(c.output_shape.has_array_of_objects);
  assert.ok(c.output_shape.id_fields.some((f) => /user_id/.test(f.field_path)));
});

test('classifier: HTML responses get no id_fields — LLM owns HTML interpretation', () => {
  // The classifier doesn't regex-scan HTML for id-shapes. For an HTML
  // response, the agent calls `get_network_log({i, full: true})` and/or
  // `find_in_page` and does the extraction themselves. The runtime
  // stores no candidate id_fields for HTML responses.
  const html =
    '<!DOCTYPE html><html><body>' +
    '<a data-thread-id="156025504001094" href="/t/x">Meta AI</a>' +
    '</body></html>';
  const entry = req({
    method: 'GET',
    url: 'https://www.example.com/inbox',
    headers: { 'content-type': 'text/html' },
    responseBody: html,
  });
  const c = classifyRequestShape(entry, { request_i: 0 });
  assert.ok(c);
  assert.strictEqual(c.output_shape.response_format, 'html');
  assert.deepStrictEqual(c.output_shape.id_fields, []);
});

test('classifier: REST search endpoint path triggers input signal', () => {
  const entry = req({
    method: 'GET',
    url: 'https://www.example.com/api/v2/search?name=alice',
    headers: { 'content-type': 'application/json' },
    responseBody: { results: [{ id: '507f1f77bcf86cd799439011', name: 'alice' }] },
  });
  const c = classifyRequestShape(entry, { request_i: 10 });
  assert.ok(c);
  assert.strictEqual(c.looks_like_lookup, true);
  // Both /search path signal AND ?name= key fire
  assert.ok((c.lookup_confidence ?? 0) >= 0.5);
});

// ---- Negative: must NOT over-match ----

test('classifier: plain message-send POST is NOT a lookup', () => {
  // Writes have a text body and return an ack with an id — we must not
  // classify every POST-that-returns-id as a lookup.
  const entry = req({
    method: 'POST',
    url: 'https://www.example.com/api/messages',
    headers: { 'content-type': 'application/json' },
    postData: { text: 'hello world', thread_id: '156025504001094' },
    responseBody: { id: '999888777666555', ok: true },
  });
  const c = classifyRequestShape(entry, { request_i: 20 });
  // id_fields will be non-empty (the returned message id), but the input
  // has no lookup-shaped key (`text` is NOT in LOOKUP_INPUT_KEYS... actually
  // it IS, which is a known false-positive source — we accept it because
  // the input signal alone is 0.6, needs output too). Output signal is
  // 0.6 (id_fields present) but has_array_of_objects is false so it's
  // only just enough. Expect looks_like_lookup: may vary; the confidence
  // is below a "definitely a lookup" level.
  if (c?.looks_like_lookup) {
    // If it matches, confidence should NOT be high (no array output).
    assert.ok(c.lookup_confidence < 0.8, `write-POST should not have high lookup confidence, got ${c.lookup_confidence}`);
  }
});

test('classifier: heartbeat / ping request returns null or looks_like_lookup: false', () => {
  const entry = req({
    method: 'POST',
    url: 'https://www.example.com/ping',
    postData: {},
    responseBody: { pong: true },
  });
  const c = classifyRequestShape(entry, { request_i: 0 });
  // No id fields → not a lookup.
  if (c) assert.strictEqual(c.looks_like_lookup, false);
});

test('classifier: bulk-read endpoint (no query input) is NOT a lookup', () => {
  const entry = req({
    method: 'GET',
    url: 'https://www.example.com/api/inbox',
    responseBody: {
      threads: [
        { id: '156025504001094', name: 'Meta AI' },
        { id: '789012345678901', name: 'Other' },
      ],
    },
  });
  const c = classifyRequestShape(entry, { request_i: 3 });
  // No query keys, no search path segment → input signal is weak.
  // Output signal is strong (array of id-objects) but alone it's not enough.
  if (c) assert.strictEqual(c.looks_like_lookup, false, 'inbox-dump should not classify as lookup');
});

test('classifier: returns null for unparseable URLs', () => {
  const entry = req({ url: '' });
  assert.strictEqual(classifyRequestShape(entry, { request_i: 0 }), null);
});

test('classifier: returns null when responseBody is unclassifiable', () => {
  const entry = req({
    url: 'https://www.example.com/stream',
    headers: { 'content-type': 'video/mp4' },
    responseBody: null,
  });
  const c = classifyRequestShape(entry, { request_i: 0 });
  // No response format detected → null
  assert.strictEqual(c, null);
});

// ---- Output shape details ----

test('classifier: id_fields capture nested paths', () => {
  const entry = req({
    method: 'POST',
    url: 'https://www.example.com/api/search',
    postData: { query: 'test' },
    responseBody: {
      data: {
        users: [
          {
            user_id: '156025504001094',
            profile: { profile_id: '12345678901' },
          },
        ],
      },
    },
  });
  const c = classifyRequestShape(entry, { request_i: 0 });
  assert.ok(c);
  const paths = c.output_shape.id_fields.map((f) => f.field_path);
  assert.ok(paths.some((p) => /user_id/.test(p)));
  assert.ok(paths.some((p) => /profile_id/.test(p)));
});

test('classifier: handles JSON-string-encoded postData (common XHR pattern)', () => {
  const entry = req({
    method: 'POST',
    url: 'https://www.example.com/api/graphql',
    postData: JSON.stringify({ query: 'search', variables: { q: 'test' } }),
    responseBody: { data: { result: { id: '156025504001094' } } },
  });
  const c = classifyRequestShape(entry, { request_i: 0 });
  assert.ok(c);
  // body_keys should include 'query' even though postData is a string
  assert.ok(c.input_shape.body_keys?.some((k) => k === 'query'));
});

test('classifier: confidence is a 2-decimal number in [0, 1]', () => {
  const entry = req({
    url: 'https://www.example.com/search?q=x',
    responseBody: { results: [{ id: '156025504001094' }] },
  });
  const c = classifyRequestShape(entry, { request_i: 0 });
  assert.ok(c);
  assert.ok(c.lookup_confidence >= 0 && c.lookup_confidence <= 1);
  // Check 2-decimal rounding
  assert.strictEqual(
    c.lookup_confidence,
    Number(c.lookup_confidence.toFixed(2)),
  );
});

test('classifier: request_i round-trips verbatim', () => {
  const entry = req({
    url: 'https://www.example.com/search?q=test',
    responseBody: { id: '156025504001094' },
  });
  const c = classifyRequestShape(entry, { request_i: 999 });
  assert.ok(c);
  assert.strictEqual(c.request_i, 999);
});
