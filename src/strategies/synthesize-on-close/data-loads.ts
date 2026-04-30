// Data-load candidate enumeration for the close_session review path. Separate
// concern from the synth pipeline: when a capability was declared without
// typed-literal args, the agent needs to explicitly pick the right endpoint
// from a ranked list of data-load XHRs.

import type { Session } from '../../drivers/types/session';
import type { InterceptedRequest } from '../../drivers/types/network';
import { classifyDataLoadXhr } from '../../response/data-load-classifier';
import { sliceLargeString } from '../../response/response-size';
import { stringifyOrEmpty } from './helpers';
import type { ParamObservation } from '../../response/session-observations';

/**
 * Candidate shape surfaced in the `close_session` review response. The agent
 * reads `body_preview` to identify which request carried the data it reported
 * to the user, picks, and calls save_strategy against the chosen URL.
 */
export interface DataLoadCandidate {
  /** Index into session.intercepted — the `i` handle the agent passes
   *  to `get_network_log({i, full: true})` to inspect the full entry. */
  i: number;
  method: string;
  url: string;
  status: number | null;
  body_bytes: number;
  /** Head slice of the stringified response body — enough to spot a
   *  substring the agent recognizes from what it just told the user.
   *  Full body available via `get_network_log({i, full: true})`. */
  body_preview: string;
  body_truncated?: boolean;
  body_preview_hint?: string;
  /** Classifier signals that fired on this request (list_shaped_body,
   *  name_affinity, etc). Diagnostic only; agent doesn't rank. */
  signals: string[];
  score: number;
  /** True when the captured request carried a Cookie header at capture
   *  time — warm replay needs a live page (page-script tier), not
   *  Node (fetch). Surfaced here so the agent knows which tier to save
   *  without having to re-inspect the headers. */
  needs_browser_session: boolean;
}

const BODY_PREVIEW_MAX = 400;

/**
 * Narrow the session's intercepted requests to a ranked candidate list of
 * data-load XHRs. Used by `close_session`'s review path: when a capability was
 * declared without typed-literal args, the agent needs to explicitly pick the
 * right endpoint. This function enumerates and ranks; it does NOT save.
 *
 * Dedupes by host+path so scroll-pagination or retry storms don't inflate the
 * list. Sorts by classifier score desc, ties broken by earliest-fired request
 * index (primary data loads fire before secondary-panel fetches).
 */
export function collectDataLoadCandidates(
  session: Session,
  capability: string,
  intercepted: InterceptedRequest[],
  limit = 10,
): DataLoadCandidate[] {
  const originHost = extractSessionOrigin(session);
  type Scored = {
    req: InterceptedRequest;
    i: number;
    score: number;
    signals: string[];
  };
  const raw: Scored[] = [];
  for (let i = 0; i < intercepted.length; i += 1) {
    const req = intercepted[i];
    if (!req) continue;
    const hit = classifyDataLoadXhr(req, capability, originHost);
    if (hit !== null) raw.push({ req, i, score: hit.score, signals: hit.signals });
  }
  if (raw.length === 0) return [];
  const byPath = new Map<string, Scored>();
  for (const c of raw) {
    let pathKey: string;
    try {
      const u = new URL(c.req.url);
      pathKey = `${u.host}${u.pathname}`;
    } catch {
      pathKey = c.req.url;
    }
    const prev = byPath.get(pathKey);
    if (!prev || c.score > prev.score) byPath.set(pathKey, c);
  }
  const deduped = Array.from(byPath.values());
  deduped.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i));
  return deduped.slice(0, limit).map(({ req, i, score, signals }) => {
    const headers = req.headers;
    let hasCookie = false;
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'cookie' && headers[k] && headers[k].length > 0) {
        hasCookie = true;
        break;
      }
    }
    const bodyStr = stringifyOrEmpty(req.responseBody);
    const sliced = sliceLargeString(bodyStr, {
      length: BODY_PREVIEW_MAX,
      defaultMaxLength: BODY_PREVIEW_MAX,
      hintFetchNext: () =>
        `Full body available via get_network_log({i: ${i}, full: true, body_offset: ${BODY_PREVIEW_MAX}}).`,
    });
    return {
      i,
      method: req.method,
      url: req.url,
      status: req.status,
      body_bytes: sliced.total_chars,
      body_preview: sliced.slice,
      ...(sliced.truncated ? { body_truncated: true } : {}),
      ...(sliced.hint ? { body_preview_hint: sliced.hint } : {}),
      signals,
      score,
      needs_browser_session: hasCookie,
    };
  });
}

