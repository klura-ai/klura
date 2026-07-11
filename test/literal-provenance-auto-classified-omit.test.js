// literal_provenance: an item shown with `auto_classified` may be OMITTED from
// audit_answers, and the audit fills in that classification.
//
// The behavior has always existed (validate() falls back to item.auto_classified
// when the path is absent from the answer), but the agent-facing
// `expectedAnswerShape` never said so. Observed cost on the real-site batch: cold
// agents overrode a correct `auto_classified: {caller_input: "query"}` with a
// wrong `"static"`, drawing 1-2 extra save_strategy rejection rounds each. The
// teaching now lives in the rejection envelope; these tests lock in both halves.

import test from 'node:test';
import assert from 'node:assert/strict';

const { literalProvenanceClassifier } = await import(
  '../dist/audit/lift/save-strategy-classifiers.js'
);

// A fetch strategy whose endpoint carries a `{{query}}` placeholder. The runtime
// auto-classifies that literal as {caller_input: "query"}.
function strategyWithPlaceholder() {
  return {
    strategy: 'fetch',
    baseUrl: 'https://hn.algolia.com',
    endpoint: '/api/v1/search?query={{query}}&tags=story',
    method: 'GET',
    response: { format: 'json' },
    notes: { params: { query: { description: 'search text', kind: 'text' } } },
  };
}

const ctx = {
  capability: 'search_stories',
  observedSiblings: [],
  observedParamValues: {},
  capturedEndpointPaths: new Set(),
  session: {},
};

test('the endpoint literal is surfaced with an auto_classified caller_input hint', () => {
  const items = literalProvenanceClassifier.buildItems(strategyWithPlaceholder(), ctx);
  const endpointItem = items.find((i) => i.path === 'endpoint');
  assert.ok(endpointItem, 'endpoint is a scanned literal item');
  assert.deepEqual(
    endpointItem.auto_classified,
    { caller_input: 'query' },
    'runtime derived the classification from the {{query}} placeholder',
  );
});

test('omitting an auto_classified item validates clean — the audit fills it in', () => {
  const strategy = strategyWithPlaceholder();
  // Empty answer: the agent supplied nothing for `endpoint`.
  const issues = literalProvenanceClassifier.validate(strategy, ctx, {});
  assert.deepEqual(
    issues,
    [],
    `omitting the auto_classified endpoint should raise no issues; got ${JSON.stringify(issues)}`,
  );
});

test('overriding with the wrong classification IS rejected (the trap the agent fell into)', () => {
  const strategy = strategyWithPlaceholder();
  // "static" contradicts the {{query}} placeholder — the exact wrong answer the
  // real-site cold agents sent before correcting.
  const issues = literalProvenanceClassifier.validate(strategy, ctx, { endpoint: 'static' });
  assert.ok(
    issues.length > 0,
    'classifying a placeholder-bearing endpoint as "static" must be rejected',
  );
});

test('expectedAnswerShape teaches that auto_classified items can be omitted', () => {
  const shape = literalProvenanceClassifier.expectedAnswerShape;
  assert.match(shape, /auto_classified/, 'names the auto_classified field');
  assert.match(
    shape,
    /omit/i,
    'tells the agent it can omit those items rather than guessing at a value',
  );
});
