import {
  parseBoundedRecord,
  parseExactRecord,
  parseInteger,
  parseJsonPointer,
  parseStableContractId,
  parseString,
  PublicContractError,
  type JsonPointerV1,
  type StableContractIdV1,
} from './common';
import { canonicalJson, type JsonValueV1 } from './json';
import { parseJsonSchema, validateJsonSchema, type JsonSchemaV1 } from './json-schema';
import {
  evaluateValueExpression,
  parseValueExpression,
  resolveJsonPointer,
  type ValueExpressionV1,
} from './value-expression';
import {
  evaluateCollectionPredicate,
  parseCollectionPredicate,
  type CollectionPredicateV1,
} from './collection-predicate';
import { evaluateScrapeValue, parseScrapeValue, type ScrapeValueV1 } from './scrape-value';

export type BodyKindV1 = 'json_object' | 'json_array' | 'html' | 'text' | 'empty' | 'binary';
export type OutcomeClassV1 =
  | 'success'
  | 'domain_error'
  | 'caller_error'
  | 'authentication_required'
  | 'rate_limited'
  | 'upstream_unavailable';
export type RetryClassV1 = 'transport_failure' | 'rate_limited' | 'upstream_unavailable';

export type StructuralMatcherV1 =
  | { op: 'all' | 'any'; items: StructuralMatcherV1[] }
  | { op: 'not'; item: StructuralMatcherV1 }
  | { op: 'status_in'; values: number[] }
  | { op: 'body_kind'; value: BodyKindV1 }
  | { op: 'media_type'; value: string }
  | { op: 'header'; name: string; test: 'exists'; value: null }
  | { op: 'header'; name: string; test: 'equals'; value: string }
  | {
      op: 'json_pointer';
      pointer: JsonPointerV1;
      test: 'exists' | 'type' | 'equals';
      value: null | boolean | number | string;
      expected_type: null | 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';
    }
  | {
      op: 'array_length';
      pointer: JsonPointerV1;
      compare: 'eq' | 'lt' | 'lte' | 'gt' | 'gte';
      value: number;
    }
  | { op: 'html_selector_exists'; selector: string }
  | { op: 'body_empty'; value: boolean };

export type OutcomeProjectionV1 =
  | { kind: 'none' }
  | { kind: 'body' }
  | { kind: 'json_pointer'; pointer: JsonPointerV1 }
  | OutcomeJsonArrayMapProjectionV1
  | {
      kind: 'json_object';
      entries: Record<string, OutcomeJsonObjectEntryV1>;
    };

export interface OutcomeJsonArrayMapProjectionV1 {
  kind: 'json_array_map';
  items_pointer: JsonPointerV1;
  include_when: CollectionPredicateV1 | null;
  projection: ScrapeValueV1;
}

export type OutcomeJsonObjectEntryV1 =
  | { kind: 'json_pointer'; pointer: JsonPointerV1 }
  | OutcomeJsonArrayMapProjectionV1;

export type RetryAfterProjectionV1 =
  | {
      kind: 'response_header_delta_seconds';
      header: string;
      minimum_seconds: number;
      maximum_seconds: number;
    }
  | {
      kind: 'json_number';
      pointer: JsonPointerV1;
      unit: 'milliseconds' | 'seconds';
      minimum: number;
      maximum: number;
    };

export interface InputOutputEqualAssertionV1 {
  assertion_id: StableContractIdV1;
  kind: 'input_output_equal';
  input_pointer: JsonPointerV1;
  output_pointer: JsonPointerV1;
}

export interface InputOutputExpressionEqualAssertionV1 {
  assertion_id: StableContractIdV1;
  kind: 'input_output_expression_equal';
  input_expression: ValueExpressionV1;
  output_pointer: JsonPointerV1;
}

export type AssertionV1 = InputOutputEqualAssertionV1 | InputOutputExpressionEqualAssertionV1;

export interface OutcomeCaseV1 {
  case_id: StableContractIdV1;
  strategy_ids: StableContractIdV1[];
  matcher: StructuralMatcherV1;
  projection: OutcomeProjectionV1;
  assertions: AssertionV1[];
  retry_after: RetryAfterProjectionV1 | null;
}

