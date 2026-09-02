import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BrowserInteractionExecutionError,
  executeBrowserInteractionProgram,
} = require('../dist/consumer/execution/public-browser/interaction-executor.js');
const { PublicCallerV1 } = require('../dist/consumer/call.js');
const { PublicHttpExecutionError } = require('../dist/consumer/execution/node-http.js');

function action(kind, extra = {}) {
  return {
    action_id: 'action',
    kind,
    target: { frame: { kind: 'main' }, selector: 'button' },
    expect: {
      wait: null,
      egress_rule_ids: [],
      minimum_matching_requests: 0,
      maximum_matching_requests: 0,
    },
    ...extra,
  };
}

function pageWithLocator(locator) {
  return {
    locator: () => locator,
    viewportSize: () => ({ width: 1280, height: 720 }),
    mouse: { wheel: async () => undefined },
  };
}

function input(page, program, network) {
  return {
    page,
    program,
    projection: { item_selector: 'item', cardinality: 'one', fields: { id: {} } },
    maximum_output_bytes: 1024,
    expression_context: { input: {}, bindings: {} },
    strategy_id: 'strategy',
    network,
    signal: new AbortController().signal,
    timeout_ms: 1000,
  };
}

test('browser interaction invokes only the declared first-party action and closes its egress scope', async () => {
  let clicks = 0;
  let finished = 0;
  const locator = {
    count: async () => 1,
    click: async () => {
      clicks += 1;
    },
  };
  const network = {
    beginAction: (current) => ({ action_id: current.action_id }),
    finishAction: async () => {
      finished += 1;
    },
    abortAction: () => assert.fail('action must not abort'),
    waitForQuiet: async () => assert.fail('quiet wait is not declared'),
  };
  const result = await executeBrowserInteractionProgram(
    input(pageWithLocator(locator), { initial: [action('click')], repeat: null }, network),
  );
  assert.equal(result, null);
  assert.equal(clicks, 1);
  assert.equal(finished, 1);
});

test('browser interaction rejects a non-string fill expression as a typed failure', async () => {
  const locator = { count: async () => 1, fill: async () => assert.fail('must not fill') };
  const network = {
    beginAction: (current) => ({ action_id: current.action_id }),
    finishAction: async () => assert.fail('must not finish'),
    abortAction: () => undefined,
    waitForQuiet: async () => assert.fail('quiet wait is not declared'),
  };
  await assert.rejects(
    executeBrowserInteractionProgram(
      input(
        pageWithLocator(locator),
        {
          initial: [action('fill', { value: { op: 'literal', value: 1 } })],
          repeat: null,
        },
        network,
      ),
    ),
    (error) =>
      error instanceof BrowserInteractionExecutionError && error.failure.code === 'value_invalid',
  );
});

test('browser interaction binds an egress mismatch to its triggering action', async () => {
  const locator = { count: async () => 1, click: async () => undefined };
  const network = {
    beginAction: (current) => ({ action_id: current.action_id }),
    finishAction: async () => {
      throw new Error('unexpected request');
    },
    abortAction: () => undefined,
    waitForQuiet: async () => assert.fail('quiet wait is not declared'),
  };
  await assert.rejects(
    executeBrowserInteractionProgram(
      input(pageWithLocator(locator), { initial: [action('click')], repeat: null }, network),
    ),
    (error) =>
      error instanceof BrowserInteractionExecutionError &&
      error.failure.code === 'action_egress_mismatch' &&
      error.failure.action_id === 'action',
  );
});

test('public caller returns the typed interaction failure without retrying it', async () => {
  const failure = {
    kind: 'browser_interaction_failed',
    strategy_id: 'strategy',
    code: 'target_not_found',
    action_id: 'action',
    round: 0,
  };
  const caller = new PublicCallerV1(undefined, undefined, async () => {
    throw new PublicHttpExecutionError('browser_interaction_failed', 'missing target', 1, failure);
  });
  const result = await caller.call(
    {
      strategies: [{ kind: 'browser_navigation', strategy_id: 'strategy' }],
      authentication: { mode: 'none' },
      max_target_requests_per_call: 2,
      call_timeouts: { per_request_timeout_ms: 1000, total_timeout_ms: 1000 },
      call_retry_policy: {
        max_retries: 1,
        on: ['transport_failure'],
        base_delay_ms: 1,
        max_delay_ms: 1,
        jitter_ratio: 0,
        honor_structural_retry_after: false,
      },
    },
    {},
  );
  assert.deepEqual(result, {
    kind: 'failure',
    code: 'browser_interaction_failed',
    attempts: 1,
    cause: failure,
  });
});
