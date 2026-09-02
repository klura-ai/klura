import {
  parseBoundedRecord,
  parseCapabilityId,
  parseExactRecord,
  parseStableContractId,
  parseString,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  sha256Digest,
  type CapabilityIdV1,
  type StableContractIdV1,
} from './common';
import { assertJsonValue, canonicalJson, type JsonValueV1 } from './json';
import { validateJsonSchema } from './json-schema';
import {
  parseOriginTrafficPolicies,
  parseOrigins,
  uniqueOrigins,
  type OriginTrafficPolicyV1,
} from './traffic-policy';
import {
  parseAuthenticationBrowserResourcePolicy,
  type AuthenticationBrowserResourcePolicyV1,
} from '../../consumer/execution/public-browser/authentication-resource-policy';
import type { PublicReadCapabilityV1 } from './package';

export interface PublicAuthenticationContractV1 {
  login_url: string;
  navigation_origins: [string, ...string[]];
  origin_traffic_policies: [OriginTrafficPolicyV1, ...OriginTrafficPolicyV1[]];
  browser_resources: AuthenticationBrowserResourcePolicyV1;
  check: {
    capability: CapabilityIdV1;
    input: JsonValueV1;
    authenticated_outcome_ids: [StableContractIdV1, ...StableContractIdV1[]];
  };
}

export type PublicCapabilityAuthenticationV1 =
  | { mode: 'none' }
  | {
      mode: 'optional' | 'required';
      authentication_contract_id: StableContractIdV1;
    };

export function parseAuthenticationContracts(
  value: unknown,
): Record<StableContractIdV1, PublicAuthenticationContractV1> {
  const record = parseBoundedRecord(value, 'package.authentication_contracts', 32);
  const contracts = {} as Record<StableContractIdV1, PublicAuthenticationContractV1>;
  for (const [key, candidate] of Object.entries(record)) {
    const contractId = parseStableContractId(key, `package.authentication_contracts.${key}`);
    contracts[contractId] = parseAuthenticationContract(
      candidate,
      `package.authentication_contracts.${contractId}`,
    );
  }
  return contracts;
}

export function parseCapabilityAuthentication(
  value: unknown,
  field: string,
): PublicCapabilityAuthenticationV1 {
  const record = parseBoundedRecord(value, field, 2);
  if (record.mode === 'none') {
    parseExactRecord(record, field, ['mode']);
    return { mode: 'none' };
  }
  const selected = parseExactRecord(record, field, ['mode', 'authentication_contract_id']);
  if (selected.mode !== 'optional' && selected.mode !== 'required') {
    throw new PublicContractError(`${field}.mode`, 'must be none, optional, or required');
  }
  return {
    mode: selected.mode,
    authentication_contract_id: parseStableContractId(
      selected.authentication_contract_id,
      `${field}.authentication_contract_id`,
    ),
  };
}

export function calculateAuthenticationContractDigest(
  contract: PublicAuthenticationContractV1,
): ReturnType<typeof sha256Digest> {
  return sha256Digest(canonicalJson(contract as unknown as JsonValueV1));
}

export function validatePackageAuthentication(
  capabilities: Record<CapabilityIdV1, PublicReadCapabilityV1>,
  contracts: Record<StableContractIdV1, PublicAuthenticationContractV1>,
): void {
  for (const [capabilityId, capability] of Object.entries(capabilities)) {
    if (capability.authentication.mode === 'none') continue;
    if (contracts[capability.authentication.authentication_contract_id] === undefined) {
      throw new PublicContractError(
        `package.capabilities.${capabilityId}.authentication.authentication_contract_id`,
        'does not name an authentication contract in this package',
      );
    }
    if (
      capability.strategies.some(
        (strategy) => strategy.kind === 'http_request' && strategy.context === 'node',
      )
    ) {
      throw new PublicContractError(
        `package.capabilities.${capabilityId}.strategies`,
        'must not use node HTTP when local browser authentication is declared',
      );
    }
  }
  for (const [contractId, contract] of Object.entries(contracts)) {
    const field = `package.authentication_contracts.${contractId}.check`;
    const capability = capabilities[contract.check.capability];
    if (capability === undefined) {
      throw new PublicContractError(
        `${field}.capability`,
        'does not name a capability in this package',
      );
    }
    if (capability.collection !== null) {
      throw new PublicContractError(`${field}.capability`, 'must not have a collection contract');
    }
    if (capability.strategies.length !== 1) {
      throw new PublicContractError(`${field}.capability`, 'must declare exactly one strategy');
    }
    if (capability.call_retry_policy.max_retries !== 0) {
      throw new PublicContractError(`${field}.capability`, 'must not retry automatically');
    }
    if (
      capability.authentication.mode !== 'optional' ||
      capability.authentication.authentication_contract_id !== contractId
    ) {
      throw new PublicContractError(
        `${field}.capability`,
        'must use this authentication contract in optional mode',
      );
    }
    validateJsonSchema(contract.check.input, capability.input_schema, `${field}.input`);
    const successOutcomeIds = capability.outcomes
      .filter((outcome) => outcome.class === 'success')
      .map((outcome) => outcome.outcome_id)
      .sort(compareText);
    if (!sameEntries(contract.check.authenticated_outcome_ids, successOutcomeIds)) {
      throw new PublicContractError(
        `${field}.authenticated_outcome_ids`,
        'must name every success outcome on the check capability exactly once',
      );
    }
  }
}