export interface OutcomeContractV1 {
  outcome_id: StableContractIdV1;
  class: OutcomeClassV1;
  output_schema: JsonSchemaV1 | null;
  cases: OutcomeCaseV1[];
}

export interface CallRetryPolicyV1 {
  max_retries: 0 | 1 | 2;
  on: RetryClassV1[];
  base_delay_ms: number;
  max_delay_ms: number;
  jitter_ratio: number;
  honor_structural_retry_after: boolean;
}

export interface OutcomeResponseV1 {
  status: number;
  headers: Readonly<Record<string, string>>;
  media_type: string | null;
  body_kind: BodyKindV1;
  body: JsonValueV1;
}

export interface OutcomeEvaluationContextV1 {
  input: JsonValueV1;
  html_selector_exists?: (selector: string) => boolean;
  maximum_output_bytes?: number;
}

export type OutcomeEvaluationResultV1 =
  | {
      kind: 'outcome';
      outcome_id: StableContractIdV1;
      outcome_class: OutcomeClassV1;
      case_id: StableContractIdV1;
      data: JsonValueV1 | null;
      retry_after_ms: number | null;
    }
  | {
      kind:
        | 'unclassified_response'
        | 'ambiguous_response'
        | 'verification_failed'
        | 'projection_failed';
    };

const BODY_KINDS = new Set<BodyKindV1>([
  'json_object',
  'json_array',
  'html',
  'text',
  'empty',
  'binary',
]);
const OUTCOME_CLASSES = new Set<OutcomeClassV1>([
  'success',
  'domain_error',
  'caller_error',
  'authentication_required',
  'rate_limited',
  'upstream_unavailable',
]);
const RETRY_CLASSES = ['rate_limited', 'transport_failure', 'upstream_unavailable'] as const;
const RAW_ITEM_ONLY = new Set(['raw_item'] as const);

export function parseOutcomeContract(value: unknown, field = 'outcome'): OutcomeContractV1 {
  const record = parseExactRecord(value, field, ['outcome_id', 'class', 'output_schema', 'cases']);
  const outcomeClass = parseOutcomeClass(record.class, `${field}.class`);
  const outputSchema =
    record.output_schema === null
      ? null
      : parseJsonSchema(record.output_schema, `${field}.output_schema`);
  if (!Array.isArray(record.cases) || record.cases.length === 0 || record.cases.length > 32) {
    throw new PublicContractError(`${field}.cases`, 'must contain one to 32 cases');
  }
  const caseIds = new Set<string>();
  const cases = record.cases.map((candidate, index) => {
    const parsed = parseOutcomeCase(
      candidate,
      `${field}.cases[${index}]`,
      outcomeClass,
      outputSchema,
    );
    if (caseIds.has(parsed.case_id)) {
      throw new PublicContractError(`${field}.cases[${index}].case_id`, 'must not be duplicated');
    }
    caseIds.add(parsed.case_id);
    return parsed;
  });
  return {
    outcome_id: parseStableContractId(record.outcome_id, `${field}.outcome_id`),
    class: outcomeClass,
    output_schema: outputSchema,
    cases,
  };
}

