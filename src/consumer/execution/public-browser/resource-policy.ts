import {
  parseBoundedRecord,
  parseExactRecord,
  parseHttpsOrigin,
  parseInteger,
  parseStableContractId,
  parseString,
  PublicContractError,
  type StableContractIdV1,
} from '../../../public/contracts/common';

const MAX_BROWSER_EGRESS_RULES_V1 = 64;
const MAX_BROWSER_ROUTE_PATH_BYTES_V1 = 2_048;
const MAX_BROWSER_QUERY_KEYS_V1 = 32;
const MAX_BROWSER_REQUESTS_PER_TASK_V1 = 256;
const MAX_BROWSER_REQUEST_BODY_BYTES_V1 = 8 * 1024 * 1024;
const MAX_BROWSER_SINGLE_REQUEST_BODY_BYTES_V1 = 1024 * 1024;
const MAX_BROWSER_RESPONSE_BYTES_V1 = 32 * 1024 * 1024;
const MAX_BROWSER_WIRE_BYTES_V1 = 64 * 1024 * 1024;

const BROWSER_RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'script',
  'xhr',
  'fetch',
  'event_source',
  'image',
  'font',
  'media',
  'ping',
  'worker',
] as const;

export type BrowserResourceTypeV1 = (typeof BROWSER_RESOURCE_TYPES)[number];
type BrowserEgressPhaseV1 =
  | 'navigation'
  | 'resource'
  | 'interaction'
  | 'runtime_request'
  | 'page_script';
type BrowserMethodV1 = 'GET' | 'HEAD' | 'POST';

export interface BrowserRouteMatcherV1 {
  path: { kind: 'exact'; value: string } | { kind: 'prefix'; value: string };
  query:
    | { kind: 'none' }
    | {
        kind: 'keys';
        required: string[];
        allowed: string[];
      };
}

export interface BrowserEgressRuleV1 {
  rule_id: StableContractIdV1;
  phase: BrowserEgressPhaseV1;
  origin: string;
  methods: [BrowserMethodV1, ...BrowserMethodV1[]];
  route: BrowserRouteMatcherV1;
  resource_types: [BrowserResourceTypeV1, ...BrowserResourceTypeV1[]];
  max_requests: number;
  max_encoded_request_body_bytes: number;
  max_encoded_response_bytes: number;
}

export interface BrowserResourcePolicyV1 {
  egress_rules: [BrowserEgressRuleV1, ...BrowserEgressRuleV1[]];
  max_requests_per_browser_task: number;
  max_encoded_request_body_bytes_per_browser_task: number;
  max_encoded_response_bytes_per_browser_task: number;
  max_proxy_wire_bytes_per_browser_task: number;
  max_single_request_body_bytes: number;
  max_single_response_bytes: number;
  service_workers: 'block';
  downloads: 'block';
  popups: 'block';
  websockets: 'block';
  webtransport: 'block';
  webrtc_direct_egress: 'block';
  browser_cache: 'block';
}

export interface BrowserEgressCandidateV1 {
  phase: BrowserEgressPhaseV1;
  url: string;
  method: string;
  resource_type: string;
}

export interface BrowserPreflightEgressCandidateV1 extends BrowserEgressCandidateV1 {
  requested_method: string | null;
}

