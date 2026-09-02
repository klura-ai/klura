import {
  parseCapabilityId,
  parseExactRecord,
  parsePackageVersion,
  parseStableContractId,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  type CapabilityIdV1,
  type PackageVersionV1,
  type StableContractIdV1,
} from './common';
import { assertJsonValue, parseStrictJson, type JsonValueV1 } from './json';

/**
 * Public package fixture contract.
 *
 * One fixture file is the replayable evidence for one smoke execution of a
 * packaged capability: the exporter captures fixtures during export smoke, the
 * tools repository replays them in CI, and reviewers verify exported trees
 * against them. All three sides share this parser, the file-name grammar, and
 * the coverage planner so the contract cannot drift between producers and
 * verifiers.
 */

export const PACKAGE_FIXTURE_SCHEMA_VERSION = 1;

export const PACKAGE_FIXTURE_KINDS = {
  call: 'call',
  run: 'run',
} as const;

export type PackageFixtureKindV1 =
  (typeof PACKAGE_FIXTURE_KINDS)[keyof typeof PACKAGE_FIXTURE_KINDS];

export const PACKAGE_FIXTURE_LIMITS = {
  maximumBytes: 512 * 1024,
  maximumResponses: 128,
  maximumDepth: PUBLIC_CONTRACT_LIMITS.maxDepth,
  maximumFileStemChars: 128,
  maximumSelectorMatches: 32,
  // Matches the selector bound the outcome contract's html_selector_exists
  // matcher parser enforces.
  maximumSelectorChars: 512,
} as const;

export const PACKAGE_FIXTURE_COVERAGE_ISSUE_CODES = {
  missingFixture: 'missing_fixture',
  kindNotAllowed: 'kind_not_allowed',
  unknownCapability: 'unknown_capability',
} as const;

export type PackageFixtureCoverageIssueCodeV1 =
  (typeof PACKAGE_FIXTURE_COVERAGE_ISSUE_CODES)[keyof typeof PACKAGE_FIXTURE_COVERAGE_ISSUE_CODES];

export interface PublicPackageFixtureResponseV1 {
  strategy_id: StableContractIdV1 | null;
  response: {
    status: number;
    headers: Readonly<Record<string, string>>;
    media_type: string | null;
    body_kind: 'json_object' | 'json_array';
    body: JsonValueV1;
    target_requests: number;
    /**
     * Recorded page evaluations for the `html_selector_exists` outcome
     * matchers bound to the responding strategy, keyed by selector. Replay
     * rehydrates the live-page selector callback from this record so
     * selector-matched outcome cases resolve without a browser.
     */
    selector_matches?: Readonly<Record<string, boolean>>;
  };
}

export interface PublicPackageCallFixtureV1 {
  fixture_schema_version: typeof PACKAGE_FIXTURE_SCHEMA_VERSION;
  kind: typeof PACKAGE_FIXTURE_KINDS.call;
  version: PackageVersionV1;
  capability: CapabilityIdV1;
  input: JsonValueV1;
  responses: PublicPackageFixtureResponseV1[];
  caller_bounds: null;
  input_mode_id: null;
  expected: { result: JsonValueV1 };
}

export interface PublicPackageRunFixtureV1 {
  fixture_schema_version: typeof PACKAGE_FIXTURE_SCHEMA_VERSION;
  kind: typeof PACKAGE_FIXTURE_KINDS.run;
  version: PackageVersionV1;
  capability: CapabilityIdV1;
  input: JsonValueV1;
  responses: PublicPackageFixtureResponseV1[];
  caller_bounds: JsonValueV1;
  input_mode_id: StableContractIdV1 | null;
  expected: { result: JsonValueV1; items: JsonValueV1[] };
}

export type PublicPackageFixtureV1 = PublicPackageCallFixtureV1 | PublicPackageRunFixtureV1;

const FIXTURE_KEYS = [
  'fixture_schema_version',
  'kind',
  'version',
  'capability',
  'input',
  'responses',
  'expected',
  'caller_bounds',
  'input_mode_id',
] as const;

