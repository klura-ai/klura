// Tests for extractFromHtml's nested-fields support and the strict
// responseExtractEntrySchema. Covers the listing-shaped per-row extraction
// path that listing strategies (search results, product cards) want, and
// the save-time rejection of silently-degraded shapes.

import test from 'node:test';
import assert from 'node:assert';
import { extractFromHtml } from '../dist/response/html-extract.js';
import { responseExtractEntrySchema, responseSchema } from '../dist/strategies/schemas/response.js';

// ---- extractFromHtml: nested fields ----

const HTML_SEARCH_RESULTS = `
<div class="results">
  <div class="s-result-item" data-asin="B001">
    <h2><a href="/dp/B001">Product One</a></h2>
    <span class="price">$10.00</span>
    <span class="rating">4.5</span>
  </div>
  <div class="s-result-item" data-asin="B002">
    <h2><a href="/dp/B002">Product Two</a></h2>
    <span class="price">$20.00</span>
    <span class="rating">3.8</span>
  </div>
</div>
`;

test('nested fields + multiple:true produces structured rows', () => {
  const out = extractFromHtml(HTML_SEARCH_RESULTS, {
    results: {
      selector: '.s-result-item',
      multiple: true,
      fields: {
        asin: { selector: '', attr: 'data-asin' },
        title: { selector: 'h2 a' },
        price: { selector: '.price' },
        rating: { selector: '.rating' },
      },
    },
  });
  assert.ok(Array.isArray(out.results), 'results is an array');
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.results[0], {
    asin: 'B001',
    title: 'Product One',
    price: '$10.00',
    rating: '4.5',
  });
  assert.deepEqual(out.results[1], {
    asin: 'B002',
    title: 'Product Two',
    price: '$20.00',
    rating: '3.8',
  });
});

test('nested fields with multiple:false returns a single row record', () => {
  const out = extractFromHtml(HTML_SEARCH_RESULTS, {
    first: {
      selector: '.s-result-item',
      multiple: false,
      fields: {
        title: { selector: 'h2 a' },
        price: { selector: '.price' },
      },
    },
  });
  assert.deepEqual(out.first, { title: 'Product One', price: '$10.00' });
});

test('empty fields selector reads from the row element itself', () => {
  const out = extractFromHtml(HTML_SEARCH_RESULTS, {
    asins: {
      selector: '.s-result-item',
      multiple: true,
      fields: {
        asin: { selector: '', attr: 'data-asin' },
      },
    },
  });
  assert.deepEqual(out.asins, [{ asin: 'B001' }, { asin: 'B002' }]);
});

test('field with no match returns empty string, row still present', () => {
  const out = extractFromHtml(HTML_SEARCH_RESULTS, {
    rows: {
      selector: '.s-result-item',
      multiple: true,
      fields: {
        title: { selector: 'h2 a' },
        missing: { selector: '.does-not-exist' },
      },
    },
  });
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].missing, '');
  assert.equal(out.rows[0].title, 'Product One');
});

test('no row matches with multiple:true returns empty array', () => {
  const out = extractFromHtml(HTML_SEARCH_RESULTS, {
    rows: {
      selector: '.nothing-here',
      multiple: true,
      fields: { title: { selector: 'h2' } },
    },
  });
  assert.deepEqual(out.rows, []);
});

test('flat leaf entries (existing behavior) unaffected', () => {
  const out = extractFromHtml(HTML_SEARCH_RESULTS, {
    titles: { selector: '.s-result-item h2 a', multiple: true },
    firstPrice: { selector: '.price' },
  });
  assert.deepEqual(out.titles, ['Product One', 'Product Two']);
  assert.equal(out.firstPrice, '$10.00');
});

// ---- responseExtractEntrySchema: strict shape validation ----

test('schema accepts leaf entry {selector, attr?, multiple?}', () => {
  const parsed = responseExtractEntrySchema.parse({ selector: '.x', multiple: true });
  assert.equal(parsed.selector, '.x');
  assert.equal(parsed.multiple, true);
});

test('schema accepts row-group with fields + multiple', () => {
  const parsed = responseExtractEntrySchema.parse({
    selector: '.row',
    multiple: true,
    fields: {
      title: { selector: 'h2' },
      asin: { selector: '', attr: 'data-asin' },
    },
  });
  assert.equal(parsed.selector, '.row');
  assert.ok(parsed.fields);
});

test('schema rejects unknown top-level keys (silently-degraded shapes)', () => {
  const res = responseExtractEntrySchema.safeParse({
    selector: '.row',
    multiple: true,
    columns: { title: { selector: 'h2' } },
  });
  assert.equal(res.success, false);
  const issues = res.error.issues.map((i) => i.code);
  assert.ok(
    issues.includes('unrecognized_keys'),
    `expected unrecognized_keys, got ${JSON.stringify(issues)}`,
  );
});

