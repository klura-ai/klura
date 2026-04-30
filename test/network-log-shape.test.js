// Unit tests for shapeNetworkLog — the pure shaping function that converts
// a raw InterceptedRequest[] into the agent-facing summary/detail/detail-list
// envelope. No runtime, no drivers, no fixtures — just synthetic inputs.

import test from 'node:test';
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { shapeNetworkLog } from '../dist/response/network-log-shape.js';

function fakeEntry(overrides = {}) {
  return {
    method: 'POST',
    url: 'https://example.com/api/foo',
    headers: {
      'content-type': 'application/json',
      cookie: 'session=abc; csrftoken=xyz',
    },
    postData: { foo: 'bar' },
    status: 200,
    responseBody: { ok: true },
    ...overrides,
  };
}

test('empty input → empty summary envelope with sane defaults', () => {
  const r = shapeNetworkLog([]);
  assert.deepStrictEqual(r, {
    requests: [],
    total: 0,
    total_filtered: 0,
    returned: 0,
    page: 1,
    page_size: 50,
    total_pages: 0,
    has_more: false,
    mode: 'summary',
  });
});

test('default summary shape — i, method, url, status, sizes, contentType, no headers', () => {
  const raw = [fakeEntry()];
  const r = shapeNetworkLog(raw);
  assert.strictEqual(r.mode, 'summary');
  assert.strictEqual(r.returned, 1);
  const s = r.requests[0];
  assert.strictEqual(s.i, 0);
  assert.strictEqual(s.method, 'POST');
  assert.strictEqual(s.url, 'https://example.com/api/foo');
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.contentType, 'application/json');
  assert.ok(s.postDataSize > 0);
  assert.ok(s.responseSize > 0);
  // Critical: no headers leakage anywhere in the response
  assert.ok(!('headers' in s));
  assert.ok(!JSON.stringify(r).includes('"headers"'));
  assert.ok(!JSON.stringify(r).includes('cookie'));
  assert.ok(!JSON.stringify(r).includes('csrftoken'));
});

test('case-insensitive content-type extraction with charset stripping', () => {
  const variants = [
    { headers: { 'Content-Type': 'application/json; charset=utf-8' }, expected: 'application/json' },
    { headers: { 'CONTENT-TYPE': 'text/html' }, expected: 'text/html' },
    { headers: { 'content-type': 'multipart/form-data; boundary=---xyz' }, expected: 'multipart/form-data' },
  ];
  for (const { headers, expected } of variants) {
    const r = shapeNetworkLog([fakeEntry({ headers })]);
    assert.strictEqual(r.requests[0].contentType, expected);
  }
});

test('detail by index returns single raw entry verbatim', () => {
  const raw = Array.from({ length: 10 }, (_, i) =>
    fakeEntry({ url: `https://example.com/api/${i}`, headers: { 'x-weird-header': `val-${i}` } }),
  );
  const r = shapeNetworkLog(raw, { i: 5, full: true });
  assert.strictEqual(r.mode, 'detail');
  assert.strictEqual(r.returned, 1);
  assert.strictEqual(r.total, 10);
  assert.strictEqual(r.total_filtered, 1);
  assert.strictEqual(r.has_more, false);
  // requests is a single object, not an array
  assert.strictEqual(Array.isArray(r.requests), false);
  assert.strictEqual(r.requests.url, 'https://example.com/api/5');
  // Headers preserved verbatim — even unusual names
  assert.strictEqual(r.requests.headers['x-weird-header'], 'val-5');
});

test('detail by index out of range returns empty + warning', () => {
  const raw = Array.from({ length: 10 }, () => fakeEntry());
  const r = shapeNetworkLog(raw, { i: 42, full: true });
  assert.strictEqual(r.returned, 0);
  assert.deepStrictEqual(r.requests, []);
  assert.strictEqual(r.total_pages, 0);
  assert.match(r.warning, /no entry at index 42/);
});

test('detail by index bypasses url_contains and pagination', () => {
  const raw = Array.from({ length: 10 }, (_, i) =>
    fakeEntry({ url: `https://example.com/api/${i}` }),
  );
  // url_contains "nomatch" wouldn't match anything, but i:7 still wins
  const r = shapeNetworkLog(raw, { i: 7, full: true, url_contains: 'nomatch', page: 99 });
  assert.strictEqual(r.mode, 'detail');
  assert.strictEqual(r.returned, 1);
  assert.strictEqual(r.requests.url, 'https://example.com/api/7');
});

test('url_contains narrows summary; absolute i preserved', () => {
  const raw = Array.from({ length: 10 }, (_, i) =>
    fakeEntry({ url: i === 7 ? 'https://example.com/graphql' : `https://example.com/api/${i}` }),
  );
  const r = shapeNetworkLog(raw, { url_contains: 'GRAPHQL' });
  assert.strictEqual(r.total, 10);
  assert.strictEqual(r.total_filtered, 1);
  assert.strictEqual(r.returned, 1);
  assert.strictEqual(r.requests[0].i, 7);
  assert.strictEqual(r.requests[0].url, 'https://example.com/graphql');
});

test('last: N tails after url_contains, preserves absolute i', () => {
  const raw = Array.from({ length: 20 }, (_, i) =>
    fakeEntry({ url: `https://example.com/api/${i}` }),
  );
  const r = shapeNetworkLog(raw, { last: 5 });
  assert.strictEqual(r.total, 20);
  assert.strictEqual(r.total_filtered, 5);
  assert.strictEqual(r.returned, 5);
  // Last 5 entries → indices 15..19
  assert.deepStrictEqual(
    r.requests.map((s) => s.i),
    [15, 16, 17, 18, 19],
  );
});

test('summary pagination — default page size 50 on 120 entries', () => {
  const raw = Array.from({ length: 120 }, (_, i) =>
    fakeEntry({ url: `https://example.com/api/${i}` }),
  );
  const p1 = shapeNetworkLog(raw);
  assert.strictEqual(p1.page, 1);
  assert.strictEqual(p1.page_size, 50);
  assert.strictEqual(p1.total_pages, 3);
  assert.strictEqual(p1.has_more, true);
  assert.strictEqual(p1.returned, 50);
  assert.strictEqual(p1.requests[0].i, 0);
  assert.strictEqual(p1.requests[49].i, 49);
});

