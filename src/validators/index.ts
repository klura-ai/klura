// Tiny dependency-free validators for LLM-supplied input.
//
// Every entry point that accepts data from an agent (save_strategy, set_policy,
// set_identity, execute args, listener args, perform_action, patch_step, etc.)
// routes its input through this module so the runtime gets one consistent error
// format and one place to update the rules.
//
// Design rules: 1. NO dependencies. We don't pull in zod / yup / joi / ajv. The
// runtime ships as an npm package and dep weight matters. 2. Each function
// takes the value, a `field` string for the error message, and any constraints.
// Returns the narrowed type on success or throws ValidationError on failure. 3.
// Error messages always include the field path so the agent knows WHERE the
// problem is, not just what it is. 4. Callers wrap thrown errors with their
// domain prefix: try { v.asPlatformSlug(platform, 'platform'); } catch (e) { throw new
// Error(`invalid_strategy: ${e.message}`); } The validators themselves stay
// context-free so they're reusable.
//
// Underlies the "LLMs hallucinate" guard: every entry point that accepts data
// from an agent routes through this module so hallucinated enum values, wrong
// shapes, and invented field names fail loudly at the boundary with a message
// the agent can act on.

export class ValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(field, `must be a string (got ${describe(value)})`);
  }
  return value;
}

export function asNonEmptyString(value: unknown, field: string): string {
  const s = asString(value, field);
  if (s.length === 0) {
    throw new ValidationError(field, 'must be a non-empty string');
  }
  return s;
}

/**
 * String with an upper bound on length. Catches the "LLM emits a 500 KB blob"
 * class of bug — agents sometimes paste entire HTML pages or response bodies
 * into single fields. Default cap: 10 KB unless the caller specifies.
 */
export function asBoundedString(value: unknown, field: string, max = 10_000): string {
  const s = asString(value, field);
  if (s.length > max) {
    throw new ValidationError(field, `must be at most ${max} characters (got ${s.length})`);
  }
  return s;
}

export function asNonEmptyBoundedString(value: unknown, field: string, max = 10_000): string {
  const s = asNonEmptyString(value, field);
  if (s.length > max) {
    throw new ValidationError(field, `must be at most ${max} characters (got ${s.length})`);
  }
  return s;
}

export function asObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(field, `must be a plain object (got ${describe(value)})`);
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(field, `must be an array (got ${describe(value)})`);
  }
  return value;
}

export function asNonEmptyArray(value: unknown, field: string): unknown[] {
  const arr = asArray(value, field);
  if (arr.length === 0) {
    throw new ValidationError(field, 'must be a non-empty array');
  }
  return arr;
}

export function asEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const s = asString(value, field);
  if (!allowed.includes(s as T)) {
    throw new ValidationError(
      field,
      `= ${JSON.stringify(s)} is not allowed; must be one of: ${describeEnum(allowed)}${didYouMeanSuffix(s, allowed as readonly string[])}`,
    );
  }
  return s as T;
}

/**
 * Canonical rendering of an enum / allowlist as a human-readable comma-list of
 * JSON-quoted values. Every rejection message that names an allowed set should
 * go through this helper so the prose stays in sync with the canonical
 * definition at a single source.
 */
export function describeEnum(allowed: readonly string[]): string {
  return allowed.map((a) => JSON.stringify(a)).join(', ');
}

/**
 * Central did-you-mean helper. Given an agent-supplied bad value and the
 * allowed set, returns ` — did you mean "Y"?` when the closest allowed value is
 * within edit-distance 3 AND shares at least 30% of characters. Returns ''
 * otherwise. Centralizing here means every save-time validator that rejects
 * unknown fields / unknown enum values suggests the likely intended value
 * without each site re-implementing the heuristic.
 */
export function didYouMeanSuffix(bad: string, allowed: readonly string[]): string {
  const suggestion = closestAllowed(bad, allowed);
  if (!suggestion) return '';
  return ` — did you mean ${JSON.stringify(suggestion)}?`;
}