export function parseBrowserResourcePolicy(value: unknown, field: string): BrowserResourcePolicyV1 {
  const record = parseExactRecord(value, field, [
    'egress_rules',
    'max_requests_per_browser_task',
    'max_encoded_request_body_bytes_per_browser_task',
    'max_encoded_response_bytes_per_browser_task',
    'max_proxy_wire_bytes_per_browser_task',
    'max_single_request_body_bytes',
    'max_single_response_bytes',
    'service_workers',
    'downloads',
    'popups',
    'websockets',
    'webtransport',
    'webrtc_direct_egress',
    'browser_cache',
  ]);
  const maxRequests = parseInteger(
    record.max_requests_per_browser_task,
    `${field}.max_requests_per_browser_task`,
    1,
    MAX_BROWSER_REQUESTS_PER_TASK_V1,
  );
  const maxRequestBodyBytes = parseInteger(
    record.max_encoded_request_body_bytes_per_browser_task,
    `${field}.max_encoded_request_body_bytes_per_browser_task`,
    0,
    MAX_BROWSER_REQUEST_BODY_BYTES_V1,
  );
  const maxResponseBytes = parseInteger(
    record.max_encoded_response_bytes_per_browser_task,
    `${field}.max_encoded_response_bytes_per_browser_task`,
    1,
    MAX_BROWSER_RESPONSE_BYTES_V1,
  );
  const maxWireBytes = parseInteger(
    record.max_proxy_wire_bytes_per_browser_task,
    `${field}.max_proxy_wire_bytes_per_browser_task`,
    1,
    MAX_BROWSER_WIRE_BYTES_V1,
  );
  const maxSingleRequestBodyBytes = parseInteger(
    record.max_single_request_body_bytes,
    `${field}.max_single_request_body_bytes`,
    0,
    Math.min(maxRequestBodyBytes, MAX_BROWSER_SINGLE_REQUEST_BODY_BYTES_V1),
  );
  const maxSingleResponseBytes = parseInteger(
    record.max_single_response_bytes,
    `${field}.max_single_response_bytes`,
    1,
    maxResponseBytes,
  );
  for (const name of [
    'service_workers',
    'downloads',
    'popups',
    'websockets',
    'webtransport',
    'webrtc_direct_egress',
    'browser_cache',
  ] as const) {
    if (record[name] !== 'block') {
      throw new PublicContractError(`${field}.${name}`, 'must be block');
    }
  }
  const egressRules = parseEgressRules(
    record.egress_rules,
    `${field}.egress_rules`,
    maxSingleRequestBodyBytes,
  );
  return {
    egress_rules: egressRules,
    max_requests_per_browser_task: maxRequests,
    max_encoded_request_body_bytes_per_browser_task: maxRequestBodyBytes,
    max_encoded_response_bytes_per_browser_task: maxResponseBytes,
    max_proxy_wire_bytes_per_browser_task: maxWireBytes,
    max_single_request_body_bytes: maxSingleRequestBodyBytes,
    max_single_response_bytes: maxSingleResponseBytes,
    service_workers: 'block',
    downloads: 'block',
    popups: 'block',
    websockets: 'block',
    webtransport: 'block',
    webrtc_direct_egress: 'block',
    browser_cache: 'block',
  };
}

export function matchBrowserEgressRule(
  policy: BrowserResourcePolicyV1,
  candidate: BrowserEgressCandidateV1,
): BrowserEgressRuleV1 | null {
  const url = parseBrowserEgressUrl(candidate.url);
  if (url === null) return null;
  const method = candidate.method as BrowserMethodV1;
  const resourceType = candidate.resource_type as BrowserResourceTypeV1;
  if (!BROWSER_RESOURCE_TYPES.includes(resourceType)) return null;
  const matching = policy.egress_rules.filter(
    (rule) =>
      rule.phase === candidate.phase &&
      rule.origin === url.origin &&
      rule.methods.includes(method) &&
      rule.resource_types.includes(resourceType) &&
      browserRouteMatches(rule.route, url),
  );
  return matching.length === 1 ? (matching[0] ?? null) : null;
}

/**
 * A CORS preflight derives authority from one signed request rule. OPTIONS is
 * never independently declarable and cannot add an origin, route, or method.
 */
export function matchBrowserPreflightEgressRule(
  policy: BrowserResourcePolicyV1,
  candidate: BrowserPreflightEgressCandidateV1,
): BrowserEgressRuleV1 | null {
  if (
    candidate.method !== 'OPTIONS' ||
    candidate.resource_type !== 'preflight' ||
    candidate.phase !== 'resource' ||
    !isSupportedBrowserMethod(candidate.requested_method)
  ) {
    return null;
  }
  const requestedMethod = candidate.requested_method;
  const url = parseBrowserEgressUrl(candidate.url);
  if (url === null) return null;
  const matching = policy.egress_rules.filter(
    (rule) =>
      rule.phase === candidate.phase &&
      rule.origin === url.origin &&
      rule.methods.includes(requestedMethod) &&
      rule.resource_types.some(
        (resourceType) => resourceType === 'fetch' || resourceType === 'xhr',
      ) &&
      browserRouteMatches(rule.route, url),
  );
  return matching.length === 1 ? (matching[0] ?? null) : null;
}

