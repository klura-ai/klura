import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyFactoryExecutionResult, factoryExecutionWasAccepted } =
  await import('../dist/execution/result-classification.js');

test('factory execution classification covers all six structural states', () => {
  const cases = [
    [{ status: 200, body: { ok: true } }, 'explicit_success'],
    [{ status: 200, body: { ok: false } }, 'explicit_failure'],
    [{ status: 204, body: null }, 'transport_accepted'],
    [{ status: 503, body: {} }, 'transport_failure'],
    [{ status: 0, executionState: 'not_run', body: {} }, 'not_run'],
    [{ status: 0, executionState: 'sent_unconfirmed', body: { sent: true } }, 'delivery_unknown'],
  ];
  for (const [result, expected] of cases) {
    assert.equal(classifyFactoryExecutionResult(result), expected);
  }
});

test('runtime execution state takes precedence over missing or contradictory status', () => {
  assert.equal(
    classifyFactoryExecutionResult({
      executionState: 'not_run',
      body: { ok: true },
    }),
    'not_run',
  );
  assert.equal(
    classifyFactoryExecutionResult({
      status: 200,
      executionState: 'sent_unconfirmed',
      body: { ok: true },
    }),
    'delivery_unknown',
  );
});

test('only explicit success and transport acceptance are accepted', () => {
  for (const classification of [
    'explicit_failure',
    'transport_failure',
    'not_run',
    'delivery_unknown',
  ]) {
    assert.equal(factoryExecutionWasAccepted(classification), false);
  }
  assert.equal(factoryExecutionWasAccepted('explicit_success'), true);
  assert.equal(factoryExecutionWasAccepted('transport_accepted'), true);
});