export function parseCallRetryPolicy(
  value: unknown,
  field = 'call_retry_policy',
): CallRetryPolicyV1 {
  const record = parseExactRecord(value, field, [
    'max_retries',
    'on',
    'base_delay_ms',
    'max_delay_ms',
    'jitter_ratio',
    'honor_structural_retry_after',
  ]);
  const maxRetries = parseInteger(record.max_retries, `${field}.max_retries`, 0, 2) as 0 | 1 | 2;
  if (!Array.isArray(record.on) || record.on.length > RETRY_CLASSES.length) {
    throw new PublicContractError(`${field}.on`, 'must be an array of retry classes');
  }
  const on: RetryClassV1[] = [];
  for (const [index, entry] of record.on.entries()) {
    if (!RETRY_CLASSES.includes(entry as RetryClassV1)) {
      throw new PublicContractError(`${field}.on[${index}]`, 'must be a supported retry class');
    }
    if (on.includes(entry as RetryClassV1)) {
      throw new PublicContractError(`${field}.on[${index}]`, 'must not contain duplicates');
    }
    on.push(entry as RetryClassV1);
  }
  if (canonicalJson(on) !== canonicalJson([...on].sort(compareText))) {
    throw new PublicContractError(`${field}.on`, 'must be in canonical lexical order');
  }
  if ((maxRetries === 0) !== (on.length === 0)) {
    throw new PublicContractError(field, 'max_retries:0 iff on is empty');
  }
  const baseDelay = parseInteger(record.base_delay_ms, `${field}.base_delay_ms`, 100, 30_000);
  const maxDelay = parseInteger(record.max_delay_ms, `${field}.max_delay_ms`, baseDelay, 60_000);
  if (
    typeof record.jitter_ratio !== 'number' ||
    !Number.isFinite(record.jitter_ratio) ||
    record.jitter_ratio < 0 ||
    record.jitter_ratio > 0.25
  ) {
    throw new PublicContractError(
      `${field}.jitter_ratio`,
      'must be a finite number from 0 to 0.25',
    );
  }
  if (typeof record.honor_structural_retry_after !== 'boolean') {
    throw new PublicContractError(`${field}.honor_structural_retry_after`, 'must be a boolean');
  }
  return {
    max_retries: maxRetries,
    on,
    base_delay_ms: baseDelay,
    max_delay_ms: maxDelay,
    jitter_ratio: record.jitter_ratio,
    honor_structural_retry_after: record.honor_structural_retry_after,
  };
}

export function evaluateOutcomeContracts(
  outcomes: readonly OutcomeContractV1[],
  strategyId: StableContractIdV1,
  response: OutcomeResponseV1,
  context: OutcomeEvaluationContextV1,
): OutcomeEvaluationResultV1 {
  const matches: Array<{ outcome: OutcomeContractV1; case: OutcomeCaseV1 }> = [];
  for (const outcome of outcomes) {
    for (const outcomeCase of outcome.cases) {
      if (!outcomeCase.strategy_ids.includes(strategyId)) continue;
      if (matchesStructuralMatcher(outcomeCase.matcher, response, context)) {
        matches.push({ outcome, case: outcomeCase });
      }
    }
  }
  if (matches.length === 0) return { kind: 'unclassified_response' };
  if (matches.length > 1) return { kind: 'ambiguous_response' };
  const selected = matches[0];
  if (!selected) return { kind: 'unclassified_response' };
  try {
    const data = projectOutcome(selected.case.projection, response);
    if (selected.outcome.output_schema === null) {
      if (data !== null || selected.case.assertions.length > 0)
        return { kind: 'verification_failed' };
    } else {
      if (data === null) return { kind: 'verification_failed' };
      validateJsonSchema(data, selected.outcome.output_schema, 'outcome.data');
      for (const assertion of selected.case.assertions) {
        const inputValue =
          assertion.kind === 'input_output_equal'
            ? resolveJsonPointer(context.input, assertion.input_pointer, 'assertion.input_pointer')
            : evaluateValueExpression(assertion.input_expression, {
                input: context.input,
                bindings: {},
              });
        const outputValue = resolveJsonPointer(
          data,
          assertion.output_pointer,
          'assertion.output_pointer',
        );
        if (canonicalJson(inputValue) !== canonicalJson(outputValue))
          return { kind: 'verification_failed' };
      }
    }
    if (
      data !== null &&
      context.maximum_output_bytes !== undefined &&
      Buffer.byteLength(canonicalJson(data), 'utf8') > context.maximum_output_bytes
    ) {
      return { kind: 'projection_failed' };
    }
    return {
      kind: 'outcome',
      outcome_id: selected.outcome.outcome_id,
      outcome_class: selected.outcome.class,
      case_id: selected.case.case_id,
      data,
      retry_after_ms: resolveStructuralRetryAfter(selected.case.retry_after, response),
    };
  } catch (error) {
    if (error instanceof PublicContractError) return { kind: 'verification_failed' };
    throw error;
  }
}

