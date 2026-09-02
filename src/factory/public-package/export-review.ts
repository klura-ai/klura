// Parsing for the platform-export input: the platform slug, the
// tools-repository path, and the reviewed package contract with its
// per-capability page-script and fixture reviews. Every failure is a
// PublicContractError naming the exact reviewed path, raised before any
// smoke traffic or file writes.
import fs from 'node:fs';
import path from 'node:path';
import {
  parseBoundedRecord,
  parseExactRecord,
  parsePackageId,
  parsePackageVersion,
  parseRuntimeRange,
  parseStableContractId,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  runtimeSupportsVersion,
  type PackageIdV1,
  type PackageVersionV1,
  type StableContractIdV1,
} from '../../public/contracts/common';
import { readConsumerRuntimeVersion } from '../../consumer/runtime-version';
import { assertJsonValue, type JsonValueV1 } from '../../public/contracts/json';
import { PACKAGE_FIXTURE_KINDS } from '../../public/contracts/fixture';
import {
  parseRegistryCatalogManifest,
  parseRegistryReleaseState,
  REGISTRY_CATALOG_SCHEMA_VERSION,
  REGISTRY_RELEASE_CATALOG_KEYS,
  type RegistryCatalogManifestV1,
} from '../../public/contracts/registry-catalog';
import { TOOLS_PACKAGE_LAYOUT_V1 } from './tools-layout';
import { asPlatformSlug, ValidationError } from '../../validators';
import type { PublicReadCapabilitySourceV1 } from './compiler';

const CAPABILITY_CONTRACT_KEYS = [
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

const PAGE_SCRIPT_REVIEW_KEYS = [
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

export interface ParsedExportReviewV1 {
  package_id: PackageIdV1;
  version: PackageVersionV1;
  authentication_contracts: Record<string, unknown>;
  registry_manifest: RegistryCatalogManifestV1;
  capabilities: Record<string, ParsedCapabilityReviewV1>;
}

export function parsePlatform(value: unknown): string {
  try {
    return asPlatformSlug(value, 'platform');
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new PublicContractError('platform_export.platform', error.message);
    }
    throw error;
  }
}

export function parseToolsRepositoryPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new PublicContractError(
      'platform_export.tools_repository_path',
      'must be a non-empty absolute path without NUL',
    );
  }
  if (!path.isAbsolute(value)) {
    throw new PublicContractError(
      'platform_export.tools_repository_path',
      'must be an absolute path',
    );
  }
  const resolved = path.resolve(value);
  const toolsDirectory = path.join(resolved, TOOLS_PACKAGE_LAYOUT_V1.packagesDirectoryName);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    throw new PublicContractError(
      'platform_export.tools_repository_path',
      'must name an existing directory',
    );
  }
  if (!fs.statSync(toolsDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new PublicContractError(
      'platform_export.tools_repository_path',
      'must contain the tools/ package directory',
    );
  }
  return resolved;
}

export function parseExportReview(value: unknown): ParsedExportReviewV1 {
  const review = parseExactRecord(value, 'platform_export.review', [
    'package_id',
    'version',
    'authentication_contracts',
    'catalog',
    'capabilities',
  ]);
  const version = parsePackageVersion(review.version, 'platform_export.review.version');
  const catalog = parseExactRecord(
    review.catalog,
    'platform_export.review.catalog',
    REGISTRY_RELEASE_CATALOG_KEYS,
  );
  const state = parseRegistryReleaseState(catalog.state, 'platform_export.review.catalog.state');
  const runtimeRange = parseRuntimeRange(
    catalog.runtime_range,
    'platform_export.review.catalog.runtime_range',
  );
  // Fixtures are smoke-verified under the exporting runtime, so an installable
  // release may only promise a compatibility window that covers it.
  const exportingRuntime = parsePackageVersion(readConsumerRuntimeVersion(), 'runtime.version');
  if (state === 'installable' && !runtimeSupportsVersion(runtimeRange, exportingRuntime)) {
    throw new PublicContractError(
      'platform_export.review.catalog.runtime_range',
      `must include the exporting runtime ${exportingRuntime}: this export verifies fixtures ` +
        `under that runtime, and [${runtimeRange.minimum_inclusive}, ${runtimeRange.maximum_exclusive}) excludes it`,
    );
  }
  // The written registry.json is validated here, before any smoke traffic,
  // through the same manifest contract every registry-side reader parses.
  const registryManifest = parseRegistryCatalogManifest(
    {
      registry_catalog_schema_version: REGISTRY_CATALOG_SCHEMA_VERSION,
      display_name: catalog.display_name,
      description: catalog.description,
      domains: catalog.domains,
      tags: catalog.tags,
      stable_version: version,
      releases: [
        {
          source: TOOLS_PACKAGE_LAYOUT_V1.packageSourceFileName,
          state,
          runtime_range: runtimeRange,
        },
      ],
    },
    'platform_export.review.catalog',
  );
  const rawCapabilities = parseBoundedRecord(
    review.capabilities,
    'platform_export.review.capabilities',
    32,
  );
  if (Object.keys(rawCapabilities).length === 0) {
    throw new PublicContractError(
      'platform_export.review.capabilities',
      'must contain at least one reviewed capability',
    );
  }
  const capabilities: Record<string, ParsedCapabilityReviewV1> = {};
  // The fixture_id namespace is package-wide: every fixture file lands in the
  // package's single flat fixtures/ directory, so one shared set rejects a
  // collision here — before any smoke traffic — instead of at file-write time.
  const fixtureIds = new Set<string>();
  for (const [capabilityId, value] of Object.entries(rawCapabilities)) {
    capabilities[capabilityId] = parseCapabilityReview(value, capabilityId, fixtureIds);
  }
  return {
    package_id: parsePackageId(review.package_id, 'platform_export.review.package_id'),
    version,
    authentication_contracts: parseBoundedRecord(
      review.authentication_contracts,
      'platform_export.review.authentication_contracts',
      32,
    ),
    registry_manifest: registryManifest,
    capabilities,
  };
}

function parseCapabilityReview(
  value: unknown,
  capabilityId: string,
  seenFixtureIds: Set<string>,
): ParsedCapabilityReviewV1 {
  const field = `platform_export.review.capabilities.${capabilityId}`;
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
    parseFixtureReview(candidate, `${field}.fixtures[${index}]`, seenFixtureIds),
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
