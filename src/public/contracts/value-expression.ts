import { createHmac } from 'node:crypto';
import {
  parseBoundedRecord,
  parseExactRecord,
  parseJsonPointer,
  parseStableContractId,
  parseString,
  PublicContractError,
  sha256Digest,
  type JsonPointerV1,
} from './common';
import { assertJsonValue, canonicalJson, type JsonValueV1 } from './json';

export const VALUE_EXPRESSION_LIMITS_V1 = {
  maximumDepth: 12,
  maximumNodes: 256,
  maximumCollectionItems: 64,
  maximumObjectFields: 64,
  maximumEncodedOutputBytes: 64 * 1024,
  maximumCryptoInputBytes: 64 * 1024,
} as const;

export type ValueExpressionV1 =
  | { op: 'literal'; value: string | number | boolean | null }
  | { op: 'input'; pointer: JsonPointerV1 }
  | { op: 'binding'; name: string }
  | { op: 'object'; fields: Record<string, ValueExpressionV1> }
  | { op: 'array'; items: ValueExpressionV1[] }
  | { op: 'concat'; values: ValueExpressionV1[] }
  | { op: 'to_string'; value: ValueExpressionV1 }
  | { op: 'url_encode'; value: ValueExpressionV1 }
  | { op: 'json_encode'; value: ValueExpressionV1 }
  | { op: 'base64'; value: ValueExpressionV1 }
  | { op: 'sha256'; value: ValueExpressionV1 }
  | {
      op: 'hmac_sha256';
      key: ValueExpressionV1;
      value: ValueExpressionV1;
      encoding: 'hex' | 'base64url';
    };

export class ValueExpressionError extends PublicContractError {
  constructor(field: string, message: string) {
    super(field, message);
    this.name = 'ValueExpressionError';
  }
}

export interface ValueExpressionContextV1 {
  input: JsonValueV1;
  bindings: Readonly<Record<string, JsonValueV1>>;
}

export function parseValueExpression(
  value: unknown,
  field = 'value_expression',
): ValueExpressionV1 {
  return parseExpression(value, field, { nodes: 0 }, 0);
}

export function evaluateValueExpression(
  expression: ValueExpressionV1,
  context: ValueExpressionContextV1,
): JsonValueV1 {
  assertJsonValue(context.input, 'value_context.input', VALUE_EXPRESSION_LIMITS_V1.maximumDepth);
  for (const [name, binding] of Object.entries(context.bindings)) {
    assertJsonValue(
      binding,
      `value_context.bindings.${name}`,
      VALUE_EXPRESSION_LIMITS_V1.maximumDepth,
    );
  }
  const value = evaluateExpression(expression, context, 'value_expression');
  assertExpressionOutput(value, 'value_expression');
  return value;
}

export function resolveJsonPointer(
  value: JsonValueV1,
  pointer: JsonPointerV1,
  field: string,
): JsonValueV1 {
  let current: JsonValueV1 = value;
  if (pointer.length === 0) return current;
  for (const encodedToken of pointer.slice(1).split('/')) {
    const token = encodedToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) {
        throw new ValueExpressionError(
          field,
          `array pointer token ${JSON.stringify(token)} is invalid`,
        );
      }
      const index = Number(token);
      const entry = current[index];
      if (entry === undefined) {
        throw new ValueExpressionError(
          field,
          `pointer ${JSON.stringify(pointer)} does not resolve`,
        );
      }
      current = entry;
      continue;
    }
    if (!current || typeof current !== 'object') {
      throw new ValueExpressionError(field, `pointer ${JSON.stringify(pointer)} does not resolve`);
    }
    const object = current as Record<string, JsonValueV1>;
    if (!Object.hasOwn(object, token)) {
      throw new ValueExpressionError(field, `pointer ${JSON.stringify(pointer)} does not resolve`);
    }
    current = object[token] as JsonValueV1;
  }
  return current;
}