/**
 * Captured response that enumerates values used as URL-param values on
 * other captures. The structural signal: the agent clicked tiles and
 * observed `(urlParam, value, label)` triples, AND an earlier capture
 * served a response whose body contains all those `value` strings — that
 * earlier capture IS the listing endpoint for this enum. Surfaced
 * alongside `candidate_xhrs` in the close_session handoff so the agent
 * sees the listing while planning lifts and naturally factors it as a
 * sibling capability with `notes.params.<X>.source: "capability:list_<entity>"`
 * (which the runtime resolves at execute time per execution.ts'
 * `validateEnumArgsAgainstSourceCapability`).
 */
export interface ListingCandidate {
  /** Index into session.intercepted — the captured listing request. */
  i: number;
  method: string;
  url: string;
  status: number | null;
  /** Sample of the enumerated values found in the response body. */
  enumerated_values: string[];
  /** Where these values later showed up as a URL-param value, proving the
   *  listing-then-pick relationship. */
  used_as: {
    url_param: string;
    appears_in_request_i: number;
    appears_in_request_url: string;
  };
}

const LISTING_VALUE_LIMIT = 20;

/**
 * Find captured responses that enumerate values used as URL-param values on
 * other captures. Walks every observation under `observedParamValues`, finds
 * the captured request whose response contains every observed value (the
 * "listing"), and surfaces it as a candidate alongside the click-firing
 * request that consumed one of those values.
 *
 * Structural — no fuzzy matching. The signal is "all observed values for
 * URL param X appear verbatim in capture #N's response body, and capture
 * #M used X={value-from-observation} in its URL." That pair (#N, #M) IS
 * the listing-then-pick pattern.
 */
export function collectListingCandidates(
  intercepted: InterceptedRequest[],
  observedParamValues: Record<string, ParamObservation[]>,
  limit = 5,
): ListingCandidate[] {
  // Group observed click-time values per URL param.
  const obsByParam = new Map<string, Set<string>>();
  for (const [paramName, obsList] of Object.entries(observedParamValues)) {
    const values = new Set<string>();
    for (const o of obsList) {
      if (o.source.kind !== 'ui_click') continue;
      if (typeof o.value === 'string' && o.value.length > 0) values.add(o.value);
    }
    if (values.size > 0) obsByParam.set(paramName, values);
  }
  if (obsByParam.size === 0) return [];

  const out: ListingCandidate[] = [];
  const claimed = new Set<number>();
  for (let i = 0; i < intercepted.length; i += 1) {
    const req = intercepted[i];
    if (req === undefined || req.responseBody === undefined || req.responseBody === null) continue;
    let bodyStr: string;
    if (typeof req.responseBody === 'string') {
      bodyStr = req.responseBody;
    } else if (typeof req.responseBody === 'object') {
      try {
        bodyStr = JSON.stringify(req.responseBody);
      } catch {
        continue;
      }
    } else {
      continue;
    }
    for (const [urlParam, values] of obsByParam) {
      // ALL observed values must appear verbatim. Substring match on the
      // serialized body is structurally sufficient: a listing that
      // enumerates these values has them all; an unrelated request won't.
      // Quote-wrapped check (`"value"`) avoids partial-substring false
      // positives (`"italian"` vs `"italianate"`).
      const allPresent = [...values].every(
        (v) => bodyStr.includes(`"${v}"`) || bodyStr.includes(JSON.stringify(v)),
      );
      if (!allPresent) continue;
      // Confirm a different captured request used this URL param with one
      // of these values — that proves it's a listing-then-pick pair, not
      // just a coincidental string match.
      const usingIdx = intercepted.findIndex((r, idx) => {
        if (idx === i) return false;
        try {
          const u = new URL(r.url);
          const got = u.searchParams.get(urlParam);
          return typeof got === 'string' && values.has(got);
        } catch {
          return false;
        }
      });
      if (usingIdx === -1) continue;
      if (claimed.has(i)) continue;
      claimed.add(i);
      const usingReq = intercepted[usingIdx];
      if (usingReq === undefined) continue;
      out.push({
        i,
        method: req.method,
        url: req.url,
        status: req.status,
        enumerated_values: [...values].slice(0, LISTING_VALUE_LIMIT),
        used_as: {
          url_param: urlParam,
          appears_in_request_i: usingIdx,
          appears_in_request_url: usingReq.url,
        },
      });
      if (out.length >= limit) return out;
      break;
    }
  }
  return out;
}

/**
 * Best-effort session-origin host. Prefers the first URL the driver tracked via
 * `driver.navigate` (set on session creation); falls back to the first captured
 * request. Returns null if nothing is known — the classifier then skips the
 * same-origin gate, which is safe because the other gates (list-shape JSON,
 * non-trivial size) still filter the candidate set.
 */
function extractSessionOrigin(session: Session): string | null {
  const visited = session.visitedUrls ?? [];
  for (const u of visited) {
    try {
      return new URL(u).host;
    } catch {
      continue;
    }
  }
  for (const r of session.intercepted) {
    if (typeof r.url === 'string') {
      try {
        return new URL(r.url).host;
      } catch {
        continue;
      }
    }
  }
  return null;
}
