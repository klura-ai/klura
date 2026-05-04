// Classify a captured HTTP request by its "the-page's-data-load" shape — the
// XHR a page fires at load to populate a list/feed/grid. Used by the no-args
// branch of synth_fetch at end_drive: when a capability was declared
// without typed-literal args (a read-only capability like "get popular videos"
// or "list latest posts"), there's no literal to anchor on. We fall back to
// picking the request that LOOKS like the page's data load, and save a static
// fetch against it so the next warm run doesn't have to re-discover the
// endpoint.
//
// ---- Architectural exception note ----
//
// The "delegate to the LLM" principle (see `runtime/docs/principles.md`) says
// the runtime should not pattern-match on specific protocol/site shapes — the
// LLM decides, the runtime just exposes primitives. This classifier breaks that
// rule in the same shape as `lookup-classifier.ts` and
// `envelope-advisories.ts`: a bounded set of structural heuristics that turn
// raw captured traffic into a RANKED CANDIDATE so the agent doesn't have to
// scan 200 requests by hand at the moment end_drive fires.
//
// The exception is bounded on purpose: - The classifier outputs CANDIDATES, not
// judgments. The saved strategy is the best current understanding from the
// capture; the working-dir logbook accumulates additional captures so the next
// session's agent can refine it (add response.extract, rename args, re-save). -
// Signals are structural (JSON body shape, same-origin, list-shape, token
// intersection with capability name). Never brand-specific URL regexes. -
// Simple sites that POST JSON from a <form> (no XHR data-load at all) match
// zero candidates — the accumulator is empty; no harm done. - The caller guards
// against ambiguity: if the top candidate doesn't beat the runner-up by a
// margin, nothing is saved.
//
// If you find yourself adding a classifier branch for a specific site's URL
// pattern, stop: that's the class of code the principles doc forbids
// (`runtime/docs/principles.md`). Keep signals structural and narrow.
//
// ---- Shape ----
//
// Pure: input is one `InterceptedRequest` + context (capability name, session
// origin host), output is `{score, signals}` or null. No session state, no side
// effects. Tested in isolation against fixtures.

import type { InterceptedRequest } from '../drivers/types/network';

interface DataLoadCandidate {
  /** Soft-signal score. Higher = more confident. Start gates must all
   *  pass before scoring — failing a gate returns null, not score 0. */
  score: number;
  /** Human-readable list of signals that fired. Consumed by the
   *  end-drive candidate ranker (data-load-classifier results feed
   *  `candidate_xhrs[].signals`); not stored on the strategy itself. */
  signals: string[];
}

const MIN_BODY_BYTES = 500;
const LIST_SHAPE_MAX_DEPTH = 2;

/**
 * Classify a single intercepted request. Returns a scored candidate if the
 * request matches the "page's data-load XHR" shape, or null if it doesn't.
 *
 * `originHost` is the host portion of the session's entry URL (what
 * `start_session` navigated to). Third-party XHRs — analytics pings, CDN asset
 * fetches, ad beacons — never qualify because the strategy we'd save has to run
 * against the same origin at warm time anyway.
 *
 * `capabilityName` is the declared capability (e.g. "list_user_videos"); tokens
 * from it participate in a soft name-affinity signal against the URL path
 * segments. Empty string = no name-affinity boost.
 */
