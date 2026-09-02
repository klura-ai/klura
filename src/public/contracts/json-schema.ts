import { parseBoundedRecord, parseInteger, parseString, PublicContractError } from './common';
import { assertJsonValue, canonicalJson, type JsonValueV1 } from './json';

export const JSON_SCHEMA_LIMITS_V1 = {
  maximumDepth: 12,
  maximumNodes: 256,
  maximumProperties: 64,
  maximumEnumValues: 64,
  maximumStringLength: 64 * 1024,
  maximumArrayItems: 10_000,
} as const;

export type JsonSchemaV1 =
  | { type: 'null'; enum: null[] | null }
  | { type: 'boolean'; enum: boolean[] | null }
  | {
      type: 'string';
      minLength: number | null;
      maxLength: number | null;
      enum: string[] | null;
    }
  | {
      type: 'number' | 'integer';
      minimum: number | null;
      maximum: number | null;
      enum: number[] | null;
    }
  | {
      type: 'array';
      items: JsonSchemaV1;
      minItems: number | null;
      maxItems: number | null;
      enum: JsonValueV1[] | null;
    }
  | {
      type: 'object';
      properties: Record<string, JsonSchemaV1>;
      required: string[];
      additionalProperties: false | JsonSchemaV1;
      minProperties: number | null;
      maxProperties: number | null;
      enum: JsonValueV1[] | null;
    };

export function parseJsonSchema(value: unknown, field = 'schema'): JsonSchemaV1 {
  return parseSchema(value, field, { nodes: 0 }, 0);
}

export function validateJsonSchema(
  value: unknown,
  schema: JsonSchemaV1,
  field = 'value',
): JsonValueV1 {
  assertJsonValue(value, field, JSON_SCHEMA_LIMITS_V1.maximumDepth);
  validateAgainstSchema(value, schema, field);
  return value;
}

function parseSchema(
  value: unknown,
  field: string,
  state: { nodes: number },
  depth: number,
): JsonSchemaV1 {
  if (depth > JSON_SCHEMA_LIMITS_V1.maximumDepth) {
    throw new PublicContractError(
      field,
      `exceeds maximum schema depth ${JSON_SCHEMA_LIMITS_V1.maximumDepth}`,
    );
  }
  state.nodes += 1;
  if (state.nodes > JSON_SCHEMA_LIMITS_V1.maximumNodes) {
    throw new PublicContractError(
      field,
      `exceeds maximum schema node count ${JSON_SCHEMA_LIMITS_V1.maximumNodes}`,
    );
  }
  const typeRecord = parseBoundedRecord(value, field, 16);
  const type = typeRecord.type;
  if (
    type !== 'null' &&
    type !== 'boolean' &&
    type !== 'string' &&
    type !== 'number' &&
    type !== 'integer' &&
    type !== 'array' &&
    type !== 'object'
  ) {
    throw new PublicContractError(`${field}.type`, 'must be a supported JSON Schema type');
  }

  switch (type) {
    case 'null':
      return parseNullSchema(value, field);
    case 'boolean':
      return parseBooleanSchema(value, field);
    case 'string':
      return parseStringSchema(value, field);
    case 'number':
    case 'integer':
      return parseNumberSchema(value, field, type);
    case 'array':
      return parseArraySchema(value, field, state, depth);
    case 'object':
      return parseObjectSchema(value, field, state, depth);
  }
}

function parseNullSchema(value: unknown, field: string): JsonSchemaV1 {
  const record = parseSchemaRecord(value, field, ['type', 'enum'], ['type']);
  return {
    type: 'null',
    enum: parseScalarEnum(record.enum, `${field}.enum`, 'null') as null[] | null,
  };
}

function parseBooleanSchema(value: unknown, field: string): JsonSchemaV1 {
  const record = parseSchemaRecord(value, field, ['type', 'enum'], ['type']);
  return {
    type: 'boolean',
    enum: parseScalarEnum(record.enum, `${field}.enum`, 'boolean') as boolean[] | null,
  };
}

