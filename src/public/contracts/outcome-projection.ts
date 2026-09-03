import { PublicContractError, type JsonPointerV1 } from './common';
import { resolveJsonPointer } from './value-expression';
import type { JsonValueV1 } from './json';
import { evaluateCollectionPredicate } from './collection-predicate';
import { evaluateScrapeValue } from './scrape-value';
import type {
  OutcomeJsonArrayMapProjectionV1,
  OutcomeProjectionV1,
  OutcomeResponseV1,
} from './outcome';

/** Turns a classified response into the value the outcome's schema and
 *  assertions judge; every projection here is data-only. */
export function projectOutcome(
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
    if (projection.limit !== null && output.length >= projection.limit) break;
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

export function tryResolveResponseJsonPointer(
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

export function jsonType(
  value: JsonValueV1,
): 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as 'boolean' | 'number' | 'string' | 'object';
}

export function isScalar(value: unknown): value is null | boolean | number | string {
  return (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  );
}

export function isBodyEmpty(value: JsonValueV1): boolean {
  return value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

export function compareNumber(
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
