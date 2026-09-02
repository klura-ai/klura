import {
  parseBoundedRecord,
  parseCapabilityId,
  parseExactRecord,
  parseHttpsOrigin,
  parseInteger,
  parseJsonPointer,
  parsePackageId,
  parsePackageVersion,
  parseSha256Digest,
  parseStableContractId,
  parseString,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  sha256Digest,
  type CapabilityIdV1,
  type JsonPointerV1,
  type PackageIdV1,
  type PackageVersionV1,
  type Sha256DigestV1,
  type StableContractIdV1,
} from './common';
import { canonicalJson, type JsonValueV1 } from './json';
import { parseJsonSchema, type JsonSchemaV1 } from './json-schema';
import { parseCollectionRunContract, type CollectionRunContractV1 } from './collection';
import {
  parseBrowserInteractionProgram,
  parseBrowserWait,
  validateBrowserInteractionProgram,
  type BrowserInteractionProgramV1,
  type BrowserWaitV1,
} from './browser-interaction';
import { parseCssSelector } from './css-selector';
import {
  parseBrowserResourcePolicy,
  type BrowserResourcePolicyV1,
} from '../../consumer/execution/public-browser/resource-policy';
import {
  parseAuthenticationContracts,
  parseCapabilityAuthentication,
  validatePackageAuthentication,
  type PublicAuthenticationContractV1,
  type PublicCapabilityAuthenticationV1,
} from './authentication';
import {
  parseOriginTrafficPolicies,
  parseOrigins,
  uniqueOrigins,
  type OriginTrafficPolicyV1,
} from './traffic-policy';
import { validateBrowserHttpStrategy } from './browser-http-validation';
import {
  parseCallRetryPolicy,
  parseOutcomeContract,
  type CallRetryPolicyV1,
  type OutcomeContractV1,
} from './outcome';
import { assertHttpRequestStringSlots } from './request-slots';
import { parseValueExpression, type ValueExpressionV1 } from './value-expression';
import {
  parseBrowserPageScriptStrategy,
  validateBrowserPageScriptStrategy,
  type PublicBrowserPageScriptStrategyV1,
} from './browser-page-script';

const PACKAGE_KEYS = [
  'package_schema_version',
  'package_id',
  'version',
  'manifest_digest',
  'authentication_contracts',
  'capabilities',
] as const;

const MAX_HTTP_REQUEST_BYTES_V1 = 8 * 1024 * 1024;
const MAX_TARGET_REQUESTS_PER_CALL_V1 = 256;
const RUNTIME_OWNED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'transfer-encoding',
]);

export type { OriginTrafficPolicyV1 } from './traffic-policy';
export type {
  PublicAuthenticationContractV1,
  PublicCapabilityAuthenticationV1,
} from './authentication';

export interface PublicHttpRequestV1 {
  strategy_id: StableContractIdV1;
  method: 'GET' | 'POST';
  base_url: string;
  endpoint: ValueExpressionV1;
  headers: Record<string, ValueExpressionV1>;
  query: Record<string, ValueExpressionV1>;
  body: ValueExpressionV1 | null;
  response_body_limit_bytes: number;
}

export interface PublicHttpStrategyV1 {
  kind: 'http_request';
  context: 'node' | 'browser';
  request: PublicHttpRequestV1;
  projection: { kind: 'json' };
  prerequisites: [];
  replay: 'safe_read' | 'indeterminate';
}

export type DomProjectionFieldV1 =
  | { kind: 'text'; selector: string | null; required: boolean }
  | { kind: 'attribute'; selector: string | null; attribute: string; required: boolean }
  | {
      kind: 'resolved_url';
      selector: string | null;
      attribute: 'href' | 'src';
      required: boolean;
    }
  | { kind: 'json_ld'; selector: string; pointer: JsonPointerV1; required: boolean };

export interface DomProjectionV1 {
  item_selector: string;
  cardinality: 'one' | 'array';
  fields: Record<StableContractIdV1, DomProjectionFieldV1>;
}