function parseEgressRules(
  value: unknown,
  field: string,
  maximumRequestBodyBytes: number,
): [BrowserEgressRuleV1, ...BrowserEgressRuleV1[]] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BROWSER_EGRESS_RULES_V1) {
    throw new PublicContractError(
      field,
      `must contain one to ${MAX_BROWSER_EGRESS_RULES_V1} browser egress rules`,
    );
  }
  const ids = new Set<string>();
  const rules = value.map((candidate, index) => {
    const rule = parseEgressRule(candidate, `${field}[${index}]`, maximumRequestBodyBytes);
    if (ids.has(rule.rule_id)) {
      throw new PublicContractError(`${field}[${index}].rule_id`, 'must not be duplicated');
    }
    ids.add(rule.rule_id);
    return rule;
  });
  for (let left = 0; left < rules.length; left += 1) {
    for (let right = left + 1; right < rules.length; right += 1) {
      const first = rules[left];
      const second = rules[right];
      if (first && second && rulesOverlap(first, second)) {
        throw new PublicContractError(
          field,
          `rules ${JSON.stringify(first.rule_id)} and ${JSON.stringify(second.rule_id)} overlap`,
        );
      }
    }
  }
  return rules as [BrowserEgressRuleV1, ...BrowserEgressRuleV1[]];
}

function parseEgressRule(
  value: unknown,
  field: string,
  maximumRequestBodyBytes: number,
): BrowserEgressRuleV1 {
  const record = parseExactRecord(value, field, [
    'rule_id',
    'phase',
    'origin',
    'methods',
    'route',
    'resource_types',
    'max_requests',
    'max_encoded_request_body_bytes',
    'max_encoded_response_bytes',
  ]);
  if (!isBrowserEgressPhase(record.phase)) {
    throw new PublicContractError(`${field}.phase`, 'must be a browser egress phase');
  }
  const resourceTypes = parseBrowserResourceTypes(record.resource_types, `${field}.resource_types`);
  if (record.phase !== 'resource' && resourceTypes.includes('ping')) {
    throw new PublicContractError(
      `${field}.resource_types`,
      'may contain ping only for a resource rule',
    );
  }
  if (
    record.phase === 'runtime_request' &&
    (resourceTypes.length !== 1 || resourceTypes[0] !== 'fetch')
  ) {
    throw new PublicContractError(
      `${field}.resource_types`,
      'must be exactly fetch for a runtime_request rule',
    );
  }
  if (
    record.phase === 'page_script' &&
    resourceTypes.some((resourceType) => resourceType !== 'fetch' && resourceType !== 'xhr')
  ) {
    throw new PublicContractError(
      `${field}.resource_types`,
      'must contain only fetch and xhr for a page_script rule',
    );
  }
  const methods = parseMethods(record.methods, record.phase, `${field}.methods`);
  const maxRequestBodyBytes = parseInteger(
    record.max_encoded_request_body_bytes,
    `${field}.max_encoded_request_body_bytes`,
    0,
    maximumRequestBodyBytes,
  );
  if (!methods.includes('POST') && maxRequestBodyBytes !== 0) {
    throw new PublicContractError(
      `${field}.max_encoded_request_body_bytes`,
      'must be zero when POST is not declared',
    );
  }
  return {
    rule_id: parseStableContractId(record.rule_id, `${field}.rule_id`),
    phase: record.phase,
    origin: parseHttpsOrigin(record.origin, `${field}.origin`),
    methods,
    route: parseBrowserRouteMatcher(record.route, `${field}.route`),
    resource_types: resourceTypes,
    max_requests: parseInteger(
      record.max_requests,
      `${field}.max_requests`,
      1,
      MAX_BROWSER_REQUESTS_PER_TASK_V1,
    ),
    max_encoded_request_body_bytes: maxRequestBodyBytes,
    max_encoded_response_bytes: parseInteger(
      record.max_encoded_response_bytes,
      `${field}.max_encoded_response_bytes`,
      1,
      MAX_BROWSER_RESPONSE_BYTES_V1,
    ),
  };
}