function resolveStructuralRetryAfter(
  projection: RetryAfterProjectionV1 | null,
  response: OutcomeResponseV1,
): number | null {
  if (projection === null) return null;
  if (projection.kind === 'response_header_delta_seconds') {
    const value = response.headers[projection.header];
    if (!value || !/^(0|[1-9]\d*)$/.test(value)) return null;
    const seconds = Number(value);
    if (
      !Number.isSafeInteger(seconds) ||
      seconds < projection.minimum_seconds ||
      seconds > projection.maximum_seconds
    ) {
      return null;
    }
    return seconds * 1_000;
  }
  const value = tryResolveResponseJsonPointer(response, projection.pointer);
  if (!value.found || typeof value.value !== 'number' || !Number.isSafeInteger(value.value)) {
    return null;
  }
  if (value.value < projection.minimum || value.value > projection.maximum) return null;
  return projection.unit === 'seconds' ? value.value * 1_000 : value.value;
}

export function matchesStructuralMatcher(
  matcher: StructuralMatcherV1,
  response: OutcomeResponseV1,
  context: OutcomeEvaluationContextV1,
): boolean {
  switch (matcher.op) {
    case 'all':
      return matcher.items.every((item) => matchesStructuralMatcher(item, response, context));
    case 'any':
      return matcher.items.some((item) => matchesStructuralMatcher(item, response, context));
    case 'not':
      return !matchesStructuralMatcher(matcher.item, response, context);
    case 'status_in':
      return matcher.values.includes(response.status);
    case 'body_kind':
      return response.body_kind === matcher.value;
    case 'media_type':
      return response.media_type === matcher.value;
    case 'header': {
      const value = response.headers[matcher.name];
      return matcher.test === 'exists' ? value !== undefined : value === matcher.value;
    }
    case 'json_pointer': {
      const value = tryResolveResponseJsonPointer(response, matcher.pointer);
      if (matcher.test === 'exists') return value.found;
      if (!value.found) return false;
      if (matcher.test === 'type') return jsonType(value.value) === matcher.expected_type;
      return canonicalJson(value.value) === canonicalJson(matcher.value);
    }
    case 'array_length': {
      const value = tryResolveResponseJsonPointer(response, matcher.pointer);
      if (!value.found || !Array.isArray(value.value)) return false;
      return compareNumber(value.value.length, matcher.compare, matcher.value);
    }
    case 'html_selector_exists':
      return context.html_selector_exists?.(matcher.selector) ?? false;
    case 'body_empty':
      return isBodyEmpty(response.body) === matcher.value;
  }
}

function parseOutcomeCase(
  value: unknown,
  field: string,
  outcomeClass: OutcomeClassV1,
  outputSchema: JsonSchemaV1 | null,
): OutcomeCaseV1 {
  const record = parseExactRecord(value, field, [
    'case_id',
    'strategy_ids',
    'matcher',
    'projection',
    'assertions',
    'retry_after',
  ]);
  const projection = parseProjection(record.projection, `${field}.projection`);
  if (!Array.isArray(record.assertions) || record.assertions.length > 16) {
    throw new PublicContractError(
      `${field}.assertions`,
      'must be an array with at most 16 assertions',
    );
  }
  const assertionIds = new Set<string>();
  const assertions = record.assertions.map((candidate, index) => {
    const parsed = parseAssertion(candidate, `${field}.assertions[${index}]`);
    if (assertionIds.has(parsed.assertion_id)) {
      throw new PublicContractError(
        `${field}.assertions[${index}].assertion_id`,
        'must not be duplicated',
      );
    }
    assertionIds.add(parsed.assertion_id);
    return parsed;
  });
  if (projection.kind === 'none' && (outputSchema !== null || assertions.length > 0)) {
    throw new PublicContractError(
      field,
      'projection:none requires output_schema:null and no assertions',
    );
  }
  if (projection.kind !== 'none' && outputSchema === null) {
    throw new PublicContractError(field, 'a projected outcome requires an output_schema');
  }
  const retryAfter =
    record.retry_after === null
      ? null
      : parseRetryAfter(record.retry_after, `${field}.retry_after`);
  if (
    retryAfter !== null &&
    outcomeClass !== 'rate_limited' &&
    outcomeClass !== 'upstream_unavailable'
  ) {
    throw new PublicContractError(
      `${field}.retry_after`,
      'is allowed only on rate_limited or upstream_unavailable outcomes',
    );
  }
  return {
    case_id: parseStableContractId(record.case_id, `${field}.case_id`),
    strategy_ids: parseStrategyIds(record.strategy_ids, `${field}.strategy_ids`),
    matcher: parseStructuralMatcher(record.matcher, `${field}.matcher`),
    projection,
    assertions,
    retry_after: retryAfter,
  };
}