export type {
  BrowserActionExpectationV1,
  BrowserActionV1,
  BrowserInteractionProgramV1,
  BrowserTargetV1,
  BrowserWaitV1,
  DomPredicateV1,
} from './browser-interaction';
export type {
  PublicBrowserPageScriptProgramV1,
  PublicBrowserPageScriptRequestBodyLimitsV1,
  PublicBrowserPageScriptResultShapeV1,
  PublicBrowserPageScriptStrategyV1,
} from './browser-page-script';

export interface PublicBrowserNavigationStrategyV1 {
  kind: 'browser_navigation';
  strategy_id: StableContractIdV1;
  url: ValueExpressionV1;
  wait: BrowserWaitV1;
  interaction: BrowserInteractionProgramV1 | null;
  projection: DomProjectionV1;
  prerequisites: [];
  replay: 'safe_read' | 'indeterminate';
}

export type PublicExecutionStrategyV1 =
  | PublicHttpStrategyV1
  | PublicBrowserNavigationStrategyV1
  | PublicBrowserPageScriptStrategyV1;

export interface PublicReadCapabilityV1 {
  description: string;
  visibility: 'public' | 'internal';
  effect: 'read';
  authentication: PublicCapabilityAuthenticationV1;
  request_origins: string[];
  navigation_origins: string[];
  origin_traffic_policies: OriginTrafficPolicyV1[];
  browser_resources: BrowserResourcePolicyV1 | null;
  max_target_requests_per_call: number;
  max_encoded_outcome_bytes: number;
  call_timeouts: {
    per_request_timeout_ms: number;
    total_timeout_ms: number;
  };
  input_schema: JsonSchemaV1;
  call_retry_policy: CallRetryPolicyV1;
  strategies: [PublicExecutionStrategyV1, ...PublicExecutionStrategyV1[]];
  outcomes: [OutcomeContractV1, ...OutcomeContractV1[]];
  control: null;
  collection: CollectionRunContractV1 | null;
}

export interface PublicToolPackageV1 {
  package_schema_version: 1;
  package_id: PackageIdV1;
  version: PackageVersionV1;
  manifest_digest: Sha256DigestV1;
  authentication_contracts: Record<StableContractIdV1, PublicAuthenticationContractV1>;
  capabilities: Record<CapabilityIdV1, PublicReadCapabilityV1>;
}

export function getPublicCapabilityTransports(
  capability: PublicReadCapabilityV1,
): Array<'http_node' | 'http_browser' | 'browser_navigation' | 'browser_page_script'> {
  const transports = new Set<
    'http_node' | 'http_browser' | 'browser_navigation' | 'browser_page_script'
  >();
  for (const strategy of capability.strategies) {
    if (strategy.kind === 'browser_navigation') {
      transports.add('browser_navigation');
    } else if (strategy.kind === 'browser_page_script') {
      transports.add('browser_page_script');
    } else {
      transports.add(strategy.context === 'node' ? 'http_node' : 'http_browser');
    }
  }
  return [...transports].sort(compareText);
}

export function calculatePublicToolPackageManifestDigest(value: unknown): Sha256DigestV1 {
  const record = parseExactRecord(value, 'package', PACKAGE_KEYS);
  const projection = {
    package_schema_version: record.package_schema_version,
    package_id: record.package_id,
    version: record.version,
    authentication_contracts: record.authentication_contracts,
    capabilities: record.capabilities,
  };
  return sha256Digest(canonicalJson(projection as JsonValueV1));
}

export function parsePublicToolPackage(value: unknown): PublicToolPackageV1 {
  const record = parseExactRecord(value, 'package', PACKAGE_KEYS);
  if (record.package_schema_version !== 1) {
    throw new PublicContractError('package.package_schema_version', 'must be 1');
  }
  const manifestDigest = parseSha256Digest(record.manifest_digest, 'package.manifest_digest');
  const actualManifestDigest = calculatePublicToolPackageManifestDigest(record);
  if (manifestDigest !== actualManifestDigest) {
    throw new PublicContractError(
      'package.manifest_digest',
      'does not match the canonical package manifest',
    );
  }
  const authenticationContracts = parseAuthenticationContracts(record.authentication_contracts);
  const capabilitiesRecord = parseBoundedRecord(
    record.capabilities,
    'package.capabilities',
    PUBLIC_CONTRACT_LIMITS.maxPackageCapabilities,
  );
  if (Object.keys(capabilitiesRecord).length === 0) {
    throw new PublicContractError('package.capabilities', 'must contain at least one capability');
  }
  const capabilities = {} as Record<CapabilityIdV1, PublicReadCapabilityV1>;
  for (const [key, candidate] of Object.entries(capabilitiesRecord)) {
    const capabilityId = parseCapabilityId(key, `package.capabilities.${key}`);
    capabilities[capabilityId] = parsePublicReadCapability(
      candidate,
      `package.capabilities.${key}`,
    );
  }
  validatePackageAuthentication(capabilities, authenticationContracts);
  validateCollectionCapabilities(capabilities);
  return {
    package_schema_version: 1,
    package_id: parsePackageId(record.package_id, 'package.package_id'),
    version: parsePackageVersion(record.version, 'package.version'),
    manifest_digest: manifestDigest,
    authentication_contracts: authenticationContracts,
    capabilities,
  };
}

