import {
  parseExactRecord,
  parseInteger,
  parseJsonPointer,
  PublicContractError,
  type JsonPointerV1,
} from './common';
import { canonicalJson, assertJsonValue, type JsonValueV1 } from './json';
import { resolveJsonPointer } from './value-expression';

export type CollectionPredicateSourceV1 =
  | 'args'
  | 'parent_item'
  | 'task_data'
  | 'task_outcome'
  | 'raw_item';

export interface CollectionPredicateReferenceV1 {
  from: CollectionPredicateSourceV1;
  pointer: JsonPointerV1;
}

export type CollectionPredicateValueV1 =
  | { kind: 'ref'; ref: CollectionPredicateReferenceV1 }
  | { kind: 'literal'; value: JsonValueV1 };

export type CollectionPredicateV1 =
  | { op: 'exists' | 'not_exists'; ref: CollectionPredicateReferenceV1 }
  | {
      op: 'json_type';
      ref: CollectionPredicateReferenceV1;
      value: 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';
    }
  | { op: 'equals'; left: CollectionPredicateValueV1; right: CollectionPredicateValueV1 }
  | { op: 'one_of'; value: CollectionPredicateValueV1; constants: JsonValueV1[] }
  | {
      op: 'array_length';
      ref: CollectionPredicateReferenceV1;
      relation: 'eq' | 'min' | 'max';
      value: number;
    }
  | { op: 'all' | 'any'; predicates: CollectionPredicateV1[] }
  | { op: 'not'; predicate: CollectionPredicateV1 };

export type CollectionPredicateContextV1 = Partial<
  Record<CollectionPredicateSourceV1, JsonValueV1>
>;

const JSON_TYPES = new Set(['null', 'boolean', 'number', 'string', 'array', 'object']);
const MAX_PREDICATE_DEPTH_V1 = 12;
const MAX_PREDICATE_ITEMS_V1 = 32;

export function parseCollectionPredicate(
  value: unknown,
  field: string,
  allowedSources: ReadonlySet<CollectionPredicateSourceV1>,
): CollectionPredicateV1 {
  return parsePredicate(value, field, allowedSources, 0);
}

export function evaluateCollectionPredicate(
  predicate: CollectionPredicateV1,
  context: CollectionPredicateContextV1,
): boolean {
  switch (predicate.op) {
    case 'exists':
      return resolveReference(predicate.ref, context).found;
    case 'not_exists':
      return !resolveReference(predicate.ref, context).found;
    case 'json_type': {
      const resolved = resolveReference(predicate.ref, context);
      return resolved.found && jsonType(resolved.value) === predicate.value;
    }
    case 'equals': {
      const left = resolveValue(predicate.left, context);
      const right = resolveValue(predicate.right, context);
      return left.found && right.found && canonicalJson(left.value) === canonicalJson(right.value);
    }
    case 'one_of': {
      const resolved = resolveValue(predicate.value, context);
      if (!resolved.found) return false;
      const rendered = canonicalJson(resolved.value);
      return predicate.constants.some((constant) => canonicalJson(constant) === rendered);
    }
    case 'array_length': {
      const resolved = resolveReference(predicate.ref, context);
      if (!resolved.found || !Array.isArray(resolved.value)) return false;
      if (predicate.relation === 'eq') return resolved.value.length === predicate.value;
      if (predicate.relation === 'min') return resolved.value.length >= predicate.value;
      return resolved.value.length <= predicate.value;
    }
    case 'all':
      return predicate.predicates.every((item) => evaluateCollectionPredicate(item, context));
    case 'any':
      return predicate.predicates.some((item) => evaluateCollectionPredicate(item, context));
    case 'not':
      return !evaluateCollectionPredicate(predicate.predicate, context);
  }
}

