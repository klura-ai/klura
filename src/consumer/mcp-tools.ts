import path from 'node:path';
import {
  parsePackageId,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  type PackageIdV1,
} from '../public/contracts/common';
import { assertJsonValue, canonicalJson, type JsonValueV1 } from '../public/contracts/json';
import { KluraConsumerClientV1 } from './client';
import {
  CONSUMER_TOOL_CONTRACTS,
  parseConsumerArgs,
  toolInputJsonSchema,
  type ConsumerArgsContractV1,
  type ConsumerArgsOutputV1,
} from './contracts/tool-contracts';
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
 * KluraConsumerClientV1 and its local daemon. Each tool's published input
 * schema is generated from its argument contract, and its handler validates
 * with that same contract before touching the client.
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
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.searchPackages],
      { readOnlyHint: true },
      'search',
      async (record) =>
        client.search(record.query, {
          ...(record.cursor === undefined ? {} : { cursor: record.cursor }),
          ...(record.limit === undefined ? {} : { limit: record.limit }),
        }),
    ),
    definition(
      TOOL_NAMES.showPackage,
      'Show one signed package or one capability without installing it.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.showPackage],
      { readOnlyHint: true },
      'show',
      async (record) => client.show(record),
    ),
    definition(
      TOOL_NAMES.installPackage,
      'Verify and activate one signed package in the local package store.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.installPackage],
      { idempotentHint: true },
      'install',
      async (record) => client.install(record),
    ),
    definition(
      TOOL_NAMES.listInstalledPackages,
      'List locally active packages with a structural cursor.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.listInstalledPackages],
      { readOnlyHint: true },
      'list_installed',
      (record) =>
        client.installed({
          ...(record.cursor === undefined ? {} : { cursor: record.cursor }),
          ...(record.limit === undefined ? {} : { limit: record.limit }),
        }),
    ),
    definition(
      TOOL_NAMES.removePackage,
      'Remove one active package pointer; immutable artifacts used by runs remain local.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.removePackage],
      { destructiveHint: true, idempotentHint: true },
      'remove',
      (record) => client.remove(record.package_id),
    ),
    definition(
      TOOL_NAMES.runConsumerDoctor,
      'Inspect local package state and live scheduler contention without sending target traffic.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.runConsumerDoctor],
      { readOnlyHint: true },
      'doctor',
      () => client.doctor(),
    ),
    definition(
      TOOL_NAMES.clearPackageSession,
      'Remove one locally encrypted browser session without changing its installed package.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.clearPackageSession],
      { destructiveHint: true, idempotentHint: true },
      'clear_session',
      (record) =>
        client.clearSession(record.package_id, {
          ...(record.authentication_contract_id === undefined
            ? {}
            : { authentication_contract_id: record.authentication_contract_id }),
          ...(record.session_name === undefined ? {} : { session_name: record.session_name }),
        }),
    ),
    definition(
      TOOL_NAMES.openPackageLogin,
      "Open one package realm's signed local login browser. After the user finishes, call complete_package_login.",
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.openPackageLogin],
      { openWorldHint: true },
      'open_login',
      (record) =>
        client.openLogin(record.package_id, {
          ...(record.authentication_contract_id === undefined
            ? {}
            : { authentication_contract_id: record.authentication_contract_id }),
          ...(record.session_name === undefined ? {} : { session_name: record.session_name }),
        }),
    ),
    definition(
      TOOL_NAMES.completePackageLogin,
      'Verify one completed local login and save its encrypted browser session only on the declared authenticated outcome.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.completePackageLogin],
      { openWorldHint: true },
      'complete_login',
      (record) => client.completeLogin(record.interaction_id),
    ),
    definition(
      TOOL_NAMES.callPackageCapability,
      'Call one installed read capability and return its typed verified outcome or failure.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.callPackageCapability],
      { readOnlyHint: true, openWorldHint: true },
      'call',
      async (record) =>
        client.call(
          { package_id: record.package_id, capability: record.capability },
          record.input,
          {
            ...(record.session_name === undefined ? {} : { session_name: record.session_name }),
            ...(record.timeout_ms === undefined ? {} : { timeout_ms: record.timeout_ms }),
          },
        ),
    ),
    definition(
      TOOL_NAMES.startScrapeRun,
      'Start a durable local scrape run; session_name selects its pinned local browser session.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.startScrapeRun],
      { openWorldHint: true },
      'start_run',
      async (record) => {
        const output = record.options.output;
        if (output !== undefined && output.kind === 'file' && !path.isAbsolute(output.path)) {
          throw new PublicContractError('output', 'must use an absolute file path');
        }
        return client.startRun(
          { package_id: record.package_id, capability: record.capability },
          record.input,
          record.options,
        );
      },
    ),
    definition(
      TOOL_NAMES.getScrapeRun,
      'Read the current durable state of one local scrape run.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.getScrapeRun],
      { readOnlyHint: true },
      'get_run',
      (record) => client.getRun(record.run_id),
    ),
    definition(
      TOOL_NAMES.listScrapeRuns,
      'List a bounded cursor page of local scrape runs and quarantined corrupt journals.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.listScrapeRuns],
      { readOnlyHint: true },
      'list_runs',
      (record) =>
        client.listRuns({
          ...(record.cursor === undefined ? {} : { cursor: record.cursor }),
          ...(record.limit === undefined ? {} : { limit: record.limit }),
        }),
    ),
    definition(
      TOOL_NAMES.listScrapeRunItems,
      'Read one bounded page of durably committed scrape items.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.listScrapeRunItems],
      { readOnlyHint: true },
      'list_run_items',
      (record) =>
        client.listRunItems(record.run_id, {
          ...(record.after_sequence === undefined ? {} : { after_sequence: record.after_sequence }),
          ...(record.limit === undefined ? {} : { limit: record.limit }),
        }),
    ),
    definition(
      TOOL_NAMES.waitScrapeRun,
      'Return the current local scrape state or wait once for its durable journal version to advance.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.waitScrapeRun],
      { readOnlyHint: true },
      'wait_run',
      (record) =>
        client.waitRunState(record.run_id, {
          ...(record.after_state_version === undefined
            ? {}
            : { after_state_version: record.after_state_version }),
          ...(record.wait_timeout_ms === undefined
            ? {}
            : { wait_timeout_ms: record.wait_timeout_ms }),
        }),
    ),
    definition(
      TOOL_NAMES.resumeScrapeRun,
      'Resume one interrupted local scrape run from its exact immutable artifact.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.resumeScrapeRun],
      { openWorldHint: true },
      'resume_run',
      (record) => client.resumeRun(record.run_id, runCommandOptions(record)),
    ),
    definition(
      TOOL_NAMES.cancelScrapeRun,
      'Durably cancel one active local scrape run.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.cancelScrapeRun],
      { destructiveHint: true },
      'cancel_run',
      (record) => client.cancelRun(record.run_id, 'mcp_cancel', runCommandOptions(record)),
    ),
    definition(
      TOOL_NAMES.discardScrapeRun,
      'Discard one quarantined corrupt local run after host confirmation.',
      CONSUMER_TOOL_CONTRACTS[TOOL_NAMES.discardScrapeRun],
      { destructiveHint: true },
      'discard_run',
      (record) => client.discardRun(record.run_id, runCommandOptions(record)),
    ),
  ];
}

export const TOOL_DEFS = createConsumerMcpTools();

function definition<F extends ConsumerArgsContractV1['fields']>(
  name: ToolDef['name'],
  description: string,
  contract: ConsumerArgsContractV1<F>,
  annotations: NonNullable<ToolDef['annotations']>,
  operation: ConsumerMcpOperationV1,
  handler: (
    record: ConsumerArgsOutputV1<F>,
  ) => Promise<unknown> | object | string | number | boolean | null,
): ToolDef {
  return {
    name,
    description,
    inputSchema: toolInputJsonSchema(contract),
    annotations,
    responseSurface: 'consumer',
    // Consumer tools take no session_id and never reach the phase
    // middleware — they are not session-gated.
    phasePolicy: { category: 'none' },
    handler: async (args) => {
      try {
        return boundMcpResult(await handler(parseConsumerArgs(contract, args, name)), operation);
      } catch (error) {
        if (error instanceof PublicContractError) {
          return mcpFailure(operation, knownPackageId(args), 'invalid_options');
        }
        throw error;
      }
    },
  };
}

function runCommandOptions(record: { operation_id?: string }): { operation_id?: string } {
  return record.operation_id === undefined ? {} : { operation_id: record.operation_id };
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