function parsePublicReadCapability(value: unknown, field: string): PublicReadCapabilityV1 {
  const record = parseExactRecord(value, field, [
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
    'strategies',
    'outcomes',
    'control',
    'collection',
  ]);
  if (record.visibility !== 'public' && record.visibility !== 'internal') {
    throw new PublicContractError(`${field}.visibility`, 'must be public or internal');
  }
  if (record.effect !== 'read') {
    throw new PublicContractError(`${field}.effect`, 'must be read');
  }
  const authentication = parseCapabilityAuthentication(
    record.authentication,
    `${field}.authentication`,
  );
  const requestOrigins = parseOrigins(record.request_origins, `${field}.request_origins`, false);
  const navigationOrigins = parseOrigins(
    record.navigation_origins,
    `${field}.navigation_origins`,
    false,
  );
  if (requestOrigins.length === 0 && navigationOrigins.length === 0) {
    throw new PublicContractError(field, 'must declare at least one request or navigation origin');
  }
  if (record.control !== null) {
    throw new PublicContractError(
      field,
      'control requires a public execution profile that is not installed',
    );
  }
  const maxTargetRequests = parseInteger(
    record.max_target_requests_per_call,
    `${field}.max_target_requests_per_call`,
    1,
    MAX_TARGET_REQUESTS_PER_CALL_V1,
  );
  const maxEncodedOutcomeBytes = parseInteger(
    record.max_encoded_outcome_bytes,
    `${field}.max_encoded_outcome_bytes`,
    1,
    16_384,
  );
  const timeouts = parseCallTimeouts(record.call_timeouts, `${field}.call_timeouts`);
  const inputSchema = parseJsonSchema(record.input_schema, `${field}.input_schema`);
  const retryPolicy = parseCallRetryPolicy(record.call_retry_policy, `${field}.call_retry_policy`);
  const strategies = parseStrategies(record.strategies, `${field}.strategies`, requestOrigins);
  strategies.forEach((strategy, index) => {
    if (strategy.kind !== 'http_request') return;
    assertHttpRequestStringSlots(
      strategy.request,
      inputSchema,
      `${field}.strategies[${index}].request`,
    );
  });
  const browserHttpStrategies = strategies.filter(
    (strategy): strategy is PublicHttpStrategyV1 =>
      strategy.kind === 'http_request' && strategy.context === 'browser',
  );
  const hasBrowserNavigation = strategies.some(
    (strategy) => strategy.kind === 'browser_navigation' || strategy.kind === 'browser_page_script',
  );
  const browserPageScripts = strategies.filter(
    (strategy): strategy is PublicBrowserPageScriptStrategyV1 =>
      strategy.kind === 'browser_page_script',
  );
  const hasBrowserExecution = hasBrowserNavigation || browserHttpStrategies.length > 0;
  const browserResources =
    record.browser_resources === null
      ? null
      : parseBrowserResourcePolicy(record.browser_resources, `${field}.browser_resources`);
  if (hasBrowserExecution !== (browserResources !== null)) {
    throw new PublicContractError(
      `${field}.browser_resources`,
      'is required exactly when a browser execution strategy is declared',
    );
  }
  if (hasBrowserExecution && navigationOrigins.length === 0) {
    throw new PublicContractError(
      `${field}.navigation_origins`,
      'must contain at least one origin for browser execution',
    );
  }
  if (!hasBrowserExecution && navigationOrigins.length > 0) {
    throw new PublicContractError(
      `${field}.navigation_origins`,
      'must be empty without a browser strategy',
    );
  }
  if (browserPageScripts.length > 0) {
    if (authentication.mode !== 'none') {
      throw new PublicContractError(
        `${field}.authentication`,
        'must be none for the reviewed browser page-script profile',
      );
    }
    if (navigationOrigins.length !== 1) {
      throw new PublicContractError(
        `${field}.navigation_origins`,
        'must contain exactly one origin for the reviewed browser page-script profile',
      );
    }
  }
  if (browserResources !== null) {
    for (const [index, strategy] of strategies.entries()) {
      if (strategy.kind === 'browser_navigation' && strategy.interaction !== null) {
        validateBrowserInteractionProgram(
          strategy.interaction,
          strategy.projection.cardinality,
          browserResources,
          `${field}.strategies[${index}].interaction`,
        );
      }
      if (strategy.kind === 'browser_page_script') {
        validateBrowserPageScriptStrategy(
          strategy,
          navigationOrigins[0] as string,
          browserResources,
          inputSchema,
          `${field}.strategies[${index}]`,
        );
      }
    }
    for (const strategy of browserHttpStrategies) {
      validateBrowserHttpStrategy(strategy, navigationOrigins, browserResources, field);
    }
  }
  for (const strategy of browserPageScripts) {
    const minimumPerAttempt =
      1 +
      strategy.program.expect.minimum_matching_requests +
      (strategy.interaction?.initial ?? []).reduce(
        (total, action) => total + action.expect.minimum_matching_requests,
        0,
      );
    if (maxTargetRequests < minimumPerAttempt * (1 + retryPolicy.max_retries)) {
      throw new PublicContractError(
        `${field}.max_target_requests_per_call`,
        'must cover navigation, required preparation requests, and required page-script requests for every retry',
      );
    }
  }
  const originTrafficPolicies = parseOriginTrafficPolicies(
    record.origin_traffic_policies,
    `${field}.origin_traffic_policies`,
    uniqueOrigins([
      ...requestOrigins,
      ...navigationOrigins,
      ...(browserResources?.egress_rules.map((rule) => rule.origin) ?? []),
    ]),
  );
  const browserRequestsPerAttempt = browserHttpStrategies.length > 0 ? 2 : 1;
  if (maxTargetRequests < browserRequestsPerAttempt * (1 + retryPolicy.max_retries)) {
    throw new PublicContractError(
      `${field}.max_target_requests_per_call`,
      'must cover the initial request and every same-strategy retry',
    );
  }
  if (
    retryPolicy.max_retries > 0 &&
    strategies.some((strategy) => strategy.replay !== 'safe_read')
  ) {
    throw new PublicContractError(
      `${field}.strategies`,
      'must all be safe_read when call retries are enabled',
    );
  }
  const outcomes = parseOutcomes(record.outcomes, `${field}.outcomes`, strategies);
  const collection =
    record.collection === null
      ? null
      : parseCollectionRunContract(record.collection, `${field}.collection`);
  if (record.visibility === 'internal' && collection !== null) {
    throw new PublicContractError(`${field}.collection`, 'must be null for an internal capability');
  }
  return {
    description: parseNonEmptyString(record.description, `${field}.description`, 256),
    visibility: record.visibility,
    effect: 'read',
    authentication,
    request_origins: requestOrigins,
    navigation_origins: navigationOrigins,
    origin_traffic_policies: originTrafficPolicies,
    browser_resources: browserResources,
    max_target_requests_per_call: maxTargetRequests,
    max_encoded_outcome_bytes: maxEncodedOutcomeBytes,
    call_timeouts: timeouts,
    input_schema: inputSchema,
    call_retry_policy: retryPolicy,
    strategies,
    outcomes,
    control: null,
    collection,
  };
}