test('summary pagination — page 2 + page 3 + beyond', () => {
  const raw = Array.from({ length: 120 }, (_, i) =>
    fakeEntry({ url: `https://example.com/api/${i}` }),
  );

  const p2 = shapeNetworkLog(raw, { page: 2 });
  assert.strictEqual(p2.returned, 50);
  assert.strictEqual(p2.requests[0].i, 50);
  assert.strictEqual(p2.has_more, true);

  const p3 = shapeNetworkLog(raw, { page: 3 });
  assert.strictEqual(p3.returned, 20);
  assert.strictEqual(p3.requests[0].i, 100);
  assert.strictEqual(p3.requests[19].i, 119);
  assert.strictEqual(p3.has_more, false);

  const p10 = shapeNetworkLog(raw, { page: 10 });
  assert.strictEqual(p10.returned, 0);
  assert.strictEqual(p10.has_more, false);
  assert.match(p10.warning, /beyond total_pages/);
});

test('summary pagination + url_contains — paginates the filtered set', () => {
  const raw = Array.from({ length: 100 }, (_, i) =>
    fakeEntry({ url: i % 4 === 0 ? `https://example.com/api/${i}` : `https://other.com/${i}` }),
  );
  const r = shapeNetworkLog(raw, { url_contains: 'example.com', page: 1 });
  assert.strictEqual(r.total, 100);
  assert.strictEqual(r.total_filtered, 25);
  assert.strictEqual(r.returned, 25);
  // First filtered entry is index 0, then 4, 8, etc.
  assert.strictEqual(r.requests[0].i, 0);
  assert.strictEqual(r.requests[1].i, 4);
});

test('page_size clamping — too big clamps with warning', () => {
  const raw = Array.from({ length: 300 }, () => fakeEntry());
  const r = shapeNetworkLog(raw, { page_size: 500 });
  assert.strictEqual(r.page_size, 200);
  assert.match(r.warning, /clamped from 500 to 200/);
  assert.strictEqual(r.returned, 200);
});

test('page_size 0 or negative falls back to default with no warning', () => {
  const raw = Array.from({ length: 100 }, () => fakeEntry());
  const r0 = shapeNetworkLog(raw, { page_size: 0 });
  const rNeg = shapeNetworkLog(raw, { page_size: -5 });
  assert.strictEqual(r0.page_size, 50);
  assert.strictEqual(rNeg.page_size, 50);
  assert.strictEqual(r0.warning, undefined);
  assert.strictEqual(rNeg.warning, undefined);
});

test('full:true without index → detail-lite with body clipping (multi-entry, narrowing filter)', () => {
  const raw = Array.from({ length: 30 }, (_, i) =>
    fakeEntry({ url: `https://example.com/api/${i}` }),
  );
  const r = shapeNetworkLog(raw, { full: true, url_contains: 'api' });
  // Multi-entry `full:true` without an explicit `i` / `ws_i` auto-promotes
  // to detail-lite so bodies are clipped + the response respects the
  // MCP tool-output budget. Avoids the 2026-04-21T09 messenger failure
  // mode where 5 entries × 20K bodies = 107K response → harness file-dump.
  assert.strictEqual(r.mode, 'detail-lite');
  // Detail mode still returns full-shape entries — headers present.
  assert.ok('headers' in r.requests[0]);
});

test('full:true + explicit page_size → detail-list with per-entry body clipping', () => {
  // Caller explicitly tuning a page size bypasses auto-promote and lands
  // in the detail-list branch, which STILL slices bodies via toDetailLite
  // so the response can't blow the budget.
  const raw = Array.from({ length: 30 }, (_, i) =>
    fakeEntry({ url: `https://example.com/api/${i}`, responseBody: 'z'.repeat(50_000) }),
  );
  const r = shapeNetworkLog(raw, { full: true, url_contains: 'api', page_size: 5 });
  assert.strictEqual(r.mode, 'detail-list');
  assert.strictEqual(r.returned, 5);
  // Each entry's body is clipped — no 50KB verbatim bodies.
  for (const entry of r.requests) {
    assert.ok(
      entry.responseBody.length < 50_000,
      `responseBody should be clipped, got ${entry.responseBody.length}`,
    );
  }
});

test('detail-list page_size clamping — caps at 20 with warning', () => {
  const raw = Array.from({ length: 50 }, () => fakeEntry());
  const r = shapeNetworkLog(raw, { full: true, page_size: 50 });
  assert.strictEqual(r.page_size, 20);
  assert.match(r.warning, /clamped from 50 to 20/);
});

test('absolute index invariant — i from page 2 round-trips', () => {
  const raw = Array.from({ length: 120 }, (_, i) =>
    fakeEntry({ url: `https://example.com/api/${i}` }),
  );
  const p2 = shapeNetworkLog(raw, { page: 2 });
  const targetI = p2.requests[7].i; // some index from page 2
  assert.strictEqual(targetI, 57);
  // Round-trip: pass that i back for detail
  const detail = shapeNetworkLog(raw, { i: targetI, full: true });
  assert.strictEqual(detail.requests.url, 'https://example.com/api/57');
});

test('full-mode verbatim — adversarial header name preserved', () => {
  const adversarial = [
    fakeEntry({
      headers: {
        'sec-fetch-auth': 'SECRET_CSRF_TOKEN_XYZ',
        'random-name-no-pattern': 'another-secret',
        'fetch-signature': 'bypass-attempt',
      },
    }),
  ];
  const detail = shapeNetworkLog(adversarial, { i: 0, full: true });
  // Every header name preserved regardless of how unusual
  assert.strictEqual(detail.requests.headers['sec-fetch-auth'], 'SECRET_CSRF_TOKEN_XYZ');
  assert.strictEqual(detail.requests.headers['random-name-no-pattern'], 'another-secret');
  assert.strictEqual(detail.requests.headers['fetch-signature'], 'bypass-attempt');
});

test('summary never leaks header names — adversarial regression', () => {
  const adversarial = [
    fakeEntry({
      headers: {
        'sec-fetch-auth': 'CSRF_VALUE',
        'random-name': 'value',
      },
    }),
  ];
  const summary = shapeNetworkLog(adversarial);
  const json = JSON.stringify(summary);
  // None of the adversarial header names or values should appear in the summary
  assert.ok(!json.includes('sec-fetch-auth'));
  assert.ok(!json.includes('CSRF_VALUE'));
  assert.ok(!json.includes('random-name'));
  assert.ok(!json.includes('"headers"'));
});

test('entry with no headers still produces valid summary (no contentType)', () => {
  const raw = [{
    method: 'POST',
    url: 'https://example.com/api',
    headers: {},
    postData: { x: 1 },
    status: 200,
    responseBody: null,
  }];
  const r = shapeNetworkLog(raw);
  assert.strictEqual(r.requests[0].contentType, undefined);
  assert.strictEqual(r.requests[0].method, 'POST');
});

