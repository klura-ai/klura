import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { projectHtml, decodeHtmlBody } = require('../dist/consumer/execution/html-projection.js');
const { parseHtmlProjection } = require('../dist/public/contracts/html-projection.js');
const { parsePublicHtmlResponse } = require('../dist/consumer/execution/node-http.js');
const { PublicContractError } = require('../dist/public/contracts/common.js');

const PAGE = `<!doctype html><html><body>
  <h1 id="title">  Desk lamp  </h1>
  <ul class="results">
    <li class="row" data-asin="A1"><h2>First</h2><a href="/p/1">go</a><span class="tag">x</span><span class="tag">y</span></li>
    <li class="row" data-asin="A2"><h2>Second</h2><a href="/p/2">go</a></li>
  </ul>
  <a class="social" href="https://example.test/a">A</a>
  <a class="social" href="https://example.test/b">B</a>
</body></html>`;

test('an html projection reads leaves, rows, and attributes with fixed shapes', () => {
  const projection = parseHtmlProjection(
    {
      kind: 'html',
      extract: {
        title: { selector: '#title', attr: null, multiple: false, fields: null },
        missing: { selector: '#nope', attr: null, multiple: false, fields: null },
        socials: { selector: 'a.social', attr: 'href', multiple: true, fields: null },
        none: { selector: 'a.none', attr: 'href', multiple: true, fields: null },
        results: {
          selector: 'li.row',
          attr: null,
          multiple: true,
          fields: {
            asin: { selector: null, attr: 'data-asin', multiple: false },
            title: { selector: 'h2', attr: null, multiple: false },
            url: { selector: 'a', attr: 'href', multiple: false },
            tags: { selector: 'span.tag', attr: null, multiple: true },
            absent: { selector: 'em', attr: null, multiple: false },
          },
        },
        first: {
          selector: 'li.row',
          attr: null,
          multiple: false,
          fields: { title: { selector: 'h2', attr: null, multiple: false } },
        },
        no_rows: {
          selector: 'li.other',
          attr: null,
          multiple: false,
          fields: { title: { selector: 'h2', attr: null, multiple: false } },
        },
      },
    },
    'projection',
  );
  assert.deepEqual(projectHtml(PAGE, projection), {
    title: 'Desk lamp',
    missing: '',
    socials: ['https://example.test/a', 'https://example.test/b'],
    none: [],
    results: [
      { asin: 'A1', title: 'First', url: '/p/1', tags: 'x,y', absent: '' },
      { asin: 'A2', title: 'Second', url: '/p/2', tags: '', absent: '' },
    ],
    first: { title: 'First' },
    no_rows: {},
  });
});

test('an html projection is bounded and refuses what it cannot review', () => {
  const base = (over) => ({
    kind: 'html',
    extract: { item: { selector: 'li', attr: null, multiple: false, fields: null, ...over } },
  });
  assert.throws(
    () => parseHtmlProjection({ kind: 'html', extract: {} }, 'p'),
    (error) => error instanceof PublicContractError && /at least one extraction/.test(error.message),
  );
  assert.throws(
    () => parseHtmlProjection(base({ json: 'a.b' }), 'p'),
    (error) => error instanceof PublicContractError && /is not allowed/.test(error.message),
  );
  assert.throws(
    () => parseHtmlProjection(base({ selector: 'li::before' }), 'p'),
    (error) => error instanceof PublicContractError && /non-element selector/.test(error.message),
  );
  assert.throws(
    () =>
      parseHtmlProjection(
        base({ attr: 'href', fields: { t: { selector: 'h2', attr: null, multiple: false } } }),
        'p',
      ),
    (error) => error instanceof PublicContractError && /row has no attribute/.test(error.message),
  );
  assert.throws(
    () => parseHtmlProjection({ kind: 'html', extract: { 'bad key': base().extract.item } }, 'p'),
    (error) => error instanceof PublicContractError && /identifier-shaped/.test(error.message),
  );
  assert.equal(
    parseHtmlProjection(base({ selector: 'a:has(h2):not(.x)' }), 'p').extract.item.selector,
    'a:has(h2):not(.x)',
  );
});

test('an html response projects into one json object and refuses a non-document', () => {
  const projection = parseHtmlProjection(
    {
      kind: 'html',
      extract: { title: { selector: '#title', attr: null, multiple: false, fields: null } },
    },
    'projection',
  );
  const response = parsePublicHtmlResponse(
    {
      status: 200,
      headers: { 'content-type': 'text/html; charset=ISO-8859-1' },
      bytes: Buffer.from(PAGE.replace('Desk lamp', 'Bordslampa \xe5'), 'latin1'),
    },
    projection,
  );
  assert.equal(response.body_kind, 'json_object');
  assert.equal(response.media_type, 'text/html');
  assert.deepEqual(response.body, { title: 'Bordslampa å' });
  assert.throws(
    () =>
      parsePublicHtmlResponse(
        { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from('{}') },
        projection,
      ),
    (error) => error.code === 'response_contract_mismatch',
  );
  for (const declared of ['application/xhtml+xml', 'text/vnd.reddit.partial+html; charset=utf-8']) {
    assert.equal(
      parsePublicHtmlResponse(
        { status: 200, headers: { 'content-type': declared }, bytes: Buffer.from(PAGE) },
        projection,
      ).body.title,
      'Desk lamp',
    );
  }
  assert.equal(decodeHtmlBody(Buffer.from('<p>ok</p>'), undefined), '<p>ok</p>');
});