/** Shared core: pure function, testable without a validator context. */
export function closestAllowed(bad: string, allowed: readonly string[]): string | null {
  if (typeof bad !== 'string' || bad.length === 0 || allowed.length === 0) {
    return null;
  }
  const badLower = bad.toLowerCase();
  let best: { value: string; distance: number } | null = null;
  for (const a of allowed) {
    const aLower = a.toLowerCase();
    if (aLower === badLower) continue;
    const d = levenshtein(badLower, aLower);
    // Tighter threshold for short strings (a 3-char typo on a 4-char field name
    // is basically unrelated). Scale with the shorter of the two.
    const maxLen = Math.max(bad.length, a.length);
    let minDistance = 3;
    if (maxLen <= 4) {
      minDistance = 1;
    } else if (maxLen <= 8) {
      minDistance = 2;
    }
    if (d <= minDistance) {
      if (!best || d < best.distance) best = { value: a, distance: d };
    }
  }
  return best?.value ?? null;
}

/**
 * Multi-candidate sibling of `closestAllowed`. Ranks `candidates` by edit
 * distance from `bad` (against a string projected via `keyFn`) and returns the
 * top N original entries — preserving the original shape so callers can render
 * the candidate's display form, not just its key.
 *
 * Uses a looser distance threshold than the single-suggestion variant
 * (`closestAllowed` only wants to suggest ONE likely-intended value;
 * `closestAllowedCandidates` is meant to PRIME the agent with the available
 * options when no clear single match exists). Candidates beyond `maxResults`
 * are dropped. When fewer than `maxResults` candidates are within range, all of
 * them are returned (small option-sets get fully listed).
 *
 * Empty `bad` or empty `candidates` → empty result.
 */
export function closestAllowedCandidates<T>(
  bad: string,
  candidates: readonly T[],
  keyFn: (c: T) => string,
  options?: { maxResults?: number; maxDistance?: number },
): T[] {
  if (typeof bad !== 'string' || bad.length === 0 || candidates.length === 0) return [];
  const maxResults = options?.maxResults ?? 5;
  const maxDistance = options?.maxDistance ?? Math.max(bad.length, 8);
  const badLower = bad.toLowerCase();
  const ranked: Array<{ entry: T; distance: number }> = [];
  for (const c of candidates) {
    const key = keyFn(c);
    if (typeof key !== 'string' || key.length === 0) continue;
    const d = levenshtein(badLower, key.toLowerCase());
    if (d > maxDistance) continue;
    ranked.push({ entry: c, distance: d });
  }
  ranked.sort((a, b) => a.distance - b.distance);
  return ranked.slice(0, maxResults).map((r) => r.entry);
}

/**
 * Render a list of candidate strings as a bullet block suitable for appending
 * to a rejection message. Returns the empty string when `candidates` is empty.
 * Header is rendered as a leading line ending with `:` followed by bullets.
 */
export function formatCandidateList(
  candidates: readonly string[],
  options?: { header?: string; bullet?: string; maxResults?: number },
): string {
  if (candidates.length === 0) return '';
  const max = options?.maxResults ?? candidates.length;
  const bullet = options?.bullet ?? '  - ';
  const header = options?.header ?? 'Candidates';
  const shown = candidates.slice(0, max);
  const more = candidates.length - shown.length;
  const lines = [`${header}:`, ...shown.map((c) => `${bullet}${c}`)];
  if (more > 0) lines.push(`${bullet}… (${more} more)`);
  return `\n\n${lines.join('\n')}`;
}

/** Classic dynamic-programming Levenshtein. Sub-millisecond for the
 * string lengths we see in schema field names (< 40 chars). And yes,
 *  you'd be surprised how bad LLMs can be at spelling */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1, // deletion
        (curr[j - 1] ?? 0) + 1, // insertion
        (prev[j - 1] ?? 0) + cost, // substitution
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