export function classifyDataLoadXhr(
  req: InterceptedRequest,
  capabilityName: string,
  originHost: string | null,
): DataLoadCandidate | null {
  // Gate 1: well-formed URL + 2xx status.
  if (typeof req.url !== 'string' || req.url.length === 0) return null;
  if (typeof req.status !== 'number' || req.status < 200 || req.status >= 300) return null;

  // Gate 2: skip full-page navigations and 3xx redirects. Those are never the
  // data-load XHR; they're the surrounding page load.
  if (req.isNavigation === true) return null;
  if (typeof req.redirectUrl === 'string' && req.redirectUrl.length > 0) return null;

  // Gate 3: same-origin as the session's entry URL. A strategy saved against a
  // third-party host can't reuse the session cookies anyway.
  let reqHost: string;
  let pathSegments: string[];
  try {
    const u = new URL(req.url);
    reqHost = u.host;
    pathSegments = u.pathname.split('/').filter((s) => s.length > 0);
  } catch {
    return null;
  }
  if (originHost && reqHost !== originHost) return null;

  // Gate 4: JSON response. Either by content-type header or by the responseBody
  // shape (string that parses as JSON, or already-parsed object/array).
  const ct = findHeader(req.headers, 'content-type');
  const ctIsJson = ct !== null && /\bapplication\/json\b/i.test(ct);
  let parsed: unknown = undefined;
  if (typeof req.responseBody === 'string') {
    const trimmed = req.responseBody.trim();
    if (trimmed.length === 0) return null;
    // Require at least a plausible JSON open char so we don't pay JSON.parse
    // cost on HTML/binary bodies.
    const firstCh = trimmed[0];
    if (firstCh === '{' || firstCh === '[') {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Not valid JSON — if the content-type claimed JSON, reject (broken
        // server); otherwise let the gate fail below.
        if (ctIsJson) return null;
      }
    }
  } else if (typeof req.responseBody === 'object' && req.responseBody !== null) {
    parsed = req.responseBody;
  }
  if (parsed === undefined) return null;
  if (!ctIsJson && !(Array.isArray(parsed) || (typeof parsed === 'object' && parsed !== null))) {
    return null;
  }

  // Soft signals.
  const signals: string[] = [];
  let score = 0;

  // List-shaped body: top-level array, OR object containing an array within
  // LIST_SHAPE_MAX_DEPTH. Reads overwhelmingly return collections.
  if (isListShaped(parsed, LIST_SHAPE_MAX_DEPTH)) {
    score += 3;
    signals.push('list_shaped_body');
  }

  // Body size filter — strips ping / tiny-config responses. Simple binary
  // signal; the runtime's role is to NARROW the 168 captured requests to ~10
  // interesting ones, not to pick the winner. The LLM picks; scoring just needs
  // to group plausible candidates.
  const bodyLen =
    typeof req.responseBody === 'string'
      ? req.responseBody.length
      : JSON.stringify(req.responseBody).length;
  if (bodyLen >= MIN_BODY_BYTES) {
    score += 1;
    signals.push('body_gte_500_bytes');
  }

  // GET bonus. POSTs qualify (GraphQL, Facebook-style POST-for-reads), but GETs
  // are more often the clean data-load primitive.
  if (req.method.toUpperCase() === 'GET') {
    score += 1;
    signals.push('method_get');
  }

  // Name affinity: tokenize capability name by `_` / `-`, intersect with URL
  // path segments. Each match +2, capped at +4 (two distinct tokens).
  // "list_user_videos" finds "/api/user/videos" strongly.
  const capTokens = capabilityName
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter((t) => t.length >= 3)
    .filter((t) => !COMMON_CAPABILITY_NOISE_TOKENS.has(t));
  const segLower = pathSegments.map((s) => s.toLowerCase());
  let affinityMatches = 0;
  for (const t of capTokens) {
    // Exact segment match OR segment contains token as a substring (handles
    // "/api/userVideos" → match for "videos").
    if (segLower.some((s) => s === t || s.includes(t))) {
      affinityMatches += 1;
    }
  }
  if (affinityMatches > 0) {
    const bonus = Math.min(affinityMatches, 2) * 2;
    score += bonus;
    signals.push(`name_affinity:${affinityMatches}`);
  }

  return { score, signals };
}

const COMMON_CAPABILITY_NOISE_TOKENS = new Set([
  'get',
  'list',
  'fetch',
  'load',
  'find',
  'search',
  'by',
  'for',
  'the',
  'all',
  'any',
]);

function findHeader(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function isListShaped(value: unknown, maxDepth: number): boolean {
  if (Array.isArray(value)) return value.length >= 1;
  if (maxDepth <= 0) return false;
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (isListShaped(v, maxDepth - 1)) return true;
    }
  }
  return false;
}
