// Slug-collision concern — one fact-extractor shared by every surface that
// reasons about "a capability slug bakes a query-param value."
//
// Consumers project the same facts into different envelopes:
//   - `detectSlugBakesQueryValue` (audit/triage/triage-plan.ts) — audit issue
//     over the agent's declared request_patterns.
//   - `deriveSlugCollisions` (phases/triage/triage-authoring-contract.ts) —
//     authoring hint over the session's captured URLs (a forward prediction
//     of what the audit will fire on once request_patterns cover them).
//   - `detectEnumValueInCapabilitySlug` (gate/save-warnings-collision.ts) —
//     save-time issue over the strategy's own observed_values (tokenizer
//     only; its value source is strategy metadata, not URLs).
//
// The module owns the matching primitives; each consumer owns its input
// source. Parity between audit issue and authoring hint is enforced by
// runtime/test/authoring-contract-parity.test.js.

/** Canonical slug tokenizer: lowercase, split on `_`, `-`, `/`, drop empty
 *  segments. Exact-token matching downstream keeps the check crisp — no
 *  substring matching (which false-positives on short generic tokens). */
export function tokenizeSlug(slug: string): string[] {
  return slug
    .toLowerCase()
    .split(/[_\-/]/)
    .filter((t) => t.length > 0);
}

export interface SlugQueryValueCollision {
  /** The query-param value (verbatim casing) that collides with a slug token. */
  token: string;
  /** The query param carrying the colliding value. */
  param_name: string;
  /** The URL string the collision was found on (as passed in). */
  url: string;
}

/** Walk `urls` and report every query-param value that exact-token-matches
 *  one of the slug's tokens. Relative paths resolve against a placeholder
 *  base so `?x=y` query parsing still works; unparseable entries are
 *  skipped. */
export function findSlugQueryValueCollisions(
  slug: string,
  urls: readonly string[],
): SlugQueryValueCollision[] {
  const tokens = new Set(tokenizeSlug(slug));
  if (tokens.size === 0) return [];
  const out: SlugQueryValueCollision[] = [];
  for (const raw of urls) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      try {
        parsed = new URL(raw, 'https://__placeholder__/');
      } catch {
        continue;
      }
    }
    for (const [paramName, value] of parsed.searchParams) {
      if (typeof value !== 'string' || value.length === 0) continue;
      if (tokens.has(value.toLowerCase())) {
        out.push({ token: value, param_name: paramName, url: raw });
      }
    }
  }
  return out;
}
