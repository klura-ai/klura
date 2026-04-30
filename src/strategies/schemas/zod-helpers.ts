// Shared helpers for Zod-backed validators in `runtime/src/strategies/schemas/`.
// Two contracts:
//   1. Convert a `ZodError` into the klura `invalid_strategy: <where>.<field>
//      ...` bullet format used everywhere else in the codebase.
//   2. Render a schema's introspectable shape to a compact JSON-skeleton —
//      `z.toJSONSchema` is the source of truth, walked here into the
//      agent-facing render.

import { z } from 'zod';
import type { ZodError, ZodType } from 'zod';

// Zod's per-issue type signature is intentionally open — the discriminant
// switch below is the canonical form. Use a single typed-as-any handle so
// the casts at every case-arm don't pile up. Every per-code field is
// optional here (the discriminant guarantees only `code`, `path`,
// `message` are always present); narrowing happens inline.
interface ZodIssueRecord {
  code: string;
  path: readonly (string | number)[];
  message: string;
  expected?: string;
  input?: unknown;
  values?: readonly unknown[];
  format?: string;
  keys?: readonly string[];
  issues?: ZodIssueRecord[];
}

/** Convert one Zod issue into a klura-style bullet. Walks `path` for the
 *  field locator. Handles record-key + nested-issue cases by recursing. */
export function formatZodIssue(issue: ZodIssueRecord, where: string): string {
  const fieldPath = issue.path.length > 0 ? `${where}.${issue.path.join('.')}` : where;
  switch (issue.code) {
    case 'invalid_type': {
      // Zod 4 reports missing required fields as { code: 'invalid_type',
      // expected, input: undefined } in some cases, and omits `input` while
      // spelling "received undefined" in others. Other type mismatches carry
      // the received type in the natural message.
      if (issue.input === undefined && /received undefined/.test(issue.message)) {
        return `${fieldPath} is required (${issue.expected ?? 'value'})`;
      }
      const naturalType = /^Invalid input: expected ([^,]+), received ([^,]+)$/.exec(issue.message);
      if (naturalType) {
        const [, expected, received] = naturalType;
        if (!expected || !received) return joinMessage(fieldPath, issue.message);
        const expectedLabel = expected === 'record' ? 'object' : expected;
        const article = /^[aeiou]/i.test(expectedLabel) ? 'an' : 'a';
        return `${fieldPath} must be ${article} ${expectedLabel} (expected ${expected}, got ${received})`;
      }
      if (issue.message) return joinMessage(fieldPath, issue.message);
      return `${fieldPath} must be ${issue.expected ?? 'a valid value'} (got ${typeof issue.input})`;
    }
    case 'invalid_value':
      return `${fieldPath} must be ${formatExpected(issue)}`;
    case 'invalid_format':
      if (issue.message) return joinMessage(fieldPath, issue.message);
      return `${fieldPath} must be a valid ${issue.format ?? 'value'}`;
    case 'too_small':
    case 'too_big':
      return joinMessage(fieldPath, issue.message);
    case 'unrecognized_keys': {
      const keys = issue.keys ?? [];
      const list = keys.map((k) => `"${k}"`).join(', ');
      const noun = keys.length === 1 ? 'field' : 'fields';
      return `${fieldPath} has unknown ${noun} ${list}`;
    }
    case 'invalid_key': {
      // `record(keySchema, valueSchema)` rejection on a key that fails
      // keySchema. Zod 4 wraps the inner issue under `issues`. Recurse
      // so the underlying message (e.g. "snake_case identifier") lands
      // verbatim.
      if (issue.issues && issue.issues.length > 0) {
        return issue.issues.map((inner) => formatZodIssue(inner, fieldPath)).join('; ');
      }
      return joinMessage(fieldPath, issue.message);
    }
    case 'custom':
      // .refine() messages land here. The refine callback supplies the
      // human-facing text directly.
      return joinMessage(fieldPath, issue.message);
    default:
      return joinMessage(fieldPath, issue.message);
  }
}

