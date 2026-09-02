import path from 'node:path';
import {
  parseBoundedRecord,
  parseCapabilityId,
  parseInteger,
  parsePackageId,
  parsePackageVersion,
  parseSessionName,
  parseStableContractId,
  parseString,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  type PackageIdV1,
} from '../public/contracts/common';
import { assertJsonValue, canonicalJson, type JsonValueV1 } from '../public/contracts/json';
import { parseRunOutputFormat } from './scrape/output';
import { parseRunId, parseRunOperationId } from './scrape/journal';
import {
  KluraConsumerClientV1,
  type ConsumerCapabilitySelectorV1,
  type ConsumerStartRunOptionsV1,
} from './client';
import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../public/mcp-tool';

export const MCP_STRUCTURED_CONTENT_MAX_BYTES_V1 = 20_480;

type ConsumerMcpOperationV1 =
  | 'search'
  | 'show'
  | 'install'
  | 'list_installed'
  | 'remove'
  | 'doctor'
  | 'clear_session'
  | 'open_login'
  | 'complete_login'
  | 'call'
  | 'start_run'
  | 'get_run'
  | 'list_runs'
  | 'list_run_items'
  | 'wait_run'
  | 'resume_run'
  | 'cancel_run'
  | 'discard_run';

type ConsumerMcpClientV1 = Pick<
  KluraConsumerClientV1,
  | 'search'
  | 'show'
  | 'install'
  | 'installed'
  | 'remove'
  | 'doctor'
  | 'clearSession'
  | 'openLogin'
  | 'completeLogin'
  | 'call'
  | 'startRun'
  | 'getRun'
  | 'listRuns'
  | 'listRunItems'
  | 'waitRun'
  | 'waitRunState'
  | 'resumeRun'
  | 'cancelRun'
  | 'discardRun'
>;

/**
 * Consumer MCP definitions are an adapter only: all managed behavior stays in
 * KluraConsumerClientV1 and its local daemon.
 */