test('isNavigation and redirectUrl flow through to summary', () => {
  const raw = [fakeEntry({ isNavigation: true, redirectUrl: 'https://example.com/done', status: 302 })];
  const r = shapeNetworkLog(raw);
  assert.strictEqual(r.requests[0].isNavigation, true);
  assert.strictEqual(r.requests[0].redirectUrl, 'https://example.com/done');
  assert.strictEqual(r.requests[0].status, 302);
});

// --- detail-lite auto-promotion ------------------------------------------

test('detail-lite: url_contains on a small filtered set auto-promotes', () => {
  const raw = Array.from({ length: 15 }, (_, i) =>
    fakeEntry({
      url: i % 3 === 0 ? 'https://example.com/api/graphql' : `https://example.com/api/other/${i}`,
      headers: { 'content-type': 'application/json', 'x-api-name': `op-${i}` },
      postData: JSON.stringify({ op: `op-${i}` }),
      responseBody: JSON.stringify({ data: { id: i } }),
    }),
  );
  const r = shapeNetworkLog(raw, { url_contains: 'graphql' });
  assert.strictEqual(r.mode, 'detail-lite', 'filtered narrow set should auto-promote');
  assert.strictEqual(r.returned, 5, 'should return all 5 graphql entries');
  // Detail-lite entries carry headers, postData, and a response body preview.
  const e0 = r.requests[0];
  assert.ok(e0.headers, 'detail-lite entries should include headers');
  assert.strictEqual(e0.headers['x-api-name'], 'op-0');
  assert.ok(e0.postData, 'detail-lite entries should include postData');
  assert.ok(e0.responseBody, 'detail-lite entries should include response preview');
  // Absolute index preserved for round-trip to {i, full: true}.
  assert.strictEqual(typeof e0.i, 'number');
  assert.strictEqual(e0.i, 0);
  assert.strictEqual(r.requests[1].i, 3);
});

test('detail-lite: text_contains matches across headers, postData, responseBody', () => {
  const raw = [
    fakeEntry({
      url: 'https://example.com/api/search',
      headers: { 'x-api-name': 'SearchUsers' },
      postData: JSON.stringify({ query: 'nothing' }),
      responseBody: JSON.stringify({ results: [] }),
    }),
    fakeEntry({
      url: 'https://example.com/api/mutation',
      headers: { 'x-api-name': 'SendMessage' },
      postData: JSON.stringify({ text: 'Hello from field-report' }),
      responseBody: JSON.stringify({ ok: true }),
    }),
    fakeEntry({
      url: 'https://example.com/api/echo',
      headers: { 'x-api-name': 'EchoMutation' },
      postData: JSON.stringify({ text: 'something else' }),
      responseBody: JSON.stringify({ echoed: 'Hello from field-report' }),
    }),
  ];
  // Needle is in entry [1].postData and entry [2].responseBody — should find both.
  const r = shapeNetworkLog(raw, { text_contains: 'Hello from field-report' });
  assert.strictEqual(r.mode, 'detail-lite');
  assert.strictEqual(r.total_filtered, 2);
  const indices = r.requests.map((e) => e.i).sort();
  assert.deepStrictEqual(indices, [1, 2]);
});

test('detail-lite: text_contains is case-insensitive', () => {
  const raw = [
    fakeEntry({ responseBody: JSON.stringify({ friendly_name: 'UseLSSendMessageMutation' }) }),
  ];
  const r = shapeNetworkLog(raw, { text_contains: 'sendmessage' });
  assert.strictEqual(r.mode, 'detail-lite');
  assert.strictEqual(r.total_filtered, 1);
});

test('detail-lite: text_contains matches form-encoded postData (the Messenger class)', () => {
  // Reproduction of the real failure: Facebook sends graphql POSTs as
  // application/x-www-form-urlencoded, and the literal the user typed
  // shows up on the wire as `Hello+from+a+klura` (plus-for-space) plus
  // %7B / %22 escapes around the JSON. A naive raw-substring match
  // would miss the literal "Hello from a klura"; text_contains must
  // decode the form encoding before matching.
  const formBody =
    'fb_dtsg=NAcNyZ&jazoest=25431&lsd=abcdef&' +
    'variables=%7B%22input%22%3A%7B%22message_text%22%3A%22Hello+from+a+klura+field-report+run+on+2026-04-15%22%7D%7D&' +
    'doc_id=1234567890';
  const raw = [
    fakeEntry({
      url: 'https://www.messenger.com/api/graphql/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: formBody,
      responseBody: '{"data":{"send_message":{"id":"m_12345"}}}',
    }),
    fakeEntry({
      url: 'https://www.messenger.com/api/graphql/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'variables=%7B%22query%22%3A%22unrelated%22%7D',
    }),
  ];
  const r = shapeNetworkLog(raw, {
    text_contains: 'Hello from a klura field-report run on 2026-04-15',
  });
  assert.strictEqual(r.mode, 'detail-lite', 'should auto-promote on a hit');
  assert.strictEqual(r.total_filtered, 1, 'only the send entry should match');
  assert.strictEqual(r.requests[0].i, 0);
});

test('detail-lite: text_contains matches percent-encoded JSON values', () => {
  // Variant of the above — a GET URL with the message encoded as a
  // query param, fully percent-encoded. Should match.
  const raw = [
    fakeEntry({
      url: 'https://api.example.com/v1/search?q=Hello%20world%20test',
      postData: null,
    }),
  ];
  const r = shapeNetworkLog(raw, { text_contains: 'Hello world test' });
  assert.strictEqual(r.mode, 'detail-lite');
  assert.strictEqual(r.total_filtered, 1);
});

test('detail-lite: text_contains still matches plain JSON bodies', () => {
  // Regression: the URL-decoding fix must not break the JSON-body case
  // (where postData is already a plain JSON string with no form encoding).
  const raw = [
    fakeEntry({
      url: 'https://api.example.com/v1/send',
      headers: { 'content-type': 'application/json' },
      postData: JSON.stringify({ text: 'Hello from a klura field-report run on 2026-04-15' }),
    }),
  ];
  const r = shapeNetworkLog(raw, {
    text_contains: 'Hello from a klura field-report run on 2026-04-15',
  });
  assert.strictEqual(r.mode, 'detail-lite');
  assert.strictEqual(r.total_filtered, 1);
});

