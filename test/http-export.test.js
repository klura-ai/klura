// The `fetch` tier is the fastest one the pipeline can reach and the one it
// works hardest for. The package format has always carried
// PublicHttpStrategyV1, so a fetch capability that could not ship was blocked
// by the review path alone.
//
// What matters most here is what is REFUSED. The local tier can express things
// the public profile cannot, and a strategy exported minus its dynamic parts is
// not the strategy that was verified — it is a different request that happens
// to compile.

import test from 'node:test';
import assert from 'node:assert';

import {
  exportReviewedLocalFetchStrategySource,
  compileTemplateExpression,
} from '../dist/factory/public-package/http-export.js';

const base = (over = {}) => ({
  local_strategy: {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://api.example.com',
    endpoint: '/search/{{query}}',
    params: { page: '{{page}}', limit: '24' },
    ...over,
  },
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: { query: { type: 'string' }, page: { type: 'string' } },
  },
  strategy_id: 'search_v1',
  context: 'node',
  replay: 'safe_read',
  response_body_limit_bytes: 1_000_000,
});

const props = new Set(['query', 'page']);

test('a caller placeholder compiles to an input read, not a literal', () => {
  const expr = compileTemplateExpression('/search/{{query}}', props, 'f');
  assert.equal(expr.op, 'concat');
  assert.deepEqual(expr.values[0], { op: 'literal', value: '/search/' });
  assert.equal(expr.values[1].op, 'input');
  assert.equal(expr.values[1].pointer, '/query');
});

test('a template with no placeholders is a single literal', () => {
  assert.deepEqual(compileTemplateExpression('/static', props, 'f'), {
    op: 'literal',
    value: '/static',
  });
});

test('a bare placeholder is the input expression alone', () => {
  assert.deepEqual(compileTemplateExpression('{{query}}', props, 'f'), {
    op: 'input',
    pointer: '/query',
  });
});

test('an undeclared placeholder is refused and names what is declared', () => {
  // Exporting it as a literal would bake the author's own value into every
  // caller's request — the exact failure the contract exists to prevent.
  assert.throws(
    () => compileTemplateExpression('/x/{{secret_id}}', props, 'f'),
    (e) => /not a top-level property/.test(e.message) && /query, page/.test(e.message),
  );
});

test('a full fetch strategy exports to an http_request strategy', () => {
  const out = exportReviewedLocalFetchStrategySource(base());
  assert.equal(out.kind, 'http_request');
  assert.equal(out.context, 'node');
  assert.equal(out.request.method, 'GET');
  assert.equal(out.request.base_url, 'https://api.example.com');
  assert.equal(out.request.query.limit.op, 'literal');
  assert.equal(out.request.query.page.op, 'input');
  assert.deepEqual(out.prerequisites, []);
  assert.equal(out.projection.kind, 'json');
});

test('a generated value is refused rather than dropped', () => {
  // `{{__gen.timestamp}}` is local JavaScript evaluated per call. Exporting the
  // request without it ships a strategy nobody verified.
  assert.throws(
    () =>
      exportReviewedLocalFetchStrategySource(
        base({ generated: { timestamp: { code: 'String(Date.now())' } } }),
      ),
    (e) => /must be absent/.test(e.message) && /timestamp/.test(e.message),
  );
});

test('the generated-value refusal points at the tier that can express it', () => {
  try {
    exportReviewedLocalFetchStrategySource(
      base({ generated: { nonce: { code: 'Math.random()' } } }),
    );
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /page-script tier/);
  }
});

test('a generated placeholder in the endpoint is refused by name', () => {
  assert.throws(
    () => compileTemplateExpression('/s?_dt={{__gen.timestamp}}', props, 'f'),
    (e) => /__gen\.timestamp/.test(e.message) && /page-script tier/.test(e.message),
  );
});

test('a prerequisite is refused: a packaged http strategy has no page', () => {
  assert.throws(
    () =>
      exportReviewedLocalFetchStrategySource(
        base({ prerequisites: [{ kind: 'page-extract', name: 'token' }] }),
      ),
    /must be empty/,
  );
});

test('a non-fetch local strategy is refused', () => {
  assert.throws(
    () => exportReviewedLocalFetchStrategySource(base({ strategy: 'page-script' })),
    /must be fetch/,
  );
});

test('a method outside the public profile is refused', () => {
  assert.throws(
    () => exportReviewedLocalFetchStrategySource(base({ method: 'DELETE' })),
    /must be GET or POST/,
  );
});

test('a GET carrying a body is refused', () => {
  assert.throws(
    () => exportReviewedLocalFetchStrategySource(base({ body: '{"a":1}' })),
    /must be absent for a GET request/,
  );
});

test('a POST body compiles with its caller placeholders', () => {
  const out = exportReviewedLocalFetchStrategySource(
    base({ method: 'POST', body: '{"q":"{{query}}"}' }),
  );
  assert.equal(out.request.body.op, 'concat');
  assert.ok(out.request.body.values.some((v) => v.op === 'input' && v.pointer === '/query'));
});

