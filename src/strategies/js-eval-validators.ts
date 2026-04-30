// Validators specific to the `js-eval` prereq shape — bounded-script acceptance
// + the {kind, min_length, max_length, required_keys} return-shape declaration.
// Kept here (not in the generic runtime/src/validators.ts toolkit) because the
// shape language is klura-domain and only this one prereq method reads it; the
// toolkit stays focused on type-coercion primitives + schema-rendering helpers.

import {
  ValidationError,
  asNonEmptyBoundedString,
  asObject,
  asEnum,
  asNonNegativeInt,
  asArray,
  asNonEmptyString,
  asString,
  assertNoReservedKeys,
} from '../validators';

/**
 * Upper bound on js-eval prereq expressions. Sized for real-world signer /
 * nonce-minter code — the TikTok X-Bogus signer + its base64 wrappers
 * comfortably fits, and binary-frame builders need a few KB of bit-twiddling
 * and TextEncoder glue. Smaller token-minting one-liners are well under this
 * cap.
 */
export const JS_EVAL_SCRIPT_MAX = 8192;

/**
 * String expression suitable for `page.evaluate`. Enforces a length cap and
 * rejects obvious malformed shapes. Does NOT attempt to block "dangerous" JS —
 * that's not what this layer is for.
 */
export function asBoundedScript(
  value: unknown,
  field: string,
  max: number = JS_EVAL_SCRIPT_MAX,
): string {
  const s = asNonEmptyBoundedString(value, field, max);
  if (!isBalancedBracketsAndQuotes(s)) {
    throw new ValidationError(
      field,
      'has unbalanced brackets or quotes — the runtime would fail to parse it as a JavaScript expression',
    );
  }
  return s;
}

/**
 * Cheap balanced-bracket + quote check. Walks the string once and verifies
 * every `(`/`{`/`[` has a matching closer and that single/ double/backtick
 * quoted regions are properly closed; skips escaped characters inside strings.
 * Not a parser — an LLM that writes syntactically-valid JS but
 * semantically-wrong code (nonexistent global, wrong return shape) gets caught
 * by the save-time execution probe, not here.
 */
function isBalancedBracketsAndQuotes(s: string): boolean {
  const stack: string[] = [];
  let inString: '"' | "'" | '`' | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') {
        i++; // skip next
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = stack.pop();
      if (
        (ch === ')' && open !== '(') ||
        (ch === ']' && open !== '[') ||
        (ch === '}' && open !== '{')
      ) {
        return false;
      }
    }
  }
  return inString === null && stack.length === 0;
}

/**
 * Allowed `kind` values for a js-eval prereq's return-shape declaration. Narrow
 * on purpose — a richer shape language (nested objects, arrays-of-X,
 * discriminated unions) is easy to invent but the current caller only needs
 * primitive scalars + one-level objects.
 */
export const JS_EVAL_SHAPE_KINDS = ['string', 'number', 'boolean', 'object'] as const;

export type JsEvalShapeKind = (typeof JS_EVAL_SHAPE_KINDS)[number];

export interface JsEvalReturnShape {
  kind: JsEvalShapeKind;
  /** Only meaningful for `kind: "string"` — inclusive lower bound. */
  min_length?: number;
  /** Only meaningful for `kind: "string"` — inclusive upper bound. */
  max_length?: number;
  /** Only meaningful for `kind: "object"` — object must contain these keys. */
  required_keys?: string[];
}

/**
 * Validate that `value` describes a legal return-shape declaration and narrow
 * it to {@link JsEvalReturnShape}. Used at save-time when parsing the strategy
 * file and at execute-time when re-verifying a minted value.
 */
export function asReturnShape(value: unknown, field: string): JsEvalReturnShape {
  const obj = asObject(value, field);
  assertNoReservedKeys(obj, field);
  const kind = asEnum(obj.kind, `${field}.kind`, JS_EVAL_SHAPE_KINDS);
  const out: JsEvalReturnShape = { kind };
  if (obj.min_length !== undefined) {
    out.min_length = asNonNegativeInt(obj.min_length, `${field}.min_length`);
  }
  if (obj.max_length !== undefined) {
    out.max_length = asNonNegativeInt(obj.max_length, `${field}.max_length`);
  }
  if (
    out.min_length !== undefined &&
    out.max_length !== undefined &&
    out.min_length > out.max_length
  ) {
    throw new ValidationError(
      field,
      `min_length (${out.min_length}) must be <= max_length (${out.max_length})`,
    );
  }
  if (obj.required_keys !== undefined) {
    const arr = asArray(obj.required_keys, `${field}.required_keys`);
    const keys: string[] = [];
    arr.forEach((entry, i) => {
      keys.push(asNonEmptyString(entry, `${field}.required_keys[${i}]`));
    });
    out.required_keys = keys;
  }
  if (kind !== 'string' && (out.min_length !== undefined || out.max_length !== undefined)) {
    throw new ValidationError(
      field,
      `min_length / max_length are only valid when kind === "string" (got kind = "${kind}")`,
    );
  }
  if (kind !== 'object' && out.required_keys !== undefined) {
    throw new ValidationError(
      field,
      `required_keys is only valid when kind === "object" (got kind = "${kind}")`,
    );
  }
  return out;
}

/**
 * Check a runtime value against a return-shape declaration. Called at save-time
 * after the probe runs the expression, and at execute-time after the refresh
 * loop mints a fresh value. Any shape drift between declared and observed
 * throws `ValidationError` so the caller can reject cleanly.
 *
 * Returns the serializable token — for `kind: "string"` / `number` / `boolean`
 * this is the value coerced to a string, and for `kind: "object"` this is the
 * JSON-serialized form. The result slot that consumes this is a `Record<string,
 * string>` token table, so object shapes are stored as JSON text and the caller
 * is responsible for re-parsing at interpolation time.
 */
export function assertReturnShape(value: unknown, shape: JsEvalReturnShape, field: string): string {
  if (shape.kind === 'string') {
    const s = asString(value, field);
    if (shape.min_length !== undefined && s.length < shape.min_length) {
      throw new ValidationError(
        field,
        `string of length ${s.length} is shorter than declared min_length ${shape.min_length}`,
      );
    }
    if (shape.max_length !== undefined && s.length > shape.max_length) {
      throw new ValidationError(
        field,
        `string of length ${s.length} is longer than declared max_length ${shape.max_length}`,
      );
    }
    return s;
  }
  if (shape.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ValidationError(field, `must be a finite number (got ${describe(value)})`);
    }
    return String(value);
  }
  if (shape.kind === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new ValidationError(field, `must be a boolean (got ${describe(value)})`);
    }
    return String(value);
  }
  // kind === 'object'
  const obj = asObject(value, field);
  for (const key of shape.required_keys ?? []) {
    if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
      throw new ValidationError(field, `object is missing required key "${key}"`);
    }
  }
  try {
    return JSON.stringify(obj);
  } catch (err) {
    throw new ValidationError(
      field,
      `object could not be JSON-serialized: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