test('detail-lite: text_contains survives malformed percent sequences without throwing', () => {
  // decodeURIComponent throws on a stray `%` — we must catch and fall
  // back to the already-tried raw / plus-decoded variants.
  const raw = [
    fakeEntry({
      url: 'https://example.com/weird',
      postData: 'q=50%25off+sale', // legal percent-encoding: "50%off sale"
    }),
    fakeEntry({
      url: 'https://example.com/broken',
      postData: 'q=a%ZZ+broken', // illegal percent sequence
    }),
  ];
  // Neither matches "definitely-not-present", but the call must not throw.
  const r = shapeNetworkLog(raw, { text_contains: 'definitely-not-present' });
  assert.strictEqual(r.total_filtered, 0);
  // Sanity: a legitimate decoded match on the first entry still works.
  const r2 = shapeNetworkLog(raw, { text_contains: '50%off' });
  assert.strictEqual(r2.total_filtered, 1);
});

test('detail-lite: text_contains combines with url_contains (both filters apply)', () => {
  const raw = [
    fakeEntry({
      url: 'https://example.com/api/graphql',
      postData: JSON.stringify({ op: 'SendMessage' }),
    }),
    fakeEntry({
      url: 'https://example.com/api/rest',
      postData: JSON.stringify({ op: 'SendMessage' }),
    }),
  ];
  const r = shapeNetworkLog(raw, { url_contains: 'graphql', text_contains: 'SendMessage' });
  assert.strictEqual(r.total_filtered, 1);
  assert.strictEqual(r.requests[0].i, 0);
});

test('detail-lite: large responseBody clipped with truncation markers', () => {
  const bigBody = 'x'.repeat(5000);
  const raw = [
    fakeEntry({
      url: 'https://example.com/api/bigblob',
      responseBody: bigBody,
    }),
  ];
  const r = shapeNetworkLog(raw, { url_contains: 'bigblob' });
  assert.strictEqual(r.mode, 'detail-lite');
  const entry = r.requests[0];
  assert.strictEqual(entry.responseBody_truncated, true);
  assert.strictEqual(entry.responseBody_total_chars, 5000);
  assert.strictEqual(entry.responseBody_slice_start, 0);
  assert.strictEqual(entry.responseBody_slice_end, 512);
  assert.ok(
    entry.responseBody_hint && entry.responseBody_hint.includes('body_offset'),
    'expected responseBody_hint pointing at the next chunk',
  );
  assert.strictEqual(entry.responseBody.length, 512);
});

test('detail-lite: small responseBody not marked truncated', () => {
  const raw = [
    fakeEntry({
      url: 'https://example.com/api/small',
      responseBody: JSON.stringify({ ok: true }),
    }),
  ];
  const r = shapeNetworkLog(raw, { url_contains: 'small' });
  assert.strictEqual(r.mode, 'detail-lite');
  assert.ok(!r.requests[0].responseBody_truncated);
});

test('detail-lite: greedy-paginates when the whole narrowed set overflows', () => {
  // 20 entries with heavy headers (~2 KB each) + small postData. Whole set
  // is ~40 KB, which blows the 20 KB budget, so the runtime greedy-packs
  // as many entries as fit into the first page and stamps has_more=true.
  const heavyHeaders = {};
  for (let k = 0; k < 40; k += 1) {
    heavyHeaders[`x-custom-header-${k}`] = 'v'.repeat(50);
  }
  const raw = Array.from({ length: 20 }, (_, i) =>
    fakeEntry({
      url: 'https://example.com/api/graphql',
      headers: { ...heavyHeaders, 'x-op-name': `op-${i}`, 'content-type': 'application/json' },
      postData: JSON.stringify({ q: `q-${i}` }),
      responseBody: JSON.stringify({ ok: true, id: i }),
    }),
  );
  const page1 = shapeNetworkLog(raw, { url_contains: 'graphql' });
  assert.strictEqual(page1.mode, 'detail-lite');
  assert.strictEqual(page1.total_filtered, 20);
  assert.ok(page1.total_pages > 1, 'should paginate when narrowed set overflows');
  assert.ok(page1.returned < 20, 'page 1 should only hold a subset');
  assert.strictEqual(page1.has_more, true);
  assert.match(page1.warning, /paginated into/);
  // Entries on page 1 still carry full headers + postData + i for round-trip.
  for (const entry of page1.requests) {
    assert.ok(entry.headers['x-op-name']);
    assert.ok(entry.postData);
    assert.strictEqual(typeof entry.i, 'number');
  }

  // Requesting page 2 gives the next slice of the same detail-lite mode.
  const page2 = shapeNetworkLog(raw, { url_contains: 'graphql', page: 2 });
  assert.strictEqual(page2.mode, 'detail-lite');
  assert.strictEqual(page2.page, 2);
  assert.ok(page2.returned > 0);
});

test('detail-lite: skips entries too large to fit even alone', () => {
  // One entry has a pathologically huge postData (30 KB); the runtime
  // skips it and notes the skipped index in the warning.
  const raw = [
    fakeEntry({
      url: 'https://example.com/api/monster',
      postData: 'z'.repeat(30_000),
    }),
    fakeEntry({
      url: 'https://example.com/api/normal',
      postData: JSON.stringify({ ok: true }),
    }),
  ];
  const r = shapeNetworkLog(raw, { url_contains: 'api' });
  assert.strictEqual(r.mode, 'detail-lite');
  // Only the normal entry fits.
  assert.strictEqual(r.returned, 1);
  assert.strictEqual(r.requests[0].i, 1);
  assert.match(r.warning, /too large to include/);
  assert.match(r.warning, /indices: 0/);
});

test('detail-lite: falls back to summary when every entry is a giant', () => {
  // Every filtered entry is over the per-entry soft cap (15 KB), so
  // nothing can be greedy-packed into even an empty page. Runtime gives
  // up and returns summary + pagination.
  const raw = Array.from({ length: 5 }, () =>
    fakeEntry({
      url: 'https://example.com/api/huge',
      postData: 'z'.repeat(20_000),
    }),
  );
  const r = shapeNetworkLog(raw, { url_contains: 'huge' });
  assert.strictEqual(r.mode, 'summary');
  assert.strictEqual(r.total_filtered, 5);
});

test('detail-lite: unfiltered small log stays in summary mode', () => {
  // No narrowing filter → summary, even if the full log would fit.
  const raw = Array.from({ length: 5 }, () => fakeEntry());
  const r = shapeNetworkLog(raw);
  assert.strictEqual(r.mode, 'summary');
});

