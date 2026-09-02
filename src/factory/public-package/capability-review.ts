// The reviewed-capability contract shared by every producer of a public
// package source: the exact key sets a reviewed `contract` and `page_script`
// carry, the parser that validates one reviewed capability under a
// caller-chosen field prefix, and the projection of a reviewed capability plus
// its saved local page-script onto a compilable capability source. Every
// failure is a PublicContractError naming the exact reviewed path beneath the
// caller's prefix.
import {
  parseExactRecord,
  parseStableContractId,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  type StableContractIdV1,
} from '../../public/contracts/common';
import { assertJsonValue, type JsonValueV1 } from '../../public/contracts/json';
import { PACKAGE_FIXTURE_KINDS } from '../../public/contracts/fixture';
import type { Strategy } from '../../strategies/skills';
import {
  exportReviewedLocalPageScriptStrategySource,
  type PublicReadCapabilitySourceV1,
} from './compiler';
import { exportReviewedLocalFetchStrategySource } from './http-export';

export const CAPABILITY_CONTRACT_KEYS = [
  'description',
  'visibility',
  'effect',
  'authentication',
  'request_origins',
  'navigation_origins',
  'origin_traffic_policies',
  'browser_resources',
  'max_target_requests_per_call',
  'max_encoded_outcome_bytes',
  'call_timeouts',
  'input_schema',
  'call_retry_policy',
  'outcomes',
  'control',
  'collection',
] as const;

export const PAGE_SCRIPT_REVIEW_KEYS = [
  'tier',
  'strategy_id',
  'wait',
  'interaction',
  'expect',
  'request_body_limits',
  'replay',
] as const;

export const HTTP_REVIEW_KEYS = [
  'tier',
  'strategy_id',
  'context',
  'replay',
  'response_body_limit_bytes',
] as const;

export type ParsedFixtureReviewV1 =
  | {
      kind: typeof PACKAGE_FIXTURE_KINDS.call;
      fixture_id: StableContractIdV1;
      input: JsonValueV1;
    }
  | {
      kind: typeof PACKAGE_FIXTURE_KINDS.run;
      fixture_id: StableContractIdV1;
      input: JsonValueV1;
      caller_bounds: JsonValueV1;
      input_mode_id: StableContractIdV1 | null;
    };

export interface ParsedPageScriptReviewV1 {
  tier: 'page-script';
  strategy_id: StableContractIdV1;
  wait: unknown;
  interaction: unknown;
  expect: unknown;
  request_body_limits: unknown;
  replay: unknown;
}

export interface ParsedHttpReviewV1 {
  tier: 'fetch';
  strategy_id: StableContractIdV1;
  context: 'node' | 'browser';
  replay: 'safe_read' | 'indeterminate';
  response_body_limit_bytes: number;
}

/**
 * A reviewed capability names exactly one strategy block, and the key chooses
 * the tier: `page_script` for a browser page-script, `http` for a fetch. The
 * package format carries both.
 */
export interface ParsedCapabilityReviewV1 {
  contract: Omit<PublicReadCapabilitySourceV1, 'strategies'>;
  page_script: ParsedPageScriptReviewV1 | null;
  http: ParsedHttpReviewV1 | null;
  fixtures: ParsedFixtureReviewV1[];
}

export interface CapabilityReviewParseContextV1 {
  /** Field path of the reviewed capability map, without the capability key. */
  field_prefix: string;
  capability_id: string;
  /**
   * Fixture IDs already claimed by sibling capabilities. The namespace is
   * package-wide because every fixture file lands in the package's single flat
   * fixtures/ directory.
   */
  seen_fixture_ids: Set<string>;
}

/**
 * Validates one reviewed capability. The caller supplies the field prefix, so
 * each producer of a package source rejects under its own input path.
 */
export function parseCapabilityReview(
  value: unknown,
  context: CapabilityReviewParseContextV1,
): ParsedCapabilityReviewV1 {
  const field = `${context.field_prefix}.${context.capability_id}`;
  const blockKey = selectStrategyBlockKey(value, field);
  const review = parseExactRecord(value, field, ['contract', blockKey, 'fixtures']);
  const contract = parseExactRecord(review.contract, `${field}.contract`, CAPABILITY_CONTRACT_KEYS);
  const { page_script: pageScript, http } = parseStrategyBlocks(review, field, blockKey);
  if (
    !Array.isArray(review.fixtures) ||
    review.fixtures.length === 0 ||
    review.fixtures.length > 8
  ) {
    throw new PublicContractError(`${field}.fixtures`, 'must contain one to eight fixtures');
  }
  const fixtures = review.fixtures.map((candidate, index) =>
    parseFixtureReview(candidate, `${field}.fixtures[${index}]`, context.seen_fixture_ids),
  );
  return {
    contract: contract as unknown as Omit<PublicReadCapabilitySourceV1, 'strategies'>,
    page_script: pageScript,
    http,
    fixtures,
  };
}

export function parsePageScriptReview(value: unknown, field: string): ParsedPageScriptReviewV1 {
  const record = parseExactRecord(value, field, PAGE_SCRIPT_REVIEW_KEYS);
  if (record.tier !== 'page-script') {
    throw new PublicContractError(`${field}.tier`, 'must be page-script');
  }
  return {
    tier: 'page-script',
    strategy_id: parseStableContractId(record.strategy_id, `${field}.strategy_id`),
    wait: record.wait,
    interaction: record.interaction,
    expect: record.expect,
    request_body_limits: record.request_body_limits,
    replay: record.replay,
  };
}

export type StrategyBlockKeyV1 = 'page_script' | 'http';

/**
 * Names the one strategy block a reviewed capability declares.
 *
 * Read before the exact-record parse, because every key in an exact key set is
 * required: listing both blocks there would demand both on every review. The
 * key set is chosen from this instead, so each variant stays exactly specified.
 */
