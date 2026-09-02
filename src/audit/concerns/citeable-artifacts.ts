// Citeable-artifacts concern — the one extractor for "what can a
// tier_justification quote verbatim."
//
// Consumers:
//   - `tierJustificationUnciteable` Detector (audit/triage/triage-plan.ts)
//     passes the plan's defense_surface so declared origins / scripts /
//     cookies count as citeable alongside the session captures.
//   - `composeTriageAuthoringContract` (phases/triage/) passes no defense
//     surface (none exists at compose time) and slices the result to its
//     sample budget.
//
// Both sides therefore cite from the same universe — the hint can never
// advertise an artifact the audit would reject, and the audit can never
// demand a format the hint doesn't show. Parity is enforced by
// runtime/test/authoring-contract-parity.test.js.

import { urlKey } from '../../phases/surface-binding';

/** The session slice this extractor reads. Matches both the full `Session`
 *  and the contract composers' `Pick<Session, ...>` shapes. */
export interface CiteableSessionSlice {
  intercepted: ReadonlyArray<{
    url?: string;
    contentType?: string;
    setCookieNames?: unknown;
  }>;
  domNavigations?: ReadonlyArray<{ url?: string }>;
}

/** The plan-declared surface fields that extend the citeable universe.
 *  Structural subset of `DefenseSurface` (working-dir/schema). */
export interface CiteableDefenseSlice {
  observed_origins: readonly string[];
  observed_scripts: readonly string[];
  cookies_set: readonly string[];
}

/** Array guard that preserves the element type of an already-typed readonly
 *  array (the built-in `Array.isArray` narrows to `any[]`, which would strip
 *  the evidence entries down to `any`). */
function isReadonlyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function originOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * Collect every cite-able artifact: origins + hosts, script URLs + script
 * filenames, cookie names, observed navigation URLs (raw + urlKey-canonical).
 * Declared-surface artifacts are admissible because
 * `request_pattern_url_observed` already ground-truth-checks declared
 * origins against captures — allowing them here covers the forward-claim
 * case (agent declares an origin they walked but no XHR fired yet) without
 * opening a hallucination escape hatch.
 */
export function collectCiteableArtifacts(
  session: CiteableSessionSlice,
  defenseSurface?: CiteableDefenseSlice,
): Set<string> {
  const set = new Set<string>();
  if (defenseSurface) {
    for (const o of defenseSurface.observed_origins) {
      const origin = originOf(o);
      if (origin) {
        set.add(origin);
        try {
          set.add(new URL(origin).host.toLowerCase());
        } catch {
          /* unreachable when originOf returned non-null */
        }
      }
    }
    for (const name of defenseSurface.cookies_set) {
      if (typeof name === 'string' && name.length > 0) set.add(name);
    }
    for (const script of defenseSurface.observed_scripts) {
      if (typeof script !== 'string' || script.length === 0) continue;
      set.add(script);
      try {
        const u = new URL(script);
        const filename = u.pathname.split('/').filter(Boolean).pop();
        if (filename) set.add(filename);
      } catch {
        /* not a URL — pass through as-is */
      }
    }
  }
  const intercepted = isReadonlyArray(session.intercepted) ? session.intercepted : [];
  for (const entry of intercepted) {
    if (typeof entry.url !== 'string' || entry.url.length === 0) continue;
    let parsed: URL;
    try {
      parsed = new URL(entry.url);
    } catch {
      continue;
    }
    set.add(parsed.host.toLowerCase());
    set.add(`${parsed.protocol}//${parsed.host.toLowerCase()}`);
    const ct = entry.contentType ?? '';
    if (/javascript|ecmascript/i.test(ct) || /\.m?js(\?|$)/.test(parsed.pathname)) {
      set.add(entry.url);
      const filename = parsed.pathname.split('/').filter(Boolean).pop();
      if (filename) set.add(filename);
    }
    if (isReadonlyArray(entry.setCookieNames)) {
      for (const name of entry.setCookieNames) {
        if (typeof name === 'string') set.add(name);
      }
    }
  }
  for (const nav of session.domNavigations ?? []) {
    if (typeof nav.url !== 'string' || nav.url.length === 0) continue;
    set.add(nav.url);
    const key = urlKey(nav.url);
    if (key) set.add(key);
  }
  return set;
}