function parseStringSchema(value: unknown, field: string): JsonSchemaV1 {
  const record = parseSchemaRecord(
    value,
    field,
    ['type', 'minLength', 'maxLength', 'enum'],
    ['type'],
  );
  const bounds = parseLengthBounds(record.minLength, record.maxLength, field);
  return {
    type: 'string',
    minLength: bounds.minimum,
    maxLength: bounds.maximum,
    enum: parseScalarEnum(record.enum, `${field}.enum`, 'string') as string[] | null,
  };
}

function parseNumberSchema(
  value: unknown,
  field: string,
  type: 'number' | 'integer',
): JsonSchemaV1 {
  const record = parseSchemaRecord(value, field, ['type', 'minimum', 'maximum', 'enum'], ['type']);
  const bounds = parseNumberBounds(record.minimum, record.maximum, field);
  const enumValues = parseScalarEnum(record.enum, `${field}.enum`, 'number') as number[] | null;
  if (type === 'integer' && enumValues?.some((entry) => !Number.isSafeInteger(entry))) {
    throw new PublicContractError(`${field}.enum`, 'integer enums must contain safe integers only');
  }
  return { type, minimum: bounds.minimum, maximum: bounds.maximum, enum: enumValues };
}

function parseArraySchema(
  value: unknown,
  field: string,
  state: { nodes: number },
  depth: number,
): JsonSchemaV1 {
  const record = parseSchemaRecord(
    value,
    field,
    ['type', 'items', 'minItems', 'maxItems', 'enum'],
    ['type', 'items'],
  );
  const bounds = parseItemBounds(record.minItems, record.maxItems, field, 'Items');
  return {
    type: 'array',
    items: parseSchema(record.items, `${field}.items`, state, depth + 1),
    minItems: bounds.minimum,
    maxItems: bounds.maximum,
    enum: parseJsonEnum(record.enum, `${field}.enum`),
  };
}

function parseObjectSchema(
  value: unknown,
  field: string,
  state: { nodes: number },
  depth: number,
): JsonSchemaV1 {
  const record = parseSchemaRecord(
    value,
    field,
    [
      'type',
      'properties',
      'required',
      'additionalProperties',
      'minProperties',
      'maxProperties',
      'enum',
    ],
    ['type', 'additionalProperties'],
  );
  const propertiesRecord =
    record.properties === undefined
      ? {}
      : parseBoundedRecord(
          record.properties,
          `${field}.properties`,
          JSON_SCHEMA_LIMITS_V1.maximumProperties,
        );
  const properties: Record<string, JsonSchemaV1> = {};
  for (const [name, propertySchema] of Object.entries(propertiesRecord)) {
    parseString(name, `${field}.properties key`, 256);
    properties[name] = parseSchema(propertySchema, `${field}.properties.${name}`, state, depth + 1);
  }
  const required = parseRequired(record.required, `${field}.required`, properties);
  const bounds = parseItemBounds(record.minProperties, record.maxProperties, field, 'Properties');
  const additionalProperties = parseAdditionalProperties(
    record.additionalProperties,
    `${field}.additionalProperties`,
    state,
    depth,
    bounds.maximum,
  );
  return {
    type: 'object',
    properties,
    required,
    additionalProperties,
    minProperties: bounds.minimum,
    maxProperties: bounds.maximum,
    enum: parseJsonEnum(record.enum, `${field}.enum`),
  };
}

function parseScalarEnum(
  value: unknown,
  field: string,
  scalarType: 'null' | 'boolean' | 'string' | 'number',
): null[] | boolean[] | string[] | number[] | null {
  if (value === null || value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > JSON_SCHEMA_LIMITS_V1.maximumEnumValues
  ) {
    throw new PublicContractError(
      field,
      `must be null or a non-empty array with at most ${JSON_SCHEMA_LIMITS_V1.maximumEnumValues} values`,
    );
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (scalarType === 'null' ? entry !== null : typeof entry !== scalarType) {
      throw new PublicContractError(`${field}[${index}]`, `must be a ${scalarType}`);
    }
    if (scalarType === 'number' && !Number.isFinite(entry as number)) {
      throw new PublicContractError(`${field}[${index}]`, 'must be finite');
    }
    const key = canonicalJson(entry as JsonValueV1);
    if (seen.has(key))
      throw new PublicContractError(`${field}[${index}]`, 'must not contain duplicates');
    seen.add(key);
  }
  return value as null[] | boolean[] | string[] | number[];
}