test('detail-lite: explicit page_size suppresses auto-promotion', () => {
  // page_size is a summary-style tuning knob; when the caller sets it
  // explicitly the runtime respects it and stays in summary mode.
  const raw = Array.from({ length: 10 }, () =>
    fakeEntry({ url: 'https://example.com/api/x', responseBody: JSON.stringify({ ok: true }) }),
  );
  const r = shapeNetworkLog(raw, { url_contains: 'api', page_size: 5 });
  assert.strictEqual(r.mode, 'summary', 'explicit page_size opts out of detail-lite');
});

test('detail-lite: opts.page walks detail-lite pages when the narrowed set overflows', () => {
  // Build a set big enough to require detail-lite pagination, then ask
  // for page 1 and page 2 back-to-back. Both should come back as
  // detail-lite with the expected page numbers.
  const heavyHeaders = {};
  for (let k = 0; k < 30; k += 1) heavyHeaders[`x-h-${k}`] = 'v'.repeat(60);
  const raw = Array.from({ length: 15 }, (_, i) =>
    fakeEntry({
      url: 'https://example.com/api/graphql',
      headers: { ...heavyHeaders, 'x-op': `op-${i}` },
      postData: JSON.stringify({ q: `q-${i}` }),
    }),
  );
  const p1 = shapeNetworkLog(raw, { url_contains: 'graphql' });
  assert.strictEqual(p1.mode, 'detail-lite');
  assert.ok(p1.total_pages > 1);
  const p2 = shapeNetworkLog(raw, { url_contains: 'graphql', page: 2 });
  assert.strictEqual(p2.mode, 'detail-lite');
  assert.strictEqual(p2.page, 2);
});

test('budget regression: full:true on heavy bodies never exceeds MAX_TOOL_OUTPUT_CHARS', async () => {
  // Regression for 2026-04-21T09 messenger: agent called
  // get_network_log(full: true) on a narrowed set where several
  // captured entries carried 20–30KB responseBody each. Raw
  // detail-list returned them verbatim; total response was 107KB,
  // which blew the 25KB MCP cap and fell through to the harness
  // file-dump (reading the dumped file burns multiple rounds).
  // Detail-lite packs entries under the budget; this test asserts
  // the invariant.
  const { MAX_TOOL_OUTPUT_CHARS } = await import('../dist/response/response-size.js');
  const raw = Array.from({ length: 10 }, (_, i) =>
    fakeEntry({
      url: `https://example.com/api/graphql?q=${i}`,
      responseBody: 'x'.repeat(20_000),
      postData: 'y'.repeat(5_000),
    }),
  );
  const r = shapeNetworkLog(raw, { url_contains: 'graphql', full: true });
  const serialized = JSON.stringify(r);
  assert.ok(
    serialized.length <= MAX_TOOL_OUTPUT_CHARS,
    `response ${serialized.length} chars must fit under MAX_TOOL_OUTPUT_CHARS (${MAX_TOOL_OUTPUT_CHARS})`,
  );
});

test('detail-lite: explicit full:true auto-promotes to detail-lite with body clipping', () => {
  // Prior behavior (raw detail-list with verbatim bodies) blew the
  // 25KB MCP tool-output budget on response-body-heavy captures (see
  // 2026-04-21T09 messenger field report, 107KB payload). full:true
  // without an explicit `i` / `ws_i` now packs through detail-lite so
  // the response stays under budget regardless of body size.
  const raw = Array.from({ length: 3 }, () =>
    fakeEntry({ url: 'https://example.com/api/x', responseBody: 'z'.repeat(5000) }),
  );
  const r = shapeNetworkLog(raw, { url_contains: 'api', full: true });
  assert.strictEqual(r.mode, 'detail-lite');
  // Bodies are clipped relative to the 5000-char originals.
  assert.ok(
    r.requests[0].responseBody.length <= 5000,
    'responseBody should be clipped or equal to original',
  );
});

// ---- wsFrames integration ----

function fakeWsFrame(overrides = {}) {
  return {
    url: 'wss://ws.example.com/chat',
    direction: 'sent',
    payload: '{"type":"publish","text":"hello"}',
    timestamp: Date.now(),
    ...overrides,
  };
}

test('wsFrames included in summary when session has any', () => {
  const raw = [fakeEntry()];
  const ws = [fakeWsFrame({ payload: '{"msg":"hi"}' })];
  const r = shapeNetworkLog(raw, {}, ws);
  assert.strictEqual(r.wsFramesTotal, 1);
  assert.strictEqual(r.wsFrames.length, 1);
  assert.strictEqual(r.wsFrames[0].i, 0);
  assert.strictEqual(r.wsFrames[0].direction, 'sent');
  assert.strictEqual(r.wsFrames[0].payload, '{"msg":"hi"}');
});

test('wsFrames omitted when session has none', () => {
  const r = shapeNetworkLog([fakeEntry()], {});
  assert.strictEqual(r.wsFrames, undefined);
  assert.strictEqual(r.wsFramesTotal, undefined);
});

test('wsFrames payload clipped to 512 chars with truncation flag', () => {
  const longPayload = 'x'.repeat(2000);
  const ws = [fakeWsFrame({ payload: longPayload })];
  const r = shapeNetworkLog([], {}, ws);
  assert.strictEqual(r.wsFrames[0].payload.length, 512);
  assert.strictEqual(r.wsFrames[0].payload_truncated, true);
  assert.strictEqual(r.wsFrames[0].payload_total_chars, 2000);
});

test('text_contains filter also matches ws frame payloads', () => {
  const raw = [fakeEntry({ url: 'https://other.example.com/unrelated' })];
  const ws = [
    fakeWsFrame({ payload: '{"type":"heartbeat"}' }),
    fakeWsFrame({ payload: '{"msg":"klura-specific-literal"}' }),
    fakeWsFrame({ payload: '{"type":"ack"}' }),
  ];
  const r = shapeNetworkLog(raw, { text_contains: 'klura-specific-literal' }, ws);
  assert.strictEqual(r.wsFramesFiltered, 1);
  assert.strictEqual(r.wsFrames.length, 1);
  assert.strictEqual(r.wsFrames[0].i, 1);
  assert.ok(r.wsFrames[0].payload.includes('klura-specific-literal'));
});

test('unfiltered wsFrames capped at 30 with warning', () => {
  const ws = Array.from({ length: 50 }, (_, i) =>
    fakeWsFrame({ payload: `frame-${i}` }),
  );
  const r = shapeNetworkLog([], {}, ws);
  assert.strictEqual(r.wsFramesTotal, 50);
  assert.strictEqual(r.wsFrames.length, 30);
  // Returns the LAST 30 (most recent).
  assert.strictEqual(r.wsFrames[0].i, 20);
  assert.strictEqual(r.wsFrames[29].i, 49);
  assert.ok(r.warning && r.warning.includes('wsFrames capped'));
});