function validateCollectionCapabilities(
  capabilities: Record<CapabilityIdV1, PublicReadCapabilityV1>,
): void {
  for (const [ownerId, owner] of Object.entries(capabilities)) {
    const collection = owner.collection;
    if (collection === null) continue;
    const taskKinds = new Map(collection.task_kinds.map((task) => [task.id, task]));
    const rootTaskIds = new Set<StableContractIdV1>();
    for (const mode of collection.input_modes.modes) {
      for (const root of mode.roots) {
        const task = taskKinds.get(root.task_kind);
        if (!task) {
          throw new PublicContractError(
            `package.capabilities.${ownerId}.collection.input_modes`,
            'root does not name a declared task kind',
          );
        }
        if (task.task_role !== 'page') {
          throw new PublicContractError(
            `package.capabilities.${ownerId}.collection.input_modes`,
            'every root must invoke a declared page task',
          );
        }
        rootTaskIds.add(task.id);
      }
    }
    const inbound = new Set<string>();
    for (const task of collection.task_kinds) {
      const target = capabilities[task.capability];
      if (!target) {
        throw new PublicContractError(
          `package.capabilities.${ownerId}.collection.task_kinds.${task.id}.capability`,
          'does not name a capability in this package',
        );
      }
      if (target.strategies.some((strategy) => strategy.replay !== 'safe_read')) {
        throw new PublicContractError(
          `package.capabilities.${ownerId}.collection.task_kinds.${task.id}.capability`,
          'must use only safe_read strategies for durable collection execution',
        );
      }
      if (!sameAuthenticationRealm(owner.authentication, target.authentication)) {
        throw new PublicContractError(
          `package.capabilities.${ownerId}.collection.task_kinds.${task.id}.capability`,
          'must use the same authentication realm as its collection capability',
        );
      }
      const outcomes = new Map(target.outcomes.map((outcome) => [outcome.outcome_id, outcome]));
      for (const outcomeId of task.page_outcome_ids) {
        const outcome = outcomes.get(outcomeId);
        if (!outcome || outcome.class !== 'success') {
          throw new PublicContractError(
            `package.capabilities.${ownerId}.collection.task_kinds.${task.id}.page_outcome_ids`,
            'must name success outcomes on the target capability',
          );
        }
      }
      for (const outcomeId of task.terminal_outcome_ids) {
        const outcome = outcomes.get(outcomeId);
        if (!outcome || (outcome.class !== 'success' && outcome.class !== 'domain_error')) {
          throw new PublicContractError(
            `package.capabilities.${ownerId}.collection.task_kinds.${task.id}.terminal_outcome_ids`,
            'must name success or domain_error outcomes on the target capability',
          );
        }
      }
      for (const fanout of task.fanout) inbound.add(fanout.child_task_kind);
    }
    for (const task of collection.task_kinds) {
      if (task.task_role === 'detail' && !inbound.has(task.id)) {
        throw new PublicContractError(
          `package.capabilities.${ownerId}.collection.task_kinds.${task.id}`,
          'a detail task must be reachable through fan-out',
        );
      }
    }
    const maximumDepth = maximumFanoutDepth(collection.task_kinds, rootTaskIds);
    if (maximumDepth > collection.max_fanout_depth) {
      throw new PublicContractError(
        `package.capabilities.${ownerId}.collection.max_fanout_depth`,
        'is lower than the declared task graph depth',
      );
    }
  }
}