// Splice a field locator with a message. If the message is already a
// well-formed sentence-fragment ("must be ...", "is required", "has
// unknown ..."), space-join — `field must be ...` reads naturally. For
// fragments that start with a noun ("snake_case identifier"), fall back
// to ": " so `field: snake_case identifier` doesn't look like
// concatenation slop.
function joinMessage(fieldPath: string, message: string): string {
  if (/^(must |is |has |should |cannot |contains |exceeds |declares )/.test(message)) {
    return `${fieldPath} ${message}`;
  }
  return `${fieldPath}: ${message}`;
}

function formatExpected(issue: ZodIssueRecord): string {
  if (Array.isArray(issue.values) && issue.values.length > 0) {
    const list = issue.values.map((v) => JSON.stringify(v)).join(' | ');
    return `one of ${list}`;
  }
  return issue.message || 'a valid value';
}

/** Convert a whole ZodError into a flat issue-string array, klura-bullet
 *  formatted. */
export function zodErrorToIssues(err: ZodError, where: string): string[] {
  return err.issues.map((i) => formatZodIssue(i as unknown as ZodIssueRecord, where));
}

/** Run `schema.safeParse` and throw the klura-canonical bundled rejection
 *  on failure. Returns the parsed data on success. */
export function parseOrThrow<T extends ZodType>(
  schema: T,
  data: unknown,
  opts: { where: string; kindLabel?: string; referenceSlug?: string },
): z.infer<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = zodErrorToIssues(result.error, opts.where);
  const kindSuffix = opts.kindLabel ? ` (${opts.kindLabel})` : '';
  const issueLabel = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
  const head = `invalid_strategy: ${opts.where}${kindSuffix} has ${issueLabel} — fix all before retrying:`;
  const bullets = issues.map((s) => `  - ${s}`).join('\n');
  const skeleton = renderZodSkeleton(schema);
  const ref = opts.referenceSlug ? `\n\nSee klura://reference#${opts.referenceSlug}.` : '';
  throw new Error(`${head}\n${bullets}\n\nExpected shape:\n${skeleton}${ref}`);
}

/** Render a Zod schema's shape as a compact JSON-skeleton. Reads from
 *  `z.toJSONSchema(schema)` — reflection over the schema's structure,
 *  not a parallel data table. */
export function renderZodSkeleton(schema: ZodType): string {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchemaNode;
  return jsonSchemaToSkeleton(json, '  ');
}

interface JsonSchemaNode {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  format?: string;
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  additionalProperties?: boolean | JsonSchemaNode;
}

function jsonSchemaToSkeleton(node: JsonSchemaNode, indent: string): string {
  if (!node.properties || Object.keys(node.properties).length === 0) {
    return `${indent}${typeLabel(node)}`;
  }
  const required = new Set(node.required ?? []);
  const lines: string[] = ['{'];
  for (const [field, prop] of Object.entries(node.properties)) {
    const key = required.has(field) ? `"${field}"` : `"${field}"?`;
    const t = typeLabel(prop);
    const hint = prop.description ? `  // ${prop.description}` : '';
    lines.push(`${indent}  ${key}: ${t},${hint}`);
  }
  lines.push(`${indent}}`);
  return lines.join('\n');
}

function typeLabel(node: JsonSchemaNode): string {
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum.map((v) => JSON.stringify(v)).join(' | ');
  }
  if (node.anyOf && node.anyOf.length > 0) {
    return node.anyOf.map(typeLabel).join(' | ');
  }
  if (node.type === 'array') {
    return node.items ? `${typeLabel(node.items)}[]` : 'array';
  }
  if (node.type === 'object') {
    if (node.properties && Object.keys(node.properties).length > 0) {
      return jsonSchemaToSkeleton(node, '  ');
    }
    return 'object';
  }
  if (typeof node.type === 'string') {
    if (node.format === 'url' || node.format === 'uri') return 'url';
    return node.type;
  }
  return 'unknown';
}
