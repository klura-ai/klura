// One definition per consumer tool input, consumed at every trust boundary.
//
// Each consumer tool has exactly one argument contract here and each daemon
// consumer route has exactly one wire-body contract. Four derivations share
// them:
//
//   1. MCP input schemas — `toolInputJsonSchema()` renders the published
//      JSON Schema from the contract, so the agent-visible shape cannot
//      drift from what the handler accepts.
//   2. MCP/SDK argument validation — `parseConsumerArgs()`.
//   3. Daemon wire-body validation — `parseConsumerWireBody()`, which
//      encodes the exact-keyset plus null-for-absent wire convention.
//   4. CLI flag bounds — the CLI reads the same `CONSUMER_BOUNDS` /
//      `CALLER_BOUND_KEYS` constants this module builds its fields from.
//
// Identifier grammar stays in its existing single home: every field here
// DELEGATES to the public-contract parsers (`parsePackageId`, `parseRunId`,
// `parseScrapeCallerBounds`, …) rather than re-expressing them. Validation
// still runs at each boundary — the boundaries share the definition, not a
// single execution.
//
// Fields whose value-level validation is owned by a typed-failure service
// (registry search/show/install, installed listing, run listing) are wire
// passthroughs: the wire contract checks the exact keyset and the service
// keeps producing its typed `consumer_failure` envelope for bad values.

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
  type CapabilityIdV1,
  type PackageIdV1,
  type PackageVersionV1,
  type SessionNameV1,
  type StableContractIdV1,
} from '../../public/contracts/common';
import { assertJsonValue, type JsonValueV1 } from '../../public/contracts/json';
import {
  CONSUMER_BOUNDS,
  CONSUMER_BYTE_LIMITS,
  CONSUMER_LIMITS_MAX_ENTRIES_V1,
  type CallerBoundKeyV1,
  type ConsumerIntegerBoundV1,
} from '../../public/contracts/consumer-bounds';
import {
  parseScrapeCallerBounds,
  parseScrapeCallerLimitMap,
} from '../../public/contracts/scrape-policy';
import {
  parseRunId,
  parseRunOperationId,
  type RunCancellationSourceV1,
  type RunIdV1,
  type RunOperationIdV1,
} from '../scrape/journal';
import {
  DEFAULT_INLINE_OUTPUT_MAX_BYTES_V1,
  parseRunOutput,
  parseRunOutputFormat,
  type RunOutputFormatV1,
  type RunOutputV1,
} from '../scrape/output';
import { TOOL_NAMES } from '../../vocab';
import type { JsonSchema } from '../../public/mcp-tool';

type AssertNever<T extends never> = T;

// ---------- Field contracts ----------

/** One field: a published JSON Schema fragment plus its exact validator. */
export interface ConsumerFieldContractV1<T> {
  json_schema: JsonSchema;
  parse(value: unknown, field: string): T;
}

function delegatedField<T>(
  parse: (value: unknown, field: string) => T,
  jsonSchema: JsonSchema,
): ConsumerFieldContractV1<T> {
  return { json_schema: jsonSchema, parse };
}

function boundedStringField(maxBytes: number): ConsumerFieldContractV1<string> {
  return {
    json_schema: { type: 'string', maxLength: maxBytes },
    parse: (value, field) => parseString(value, field, maxBytes),
  };
}

function boundedIntegerField(bound: ConsumerIntegerBoundV1): ConsumerFieldContractV1<number> {
  return {
    json_schema: {
      type: 'integer',
      minimum: bound.minimum,
      ...(bound.maximum === Number.MAX_SAFE_INTEGER ? {} : { maximum: bound.maximum }),
    },
    parse: (value, field) => parseInteger(value, field, bound.minimum, bound.maximum),
  };
}

function jsonValueField(): ConsumerFieldContractV1<JsonValueV1> {
  return {
    json_schema: {},
    parse: (value, field) => {
      assertJsonValue(value, field, PUBLIC_CONTRACT_LIMITS.maxDepth);
      return value;
    },
  };
}

/** Wire-only field whose value-level validation is owned by a typed-failure service. */
function passthroughField(): ConsumerFieldContractV1<unknown> {
  return { json_schema: {}, parse: (value) => value };
}

/** The declared run output formats. Parsing delegates to `parseRunOutputFormat`. */
export const RUN_OUTPUT_FORMATS = ['json', 'ndjson', 'csv'] as const;

