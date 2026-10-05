// The shape of one response, in the subset a signed outcome contract admits.
//
// A package signs what a capability returns: every field, its type, how deep
// it nests. That schema is derived from a response the capability actually
// returned, never written by hand, and a response whose shape the subset
// cannot state is one the capability cannot ship with. The limits here are the
// contract parser's own, read from it, so "this fits" means the same thing
// when a strategy is saved as when a package is compiled from it.
import { JSON_SCHEMA_LIMITS_V1 } from '../../public/contracts/json-schema';

/** The most one outcome may carry, as encoded JSON. */
export const MAX_OUTCOME_BYTES_V1 = 16_384;

/** Rows read from a list to describe it; rows past this add no new shape. */
const MAX_SAMPLED_ITEMS = 25;

export type InferredSchemaV1 =
  | { type: 'null' }
  | { type: 'boolean' | 'number' | 'string'; nullable?: true }
  | { type: 'array'; items?: InferredSchemaV1; undescribed_at?: string; nullable?: true }
  | {
      type: 'object';
      properties: Record<string, InferredSchemaV1>;
      required: string[];
      additionalProperties: false;
      nullable?: true;
    };

/**
 * The shape cannot be written down in the subset a signed contract admits.
 *
 * There is deliberately no permissive fallback. The subset has no "any": a
 * node standing in for "something was here" would be a claim about data
 * nobody has seen, signed.
 */
export class OutcomeShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeShapeError';
  }
}

export function encodedBytes(value: unknown): number {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * One schema covering both observations.
 *
 * Array items differ between rows, and a schema built from row one alone
 * rejects row two. Merging widens: a key missing from either side stops being
 * required, and a field null in one row and typed in another becomes nullable,
 * which is how the subset says "sometimes absent". Any other disagreement is
 * reported, not papered over.
 */
export function mergeOutcomeSchemas(
  a: InferredSchemaV1 | undefined,
  b: InferredSchemaV1 | undefined,
): InferredSchemaV1 | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.type === 'null' && b.type !== 'null') return { ...b, nullable: true };
  if (b.type === 'null' && a.type !== 'null') return { ...a, nullable: true };
  if (a.type === 'null' || b.type === 'null') return a;
  if (a.type !== b.type) {
    throw new OutcomeShapeError(
      `the same field is ${a.type} in one row and ${b.type} in another, which a signed schema cannot express`,
    );
  }
  const nullable = a.nullable || b.nullable ? { nullable: true as const } : {};
  if (a.type === 'array' && b.type === 'array') {
    const items = mergeOutcomeSchemas(a.items, b.items);
    // A list empty in every row seen so far keeps the place it was found.
    return items
      ? { type: 'array', items, ...nullable }
      : { type: 'array', undescribed_at: a.undescribed_at ?? b.undescribed_at ?? '', ...nullable };
  }
  if (a.type === 'object' && b.type === 'object') {
    const properties: Record<string, InferredSchemaV1> = { ...a.properties };
    for (const [key, schema] of Object.entries(b.properties)) {
      const merged = mergeOutcomeSchemas(properties[key], schema);
      if (merged) properties[key] = merged;
    }
    return {
      type: 'object',
      properties,
      required: a.required.filter((key) => b.required.includes(key)),
      additionalProperties: false,
      ...nullable,
    };
  }
  return { ...a, ...nullable };
}

function inferNode(value: unknown, depth: number, path: string): InferredSchemaV1 {
  if (depth >= JSON_SCHEMA_LIMITS_V1.maximumDepth) {
    throw new OutcomeShapeError(
      `the response nests deeper than ${JSON_SCHEMA_LIMITS_V1.maximumDepth} levels — return the ` +
        `part a caller reads instead of the whole document`,
    );
  }
  if (value === null) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  // Always `number`: whether a field is integral is not something a handful
  // of observations can establish.
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'string') return { type: 'string' };
  if (Array.isArray(value)) {
    // An empty list cannot describe its rows. It is left without an item
    // schema, and stays that way only if no other row fills the same list.
    if (value.length === 0) return { type: 'array', undescribed_at: path };
    let items: InferredSchemaV1 | undefined;
    for (const item of value.slice(0, MAX_SAMPLED_ITEMS)) {
      items = mergeOutcomeSchemas(items, inferNode(item, depth + 1, `${path}[]`));
    }
    return items ? { type: 'array', items } : { type: 'array', undescribed_at: path };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > JSON_SCHEMA_LIMITS_V1.maximumProperties) {
      throw new OutcomeShapeError(
        `an object in the response carries ${entries.length} keys and a schema admits ` +
          `${JSON_SCHEMA_LIMITS_V1.maximumProperties} — return the keys a caller reads`,
      );
    }
    const properties: Record<string, InferredSchemaV1> = {};
    const required: string[] = [];
    for (const [key, entry] of entries) {
      properties[key] = inferNode(entry, depth + 1, path ? `${path}.${key}` : key);
      // A null in the sample is the field telling you it is optional.
      if (entry !== null && entry !== undefined) required.push(key);
    }
    return { type: 'object', properties, required, additionalProperties: false };
  }
  throw new OutcomeShapeError(`a ${jsonTypeOf(value)} value has no schema in the subset`);
}