export function selectStrategyBlockKey(value: unknown, field: string): StrategyBlockKeyV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const record = value as Record<string, unknown>;
  const hasPageScript = record.page_script !== undefined && record.page_script !== null;
  const hasHttp = record.http !== undefined && record.http !== null;
  if (hasPageScript === hasHttp) {
    throw new PublicContractError(
      field,
      hasPageScript
        ? 'must declare either page_script or http, not both: a reviewed capability names one strategy'
        : 'must declare either a page_script or an http strategy block',
    );
  }
  return hasHttp ? 'http' : 'page_script';
}

/** Parses whichever strategy block `selectStrategyBlockKey` named. */
export function parseStrategyBlocks(
  review: Record<string, unknown>,
  field: string,
  key: StrategyBlockKeyV1,
): Pick<ParsedCapabilityReviewV1, 'page_script' | 'http'> {
  return key === 'http'
    ? { page_script: null, http: parseHttpReview(review.http, `${field}.http`) }
    : {
        page_script: parsePageScriptReview(review.page_script, `${field}.page_script`),
        http: null,
      };
}

export function parseHttpReview(value: unknown, field: string): ParsedHttpReviewV1 {
  const record = parseExactRecord(value, field, HTTP_REVIEW_KEYS);
  if (record.tier !== 'fetch') {
    throw new PublicContractError(`${field}.tier`, 'must be fetch');
  }
  if (record.context !== 'node' && record.context !== 'browser') {
    throw new PublicContractError(`${field}.context`, 'must be node or browser');
  }
  if (record.replay !== 'safe_read' && record.replay !== 'indeterminate') {
    throw new PublicContractError(`${field}.replay`, 'must be safe_read or indeterminate');
  }
  if (
    typeof record.response_body_limit_bytes !== 'number' ||
    !Number.isInteger(record.response_body_limit_bytes) ||
    record.response_body_limit_bytes < 1
  ) {
    throw new PublicContractError(
      `${field}.response_body_limit_bytes`,
      'must be a positive integer',
    );
  }
  return {
    tier: 'fetch',
    strategy_id: parseStableContractId(record.strategy_id, `${field}.strategy_id`),
    context: record.context,
    replay: record.replay,
    response_body_limit_bytes: record.response_body_limit_bytes,
  };
}

/**
 * Projects a reviewed capability and its saved local page-script onto the
 * compilable capability source, which binds the reviewed contract to the one
 * public strategy derived from the local page-script.
 */
export function buildCapabilitySource(
  localStrategy: Strategy,
  capabilityReview: Pick<ParsedCapabilityReviewV1, 'contract' | 'page_script' | 'http'>,
): PublicReadCapabilitySourceV1 {
  const { page_script: pageScript, http } = capabilityReview;
  if (http) {
    return {
      ...capabilityReview.contract,
      strategies: [
        exportReviewedLocalFetchStrategySource({
          local_strategy: localStrategy,
          input_schema: capabilityReview.contract.input_schema,
          strategy_id: http.strategy_id,
          context: http.context,
          replay: http.replay,
          response_body_limit_bytes: http.response_body_limit_bytes,
        }),
      ],
    };
  }
  if (!pageScript) {
    throw new PublicContractError(
      'capability_review',
      'must declare either a page_script or an http strategy block',
    );
  }
  const publicStrategy = exportReviewedLocalPageScriptStrategySource({
    local_strategy: localStrategy,
    input_schema: capabilityReview.contract.input_schema,
    strategy_id: pageScript.strategy_id,
    wait: pageScript.wait,
    interaction: pageScript.interaction,
    expect: pageScript.expect,
    request_body_limits: pageScript.request_body_limits,
    replay: pageScript.replay,
  });
  return {
    ...capabilityReview.contract,
    strategies: [publicStrategy],
  };
}

function parseFixtureReview(
  value: unknown,
  field: string,
  seenFixtureIds: Set<string>,
): ParsedFixtureReviewV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind !== PACKAGE_FIXTURE_KINDS.call && kind !== PACKAGE_FIXTURE_KINDS.run) {
    throw new PublicContractError(
      `${field}.kind`,
      `must be ${PACKAGE_FIXTURE_KINDS.call} or ${PACKAGE_FIXTURE_KINDS.run}`,
    );
  }
  const fixture = parseExactRecord(
    value,
    field,
    kind === PACKAGE_FIXTURE_KINDS.call
      ? ['fixture_id', 'kind', 'input']
      : ['fixture_id', 'kind', 'input', 'caller_bounds', 'input_mode_id'],
  );
  const fixtureId = parseStableContractId(fixture.fixture_id, `${field}.fixture_id`);
  if (seenFixtureIds.has(fixtureId)) {
    throw new PublicContractError(
      `${field}.fixture_id`,
      'must be unique across every capability in this review: all fixture files share the package fixtures/ directory',
    );
  }
  seenFixtureIds.add(fixtureId);
  assertJsonValue(fixture.input, `${field}.input`, PUBLIC_CONTRACT_LIMITS.maxDepth);
  if (kind === PACKAGE_FIXTURE_KINDS.call) {
    return { kind, fixture_id: fixtureId, input: fixture.input };
  }
  assertJsonValue(fixture.caller_bounds, `${field}.caller_bounds`, PUBLIC_CONTRACT_LIMITS.maxDepth);
  const inputModeId =
    fixture.input_mode_id === null
      ? null
      : parseStableContractId(fixture.input_mode_id, `${field}.input_mode_id`);
  return {
    kind,
    fixture_id: fixtureId,
    input: fixture.input,
    caller_bounds: fixture.caller_bounds,
    input_mode_id: inputModeId,
  };
}
