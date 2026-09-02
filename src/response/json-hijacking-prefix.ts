// Anti-JSON-hijacking prefixes.
//
// Some servers prepend a short unparseable guard to JSON responses so the body
// cannot be loaded as a `<script>` and read cross-origin. The guard is not part
// of the JSON: a consumer strips it, then parses. `)]}'` is the widely-deployed
// form; `for(;;);` and `while(1);` are the other two in common use.
//
// This is exact-literal matching at offset 0 of a response body, not a keyword
// bank over prose — the set is closed, each member is a fixed byte sequence,
// and a body that does not begin with one is left completely untouched.

/** The guards, longest first so a prefix of a prefix cannot match early. */
const HIJACKING_PREFIXES = [")]}',", ")]}'", 'for(;;);', 'while(1);', '&&&START&&&'] as const;

export interface PrefixStripResult {
  /** The body with the guard (and any newline following it) removed. */
  text: string;
  /** The guard that was removed, or null when the body carried none. */
  prefix: string | null;
}

/**
 * Remove a leading anti-hijacking guard, if present.
 *
 * Leaves the text untouched when no known guard starts it, so this is safe to
 * apply to any body. Callers should attempt a plain parse first and only reach
 * for this on failure — that way a body that happens to begin with these bytes
 * inside valid JSON is never disturbed.
 */
export function stripJsonHijackingPrefix(text: string): PrefixStripResult {
  for (const prefix of HIJACKING_PREFIXES) {
    if (!text.startsWith(prefix)) continue;
    let rest = text.slice(prefix.length);
    // The guard is conventionally followed by a newline; drop one if present
    // so the remainder starts at the JSON itself.
    if (rest.startsWith('\r\n')) rest = rest.slice(2);
    else if (rest.startsWith('\n')) rest = rest.slice(1);
    return { text: rest, prefix };
  }
  return { text, prefix: null };
}

/**
 * Parse a response body as JSON, tolerating a leading anti-hijacking guard.
 *
 * Returns `undefined` when the body is not JSON either way, so the caller can
 * keep its existing "content-type lied, hand back the raw text" behaviour.
 */
export function parseJsonAllowingHijackingPrefix(
  text: string,
): { value: unknown; prefix: string | null } | undefined {
  try {
    return { value: JSON.parse(text), prefix: null };
  } catch {
    /* fall through to the guard-stripping attempt */
  }
  const stripped = stripJsonHijackingPrefix(text);
  if (stripped.prefix === null) return undefined;
  try {
    return { value: JSON.parse(stripped.text), prefix: stripped.prefix };
  } catch {
    return undefined;
  }
}