function sameAuthenticationRealm(
  left: PublicReadCapabilityV1['authentication'],
  right: PublicReadCapabilityV1['authentication'],
): boolean {
  if (left.mode === 'none' || right.mode === 'none') {
    return left.mode === 'none' && right.mode === 'none';
  }
  return left.authentication_contract_id === right.authentication_contract_id;
}

function maximumFanoutDepth(
  taskKinds: readonly CollectionRunContractV1['task_kinds'][number][],
  roots: ReadonlySet<StableContractIdV1>,
): number {
  const byId = new Map(taskKinds.map((task) => [task.id, task]));
  const visit = (id: StableContractIdV1, depth: number): number => {
    const task = byId.get(id);
    if (!task) return depth;
    return task.fanout.reduce(
      (maximum, edge) => Math.max(maximum, visit(edge.child_task_kind, depth + 1)),
      depth,
    );
  };
  return Math.max(...[...roots].map((id) => visit(id, 0)));
}

function parseCallTimeouts(
  value: unknown,
  field: string,
): { per_request_timeout_ms: number; total_timeout_ms: number } {
  const record = parseExactRecord(value, field, ['per_request_timeout_ms', 'total_timeout_ms']);
  const perRequest = parseInteger(
    record.per_request_timeout_ms,
    `${field}.per_request_timeout_ms`,
    1_000,
    60_000,
  );
  const total = parseInteger(record.total_timeout_ms, `${field}.total_timeout_ms`, 1_000, 300_000);
  if (total < perRequest) {
    throw new PublicContractError(
      field,
      'total_timeout_ms must be at least per_request_timeout_ms',
    );
  }
  return { per_request_timeout_ms: perRequest, total_timeout_ms: total };
}

