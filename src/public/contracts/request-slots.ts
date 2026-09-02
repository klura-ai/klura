import { PublicContractError } from './common';
import type { JsonSchemaV1 } from './json-schema';
import type { ValueExpressionV1 } from './value-expression';

export interface HttpRequestStringSlotsV1 {
  endpoint: ValueExpressionV1;
  headers: Record<string, ValueExpressionV1>;
  query: Record<string, ValueExpressionV1>;
}

/** Rejects an endpoint, query, or header expression that can never evaluate to
 *  a string, using only what the package declares: a non-string literal, an
 *  object or array, or an input whose declared schema type is not string. The
 *  evaluator enforces the same rule per call; catching it here keeps a package
 *  from shipping with a request it can never send. */
export function assertHttpRequestStringSlots(
  request: HttpRequestStringSlotsV1,
  inputSchema: JsonSchemaV1,
  field: string,
): void {
  assertStringSlotExpression(request.endpoint, inputSchema, `${field}.endpoint`);
  for (const [name, expression] of Object.entries(request.query)) {
    assertStringSlotExpression(expression, inputSchema, `${field}.query.${name}`);
  }
  for (const [name, expression] of Object.entries(request.headers)) {
    assertStringSlotExpression(expression, inputSchema, `${field}.headers.${name}`);
  }
}

function assertStringSlotExpression(
  expression: ValueExpressionV1,
  inputSchema: JsonSchemaV1,
  field: string,
): void {
  switch (expression.op) {
    case 'literal':
      if (typeof expression.value !== 'string') {
        throw new PublicContractError(
          field,
          `literal ${JSON.stringify(expression.value)} is not a string; this slot requires one`,
        );
      }
      return;
    case 'input': {
      const declared = declaredInputType(inputSchema, expression.pointer);
      if (declared !== null && declared !== 'string') {
        throw new PublicContractError(
          field,
          `input ${expression.pointer} is declared ${declared} but this slot requires a string; wrap it in {"op":"to_string"}`,
        );
      }
      return;
    }
    case 'object':
    case 'array':
      throw new PublicContractError(
        field,
        `${expression.op} can never evaluate to a string; this slot requires one`,
      );
    case 'concat':
      expression.values.forEach((nested, index) => {
        assertStringSlotExpression(nested, inputSchema, `${field}.values[${index}]`);
      });
      return;
    case 'url_encode':
    case 'base64':
    case 'sha256':
      assertStringSlotExpression(expression.value, inputSchema, `${field}.value`);
      return;
    case 'hmac_sha256':
      assertStringSlotExpression(expression.key, inputSchema, `${field}.key`);
      assertStringSlotExpression(expression.value, inputSchema, `${field}.value`);
      return;
    case 'to_string':
    case 'json_encode':
    case 'binding':
      return;
  }
}

/** The declared type of a top-level input property, or null when the schema
 *  does not pin one (nested pointers, permissive objects, unknown keys). */
function declaredInputType(schema: JsonSchemaV1, pointer: string): JsonSchemaV1['type'] | null {
  if (schema.type !== 'object') return null;
  const tokens = pointer.split('/').slice(1);
  if (tokens.length !== 1 || tokens[0] === undefined) return null;
  const key = tokens[0].replace(/~1/g, '/').replace(/~0/g, '~');
  const property = schema.properties[key];
  return property === undefined ? null : property.type;
}