/** Caller-facing run output declaration; path policy (absolute vs resolve) stays per boundary. */
export type ConsumerRunOutputInputV1 =
  | { kind: 'inline' }
  | { kind: 'file'; path: string; format: RunOutputFormatV1 };

function runOutputField(): ConsumerFieldContractV1<ConsumerRunOutputInputV1> {
  return {
    json_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...RUN_OUTPUT_KINDS] },
        path: { type: 'string' },
        format: { type: 'string', enum: [...RUN_OUTPUT_FORMATS] },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    parse: (value, field) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new PublicContractError(field, 'must be an object');
      }
      const record = value as Record<string, unknown>;
      if (record.kind === 'inline') {
        if (Object.keys(record).length !== 1) {
          throw new PublicContractError(field, 'inline output has no extra fields');
        }
        return { kind: 'inline' };
      }
      if (record.kind !== 'file') {
        throw new PublicContractError(`${field}.kind`, 'must be inline or file');
      }
      if (
        Object.keys(record).length !== 3 ||
        !Object.hasOwn(record, 'path') ||
        !Object.hasOwn(record, 'format')
      ) {
        throw new PublicContractError(field, 'must be a file output with path and format');
      }
      return {
        kind: 'file',
        path: parseString(record.path, `${field}.path`, PUBLIC_CONTRACT_LIMITS.outputPathBytes),
        format: parseRunOutputFormat(record.format, `${field}.format`),
      };
    },
  };
}

const RUN_OUTPUT_KINDS = ['inline', 'file'] as const;

function callerLimitsField(): ConsumerFieldContractV1<Record<string, number>> {
  return {
    json_schema: {
      type: 'object',
      additionalProperties: {
        type: 'integer',
        minimum: CONSUMER_BOUNDS.caller_limit.minimum,
        maximum: CONSUMER_BOUNDS.caller_limit.maximum,
      },
      maxProperties: CONSUMER_LIMITS_MAX_ENTRIES_V1,
    },
    parse: (value, field) => {
      parseBoundedRecord(value, field, CONSUMER_LIMITS_MAX_ENTRIES_V1);
      return parseScrapeCallerLimitMap(value, field);
    },
  };
}

/** The declared run cancellation sources accepted on the cancel wire. */
export const RUN_CANCELLATION_SOURCES = [
  'foreground_sigint',
  'sdk_cancel',
  'mcp_cancel',
  'cli_cancel',
] as const;

function cancellationSourceField(): ConsumerFieldContractV1<RunCancellationSourceV1> {
  return {
    json_schema: { type: 'string', enum: [...RUN_CANCELLATION_SOURCES] },
    parse: (value, field) => {
      if (!(RUN_CANCELLATION_SOURCES as readonly unknown[]).includes(value)) {
        throw new PublicContractError(field, 'is invalid');
      }
      return value as RunCancellationSourceV1;
    },
  };
}

function detachField(): ConsumerFieldContractV1<true> {
  return {
    json_schema: { type: 'boolean', const: true },
    parse: (value, field) => {
      if (typeof value !== 'boolean') {
        throw new PublicContractError(field, 'must be a boolean');
      }
      if (!value) {
        throw new PublicContractError(field, 'must be true for a durable scrape run');
      }
      return true;
    },
  };
}

/** Validates a nested caller-bounds wire object and returns the byte-identical value. */
function callerBoundsWireField(): ConsumerFieldContractV1<JsonValueV1> {
  return {
    json_schema: {},
    parse: (value, field) => {
      parseScrapeCallerBounds(value, field);
      return value as JsonValueV1;
    },
  };
}

function runOutputWireField(): ConsumerFieldContractV1<RunOutputV1> {
  return {
    json_schema: {},
    parse: (value, field) => parseRunOutput(value, field),
  };
}

