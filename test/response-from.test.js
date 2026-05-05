// Cover the `response.from` mechanism end-to-end:
//   - Validation: missing prereq, wrong-kind prereq, recorded-path rejection,
//     fetch/page-script with no endpoint when from is set (should pass).
//   - Helper: applyResponseFrom returns the prereq's parsed value across
//     format=json / format=html / format absent / extract present.
//
// Execution-path integration (running fetch-node / fetch-browser end-to-end)
// is covered indirectly by the field-reports facebook scenario; pulling the
// full pool/session machinery into a unit test isn't worth the complexity
// for what is structurally a 5-line short-circuit.

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateStrategyShape } from '../dist/strategies/skills.js';
import { applyResponseFrom, hasResponseFrom } from '../dist/execution/response-from.js';

function expectReject(data, matcher) {
  assert.throws(
    () => validateStrategyShape(data),
    (err) => {
      assert.match(err.message, /^invalid_strategy:/);
      if (matcher instanceof RegExp) assert.match(err.message, matcher);
      return true;
    },
  );
}

const validJsEvalPrereq = (name = 'threads') => ({
  kind: 'js-eval',
  name,
  url: 'https://example.com',
  expression: 'return JSON.stringify({a:1})',
  binds: name,
  return_shape: { kind: 'string' },
});

// ---------------------------------------------------------------------------
// Validation: page-script + response.from + js-eval prereq, no endpoint
// ---------------------------------------------------------------------------

test('page-script with response.from + js-eval prereq passes without endpoint', () => {
  validateStrategyShape({
    strategy: 'page-script',
    prerequisites: [validJsEvalPrereq()],
    response: { from: 'threads', format: 'json' },
  });
});

test('fetch with response.from + js-eval prereq passes without endpoint', () => {
  validateStrategyShape({
    strategy: 'fetch',
    prerequisites: [validJsEvalPrereq()],
    response: { from: 'threads', format: 'json' },
  });
});

test('response.from with no matching prereq is rejected naming the prereq', () => {
  expectReject(
    {
      strategy: 'page-script',
      prerequisites: [validJsEvalPrereq('other')],
      response: { from: 'threads' },
    },
    /response\.from = "threads" but no prereq with that name/,
  );
});

test('response.from referencing a browser-kind prereq is rejected', () => {
  expectReject(
    {
      strategy: 'page-script',
      prerequisites: [{ kind: 'browser', name: 'login', steps: [{ action: 'navigate', url: 'https://example.com' }] }],
      response: { from: 'login' },
    },
    /references a prereq of kind "browser"/,
  );
});

test('response.from on recorded-path is rejected with a pointer to response.extract', () => {
  expectReject(
    {
      strategy: 'recorded-path',
      steps: [{ id: 'nav', action: 'navigate', url: 'https://example.com' }],
      prerequisites: [validJsEvalPrereq()],
      response: { from: 'threads' },
    },
    /recorded-path\.response\.from is not supported.*use tier "page-script" with response\.from/s,
  );
});

test('endpoint required rejection text mentions response.from as alternative', () => {
  expectReject(
    {
      strategy: 'page-script',
      baseUrl: 'https://example.com',
    },
    /endpoint is required.*response\.from/s,
  );
});

// ---------------------------------------------------------------------------
// Helper: applyResponseFrom
// ---------------------------------------------------------------------------

test('hasResponseFrom returns true only when response.from is non-empty string', () => {
  assert.equal(hasResponseFrom({ response: { from: 'x' } }), true);
  assert.equal(hasResponseFrom({ response: { from: '' } }), false);
  assert.equal(hasResponseFrom({ response: {} }), false);
  assert.equal(hasResponseFrom({}), false);
  assert.equal(hasResponseFrom(null), false);
});

test('applyResponseFrom parses JSON when format:json (default)', () => {
  const result = applyResponseFrom(
    { response: { from: 'threads' } },
    { threads: '{"count": 3, "items": ["a", "b"]}' },
  );
  assert.deepEqual(result.body, { count: 3, items: ['a', 'b'] });
});

test('applyResponseFrom passes raw string through when format:html', () => {
  const result = applyResponseFrom(
    { response: { from: 'page', format: 'html' } },
    { page: '<html><body>hi</body></html>' },
  );
  assert.equal(result.body, '<html><body>hi</body></html>');
});

test('applyResponseFrom applies CSS extraction when format:html + extract', () => {
  const result = applyResponseFrom(
    {
      response: {
        from: 'page',
        format: 'html',
        extract: { title: { selector: 'h1' } },
      },
    },
    { page: '<html><body><h1>The Title</h1></body></html>' },
  );
  assert.deepEqual(result.body, { title: 'The Title' });
});

test('applyResponseFrom throws with a clear message on unparseable JSON', () => {
  assert.throws(
    () =>
      applyResponseFrom(
        { response: { from: 'threads', format: 'json' } },
        { threads: 'not json at all' },
      ),
    /response\.from = "threads".*format:"json".*did not parse as JSON/s,
  );
});

test('applyResponseFrom throws when the named prereq did not produce a value', () => {
  assert.throws(
    () => applyResponseFrom({ response: { from: 'missing' } }, {}),
    /response\.from = "missing" but prereq did not produce a bound value/,
  );
});

test('applyResponseFrom throws when called without response.from set', () => {
  assert.throws(
    () => applyResponseFrom({ response: {} }, { x: '1' }),
    /applyResponseFrom called without response\.from set/,
  );
});