test('schema rejects `attr` + `fields` combo', () => {
  const res = responseExtractEntrySchema.safeParse({
    selector: '.row',
    multiple: true,
    attr: 'data-asin',
    fields: { title: { selector: 'h2' } },
  });
  assert.equal(res.success, false);
  assert.ok(
    res.error.issues.some((i) => i.message.includes('mutually exclusive')),
    `expected mutually-exclusive message, got ${JSON.stringify(res.error.issues)}`,
  );
});

test('schema rejects `fields` without explicit `multiple`', () => {
  const res = responseExtractEntrySchema.safeParse({
    selector: '.row',
    fields: { title: { selector: 'h2' } },
  });
  assert.equal(res.success, false);
  assert.ok(
    res.error.issues.some((i) => i.message.includes('explicit `multiple`')),
    `expected explicit-multiple message, got ${JSON.stringify(res.error.issues)}`,
  );
});

test('schema rejects nested fields-inside-fields (one level only)', () => {
  const res = responseExtractEntrySchema.safeParse({
    selector: '.row',
    multiple: true,
    fields: {
      group: { selector: '.x', fields: { y: { selector: 'z' } } },
    },
  });
  assert.equal(res.success, false);
});

test('responseSchema parses a full extract block end-to-end', () => {
  const parsed = responseSchema.parse({
    format: 'html',
    extract: {
      results: {
        selector: '.s-result-item',
        multiple: true,
        fields: {
          title: { selector: 'h2' },
          price: { selector: '.price' },
        },
      },
    },
  });
  assert.equal(parsed.format, 'html');
  assert.ok(parsed.extract?.results);
});

// ---- extractFromHtml: `json` dot-path into script-tag payloads ----

const HTML_EMBEDDED_JSON = `
<html><body>
  <h1>Rounded: 422.5K</h1>
  <script id="__DATA__" type="application/json">
    {"scope":{"user":{"name":"NASA","stats":{"followers":422500,"verified":true,"rank":0}},
     "items":[{"id":"a"},{"id":"b"}]}}
  </script>
  <script id="__BROKEN__" type="application/json">{not valid json</script>
</body></html>
`;

test('json dot-path returns raw scalars, not stringified ones', () => {
  const out = extractFromHtml(HTML_EMBEDDED_JSON, {
    followers: { selector: '#__DATA__', json: 'scope.user.stats.followers' },
    verified: { selector: '#__DATA__', json: 'scope.user.stats.verified' },
    rank: { selector: '#__DATA__', json: 'scope.user.stats.rank' },
  });
  assert.strictEqual(out.followers, 422500);
  assert.strictEqual(out.verified, true);
  assert.strictEqual(out.rank, 0);
});

test('json dot-path returns nested objects and arrays intact', () => {
  const out = extractFromHtml(HTML_EMBEDDED_JSON, {
    user: { selector: '#__DATA__', json: 'scope.user' },
    items: { selector: '#__DATA__', json: 'scope.items' },
    second: { selector: '#__DATA__', json: 'scope.items[1].id' },
  });
  assert.deepStrictEqual(out.user, {
    name: 'NASA',
    stats: { followers: 422500, verified: true, rank: 0 },
  });
  assert.deepStrictEqual(out.items, [{ id: 'a' }, { id: 'b' }]);
  assert.strictEqual(out.second, 'b');
});

test('json:"" returns the whole parsed document', () => {
  const out = extractFromHtml(HTML_EMBEDDED_JSON, {
    all: { selector: '#__DATA__', json: '' },
  });
  assert.deepStrictEqual(Object.keys(out.all), ['scope']);
});

test('json dot-path that does not resolve returns empty string', () => {
  const out = extractFromHtml(HTML_EMBEDDED_JSON, {
    missing: { selector: '#__DATA__', json: 'scope.user.nope.deeper' },
  });
  assert.strictEqual(out.missing, '');
});

test('unparseable script text returns empty string, never throws', () => {
  const out = extractFromHtml(HTML_EMBEDDED_JSON, {
    broken: { selector: '#__BROKEN__', json: 'anything' },
    absent: { selector: '#__NOT_THERE__', json: 'anything' },
  });
  assert.strictEqual(out.broken, '');
  assert.strictEqual(out.absent, '');
});