export function asPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(field, `must be a positive integer (got ${describe(value)})`);
  }
  return value;
}

export function asNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(field, `must be a non-negative integer (got ${describe(value)})`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Domain primitives — common klura-shaped strings
// ---------------------------------------------------------------------------

// Platform slugs are kebab-case and become filesystem directory names
// (skills/<platform>/...). Underscores are excluded so the surface stays
// visually distinct from capability / identity / step_id slugs, which are
// snake_case. Single-letter platforms like "x" (x.com) are valid, so the
// trailing char class is {0,63}.
const PLATFORM_SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;

// Identifier slugs (capability names, identity keys, per-capability policy
// keys, binds_to_args entries, recorded-path step ids) share the same
// snake_case shape. SAME regex as `STEP_ID_REGEX` in
// `strategies/validate/recorded-path.ts` — keep in sync if either moves.
const IDENTIFIER_SLUG_RE = /^[a-z][a-z0-9_]{2,39}$/;

/**
 * Platform name — kebab-case, starts with a letter, 1-64 chars. Becomes a
 * filesystem directory, so no path separators, dots, or uppercase.
 */
export function asPlatformSlug(value: unknown, field: string): string {
  const s = asNonEmptyBoundedString(value, field, 64);
  if (!PLATFORM_SLUG_RE.test(s)) {
    throw new ValidationError(
      field,
      `= ${JSON.stringify(s)} must be kebab-case like 'facebook-messenger' or 'hackernews' (lowercase letters / digits / dashes only, starts with a letter, 1-64 chars)`,
    );
  }
  return s;
}

/**
 * Identifier slug — snake_case, starts with a letter, 3-40 chars. Used for
 * capability names, identity keys, per-capability policy keys, binds_to_args
 * entries, and recorded-path step ids.
 */
export function asIdentifierSlug(value: unknown, field: string): string {
  const s = asNonEmptyBoundedString(value, field, 40);
  if (!IDENTIFIER_SLUG_RE.test(s)) {
    throw new ValidationError(
      field,
      `= ${JSON.stringify(s)} must be snake_case like 'send_message' or 'get_user_posts' (lowercase letters / digits / underscores only, starts with a letter, 3-40 chars)`,
    );
  }
  return s;
}

const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

/**
 * Parse-validate a URL. Default whitelist: http + https only. Rejects `file:`,
 * `javascript:`, `data:`, etc. that could escape into the wrong context (page
 * navigation, iframe injection, fetch hijack).
 */
export function asUrl(
  value: unknown,
  field: string,
  options: { schemes?: ReadonlySet<string>; maxLength?: number } = {},
): string {
  const s = asNonEmptyBoundedString(value, field, options.maxLength ?? 4096);
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    throw new ValidationError(field, `is not a valid URL: ${JSON.stringify(s)}`);
  }
  const allowed = options.schemes ?? ALLOWED_URL_SCHEMES;
  if (!allowed.has(parsed.protocol)) {
    throw new ValidationError(
      field,
      `URL scheme ${JSON.stringify(parsed.protocol)} not allowed; must be one of: ${[...allowed].join(', ')}`,
    );
  }
  return s;
}

// Reserved object keys that, if used as input keys, can corrupt prototype
// chains via Object.assign / spread. Reject loudly at the validation layer.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Asserts that none of the keys in an object are reserved JS internals
 * (__proto__, constructor, prototype). Prevents prototype pollution when the
 * caller spreads or assigns the validated object into another.
 */
export function assertNoReservedKeys(obj: Record<string, unknown>, field: string): void {
  for (const key of Object.keys(obj)) {
    if (RESERVED_KEYS.has(key)) {
      throw new ValidationError(
        field,
        `key ${JSON.stringify(key)} is reserved (would corrupt the prototype chain)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