export function createConsumerMcpTools(
  client: ConsumerMcpClientV1 = new KluraConsumerClientV1({
    inline_output_max_bytes: MCP_STRUCTURED_CONTENT_MAX_BYTES_V1,
  }),
): ToolDef[] {
  return [
    definition(
      TOOL_NAMES.searchPackages,
      'Search the signed local-tool catalog. Install a selected package before calling it.',
      objectSchema({
        query: { type: 'string', maxLength: 512 },
        cursor: { type: 'string', maxLength: 1024 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      }),
      { readOnlyHint: true },
      'search',
      async (args) => {
        const record = parseMcpRecord(args, 'search_packages', ['query', 'cursor', 'limit']);
        const query =
          record.query === undefined ? undefined : parseString(record.query, 'query', 512);
        const cursor =
          record.cursor === undefined ? undefined : parseString(record.cursor, 'cursor', 1_024);
        const limit =
          record.limit === undefined ? undefined : parseInteger(record.limit, 'limit', 1, 50);
        return client.search(query, {
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        });
      },
    ),
    definition(
      TOOL_NAMES.showPackage,
      'Show one signed package or one capability without installing it.',
      objectSchema(
        {
          package_id: { type: 'string' },
          version: { type: 'string' },
          capability: { type: 'string' },
        },
        ['package_id'],
      ),
      { readOnlyHint: true },
      'show',
      async (args) => client.show(parseShowInput(args)),
    ),
    definition(
      TOOL_NAMES.installPackage,
      'Verify and activate one signed package in the local package store.',
      objectSchema({ package_id: { type: 'string' }, version: { type: 'string' } }, ['package_id']),
      { idempotentHint: true },
      'install',
      async (args) => client.install(parsePackageSelector(args, 'install_package')),
    ),
    definition(
      TOOL_NAMES.listInstalledPackages,
      'List locally active packages with a structural cursor.',
      objectSchema({
        cursor: { type: 'string', maxLength: 1024 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      }),
      { readOnlyHint: true },
      'list_installed',
      (args) => {
        const record = parseMcpRecord(args, 'list_installed_packages', ['cursor', 'limit']);
        return client.installed({
          ...(record.cursor === undefined
            ? {}
            : { cursor: parseString(record.cursor, 'cursor', 1_024) }),
          ...(record.limit === undefined
            ? {}
            : { limit: parseInteger(record.limit, 'limit', 1, 100) }),
        });
      },
    ),
    definition(
      TOOL_NAMES.removePackage,
      'Remove one active package pointer; immutable artifacts used by runs remain local.',
      objectSchema({ package_id: { type: 'string' } }, ['package_id']),
      { destructiveHint: true, idempotentHint: true },
      'remove',
      (args) =>
        client.remove(
          parsePackageId(
            parseMcpRecord(args, 'remove_package', ['package_id'], ['package_id']).package_id,
            'package_id',
          ),
        ),
    ),
    definition(
      TOOL_NAMES.runConsumerDoctor,
      'Inspect local package state and live scheduler contention without sending target traffic.',
      objectSchema({}),
      { readOnlyHint: true },
      'doctor',
      (args) => {
        parseMcpRecord(args, 'run_consumer_doctor', []);
        return client.doctor();
      },
    ),
    definition(
      TOOL_NAMES.clearPackageSession,
      'Remove one locally encrypted browser session without changing its installed package.',
      objectSchema(
        {
          package_id: { type: 'string' },
          authentication_contract_id: { type: 'string' },
          session_name: { type: 'string' },
        },
        ['package_id'],
      ),
      { destructiveHint: true, idempotentHint: true },
      'clear_session',
      (args) => {
        const record = parseMcpRecord(
          args,
          'clear_package_session',
          ['package_id', 'authentication_contract_id', 'session_name'],
          ['package_id'],
        );
        return client.clearSession(parsePackageId(record.package_id, 'package_id'), {
          ...(record.authentication_contract_id === undefined
            ? {}
            : {
                authentication_contract_id: parseStableContractId(
                  record.authentication_contract_id,
                  'authentication_contract_id',
                ),
              }),
          ...(record.session_name === undefined
            ? {}
            : { session_name: parseSessionName(record.session_name, 'session_name') }),
        });
      },
    ),
    definition(
      TOOL_NAMES.openPackageLogin,
      "Open one package realm's signed local login browser. After the user finishes, call complete_package_login.",
      objectSchema(
        {
          package_id: { type: 'string' },
          authentication_contract_id: { type: 'string' },
          session_name: { type: 'string' },
        },
        ['package_id'],
      ),
      { openWorldHint: true },
      'open_login',
      (args) => {
        const record = parseMcpRecord(
          args,
          'open_package_login',
          ['package_id', 'authentication_contract_id', 'session_name'],
          ['package_id'],
        );
        return client.openLogin(parsePackageId(record.package_id, 'package_id'), {
          ...(record.authentication_contract_id === undefined
            ? {}
            : {
                authentication_contract_id: parseStableContractId(
                  record.authentication_contract_id,
                  'authentication_contract_id',
                ),
              }),
          ...(record.session_name === undefined
            ? {}
            : { session_name: parseSessionName(record.session_name, 'session_name') }),
        });
      },
    ),
    definition(
      TOOL_NAMES.completePackageLogin,
      'Verify one completed local login and save its encrypted browser session only on the declared authenticated outcome.',
      objectSchema({ interaction_id: { type: 'string', maxLength: 48 } }, ['interaction_id']),
      { openWorldHint: true },
      'complete_login',
      (args) => {
        const record = parseMcpRecord(
          args,
          'complete_package_login',
          ['interaction_id'],
          ['interaction_id'],
        );
        return client.completeLogin(parseString(record.interaction_id, 'interaction_id', 48));
      },
    ),
    definition(
      TOOL_NAMES.callPackageCapability,
      'Call one installed read capability and return its typed verified outcome or failure.',
      objectSchema(
        {
          package_id: { type: 'string' },
          capability: { type: 'string' },
          input: {},
          session_name: { type: 'string' },
          timeout_ms: { type: 'integer', minimum: 1, maximum: 300000 },
        },
        ['package_id', 'capability', 'input'],
      ),
      { readOnlyHint: true, openWorldHint: true },
      'call',
      async (args) => {
        const record = parseMcpRecord(
          args,
          'call_package_capability',
          ['package_id', 'capability', 'input', 'session_name', 'timeout_ms'],
          ['package_id', 'capability', 'input'],
        );
        assertJsonValue(record.input, 'input', PUBLIC_CONTRACT_LIMITS.maxDepth);
        return client.call(parseCapabilitySelector(record), record.input, {
          ...(record.session_name === undefined
            ? {}
            : { session_name: parseSessionName(record.session_name, 'session_name') }),
          ...(record.timeout_ms === undefined
            ? {}
            : { timeout_ms: parseInteger(record.timeout_ms, 'timeout_ms', 1, 300_000) }),
        });
      },
    ),
    definition(
      TOOL_NAMES.startScrapeRun,
      'Start a durable local scrape run; session_name selects its pinned local browser session.',
      objectSchema(
        {
          package_id: { type: 'string' },
          capability: { type: 'string' },
          input: {},
          options: { type: 'object' },
        },
        ['package_id', 'capability', 'input', 'options'],
      ),
      { openWorldHint: true },
      'start_run',
      async (args) => {
        const record = parseMcpRecord(
          args,
          'start_scrape_run',
          ['package_id', 'capability', 'input', 'options'],
          ['package_id', 'capability', 'input', 'options'],
        );
        assertJsonValue(record.input, 'input', PUBLIC_CONTRACT_LIMITS.maxDepth);
        return client.startRun(
          parseCapabilitySelector(record),
          record.input,
          parseStartRunOptions(record.options),
        );
      },
    ),
    definition(
      TOOL_NAMES.getScrapeRun,
      'Read the current durable state of one local scrape run.',
      objectSchema({ run_id: { type: 'string' } }, ['run_id']),
      { readOnlyHint: true },
      'get_run',
      (args) =>
        client.getRun(
          parseRunId(
            parseMcpRecord(args, 'get_scrape_run', ['run_id'], ['run_id']).run_id,
            'run_id',
          ),
        ),
    ),
    definition(
      TOOL_NAMES.listScrapeRuns,
      'List a bounded cursor page of local scrape runs and quarantined corrupt journals.',
      objectSchema({
        cursor: { type: 'string', maxLength: 1024 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      }),
      { readOnlyHint: true },
      'list_runs',
      (args) => {
        const record = parseMcpRecord(args, 'list_scrape_runs', ['cursor', 'limit']);
        return client.listRuns({
          ...(record.cursor === undefined
            ? {}
            : { cursor: parseString(record.cursor, 'cursor', 1_024) }),
          ...(record.limit === undefined
            ? {}
            : { limit: parseInteger(record.limit, 'limit', 1, 100) }),
        });
      },
    ),
    definition(
      TOOL_NAMES.listScrapeRunItems,
      'Read one bounded page of durably committed scrape items.',
      objectSchema(
        {
          run_id: { type: 'string' },
          after_sequence: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        ['run_id'],
      ),
      { readOnlyHint: true },
      'list_run_items',
      (args) => {
        const record = parseMcpRecord(
          args,
          'list_scrape_run_items',
          ['run_id', 'after_sequence', 'limit'],
          ['run_id'],
        );
        return client.listRunItems(parseRunId(record.run_id, 'run_id'), {
          ...(record.after_sequence === undefined
            ? {}
            : { after_sequence: parseInteger(record.after_sequence, 'after_sequence', 0, 1e9) }),
          ...(record.limit === undefined
            ? {}
            : { limit: parseInteger(record.limit, 'limit', 1, 100) }),
        });
      },
    ),
    definition(
      TOOL_NAMES.waitScrapeRun,
      'Return the current local scrape state or wait once for its durable journal version to advance.',
      objectSchema(
        {
          run_id: { type: 'string' },
          after_state_version: { type: 'integer', minimum: 0 },
          wait_timeout_ms: { type: 'integer', minimum: 0, maximum: 25_000 },
        },
        ['run_id'],
      ),
      { readOnlyHint: true },
      'wait_run',
      (args) => {
        const record = parseMcpRecord(
          args,
          'wait_scrape_run',
          ['run_id', 'after_state_version', 'wait_timeout_ms'],
          ['run_id'],
        );
        return client.waitRunState(parseRunId(record.run_id, 'run_id'), {
          ...(record.after_state_version === undefined
            ? {}
            : {
                after_state_version: parseInteger(
                  record.after_state_version,
                  'after_state_version',
                  0,
                  Number.MAX_SAFE_INTEGER,
                ),
              }),
          ...(record.wait_timeout_ms === undefined
            ? {}
            : {
                wait_timeout_ms: parseInteger(record.wait_timeout_ms, 'wait_timeout_ms', 0, 25_000),
              }),
        });
      },
    ),
    definition(
      TOOL_NAMES.resumeScrapeRun,
      'Resume one interrupted local scrape run from its exact immutable artifact.',
      objectSchema({ run_id: { type: 'string' }, operation_id: { type: 'string' } }, ['run_id']),
      { openWorldHint: true },
      'resume_run',
      (args) => {
        const record = parseMcpRecord(
          args,
          'resume_scrape_run',
          ['run_id', 'operation_id'],
          ['run_id'],
        );
        return client.resumeRun(
          parseRunId(record.run_id, 'run_id'),
          parseRunCommandOptions(record),
        );
      },
    ),
    definition(
      TOOL_NAMES.cancelScrapeRun,
      'Durably cancel one active local scrape run.',
      objectSchema({ run_id: { type: 'string' }, operation_id: { type: 'string' } }, ['run_id']),
      { destructiveHint: true },
      'cancel_run',
      (args) => {
        const record = parseMcpRecord(
          args,
          'cancel_scrape_run',
          ['run_id', 'operation_id'],
          ['run_id'],
        );
        return client.cancelRun(
          parseRunId(record.run_id, 'run_id'),
          'mcp_cancel',
          parseRunCommandOptions(record),
        );
      },
    ),
    definition(
      TOOL_NAMES.discardScrapeRun,
      'Discard one quarantined corrupt local run after host confirmation.',
      objectSchema({ run_id: { type: 'string' }, operation_id: { type: 'string' } }, ['run_id']),
      { destructiveHint: true },
      'discard_run',
      (args) => {
        const record = parseMcpRecord(
          args,
          'discard_scrape_run',
          ['run_id', 'operation_id'],
          ['run_id'],
        );
        return client.discardRun(
          parseRunId(record.run_id, 'run_id'),
          parseRunCommandOptions(record),
        );
      },
    ),
  ];
}

export const TOOL_DEFS = createConsumerMcpTools();

function definition(
  name: ToolDef['name'],
  description: string,
  inputSchema: ToolDef['inputSchema'],
  annotations: NonNullable<ToolDef['annotations']>,
  operation: ConsumerMcpOperationV1,
  handler: (args: unknown) => Promise<unknown> | object | string | number | boolean | null,
): ToolDef {
  return {
    name,
    description,
    inputSchema,
    annotations,
    responseSurface: 'consumer',
    handler: async (args) => {
      try {
        return boundMcpResult(await handler(args), operation);
      } catch (error) {
        if (error instanceof PublicContractError) {
          return mcpFailure(operation, knownPackageId(args), 'invalid_options');
        }
        throw error;
      }
    },
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): ToolDef['inputSchema'] {
  return { type: 'object', properties, required, additionalProperties: false };
}

function parseShowInput(value: unknown): Record<string, unknown> {
  const record = parseMcpRecord(
    value,
    'show_package',
    ['package_id', 'version', 'capability'],
    ['package_id'],
  );
  const result: Record<string, unknown> = {
    package_id: parsePackageId(record.package_id, 'package_id'),
  };
  if (record.version !== undefined) result.version = parsePackageVersion(record.version, 'version');
  if (record.capability !== undefined)
    result.capability = parseCapabilityId(record.capability, 'capability');
  return result;
}

function parsePackageSelector(value: unknown, field: string): Record<string, unknown> {
  const record = parseMcpRecord(value, field, ['package_id', 'version'], ['package_id']);
  const result: Record<string, unknown> = {
    package_id: parsePackageId(record.package_id, 'package_id'),
  };
  if (record.version !== undefined) result.version = parsePackageVersion(record.version, 'version');
  return result;
}

function parseCapabilitySelector(record: Record<string, unknown>): ConsumerCapabilitySelectorV1 {
  return {
    package_id: parsePackageId(record.package_id, 'package_id'),
    capability: parseCapabilityId(record.capability, 'capability'),
  };
}

function parseStartRunOptions(value: unknown): ConsumerStartRunOptionsV1 {
  const record = parseMcpRecord(value, 'start_scrape_run.options', [
    'operation_id',
    'input_mode_id',
    'session_name',
    'output',
    'max_items',
    'max_pages',
    'max_requests',
    'timeout_ms',
    'max_concurrency',
    'limits',
  ]);
  const options: ConsumerStartRunOptionsV1 = {};
  if (record.operation_id !== undefined) {
    options.operation_id = parseRunOperationId(record.operation_id, 'operation_id');
  }
  if (record.session_name !== undefined) {
    options.session_name = parseSessionName(record.session_name, 'session_name');
  }
  if (record.input_mode_id !== undefined) {
    options.input_mode_id = parseStableContractId(record.input_mode_id, 'input_mode_id');
  }
  if (record.output !== undefined) options.output = parseMcpOutput(record.output);
  for (const key of [
    'max_items',
    'max_pages',
    'max_requests',
    'timeout_ms',
    'max_concurrency',
  ] as const) {
    if (record[key] !== undefined) options[key] = parseInteger(record[key], key, 1, 1e9);
  }
  if (record.limits !== undefined) {
    const limits = parseBoundedRecord(record.limits, 'limits', 64);
    const parsed: Record<string, number> = {};
    for (const [key, limit] of Object.entries(limits)) {
      parseStableContractId(key, `limits.${key}`);
      parsed[key] = parseInteger(limit, `limits.${key}`, 1, 1e9);
    }
    options.limits = parsed;
  }
  return options;
}

function parseRunCommandOptions(record: Record<string, unknown>): { operation_id?: string } {
  if (record.operation_id === undefined) return {};
  return { operation_id: parseRunOperationId(record.operation_id, 'operation_id') };
}

function parseMcpOutput(value: unknown): ConsumerStartRunOptionsV1['output'] {
  const record = parseMcpRecord(value, 'output', ['kind', 'path', 'format'], ['kind']);
  if (record.kind === 'inline') {
    parseMcpRecord(value, 'output', ['kind'], ['kind']);
    return { kind: 'inline' };
  }
  const file = parseMcpRecord(
    value,
    'output',
    ['kind', 'path', 'format'],
    ['kind', 'path', 'format'],
  );
  if (file.kind !== 'file' || typeof file.path !== 'string' || !path.isAbsolute(file.path)) {
    throw new PublicContractError('output', 'must use an absolute file path');
  }
  return {
    kind: 'file',
    path: file.path,
    format: parseRunOutputFormat(file.format, 'output.format'),
  };
}

function parseMcpRecord(
  value: unknown,
  field: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new PublicContractError(`${field}.${key}`, 'is not allowed');
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) {
      throw new PublicContractError(field, `is missing required key ${JSON.stringify(key)}`);
    }
  }
  return record;
}

function boundMcpResult(value: unknown, operation: ConsumerMcpOperationV1): JsonValueV1 {
  try {
    assertJsonValue(value, 'consumer_mcp_result', PUBLIC_CONTRACT_LIMITS.maxDepth);
    if (Buffer.byteLength(canonicalJson(value), 'utf8') <= MCP_STRUCTURED_CONTENT_MAX_BYTES_V1) {
      return value;
    }
  } catch {
    // Fall through to the bounded adapter failure below.
  }
  return mcpFailure(operation, null, 'output_too_large_for_adapter');
}

function mcpFailure(
  operation: ConsumerMcpOperationV1,
  packageId: PackageIdV1 | null,
  code: 'invalid_options' | 'output_too_large_for_adapter',
): JsonValueV1 {
  return {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation,
    code,
    retryable: false,
    package_id: packageId,
  };
}

function knownPackageId(value: unknown): PackageIdV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    return parsePackageId((value as Record<string, unknown>).package_id, 'package_id');
  } catch {
    return null;
  }
}
