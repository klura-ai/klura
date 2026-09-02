import { PublicContractError } from '../../public/contracts/common';
import type {
  PublicAuthenticationContractV1,
  PublicBrowserNavigationStrategyV1,
  PublicBrowserPageScriptStrategyV1,
  PublicExecutionStrategyV1,
  PublicHttpStrategyV1,
  PublicReadCapabilityV1,
  PublicToolPackageV1,
} from '../../public/contracts/package';
import type { CollectionRunContractV1 } from '../../public/contracts/collection';
import type {
  RegistryIndexV1,
  RegistryPackageV1,
  RegistryPackageVersionV1,
} from '../../public/contracts/registry-index';

/**
 * Maintainer review projection.
 *
 * The tools-repository review snapshot is the surface a human reviews when a
 * pull request changes a package, so it must be exhaustive over everything a
 * package can execute or emit: every strategy tier projects every contract
 * field — including the complete `browser_page_script` program source — and
 * every capability field projects except the keys named in
 * `REVIEW_PROJECTION_OMITTED_KEYS`. Each projection maps keys explicitly, and
 * the strategy switch has a `never` default, so adding a strategy kind fails
 * compilation and adding a contract field fails the key-exhaustiveness test
 * until the projection makes an include-or-omit decision.
 */

export const REVIEW_PROJECTION_SCHEMA_VERSION = 2;

/**
 * Contract keys deliberately absent from the review projection. Every key of
 * every projected contract must appear either in its projection output or in
 * this record; `runtime/test/registry-catalog.test.js` enforces the union.
 */
export const REVIEW_PROJECTION_OMITTED_KEYS = {
  /** Constant schema marker plus the identity fields the snapshot carries as map keys. */
  package: ['package_schema_version', 'package_id', 'version'],
  /**
   * Deployment mechanics bound by digest checks, the map-key version, and the
   * derived capability summary.
   */
  registry_version: ['version', 'package_url', 'package_bytes', 'capabilities'],
  /** Catalog prose; every executable and budget field projects. */
  capability: ['description'],
  /** Strategies project every contract field. */
  strategy: [],
  /** Authentication contracts project every contract field. */
  authentication_contract: [],
  /** Collection contracts project every contract field. */
  collection: [],
} as const;

export interface ReviewHttpStrategyProjectionV1 {
  kind: PublicHttpStrategyV1['kind'];
  context: PublicHttpStrategyV1['context'];
  request: PublicHttpStrategyV1['request'];
  projection: PublicHttpStrategyV1['projection'];
  prerequisites: PublicHttpStrategyV1['prerequisites'];
  replay: PublicHttpStrategyV1['replay'];
}

export interface ReviewBrowserNavigationStrategyProjectionV1 {
  kind: PublicBrowserNavigationStrategyV1['kind'];
  strategy_id: PublicBrowserNavigationStrategyV1['strategy_id'];
  url: PublicBrowserNavigationStrategyV1['url'];
  wait: PublicBrowserNavigationStrategyV1['wait'];
  interaction: PublicBrowserNavigationStrategyV1['interaction'];
  projection: PublicBrowserNavigationStrategyV1['projection'];
  prerequisites: PublicBrowserNavigationStrategyV1['prerequisites'];
  replay: PublicBrowserNavigationStrategyV1['replay'];
}

export interface ReviewBrowserPageScriptStrategyProjectionV1 {
  kind: PublicBrowserPageScriptStrategyV1['kind'];
  strategy_id: PublicBrowserPageScriptStrategyV1['strategy_id'];
  url: PublicBrowserPageScriptStrategyV1['url'];
  wait: PublicBrowserPageScriptStrategyV1['wait'];
  interaction: PublicBrowserPageScriptStrategyV1['interaction'];
  program: PublicBrowserPageScriptStrategyV1['program'];
  prerequisites: PublicBrowserPageScriptStrategyV1['prerequisites'];
  replay: PublicBrowserPageScriptStrategyV1['replay'];
}

export type ReviewStrategyProjectionV1 =
  | ReviewHttpStrategyProjectionV1
  | ReviewBrowserNavigationStrategyProjectionV1
  | ReviewBrowserPageScriptStrategyProjectionV1;

export interface ReviewCapabilityProjectionV1 {
  visibility: PublicReadCapabilityV1['visibility'];
  effect: PublicReadCapabilityV1['effect'];
  authentication: PublicReadCapabilityV1['authentication'];
  request_origins: PublicReadCapabilityV1['request_origins'];
  navigation_origins: PublicReadCapabilityV1['navigation_origins'];
  origin_traffic_policies: PublicReadCapabilityV1['origin_traffic_policies'];
  browser_resources: PublicReadCapabilityV1['browser_resources'];
  request_budget: {
    max_target_requests_per_call: PublicReadCapabilityV1['max_target_requests_per_call'];
    max_encoded_outcome_bytes: PublicReadCapabilityV1['max_encoded_outcome_bytes'];
    call_timeouts: PublicReadCapabilityV1['call_timeouts'];
    call_retry_policy: PublicReadCapabilityV1['call_retry_policy'];
  };
  input_schema: PublicReadCapabilityV1['input_schema'];
  strategies: ReviewStrategyProjectionV1[];
  outcomes: PublicReadCapabilityV1['outcomes'];
  control: PublicReadCapabilityV1['control'];
  collection: CollectionRunContractV1 | null;
}

export interface ReviewPackageProjectionV1 {
  package_digest: RegistryPackageVersionV1['package_digest'];
  manifest_digest: RegistryPackageVersionV1['manifest_digest'];
  state: RegistryPackageVersionV1['state'];
  runtime_range: RegistryPackageVersionV1['runtime_range'];
  authentication_contracts: Record<string, PublicAuthenticationContractV1>;
  capabilities: Record<string, ReviewCapabilityProjectionV1>;
}

