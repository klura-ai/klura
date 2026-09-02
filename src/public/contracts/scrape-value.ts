import {
  parseBoundedRecord,
  parseExactRecord,
  parseInteger,
  parseJsonPointer,
  PublicContractError,
  type JsonPointerV1,
} from './common';
import { assertJsonValue, type JsonValueV1 } from './json';
import { resolveJsonPointer } from './value-expression';

export type ScrapeValueSourceV1 = 'args' | 'seed' | 'parent_item' | 'task_data' | 'raw_item';

export type ScrapeValueV1 =
  | { op: 'get'; from: ScrapeValueSourceV1; pointer: JsonPointerV1 }
  | { op: 'literal'; value: JsonValueV1 }
  | { op: 'add_integer'; value: ScrapeValueV1; amount: number }
  | { op: 'object'; entries: Record<string, ScrapeValueV1> }
  | { op: 'array'; items: ScrapeValueV1[] };

export type ScrapeValueContextV1 = Partial<Record<ScrapeValueSourceV1, JsonValueV1>>;

const MAX_SCRAPE_VALUE_DEPTH_V1 = 12;
const MAX_SCRAPE_VALUE_ENTRIES_V1 = 64;

export class ScrapeValueError extends PublicContractError {
  constructor(message: string) {
    super('scrape_value', message);
    this.name = 'ScrapeValueError';
  }
}

export function parseScrapeValue(
  value: unknown,
  field: string,
  allowedSources: ReadonlySet<ScrapeValueSourceV1>,
): ScrapeValueV1 {
  return parseValue(value, field, allowedSources, 0);
}

export function evaluateScrapeValue(
  value: ScrapeValueV1,
  context: ScrapeValueContextV1,
): JsonValueV1 {
  let result: JsonValueV1;
  switch (value.op) {
    case 'get': {
      const source = context[value.from];
      if (source === undefined) {
        throw new ScrapeValueError(`source ${value.from} is unavailable`);
      }
      try {
        result = resolveJsonPointer(source, value.pointer, 'scrape_value.pointer');
      } catch (error) {
        if (error instanceof PublicContractError) throw new ScrapeValueError(error.message);
        throw error;
      }
      break;
    }
    case 'literal':
      result = value.value;
      break;
    case 'add_integer': {
      const current = evaluateScrapeValue(value.value, context);
      if (typeof current !== 'number' || !Number.isSafeInteger(current)) {
        throw new ScrapeValueError('add_integer operand must be a safe integer');
      }
      const integerResult = current + value.amount;
      if (!Number.isSafeInteger(integerResult))
        throw new ScrapeValueError('add_integer result is out of range');
      result = integerResult;
      break;
    }
    case 'object': {
      const object: Record<string, JsonValueV1> = {};
      for (const [key, entry] of Object.entries(value.entries)) {
        object[key] = evaluateScrapeValue(entry, context);
      }
      result = object;
      break;
    }
    case 'array': {
      result = value.items.map((item) => evaluateScrapeValue(item, context));
      break;
    }
  }
  return result;
}

function parseValue(
  value: unknown,
  field: string,
  allowedSources: ReadonlySet<ScrapeValueSourceV1>,
  depth: number,
): ScrapeValueV1 {
  if (depth > MAX_SCRAPE_VALUE_DEPTH_V1) {
    throw new PublicContractError(field, `exceeds scrape value depth ${MAX_SCRAPE_VALUE_DEPTH_V1}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be a scrape value object');
  }
  const op = (value as Record<string, unknown>).op;
  if (op === 'get') {
    const record = parseExactRecord(value, field, ['op', 'from', 'pointer']);
    if (
      typeof record.from !== 'string' ||
      !allowedSources.has(record.from as ScrapeValueSourceV1)
    ) {
      throw new PublicContractError(`${field}.from`, 'is not available in this value context');
    }
    return {
      op,
      from: record.from as ScrapeValueSourceV1,
      pointer: parseJsonPointer(record.pointer, `${field}.pointer`),
    };
  }
  if (op === 'literal') {
    const record = parseExactRecord(value, field, ['op', 'value']);
    assertJsonValue(record.value, `${field}.value`, MAX_SCRAPE_VALUE_DEPTH_V1);
    return { op, value: record.value };
  }
  if (op === 'add_integer') {
    const record = parseExactRecord(value, field, ['op', 'value', 'amount']);
    return {
      op,
      value: parseValue(record.value, `${field}.value`, allowedSources, depth + 1),
      amount: parseInteger(record.amount, `${field}.amount`, -1_000_000, 1_000_000),
    };
  }
  if (op === 'object') {
    const record = parseExactRecord(value, field, ['op', 'entries']);
    const entries = parseBoundedRecord(
      record.entries,
      `${field}.entries`,
      MAX_SCRAPE_VALUE_ENTRIES_V1,
    );
    const parsed: Record<string, ScrapeValueV1> = {};
    for (const [key, entry] of Object.entries(entries)) {
      parsed[key] = parseValue(entry, `${field}.entries.${key}`, allowedSources, depth + 1);
    }
    return { op, entries: parsed };
  }
  if (op === 'array') {
    const record = parseExactRecord(value, field, ['op', 'items']);
    if (!Array.isArray(record.items) || record.items.length > MAX_SCRAPE_VALUE_ENTRIES_V1) {
      throw new PublicContractError(
        `${field}.items`,
        `must contain at most ${MAX_SCRAPE_VALUE_ENTRIES_V1} entries`,
      );
    }
    return {
      op,
      items: record.items.map((item, index) =>
        parseValue(item, `${field}.items[${index}]`, allowedSources, depth + 1),
      ),
    };
  }
  throw new PublicContractError(`${field}.op`, 'must be a supported scrape value operation');
}