function parseStructuralMatcher(value: unknown, field: string, depth = 0): StructuralMatcherV1 {
  if (depth > 12) throw new PublicContractError(field, 'exceeds maximum matcher depth 12');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be a matcher object');
  }
  const op = (value as Record<string, unknown>).op;
  if (typeof op !== 'string') throw new PublicContractError(`${field}.op`, 'must be a string');
  switch (op) {
    case 'all':
    case 'any': {
      const record = parseExactRecord(value, field, ['op', 'items']);
      if (!Array.isArray(record.items) || record.items.length === 0 || record.items.length > 32) {
        throw new PublicContractError(`${field}.items`, 'must contain one to 32 matchers');
      }
      return {
        op,
        items: record.items.map((item, index) =>
          parseStructuralMatcher(item, `${field}.items[${index}]`, depth + 1),
        ),
      };
    }
    case 'not': {
      const record = parseExactRecord(value, field, ['op', 'item']);
      return { op, item: parseStructuralMatcher(record.item, `${field}.item`, depth + 1) };
    }
    case 'status_in': {
      const record = parseExactRecord(value, field, ['op', 'values']);
      return { op, values: parseStatusValues(record.values, `${field}.values`) };
    }
    case 'body_kind': {
      const record = parseExactRecord(value, field, ['op', 'value']);
      if (!BODY_KINDS.has(record.value as BodyKindV1))
        throw new PublicContractError(`${field}.value`, 'must be a supported body kind');
      return { op, value: record.value as BodyKindV1 };
    }
    case 'media_type': {
      const record = parseExactRecord(value, field, ['op', 'value']);
      return { op, value: parseMediaType(record.value, `${field}.value`) };
    }
    case 'header':
      return parseHeaderMatcher(value, field);
    case 'json_pointer':
      return parseJsonPointerMatcher(value, field);
    case 'array_length':
      return parseArrayLengthMatcher(value, field);
    case 'html_selector_exists': {
      const record = parseExactRecord(value, field, ['op', 'selector']);
      return { op, selector: parseSelector(record.selector, `${field}.selector`) };
    }
    case 'body_empty': {
      const record = parseExactRecord(value, field, ['op', 'value']);
      if (typeof record.value !== 'boolean')
        throw new PublicContractError(`${field}.value`, 'must be a boolean');
      return { op, value: record.value };
    }
    default:
      throw new PublicContractError(`${field}.op`, `is not supported: ${JSON.stringify(op)}`);
  }
}

function parseHeaderMatcher(value: unknown, field: string): StructuralMatcherV1 {
  const record = parseExactRecord(value, field, ['op', 'name', 'test', 'value']);
  const name = parseHeaderName(record.name, `${field}.name`);
  if (record.test !== 'exists' && record.test !== 'equals') {
    throw new PublicContractError(`${field}.test`, 'must be "exists" or "equals"');
  }
  if (record.test === 'exists' && record.value !== null) {
    throw new PublicContractError(`${field}.value`, 'must be null for an exists test');
  }
  if (record.test === 'exists') return { op: 'header', name, test: 'exists', value: null };
  const headerValue = record.value;
  if (typeof headerValue !== 'string') {
    throw new PublicContractError(`${field}.value`, 'must be a string for an equals test');
  }
  return { op: 'header', name, test: 'equals', value: headerValue };
}