test('json + multiple:true yields one resolved value per matched element', () => {
  const html = `
    <div class="card"><script type="application/ld+json">{"name":"One","offers":{"price":10}}</script></div>
    <div class="card"><script type="application/ld+json">{"name":"Two","offers":{"price":20}}</script></div>
  `;
  const out = extractFromHtml(html, {
    prices: { selector: 'script[type="application/ld+json"]', json: 'offers.price', multiple: true },
  });
  assert.deepStrictEqual(out.prices, [10, 20]);
});

test('json inside a row-group field is scoped to its row', () => {
  const html = `
    <div class="card"><span class="t">One</span><script class="j">{"price":10}</script></div>
    <div class="card"><span class="t">Two</span><script class="j">{"price":20}</script></div>
  `;
  const out = extractFromHtml(html, {
    rows: {
      selector: '.card',
      multiple: true,
      fields: { title: { selector: '.t' }, price: { selector: '.j', json: 'price' } },
    },
  });
  assert.deepStrictEqual(out.rows, [
    { title: 'One', price: 10 },
    { title: 'Two', price: 20 },
  ]);
});

test('schema accepts a json leaf and rejects json combined with attr or fields', () => {
  assert.equal(
    responseExtractEntrySchema.safeParse({ selector: '#d', json: 'a.b' }).success,
    true,
  );
  assert.equal(
    responseExtractEntrySchema.safeParse({ selector: '#d', json: 'a.b', attr: 'href' }).success,
    false,
  );
  assert.equal(
    responseExtractEntrySchema.safeParse({
      selector: '#d',
      json: 'a.b',
      multiple: true,
      fields: { x: { selector: '.x' } },
    }).success,
    false,
  );
});

test('schema rejects json + attr inside a row-group field', () => {
  const res = responseExtractEntrySchema.safeParse({
    selector: '.card',
    multiple: true,
    fields: { price: { selector: '.j', json: 'price', attr: 'content' } },
  });
  assert.equal(res.success, false);
});

// ---- json dot-path: keys that contain dots ----
//
// Rehydration blobs routinely namespace their scope keys ("webapp.user-detail",
// "seo.abtest"), so a bare `.` split would shred them into segments that
// resolve to nothing. Bracket-quoted keys are what make those blobs reachable.

const HTML_DOTTED_KEYS = `
<script id="__SCOPE__" type="application/json">
{"__DEFAULT_SCOPE__":{"webapp.user-detail":{"userInfo":{"user":{"id":"678","nickname":"NatGeo"},
 "stats":{"followerCount":9600000}}},"seo.abtest":{"canonical":"/@natgeo"}}}
</script>
`;

test('bracket-quoted keys address segments containing dots', () => {
  const out = extractFromHtml(HTML_DOTTED_KEYS, {
    nickname: {
      selector: '#__SCOPE__',
      json: '__DEFAULT_SCOPE__["webapp.user-detail"].userInfo.user.nickname',
    },
    followers: {
      selector: '#__SCOPE__',
      json: '__DEFAULT_SCOPE__["webapp.user-detail"].userInfo.stats.followerCount',
    },
    canonical: { selector: '#__SCOPE__', json: `__DEFAULT_SCOPE__['seo.abtest'].canonical` },
  });
  assert.strictEqual(out.nickname, 'NatGeo');
  assert.strictEqual(out.followers, 9600000);
  assert.strictEqual(out.canonical, '/@natgeo');
});

test('a dotted key left unquoted resolves to nothing rather than guessing', () => {
  const out = extractFromHtml(HTML_DOTTED_KEYS, {
    shredded: { selector: '#__SCOPE__', json: '__DEFAULT_SCOPE__.webapp.user-detail.userInfo' },
  });
  assert.strictEqual(out.shredded, '');
});

test('malformed paths resolve to empty, never throw', () => {
  const out = extractFromHtml(HTML_DOTTED_KEYS, {
    unterminatedBracket: { selector: '#__SCOPE__', json: '__DEFAULT_SCOPE__[0' },
    unterminatedQuote: { selector: '#__SCOPE__', json: '__DEFAULT_SCOPE__["webapp' },
    nonNumericIndex: { selector: '#__SCOPE__', json: '__DEFAULT_SCOPE__[abc]' },
  });
  assert.strictEqual(out.unterminatedBracket, '');
  assert.strictEqual(out.unterminatedQuote, '');
  assert.strictEqual(out.nonNumericIndex, '');
});

test('quoted keys and array indices mix in one path', () => {
  const html = `<script id="s">{"a.b":{"rows":[{"id":"x"},{"id":"y"}]}}</script>`;
  const out = extractFromHtml(html, {
    second: { selector: '#s', json: `["a.b"].rows[1].id` },
  });
  assert.strictEqual(out.second, 'y');
});