/** The path of a list no observation described, or null when every list has
 *  an item schema. */
function firstUndescribedList(schema: InferredSchemaV1): string | null {
  if (schema.type === 'array') {
    return schema.items ? firstUndescribedList(schema.items) : (schema.undescribed_at ?? '');
  }
  if (schema.type === 'object') {
    for (const property of Object.values(schema.properties)) {
      const found = firstUndescribedList(property);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Nodes in the finished schema, which is what the contract bounds. */
function countNodes(schema: InferredSchemaV1): number {
  if (schema.type === 'array') return 1 + (schema.items ? countNodes(schema.items) : 0);
  if (schema.type === 'object') {
    return Object.values(schema.properties).reduce((total, child) => total + countNodes(child), 1);
  }
  return 1;
}

/**
 * The schema for one response, or an `OutcomeShapeError` naming why the
 * subset cannot state it: too deep, too wide, too many nodes, a field whose
 * type differs between rows, or a list no row filled.
 */
export function inferOutcomeSchema(value: unknown): InferredSchemaV1 {
  const schema = inferNode(value, 0, '');
  const undescribed = firstUndescribedList(schema);
  if (undescribed !== null) {
    throw new OutcomeShapeError(
      `${undescribed || 'the response'} is an empty list in this response, so its rows are ` +
        `undescribed — document an example whose call fills it, or leave the field out`,
    );
  }
  const nodes = countNodes(schema);
  if (nodes > JSON_SCHEMA_LIMITS_V1.maximumNodes) {
    throw new OutcomeShapeError(
      `describing this response takes ${nodes} schema nodes and a signed schema admits ` +
        `${JSON_SCHEMA_LIMITS_V1.maximumNodes} — return the fields a caller reads`,
    );
  }
  return schema;
}

/**
 * Whether a response is a record with fields and nothing in them.
 *
 * A lookup asked for something the site does not have answers in full shape:
 * every field present, every field null, perhaps a flag saying so. A field
 * that merely repeats one of the call's own arguments is the caller's value,
 * not the site's, and a boolean is a flag about the answer rather than part of
 * it — so a body is hollow when it has such fields and no other leaf holds a
 * value. A body made only of booleans is left alone: that can be the answer.
 */
export function isHollowRecord(body: unknown, args: unknown = {}): boolean {
  const echoed = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number') echoed.add(String(value));
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(args);

  let fields = 0;
  let filled = 0;
  const visit = (value: unknown): void => {
    if (typeof value === 'boolean') return;
    if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(visit);
      return;
    }
    fields += 1;
    if (typeof value === 'string') {
      if (value.trim().length > 0 && !echoed.has(value)) filled += 1;
    } else if (typeof value === 'number' && !echoed.has(String(value))) {
      filled += 1;
    }
  };
  visit(body);
  return fields > 0 && filled === 0;
}

/**
 * How many whole rows of an oversized listing fit one outcome, or null when
 * cutting rows cannot make the response fit: its bulk is not a list, a single
 * row is too large, or what surrounds the list is itself most of the budget.
 * Returns the response as a caller would receive it beside the row count.
 */
export function boundedListing(body: unknown): { limit: number; projected: unknown } | null {
  const rowsThatFit = (rows: unknown[], overheadBytes: number): number => {
    const largest = Math.max(...rows.map((row) => encodedBytes(row)));
    const fit = Math.floor(((MAX_OUTCOME_BYTES_V1 - overheadBytes) * 0.8) / (largest + 1));
    return Math.min(fit, rows.length, 1000);
  };
  if (Array.isArray(body)) {
    if (body.length === 0) return null;
    const limit = rowsThatFit(body, 2);
    return limit < 1 ? null : { limit, projected: body.slice(0, limit) };
  }
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const lists = Object.entries(record).filter(
    (entry): entry is [string, unknown[]] => Array.isArray(entry[1]) && entry[1].length > 0,
  );
  const [first, ...others] = lists;
  if (!first) return null;
  const [listKey, rows] = others.reduce(
    (largest, candidate) =>
      encodedBytes(candidate[1]) > encodedBytes(largest[1]) ? candidate : largest,
    first,
  );
  const rest = Object.fromEntries(Object.entries(record).filter(([key]) => key !== listKey));
  const overhead = encodedBytes(rest) + listKey.length + 8;
  if (overhead > MAX_OUTCOME_BYTES_V1 / 2) return null;
  const limit = rowsThatFit(rows, overhead);
  return limit < 1 ? null : { limit, projected: { ...record, [listKey]: rows.slice(0, limit) } };
}