test('text_contains bypasses the 30-frame cap', () => {
  const ws = Array.from({ length: 50 }, (_, i) =>
    fakeWsFrame({ payload: `has-target-${i}` }),
  );
  const r = shapeNetworkLog([], { text_contains: 'has-target' }, ws);
  assert.strictEqual(r.wsFramesFiltered, 50);
  assert.strictEqual(r.wsFrames.length, 50);
});

test('{ws_i, full: true} returns the untrimmed frame', () => {
  const longPayload = 'q'.repeat(2000);
  const ws = [
    fakeWsFrame({ payload: 'short' }),
    fakeWsFrame({ payload: longPayload }),
  ];
  const r = shapeNetworkLog([], { ws_i: 1, full: true }, ws);
  assert.strictEqual(r.mode, 'detail');
  assert.strictEqual(r.wsFrame.payload, longPayload);
  assert.strictEqual(r.wsFrame.payload.length, 2000);
  assert.strictEqual(r.wsFramesTotal, 2);
});

test('{ws_i} out-of-range returns empty + warning', () => {
  const ws = [fakeWsFrame()];
  const r = shapeNetworkLog([], { ws_i: 99, full: true }, ws);
  assert.strictEqual(r.mode, 'detail');
  assert.strictEqual(r.wsFrame, undefined);
  assert.ok(r.warning && r.warning.includes('no ws frame at index 99'));
});

// ---- _advisory: complex-envelope detector framework ----
//
// The detectors live in response/envelope-advisories.ts and run from inside
// shapeNetworkLog. These tests exercise the integration: agent calls
// get_network_log, sees `_advisory` on the response when traffic looks
// structurally complex, sees nothing when it doesn't.

// Compose an MQTT-PUBLISH-ish binary frame: leading 0x32, varint length, then
// a binary blob containing the literal the agent typed. Mirrors the run-4
// Messenger capture shape closely enough to trip the binary-WS detector.
function binaryWsFrameWithLiteral(literal, overrides = {}) {
  const header = String.fromCharCode(0x32, 0xfd, 0x09, 0x00, 0x05);
  const blob = String.fromCharCode(0x00, 0x01, 0x02, 0x03, 0x7f, 0x80, 0x81, 0x82);
  return fakeWsFrame({
    payload: `${header}topic/inbox${blob}${literal}${blob}${blob}`,
    direction: 'sent',
    ...overrides,
  });
}

test('_advisory: plain JSON over WS does not fire any detector', () => {
  const ws = [
    fakeWsFrame({ payload: '{"type":"publish","text":"klura-test-literal"}' }),
  ];
  const r = shapeNetworkLog([], { text_contains: 'klura-test-literal' }, ws);
  assert.strictEqual(r._advisory, undefined);
});

test('_advisory: HTTP-only filtered response with plain JSON body fires no advisory', () => {
  const raw = [
    fakeEntry({
      url: 'https://api.example.com/send',
      postData: { text: 'klura-test-literal' },
      headers: { 'content-type': 'application/json' },
    }),
  ];
  const r = shapeNetworkLog(raw, { text_contains: 'klura-test-literal' });
  assert.strictEqual(r._advisory, undefined);
});

test('_advisory: empty everything returns no advisory', () => {
  const r = shapeNetworkLog([]);
  assert.strictEqual(r._advisory, undefined);
});

test('_advisory: binary WS write carrying the literal fires binary_ws_frame', () => {
  const ws = [
    fakeWsFrame({ payload: '{"type":"heartbeat"}' }),
    binaryWsFrameWithLiteral('klura-test-literal'),
  ];
  const r = shapeNetworkLog([], { text_contains: 'klura-test-literal' }, ws);
  assert.ok(r._advisory, 'expected advisory on response');
  assert.strictEqual(r._advisory.kind, 'binary_ws_frame');
  assert.strictEqual(r._advisory.ws_i, 1);
  assert.strictEqual(r._advisory.evidence.first_byte, '0x32');
  assert.ok(r._advisory.evidence.literal_at_offset > 0);
  assert.ok(Array.isArray(r._advisory.refs));
});

test('_advisory: binary WS write where literal NOT in payload does not fire (anchored to filter)', () => {
  const ws = [
    binaryWsFrameWithLiteral('something-else-entirely'),
  ];
  const r = shapeNetworkLog([], { text_contains: 'klura-test-literal' }, ws);
  assert.strictEqual(r._advisory, undefined);
});

test('_advisory: received-direction binary frame does not fire (only sent writes lift)', () => {
  const ws = [binaryWsFrameWithLiteral('klura-test-literal', { direction: 'received' })];
  const r = shapeNetworkLog([], { text_contains: 'klura-test-literal' }, ws);
  assert.strictEqual(r._advisory, undefined);
});

test('_advisory: two binary WS sent frames with the literal — points at the first', () => {
  const ws = [
    binaryWsFrameWithLiteral('klura-test-literal'),
    binaryWsFrameWithLiteral('klura-test-literal'),
  ];
  const r = shapeNetworkLog([], { text_contains: 'klura-test-literal' }, ws);
  assert.strictEqual(r._advisory.kind, 'binary_ws_frame');
  assert.strictEqual(r._advisory.ws_i, 0);
});

test('_advisory: stats with 0 verify_against calls stamps iteration counter in evidence', () => {
  const ws = [binaryWsFrameWithLiteral('klura-test-literal')];
  const stats = { total: 0, with_verify_against: 0, ok_true: 0, verified_ok: 0 };
  const r = shapeNetworkLog([], { text_contains: 'klura-test-literal' }, ws, stats);
  assert.strictEqual(r._advisory.kind, 'binary_ws_frame');
  assert.strictEqual(r._advisory.evidence.verify_iterations_so_far, 0);
});

test('_advisory: stats with N>0 verify_against and 0 verified_ok stamps counters', () => {
  const ws = [binaryWsFrameWithLiteral('klura-test-literal')];
  const stats = { total: 4, with_verify_against: 4, ok_true: 0, verified_ok: 0 };
  const r = shapeNetworkLog([], { text_contains: 'klura-test-literal' }, ws, stats);
  assert.strictEqual(r._advisory.evidence.verify_iterations_so_far, 4);
  assert.strictEqual(r._advisory.evidence.verified_ok_so_far, 0);
});