function parseAuthenticationContract(
  value: unknown,
  field: string,
): PublicAuthenticationContractV1 {
  const record = parseExactRecord(value, field, [
    'login_url',
    'navigation_origins',
    'origin_traffic_policies',
    'browser_resources',
    'check',
  ]);
  const loginUrl = parseHttpsUrl(record.login_url, `${field}.login_url`);
  const navigationOrigins = parseOrigins(
    record.navigation_origins,
    `${field}.navigation_origins`,
    true,
  ) as [string, ...string[]];
  const browserResources = parseAuthenticationBrowserResourcePolicy(
    record.browser_resources,
    `${field}.browser_resources`,
  );
  if (!navigationOrigins.includes(new URL(loginUrl).origin)) {
    throw new PublicContractError(
      `${field}.login_url`,
      'origin must be declared in navigation_origins',
    );
  }
  if (browserResources.egress_rules.some((rule) => !navigationOrigins.includes(rule.origin))) {
    throw new PublicContractError(
      `${field}.browser_resources.egress_rules`,
      'every origin must be declared in navigation_origins',
    );
  }
  const policies = parseOriginTrafficPolicies(
    record.origin_traffic_policies,
    `${field}.origin_traffic_policies`,
    uniqueOrigins([
      ...navigationOrigins,
      ...browserResources.egress_rules.map((rule) => rule.origin),
    ]),
  ) as [OriginTrafficPolicyV1, ...OriginTrafficPolicyV1[]];
  const check = parseExactRecord(record.check, `${field}.check`, [
    'capability',
    'input',
    'authenticated_outcome_ids',
  ]);
  assertJsonValue(check.input, `${field}.check.input`, PUBLIC_CONTRACT_LIMITS.maxDepth);
  if (Buffer.byteLength(canonicalJson(check.input), 'utf8') > 16_384) {
    throw new PublicContractError(`${field}.check.input`, 'must be at most 16384 UTF-8 bytes');
  }
  return {
    login_url: loginUrl,
    navigation_origins: navigationOrigins,
    origin_traffic_policies: policies,
    browser_resources: browserResources,
    check: {
      capability: parseCapabilityId(check.capability, `${field}.check.capability`),
      input: check.input,
      authenticated_outcome_ids: parseStableContractIdList(
        check.authenticated_outcome_ids,
        `${field}.check.authenticated_outcome_ids`,
      ),
    },
  };
}

function parseHttpsUrl(value: unknown, field: string): string {
  const text = parseString(value, field, PUBLIC_CONTRACT_LIMITS.maxStringBytes);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PublicContractError(field, 'must be a canonical HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    text !== url.toString()
  ) {
    throw new PublicContractError(
      field,
      'must be a canonical HTTPS URL without credentials or fragment',
    );
  }
  return text;
}

function parseStableContractIdList(
  value: unknown,
  field: string,
): [StableContractIdV1, ...StableContractIdV1[]] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new PublicContractError(field, 'must contain one to 32 contract ids');
  }
  const ids = value.map((candidate, index) =>
    parseStableContractId(candidate, `${field}[${index}]`),
  );
  if (new Set(ids).size !== ids.length) {
    throw new PublicContractError(field, 'must not contain duplicates');
  }
  if (ids.some((id, index) => index > 0 && (ids[index - 1] ?? '') >= id)) {
    throw new PublicContractError(field, 'must use canonical lexical order');
  }
  return ids as [StableContractIdV1, ...StableContractIdV1[]];
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((entry) => expected.has(entry));
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