function parsePredicate(
  value: unknown,
  field: string,
  allowedSources: ReadonlySet<CollectionPredicateSourceV1>,
  depth: number,
): CollectionPredicateV1 {
  if (depth > MAX_PREDICATE_DEPTH_V1) {
    throw new PublicContractError(field, `exceeds predicate depth ${MAX_PREDICATE_DEPTH_V1}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be a predicate object');
  }
  const op = (value as Record<string, unknown>).op;
  if (op === 'exists' || op === 'not_exists') {
    const record = parseExactRecord(value, field, ['op', 'ref']);
    return { op, ref: parseReference(record.ref, `${field}.ref`, allowedSources) };
  }
  if (op === 'json_type') {
    const record = parseExactRecord(value, field, ['op', 'ref', 'value']);
    if (typeof record.value !== 'string' || !JSON_TYPES.has(record.value)) {
      throw new PublicContractError(`${field}.value`, 'must be a JSON type');
    }
    return {
      op,
      ref: parseReference(record.ref, `${field}.ref`, allowedSources),
      value: record.value as 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object',
    };
  }
  if (op === 'equals') {
    const record = parseExactRecord(value, field, ['op', 'left', 'right']);
    return {
      op,
      left: parseValue(record.left, `${field}.left`, allowedSources),
      right: parseValue(record.right, `${field}.right`, allowedSources),
    };
  }
  if (op === 'one_of') {
    const record = parseExactRecord(value, field, ['op', 'value', 'constants']);
    if (
      !Array.isArray(record.constants) ||
      record.constants.length === 0 ||
      record.constants.length > MAX_PREDICATE_ITEMS_V1
    ) {
      throw new PublicContractError(
        `${field}.constants`,
        `must contain one to ${MAX_PREDICATE_ITEMS_V1} values`,
      );
    }
    const constants = record.constants.map((item, index) => {
      assertJsonValue(item, `${field}.constants[${index}]`, MAX_PREDICATE_DEPTH_V1);
      return item;
    });
    assertCanonicalUnique(constants, `${field}.constants`);
    return { op, value: parseValue(record.value, `${field}.value`, allowedSources), constants };
  }
  if (op === 'array_length') {
    const record = parseExactRecord(value, field, ['op', 'ref', 'relation', 'value']);
    if (record.relation !== 'eq' && record.relation !== 'min' && record.relation !== 'max') {
      throw new PublicContractError(`${field}.relation`, 'must be eq, min, or max');
    }
    return {
      op,
      ref: parseReference(record.ref, `${field}.ref`, allowedSources),
      relation: record.relation,
      value: parseInteger(record.value, `${field}.value`, 0, 1_000_000),
    };
  }
  if (op === 'all' || op === 'any') {
    const record = parseExactRecord(value, field, ['op', 'predicates']);
    if (
      !Array.isArray(record.predicates) ||
      record.predicates.length === 0 ||
      record.predicates.length > MAX_PREDICATE_ITEMS_V1
    ) {
      throw new PublicContractError(
        `${field}.predicates`,
        `must contain one to ${MAX_PREDICATE_ITEMS_V1} predicates`,
      );
    }
    return {
      op,
      predicates: record.predicates.map((item, index) =>
        parsePredicate(item, `${field}.predicates[${index}]`, allowedSources, depth + 1),
      ),
    };
  }
  if (op === 'not') {
    const record = parseExactRecord(value, field, ['op', 'predicate']);
    return {
      op,
      predicate: parsePredicate(record.predicate, `${field}.predicate`, allowedSources, depth + 1),
    };
  }
  throw new PublicContractError(`${field}.op`, 'must be a supported collection predicate');
}

function parseReference(
  value: unknown,
  field: string,
  allowedSources: ReadonlySet<CollectionPredicateSourceV1>,
): CollectionPredicateReferenceV1 {
  const record = parseExactRecord(value, field, ['from', 'pointer']);
  if (
    typeof record.from !== 'string' ||
    !allowedSources.has(record.from as CollectionPredicateSourceV1)
  ) {
    throw new PublicContractError(`${field}.from`, 'is not available in this predicate context');
  }
  return {
    from: record.from as CollectionPredicateSourceV1,
    pointer: parseJsonPointer(record.pointer, `${field}.pointer`),
  };
}

function parseValue(
  value: unknown,
  field: string,
  allowedSources: ReadonlySet<CollectionPredicateSourceV1>,
): CollectionPredicateValueV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be a predicate value');
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'ref') {
    const record = parseExactRecord(value, field, ['kind', 'ref']);
    return { kind, ref: parseReference(record.ref, `${field}.ref`, allowedSources) };
  }
  if (kind === 'literal') {
    const record = parseExactRecord(value, field, ['kind', 'value']);
    assertJsonValue(record.value, `${field}.value`, MAX_PREDICATE_DEPTH_V1);
    return { kind, value: record.value };
  }
  throw new PublicContractError(`${field}.kind`, 'must be ref or literal');
}

function resolveReference(
  reference: CollectionPredicateReferenceV1,
  context: CollectionPredicateContextV1,
): { found: true; value: JsonValueV1 } | { found: false } {
  const source = context[reference.from];
  if (source === undefined) return { found: false };
  try {
    return {
      found: true,
      value: resolveJsonPointer(source, reference.pointer, 'predicate.pointer'),
    };
  } catch (error) {
    if (error instanceof PublicContractError) return { found: false };
    throw error;
  }
}

function resolveValue(
  value: CollectionPredicateValueV1,
  context: CollectionPredicateContextV1,
): { found: true; value: JsonValueV1 } | { found: false } {
  return value.kind === 'literal'
    ? { found: true, value: value.value }
    : resolveReference(value.ref, context);
}

function jsonType(
  value: JsonValueV1,
): 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as 'boolean' | 'number' | 'string' | 'object';
}

function assertCanonicalUnique(values: readonly JsonValueV1[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const rendered = canonicalJson(value);
    if (seen.has(rendered))
      throw new PublicContractError(field, 'must not contain duplicate values');
    seen.add(rendered);
  }
}