function parseMethods(
  value: unknown,
  phase: BrowserEgressPhaseV1,
  field: string,
): [BrowserMethodV1, ...BrowserMethodV1[]] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    throw new PublicContractError(field, 'must contain one to three browser methods');
  }
  const methods: BrowserMethodV1[] = [];
  for (const [index, candidate] of value.entries()) {
    if (!isBrowserMethod(candidate, phase)) {
      throw new PublicContractError(
        `${field}[${index}]`,
        `must be ${describeBrowserMethodsForPhase(phase)}`,
      );
    }
    methods.push(candidate);
  }
  assertCanonicalUnique(methods, field);
  return methods as [BrowserMethodV1, ...BrowserMethodV1[]];
}

function describeBrowserMethodsForPhase(phase: BrowserEgressPhaseV1): string {
  if (phase === 'runtime_request' || phase === 'page_script') return 'GET or POST';
  if (phase === 'resource') return 'GET, HEAD, or POST';
  return 'GET or HEAD';
}

function isBrowserMethod(value: unknown, phase: BrowserEgressPhaseV1): value is BrowserMethodV1 {
  if (phase === 'runtime_request' || phase === 'page_script') {
    return value === 'GET' || value === 'POST';
  }
  if (phase === 'resource') return isSupportedBrowserMethod(value);
  return value === 'GET' || value === 'HEAD';
}

function isBrowserEgressPhase(value: unknown): value is BrowserEgressPhaseV1 {
  return (
    value === 'navigation' ||
    value === 'resource' ||
    value === 'interaction' ||
    value === 'runtime_request' ||
    value === 'page_script'
  );
}

export function parseBrowserResourceTypes(
  value: unknown,
  field: string,
): [BrowserResourceTypeV1, ...BrowserResourceTypeV1[]] {
  if (!Array.isArray(value) || value.length === 0 || value.length > BROWSER_RESOURCE_TYPES.length) {
    throw new PublicContractError(field, 'must contain one or more browser resource types');
  }
  const resourceTypes = value.map((candidate, index) => {
    if (!BROWSER_RESOURCE_TYPES.includes(candidate as BrowserResourceTypeV1)) {
      throw new PublicContractError(`${field}[${index}]`, 'must be a browser resource type');
    }
    return candidate as BrowserResourceTypeV1;
  });
  assertCanonicalUnique(resourceTypes, field);
  return resourceTypes as [BrowserResourceTypeV1, ...BrowserResourceTypeV1[]];
}

export function parseBrowserRouteMatcher(value: unknown, field: string): BrowserRouteMatcherV1 {
  const record = parseExactRecord(value, field, ['path', 'query']);
  const path = parseExactRecord(record.path, `${field}.path`, ['kind', 'value']);
  if (path.kind !== 'exact' && path.kind !== 'prefix') {
    throw new PublicContractError(`${field}.path.kind`, 'must be exact or prefix');
  }
  return {
    path: { kind: path.kind, value: parseCanonicalPath(path.value, `${field}.path.value`) },
    query: parseRouteQuery(record.query, `${field}.query`),
  };
}

function parseCanonicalPath(value: unknown, field: string): string {
  const path = parseString(value, field, MAX_BROWSER_ROUTE_PATH_BYTES_V1);
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new PublicContractError(field, 'must be an absolute path without query or fragment');
  }
  let normalized: string;
  try {
    normalized = new URL(path, 'https://route.invalid').pathname;
  } catch {
    throw new PublicContractError(field, 'must be a valid absolute URL path');
  }
  if (normalized !== path) {
    throw new PublicContractError(field, 'must use canonical URL path normalization');
  }
  return path;
}

