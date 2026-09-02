import {
  parseExactRecord,
  parseJsonPointer,
  parseStableContractId,
  parseString,
  PublicContractError,
  type JsonPointerV1,
  type StableContractIdV1,
} from './common';
import type { JsonValueV1 } from './json';

export type SemanticStopComparatorV1 =
  | { kind: 'iso_date'; format: 'YYYY-MM-DD'; timezone: 'UTC' }
  | { kind: 'rfc3339_instant'; require_explicit_offset: true }
  | { kind: 'integer'; unit: 'plain' | 'unix_seconds' | 'unix_milliseconds' };

export interface DateCutoffSemanticStopV1 {
  id: StableContractIdV1;
  kind: 'date_cutoff';
  bound_arg_pointer: JsonPointerV1;
  item_value_pointer: JsonPointerV1;
  comparator: SemanticStopComparatorV1;
  order: 'ascending' | 'descending';
  inclusive: boolean;
  ordering_assertion_id: StableContractIdV1;
  invalid_item_value: 'item_invalid';
}

export type SemanticStopV1 = DateCutoffSemanticStopV1;

export type SemanticComparableValueV1 = bigint | number;

export interface ResolvedSemanticStopV1 {
  stop: SemanticStopV1;
  bound: SemanticComparableValueV1;
}

export function parseSemanticStops(value: unknown, field: string): SemanticStopV1[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new PublicContractError(field, 'must contain at most 32 semantic stops');
  }
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    const stop = parseSemanticStop(candidate, `${field}[${index}]`);
    if (ids.has(stop.id)) {
      throw new PublicContractError(`${field}[${index}].id`, 'must not be duplicated');
    }
    ids.add(stop.id);
    return stop;
  });
}

/** Resolves an optional caller cutoff without deriving values from unavailable input. */
export function resolveSemanticStops(
  stops: readonly SemanticStopV1[],
  input: JsonValueV1,
): ResolvedSemanticStopV1[] {
  return stops.flatMap((stop) => {
    const value = resolveOptionalPointer(input, stop.bound_arg_pointer);
    if (value === undefined) return [];
    return [
      {
        stop,
        bound: parseComparable(value, stop.comparator, `run.semantic_stop.${stop.id}.bound`),
      },
    ];
  });
}

export function parseSemanticStopItemValue(
  value: JsonValueV1,
  stop: SemanticStopV1,
): SemanticComparableValueV1 {
  return parseComparable(value, stop.comparator, `run.semantic_stop.${stop.id}.item`);
}

export function compareSemanticValues(
  left: SemanticComparableValueV1,
  right: SemanticComparableValueV1,
): -1 | 0 | 1 {
  if (typeof left !== typeof right) {
    throw new PublicContractError('semantic_stop', 'comparator value kinds do not match');
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseSemanticStop(value: unknown, field: string): SemanticStopV1 {
  const record = parseExactRecord(value, field, [
    'id',
    'kind',
    'bound_arg_pointer',
    'item_value_pointer',
    'comparator',
    'order',
    'inclusive',
    'ordering_assertion_id',
    'invalid_item_value',
  ]);
  if (record.kind !== 'date_cutoff') {
    throw new PublicContractError(`${field}.kind`, 'must be date_cutoff');
  }
  if (record.order !== 'ascending' && record.order !== 'descending') {
    throw new PublicContractError(`${field}.order`, 'must be ascending or descending');
  }
  if (typeof record.inclusive !== 'boolean') {
    throw new PublicContractError(`${field}.inclusive`, 'must be a boolean');
  }
  if (record.invalid_item_value !== 'item_invalid') {
    throw new PublicContractError(`${field}.invalid_item_value`, 'must be item_invalid');
  }
  return {
    id: parseStableContractId(record.id, `${field}.id`),
    kind: 'date_cutoff',
    bound_arg_pointer: parseJsonPointer(record.bound_arg_pointer, `${field}.bound_arg_pointer`),
    item_value_pointer: parseJsonPointer(record.item_value_pointer, `${field}.item_value_pointer`),
    comparator: parseComparator(record.comparator, `${field}.comparator`),
    order: record.order,
    inclusive: record.inclusive,
    ordering_assertion_id: parseStableContractId(
      record.ordering_assertion_id,
      `${field}.ordering_assertion_id`,
    ),
    invalid_item_value: 'item_invalid',
  };
}

function parseComparator(value: unknown, field: string): SemanticStopComparatorV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be a comparator object');
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'iso_date') {
    const record = parseExactRecord(value, field, ['kind', 'format', 'timezone']);
    if (record.format !== 'YYYY-MM-DD' || record.timezone !== 'UTC') {
      throw new PublicContractError(field, 'must use the UTC YYYY-MM-DD comparator');
    }
    return { kind, format: 'YYYY-MM-DD', timezone: 'UTC' };
  }
  if (kind === 'rfc3339_instant') {
    const record = parseExactRecord(value, field, ['kind', 'require_explicit_offset']);
    if (record.require_explicit_offset !== true) {
      throw new PublicContractError(`${field}.require_explicit_offset`, 'must be true');
    }
    return { kind, require_explicit_offset: true };
  }
  if (kind === 'integer') {
    const record = parseExactRecord(value, field, ['kind', 'unit']);
    if (
      record.unit !== 'plain' &&
      record.unit !== 'unix_seconds' &&
      record.unit !== 'unix_milliseconds'
    ) {
      throw new PublicContractError(`${field}.unit`, 'is invalid');
    }
    return { kind, unit: record.unit };
  }
  throw new PublicContractError(`${field}.kind`, 'is invalid');
}

