import {
  parseExactRecord,
  parseHttpsOrigin,
  parseInteger,
  parseStableContractId,
  PublicContractError,
  type StableContractIdV1,
} from '../../../public/contracts/common';
import {
  browserRouteMatches,
  browserRoutesOverlap,
  parseBrowserResourceTypes,
  parseBrowserRouteMatcher,
  type BrowserResourceTypeV1,
  type BrowserRouteMatcherV1,
} from './resource-policy';

const MAX_LOGIN_EGRESS_RULES_V1 = 64;
const MAX_LOGIN_REQUESTS_V1 = 256;
const MAX_LOGIN_REQUEST_BODY_BYTES_V1 = 8 * 1024 * 1024;
const MAX_LOGIN_RESPONSE_BYTES_V1 = 32 * 1024 * 1024;
const MAX_LOGIN_WIRE_BYTES_V1 = 64 * 1024 * 1024;
const MAX_LOGIN_SINGLE_REQUEST_BODY_BYTES_V1 = 1024 * 1024;
const MAX_LOGIN_SINGLE_RESPONSE_BYTES_V1 = 8 * 1024 * 1024;

type LoginMethodV1 = 'GET' | 'HEAD' | 'POST';

export interface AuthenticationBrowserEgressRuleV1 {
  rule_id: StableContractIdV1;
  phase: 'login';
  origin: string;
  methods: [LoginMethodV1, ...LoginMethodV1[]];
  route: BrowserRouteMatcherV1;
  resource_types: [BrowserResourceTypeV1, ...BrowserResourceTypeV1[]];
  max_requests: number;
  max_encoded_request_body_bytes: number;
  max_encoded_response_bytes: number;
}

export interface AuthenticationBrowserResourcePolicyV1 {
  egress_rules: [AuthenticationBrowserEgressRuleV1, ...AuthenticationBrowserEgressRuleV1[]];
  max_requests_per_login: number;
  max_encoded_request_body_bytes_per_login: number;
  max_encoded_response_bytes_per_login: number;
  max_proxy_wire_bytes_per_login: number;
  max_single_request_body_bytes: number;
  max_single_response_bytes: number;
  total_timeout_ms: number;
  service_workers: 'block';
  downloads: 'block';
  popups: 'block';
  websockets: 'block';
  webtransport: 'block';
  webrtc_direct_egress: 'block';
  browser_cache: 'block';
}

export interface AuthenticationBrowserEgressCandidateV1 {
  url: string;
  method: string;
  resource_type: string;
}

export function parseAuthenticationBrowserResourcePolicy(
  value: unknown,
  field: string,
): AuthenticationBrowserResourcePolicyV1 {
  const record = parseExactRecord(value, field, [
    'egress_rules',
    'max_requests_per_login',
    'max_encoded_request_body_bytes_per_login',
    'max_encoded_response_bytes_per_login',
    'max_proxy_wire_bytes_per_login',
    'max_single_request_body_bytes',
    'max_single_response_bytes',
    'total_timeout_ms',
    'service_workers',
    'downloads',
    'popups',
    'websockets',
    'webtransport',
    'webrtc_direct_egress',
    'browser_cache',
  ]);
  const maxRequests = parseInteger(
    record.max_requests_per_login,
    `${field}.max_requests_per_login`,
    1,
    MAX_LOGIN_REQUESTS_V1,
  );
  const maxRequestBody = parseInteger(
    record.max_encoded_request_body_bytes_per_login,
    `${field}.max_encoded_request_body_bytes_per_login`,
    0,
    MAX_LOGIN_REQUEST_BODY_BYTES_V1,
  );
  const maxResponse = parseInteger(
    record.max_encoded_response_bytes_per_login,
    `${field}.max_encoded_response_bytes_per_login`,
    1,
    MAX_LOGIN_RESPONSE_BYTES_V1,
  );
  const maxWire = parseInteger(
    record.max_proxy_wire_bytes_per_login,
    `${field}.max_proxy_wire_bytes_per_login`,
    1,
    MAX_LOGIN_WIRE_BYTES_V1,
  );
  const maxSingleRequest = parseInteger(
    record.max_single_request_body_bytes,
    `${field}.max_single_request_body_bytes`,
    0,
    Math.min(maxRequestBody, MAX_LOGIN_SINGLE_REQUEST_BODY_BYTES_V1),
  );
  const maxSingleResponse = parseInteger(
    record.max_single_response_bytes,
    `${field}.max_single_response_bytes`,
    1,
    Math.min(maxResponse, MAX_LOGIN_SINGLE_RESPONSE_BYTES_V1),
  );
  for (const name of BLOCKED_LOGIN_BROWSER_FIELDS) {
    if (record[name] !== 'block') {
      throw new PublicContractError(`${field}.${name}`, 'must be block');
    }
  }
  return {
    egress_rules: parseAuthenticationEgressRules(
      record.egress_rules,
      `${field}.egress_rules`,
      maxRequests,
      maxSingleRequest,
      maxSingleResponse,
    ),
    max_requests_per_login: maxRequests,
    max_encoded_request_body_bytes_per_login: maxRequestBody,
    max_encoded_response_bytes_per_login: maxResponse,
    max_proxy_wire_bytes_per_login: maxWire,
    max_single_request_body_bytes: maxSingleRequest,
    max_single_response_bytes: maxSingleResponse,
    total_timeout_ms: parseInteger(
      record.total_timeout_ms,
      `${field}.total_timeout_ms`,
      1_000,
      900_000,
    ),
    service_workers: 'block',
    downloads: 'block',
    popups: 'block',
    websockets: 'block',
    webtransport: 'block',
    webrtc_direct_egress: 'block',
    browser_cache: 'block',
  };
}

