// URL→surface routing index for the session-phase machine.
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
 *  triaged surface owns it. */
export function lookupSurface(session: Session, rawUrl: string): string | undefined {
  if (!session.surfaceMap) return undefined;
  const key = urlKey(rawUrl);
  if (key === null) return undefined;
  return session.surfaceMap.get(key);
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
