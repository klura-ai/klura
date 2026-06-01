// Lookup-segment detection + lookup-as-capability enforcement. Split out of
// save-audit.ts to keep that file under the max-lines cap; this is the cohesive
// "is this capability a lookup, and is its lookup endpoint inlined when it
// should be a sibling capability?" cluster.

import type { Strategy } from '../strategies/skills';

// Segments in a capability slug that imply a lookup step. Not a
// heuristic-gated reject — just a signal the runtime surfaces for the
// agent to respond to.
const LOOKUP_SEGMENT_REGEX = /(?:^|_)(by_[a-z]+|for_[a-z]+|lookup_[a-z]+)/g;

export function findLookupSegments(capability: string): string[] {
  const matches: string[] = [];
  for (const m of capability.matchAll(LOOKUP_SEGMENT_REGEX)) {
    if (m[1]) matches.push(m[1]);
  }
  return matches;
}

/** Canonicalize a URL to origin+pathname (ignoring query + fragment) so a
 *  prereq URL with a `{{placeholder}}` in the query matches a captured
 *  URL that had a concrete value there. Returns null when the string is
 *  not a valid URL (e.g. a template-only path). */
function canonicalizeUrlPath(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/** Extract URL-like strings from a prereq. Covers fetch-extract's `url`,
 *  page-extract's `url`, and js-eval `expression` strings that contain
 *  `fetch('...')` / `XMLHttpRequest` / `sendBeacon` calls. */
function extractPrereqUrlCandidates(prereq: Record<string, unknown>): string[] {
  const out: string[] = [];
  // A js-eval prereq's `url` is the page/eval context, NOT a network call —
  // a pure-transform expression (e.g. `args.x.toLowerCase()`) is not a lookup
  // even when its page-context url coincides with a captured path. Only a real
  // fetch()/XHR inside the expression makes a js-eval prereq a lookup. For
  // fetch-extract / page-extract, `url` IS the lookup endpoint.
  if (prereq.kind !== 'js-eval' && typeof prereq.url === 'string' && prereq.url.length > 0) {
    out.push(prereq.url);
  }
  const expression = prereq.expression;
  if (typeof expression === 'string') {
    const fetchRe = /\b(?:fetch|XMLHttpRequest|sendBeacon)\s*\(\s*(['"`])([^'"`]+)\1/g;
    let m: RegExpExecArray | null;
    while ((m = fetchRe.exec(expression)) !== null) {
      if (m[2]) out.push(m[2]);
    }
  }
  return out;
}

/**
 * Enforce lookup-as-capability for write strategies whose slug implies a
 * lookup. When the capability slug contains a `_by_<x>` / `_for_<x>` /
 * `lookup_<x>` segment AND a prereq hits an endpoint that was actually
 * observed in session traffic, that prereq MUST be routed as
 * `{kind: "capability"}` pointing at a separately-saved sibling — never
 * inlined as fetch-extract / js-eval / page-extract. Rationale: lookups
 * that are real HTTP endpoints are capabilities in their own right;
 * inlining them defeats reuse and hides a save worth tracking. Prereqs
 * that run purely against page state (page-extract / js-eval with no
 * fetch URL) do not trip this check — they're genuinely page-local.
 */
export function validateLookupPrereqsAreCapabilities(
  capability: string,
  data: Strategy,
  capturedEndpointPaths: Set<string>,
): string[] {
  if (findLookupSegments(capability).length === 0) return [];
  if (capturedEndpointPaths.size === 0) return [];
  const prereqs = (data as Record<string, unknown>).prerequisites;
  if (!Array.isArray(prereqs)) return [];
  const issues: string[] = [];
  prereqs.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    const p = raw as Record<string, unknown>;
    const kind = typeof p.kind === 'string' ? p.kind : '';
    if (kind === 'capability' || kind === 'tag') return; // already routed correctly
    const urlCandidates = extractPrereqUrlCandidates(p);
    for (const url of urlCandidates) {
      const canon = canonicalizeUrlPath(url);
      if (canon === null) continue;
      if (!capturedEndpointPaths.has(canon)) continue;
      const lookupName = typeof p.name === 'string' && p.name.length > 0 ? p.name : 'lookup';
      issues.push(
        `prerequisites[${idx}] (kind:"${kind}") hits ${canon} which was observed in session traffic — capability "${capability}" has a lookup-implying slug (_by_/_for_/_lookup_) and its lookup endpoints must be saved as their own sibling capability first, then chained via {kind: "capability", capability: "<saved-slug>", args: {...}, vars: {<name>: "<dot.path>"}}. Split: (1) save_strategy("${lookupName}", ...) with the fetch against ${canon}; (2) save_strategy("${capability}", ...) with a capability prereq pointing at it. Inline fetch-extract / js-eval / page-extract for endpoints that exist on their own is rejected.`,
      );
      break; // one issue per prereq is enough
    }
  });
  return issues;
}
