import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createKluraMcpServer } = require('../mcp-server.js');
const runtimePackage = require('../package.json');
const {
  createConsumerMcpTools,
  MCP_STRUCTURED_CONTENT_MAX_BYTES_V1,
} = require('../dist/consumer/mcp-tools.js');
const { TOOL_NAMES } = require('../dist/vocab/index.js');

test('consumer MCP tools reject unknown input structurally and preserve bounded results', async () => {
  let calls = 0;
  let callOptions;
  let clearOptions;
  let listOptions;
  let waitRunId;
  let waitOptions;
  const tools = createConsumerMcpTools({
    call: async (_selector, _input, options) => {
      calls += 1;
      callOptions = options;
      return { kind: 'large_result', payload: 'x'.repeat(MCP_STRUCTURED_CONTENT_MAX_BYTES_V1) };
    },
    clearSession: async (_packageId, options) => {
      clearOptions = options;
      return {
        result_schema_version: 1,
        kind: 'session_not_found',
        package_id: 'ikea',
        authentication_contract_id: 'account',
        session_name: 'default',
      };
    },
    listRuns: async (options) => {
      listOptions = options;
      return {
        result_schema_version: 1,
        kind: 'runs',
        items: [],
        next_cursor: null,
      };
    },
    waitRunState: async (runId, options) => {
      waitRunId = runId;
      waitOptions = options;
      return {
        result_schema_version: 1,
        kind: 'run_state',
        changed: false,
        snapshot: {
          run_id: runId,
          meta: {},
          state_version: 8,
          lifecycle: { kind: 'nonterminal', last_sequence: 8 },
          committed_item_count: 0,
        },
      };
    },
  });
  const call = tools.find((tool) => tool.name === TOOL_NAMES.callPackageCapability);
  assert.ok(call);
  const invalid = await call.handler({
    package_id: 'ikea',
    capability: 'get_product',
    input: {},
    session_name: 'default',
    unexpected: true,
  });
  assert.deepEqual(invalid, {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation: 'call',
    code: 'invalid_options',
    retryable: false,
    package_id: 'ikea',
  });
  assert.equal(calls, 0);

  const oversized = await call.handler({
    package_id: 'ikea',
    capability: 'get_product',
    input: {},
    session_name: 'default',
  });
  assert.deepEqual(oversized, {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation: 'call',
    code: 'output_too_large_for_adapter',
    retryable: false,
    package_id: null,
  });
  assert.equal(calls, 1);
  assert.deepEqual(callOptions, { session_name: 'default' });

  const clear = tools.find((tool) => tool.name === TOOL_NAMES.clearPackageSession);
  assert.ok(clear);
  assert.deepEqual(
    await clear.handler({
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
    }),
    {
      result_schema_version: 1,
      kind: 'session_not_found',
      package_id: 'ikea',
      authentication_contract_id: 'account',
      session_name: 'default',
    },
  );
  assert.deepEqual(clearOptions, {
    authentication_contract_id: 'account',
    session_name: 'default',
  });

  const listRuns = tools.find((tool) => tool.name === TOOL_NAMES.listScrapeRuns);
  assert.ok(listRuns);
  assert.deepEqual(await listRuns.handler({ cursor: 'page-cursor', limit: 2 }), {
    result_schema_version: 1,
    kind: 'runs',
    items: [],
    next_cursor: null,
  });
  assert.deepEqual(listOptions, { cursor: 'page-cursor', limit: 2 });

  const wait = tools.find((tool) => tool.name === TOOL_NAMES.waitScrapeRun);
  assert.ok(wait);
  assert.deepEqual(
    await wait.handler({
      run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      after_state_version: 8,
      wait_timeout_ms: 0,
    }),
    {
      result_schema_version: 1,
      kind: 'run_state',
      changed: false,
      snapshot: {
        run_id: 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        meta: {},
        state_version: 8,
        lifecycle: { kind: 'nonterminal', last_sequence: 8 },
        committed_item_count: 0,
      },
    },
  );
  assert.equal(waitRunId, 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.deepEqual(waitOptions, { after_state_version: 8, wait_timeout_ms: 0 });
});

test('consumer MCP run mutations preserve a caller-supplied operation identity', async () => {
  let startOptions;
  let resumeOptions;
  let cancelOptions;
  let discardOptions;
  const runId = 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const tools = createConsumerMcpTools({
    startRun: async (_selector, _input, options) => {
      startOptions = options;
      return { kind: 'run_accepted', operation_id: options.operation_id, run_id: runId };
    },
    resumeRun: async (_runId, options) => {
      resumeOptions = options;
      return { kind: 'run_resume_accepted', operation_id: options.operation_id, run_id: runId };
    },
    cancelRun: async (_runId, _source, options) => {
      cancelOptions = options;
      return { kind: 'run_cancellation_requested', operation_id: options.operation_id, run_id: runId };
    },
    discardRun: async (_runId, options) => {
      discardOptions = options;
      return { kind: 'not_quarantined', operation_id: options.operation_id, run_id: runId };
    },
  });
  const start = tools.find((tool) => tool.name === TOOL_NAMES.startScrapeRun);
  const resume = tools.find((tool) => tool.name === TOOL_NAMES.resumeScrapeRun);
  const cancel = tools.find((tool) => tool.name === TOOL_NAMES.cancelScrapeRun);
  const discard = tools.find((tool) => tool.name === TOOL_NAMES.discardScrapeRun);
  assert.ok(start && resume && cancel && discard);

  await start.handler({
    package_id: 'ikea',
    capability: 'get_product',
    input: { id: '42' },
    options: { operation_id: 'op_v1_11111111111111111111111111111111' },
  });
  await resume.handler({ run_id: runId, operation_id: 'op_v1_22222222222222222222222222222222' });
  await cancel.handler({ run_id: runId, operation_id: 'op_v1_33333333333333333333333333333333' });
  await discard.handler({ run_id: runId, operation_id: 'op_v1_44444444444444444444444444444444' });

  assert.deepEqual(startOptions, { operation_id: 'op_v1_11111111111111111111111111111111' });
  assert.deepEqual(resumeOptions, { operation_id: 'op_v1_22222222222222222222222222222222' });
  assert.deepEqual(cancelOptions, { operation_id: 'op_v1_33333333333333333333333333333333' });
  assert.deepEqual(discardOptions, { operation_id: 'op_v1_44444444444444444444444444444444' });
});

test('one MCP server exposes consumer tools with structured content and confirmation hints', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = await createKluraMcpServer({
    consumerClient: {
      search: async () => ({
        result_schema_version: 1,
        kind: 'consumer_failure',
        operation: 'search',
        code: 'registry_unavailable',
        retryable: true,
        package_id: null,
      }),
    },
  });
  const client = new Client({ name: 'klura-consumer-tool-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const search = listed.tools.find((tool) => tool.name === TOOL_NAMES.searchPackages);
    const remove = listed.tools.find((tool) => tool.name === TOOL_NAMES.removePackage);
    assert.ok(search);
    assert.equal(search.annotations?.readOnlyHint, true);
    assert.ok(remove);
    assert.equal(remove.annotations?.destructiveHint, true);

    const result = await client.callTool({ name: TOOL_NAMES.searchPackages, arguments: {} });
    assert.deepEqual(result.structuredContent, {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'search',
      code: 'registry_unavailable',
      retryable: true,
      package_id: null,
    });
    assert.deepEqual(result.content, [{ type: 'text', text: 'Consumer result: consumer_failure' }]);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP server advertises the packaged runtime version', async () => {
  const server = await createKluraMcpServer();
  try {
    assert.equal(server._serverInfo.version, runtimePackage.version);
  } finally {
    await server.close();
  }
});