/** The one shared field catalog every consumer boundary validates with. */
export const CONSUMER_FIELDS = {
  packageId: delegatedField<PackageIdV1>(parsePackageId, { type: 'string' }),
  packageVersion: delegatedField<PackageVersionV1>(parsePackageVersion, { type: 'string' }),
  capabilityId: delegatedField<CapabilityIdV1>(parseCapabilityId, { type: 'string' }),
  stableContractId: delegatedField<StableContractIdV1>(parseStableContractId, { type: 'string' }),
  sessionName: delegatedField<SessionNameV1>(parseSessionName, { type: 'string' }),
  runId: delegatedField<RunIdV1>(parseRunId, { type: 'string' }),
  runOperationId: delegatedField<RunOperationIdV1>(parseRunOperationId, { type: 'string' }),
  interactionId: boundedStringField(CONSUMER_BYTE_LIMITS.interaction_id),
  query: boundedStringField(CONSUMER_BYTE_LIMITS.query),
  cursor: boundedStringField(CONSUMER_BYTE_LIMITS.cursor),
  searchLimit: boundedIntegerField(CONSUMER_BOUNDS.search_limit),
  pageLimit: boundedIntegerField(CONSUMER_BOUNDS.page_limit),
  afterSequence: boundedIntegerField(CONSUMER_BOUNDS.after_sequence),
  afterStateVersion: boundedIntegerField(CONSUMER_BOUNDS.after_state_version),
  callTimeoutMs: boundedIntegerField(CONSUMER_BOUNDS.call_timeout_ms),
  waitTimeoutMs: boundedIntegerField(CONSUMER_BOUNDS.wait_timeout_ms),
  callerBound: boundedIntegerField(CONSUMER_BOUNDS.caller_bound),
  callerLimits: callerLimitsField(),
  input: jsonValueField(),
  runOutput: runOutputField(),
} as const;

// ---------- Argument contracts (caller-facing: MCP args, SDK inputs) ----------

interface ConsumerArgFieldV1<T, R extends boolean> {
  spec: ConsumerFieldContractV1<T>;
  required: R;
}

type ConsumerArgFieldsV1 = Record<string, ConsumerArgFieldV1<unknown, boolean>>;

export interface ConsumerArgsContractV1<F extends ConsumerArgFieldsV1 = ConsumerArgFieldsV1> {
  fields: F;
}

export type ConsumerArgsOutputV1<F extends ConsumerArgFieldsV1> = {
  [K in keyof F as F[K] extends ConsumerArgFieldV1<unknown, true> ? K : never]: F[K] extends {
    spec: ConsumerFieldContractV1<infer T>;
  }
    ? T
    : never;
} & {
  [K in keyof F as F[K] extends ConsumerArgFieldV1<unknown, true> ? never : K]?: F[K] extends {
    spec: ConsumerFieldContractV1<infer T>;
  }
    ? T
    : never;
};

function requiredArg<T>(spec: ConsumerFieldContractV1<T>): ConsumerArgFieldV1<T, true> {
  return { spec, required: true };
}

function optionalArg<T>(spec: ConsumerFieldContractV1<T>): ConsumerArgFieldV1<T, false> {
  return { spec, required: false };
}

function argsContract<F extends ConsumerArgFieldsV1>(fields: F): ConsumerArgsContractV1<F> {
  return { fields };
}

/**
 * Validates one caller-facing argument object: closed keyset, required keys,
 * per-field delegated parsing. Absent and `undefined`-valued optional keys
 * are treated as omitted.
 */
export function parseConsumerArgs<F extends ConsumerArgFieldsV1>(
  contract: ConsumerArgsContractV1<F>,
  value: unknown,
  field: string,
): ConsumerArgsOutputV1<F> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(contract.fields, key)) {
      throw new PublicContractError(`${field}.${key}`, 'is not allowed');
    }
  }
  const parsed: Record<string, unknown> = {};
  for (const [key, argField] of Object.entries(contract.fields)) {
    const candidate = record[key];
    if (candidate === undefined) {
      if (!argField.required) continue;
      if (!Object.hasOwn(record, key)) {
        throw new PublicContractError(field, `is missing required key ${JSON.stringify(key)}`);
      }
    }
    parsed[key] = argField.spec.parse(candidate, `${field}.${key}`);
  }
  return parsed as ConsumerArgsOutputV1<F>;
}

function objectField<F extends ConsumerArgFieldsV1>(
  contract: ConsumerArgsContractV1<F>,
): ConsumerFieldContractV1<ConsumerArgsOutputV1<F>> {
  return {
    json_schema: toolInputJsonSchema(contract),
    parse: (value, field) => parseConsumerArgs(contract, value, field),
  };
}