function resolveOptionalPointer(
  value: JsonValueV1,
  pointer: JsonPointerV1,
): JsonValueV1 | undefined {
  let current: JsonValueV1 = value;
  if (pointer.length === 0) return current;
  for (const encodedToken of pointer.slice(1).split('/')) {
    const token = encodedToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return undefined;
      const index = Number(token);
      const entry = current[index];
      if (entry === undefined) return undefined;
      current = entry;
      continue;
    }
    if (!current || typeof current !== 'object') return undefined;
    const entry = (current as Record<string, JsonValueV1>)[token];
    if (entry === undefined) return undefined;
    current = entry;
  }
  return current;
}

// Comparator branches preserve numeric versus instant values.
// eslint-disable-next-line sonarjs/function-return-type
function parseComparable(
  value: JsonValueV1,
  comparator: SemanticStopComparatorV1,
  field: string,
): SemanticComparableValueV1 {
  if (comparator.kind === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new PublicContractError(field, 'must be a safe integer');
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new PublicContractError(field, 'must be a string');
  }
  return comparator.kind === 'iso_date'
    ? parseIsoDate(value, field)
    : parseRfc3339Instant(value, field);
}

function parseIsoDate(value: string, field: string): bigint {
  const text = parseString(value, field, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new PublicContractError(field, 'must be an ISO date in YYYY-MM-DD form');
  const year = parseDecimal(match[1], `${field}.year`);
  const month = parseDecimal(match[2], `${field}.month`);
  const day = parseDecimal(match[3], `${field}.day`);
  assertCalendarDate(year, month, day, field);
  return daysFromCivil(year, month, day);
}

function parseRfc3339Instant(value: string, field: string): bigint {
  const text = parseString(value, field, 64);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      text,
    );
  if (!match) {
    throw new PublicContractError(field, 'must be an RFC 3339 instant with an explicit offset');
  }
  const year = parseDecimal(match[1], `${field}.year`);
  const month = parseDecimal(match[2], `${field}.month`);
  const day = parseDecimal(match[3], `${field}.day`);
  const hour = parseDecimal(match[4], `${field}.hour`);
  const minute = parseDecimal(match[5], `${field}.minute`);
  const second = parseDecimal(match[6], `${field}.second`);
  assertCalendarDate(year, month, day, field);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new PublicContractError(field, 'must contain a real clock time without leap seconds');
  }
  const fraction = match[7] ?? '';
  const fractionalNanoseconds = BigInt(
    `${fraction}${'0'.repeat(9 - fraction.length) || ''}` || '0',
  );
  const offset = parseOffset(match[8] ?? '', field);
  const seconds =
    daysFromCivil(year, month, day) * 86_400n +
    BigInt(hour * 3_600 + minute * 60 + second - offset);
  return seconds * 1_000_000_000n + fractionalNanoseconds;
}

function parseOffset(value: string, field: string): number {
  if (value === 'Z') return 0;
  const sign = value[0] === '+' ? 1 : -1;
  const hour = parseDecimal(value.slice(1, 3), `${field}.offset_hour`);
  const minute = parseDecimal(value.slice(4, 6), `${field}.offset_minute`);
  if (hour > 23 || minute > 59) {
    throw new PublicContractError(field, 'must contain a real UTC offset');
  }
  return sign * (hour * 3_600 + minute * 60);
}

function parseDecimal(value: string | undefined, field: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new PublicContractError(field, 'must be decimal digits');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new PublicContractError(field, 'is out of range');
  return number;
}

function assertCalendarDate(year: number, month: number, day: number, field: string): void {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new PublicContractError(field, 'must be a real proleptic Gregorian calendar date');
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Converts a validated proleptic-Gregorian date to days since 1970-01-01. */
function daysFromCivil(year: number, month: number, day: number): bigint {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const transformedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * transformedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return BigInt(era * 146_097 + dayOfEra - 719_468);
}