/** Parses one fixture value into its exact discriminated call or run shape. */
export function parsePublicPackageFixture(value: unknown, field: string): PublicPackageFixtureV1 {
  const record = parseExactRecord(value, field, FIXTURE_KEYS);
  if (record.fixture_schema_version !== PACKAGE_FIXTURE_SCHEMA_VERSION) {
    throw new PublicContractError(
      `${field}.fixture_schema_version`,
      `must be ${PACKAGE_FIXTURE_SCHEMA_VERSION}`,
    );
  }
  const kind = parsePackageFixtureKind(record.kind, `${field}.kind`);
  const version = parsePackageVersion(record.version, `${field}.version`);
  const capability = parseCapabilityId(record.capability, `${field}.capability`);
  assertJsonValue(record.input, `${field}.input`, PACKAGE_FIXTURE_LIMITS.maximumDepth);
  if (!Array.isArray(record.responses) || record.responses.length === 0) {
    throw new PublicContractError(`${field}.responses`, 'must contain at least one response');
  }
  if (record.responses.length > PACKAGE_FIXTURE_LIMITS.maximumResponses) {
    throw new PublicContractError(
      `${field}.responses`,
      `must contain at most ${PACKAGE_FIXTURE_LIMITS.maximumResponses} responses`,
    );
  }
  const responses = record.responses.map((entry, index) =>
    parseFixtureResponse(entry, `${field}.responses[${index}]`),
  );
  if (kind === PACKAGE_FIXTURE_KINDS.call) {
    if (record.caller_bounds !== null || record.input_mode_id !== null) {
      throw new PublicContractError(
        field,
        'call fixtures must set caller_bounds and input_mode_id to null',
      );
    }
    const expected = parseExactRecord(record.expected, `${field}.expected`, ['result']);
    assertJsonValue(
      expected.result,
      `${field}.expected.result`,
      PACKAGE_FIXTURE_LIMITS.maximumDepth,
    );
    return {
      fixture_schema_version: PACKAGE_FIXTURE_SCHEMA_VERSION,
      kind: PACKAGE_FIXTURE_KINDS.call,
      version,
      capability,
      input: record.input,
      responses,
      caller_bounds: null,
      input_mode_id: null,
      expected: { result: expected.result },
    };
  }
  assertJsonValue(
    record.caller_bounds,
    `${field}.caller_bounds`,
    PACKAGE_FIXTURE_LIMITS.maximumDepth,
  );
  const inputModeId =
    record.input_mode_id === null
      ? null
      : parseStableContractId(record.input_mode_id, `${field}.input_mode_id`);
  const expected = parseExactRecord(record.expected, `${field}.expected`, ['result', 'items']);
  assertJsonValue(expected.result, `${field}.expected.result`, PACKAGE_FIXTURE_LIMITS.maximumDepth);
  if (!Array.isArray(expected.items)) {
    throw new PublicContractError(`${field}.expected.items`, 'must be an array');
  }
  assertJsonValue(expected.items, `${field}.expected.items`, PACKAGE_FIXTURE_LIMITS.maximumDepth);
  return {
    fixture_schema_version: PACKAGE_FIXTURE_SCHEMA_VERSION,
    kind: PACKAGE_FIXTURE_KINDS.run,
    version,
    capability,
    input: record.input,
    responses,
    caller_bounds: record.caller_bounds,
    input_mode_id: inputModeId,
    expected: { result: expected.result, items: expected.items },
  };
}

/** Parses exact fixture file bytes under the same byte and depth bounds every reader applies. */
export function parsePublicPackageFixtureBytes(
  bytes: string | Uint8Array,
  field: string,
): PublicPackageFixtureV1 {
  return parsePublicPackageFixture(
    parseStrictJson(
      bytes,
      field,
      PACKAGE_FIXTURE_LIMITS.maximumBytes,
      PACKAGE_FIXTURE_LIMITS.maximumDepth,
    ),
    field,
  );
}

/** Derives the canonical fixture file name for one fixture identifier and kind. */
export function packageFixtureFileName(fixtureId: string, kind: PackageFixtureKindV1): string {
  const id = parseStableContractId(fixtureId, 'fixture_file.fixture_id');
  return `${id.replaceAll('_', '-')}.${parsePackageFixtureKind(kind, 'fixture_file.kind')}.json`;
}

export interface ParsedPackageFixtureFileNameV1 {
  stem: string;
  kind: PackageFixtureKindV1;
}