/** Renders one published MCP `inputSchema` from an argument contract. */
export function toolInputJsonSchema(contract: ConsumerArgsContractV1): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, argField] of Object.entries(contract.fields)) {
    properties[key] = argField.spec.json_schema;
    if (argField.required) required.push(key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/** `start_scrape_run` options: flattened caller bounds beside run selection fields. */
export const startScrapeRunOptionsContract = argsContract({
  operation_id: optionalArg(CONSUMER_FIELDS.runOperationId),
  input_mode_id: optionalArg(CONSUMER_FIELDS.stableContractId),
  session_name: optionalArg(CONSUMER_FIELDS.sessionName),
  output: optionalArg(CONSUMER_FIELDS.runOutput),
  max_items: optionalArg(CONSUMER_FIELDS.callerBound),
  max_pages: optionalArg(CONSUMER_FIELDS.callerBound),
  max_requests: optionalArg(CONSUMER_FIELDS.callerBound),
  timeout_ms: optionalArg(CONSUMER_FIELDS.callerBound),
  max_concurrency: optionalArg(CONSUMER_FIELDS.callerBound),
  limits: optionalArg(CONSUMER_FIELDS.callerLimits),
});

export type ConsumerStartRunOptionsParsedV1 = ConsumerArgsOutputV1<
  (typeof startScrapeRunOptionsContract)['fields']
>;

/**
 * Compile-time drift locks. Each member must stay `never`: the enum consts
 * above must cover their source union exactly, and the flattened options
 * contract must carry every caller-bound key.
 */
export type ConsumerContractDriftChecksV1 = [
  AssertNever<Exclude<RunOutputFormatV1, (typeof RUN_OUTPUT_FORMATS)[number]>>,
  AssertNever<Exclude<(typeof RUN_OUTPUT_FORMATS)[number], RunOutputFormatV1>>,
  AssertNever<Exclude<(typeof RUN_OUTPUT_KINDS)[number], ConsumerRunOutputInputV1['kind']>>,
  AssertNever<Exclude<RunCancellationSourceV1, (typeof RUN_CANCELLATION_SOURCES)[number]>>,
  AssertNever<Exclude<(typeof RUN_CANCELLATION_SOURCES)[number], RunCancellationSourceV1>>,
  AssertNever<Exclude<CallerBoundKeyV1, keyof (typeof startScrapeRunOptionsContract)['fields']>>,
];

/** Structural `{ package_id, capability }` selector shared by call and run. */
export const capabilitySelectorContract = argsContract({
  package_id: requiredArg(CONSUMER_FIELDS.packageId),
  capability: requiredArg(CONSUMER_FIELDS.capabilityId),
});

const packageSessionScopeFields = {
  package_id: requiredArg(CONSUMER_FIELDS.packageId),
  authentication_contract_id: optionalArg(CONSUMER_FIELDS.stableContractId),
  session_name: optionalArg(CONSUMER_FIELDS.sessionName),
} as const;

const runCommandFields = {
  run_id: requiredArg(CONSUMER_FIELDS.runId),
  operation_id: optionalArg(CONSUMER_FIELDS.runOperationId),
} as const;

/** One argument contract per consumer MCP tool, keyed by its vocab name. */
export const CONSUMER_TOOL_CONTRACTS = {
  [TOOL_NAMES.searchPackages]: argsContract({
    query: optionalArg(CONSUMER_FIELDS.query),
    cursor: optionalArg(CONSUMER_FIELDS.cursor),
    limit: optionalArg(CONSUMER_FIELDS.searchLimit),
  }),
  [TOOL_NAMES.showPackage]: argsContract({
    package_id: requiredArg(CONSUMER_FIELDS.packageId),
    version: optionalArg(CONSUMER_FIELDS.packageVersion),
    capability: optionalArg(CONSUMER_FIELDS.capabilityId),
  }),
  [TOOL_NAMES.installPackage]: argsContract({
    package_id: requiredArg(CONSUMER_FIELDS.packageId),
    version: optionalArg(CONSUMER_FIELDS.packageVersion),
  }),
  [TOOL_NAMES.listInstalledPackages]: argsContract({
    cursor: optionalArg(CONSUMER_FIELDS.cursor),
    limit: optionalArg(CONSUMER_FIELDS.pageLimit),
  }),
  [TOOL_NAMES.removePackage]: argsContract({
    package_id: requiredArg(CONSUMER_FIELDS.packageId),
  }),
  [TOOL_NAMES.runConsumerDoctor]: argsContract({}),
  [TOOL_NAMES.clearPackageSession]: argsContract(packageSessionScopeFields),
  [TOOL_NAMES.openPackageLogin]: argsContract(packageSessionScopeFields),
  [TOOL_NAMES.completePackageLogin]: argsContract({
    interaction_id: requiredArg(CONSUMER_FIELDS.interactionId),
  }),
  [TOOL_NAMES.callPackageCapability]: argsContract({
    package_id: requiredArg(CONSUMER_FIELDS.packageId),
    capability: requiredArg(CONSUMER_FIELDS.capabilityId),
    input: requiredArg(CONSUMER_FIELDS.input),
    session_name: optionalArg(CONSUMER_FIELDS.sessionName),
    timeout_ms: optionalArg(CONSUMER_FIELDS.callTimeoutMs),
  }),
  [TOOL_NAMES.startScrapeRun]: argsContract({
    package_id: requiredArg(CONSUMER_FIELDS.packageId),
    capability: requiredArg(CONSUMER_FIELDS.capabilityId),
    input: requiredArg(CONSUMER_FIELDS.input),
    options: requiredArg(objectField(startScrapeRunOptionsContract)),
  }),
  [TOOL_NAMES.getScrapeRun]: argsContract({
    run_id: requiredArg(CONSUMER_FIELDS.runId),
  }),
  [TOOL_NAMES.listScrapeRuns]: argsContract({
    cursor: optionalArg(CONSUMER_FIELDS.cursor),
    limit: optionalArg(CONSUMER_FIELDS.pageLimit),
  }),
  [TOOL_NAMES.listScrapeRunItems]: argsContract({
    run_id: requiredArg(CONSUMER_FIELDS.runId),
    after_sequence: optionalArg(CONSUMER_FIELDS.afterSequence),
    limit: optionalArg(CONSUMER_FIELDS.pageLimit),
  }),
  [TOOL_NAMES.waitScrapeRun]: argsContract({
    run_id: requiredArg(CONSUMER_FIELDS.runId),
    after_state_version: optionalArg(CONSUMER_FIELDS.afterStateVersion),
    wait_timeout_ms: optionalArg(CONSUMER_FIELDS.waitTimeoutMs),
  }),
  [TOOL_NAMES.resumeScrapeRun]: argsContract(runCommandFields),
  [TOOL_NAMES.cancelScrapeRun]: argsContract(runCommandFields),
  [TOOL_NAMES.discardScrapeRun]: argsContract(runCommandFields),
} as const;

// ---------- Wire contracts (daemon consumer routes) ----------

interface ConsumerWireFieldV1<T, N extends boolean> {
  spec: ConsumerFieldContractV1<T>;
  nullable: N;
}

type ConsumerWireFieldsV1 = Record<string, ConsumerWireFieldV1<unknown, boolean>>;

export interface ConsumerWireContractV1<F extends ConsumerWireFieldsV1 = ConsumerWireFieldsV1> {
  fields: F;
}

export type ConsumerWireOutputV1<F extends ConsumerWireFieldsV1> = {
  [K in keyof F]: F[K] extends { spec: ConsumerFieldContractV1<infer T>; nullable: infer N }
    ? N extends true
      ? T | null
      : T
    : never;
};

function wireValue<T>(spec: ConsumerFieldContractV1<T>): ConsumerWireFieldV1<T, false> {
  return { spec, nullable: false };
}

function wireNullable<T>(spec: ConsumerFieldContractV1<T>): ConsumerWireFieldV1<T, true> {
  return { spec, nullable: true };
}

function wireContract<F extends ConsumerWireFieldsV1>(fields: F): ConsumerWireContractV1<F> {
  return { fields };
}

/**
 * Validates one daemon wire body: closed keyset, every declared key present,
 * `null` meaning absent on nullable fields, per-field delegated parsing.
 */
export function parseConsumerWireBody<F extends ConsumerWireFieldsV1>(
  contract: ConsumerWireContractV1<F>,
  value: unknown,
  field: string,
): ConsumerWireOutputV1<F> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(contract.fields, key)) {
      throw new PublicContractError(`${field}.${key}`, 'is not allowed');
    }
  }
  const parsed: Record<string, unknown> = {};
  for (const [key, wireField] of Object.entries(contract.fields)) {
    if (!(key in record)) {
      throw new PublicContractError(field, `is missing required key ${JSON.stringify(key)}`);
    }
    const candidate = record[key];
    parsed[key] =
      wireField.nullable && candidate === null
        ? null
        : wireField.spec.parse(candidate, `${field}.${key}`);
  }
  return parsed as ConsumerWireOutputV1<F>;
}