test('headers compile the same way as query params', () => {
  const out = exportReviewedLocalFetchStrategySource(
    base({ headers: { 'x-token': '{{query}}', accept: 'application/json' } }),
  );
  assert.equal(out.request.headers['x-token'].op, 'input');
  assert.equal(out.request.headers.accept.op, 'literal');
});

test('replay and context are carried from the review, not guessed', () => {
  const out = exportReviewedLocalFetchStrategySource({
    ...base(),
    context: 'browser',
    replay: 'indeterminate',
  });
  assert.equal(out.context, 'browser');
  assert.equal(out.replay, 'indeterminate');
});

test('an unknown review field is refused rather than ignored', () => {
  assert.throws(
    () => exportReviewedLocalFetchStrategySource({ ...base(), surprise: true }),
    /surprise|unexpected|unrecognized/i,
  );
});

// A cookie / ad-consent interstitial is not a login and not a captcha. Agents
// hitting one reached for `other`, which reads as "the capability is wrong" and
// sends someone to debug a capability that is fine — the remedy is one human
// clearing the gate once.
test('consent_required is a blocking kind that escalates like the other gates', async () => {
  const { ABORT_KIND_VALUES } = await import('../dist/tools/abort_session.js');
  assert.ok(ABORT_KIND_VALUES.includes('consent_required'));
});

// Four real corpus strategies were refused for carrying `num_results_per_page:
// 24` as a number. The synthetic fixtures above use only strings, which is why
// the corpus caught this and the tests did not.

test('a numeric query param is a literal, not a rejection', () => {
  const out = exportReviewedLocalFetchStrategySource(
    base({ params: { num_results_per_page: 24, q: '{{query}}' } }),
  );
  assert.deepEqual(out.request.query.num_results_per_page, { op: 'literal', value: 24 });
  assert.equal(out.request.query.q.op, 'input');
});

test('number, boolean and null params export as the text they put on the wire', () => {
  const out = exportReviewedLocalFetchStrategySource(
    base({ params: { exact: true, cursor: null, limit: 24 } }),
  );
  assert.deepEqual(out.request.query.exact, { op: 'literal', value: 'true' });
  assert.deepEqual(out.request.query.cursor, { op: 'literal', value: 'null' });
  assert.deepEqual(out.request.query.limit, { op: 'literal', value: '24' });
});

test('a param that is neither scalar nor string is still refused', () => {
  assert.throws(
    () => exportReviewedLocalFetchStrategySource(base({ params: { nested: { a: 1 } } })),
    /must be a string, number, boolean or null/,
  );
});

test('an html response exports its extraction as the public html projection', () => {
  const out = exportReviewedLocalFetchStrategySource(
    base({
      response: {
        format: 'html',
        extract: {
          title: { selector: '#productTitle' },
          links: { selector: 'a[href^="/"]', attr: 'href', multiple: true },
          results: {
            selector: 'div[data-component-type="s-search-result"]',
            multiple: true,
            fields: {
              asin: { selector: '', attr: 'data-asin' },
              title: { selector: 'h2', attr: 'aria-label' },
              tags: { selector: 'span.tag', multiple: true },
            },
          },
        },
      },
    }),
  );
  assert.deepEqual(out.projection, {
    kind: 'html',
    extract: {
      title: { selector: '#productTitle', attr: null, multiple: false, fields: null },
      links: { selector: 'a[href^="/"]', attr: 'href', multiple: true, fields: null },
      results: {
        selector: 'div[data-component-type="s-search-result"]',
        attr: null,
        multiple: true,
        fields: {
          asin: { selector: null, attr: 'data-asin', multiple: false },
          title: { selector: 'h2', attr: 'aria-label', multiple: false },
          tags: { selector: 'span.tag', attr: null, multiple: true },
        },
      },
    },
  });
});

test('a json response stays a json projection and a json extract is refused', () => {
  assert.deepEqual(
    exportReviewedLocalFetchStrategySource(base({ response: { format: 'json' } })).projection,
    { kind: 'json' },
  );
  assert.throws(
    () =>
      exportReviewedLocalFetchStrategySource(
        base({ response: { format: 'json', extract: { id: { selector: 'x' } } } }),
      ),
    /declare what to read as the outcome projection/,
  );
});

test('a script-text json leaf and a prerequisite-bound result are refused by name', () => {
  assert.throws(
    () =>
      exportReviewedLocalFetchStrategySource(
        base({
          response: {
            format: 'html',
            extract: { data: { selector: 'script#__NEXT_DATA__', json: 'props.pageProps' } },
          },
        }),
      ),
    /dot-path read of script text/,
  );
  assert.throws(
    () =>
      exportReviewedLocalFetchStrategySource(
        base({ response: { from: 'search_results', format: 'json' } }),
      ),
    /bound from a prerequisite/,
  );
});

test('a saved header keeps its value under its canonical lowercase name', () => {
  const out = exportReviewedLocalFetchStrategySource(
    base({ headers: { Accept: 'application/json', 'X-Client': 'klura' } }),
  );
  assert.deepEqual(out.request.headers, {
    accept: { op: 'literal', value: 'application/json' },
    'x-client': { op: 'literal', value: 'klura' },
  });
});