export interface PackageReviewSnapshotV1 {
  review_schema_version: typeof REVIEW_PROJECTION_SCHEMA_VERSION;
  packages: Record<
    string,
    {
      stable_version: RegistryPackageV1['stable_version'];
      versions: Record<string, ReviewPackageProjectionV1>;
    }
  >;
}

/** Projects one execution strategy exhaustively over its contract fields. */
export function projectStrategyForReview(
  strategy: PublicExecutionStrategyV1,
): ReviewStrategyProjectionV1 {
  switch (strategy.kind) {
    case 'http_request':
      return {
        kind: strategy.kind,
        context: strategy.context,
        request: strategy.request,
        projection: strategy.projection,
        prerequisites: strategy.prerequisites,
        replay: strategy.replay,
      };
    case 'browser_navigation':
      return {
        kind: strategy.kind,
        strategy_id: strategy.strategy_id,
        url: strategy.url,
        wait: strategy.wait,
        interaction: strategy.interaction,
        projection: strategy.projection,
        prerequisites: strategy.prerequisites,
        replay: strategy.replay,
      };
    case 'browser_page_script':
      return {
        kind: strategy.kind,
        strategy_id: strategy.strategy_id,
        url: strategy.url,
        wait: strategy.wait,
        interaction: strategy.interaction,
        program: {
          source: strategy.program.source,
          source_digest: strategy.program.source_digest,
          arguments: strategy.program.arguments,
          result_shape: strategy.program.result_shape,
          expect: strategy.program.expect,
          request_body_limits: strategy.program.request_body_limits,
        },
        prerequisites: strategy.prerequisites,
        replay: strategy.replay,
      };
    default:
      return unreachableStrategyKind(strategy);
  }
}

/** Projects one capability; only `description` stays out, per the omission record. */
export function projectCapabilityForReview(
  capability: PublicReadCapabilityV1,
): ReviewCapabilityProjectionV1 {
  return {
    visibility: capability.visibility,
    effect: capability.effect,
    authentication: capability.authentication,
    request_origins: capability.request_origins,
    navigation_origins: capability.navigation_origins,
    origin_traffic_policies: capability.origin_traffic_policies,
    browser_resources: capability.browser_resources,
    request_budget: {
      max_target_requests_per_call: capability.max_target_requests_per_call,
      max_encoded_outcome_bytes: capability.max_encoded_outcome_bytes,
      call_timeouts: capability.call_timeouts,
      call_retry_policy: capability.call_retry_policy,
    },
    input_schema: capability.input_schema,
    strategies: capability.strategies.map(projectStrategyForReview),
    outcomes: capability.outcomes,
    control: capability.control,
    collection: capability.collection === null ? null : projectCollection(capability.collection),
  };
}

/** Projects one package version for review from its verified package and index entry. */
export function projectPackageForReview(
  toolPackage: PublicToolPackageV1,
  registryVersion: RegistryPackageVersionV1,
): ReviewPackageProjectionV1 {
  return {
    package_digest: registryVersion.package_digest,
    manifest_digest: registryVersion.manifest_digest,
    state: registryVersion.state,
    runtime_range: registryVersion.runtime_range,
    authentication_contracts: sortRecord(
      toolPackage.authentication_contracts,
      projectAuthenticationContract,
    ),
    capabilities: sortRecord(toolPackage.capabilities, projectCapabilityForReview),
  };
}

/** Builds the complete deterministic review snapshot for one verified deployment. */
export function buildPackageReviewSnapshot(
  index: RegistryIndexV1,
  loadPackage: (
    registryPackage: RegistryPackageV1,
    registryVersion: RegistryPackageVersionV1,
  ) => PublicToolPackageV1,
): PackageReviewSnapshotV1 {
  return {
    review_schema_version: REVIEW_PROJECTION_SCHEMA_VERSION,
    packages: sortRecord(index.packages, (registryPackage) => ({
      stable_version: registryPackage.stable_version,
      versions: sortRecord(registryPackage.versions, (registryVersion) =>
        projectPackageForReview(loadPackage(registryPackage, registryVersion), registryVersion),
      ),
    })),
  };
}

function projectAuthenticationContract(
  contract: PublicAuthenticationContractV1,
): PublicAuthenticationContractV1 {
  return {
    login_url: contract.login_url,
    navigation_origins: contract.navigation_origins,
    origin_traffic_policies: contract.origin_traffic_policies,
    browser_resources: contract.browser_resources,
    check: contract.check,
  };
}

function projectCollection(collection: CollectionRunContractV1): CollectionRunContractV1 {
  return {
    collection_schema_version: collection.collection_schema_version,
    input_modes: collection.input_modes,
    start_url_templates: collection.start_url_templates,
    item_schema: collection.item_schema,
    item_identity: collection.item_identity,
    inline_output_bound: collection.inline_output_bound,
    semantic_stops: collection.semantic_stops,
    csv_columns: collection.csv_columns,
    task_kinds: collection.task_kinds,
    max_fanout_depth: collection.max_fanout_depth,
    run_policy: collection.run_policy,
  };
}

function sortRecord<Value, Projected>(
  record: Readonly<Record<string, Value>>,
  map: (value: Value) => Projected,
): Record<string, Projected> {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, map(value)]),
  );
}

function unreachableStrategyKind(strategy: never): never {
  throw new PublicContractError(
    'review_projection.strategy.kind',
    `is not a projectable strategy kind: ${JSON.stringify((strategy as { kind?: unknown }).kind)}`,
  );
}
