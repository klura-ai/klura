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