test('_advisory: round count is stamped onto evidence when provided', () => {
  const ws = [binaryWsFrameWithLiteral('klura-test-literal')];
  const stats = { total: 0, with_verify_against: 0, ok_true: 0, verified_ok: 0 };
  const r = shapeNetworkLog(
    [],
    { text_contains: 'klura-test-literal' },
    ws,
    stats,
    14, // sessionRoundCount
  );
  assert.strictEqual(r._advisory.evidence.session_round_count, 14);
});

test('_advisory: low round count still emits the advisory kind', () => {
  const ws = [binaryWsFrameWithLiteral('klura-test-literal')];
  const stats = { total: 0, with_verify_against: 0, ok_true: 0, verified_ok: 0 };
  const r = shapeNetworkLog(
    [],
    { text_contains: 'klura-test-literal' },
    ws,
    stats,
    8,
  );
  assert.strictEqual(r._advisory.kind, 'binary_ws_frame');
});

test('_advisory: verified_ok > 0 stamps the converging counter onto evidence', () => {
  const ws = [binaryWsFrameWithLiteral('klura-test-literal')];
  const stats = { total: 6, with_verify_against: 6, ok_true: 1, verified_ok: 1 };
  const r = shapeNetworkLog([], { text_contains: 'klura-test-literal' }, ws, stats);
  assert.strictEqual(r._advisory.evidence.verified_ok_so_far, 1);
});

test('_advisory: no stats provided — no iteration counters on evidence', () => {
  const ws = [binaryWsFrameWithLiteral('klura-test-literal')];
  const r = shapeNetworkLog([], { text_contains: 'klura-test-literal' }, ws);
  assert.strictEqual(r._advisory.evidence.verify_iterations_so_far, undefined);
});

test('_advisory: multipart with binary part fires multipart_binary_body_observed', () => {
  const binaryPart = String.fromCharCode(...Array.from({ length: 64 }, (_, k) => k % 256));
  const body =
    '------WebKitFormBoundaryAbc\r\n' +
    'Content-Disposition: form-data; name="file"; filename="x.png"\r\n' +
    'Content-Type: image/png\r\n\r\n' +
    binaryPart + '\r\n' +
    '------WebKitFormBoundaryAbc--\r\n';
  const raw = [
    fakeEntry({
      url: 'https://example.com/api/upload',
      headers: { 'content-type': 'multipart/form-data; boundary=----WebKitFormBoundaryAbc' },
      postData: body,
    }),
  ];
  const r = shapeNetworkLog(raw, { url_contains: 'upload' });
  assert.ok(r._advisory);
  assert.strictEqual(r._advisory.kind, 'multipart_binary_body');
  assert.strictEqual(r._advisory.i, 0);
});

test('_advisory: multipart with text-only parts does not fire', () => {
  const body =
    '------B\r\n' +
    'Content-Disposition: form-data; name="x"\r\n\r\n' +
    'plain text value\r\n' +
    '------B--\r\n';
  const raw = [
    fakeEntry({
      headers: { 'content-type': 'multipart/form-data; boundary=----B' },
      postData: body,
    }),
  ];
  const r = shapeNetworkLog(raw, { url_contains: 'foo' });
  assert.strictEqual(r._advisory, undefined);
});

test('_advisory: escaped-JSON-in-JSON envelope fires escaped_json_envelope_observed', () => {
  const raw = [
    fakeEntry({
      url: 'https://example.com/api/send',
      headers: { 'content-type': 'application/json' },
      postData: '{"payload":"{\\"text\\":\\"klura-test-literal\\",\\"v\\":1}"}',
    }),
  ];
  const r = shapeNetworkLog(raw, { text_contains: 'klura-test-literal' });
  assert.ok(r._advisory);
  assert.strictEqual(r._advisory.kind, 'escaped_json_envelope');
  assert.strictEqual(r._advisory.i, 0);
  assert.ok(r._advisory.evidence.literal_at_offset > 0);
});

test('_advisory: literal in plain (non-escaped) JSON does not fire escaped envelope', () => {
  const raw = [
    fakeEntry({
      headers: { 'content-type': 'application/json' },
      postData: { text: 'klura-test-literal', v: 1 },
    }),
  ];
  const r = shapeNetworkLog(raw, { text_contains: 'klura-test-literal' });
  assert.strictEqual(r._advisory, undefined);
});

test('_advisory: protobuf binary HTTP body fires binary_http_body_observed', () => {
  const binaryBody = String.fromCharCode(
    0x0a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x10, 0x01, 0x18, 0xff, 0xff, 0x03,
    0x22, 0x10, 0x00, 0x01, 0x02, 0x03, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86,
  );
  const raw = [
    fakeEntry({
      url: 'https://example.com/api/grpc',
      headers: { 'content-type': 'application/x-protobuf' },
      postData: binaryBody,
    }),
  ];
  const r = shapeNetworkLog(raw, { url_contains: 'grpc' });
  assert.ok(r._advisory);
  assert.strictEqual(r._advisory.kind, 'binary_http_body');
  assert.strictEqual(r._advisory.evidence.content_type, 'application/x-protobuf');
});

test('_advisory: signed request fires body_signature_header_present', () => {
  const raw = [
    fakeEntry({
      url: 'https://example.com/api/post',
      headers: {
        'content-type': 'application/json',
        'x-content-signature': 'abc123signaturehere',
      },
      postData: { text: 'hello' },
    }),
  ];
  const r = shapeNetworkLog(raw, { url_contains: 'post' });
  assert.ok(r._advisory);
  assert.strictEqual(r._advisory.kind, 'body_signature_header_present');
  assert.strictEqual(r._advisory.evidence.header_name, 'x-content-signature');
});

function highEntropyBody(byteLen) {
  const buf = randomBytes(byteLen);
  let s = '';
  for (let k = 0; k < buf.length; k += 1) s += String.fromCharCode(buf[k]);
  return s;
}

test('_advisory: high-entropy body fires high_entropy_body_observed', () => {
  const raw = [
    fakeEntry({
      url: 'https://example.com/api/encrypted',
      headers: { 'content-type': 'application/json' },
      postData: highEntropyBody(256),
    }),
  ];
  const r = shapeNetworkLog(raw, { url_contains: 'encrypted' });
  assert.ok(r._advisory);
  assert.strictEqual(r._advisory.kind, 'high_entropy_body');
  assert.ok(r._advisory.evidence.entropy_bits_per_byte > 6.5);
});