function parseStrategies(
  value: unknown,
  field: string,
  requestOrigins: readonly string[],
): [PublicExecutionStrategyV1, ...PublicExecutionStrategyV1[]] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new PublicContractError(field, 'must contain one to eight execution strategies');
  }
  const strategyIds = new Set<string>();
  const strategies = value.map((candidate, index) => {
    const strategy = parseExecutionStrategy(candidate, `${field}[${index}]`, requestOrigins);
    const strategyId = getStrategyId(strategy);
    if (strategyIds.has(strategyId)) {
      throw new PublicContractError(`${field}[${index}].strategy_id`, 'must not be duplicated');
    }
    strategyIds.add(strategyId);
    return strategy;
  });
  return strategies as [PublicExecutionStrategyV1, ...PublicExecutionStrategyV1[]];
}

function parseExecutionStrategy(
  value: unknown,
  field: string,
  requestOrigins: readonly string[],
): PublicExecutionStrategyV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an execution strategy object');
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'browser_navigation') return parseBrowserNavigationStrategy(value, field);
  if (kind === 'browser_page_script') return parseBrowserPageScriptStrategy(value, field);
  return parseHttpStrategy(value, field, requestOrigins);
}

function parseHttpStrategy(
  value: unknown,
  field: string,
  requestOrigins: readonly string[],
): PublicHttpStrategyV1 {
  const record = parseExactRecord(value, field, [
    'kind',
    'context',
    'request',
    'projection',
    'prerequisites',
    'replay',
  ]);
  if (
    record.kind !== 'http_request' ||
    (record.context !== 'node' && record.context !== 'browser')
  ) {
    throw new PublicContractError(
      field,
      'must be a node- or browser-context data-only http_request strategy',
    );
  }
  const projection = parseExactRecord(record.projection, `${field}.projection`, ['kind']);
  if (projection.kind !== 'json') {
    throw new PublicContractError(
      `${field}.projection.kind`,
      'must be json in the current profile',
    );
  }
  if (!Array.isArray(record.prerequisites) || record.prerequisites.length !== 0) {
    throw new PublicContractError(
      `${field}.prerequisites`,
      'must be an empty array in the current profile',
    );
  }
  if (record.replay !== 'safe_read' && record.replay !== 'indeterminate') {
    throw new PublicContractError(`${field}.replay`, 'must be safe_read or indeterminate');
  }
  return {
    kind: 'http_request',
    context: record.context,
    request: parseHttpRequest(record.request, `${field}.request`, requestOrigins),
    projection: { kind: 'json' },
    prerequisites: [],
    replay: record.replay,
  };
}

function parseBrowserNavigationStrategy(
  value: unknown,
  field: string,
): PublicBrowserNavigationStrategyV1 {
  const record = parseExactRecord(value, field, [
    'kind',
    'strategy_id',
    'url',
    'wait',
    'interaction',
    'projection',
    'prerequisites',
    'replay',
  ]);
  if (record.kind !== 'browser_navigation') {
    throw new PublicContractError(`${field}.kind`, 'must be browser_navigation');
  }
  if (!Array.isArray(record.prerequisites) || record.prerequisites.length !== 0) {
    throw new PublicContractError(
      `${field}.prerequisites`,
      'must be an empty array in the public browser-navigation profile',
    );
  }
  if (record.replay !== 'safe_read' && record.replay !== 'indeterminate') {
    throw new PublicContractError(`${field}.replay`, 'must be safe_read or indeterminate');
  }
  return {
    kind: 'browser_navigation',
    strategy_id: parseStableContractId(record.strategy_id, `${field}.strategy_id`),
    url: parseValueExpression(record.url, `${field}.url`),
    wait: parseBrowserWait(record.wait, `${field}.wait`),
    interaction:
      record.interaction === null
        ? null
        : parseBrowserInteractionProgram(record.interaction, `${field}.interaction`),
    projection: parseDomProjection(record.projection, `${field}.projection`),
    prerequisites: [],
    replay: record.replay,
  };
}

