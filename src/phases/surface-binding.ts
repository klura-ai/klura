// URL→surface routing index for the phase machine.
//
// `submit_triage_plan` binds every URL in `observed_at_urls` to the plan's
// `surface_label` via `bindUrlsToSurface`. `perform_action` reads the index
// via `lookupSurface` after each navigation drain — when a path-distinct
// nav lands on a URL no triaged surface owns, the runtime fires the
// `surface_changed` checkpoint so the agent re-triages the new surface.
//
// Canonicalization rule (`urlKey`): origin + pathname; query / fragment
// stripped; host lowercased; trailing slash on a non-root path stripped.
// Different filters on /search?q=foo vs /search?q=bar collapse to the same
// surface; /search and /checkout don't.

import type { Session } from '../drivers/types/session';

/** Returns origin + pathname, query / hash stripped, host lowercased,
 *  trailing slash on a non-root path stripped. Returns `null` when the
 *  input doesn't parse as a URL. */
export function urlKey(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const origin = `${parsed.protocol}//${parsed.host.toLowerCase()}`;
  let pathname = parsed.pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  return `${origin}${pathname}`;
}

/** Bind a set of URLs to a surface label. Skips entries that fail to parse.
 *  Allocates `session.surfaceMap` lazily. */
export function bindUrlsToSurface(
  session: Session,
  surfaceLabel: string,
  urls: readonly string[],
): void {
  if (!session.surfaceMap) session.surfaceMap = new Map();
  for (const raw of urls) {
    const key = urlKey(raw);
    if (key === null) continue;
    session.surfaceMap.set(key, surfaceLabel);
  }
}

/** Returns the bound surface label for a URL, or `undefined` when no
 *  triaged surface owns it. Tries exact match first (fast path, covers the
 *  common case where the lookup URL matches a captured URL). On miss,
 *  iterates over templated map keys (those containing `{name}` segments,
 *  from `request_patterns` like `GET /channels/{id}/messages`) and tries
 *  segment-by-segment unification — a `{name}` segment matches any
 *  non-empty path segment. Without this, a save whose endpoint expands to
 *  `/channels/1412.../messages` (via `notes.params.<id>.example`) misses a
 *  bound `/channels/{id}/messages` pattern and trips
 *  `surface_triage_missing` despite the pattern structurally covering it. */
export function lookupSurface(session: Session, rawUrl: string): string | undefined {
  if (!session.surfaceMap) return undefined;
  const key = urlKey(rawUrl);
  if (key === null) return undefined;
  const exact = session.surfaceMap.get(key);
  if (exact !== undefined) return exact;
  // The `new URL()` in `urlKey` percent-encodes `{` and `}` in pathname
  // (`{id}` becomes `%7Bid%7D`), so a templated bind key looks like
  // `.../channels/%7Bid%7D/messages`. Cheap pre-filter checks both forms;
  // matchesTemplatedKey does the segment unification after decoding.
  for (const [mapKey, label] of session.surfaceMap) {
    if (!mapKey.includes('{') && !mapKey.includes('%7B')) continue;
    if (matchesTemplatedKey(mapKey, key)) return label;
  }
  return undefined;
}

/** Does `templateKey` (a canonical urlKey containing `{name}` path segments,
 *  possibly percent-encoded as `%7Bname%7D` by `new URL`) unify with
 *  `expandedKey` (a canonical urlKey with concrete values)? Same origin
 *  required; same segment count required; each segment matches if equal OR
 *  decodes to a `{name}` template (which matches any non-empty value). */
function matchesTemplatedKey(templateKey: string, expandedKey: string): boolean {
  let tUrl: URL, eUrl: URL;
  try {
    tUrl = new URL(templateKey);
    eUrl = new URL(expandedKey);
  } catch {
    return false;
  }
  if (tUrl.origin !== eUrl.origin) return false;
  const tSegs = tUrl.pathname.split('/');
  const eSegs = eUrl.pathname.split('/');
  if (tSegs.length !== eSegs.length) return false;
  for (let i = 0; i < tSegs.length; i += 1) {
    const t = tSegs[i] ?? '';
    const e = eSegs[i] ?? '';
    if (t === e) continue;
    if (isTemplateSegment(t) && e.length > 0) continue;
    return false;
  }
  return true;
}

function isTemplateSegment(seg: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(seg);
  } catch {
    decoded = seg;
  }
  return decoded.startsWith('{') && decoded.endsWith('}') && decoded.length > 2;
}

/** Two URLs are path-distinct when their canonical `urlKey` differs. Same
 *  pathname with different query is NOT path-distinct (filter UIs). When
 *  either URL fails to parse, returns `false` (don't fire on garbage). */
export function isPathDistinct(prev: string | undefined, next: string): boolean {
  if (!prev) return true;
  const a = urlKey(prev);
  const b = urlKey(next);
  if (a === null || b === null) return false;
  return a !== b;
}