function parseJsonPointerMatcher(value: unknown, field: string): StructuralMatcherV1 {
  const record = parseExactRecord(value, field, [
    'op',
    'pointer',
    'test',
    'value',
    'expected_type',
  ]);
  if (record.test !== 'exists' && record.test !== 'type' && record.test !== 'equals') {
    throw new PublicContractError(`${field}.test`, 'must be "exists", "type", or "equals"');
  }
  const expectedTypes = new Set(['null', 'boolean', 'number', 'string', 'array', 'object']);
  if (record.test === 'exists' && (record.value !== null || record.expected_type !== null)) {
    throw new PublicContractError(field, 'exists requires value:null and expected_type:null');
  }
  if (
    record.test === 'type' &&
    (record.value !== null || !expectedTypes.has(record.expected_type as string))
  ) {
    throw new PublicContractError(field, 'type requires value:null and one expected_type');
  }
  if (record.test === 'equals' && (record.expected_type !== null || !isScalar(record.value))) {
    throw new PublicContractError(field, 'equals requires a scalar value and expected_type:null');
  }
  return {
    op: 'json_pointer',
    pointer: parseJsonPointer(record.pointer, `${field}.pointer`),
    test: record.test,
    value: record.value as null | boolean | number | string,
    expected_type: record.expected_type as
      | null
      | 'null'
      | 'boolean'
      | 'number'
      | 'string'
      | 'array'
      | 'object',
  };
}

function parseArrayLengthMatcher(value: unknown, field: string): StructuralMatcherV1 {
  const record = parseExactRecord(value, field, ['op', 'pointer', 'compare', 'value']);
  if (!['eq', 'lt', 'lte', 'gt', 'gte'].includes(record.compare as string)) {
    throw new PublicContractError(`${field}.compare`, 'must be a supported comparison');
  }
  return {
    op: 'array_length',
    pointer: parseJsonPointer(record.pointer, `${field}.pointer`),
    compare: record.compare as 'eq' | 'lt' | 'lte' | 'gt' | 'gte',
    value: parseInteger(record.value, `${field}.value`, 0, 10_000),
  };
}

function parseProjection(value: unknown, field: string): OutcomeProjectionV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PublicContractError(field, 'must be an object');
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'none' || kind === 'body') {
    parseExactRecord(value, field, ['kind']);
    return { kind };
  }
  if (kind === 'json_pointer') {
    const record = parseExactRecord(value, field, ['kind', 'pointer']);
    return { kind, pointer: parseJsonPointer(record.pointer, `${field}.pointer`) };
  }
  if (kind === 'json_array_map') {
    return parseJsonArrayMapProjection(value, field);
  }
  if (kind === 'json_object') {
    const record = parseExactRecord(value, field, ['kind', 'entries']);
    const entries = parseBoundedRecord(record.entries, `${field}.entries`, 64);
    if (Object.keys(entries).length === 0) {
      throw new PublicContractError(`${field}.entries`, 'must not be empty');
    }
    const parsed: Record<string, OutcomeJsonObjectEntryV1> = {};
    for (const [name, entry] of Object.entries(entries)) {
      parsed[name] = parseJsonObjectEntry(entry, `${field}.entries.${name}`);
    }
    return { kind, entries: parsed };
  }
  throw new PublicContractError(
    `${field}.kind`,
    'must be "none", "body", "json_pointer", "json_array_map", or "json_object"',
  );
}

function parseJsonObjectEntry(value: unknown, field: string): OutcomeJsonObjectEntryV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object projection entry');
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'json_pointer') {
    const record = parseExactRecord(value, field, ['kind', 'pointer']);
    return { kind, pointer: parseJsonPointer(record.pointer, `${field}.pointer`) };
  }
  if (kind === 'json_array_map') return parseJsonArrayMapProjection(value, field);
  throw new PublicContractError(`${field}.kind`, 'must be json_pointer or json_array_map');
}

function parseJsonArrayMapProjection(
  value: unknown,
  field: string,
): OutcomeJsonArrayMapProjectionV1 {
  const record = parseExactRecord(value, field, [
    'kind',
    'items_pointer',
    'include_when',
    'projection',
  ]);
  return {
    kind: 'json_array_map',
    items_pointer: parseJsonPointer(record.items_pointer, `${field}.items_pointer`),
    include_when:
      record.include_when === null
        ? null
        : parseCollectionPredicate(record.include_when, `${field}.include_when`, RAW_ITEM_ONLY),
    projection: parseScrapeValue(record.projection, `${field}.projection`, RAW_ITEM_ONLY),
  };
}