const FIXTURE_FILE_STEM_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** Parses one fixture file name into its stem and declared kind. */
export function parsePackageFixtureFileName(
  name: unknown,
  field: string,
): ParsedPackageFixtureFileNameV1 {
  if (typeof name !== 'string') {
    throw new PublicContractError(field, 'must be a string');
  }
  for (const kind of Object.values(PACKAGE_FIXTURE_KINDS)) {
    const suffix = `.${kind}.json`;
    if (!name.endsWith(suffix)) continue;
    const stem = name.slice(0, -suffix.length);
    if (
      stem.length === 0 ||
      stem.length > PACKAGE_FIXTURE_LIMITS.maximumFileStemChars ||
      !FIXTURE_FILE_STEM_RE.test(stem)
    ) {
      throw new PublicContractError(
        field,
        'must use a lowercase dot- or hyphen-separated fixture file stem',
      );
    }
    return { stem, kind };
  }
  throw new PublicContractError(
    field,
    `must end with .${PACKAGE_FIXTURE_KINDS.call}.json or .${PACKAGE_FIXTURE_KINDS.run}.json`,
  );
}

export interface PackageFixtureCoverageEntryV1<Id extends string = string> {
  capability: Id;
  required_kinds: readonly PackageFixtureKindV1[];
}

/**
 * Plans required fixture kinds per capability: every capability replays at
 * least one call fixture, and a capability that declares a collection also
 * replays at least one run fixture.
 */
export function planPackageFixtureCoverage<Id extends string>(
  capabilities: Readonly<Record<Id, { readonly collection: unknown }>>,
): Array<PackageFixtureCoverageEntryV1<Id>> {
  return (Object.keys(capabilities) as Id[])
    .sort((a, b) => a.localeCompare(b))
    .map((capability) => {
      const declared = capabilities[capability];
      const hasCollection = declared.collection !== null && declared.collection !== undefined;
      return {
        capability,
        required_kinds: hasCollection
          ? [PACKAGE_FIXTURE_KINDS.call, PACKAGE_FIXTURE_KINDS.run]
          : [PACKAGE_FIXTURE_KINDS.call],
      };
    });
}

export interface PackageFixtureCoverageIssueV1 {
  code: PackageFixtureCoverageIssueCodeV1;
  capability: string;
  kind: PackageFixtureKindV1;
  message: string;
}

/**
 * Compares planned coverage against covered fixture kinds and returns every
 * issue at once: missing required kinds, kinds the plan does not admit, and
 * coverage claimed for capabilities outside the plan.
 */
