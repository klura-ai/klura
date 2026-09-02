// Consumer contract parity tests. The consumer tool contracts are the single
// definition of every consumer tool input: published MCP schemas must be
// generated from them, wire contracts must cover every daemon consumer
// route, and adapter bounds must equal what the domain caller-bounds parser
// accepts. Snapshots lock the load-bearing published schemas so a generator
// regression cannot silently degrade a tool input back to a bare object.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createConsumerMcpTools } = require('../dist/consumer/mcp-tools.js');
const {
  CONSUMER_TOOL_CONTRACTS,
  CONSUMER_WIRE_CONTRACTS,
  RUN_CANCELLATION_SOURCES,
  RUN_OUTPUT_FORMATS,
  parseConsumerArgs,
  parseConsumerWireBody,
  startScrapeRunOptionsContract,
  toolInputJsonSchema,
} = require('../dist/consumer/contracts/tool-contracts.js');
const {
  CALLER_BOUND_KEYS,
  CONSUMER_BOUNDS,
  CONSUMER_LIMITS_MAX_ENTRIES_V1,
} = require('../dist/public/contracts/consumer-bounds.js');
const {
  parseScrapeCallerBounds,
  parseScrapeCallerLimitMap,
} = require('../dist/public/contracts/scrape-policy.js');
const { PublicContractError } = require('../dist/public/contracts/common.js');
const { parseRunOutputFormat } = require('../dist/consumer/scrape/output.js');
const { TOOL_NAMES } = require('../dist/vocab/index.js');

test('every consumer tool publishes exactly the schema generated from its contract', () => {
  const tools = createConsumerMcpTools({});
  assert.equal(tools.length, Object.keys(CONSUMER_TOOL_CONTRACTS).length);
  for (const tool of tools) {
    const contract = CONSUMER_TOOL_CONTRACTS[tool.name];
    assert.ok(contract, `${tool.name} has no argument contract`);
    assert.deepEqual(tool.inputSchema, toolInputJsonSchema(contract));
  }
});

test('generated schemas and contract parsers share one keyset per tool', () => {
  for (const [name, contract] of Object.entries(CONSUMER_TOOL_CONTRACTS)) {
    const schema = toolInputJsonSchema(contract);
    assert.equal(schema.type, 'object', name);
    assert.equal(schema.additionalProperties, false, name);
    assert.deepEqual(Object.keys(schema.properties), Object.keys(contract.fields), name);
    assert.deepEqual(
      schema.required,
      Object.entries(contract.fields)
        .filter(([, field]) => field.required)
        .map(([key]) => key),
      name,
    );
    for (const key of Object.keys(contract.fields)) {
      assert.equal(typeof schema.properties[key], 'object', `${name}.${key}`);
    }
  }
});

test('start_scrape_run publishes its complete ten-field options contract', () => {
  const callerBound = {
    type: 'integer',
    minimum: 1,
    maximum: 3_600_000,
  };
  assert.deepEqual(toolInputJsonSchema(CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.startScrapeRun]), {
    type: 'object',
    properties: {
      package_id: { type: 'string' },
      capability: { type: 'string' },
      input: {},
      options: {
        type: 'object',
        properties: {
          operation_id: { type: 'string' },
          input_mode_id: { type: 'string' },
          session_name: { type: 'string' },
          output: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['inline', 'file'] },
              path: { type: 'string' },
              format: { type: 'string', enum: ['json', 'ndjson', 'csv'] },
            },
            required: ['kind'],
            additionalProperties: false,
          },
          max_items: callerBound,
          max_pages: callerBound,
          max_requests: callerBound,
          timeout_ms: callerBound,
          max_concurrency: callerBound,
          limits: {
            type: 'object',
            additionalProperties: { type: 'integer', minimum: 1, maximum: 1_000_000 },
            maxProperties: 64,
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    required: ['package_id', 'capability', 'input', 'options'],
    additionalProperties: false,
  });
});

test('bounded consumer tool schemas publish their exact shared bounds', () => {
  assert.deepEqual(toolInputJsonSchema(CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.callPackageCapability]), {
    type: 'object',
    properties: {
      package_id: { type: 'string' },
      capability: { type: 'string' },
      input: {},
      session_name: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 1, maximum: 300_000 },
    },
    required: ['package_id', 'capability', 'input'],
    additionalProperties: false,
  });
  assert.deepEqual(toolInputJsonSchema(CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.waitScrapeRun]), {
    type: 'object',
    properties: {
      run_id: { type: 'string' },
      after_state_version: { type: 'integer', minimum: 0 },
      wait_timeout_ms: { type: 'integer', minimum: 0, maximum: 25_000 },
    },
    required: ['run_id'],
    additionalProperties: false,
  });
  assert.deepEqual(toolInputJsonSchema(CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.listScrapeRunItems]), {
    type: 'object',
    properties: {
      run_id: { type: 'string' },
      after_sequence: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['run_id'],
    additionalProperties: false,
  });
});