function parseExpression(
  value: unknown,
  field: string,
  state: { nodes: number },
  depth: number,
): ValueExpressionV1 {
  if (depth > VALUE_EXPRESSION_LIMITS_V1.maximumDepth) {
    throw new ValueExpressionError(
      field,
      `exceeds maximum depth ${VALUE_EXPRESSION_LIMITS_V1.maximumDepth}`,
    );
  }
  state.nodes += 1;
  if (state.nodes > VALUE_EXPRESSION_LIMITS_V1.maximumNodes) {
    throw new ValueExpressionError(
      field,
      `exceeds maximum node count ${VALUE_EXPRESSION_LIMITS_V1.maximumNodes}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValueExpressionError(field, 'must be an expression object');
  }
  const candidate = value as Record<string, unknown>;
  const op = candidate.op;
  if (typeof op !== 'string') throw new ValueExpressionError(`${field}.op`, 'must be a string');

  switch (op) {
    case 'literal': {
      const record = parseExactRecord(value, field, ['op', 'value']);
      const literal = record.value;
      if (
        literal !== null &&
        typeof literal !== 'string' &&
        typeof literal !== 'number' &&
        typeof literal !== 'boolean'
      ) {
        throw new ValueExpressionError(`${field}.value`, 'must be a scalar JSON literal');
      }
      if (typeof literal === 'number' && !Number.isFinite(literal)) {
        throw new ValueExpressionError(`${field}.value`, 'must be a finite number');
      }
      return { op, value: literal };
    }
    case 'input': {
      const record = parseExactRecord(value, field, ['op', 'pointer']);
      return { op, pointer: parseJsonPointer(record.pointer, `${field}.pointer`) };
    }
    case 'binding': {
      const record = parseExactRecord(value, field, ['op', 'name']);
      return { op, name: parseStableContractId(record.name, `${field}.name`) };
    }
    case 'object': {
      const record = parseExactRecord(value, field, ['op', 'fields']);
      const fieldsRecord = parseBoundedRecord(
        record.fields,
        `${field}.fields`,
        VALUE_EXPRESSION_LIMITS_V1.maximumObjectFields,
      );
      const fields: Record<string, ValueExpressionV1> = {};
      for (const [name, nested] of Object.entries(fieldsRecord)) {
        parseString(name, `${field}.fields key`, 128);
        if (name.length === 0)
          throw new ValueExpressionError(`${field}.fields`, 'must not contain an empty key');
        fields[name] = parseExpression(nested, `${field}.fields.${name}`, state, depth + 1);
      }
      return { op, fields };
    }
    case 'array': {
      const record = parseExactRecord(value, field, ['op', 'items']);
      if (
        !Array.isArray(record.items) ||
        record.items.length > VALUE_EXPRESSION_LIMITS_V1.maximumCollectionItems
      ) {
        throw new ValueExpressionError(
          `${field}.items`,
          `must be an array with at most ${VALUE_EXPRESSION_LIMITS_V1.maximumCollectionItems} items`,
        );
      }
      return {
        op,
        items: record.items.map((item, index) =>
          parseExpression(item, `${field}.items[${index}]`, state, depth + 1),
        ),
      };
    }
    case 'concat': {
      const record = parseExactRecord(value, field, ['op', 'values']);
      if (
        !Array.isArray(record.values) ||
        record.values.length > VALUE_EXPRESSION_LIMITS_V1.maximumCollectionItems
      ) {
        throw new ValueExpressionError(
          `${field}.values`,
          `must be an array with at most ${VALUE_EXPRESSION_LIMITS_V1.maximumCollectionItems} items`,
        );
      }
      return {
        op,
        values: record.values.map((item, index) =>
          parseExpression(item, `${field}.values[${index}]`, state, depth + 1),
        ),
      };
    }
    case 'to_string':
    case 'url_encode':
    case 'json_encode':
    case 'base64':
    case 'sha256': {
      const record = parseExactRecord(value, field, ['op', 'value']);
      return { op, value: parseExpression(record.value, `${field}.value`, state, depth + 1) };
    }
    case 'hmac_sha256': {
      const record = parseExactRecord(value, field, ['op', 'key', 'value', 'encoding']);
      if (record.encoding !== 'hex' && record.encoding !== 'base64url') {
        throw new ValueExpressionError(`${field}.encoding`, 'must be "hex" or "base64url"');
      }
      return {
        op,
        key: parseExpression(record.key, `${field}.key`, state, depth + 1),
        value: parseExpression(record.value, `${field}.value`, state, depth + 1),
        encoding: record.encoding,
      };
    }
    default:
      throw new ValueExpressionError(`${field}.op`, `is not supported: ${JSON.stringify(op)}`);
  }
}

// eslint-disable-next-line sonarjs/function-return-type -- The closed AST returns its JSON union.
function evaluateExpression(
  expression: ValueExpressionV1,
  context: ValueExpressionContextV1,
  field: string,
): JsonValueV1 {
  switch (expression.op) {
    case 'literal':
      return expression.value;
    case 'input':
      return resolveJsonPointer(context.input, expression.pointer, `${field}.pointer`);
    case 'binding': {
      const binding = context.bindings[expression.name];
      if (binding === undefined) {
        throw new ValueExpressionError(
          `${field}.name`,
          `binding ${JSON.stringify(expression.name)} is unavailable`,
        );
      }
      return binding;
    }
    case 'object': {
      const result: Record<string, JsonValueV1> = {};
      for (const [name, nested] of Object.entries(expression.fields)) {
        result[name] = evaluateExpression(nested, context, `${field}.fields.${name}`);
      }
      return result;
    }
    case 'array':
      return expression.items.map((nested, index) =>
        evaluateExpression(nested, context, `${field}.items[${index}]`),
      );
    case 'concat':
      return expression.values
        .map((nested, index) =>
          asExpressionString(
            evaluateExpression(nested, context, `${field}.values[${index}]`),
            `${field}.values[${index}]`,
          ),
        )
        .join('');
    case 'to_string':
      return asScalarString(
        evaluateExpression(expression.value, context, `${field}.value`),
        `${field}.value`,
      );
    case 'url_encode':
      return encodeURIComponent(
        asExpressionString(
          evaluateExpression(expression.value, context, `${field}.value`),
          `${field}.value`,
        ),
      );
    case 'json_encode':
      return canonicalJson(evaluateExpression(expression.value, context, `${field}.value`));
    case 'base64': {
      const value = asExpressionString(
        evaluateExpression(expression.value, context, `${field}.value`),
        `${field}.value`,
      );
      assertCryptoInput(value, `${field}.value`);
      return Buffer.from(value, 'utf8').toString('base64');
    }
    case 'sha256': {
      const value = asExpressionString(
        evaluateExpression(expression.value, context, `${field}.value`),
        `${field}.value`,
      );
      assertCryptoInput(value, `${field}.value`);
      return sha256Digest(value);
    }
    case 'hmac_sha256': {
      const key = asExpressionString(
        evaluateExpression(expression.key, context, `${field}.key`),
        `${field}.key`,
      );
      const value = asExpressionString(
        evaluateExpression(expression.value, context, `${field}.value`),
        `${field}.value`,
      );
      assertCryptoInput(key, `${field}.key`);
      assertCryptoInput(value, `${field}.value`);
      return createHmac('sha256', key).update(value).digest(expression.encoding);
    }
  }
}

function asExpressionString(value: JsonValueV1, field: string): string {
  if (typeof value !== 'string') throw new ValueExpressionError(field, 'must evaluate to a string');
  return value;
}

function asScalarString(value: JsonValueV1, field: string): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new ValueExpressionError(field, 'must evaluate to a string, number, or boolean');
}

function assertCryptoInput(value: string, field: string): void {
  if (Buffer.byteLength(value, 'utf8') > VALUE_EXPRESSION_LIMITS_V1.maximumCryptoInputBytes) {
    throw new ValueExpressionError(
      field,
      `exceeds crypto input limit ${VALUE_EXPRESSION_LIMITS_V1.maximumCryptoInputBytes}`,
    );
  }
}

function assertExpressionOutput(value: JsonValueV1, field: string): void {
  if (
    Buffer.byteLength(canonicalJson(value), 'utf8') >
    VALUE_EXPRESSION_LIMITS_V1.maximumEncodedOutputBytes
  ) {
    throw new ValueExpressionError(
      field,
      `exceeds output limit ${VALUE_EXPRESSION_LIMITS_V1.maximumEncodedOutputBytes}`,
    );
  }
}
