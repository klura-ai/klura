import {
  parseExactRecord,
  parseInteger,
  parseStableContractId,
  PublicContractError,
  type StableContractIdV1,
} from './common';
import {
  CALLER_BOUND_KEYS,
  CONSUMER_BOUNDS,
  CONSUMER_LIMITS_MAX_ENTRIES_V1,
  type CallerBoundKeyV1,
} from './consumer-bounds';
import { parseCallRetryPolicy, type CallRetryPolicyV1 } from './outcome';

export interface DurableRunBoundsV1 {
  max_frontier_bytes: number;
  max_data_spool_bytes: number;
  max_journal_bytes: number;
  max_journal_frames: number;
  max_reorder_buffer_bytes: number;
  max_local_state_bytes: number;
}

export interface ScrapeRunPolicyV1 {
  max_concurrency: number;
  per_request_timeout_ms: number;
  total_timeout_ms: number;
  max_requests: number;
  max_tasks: number;
  max_pages: number;
  max_items: number;
  max_encoded_item_bytes: number;
  max_output_bytes: number;
  retry: CallRetryPolicyV1;
  durable: DurableRunBoundsV1;
}

export type ScrapeLimitV1 =
  | { id: StableContractIdV1; kind: 'fixed'; value: number }
  | { id: StableContractIdV1; kind: 'caller'; default: number; maximum: number };

export interface EffectiveRunBoundsV1 {
  policy: ScrapeRunPolicyV1;
  named_limits: Record<StableContractIdV1, number>;
}

export type ScrapeCallerBoundsV1 = Partial<Record<CallerBoundKeyV1, number>> & {
  limits?: Record<string, number>;
};

const MAX_ITEM_LIMIT_V1 = CONSUMER_BOUNDS.caller_limit.maximum;
const RESERVED_LIMIT_IDS = new Set(['caller_max_items', 'caller_max_pages']);

export function parseScrapeRunPolicy(value: unknown, field: string): ScrapeRunPolicyV1 {
  const record = parseExactRecord(value, field, [
    'max_concurrency',
    'per_request_timeout_ms',
    'total_timeout_ms',
    'max_requests',
    'max_tasks',
    'max_pages',
    'max_items',
    'max_encoded_item_bytes',
    'max_output_bytes',
    'retry',
    'durable',
  ]);
  const perRequestTimeout = parseInteger(
    record.per_request_timeout_ms,
    `${field}.per_request_timeout_ms`,
    1_000,
    60_000,
  );
  const totalTimeout = parseInteger(
    record.total_timeout_ms,
    `${field}.total_timeout_ms`,
    1_000,
    3_600_000,
  );
  if (totalTimeout < perRequestTimeout) {
    throw new PublicContractError(field, 'total_timeout_ms must cover one request timeout');
  }
  return {
    max_concurrency: parseInteger(record.max_concurrency, `${field}.max_concurrency`, 1, 32),
    per_request_timeout_ms: perRequestTimeout,
    total_timeout_ms: totalTimeout,
    max_requests: parseInteger(record.max_requests, `${field}.max_requests`, 1, 1_000),
    max_tasks: parseInteger(record.max_tasks, `${field}.max_tasks`, 1, 1_000),
    max_pages: parseInteger(record.max_pages, `${field}.max_pages`, 1, 1_000),
    max_items: parseInteger(record.max_items, `${field}.max_items`, 1, MAX_ITEM_LIMIT_V1),
    max_encoded_item_bytes: parseInteger(
      record.max_encoded_item_bytes,
      `${field}.max_encoded_item_bytes`,
      1,
      16_384,
    ),
    max_output_bytes: parseInteger(
      record.max_output_bytes,
      `${field}.max_output_bytes`,
      1,
      2_147_483_648,
    ),
    retry: parseCallRetryPolicy(record.retry, `${field}.retry`),
    durable: parseDurableBounds(record.durable, `${field}.durable`),
  };
}

export function parseScrapeLimit(value: unknown, field: string): ScrapeLimitV1 {
  const kind = readKind(value, field);
  if (kind === 'fixed') {
    const record = parseExactRecord(value, field, ['id', 'kind', 'value']);
    return {
      id: parseLimitId(record.id, `${field}.id`),
      kind,
      value: parseInteger(record.value, `${field}.value`, 1, MAX_ITEM_LIMIT_V1),
    };
  }
  if (kind === 'caller') {
    const record = parseExactRecord(value, field, ['id', 'kind', 'default', 'maximum']);
    const defaultValue = parseInteger(record.default, `${field}.default`, 1, MAX_ITEM_LIMIT_V1);
    const maximum = parseInteger(
      record.maximum,
      `${field}.maximum`,
      defaultValue,
      MAX_ITEM_LIMIT_V1,
    );
    return {
      id: parseLimitId(record.id, `${field}.id`),
      kind,
      default: defaultValue,
      maximum,
    };
  }
  throw new PublicContractError(`${field}.kind`, 'must be fixed or caller');
}