test('adapter caller bounds equal what the domain caller-bounds parser accepts', () => {
  assert.equal(CONSUMER_BOUNDS.caller_bound.maximum, 3_600_000);
  assert.equal(CONSUMER_BOUNDS.caller_limit.maximum, 1_000_000);
  assert.equal(CONSUMER_LIMITS_MAX_ENTRIES_V1, 64);
  assert.deepEqual(
    parseScrapeCallerBounds({ max_items: CONSUMER_BOUNDS.caller_bound.maximum }, 'bounds'),
    { max_items: 3_600_000 },
  );
  assert.throws(
    () => parseScrapeCallerBounds({ max_items: CONSUMER_BOUNDS.caller_bound.maximum + 1 }, 'bounds'),
    (error) => error instanceof PublicContractError && error.field === 'bounds.max_items',
  );
  assert.deepEqual(
    parseScrapeCallerLimitMap({ per_seed: CONSUMER_BOUNDS.caller_limit.maximum }, 'limits'),
    { per_seed: 1_000_000 },
  );
  assert.throws(
    () =>
      parseScrapeCallerLimitMap({ per_seed: CONSUMER_BOUNDS.caller_limit.maximum + 1 }, 'limits'),
    (error) => error instanceof PublicContractError && error.field === 'limits.per_seed',
  );
  assert.throws(
    () =>
      parseScrapeCallerLimitMap(
        Object.fromEntries(
          Array.from({ length: CONSUMER_LIMITS_MAX_ENTRIES_V1 + 1 }, (_, index) => [
            `limit_${index}`,
            1,
          ]),
        ),
        'limits',
      ),
    (error) => error instanceof PublicContractError && /at most 64 entries/.test(error.message),
  );
  const options = parseConsumerArgs(
    startScrapeRunOptionsContract,
    Object.fromEntries(CALLER_BOUND_KEYS.map((key) => [key, CONSUMER_BOUNDS.caller_bound.maximum])),
    'start_run.options',
  );
  for (const key of CALLER_BOUND_KEYS) {
    assert.equal(options[key], CONSUMER_BOUNDS.caller_bound.maximum);
  }
  assert.throws(
    () =>
      parseConsumerArgs(
        startScrapeRunOptionsContract,
        { max_items: CONSUMER_BOUNDS.caller_bound.maximum + 1 },
        'start_run.options',
      ),
    (error) =>
      error instanceof PublicContractError && error.field === 'start_run.options.max_items',
  );
});

test('every daemon consumer route has exactly one wire contract', () => {
  assert.deepEqual(Object.keys(CONSUMER_WIRE_CONTRACTS).sort(), [
    '/consumer/call',
    '/consumer/doctor',
    '/consumer/install',
    '/consumer/installed',
    '/consumer/login/complete',
    '/consumer/login/open',
    '/consumer/remove',
    '/consumer/run',
    '/consumer/runs/cancel',
    '/consumer/runs/discard',
    '/consumer/runs/items',
    '/consumer/runs/items/follow',
    '/consumer/runs/list',
    '/consumer/runs/resume',
    '/consumer/runs/show',
    '/consumer/runs/wait',
    '/consumer/runs/wait-state',
    '/consumer/search',
    '/consumer/session/clear',
    '/consumer/show',
  ]);
});

test('wire bodies enforce the exact keyset, null-for-absent, and shared bounds', () => {
  const callContract = CONSUMER_WIRE_CONTRACTS['/consumer/call'];
  assert.deepEqual(
    parseConsumerWireBody(
      callContract,
      {
        package_id: 'ikea',
        capability: 'get_product',
        input: { id: '42' },
        session_name: null,
        timeout_ms: null,
      },
      'consumer.call',
    ),
    {
      package_id: 'ikea',
      capability: 'get_product',
      input: { id: '42' },
      session_name: null,
      timeout_ms: null,
    },
  );
  assert.throws(
    () =>
      parseConsumerWireBody(
        callContract,
        {
          package_id: 'ikea',
          capability: 'get_product',
          input: {},
          session_name: null,
          timeout_ms: null,
          unexpected: true,
        },
        'consumer.call',
      ),
    (error) => error instanceof PublicContractError && error.field === 'consumer.call.unexpected',
  );
  assert.throws(
    () =>
      parseConsumerWireBody(
        callContract,
        { package_id: 'ikea', capability: 'get_product', input: {}, session_name: null },
        'consumer.call',
      ),
    (error) =>
      error instanceof PublicContractError && /missing required key "timeout_ms"/.test(error.message),
  );
  assert.throws(
    () =>
      parseConsumerWireBody(
        CONSUMER_WIRE_CONTRACTS['/consumer/run'],
        {
          package_id: 'ikea',
          capability: 'get_product',
          input: { id: '42' },
          caller_bounds: { max_items: 5_000_000 },
          input_mode_id: null,
          output: null,
          inline_output_max_bytes: null,
          session_name: null,
          detach: true,
          operation_id: 'op_v1_11111111111111111111111111111111',
        },
        'consumer.run',
      ),
    (error) =>
      error instanceof PublicContractError &&
      error.field === 'consumer.run.caller_bounds.max_items',
  );
});

test('declared enum lists parse through their owning validators and reject strangers', () => {
  for (const format of RUN_OUTPUT_FORMATS) {
    assert.equal(parseRunOutputFormat(format, 'format'), format);
  }
  assert.throws(
    () => parseRunOutputFormat('xml', 'format'),
    (error) => error instanceof PublicContractError,
  );
  const cancelContract = CONSUMER_WIRE_CONTRACTS['/consumer/runs/cancel'];
  for (const source of RUN_CANCELLATION_SOURCES) {
    const record = parseConsumerWireBody(
      cancelContract,
      {
        run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        source,
        operation_id: 'op_v1_11111111111111111111111111111111',
      },
      'consumer.runs.cancel',
    );
    assert.equal(record.source, source);
  }
  assert.throws(
    () =>
      parseConsumerWireBody(
        cancelContract,
        {
          run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          source: 'other',
          operation_id: 'op_v1_11111111111111111111111111111111',
        },
        'consumer.runs.cancel',
      ),
    (error) =>
      error instanceof PublicContractError && error.field === 'consumer.runs.cancel.source',
  );
});