function parseRouteQuery(value: unknown, field: string): BrowserRouteMatcherV1['query'] {
  const record = parseBoundedRecord(value, field, 3);
  if (record.kind === 'none' && Object.keys(record).length === 1) return { kind: 'none' };
  const exact = parseExactRecord(record, field, ['kind', 'required', 'allowed']);
  if (exact.kind !== 'keys') throw new PublicContractError(`${field}.kind`, 'must be none or keys');
  const required = parseQueryKeys(exact.required, `${field}.required`);
  const allowed = parseQueryKeys(exact.allowed, `${field}.allowed`);
  if (required.some((key) => !allowed.includes(key))) {
    throw new PublicContractError(`${field}.required`, 'must be contained in allowed');
  }
  return { kind: 'keys', required, allowed };
}

function parseQueryKeys(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_BROWSER_QUERY_KEYS_V1) {
    throw new PublicContractError(
      field,
      `must contain at most ${MAX_BROWSER_QUERY_KEYS_V1} query keys`,
    );
  }
  const keys = value.map((candidate, index) => {
    const key = parseString(candidate, `${field}[${index}]`, 128);
    if (key.length === 0 || key.includes('\0')) {
      throw new PublicContractError(
        `${field}[${index}]`,
        'must be a non-empty query key without NUL',
      );
    }
    return key;
  });
  assertCanonicalUnique(keys, field);
  return keys;
}

export function browserRouteMatches(route: BrowserRouteMatcherV1, url: URL): boolean {
  const pathMatches =
    route.path.kind === 'exact'
      ? url.pathname === route.path.value
      : url.pathname.startsWith(route.path.value);
  if (!pathMatches) return false;
  const query = route.query;
  if (query.kind === 'none') return url.search.length === 0;
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return false;
  return (
    keys.every((key) => query.allowed.includes(key)) &&
    query.required.every((key) => keys.includes(key))
  );
}

function rulesOverlap(left: BrowserEgressRuleV1, right: BrowserEgressRuleV1): boolean {
  return (
    left.phase === right.phase &&
    left.origin === right.origin &&
    left.methods.some((method) => right.methods.includes(method)) &&
    (left.resource_types.some((type) => right.resource_types.includes(type)) ||
      (left.phase === 'resource' &&
        canReceiveBrowserPreflight(left) &&
        canReceiveBrowserPreflight(right))) &&
    browserRoutesOverlap(left.route, right.route)
  );
}

function canReceiveBrowserPreflight(rule: BrowserEgressRuleV1): boolean {
  return rule.resource_types.some(
    (resourceType) => resourceType === 'fetch' || resourceType === 'xhr',
  );
}

function parseBrowserEgressUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    return null;
  }
  return url;
}

function isSupportedBrowserMethod(value: unknown): value is BrowserMethodV1 {
  return value === 'GET' || value === 'HEAD' || value === 'POST';
}

export function browserRoutesOverlap(
  left: BrowserRouteMatcherV1,
  right: BrowserRouteMatcherV1,
): boolean {
  return pathsOverlap(left.path, right.path) && queriesOverlap(left.query, right.query);
}

function pathsOverlap(
  left: BrowserRouteMatcherV1['path'],
  right: BrowserRouteMatcherV1['path'],
): boolean {
  if (left.kind === 'exact' && right.kind === 'exact') return left.value === right.value;
  if (left.kind === 'exact') return left.value.startsWith(right.value);
  if (right.kind === 'exact') return right.value.startsWith(left.value);
  return left.value.startsWith(right.value) || right.value.startsWith(left.value);
}

function queriesOverlap(
  left: BrowserRouteMatcherV1['query'],
  right: BrowserRouteMatcherV1['query'],
): boolean {
  if (left.kind === 'none') {
    return right.kind === 'none' || right.required.length === 0;
  }
  if (right.kind === 'none') return left.required.length === 0;
  return (
    left.required.every((key) => right.allowed.includes(key)) &&
    right.required.every((key) => left.allowed.includes(key))
  );
}

function assertCanonicalUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new PublicContractError(field, 'must not contain duplicates');
  }
  if (values.some((value, index) => index > 0 && (values[index - 1] ?? '') >= value)) {
    throw new PublicContractError(field, 'must use canonical lexical order');
  }
}