function parseJsonEnum(value: unknown, field: string): JsonValueV1[] | null {
  if (value === null || value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > JSON_SCHEMA_LIMITS_V1.maximumEnumValues
  ) {
    throw new PublicContractError(
      field,
      `must be null or a non-empty array with at most ${JSON_SCHEMA_LIMITS_V1.maximumEnumValues} values`,
    );
  }
  const seen = new Set<string>();
  const values: JsonValueV1[] = [];
  for (const [index, entry] of value.entries()) {
    assertJsonValue(entry, `${field}[${index}]`, JSON_SCHEMA_LIMITS_V1.maximumDepth);
    const canonical = canonicalJson(entry);
    if (seen.has(canonical))
      throw new PublicContractError(`${field}[${index}]`, 'must not contain duplicates');
    seen.add(canonical);
    values.push(entry);
  }
  return values;
}

function parseLengthBounds(
  minimum: unknown,
  maximum: unknown,
  field: string,
): { minimum: number | null; maximum: number | null } {
  return parseNullableBounds(
    minimum,
    maximum,
    field,
    0,
    JSON_SCHEMA_LIMITS_V1.maximumStringLength,
    'Length',
  );
}

function parseItemBounds(
  minimum: unknown,
  maximum: unknown,
  field: string,
  label: string,
): { minimum: number | null; maximum: number | null } {
  return parseNullableBounds(
    minimum,
    maximum,
    field,
    0,
    JSON_SCHEMA_LIMITS_V1.maximumArrayItems,
    label,
  );
}

function parseNullableBounds(
  minimum: unknown,
  maximum: unknown,
  field: string,
  floor: number,
  ceiling: number,
  label: string,
): { minimum: number | null; maximum: number | null } {
  const min =
    minimum === null || minimum === undefined
      ? null
      : parseInteger(minimum, `${field}.min${label}`, floor, ceiling);
  const max =
    maximum === null || maximum === undefined
      ? null
      : parseInteger(maximum, `${field}.max${label}`, floor, ceiling);
  if (min !== null && max !== null && min > max) {
    throw new PublicContractError(field, `min${label} must not exceed max${label}`);
  }
  return { minimum: min, maximum: max };
}

function parseNumberBounds(
  minimum: unknown,
  maximum: unknown,
  field: string,
): { minimum: number | null; maximum: number | null } {
  const min =
    minimum === null || minimum === undefined
      ? null
      : parseFiniteNumber(minimum, `${field}.minimum`);
  const max =
    maximum === null || maximum === undefined
      ? null
      : parseFiniteNumber(maximum, `${field}.maximum`);
  if (min !== null && max !== null && min > max) {
    throw new PublicContractError(field, 'minimum must not exceed maximum');
  }
  return { minimum: min, maximum: max };
}

function parseFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PublicContractError(field, 'must be a finite number or null');
  }
  return value;
}

function parseRequired(
  value: unknown,
  field: string,
  properties: Record<string, JsonSchemaV1>,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > JSON_SCHEMA_LIMITS_V1.maximumProperties) {
    throw new PublicContractError(
      field,
      `must be an array with at most ${JSON_SCHEMA_LIMITS_V1.maximumProperties} values`,
    );
  }
  const required: string[] = [];
  for (const [index, entry] of value.entries()) {
    const name = parseString(entry, `${field}[${index}]`, 256);
    if (!Object.hasOwn(properties, name)) {
      throw new PublicContractError(`${field}[${index}]`, 'must name a declared property');
    }
    if (required.includes(name))
      throw new PublicContractError(`${field}[${index}]`, 'must not contain duplicates');
    required.push(name);
  }
  return required;
}

// eslint-disable-next-line sonarjs/function-return-type -- It returns one closed schema union.
function parseAdditionalProperties(
  value: unknown,
  field: string,
  state: { nodes: number },
  depth: number,
  maximumProperties: number | null,
): false | JsonSchemaV1 {
  if (value === false) return false;
  if (value === undefined) {
    throw new PublicContractError(field, 'must be false or a bounded schema');
  }
  if (maximumProperties === null) {
    throw new PublicContractError(field, 'schema-valued maps require maxProperties');
  }
  return parseSchema(value, field, state, depth + 1);
}

