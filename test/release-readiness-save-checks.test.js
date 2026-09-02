// Three save-time checks added 2026-08-03 after a full-corpus sweep found
// 12 of 42 saved capabilities returning usable data. Fourteen of the thirty
// failures were not site problems — they were shapes the runtime accepted onto
// disk and then reported as verified:
//
//   1. eight strategies whose response blew the output budget because no
//      extraction was declared, so a caller gets an error envelope forever;
//   2. six with a required param carrying no `example`, so nobody but the
//      author knows what to pass and post-save verification never ran;
//   3. and no surface anywhere reported that a capability had stopped working
//      since the day it was stamped.
//
// Each check below is the enforcement for one of those.

import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyFactoryExecutionResult, isOversizeBodyEnvelope, describeFactoryExecutionFailure } =
  await import('../dist/execution/result-classification.js');
const { detectRequiredParamsWithoutExample } = await import(
  '../dist/gate/save-warnings-param-example.js'
);

// ---------- 1. oversize bodies are failures, not "transport accepted" ----------

test('an oversize envelope classifies as an explicit failure, so it cannot be approved active', () => {
  const body = {
    error: 'response_too_large',
    total_chars: 33451,
    preview: '{"payload":[{"subEntity":...',
  };
  assert.equal(isOversizeBodyEnvelope(body), true);
  assert.equal(classifyFactoryExecutionResult({ status: 200, body }), 'explicit_failure');
});

test('the html-trimmed variant classifies the same way', () => {
  const body = { error: 'response_too_large_html_trimmed', total_chars: 1326388, a11y_tree: '- x' };
  assert.equal(classifyFactoryExecutionResult({ status: 200, body }), 'explicit_failure');
});

test('the failure description names the real cause rather than body.ok', () => {
  const body = { error: 'response_too_large', total_chars: 40000 };
  const described = describeFactoryExecutionFailure('explicit_failure', 200, body);
  assert.match(described, /exceeded the output budget/);
  assert.doesNotMatch(described, /body\.ok/);
});

test('a site field merely called `error` is not mistaken for the runtime envelope', () => {
  // No `total_chars`, and a code the runtime never emits.
  const body = { error: 'INVALID_QUERY', message: 'bad filter' };
  assert.equal(isOversizeBodyEnvelope(body), false);
  assert.equal(classifyFactoryExecutionResult({ status: 200, body }), 'transport_accepted');
});

test('a real payload still classifies as transport_accepted', () => {
  const body = { items: [{ id: 1 }], total: 1 };
  assert.equal(classifyFactoryExecutionResult({ status: 200, body }), 'transport_accepted');
  assert.equal(classifyFactoryExecutionResult({ status: 200, body: { ok: true } }), 'explicit_success');
});

// ---------- 2. required params must document their shape ----------

function strategyWithParams(params) {
  return { strategy: 'page-script', notes: { params } };
}

test('a required param with no example is flagged', () => {
  const warnings = detectRequiredParamsWithoutExample(
    strategyWithParams({ partNumber: { kind: 'id', description: 'Part number.' } }),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /notes\.params\.partNumber\.example/);
});

test('an optional param without an example is left alone', () => {
  const warnings = detectRequiredParamsWithoutExample(
    strategyWithParams({ cursor: { kind: 'id', optional: true } }),
  );
  assert.deepEqual(warnings, []);
});

test('a documented example satisfies the check, including falsy ones', () => {
  assert.deepEqual(
    detectRequiredParamsWithoutExample(strategyWithParams({ q: { kind: 'text', example: 'bakery' } })),
    [],
  );
  assert.deepEqual(
    detectRequiredParamsWithoutExample(strategyWithParams({ page: { kind: 'text', example: 0 } })),
    [],
  );
  assert.deepEqual(
    detectRequiredParamsWithoutExample(strategyWithParams({ flag: { kind: 'text', example: null } })),
    [],
  );
});

test('a bare-string param declaration is flagged — it has no example slot at all', () => {
  const warnings = detectRequiredParamsWithoutExample(
    strategyWithParams({ sku: 'The product SKU.' }),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /notes\.params\.sku\.example/);
});

test('every missing param is reported in one warning, not one rejection each', () => {
  const warnings = detectRequiredParamsWithoutExample(
    strategyWithParams({
      sku: { kind: 'id' },
      storeId: { kind: 'id' },
      ok: { kind: 'text', example: 'x' },
    }),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /2 required params/);
  assert.match(warnings[0].message, /sku/);
  assert.match(warnings[0].message, /storeId/);
  assert.doesNotMatch(warnings[0].message, /notes\.params\.ok\.example/);
});

test('the hint names the credential exception, so a password param has a way through', () => {
  const warnings = detectRequiredParamsWithoutExample(
    strategyWithParams({ password: { kind: 'text' } }),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].hint, /credential/i);
  assert.match(warnings[0].hint, /plaintext/);
});

test('a strategy declaring no params produces nothing', () => {
  assert.deepEqual(detectRequiredParamsWithoutExample({ strategy: 'fetch' }), []);
  assert.deepEqual(detectRequiredParamsWithoutExample(strategyWithParams({})), []);
});
