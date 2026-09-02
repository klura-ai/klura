import {
  parseExactRecord,
  parseFiniteNumber,
  parseHttpsOrigin,
  parseInteger,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
} from './common';

export interface OriginTrafficPolicyV1 {
  origin: string;
  max_concurrency: number;
  requests_per_second: number;
  burst: number;
  min_delay_ms: number;
  max_redirect_hops: number;
  circuit_breaker: {
    transient_failure_threshold: number;
    transient_window_ms: number;
    cooldown_ms: number;
  };
}

export function parseOrigins(value: unknown, field: string, requireOne: boolean): string[] {
  if (!Array.isArray(value) || value.length > PUBLIC_CONTRACT_LIMITS.maxPackageDomains) {
    throw new PublicContractError(
      field,
      `must contain at most ${PUBLIC_CONTRACT_LIMITS.maxPackageDomains} origins`,
    );
  }
  if (requireOne && value.length === 0) {
    throw new PublicContractError(field, 'must contain at least one origin');
  }
  const origins = value.map((candidate, index) =>
    parseHttpsOrigin(candidate, `${field}[${index}]`),
  );
  assertUnique(origins, field);
  return origins;
}

export function parseOriginTrafficPolicies(
  value: unknown,
  field: string,
  permittedOrigins: readonly string[],
): OriginTrafficPolicyV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > permittedOrigins.length) {
    throw new PublicContractError(
      field,
      'must contain exactly one policy for every permitted origin',
    );
  }
  const policies = value.map((candidate, index) =>
    parseOriginTrafficPolicy(candidate, `${field}[${index}]`),
  );
  const origins = policies.map((policy) => policy.origin);
  assertUnique(origins, field);
  if (!sameEntries(origins, permittedOrigins)) {
    throw new PublicContractError(field, 'must cover every permitted origin exactly once');
  }
  return policies;
}

export function uniqueOrigins(origins: readonly string[]): string[] {
  return [...new Set(origins)].sort(compareText);
}

function parseOriginTrafficPolicy(value: unknown, field: string): OriginTrafficPolicyV1 {
  const record = parseExactRecord(value, field, [
    'origin',
    'max_concurrency',
    'requests_per_second',
    'burst',
    'min_delay_ms',
    'max_redirect_hops',
    'circuit_breaker',
  ]);
  const circuitBreaker = parseExactRecord(record.circuit_breaker, `${field}.circuit_breaker`, [
    'transient_failure_threshold',
    'transient_window_ms',
    'cooldown_ms',
  ]);
  return {
    origin: parseHttpsOrigin(record.origin, `${field}.origin`),
    max_concurrency: parseInteger(record.max_concurrency, `${field}.max_concurrency`, 1, 4),
    requests_per_second: parseFiniteNumber(
      record.requests_per_second,
      `${field}.requests_per_second`,
      Number.MIN_VALUE,
      5,
    ),
    burst: parseInteger(record.burst, `${field}.burst`, 1, 4),
    min_delay_ms: parseInteger(record.min_delay_ms, `${field}.min_delay_ms`, 0, 60_000),
    max_redirect_hops: parseInteger(record.max_redirect_hops, `${field}.max_redirect_hops`, 0, 5),
    circuit_breaker: {
      transient_failure_threshold: parseInteger(
        circuitBreaker.transient_failure_threshold,
        `${field}.circuit_breaker.transient_failure_threshold`,
        1,
        10,
      ),
      transient_window_ms: parseInteger(
        circuitBreaker.transient_window_ms,
        `${field}.circuit_breaker.transient_window_ms`,
        1_000,
        300_000,
      ),
      cooldown_ms: parseInteger(
        circuitBreaker.cooldown_ms,
        `${field}.circuit_breaker.cooldown_ms`,
        1_000,
        900_000,
      ),
    },
  };
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new PublicContractError(field, 'must not contain duplicates');
  }
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