function parseDomProjection(value: unknown, field: string): DomProjectionV1 {
  const record = parseExactRecord(value, field, ['item_selector', 'cardinality', 'fields']);
  if (record.cardinality !== 'one' && record.cardinality !== 'array') {
    throw new PublicContractError(`${field}.cardinality`, 'must be one or array');
  }
  const fieldsRecord = parseBoundedRecord(record.fields, `${field}.fields`, 64);
  if (Object.keys(fieldsRecord).length === 0) {
    throw new PublicContractError(`${field}.fields`, 'must contain at least one projected field');
  }
  const fields = {} as DomProjectionV1['fields'];
  for (const [name, candidate] of Object.entries(fieldsRecord)) {
    const fieldId = parseStableContractId(name, `${field}.fields key`);
    fields[fieldId] = parseDomField(candidate, `${field}.fields.${fieldId}`);
  }
  return {
    item_selector: parseCssSelector(record.item_selector, `${field}.item_selector`),
    cardinality: record.cardinality,
    fields,
  };
}

function parseDomField(value: unknown, field: string): DomProjectionFieldV1 {
  const record = parseBoundedRecord(value, field, 5);
  const kind = record.kind;
  if (kind === 'text') {
    const text = parseExactRecord(record, field, ['kind', 'selector', 'required']);
    return {
      kind: 'text',
      selector: parseNullableCssSelector(text.selector, `${field}.selector`),
      required: parseBoolean(text.required, `${field}.required`),
    };
  }
  if (kind === 'attribute') {
    const attribute = parseExactRecord(record, field, [
      'kind',
      'selector',
      'attribute',
      'required',
    ]);
    return {
      kind: 'attribute',
      selector: parseNullableCssSelector(attribute.selector, `${field}.selector`),
      attribute: parseDomAttribute(attribute.attribute, `${field}.attribute`),
      required: parseBoolean(attribute.required, `${field}.required`),
    };
  }
  if (kind === 'resolved_url') {
    const resolved = parseExactRecord(record, field, ['kind', 'selector', 'attribute', 'required']);
    if (resolved.attribute !== 'href' && resolved.attribute !== 'src') {
      throw new PublicContractError(`${field}.attribute`, 'must be href or src');
    }
    return {
      kind: 'resolved_url',
      selector: parseNullableCssSelector(resolved.selector, `${field}.selector`),
      attribute: resolved.attribute,
      required: parseBoolean(resolved.required, `${field}.required`),
    };
  }
  if (kind === 'json_ld') {
    const jsonLd = parseExactRecord(record, field, ['kind', 'selector', 'pointer', 'required']);
    return {
      kind: 'json_ld',
      selector: parseCssSelector(jsonLd.selector, `${field}.selector`),
      pointer: parseJsonPointer(jsonLd.pointer, `${field}.pointer`),
      required: parseBoolean(jsonLd.required, `${field}.required`),
    };
  }
  throw new PublicContractError(`${field}.kind`, 'must be a DOM projection field kind');
}

function parseNullableCssSelector(value: unknown, field: string): string | null {
  return value === null ? null : parseCssSelector(value, field);
}

function parseDomAttribute(value: unknown, field: string): string {
  const attribute = parseString(value, field, 128);
  if (attribute.length === 0 || attribute.includes('\0')) {
    throw new PublicContractError(field, 'must be a non-empty DOM attribute name without NUL');
  }
  return attribute;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new PublicContractError(field, 'must be a boolean');
  return value;
}