export function matchAuthenticationBrowserEgressRule(
  policy: AuthenticationBrowserResourcePolicyV1,
  candidate: AuthenticationBrowserEgressCandidateV1,
): AuthenticationBrowserEgressRuleV1 | null {
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    return null;
  }
  const method = candidate.method;
  const resourceType = candidate.resource_type;
  if (!isLoginMethod(method) || !isBrowserResourceType(resourceType)) return null;
  const matching = policy.egress_rules.filter(
    (rule) =>
      rule.origin === url.origin &&
      rule.methods.includes(method) &&
      rule.resource_types.includes(resourceType) &&
      browserRouteMatches(rule.route, url),
  );
  return matching.length === 1 ? (matching[0] ?? null) : null;
}

function parseAuthenticationEgressRules(
  value: unknown,
  field: string,
  maximumRequests: number,
  maximumRequestBodyBytes: number,
  maximumResponseBytes: number,
): [AuthenticationBrowserEgressRuleV1, ...AuthenticationBrowserEgressRuleV1[]] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LOGIN_EGRESS_RULES_V1) {
    throw new PublicContractError(
      field,
      `must contain one to ${MAX_LOGIN_EGRESS_RULES_V1} authentication browser egress rules`,
    );
  }
  const ids = new Set<string>();
  const rules = value.map((candidate, index) => {
    const rule = parseAuthenticationEgressRule(
      candidate,
      `${field}[${index}]`,
      maximumRequests,
      maximumRequestBodyBytes,
      maximumResponseBytes,
    );
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
      if (first && second && authenticationRulesOverlap(first, second)) {
        throw new PublicContractError(
          field,
          `rules ${JSON.stringify(first.rule_id)} and ${JSON.stringify(second.rule_id)} overlap`,
        );
      }
    }
  }
  return rules as [AuthenticationBrowserEgressRuleV1, ...AuthenticationBrowserEgressRuleV1[]];
}

function parseAuthenticationEgressRule(
  value: unknown,
  field: string,
  maximumRequests: number,
  maximumRequestBodyBytes: number,
  maximumResponseBytes: number,
): AuthenticationBrowserEgressRuleV1 {
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
  if (record.phase !== 'login') {
    throw new PublicContractError(`${field}.phase`, 'must be login');
  }
  return {
    rule_id: parseStableContractId(record.rule_id, `${field}.rule_id`),
    phase: 'login',
    origin: parseHttpsOrigin(record.origin, `${field}.origin`),
    methods: parseLoginMethods(record.methods, `${field}.methods`),
    route: parseBrowserRouteMatcher(record.route, `${field}.route`),
    resource_types: parseLoginResourceTypes(record.resource_types, `${field}.resource_types`),
    max_requests: parseInteger(record.max_requests, `${field}.max_requests`, 1, maximumRequests),
    max_encoded_request_body_bytes: parseInteger(
      record.max_encoded_request_body_bytes,
      `${field}.max_encoded_request_body_bytes`,
      0,
      maximumRequestBodyBytes,
    ),
    max_encoded_response_bytes: parseInteger(
      record.max_encoded_response_bytes,
      `${field}.max_encoded_response_bytes`,
      1,
      maximumResponseBytes,
    ),
  };
}

function parseLoginResourceTypes(
  value: unknown,
  field: string,
): [BrowserResourceTypeV1, ...BrowserResourceTypeV1[]] {
  const resourceTypes = parseBrowserResourceTypes(value, field);
  if (resourceTypes.includes('ping')) {
    throw new PublicContractError(field, 'may contain ping only for a resource rule');
  }
  if (resourceTypes.includes('document') && resourceTypes.length !== 1) {
    throw new PublicContractError(
      field,
      'must not combine document with another login resource type',
    );
  }
  return resourceTypes;
}

function parseLoginMethods(value: unknown, field: string): [LoginMethodV1, ...LoginMethodV1[]] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    throw new PublicContractError(field, 'must contain one to three login methods');
  }
  const methods = value.map((candidate, index) => {
    if (!isLoginMethod(candidate)) {
      throw new PublicContractError(`${field}[${index}]`, 'must be GET, HEAD, or POST');
    }
    return candidate;
  });
  assertCanonicalUnique(methods, field);
  return methods as [LoginMethodV1, ...LoginMethodV1[]];
}

function authenticationRulesOverlap(
  left: AuthenticationBrowserEgressRuleV1,
  right: AuthenticationBrowserEgressRuleV1,
): boolean {
  return (
    left.origin === right.origin &&
    left.methods.some((method) => right.methods.includes(method)) &&
    (left.resource_types.some((type) => right.resource_types.includes(type)) ||
      (canReceivePreflight(left.resource_types) && canReceivePreflight(right.resource_types))) &&
    browserRoutesOverlap(left.route, right.route)
  );
}

function canReceivePreflight(resourceTypes: readonly BrowserResourceTypeV1[]): boolean {
  return resourceTypes.some((resourceType) => resourceType === 'fetch' || resourceType === 'xhr');
}

function isLoginMethod(value: unknown): value is LoginMethodV1 {
  return value === 'GET' || value === 'HEAD' || value === 'POST';
}

function isBrowserResourceType(value: unknown): value is BrowserResourceTypeV1 {
  return (
    value === 'document' ||
    value === 'stylesheet' ||
    value === 'script' ||
    value === 'xhr' ||
    value === 'fetch' ||
    value === 'event_source' ||
    value === 'image' ||
    value === 'font' ||
    value === 'media' ||
    value === 'worker'
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

const BLOCKED_LOGIN_BROWSER_FIELDS = [
  'service_workers',
  'downloads',
  'popups',
  'websockets',
  'webtransport',
  'webrtc_direct_egress',
  'browser_cache',
] as const;