function parseSchemaRecord(
  value: unknown,
  field: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): Record<string, unknown> {
  const record = parseBoundedRecord(value, field, allowedKeys.length);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new PublicContractError(`${field}.${key}`, 'is not allowed');
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) {
      throw new PublicContractError(field, `is missing required key ${JSON.stringify(key)}`);
    }
  }
  return record;
}

function validateAgainstSchema(value: JsonValueV1, schema: JsonSchemaV1, field: string): void {
  switch (schema.type) {
    case 'null':
      if (value !== null) throw new PublicContractError(field, 'must be null');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw new PublicContractError(field, 'must be a boolean');
      break;
    case 'string':
      if (typeof value !== 'string') throw new PublicContractError(field, 'must be a string');
      validateString(value, schema, field);
      break;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new PublicContractError(field, 'must be a finite number');
      }
      if (schema.type === 'integer' && !Number.isSafeInteger(value)) {
        throw new PublicContractError(field, 'must be a safe integer');
      }
      validateNumber(value, schema, field);
      break;
    case 'array':
      if (!Array.isArray(value)) throw new PublicContractError(field, 'must be an array');
      validateArray(value, schema, field);
      break;
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new PublicContractError(field, 'must be an object');
      }
      validateObject(value as Record<string, JsonValueV1>, schema, field);
      break;
  }
  if (
    schema.enum !== null &&
    !schema.enum.some((entry) => canonicalJson(entry) === canonicalJson(value))
  ) {
    throw new PublicContractError(field, 'is not one of the declared enum values');
  }
}

function validateString(
  value: string,
  schema: Extract<JsonSchemaV1, { type: 'string' }>,
  field: string,
): void {
  const length = Array.from(value).length;
  if (schema.minLength !== null && length < schema.minLength)
    throw new PublicContractError(field, `must contain at least ${schema.minLength} characters`);
  if (schema.maxLength !== null && length > schema.maxLength)
    throw new PublicContractError(field, `must contain at most ${schema.maxLength} characters`);
}

function validateNumber(
  value: number,
  schema: Extract<JsonSchemaV1, { type: 'number' | 'integer' }>,
  field: string,
): void {
  if (schema.minimum !== null && value < schema.minimum)
    throw new PublicContractError(field, `must be at least ${schema.minimum}`);
  if (schema.maximum !== null && value > schema.maximum)
    throw new PublicContractError(field, `must be at most ${schema.maximum}`);
}

function validateArray(
  value: JsonValueV1[],
  schema: Extract<JsonSchemaV1, { type: 'array' }>,
  field: string,
): void {
  if (schema.minItems !== null && value.length < schema.minItems)
    throw new PublicContractError(field, `must contain at least ${schema.minItems} items`);
  if (schema.maxItems !== null && value.length > schema.maxItems)
    throw new PublicContractError(field, `must contain at most ${schema.maxItems} items`);
  value.forEach((entry, index) => {
    validateAgainstSchema(entry, schema.items, `${field}[${index}]`);
  });
}

function validateObject(
  value: Record<string, JsonValueV1>,
  schema: Extract<JsonSchemaV1, { type: 'object' }>,
  field: string,
): void {
  const entries = Object.entries(value);
  if (schema.minProperties !== null && entries.length < schema.minProperties)
    throw new PublicContractError(
      field,
      `must contain at least ${schema.minProperties} properties`,
    );
  if (schema.maxProperties !== null && entries.length > schema.maxProperties)
    throw new PublicContractError(field, `must contain at most ${schema.maxProperties} properties`);
  for (const name of schema.required) {
    if (!Object.hasOwn(value, name))
      throw new PublicContractError(field, `is missing required property ${JSON.stringify(name)}`);
  }
  for (const [name, entry] of entries) {
    const propertySchema = schema.properties[name];
    if (propertySchema) {
      validateAgainstSchema(entry, propertySchema, `${field}.${name}`);
      continue;
    }
    if (schema.additionalProperties === false) {
      throw new PublicContractError(`${field}.${name}`, 'is not allowed');
    }
    validateAgainstSchema(entry, schema.additionalProperties, `${field}.${name}`);
  }
}