function parseAssertion(value: unknown, field: string): AssertionV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an assertion object');
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'input_output_equal') {
    const record = parseExactRecord(value, field, [
      'assertion_id',
      'kind',
      'input_pointer',
      'output_pointer',
    ]);
    return {
      assertion_id: parseStableContractId(record.assertion_id, `${field}.assertion_id`),
      kind,
      input_pointer: parseJsonPointer(record.input_pointer, `${field}.input_pointer`),
      output_pointer: parseJsonPointer(record.output_pointer, `${field}.output_pointer`),
    };
  }
  if (kind !== 'input_output_expression_equal') {
    throw new PublicContractError(
      `${field}.kind`,
      'must be "input_output_equal" or "input_output_expression_equal"',
    );
  }
  const record = parseExactRecord(value, field, [
    'assertion_id',
    'kind',
    'input_expression',
    'output_pointer',
  ]);
  const inputExpression = parseValueExpression(
    record.input_expression,
    `${field}.input_expression`,
  );
  assertInputOnlyExpression(inputExpression, `${field}.input_expression`);
  return {
    assertion_id: parseStableContractId(record.assertion_id, `${field}.assertion_id`),
    kind,
    input_expression: inputExpression,
    output_pointer: parseJsonPointer(record.output_pointer, `${field}.output_pointer`),
  };
}

function assertInputOnlyExpression(expression: ValueExpressionV1, field: string): void {
  switch (expression.op) {
    case 'binding':
      throw new PublicContractError(field, 'must not read a binding');
    case 'literal':
    case 'input':
      return;
    case 'object':
      for (const [name, nested] of Object.entries(expression.fields)) {
        assertInputOnlyExpression(nested, `${field}.fields.${name}`);
      }
      return;
    case 'array':
      expression.items.forEach((nested, index) => {
        assertInputOnlyExpression(nested, `${field}.items[${index}]`);
      });
      return;
    case 'concat':
      expression.values.forEach((nested, index) => {
        assertInputOnlyExpression(nested, `${field}.values[${index}]`);
      });
      return;
    case 'to_string':
    case 'url_encode':
    case 'json_encode':
    case 'base64':
    case 'sha256':
      assertInputOnlyExpression(expression.value, `${field}.value`);
      return;
    case 'hmac_sha256':
      assertInputOnlyExpression(expression.key, `${field}.key`);
      assertInputOnlyExpression(expression.value, `${field}.value`);
  }
}

function parseRetryAfter(value: unknown, field: string): RetryAfterProjectionV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PublicContractError(field, 'must be an object');
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'response_header_delta_seconds') {
    const record = parseExactRecord(value, field, [
      'kind',
      'header',
      'minimum_seconds',
      'maximum_seconds',
    ]);
    const minimum = parseInteger(record.minimum_seconds, `${field}.minimum_seconds`, 0, 900);
    return {
      kind,
      header: parseHeaderName(record.header, `${field}.header`),
      minimum_seconds: minimum,
      maximum_seconds: parseInteger(
        record.maximum_seconds,
        `${field}.maximum_seconds`,
        minimum,
        900,
      ),
    };
  }
  if (kind === 'json_number') {
    const record = parseExactRecord(value, field, [
      'kind',
      'pointer',
      'unit',
      'minimum',
      'maximum',
    ]);
    if (record.unit !== 'milliseconds' && record.unit !== 'seconds') {
      throw new PublicContractError(`${field}.unit`, 'must be "milliseconds" or "seconds"');
    }
    const upper = record.unit === 'seconds' ? 900 : 900_000;
    const minimum = parseInteger(record.minimum, `${field}.minimum`, 0, upper);
    return {
      kind,
      pointer: parseJsonPointer(record.pointer, `${field}.pointer`),
      unit: record.unit,
      minimum,
      maximum: parseInteger(record.maximum, `${field}.maximum`, minimum, upper),
    };
  }
  throw new PublicContractError(`${field}.kind`, 'must be a supported retry-after projection');
}

function parseStrategyIds(value: unknown, field: string): StableContractIdV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new PublicContractError(field, 'must contain one to 16 strategy ids');
  }
  const result: StableContractIdV1[] = [];
  for (const [index, entry] of value.entries()) {
    const id = parseStableContractId(entry, `${field}[${index}]`);
    if (result.includes(id))
      throw new PublicContractError(`${field}[${index}]`, 'must not contain duplicates');
    result.push(id);
  }
  return result;
}