export function resolveEffectiveRunBounds(
  policy: ScrapeRunPolicyV1,
  declaredLimits: readonly ScrapeLimitV1[],
  value: unknown,
  field: string,
): EffectiveRunBoundsV1 {
  const options = parseScrapeCallerBounds(value, field);
  const limits = indexLimits(declaredLimits, `${field}.limits`);
  const namedLimits = {} as Record<StableContractIdV1, number>;
  for (const limit of declaredLimits) {
    namedLimits[limit.id] = limit.kind === 'caller' ? limit.default : limit.value;
  }
  for (const [id, requested] of Object.entries(options.limits ?? {})) {
    const limit = limits.get(id);
    if (!limit)
      throw new PublicContractError(`${field}.limits.${id}`, 'does not name a declared limit');
    if (limit.kind !== 'caller') {
      throw new PublicContractError(`${field}.limits.${id}`, 'cannot override a fixed limit');
    }
    namedLimits[limit.id] = parseInteger(requested, `${field}.limits.${id}`, 1, limit.maximum);
  }
  return {
    policy: {
      ...policy,
      max_concurrency: lowerBound(
        options.max_concurrency,
        policy.max_concurrency,
        `${field}.max_concurrency`,
      ),
      max_items: lowerBound(options.max_items, policy.max_items, `${field}.max_items`),
      max_pages: lowerBound(options.max_pages, policy.max_pages, `${field}.max_pages`),
      max_requests: lowerBound(options.max_requests, policy.max_requests, `${field}.max_requests`),
      total_timeout_ms: lowerBound(
        options.timeout_ms,
        policy.total_timeout_ms,
        `${field}.timeout_ms`,
      ),
    },
    named_limits: namedLimits,
  };
}

function parseDurableBounds(value: unknown, field: string): DurableRunBoundsV1 {
  const record = parseExactRecord(value, field, [
    'max_frontier_bytes',
    'max_data_spool_bytes',
    'max_journal_bytes',
    'max_journal_frames',
    'max_reorder_buffer_bytes',
    'max_local_state_bytes',
  ]);
  return {
    max_frontier_bytes: parseInteger(
      record.max_frontier_bytes,
      `${field}.max_frontier_bytes`,
      1,
      268_435_456,
    ),
    max_data_spool_bytes: parseInteger(
      record.max_data_spool_bytes,
      `${field}.max_data_spool_bytes`,
      1,
      2_147_483_648,
    ),
    max_journal_bytes: parseInteger(
      record.max_journal_bytes,
      `${field}.max_journal_bytes`,
      393_432,
      268_435_456,
    ),
    max_journal_frames: parseInteger(
      record.max_journal_frames,
      `${field}.max_journal_frames`,
      6,
      10_000_000,
    ),
    max_reorder_buffer_bytes: parseInteger(
      record.max_reorder_buffer_bytes,
      `${field}.max_reorder_buffer_bytes`,
      1,
      67_108_864,
    ),
    max_local_state_bytes: parseInteger(
      record.max_local_state_bytes,
      `${field}.max_local_state_bytes`,
      1,
      4_294_967_296,
    ),
  };
}

/** Parses one nested caller-bounds object with the shared consumer bounds. */
export function parseScrapeCallerBounds(value: unknown, field: string): ScrapeCallerBoundsV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed: readonly string[] = [...CALLER_BOUND_KEYS, 'limits'];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new PublicContractError(`${field}.${key}`, 'is not allowed');
  }
  const bounds: ScrapeCallerBoundsV1 = {};
  for (const key of CALLER_BOUND_KEYS) {
    const parsed = parseOptionalPositiveInteger(record[key], `${field}.${key}`);
    if (parsed !== undefined) bounds[key] = parsed;
  }
  if (record.limits !== undefined) {
    bounds.limits = parseScrapeCallerLimitMap(record.limits, `${field}.limits`);
  }
  return bounds;
}

/** Parses one named caller-limit map with the shared entry and value bounds. */
export function parseScrapeCallerLimitMap(value: unknown, field: string): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (entries.length > CONSUMER_LIMITS_MAX_ENTRIES_V1) {
    throw new PublicContractError(
      field,
      `must contain at most ${CONSUMER_LIMITS_MAX_ENTRIES_V1} entries`,
    );
  }
  const parsed: Record<string, number> = {};
  for (const [id, candidate] of entries) {
    parseStableContractId(id, `${field}.${id}`);
    parsed[id] = parseInteger(
      candidate,
      `${field}.${id}`,
      CONSUMER_BOUNDS.caller_limit.minimum,
      CONSUMER_BOUNDS.caller_limit.maximum,
    );
  }
  return parsed;
}

function indexLimits(limits: readonly ScrapeLimitV1[], field: string): Map<string, ScrapeLimitV1> {
  const indexed = new Map<string, ScrapeLimitV1>();
  for (const limit of limits) {
    if (indexed.has(limit.id))
      throw new PublicContractError(field, 'must not contain duplicate limit ids');
    indexed.set(limit.id, limit);
  }
  return indexed;
}

function parseLimitId(value: unknown, field: string): StableContractIdV1 {
  const id = parseStableContractId(value, field);
  if (RESERVED_LIMIT_IDS.has(id)) {
    throw new PublicContractError(field, 'is reserved by the runtime');
  }
  return id;
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return parseInteger(
    value,
    field,
    CONSUMER_BOUNDS.caller_bound.minimum,
    CONSUMER_BOUNDS.caller_bound.maximum,
  );
}

function lowerBound(requested: number | undefined, maximum: number, field: string): number {
  if (requested === undefined) return maximum;
  return parseInteger(requested, field, 1, maximum);
}

function readKind(value: unknown, field: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be a limit object');
  }
  return (value as Record<string, unknown>).kind;
}