function parseHttpRequest(
  value: unknown,
  field: string,
  requestOrigins: readonly string[],
): PublicHttpRequestV1 {
  const record = parseExactRecord(value, field, [
    'strategy_id',
    'method',
    'base_url',
    'endpoint',
    'headers',
    'query',
    'body',
    'response_body_limit_bytes',
  ]);
  if (record.method !== 'GET' && record.method !== 'POST') {
    throw new PublicContractError(`${field}.method`, 'must be GET or POST');
  }
  const baseUrl = parseHttpsOrigin(record.base_url, `${field}.base_url`);
  if (!requestOrigins.includes(baseUrl)) {
    throw new PublicContractError(`${field}.base_url`, 'must be a declared request origin');
  }
  const body = record.body === null ? null : parseValueExpression(record.body, `${field}.body`);
  if (record.method === 'GET' && body !== null) {
    throw new PublicContractError(`${field}.body`, 'must be null for a GET request');
  }
  return {
    strategy_id: parseStableContractId(record.strategy_id, `${field}.strategy_id`),
    method: record.method,
    base_url: baseUrl,
    endpoint: parseValueExpression(record.endpoint, `${field}.endpoint`),
    headers: parseExpressionMap(record.headers, `${field}.headers`, true),
    query: parseExpressionMap(record.query, `${field}.query`, false),
    body,
    response_body_limit_bytes: parseInteger(
      record.response_body_limit_bytes,
      `${field}.response_body_limit_bytes`,
      1,
      MAX_HTTP_REQUEST_BYTES_V1,
    ),
  };
}

function parseExpressionMap(
  value: unknown,
  field: string,
  headers: boolean,
): Record<string, ValueExpressionV1> {
  const record = parseBoundedRecord(value, field, 64);
  const parsed: Record<string, ValueExpressionV1> = {};
  for (const [name, candidate] of Object.entries(record)) {
    const key = headers
      ? parseHeaderKey(name, `${field} key`)
      : parseQueryKey(name, `${field} key`);
    parsed[key] = parseValueExpression(candidate, `${field}.${key}`);
  }
  return parsed;
}

function parseOutcomes(
  value: unknown,
  field: string,
  strategies: readonly PublicExecutionStrategyV1[],
): [OutcomeContractV1, ...OutcomeContractV1[]] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new PublicContractError(field, 'must contain one to 32 outcome contracts');
  }
  const strategyIds = new Set(strategies.map(getStrategyId));
  const outcomeIds = new Set<string>();
  const coveredStrategies = new Set<string>();
  const outcomes = value.map((candidate, index) => {
    const outcome = parseOutcomeContract(candidate, `${field}[${index}]`);
    if (outcomeIds.has(outcome.outcome_id)) {
      throw new PublicContractError(`${field}[${index}].outcome_id`, 'must not be duplicated');
    }
    outcomeIds.add(outcome.outcome_id);
    for (const outcomeCase of outcome.cases) {
      for (const strategyId of outcomeCase.strategy_ids) {
        if (!strategyIds.has(strategyId)) {
          throw new PublicContractError(
            `${field}[${index}].cases`,
            'references a strategy absent from this capability',
          );
        }
        coveredStrategies.add(strategyId);
      }
    }
    return outcome;
  });
  for (const strategyId of strategyIds) {
    if (!coveredStrategies.has(strategyId)) {
      throw new PublicContractError(
        field,
        `does not classify strategy ${JSON.stringify(strategyId)}`,
      );
    }
  }
  return outcomes as [OutcomeContractV1, ...OutcomeContractV1[]];
}

function getStrategyId(strategy: PublicExecutionStrategyV1): StableContractIdV1 {
  return strategy.kind === 'http_request' ? strategy.request.strategy_id : strategy.strategy_id;
}

function parseHeaderKey(value: unknown, field: string): string {
  const key = parseString(value, field, 128);
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) {
    throw new PublicContractError(field, 'must be a canonical lowercase HTTP field name');
  }
  if (RUNTIME_OWNED_REQUEST_HEADERS.has(key)) {
    throw new PublicContractError(field, 'is owned by the runtime request boundary');
  }
  return key;
}

function parseQueryKey(value: unknown, field: string): string {
  const key = parseString(value, field, 128);
  if (key.length === 0 || key.includes('\0')) {
    throw new PublicContractError(field, 'must be a non-empty query key without NUL');
  }
  return key;
}

function parseNonEmptyString(value: unknown, field: string, maximumBytes: number): string {
  const text = parseString(value, field, maximumBytes);
  if (text.length === 0) throw new PublicContractError(field, 'must not be empty');
  return text;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