export function assessPackageFixtureCoverage(
  plan: ReadonlyArray<PackageFixtureCoverageEntryV1>,
  covered: Iterable<{ capability: string; kind: PackageFixtureKindV1 }>,
): PackageFixtureCoverageIssueV1[] {
  const required = new Map(plan.map((entry) => [entry.capability, new Set(entry.required_kinds)]));
  const issues: PackageFixtureCoverageIssueV1[] = [];
  const seen = new Set<string>();
  for (const entry of covered) {
    const key = `${entry.capability} ${entry.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kinds = required.get(entry.capability);
    if (kinds === undefined) {
      issues.push({
        code: PACKAGE_FIXTURE_COVERAGE_ISSUE_CODES.unknownCapability,
        capability: entry.capability,
        kind: entry.kind,
        message: 'is not a planned capability',
      });
      continue;
    }
    if (!kinds.has(entry.kind)) {
      issues.push({
        code: PACKAGE_FIXTURE_COVERAGE_ISSUE_CODES.kindNotAllowed,
        capability: entry.capability,
        kind: entry.kind,
        message: `declares no collection, so a ${entry.kind} fixture is not allowed`,
      });
    }
  }
  for (const entry of plan) {
    for (const kind of entry.required_kinds) {
      if (!seen.has(`${entry.capability} ${kind}`)) {
        issues.push({
          code: PACKAGE_FIXTURE_COVERAGE_ISSUE_CODES.missingFixture,
          capability: entry.capability,
          kind,
          message: `has no ${kind} fixture`,
        });
      }
    }
  }
  return issues;
}

const FIXTURE_RESPONSE_KEYS = [
  'status',
  'headers',
  'media_type',
  'body_kind',
  'body',
  'target_requests',
] as const;

function parseFixtureResponse(value: unknown, field: string): PublicPackageFixtureResponseV1 {
  const record = parseExactRecord(value, field, ['strategy_id', 'response']);
  const strategyId =
    record.strategy_id === null
      ? null
      : parseStableContractId(record.strategy_id, `${field}.strategy_id`);
  // selector_matches is the one optional response key: only responses whose
  // strategy carries html_selector_exists outcome matchers record it.
  const hasSelectorMatches =
    !!record.response &&
    typeof record.response === 'object' &&
    !Array.isArray(record.response) &&
    'selector_matches' in record.response;
  const response = parseExactRecord(
    record.response,
    `${field}.response`,
    hasSelectorMatches ? [...FIXTURE_RESPONSE_KEYS, 'selector_matches'] : FIXTURE_RESPONSE_KEYS,
  );
  if (
    !Number.isSafeInteger(response.status) ||
    (response.status as number) < 100 ||
    (response.status as number) > 599
  ) {
    throw new PublicContractError(`${field}.response.status`, 'must be an HTTP status');
  }
  if (
    !response.headers ||
    typeof response.headers !== 'object' ||
    Array.isArray(response.headers)
  ) {
    throw new PublicContractError(`${field}.response.headers`, 'must be an object');
  }
  for (const [name, header] of Object.entries(response.headers)) {
    if (name !== name.toLowerCase() || typeof header !== 'string') {
      throw new PublicContractError(
        `${field}.response.headers`,
        'must use lowercase string header values',
      );
    }
  }
  if (response.media_type !== null && typeof response.media_type !== 'string') {
    throw new PublicContractError(`${field}.response.media_type`, 'must be a string or null');
  }
  if (response.body_kind !== 'json_object' && response.body_kind !== 'json_array') {
    throw new PublicContractError(
      `${field}.response.body_kind`,
      'must be json_object or json_array',
    );
  }
  if (
    (response.body_kind === 'json_object' &&
      (!response.body || typeof response.body !== 'object' || Array.isArray(response.body))) ||
    (response.body_kind === 'json_array' && !Array.isArray(response.body))
  ) {
    throw new PublicContractError(`${field}.response.body`, 'does not match body_kind');
  }
  assertJsonValue(response.body, `${field}.response.body`, PACKAGE_FIXTURE_LIMITS.maximumDepth);
  if (!Number.isSafeInteger(response.target_requests) || (response.target_requests as number) < 1) {
    throw new PublicContractError(
      `${field}.response.target_requests`,
      'must be a positive integer',
    );
  }
  const selectorMatches = hasSelectorMatches
    ? parseSelectorMatches(response.selector_matches, `${field}.response.selector_matches`)
    : undefined;
  return {
    strategy_id: strategyId,
    response: {
      status: response.status as number,
      headers: response.headers as Record<string, string>,
      media_type: response.media_type,
      body_kind: response.body_kind,
      body: response.body,
      target_requests: response.target_requests as number,
      ...(selectorMatches === undefined ? {} : { selector_matches: selectorMatches }),
    },
  };
}

function parseSelectorMatches(value: unknown, field: string): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new PublicContractError(field, 'must contain at least one selector');
  }
  if (entries.length > PACKAGE_FIXTURE_LIMITS.maximumSelectorMatches) {
    throw new PublicContractError(
      field,
      `must contain at most ${PACKAGE_FIXTURE_LIMITS.maximumSelectorMatches} selectors`,
    );
  }
  for (const [selector, matched] of entries) {
    if (selector.length === 0 || selector.length > PACKAGE_FIXTURE_LIMITS.maximumSelectorChars) {
      throw new PublicContractError(
        field,
        `selector keys must be 1 to ${PACKAGE_FIXTURE_LIMITS.maximumSelectorChars} characters`,
      );
    }
    if (typeof matched !== 'boolean') {
      throw new PublicContractError(field, 'must map every selector to a boolean');
    }
  }
  return value as Record<string, boolean>;
}

function parsePackageFixtureKind(value: unknown, field: string): PackageFixtureKindV1 {
  if (value !== PACKAGE_FIXTURE_KINDS.call && value !== PACKAGE_FIXTURE_KINDS.run) {
    throw new PublicContractError(
      field,
      `must be ${PACKAGE_FIXTURE_KINDS.call} or ${PACKAGE_FIXTURE_KINDS.run}`,
    );
  }
  return value;
}