const wirePassthrough = passthroughField();

const packageSessionScopeWireFields = {
  package_id: wireValue(CONSUMER_FIELDS.packageId),
  authentication_contract_id: wireNullable(CONSUMER_FIELDS.stableContractId),
  session_name: wireNullable(CONSUMER_FIELDS.sessionName),
} as const;

/** One wire-body contract per daemon consumer route. */
export const CONSUMER_WIRE_CONTRACTS = {
  '/consumer/search': wireContract({
    query: wireNullable(wirePassthrough),
    cursor: wireNullable(wirePassthrough),
    limit: wireNullable(wirePassthrough),
  }),
  '/consumer/show': wireContract({
    package_id: wireNullable(wirePassthrough),
    version: wireNullable(wirePassthrough),
    capability: wireNullable(wirePassthrough),
  }),
  '/consumer/install': wireContract({
    package_id: wireNullable(wirePassthrough),
    version: wireNullable(wirePassthrough),
  }),
  '/consumer/installed': wireContract({
    cursor: wireNullable(wirePassthrough),
    limit: wireNullable(wirePassthrough),
  }),
  '/consumer/remove': wireContract({
    package_id: wireValue(wirePassthrough),
  }),
  '/consumer/doctor': wireContract({}),
  '/consumer/session/clear': wireContract(packageSessionScopeWireFields),
  '/consumer/login/open': wireContract(packageSessionScopeWireFields),
  '/consumer/login/complete': wireContract({
    interaction_id: wireValue(CONSUMER_FIELDS.interactionId),
  }),
  '/consumer/call': wireContract({
    package_id: wireValue(CONSUMER_FIELDS.packageId),
    capability: wireValue(CONSUMER_FIELDS.capabilityId),
    input: wireValue(CONSUMER_FIELDS.input),
    session_name: wireNullable(CONSUMER_FIELDS.sessionName),
    timeout_ms: wireNullable(CONSUMER_FIELDS.callTimeoutMs),
  }),
  '/consumer/run': wireContract({
    package_id: wireValue(CONSUMER_FIELDS.packageId),
    capability: wireValue(CONSUMER_FIELDS.capabilityId),
    input: wireValue(CONSUMER_FIELDS.input),
    caller_bounds: wireValue(callerBoundsWireField()),
    input_mode_id: wireNullable(CONSUMER_FIELDS.stableContractId),
    output: wireNullable(runOutputWireField()),
    inline_output_max_bytes: wireNullable(
      boundedIntegerField({ minimum: 1, maximum: DEFAULT_INLINE_OUTPUT_MAX_BYTES_V1 }),
    ),
    session_name: wireNullable(CONSUMER_FIELDS.sessionName),
    detach: wireValue(detachField()),
    operation_id: wireValue(CONSUMER_FIELDS.runOperationId),
  }),
  '/consumer/runs/resume': wireContract({
    run_id: wireValue(CONSUMER_FIELDS.runId),
    operation_id: wireValue(CONSUMER_FIELDS.runOperationId),
  }),
  '/consumer/runs/wait': wireContract({
    run_id: wireValue(CONSUMER_FIELDS.runId),
  }),
  '/consumer/runs/wait-state': wireContract({
    run_id: wireValue(CONSUMER_FIELDS.runId),
    after_state_version: wireNullable(CONSUMER_FIELDS.afterStateVersion),
    wait_timeout_ms: wireNullable(CONSUMER_FIELDS.waitTimeoutMs),
  }),
  '/consumer/runs/cancel': wireContract({
    run_id: wireValue(CONSUMER_FIELDS.runId),
    source: wireValue(cancellationSourceField()),
    operation_id: wireValue(CONSUMER_FIELDS.runOperationId),
  }),
  '/consumer/runs/show': wireContract({
    run_id: wireValue(CONSUMER_FIELDS.runId),
  }),
  '/consumer/runs/list': wireContract({
    cursor: wireNullable(wirePassthrough),
    limit: wireNullable(wirePassthrough),
  }),
  '/consumer/runs/items': wireContract({
    run_id: wireValue(CONSUMER_FIELDS.runId),
    after_sequence: wireNullable(CONSUMER_FIELDS.afterSequence),
    limit: wireNullable(CONSUMER_FIELDS.pageLimit),
  }),
  '/consumer/runs/items/follow': wireContract({
    run_id: wireValue(CONSUMER_FIELDS.runId),
    after_sequence: wireNullable(CONSUMER_FIELDS.afterSequence),
  }),
  '/consumer/runs/discard': wireContract({
    run_id: wireValue(CONSUMER_FIELDS.runId),
    operation_id: wireValue(CONSUMER_FIELDS.runOperationId),
  }),
} as const;
