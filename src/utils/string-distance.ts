// String-distance helpers — Levenshtein + "did you mean" suggestion + candidate
// ranking. Used by every save-time validator and audit rejection that wants to
// soften "your value isn't in the allowed set" with the likely intended value.
// Centralized here so the heuristic is uniform across rejection sites and
// adding a new closed-set rejection doesn't require re-implementing the
// suggestion logic at each call site.
//
// Quick reference:
//   didYouMeanSuffix(bad, allowed)      → ` — did you mean "X"?` or ''
//   closestAllowed(bad, allowed)        → single best match or null
//   closestAllowedCandidates(bad, ...)  → ranked top-N matches with custom keyFn
//   formatCandidateList(list, opts)     → bullet-block formatter for rejections

/**
 * Central did-you-mean helper. Given an agent-supplied bad value and the
 * allowed set, returns ` — did you mean "Y"?` when the closest allowed value is
 * within a length-scaled edit-distance threshold. Returns '' otherwise.
 * Centralizing here means every save-time validator that rejects unknown
 * fields / unknown enum values suggests the likely intended value without each
 * site re-implementing the heuristic.
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
    // is basically unrelated). Scale with the longer of the two.
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
export function levenshtein(a: string, b: string): number {
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
