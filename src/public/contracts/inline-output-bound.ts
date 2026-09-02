import {
  parseExactRecord,
  parseInteger,
  parseSha256Digest,
  PublicContractError,
  type Sha256DigestV1,
} from './common';
import { canonicalJson, canonicalJsonDigest, type JsonValueV1 } from './json';
import type { JsonSchemaV1 } from './json-schema';

export interface InlineOutputBoundV1 {
  max_serialized_item_bytes: number;
  item_schema_digest: Sha256DigestV1;
  bound_algorithm_version: 1;
}

const BOUND_ALGORITHM_VERSION_V1 = 1;
const MAX_FINITE_JSON_NUMBER_BYTES_V1 = 32;

/** Derives a conservative canonical-JSON item bound from the closed item schema. */
export function deriveInlineOutputBound(schema: JsonSchemaV1): InlineOutputBoundV1 | null {
  const maximum = maximumSerializedBytes(schema);
  if (maximum === null) return null;
  return {
    max_serialized_item_bytes: maximum,
    item_schema_digest: canonicalJsonDigest(schema as unknown as JsonValueV1),
    bound_algorithm_version: BOUND_ALGORITHM_VERSION_V1,
  };
}

/** Accepts only the bound mechanically derived from the parsed item schema. */
export function parseInlineOutputBound(
  value: unknown,
  schema: JsonSchemaV1,
  field: string,
): InlineOutputBoundV1 | null {
  const derived = deriveInlineOutputBound(schema);
  if (value === null) {
    if (derived !== null) {
      throw new PublicContractError(field, 'must contain the compiler-derived finite item bound');
    }
    return null;
  }
  const record = parseExactRecord(value, field, [
    'max_serialized_item_bytes',
    'item_schema_digest',
    'bound_algorithm_version',
  ]);
  const bound: InlineOutputBoundV1 = {
    max_serialized_item_bytes: parseInteger(
      record.max_serialized_item_bytes,
      `${field}.max_serialized_item_bytes`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    item_schema_digest: parseSha256Digest(record.item_schema_digest, `${field}.item_schema_digest`),
    bound_algorithm_version: parseBoundAlgorithmVersion(record.bound_algorithm_version, field),
  };
  if (derived === null) {
    throw new PublicContractError(
      field,
      'must be null because the item schema has no finite bound',
    );
  }
  if (
    bound.max_serialized_item_bytes !== derived.max_serialized_item_bytes ||
    bound.item_schema_digest !== derived.item_schema_digest
  ) {
    throw new PublicContractError(field, 'does not match the compiler-derived item schema bound');
  }
  return bound;
}

function parseBoundAlgorithmVersion(value: unknown, field: string): 1 {
  if (value !== BOUND_ALGORITHM_VERSION_V1) {
    throw new PublicContractError(`${field}.bound_algorithm_version`, 'must be 1');
  }
  return 1;
}

function maximumSerializedBytes(schema: JsonSchemaV1): number | null {
  if (schema.enum !== null) return maximumEnumBytes(schema.enum);
  switch (schema.type) {
    case 'null':
      return 4;
    case 'boolean':
      return 5;
    case 'number':
    case 'integer':
      return MAX_FINITE_JSON_NUMBER_BYTES_V1;
    case 'string':
      return schema.maxLength === null ? null : sumBytes(2, multiplyBytes(schema.maxLength, 6));
    case 'array':
      return maximumArrayBytes(schema);
    case 'object':
      return maximumObjectBytes(schema);
  }
}

function maximumEnumBytes(values: readonly JsonValueV1[]): number | null {
  let maximum = 0;
  for (const value of values) {
    const bytes = Buffer.byteLength(canonicalJson(value), 'utf8');
    if (!Number.isSafeInteger(bytes)) return null;
    maximum = Math.max(maximum, bytes);
  }
  return maximum;
}

function maximumArrayBytes(schema: Extract<JsonSchemaV1, { type: 'array' }>): number | null {
  if (schema.maxItems === null) return null;
  const itemBytes = maximumSerializedBytes(schema.items);
  if (itemBytes === null) return null;
  if (schema.maxItems === 0) return 2;
  return sumBytes(2, multiplyBytes(schema.maxItems, itemBytes), schema.maxItems - 1);
}

function maximumObjectBytes(schema: Extract<JsonSchemaV1, { type: 'object' }>): number | null {
  if (schema.additionalProperties !== false) return null;
  const required = new Set(schema.required);
  const entries: Array<{ required: boolean; bytes: number }> = [];
  for (const [key, child] of Object.entries(schema.properties)) {
    const valueBytes = maximumSerializedBytes(child);
    if (valueBytes === null) return null;
    const entryBytes = sumBytes(Buffer.byteLength(canonicalJson(key), 'utf8'), 1, valueBytes);
    if (entryBytes === null) return null;
    entries.push({ required: required.has(key), bytes: entryBytes });
  }
  const requiredEntries = entries.filter((entry) => entry.required);
  const maximumEntries = Math.min(schema.maxProperties ?? entries.length, entries.length);
  if (requiredEntries.length > maximumEntries) return null;
  const optionalEntries = entries
    .filter((entry) => !entry.required)
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, maximumEntries - requiredEntries.length);
  const selected = [...requiredEntries, ...optionalEntries];
  if (selected.length === 0) return 2;
  return sumBytes(2, ...selected.map((entry) => entry.bytes), selected.length - 1);
}

function multiplyBytes(left: number, right: number): number | null {
  const result = left * right;
  return Number.isSafeInteger(result) ? result : null;
}

function sumBytes(...parts: Array<number | null>): number | null {
  let total = 0;
  for (const part of parts) {
    if (part === null) return null;
    total += part;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}
