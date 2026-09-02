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

export interface ParsedCapabilityReviewV1 {
  contract: Omit<PublicReadCapabilitySourceV1, 'strategies'>;
  page_script: {
    tier: 'page-script';
    strategy_id: StableContractIdV1;
    wait: unknown;
    interaction: unknown;
    expect: unknown;
    request_body_limits: unknown;
    replay: unknown;
  };
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
  const review = parseExactRecord(value, field, ['contract', 'page_script', 'fixtures']);
  const contract = parseExactRecord(review.contract, `${field}.contract`, CAPABILITY_CONTRACT_KEYS);
  const pageScript = parseExactRecord(
    review.page_script,
    `${field}.page_script`,
    PAGE_SCRIPT_REVIEW_KEYS,
  );
  if (pageScript.tier !== 'page-script') {
    throw new PublicContractError(`${field}.page_script.tier`, 'must be page-script');
  }
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
    page_script: {
      tier: 'page-script',
      strategy_id: parseStableContractId(
        pageScript.strategy_id,
        `${field}.page_script.strategy_id`,
      ),
      wait: pageScript.wait,
      interaction: pageScript.interaction,
      expect: pageScript.expect,
      request_body_limits: pageScript.request_body_limits,
      replay: pageScript.replay,
    },
    fixtures,
  };
}

/**
 * Projects a reviewed capability and its saved local page-script onto the
 * compilable capability source, which binds the reviewed contract to the one
 * public strategy derived from the local page-script.
 */
export function buildCapabilitySource(
  localStrategy: Strategy,
  capabilityReview: Pick<ParsedCapabilityReviewV1, 'contract' | 'page_script'>,
): PublicReadCapabilitySourceV1 {
  const publicStrategy = exportReviewedLocalPageScriptStrategySource({
    local_strategy: localStrategy,
    input_schema: capabilityReview.contract.input_schema,
    strategy_id: capabilityReview.page_script.strategy_id,
    wait: capabilityReview.page_script.wait,
    interaction: capabilityReview.page_script.interaction,
    expect: capabilityReview.page_script.expect,
    request_body_limits: capabilityReview.page_script.request_body_limits,
    replay: capabilityReview.page_script.replay,
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