test('_advisory: high-entropy body with Content-Encoding does NOT fire (compressed is fine)', () => {
  const raw = [
    fakeEntry({
      url: 'https://example.com/api/gz',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      postData: highEntropyBody(256),
    }),
  ];
  const r = shapeNetworkLog(raw, { url_contains: 'gz' });
  assert.strictEqual(r._advisory, undefined);
});

// The `persisted_graphql` detector has been removed from envelope-advisories
// — GraphQL persisted queries are now handled entirely by agent discovery
// reading the request body directly, with no runtime-emitted advisory.

test('_advisory: priority — binary WS wins over signed HTTP when both match', () => {
  // Binary WS write + signed HTTP request — both fire individually, framework
  // picks binary_ws (priority 1) because try_generator against the captured
  // frame is the most direct iteration path.
  const ws = [binaryWsFrameWithLiteral('klura-test-literal')];
  const raw = [
    fakeEntry({
      headers: { 'content-type': 'application/json', 'x-hmac-signature': 'sig' },
      postData: { text: 'hi' },
    }),
  ];
  const r = shapeNetworkLog(raw, { text_contains: 'klura-test-literal' }, ws);
  assert.ok(r._advisory);
  assert.strictEqual(r._advisory.kind, 'binary_ws_frame');
});

test('_advisory: surfaces in summary mode too (no narrowing filter, ws frames present)', () => {
  // No text_contains needed — binary WS write is a self-contained signal.
  const ws = [binaryWsFrameWithLiteral('any-literal')];
  const r = shapeNetworkLog([fakeEntry()], {}, ws);
  assert.strictEqual(r.mode, 'summary');
  assert.ok(r._advisory);
  assert.strictEqual(r._advisory.kind, 'binary_ws_frame');
});

// ---- Arm 2: leading binary header + plaintext body (the Messenger shape) ----
//
// MQTT-PUBLISH-style frame: small binary header (~12 bytes), then a long
// JSON body containing the literal the agent typed. The whole frame is
// mostly printable (literal lives in plaintext JSON), but the leading
// bytes are structural — recorded-path won't replay them, the agent has
// to write `generated.frame.code`. Arm 1's high-ratio check misses this
// shape because the global non-printable ratio is tiny; arm 2 catches it
// via the leading-header + literal-after-header anchor.

function leadingHeaderFrameWithLiteral(literal, overrides = {}) {
  // Mirrors the actual Messenger capture shape: a short binary prefix
  // (MQTT PUBLISH `0x32 0xfd 0x09 0x00`) followed by a printable topic
  // string with a single null-byte separator, then the JSON body. First
  // 64 bytes contain ~4 non-printable bytes (ratio 0.06) — below arm 1's
  // 0.15 threshold, so only arm 2 fires.
  const header = String.fromCharCode(0x32, 0xfd, 0x09, 0x00);
  const topic = '/ls_req' + String.fromCharCode(0x00) + 'topic_inbox_v1_long_printable_path';
  const jsonBody =
    `{"epoch_id":"123456","otid":"7891011","tasks":[{"label":"send","text":"${literal}","trace_id":"abc-def","ts":1700000000}]}`;
  return fakeWsFrame({
    payload: header + topic + jsonBody,
    direction: 'sent',
    ...overrides,
  });
}

test('_advisory: leading-header frame (mostly printable JSON body) fires arm 2', () => {
  const ws = [leadingHeaderFrameWithLiteral('Hello-from-klura-2026-04-16')];
  const r = shapeNetworkLog([], { text_contains: 'Hello-from-klura-2026-04-16' }, ws);
  assert.ok(r._advisory, 'expected advisory on response');
  assert.strictEqual(r._advisory.kind, 'binary_ws_frame');
  assert.strictEqual(r._advisory.evidence.signature, 'leading_binary_header');
  assert.strictEqual(r._advisory.evidence.first_byte, '0x32');
  assert.ok(r._advisory.evidence.literal_at_offset >= 8);
  // The frame is mostly printable — global ratio should be well below 0.15.
  assert.ok(r._advisory.evidence.non_printable_ratio < 0.15);
});

test('_advisory: leading-header arm requires text_contains anchor (no anchor → no fire)', () => {
  const ws = [leadingHeaderFrameWithLiteral('Hello-from-klura')];
  const r = shapeNetworkLog([], {}, ws);
  // Without text_contains, the leading-header arm does not fire — the
  // literal anchor is what distinguishes "wrapped write" from "heartbeat
  // that happens to start with a control byte." Arm 1 also misses it
  // (frame is mostly printable). Result: no advisory.
  assert.strictEqual(r._advisory, undefined);
});

test('_advisory: leading-header arm requires literal AT/AFTER header bytes', () => {
  // Literal lives inside the binary header (before offset 8) — the leading
  // bytes aren't structural-prefix-then-payload, the literal IS the prefix.
  // Skip the advisory; this is something else.
  const literal = 'X';
  const header = String.fromCharCode(0x01, 0x02);
  const payload = header + literal + 'a'.repeat(200); // literal at offset 2
  const ws = [fakeWsFrame({ payload, direction: 'sent' })];
  const r = shapeNetworkLog([], { text_contains: literal }, ws);
  assert.strictEqual(r._advisory, undefined);
});

test('_advisory: text-only WS frame starting with newline does not fire (LF is printable)', () => {
  const ws = [
    fakeWsFrame({
      payload: '\n{"type":"ping","text":"klura-test-literal"}',
      direction: 'sent',
    }),
  ];
  const r = shapeNetworkLog([], { text_contains: 'klura-test-literal' }, ws);
  assert.strictEqual(r._advisory, undefined);
});

test('_advisory: single stray control byte followed by printable text does not fire', () => {
  // \x01ACK + literal-laden text — only 1 of first 8 bytes non-printable,
  // below BINARY_WS_HEADER_MIN_NON_PRINTABLE (2). Catches lightweight
  // ack-prefixed protocols without lighting them up as MQTT.
  const ws = [
    fakeWsFrame({
      payload: '\x01ACK okay text klura-test-literal here and more printable bytes',
      direction: 'sent',
    }),
  ];
  const r = shapeNetworkLog([], { text_contains: 'klura-test-literal' }, ws);
  assert.strictEqual(r._advisory, undefined);
});

test('_advisory: high-ratio binary frame still surfaces signature high_non_printable_ratio', () => {
  const ws = [binaryWsFrameWithLiteral('klura-test-literal')];
  const r = shapeNetworkLog([], { text_contains: 'klura-test-literal' }, ws);
  assert.ok(r._advisory);
  assert.strictEqual(r._advisory.evidence.signature, 'high_non_printable_ratio');
});