function parseStatusValues(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new PublicContractError(field, 'must contain one to 64 status codes');
  }
  const result: number[] = [];
  for (const [index, entry] of value.entries()) {
    const status = parseInteger(entry, `${field}[${index}]`, 100, 599);
    if (result.includes(status))
      throw new PublicContractError(`${field}[${index}]`, 'must not contain duplicates');
    result.push(status);
  }
  return result;
}

function parseOutcomeClass(value: unknown, field: string): OutcomeClassV1 {
  if (typeof value !== 'string' || !OUTCOME_CLASSES.has(value as OutcomeClassV1)) {
    throw new PublicContractError(field, 'must be a supported outcome class');
  }
  return value as OutcomeClassV1;
}

function parseMediaType(value: unknown, field: string): string {
  const mediaType = parseString(value, field, 256);
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(mediaType)) {
    throw new PublicContractError(field, 'must be a lowercase media type without parameters');
  }
  return mediaType;
}

function parseHeaderName(value: unknown, field: string): string {
  const name = parseString(value, field, 128);
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
    throw new PublicContractError(field, 'must be a canonical lowercase HTTP token');
  }
  return name;
}

function parseSelector(value: unknown, field: string): string {
  const selector = parseString(value, field, 512);
  if (selector.length === 0) throw new PublicContractError(field, 'must not be empty');
  return selector;
}

function projectOutcome(
  projection: OutcomeProjectionV1,
  response: OutcomeResponseV1,
): JsonValueV1 | null {
  let data: JsonValueV1 | null;
  switch (projection.kind) {
    case 'none':
      data = null;
      break;
    case 'body':
      data = response.body;
      break;
    case 'json_pointer':
      data = resolveJsonPointer(response.body, projection.pointer, 'outcome.projection.pointer');
      break;
    case 'json_array_map':
      data = projectJsonArray(projection, response);
      break;
    case 'json_object':
      data = projectJsonObject(projection, response);
      break;
  }
  return data;
}

function projectJsonArray(
  projection: OutcomeJsonArrayMapProjectionV1,
  response: OutcomeResponseV1,
): JsonValueV1 {
  const rawItems = resolveJsonPointer(
    response.body,
    projection.items_pointer,
    'outcome.projection.items_pointer',
  );
  if (!Array.isArray(rawItems)) {
    throw new PublicContractError('outcome.projection.items_pointer', 'must resolve to an array');
  }
  const output: JsonValueV1[] = [];
  for (const rawItem of rawItems) {
    const context = { raw_item: rawItem };
    if (
      projection.include_when !== null &&
      !evaluateCollectionPredicate(projection.include_when, context)
    ) {
      continue;
    }
    output.push(evaluateScrapeValue(projection.projection, context));
  }
  return output;
}

function projectJsonObject(
  projection: Extract<OutcomeProjectionV1, { kind: 'json_object' }>,
  response: OutcomeResponseV1,
): JsonValueV1 {
  const output: Record<string, JsonValueV1> = {};
  for (const [name, entry] of Object.entries(projection.entries)) {
    output[name] =
      entry.kind === 'json_pointer'
        ? resolveJsonPointer(response.body, entry.pointer, `outcome.projection.entries.${name}`)
        : projectJsonArray(entry, response);
  }
  return output;
}

function tryResolveResponseJsonPointer(
  response: OutcomeResponseV1,
  pointer: JsonPointerV1,
): { found: true; value: JsonValueV1 } | { found: false } {
  if (response.body_kind !== 'json_object' && response.body_kind !== 'json_array')
    return { found: false };
  try {
    return { found: true, value: resolveJsonPointer(response.body, pointer, 'matcher.pointer') };
  } catch (error) {
    if (error instanceof PublicContractError) return { found: false };
    throw error;
  }
}

function jsonType(
  value: JsonValueV1,
): 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as 'boolean' | 'number' | 'string' | 'object';
}

function isScalar(value: unknown): value is null | boolean | number | string {
  return (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  );
}

function isBodyEmpty(value: JsonValueV1): boolean {
  return value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function compareNumber(
  left: number,
  compare: 'eq' | 'lt' | 'lte' | 'gt' | 'gte',
  right: number,
): boolean {
  switch (compare) {
    case 'eq':
      return left === right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
  }
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
