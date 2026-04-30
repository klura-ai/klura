// Observation check — "every URL in the saved strategy must have been seen in
// the discovery network log."
//
// This is the anti-hallucination guard that catches an entire class of save
// mistake the selector probe can't see: the agent reaches into training-data
// memory for an endpoint it "knows" exists (e.g. an `api.*` subdomain the
// developer docs talk about) instead of the one the web app actually called
// during the discovery flow. The selector probe fires those URLs too, but it
// runs with credentials:omit for cross-origin APIs — so private endpoints
// return 404 and the probe rejection drives the agent into "fix" mode where it
// often DEMOTES the prereq into a required caller arg, silently making warm
// execute impossible.
//
// The guard cross-references every non-template URL the saved strategy points
// at — endpoint, prerequisite URL — against the captured network log for the
// active discovery session. Anything whose normalized form doesn't appear in
// the observed traffic is "invented from training data" and the save is
// rejected with a specific pointer back to the observed requests.
//
// Matching is host + path (query-tolerant). A request observed at
// `host.example/graphql` matches an endpoint saved as `host.example/graphql`
// regardless of query strings; a saved `api.host.example/...` does NOT match a
// captured `host.example/...` because the hostnames differ.

import * as skills from './skills';
import type { InterceptedRequest } from '../drivers/types/network';
import type { WebSocketFrame } from '../drivers/types/websocket';
import { detectComplexEnvelope } from '../response/envelope-advisories';
import { joinBaseAndPath } from '../execution';
import { collectParamExamples, resolveTemplate } from './probe-helpers';
import { closestAllowedCandidates, formatCandidateList } from '../validators';

/**
 * Normalize a URL for observation matching: scheme + lowercased host + path.
 * Query string and fragment are stripped. Trailing slashes are removed so
 * `/foo` and `/foo/` match. Returns null if the URL can't be parsed.
 */
export function normalizeUrlForObservation(url: string): string | null {
  try {
    const u = new URL(url);
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    return `${u.protocol}//${u.hostname.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

/**
 * Returns the matching observed URL for `candidateUrl`, or null when no
 * observed URL covers it. Match means the normalized origin+path is
 * either equal, a path-prefix parent of, or a path-prefix child of, an
 * observed URL.
 *
 * - exact: candidate `/api/send` matches observed `/api/send`.
 * - parent-of-observed: candidate `/api` matches observed `/api/send`
 *   (the agent claimed a parent path; the observed child confirms it).
 * - child-of-observed: candidate `/api/send` matches observed `/`
 *   (the agent triaged the root; every same-origin path is a child).
 *
 * The returned string is the observed URL that matched (verbatim from
 * `observedUrls`), so callers can echo it back in error messages.
 *
 * The triage-time `request_pattern_url_observed` detector and the
 * save-time `unobservedUrlDetector` both use this primitive.
 */
export function findObservedMatch(
  candidateUrl: string,
  observedUrls: readonly string[],
): string | null {
  const candidateKey = normalizeUrlForObservation(candidateUrl);
  if (candidateKey === null) return null;
  for (const observed of observedUrls) {
    const observedKey = normalizeUrlForObservation(observed);
    if (observedKey === null) continue;
    if (observedKey === candidateKey) return observed;
    // Candidate is parent-of-observed (e.g. candidate `/api`, observed
    // `/api/send`).
    if (observedKey.startsWith(`${candidateKey}/`)) return observed;
    // Candidate is child-of-observed (e.g. candidate `/api/send`,
    // observed root `/`).
    if (observedKey.endsWith('/') && candidateKey.startsWith(observedKey)) {
      return observed;
    }
    if (candidateKey.startsWith(`${observedKey}/`)) return observed;
  }
  return null;
}

/**
 * Walk a strategy and collect every URL it points at for observation checking.
 * Returns `[{ where, url }]` tuples where `where` names the field so errors can
 * point the agent at the specific offending section.
 *
 * Templates are resolved via `notes.params[*].example` before extraction. If a
 * template reference has no example, `resolveTemplate` throws — which is fine,
 * that's a pre-existing error the caller surfaces.
 */
function collectStrategyUrls(data: Record<string, unknown>): Array<{ where: string; url: string }> {
  const examples = collectParamExamples(data);
  const out: Array<{ where: string; url: string }> = [];
  const tier = typeof data.strategy === 'string' ? data.strategy : '';

  // fetch / page-script: endpoint URL = baseUrl + endpoint. The endpoint field
  // may contain a leading "METHOD " prefix; strip it for the observation check
  // (method is orthogonal to URL matching).
  //
  // WebSocket-shaped strategies are skipped here — `endpoint` is not a valid
  // field on a ws strategy, and the websocket-shape validator will reject it
  // with the right message. Building a baseUrl+endpoint URL on a ws strategy
  // would fire the misleading "endpoint not in network log" error first
  // (because no http endpoint was observed for a ws-only flow), masking the
  // real schema problem. wsUrl observation is checked by verifyWsUrlObserved.
  const isWsShaped = data.protocol === 'websocket';
  if (!isWsShaped && (tier === 'fetch' || tier === 'page-script')) {
    const baseUrl = typeof data.baseUrl === 'string' ? data.baseUrl : '';
    const endpointRaw = typeof data.endpoint === 'string' ? data.endpoint : '';
    if (baseUrl && endpointRaw) {
      const endpointPath = endpointRaw.includes(' ')
        ? endpointRaw.split(' ').slice(1).join(' ')
        : endpointRaw;
      try {
        const resolvedPath = resolveTemplate(endpointPath, examples, `${tier}.endpoint`);
        out.push({ where: `${tier}.endpoint`, url: joinBaseAndPath(baseUrl, resolvedPath) });
      } catch {
        // Unresolvable templates are surfaced by the selector probe already;
        // skip here so the observation check only fires on complete URLs.
      }
    }
  }

  // Value-producing prerequisites (page-extract, fetch-extract, js-eval) all
  // point at real URLs that the agent should have observed in the discovery
  // flow. `cached` prereqs don't fetch anything and are skipped. `browser`
  // prereqs run a recorded step list, not a single URL — not checked here.
  // Applies to both `fetch` and `page-script` tiers (prereqs are orthogonal to
  // environment now).
  if ((tier === 'fetch' || tier === 'page-script') && Array.isArray(data.prerequisites)) {
    for (const raw of data.prerequisites) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const kind = p.kind;
      const name = typeof p.name === 'string' ? p.name : '?';
      if (kind !== 'page-extract' && kind !== 'fetch-extract' && kind !== 'js-eval') continue;
      if (typeof p.url !== 'string' || !p.url) continue;
      try {
        const resolved = resolveTemplate(p.url, examples, `prerequisite "${name}".url`);
        out.push({ where: `prerequisite "${name}" (${kind})`, url: resolved });
      } catch {
        /* unresolvable templates surfaced by the selector probe */
      }
    }
  }

  return out;
}

/**
 * WebSocket-observation counterpart to `verifyStrategyUrlsObserved`. When the
 * strategy declares `protocol:"websocket"`, cross-reference its `wsUrl` against
 * the URLs of frames captured in the session's wsFrames ring buffer during
 * discovery. Rejects strategies that point at WebSocket URLs the agent recalled
 * from training data instead of the live flow.
 *
 * Matching is prefix: `frame.url.startsWith(wsUrl)` — so the strategy's `wsUrl`
 * can be the URL sans query params / sid / cid and still match the captured
 * frames (those almost always carry an ephemeral session id in the query string
 * that we deliberately strip at save time).
 *
 * No-op when the strategy isn't ws-shaped, when no frames were captured, or
 * when the strategy's wsUrl still contains `{{placeholder}}` substitutions —
 * unresolvable templates get surfaced by validateStrategyShape already.
 */
export function verifyWsUrlObserved(
  data: Record<string, unknown>,
  wsFrames: ReadonlyArray<{ url: string; direction?: string; payload?: string }>,
): void {
  if (data.protocol !== 'websocket') return;
  if (wsFrames.length === 0) return;
  const wsUrl = data.wsUrl;
  if (typeof wsUrl !== 'string' || wsUrl.length === 0) return;
  if (wsUrl.includes('{{')) return;

  const matched = wsFrames.some((f) => typeof f.url === 'string' && f.url.startsWith(wsUrl));

  // Content grounding: even if the wsUrl was observed, verify it's the URL that
  // actually *carried* the content this strategy sends. Sites routinely open
  // multiple WebSockets (presence/gateway, chat, signaling) and the agent's
  // `window.__kluraSendEncoders[X].ws.url` probe can pick the wrong one. We
  // have the capture; check literal co-occurrence.
  //
  // Literals come from three sources:
  //   1. `notes.params[].example` — the caller-arg example values.
  //   2. Quoted path tokens in `frameFromPage.expression` like "/ls_req".
  //      These are protocol topics, not user data — stable ground truth.
  //   3. Quoted path tokens in `frame` / `generated.frame.code`.
  const literals = collectWsContentLiterals(data);
  if (literals.length > 0) {
    const sentFrames = wsFrames.filter((f) => f.direction === 'sent');
    // For each literal, find which url-prefixes carried it. If any literal was
    // observed but NONE of its carriers match wsUrl, that's the bug we just
    // hit: wsUrl points at a WebSocket that the content never rides.
    for (const literal of literals) {
      const carriers = new Set<string>();
      for (const f of sentFrames) {
        const p = typeof f.payload === 'string' ? f.payload : '';
        const u = typeof f.url === 'string' ? f.url.split('?')[0] : '';
        if (p.includes(literal) && u) carriers.add(u);
      }
      if (carriers.size === 0) continue; // literal never observed — can't judge
      const wsUrlHost = wsUrl.split('?')[0] ?? wsUrl;
      const hit = Array.from(carriers).some(
        (c) => c.startsWith(wsUrlHost) || wsUrlHost.startsWith(c),
      );
      if (!hit) {
        const sampleCarriers = Array.from(carriers).slice(0, 3);
        throw new Error(
          `invalid_strategy: wsUrl ${JSON.stringify(wsUrl)} does not match the WebSocket URL that actually ` +
            `carried the referenced content. Literal ${JSON.stringify(literal)} rode ${sentFrames.filter((f) => (f.payload || '').includes(literal)).length} sent frame(s), all on: ` +
            `${sampleCarriers.map((u) => JSON.stringify(u)).join(', ')}. ` +
            `Pick one of those as wsUrl (strip the '?query' portion). Sites commonly open several WebSockets; ` +
            `the encoder module's .ws.url may not be the one your payload actually travels on.`,
        );
      }
    }
    // Every literal that appeared in the capture appeared on a url matching
    // wsUrl — content grounded. No-op out regardless of the broader observation
    // check above.
    return;
  }

  if (matched) return;

  const sampleFrameUrls = Array.from(
    new Set(wsFrames.map((f) => f.url).filter((u): u is string => typeof u === 'string')),
  ).slice(0, 5);
  throw new Error(
    `invalid_strategy: wsUrl ${JSON.stringify(wsUrl)} was NOT observed in the discovery session's ` +
      `WebSocket frames (${wsFrames.length} frames captured across ${sampleFrameUrls.length} ` +
      `distinct URLs: ${sampleFrameUrls.join(', ')}). Pick a prefix that matches an actually-observed frame URL. ` +
      `If the real frame URL has a session id / cid in the query string, use the URL up to the '?'.`,
  );
}

/**
 * Extract content literals from a ws strategy for save-time grounding. Pulls: -
 * `notes.params[].example` (caller-arg examples) - Quoted path-like tokens from
 * `frameFromPage.expression` (topics like "/ls_req", "/v1/send") that identify
 * the protocol topic, not user data - Quoted tokens from `frame` /
 * `generated.frame.code` the same way
 *
 * Filters to strings ≥ 4 chars, no `{{placeholder}}`, and path-shaped (starts
 * with `/` and contains only URL-safe chars).
 */
function collectWsContentLiterals(data: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const params = (data.notes as { params?: Record<string, unknown> } | undefined)?.params;
  if (params && typeof params === 'object') {
    for (const entry of Object.values(params)) {
      if (entry && typeof entry === 'object') {
        const example = (entry as Record<string, unknown>).example;
        if (typeof example === 'string' && example.length >= 4 && !example.includes('{{')) {
          out.add(example);
        }
      }
    }
  }
  const extractPaths = (src: unknown): void => {
    if (typeof src !== 'string') return;
    // Match quoted path-like tokens: '/foo', "/foo/bar", '/v1/xyz'
    const re = /['"`](\/[a-zA-Z0-9_\-/]{3,64})['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const matched = m[1];
      if (matched) out.add(matched);
    }
  };
  const ffp = data.frameFromPage as { expression?: unknown } | undefined;
  if (ffp) extractPaths(ffp.expression);
  extractPaths(data.frame);
  const gen = data.generated as { frame?: { code?: unknown } } | undefined;
  if (gen?.frame) extractPaths(gen.frame.code);
  return Array.from(out);
}

/**
 * Verify every strategy URL was observed in the discovery network log. Throws
 * `invalid_strategy: ...` with a pointer to the specific field and the list of
 * captured hosts the agent CAN choose from.
 *
 * `observedUrls` is the list of raw URLs the runtime captured during the
 * discovery session. Callers extract this via
 * `driver.getInterceptedRequests(session)` before the save. If no observed URLs
 * are available (programmatic save without a session, e.g. tests), the check is
 * a no-op — this function is only a guard at discovery time.
 */
export interface UnobservedUrlIssue {
  where: string;
  url: string;
  message: string;
}

/**
 * Find every saved-strategy URL that wasn't observed in the discovery
 * session's network log. Returns 0+ issues. Empty when every URL was
 * observed (or when the network log is empty / no strategy URLs exist,
 * in which case the guard is a no-op).
 *
 * Used by the audit's `unobserved_url` Detector (`ackReason: 'none'`,
 * runtime/src/audit/save-strategy.ts) to reject saves with hallucinated
 * endpoints. Per principles.md §"Observe, not probe", the rejection is
 * runtime-enforced — no legitimate ack-through path.
 */
/**
 * Single representative URL the strategy will execute against. Used by the
 * save-time surface-triage gate to ask "is the surface this strategy
 * targets bound to a triage plan?" — without it the gate has nothing to
 * look up.
 *
 * - `fetch` / `page-script`: `baseUrl + endpoint` (templates resolved via
 *   `notes.params[*].example`; unresolved templates yield `null` rather
 *   than guessing).
 * - `recorded-path`: the URL of the first `navigate` step.
 *
 * Returns `null` when the strategy carries no observable URL — the gate
 * treats that as no-binding-needed (a recorded-path with zero navigates is
 * pure DOM interaction on whatever surface the agent was on, and the
 * audit's other checks cover the suspicious shape).
 */
export function firstObservableUrl(data: Record<string, unknown>): string | null {
  const tier = typeof data.strategy === 'string' ? data.strategy : '';
  if (tier === 'fetch' || tier === 'page-script') {
    const collected = collectStrategyUrls(data);
    const endpoint = collected.find((e) => e.where.endsWith('.endpoint'));
    return endpoint?.url ?? null;
  }
  if (tier === 'recorded-path' && Array.isArray(data.steps)) {
    for (const raw of data.steps) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Record<string, unknown>;
      if (s.action !== 'navigate') continue;
      let url = '';
      if (typeof s.url === 'string' && s.url) url = s.url;
      else if (typeof s.value === 'string') url = s.value;
      if (url) return url;
    }
  }
  return null;
}

export function findUnobservedStrategyUrls(
  data: Record<string, unknown>,
  observedUrls: readonly string[],
): UnobservedUrlIssue[] {
  const strategyUrls = collectStrategyUrls(data);
  if (strategyUrls.length === 0) return [];

  // Empty-observation gate: when the session captured zero URLs but the
  // strategy declares one or more, the agent is authoring from training
  // data rather than discovery. This is the "auth failed → captured nothing
  // → save anyway from memory" path that produced github strategies
  // pointing at api.github.com / Bearer {{token}} placeholders. Refuse
  // every declared URL with the same structural message — agent must
  // either drive the session to capture real traffic, or close as
  // tool_error.
  if (observedUrls.length === 0) {
    return strategyUrls.map((entry) => ({
      where: entry.where,
      url: entry.url,
      message:
        `${entry.where} points at ${entry.url}, but the session captured ZERO requests. ` +
        `Strategies must be authored from observed traffic, not training-data recall. ` +
        `Common causes: the session never authenticated successfully (auth wall, expired storage_state); ` +
        `the page crashed before any XHR fired; the agent skipped DRIVE entirely. ` +
        `Honest fixes: (a) re-drive the session until the real send fires and is captured in the network log; ` +
        `(b) close_session and classify as tool_error / auth_required so a future run can refresh storage_state; ` +
        `(c) if the capability genuinely needs no in-page traffic (e.g. saving a page-extract from static HTML), ` +
        `document why in notes.discovery before retrying. ` +
        `Do not save URLs from memory.`,
    }));
  }

  const observedNormalized = new Set<string>();
  for (const raw of observedUrls) {
    const n = normalizeUrlForObservation(raw);
    if (n) observedNormalized.add(n);
  }
  if (observedNormalized.size === 0) return [];

  const out: UnobservedUrlIssue[] = [];
  for (const entry of strategyUrls) {
    const n = normalizeUrlForObservation(entry.url);
    if (!n) continue;
    if (observedNormalized.has(n)) continue;

    const sampleHosts = Array.from(observedNormalized)
      .map((u) => {
        try {
          return new URL(u).hostname;
        } catch {
          return '';
        }
      })
      .filter((h) => h.length > 0)
      .slice(0, 10);
    const uniqueHosts = Array.from(new Set(sampleHosts));

    // Prime the agent with the actual observed URLs the closest to the rejected
    // one — usually the agent saved a hallucinated path (recalled from training
    // data) when a similar real path WAS observed. Listing the candidates inline
    // turns "you saved a URL we didn't see" into "you saved /search but the
    // observed paths nearby are /api/search and /searc". Same anti-canned
    // mechanism as `didYouMeanSuffix` for enum values; multi-candidate variant
    // because URL similarity often has several close matches worth showing.
    const candidates = closestAllowedCandidates(
      entry.url,
      Array.from(observedNormalized),
      (u) => u,
      { maxResults: 5 },
    );
    const candidateBlock = formatCandidateList(candidates, {
      header: `Closest observed URLs (${observedUrls.length} captured this session)`,
    });

    out.push({
      where: entry.where,
      url: entry.url,
      message:
        `${entry.where} points at ${entry.url}, which was NOT observed in the ` +
        `discovery network log (${observedUrls.length} requests captured, across ${uniqueHosts.length} ` +
        `distinct hosts: ${uniqueHosts.join(', ')}). You may have recalled this endpoint from training data ` +
        `instead of the real discovery flow. The honest fix is one of: ` +
        `(a) if the value is in the DOM, use a page-extract prereq against the selector you found via find_in_page; ` +
        `(b) if the value is in an observed network response, use fetch-extract against that captured URL; ` +
        `(c) if the value truly cannot be derived from the observed flow, use notes.params to require it as a ` +
        `caller arg and document WHERE the user is expected to get it. ` +
        `Do not invent endpoints you didn't see the web app actually call.${candidateBlock}`,
    });
  }
  return out;
}

/**
 * Recorded-path-over-binary-WS save guard. Re-runs the binary-WS detector over
 * the discovery session's captured wsFrames + HTTP entries using the caller-arg
 * literals derived from the strategy itself. When a binary-WS write envelope is
 * observed AND the strategy being saved is recorded-path AND the session
 * counter shows the agent never produced a verified try_generator iteration,
 * the save is rejected — the capability is liftable above T3 and recorded-path
 * is the wrong answer.
 *
 * Caller-arg literals are extracted from `notes.params[X].example` (which the
 * user types verbatim) and from `steps[i].value` (the values the recorded-path
 * executor types into the page). The detector anchors on those literals; if
 * none of them appear in any binary WS write, the guard is silent — covers the
 * case where the recorded-path strategy is genuinely DOM-only (e.g. accept a
 * cookie banner, click a button) with no inspectable network shape.
 *
 * Bypassed when the per-session try_generator counter shows verified_ok ≥ 1
 * (the agent at least tried) — they can land an honest draft without tripping
 * this guard. Also bypassed when the session was not threaded (no sessionId).
 */
export function verifyRecordedPathOverBinaryWs(
  data: Record<string, unknown>,
  httpEntries: ReadonlyArray<InterceptedRequest>,
  wsFrames: ReadonlyArray<WebSocketFrame>,
  sessionId: string | undefined,
): void {
  if (data.strategy !== 'recorded-path') return;
  if (!sessionId) return;
  if (wsFrames.length === 0) return;

  const literals = collectRecordedPathLiterals(data);
  if (literals.length === 0) return;

  // Read the per-session counter; if the agent achieved verified_ok ≥ 1 they at
  // least tried the iteration loop, so we don't second-guess their decision to
  // save recorded-path (likely they saved BOTH a fetch candidate and a
  // recorded-path fallback).
  const stats = skills.getTryGeneratorStatsForSession(sessionId);
  if (stats && stats.verified_ok >= 1) return;

  for (const literal of literals) {
    const indexedHttp = httpEntries.map((entry, i) => ({ entry, i }));
    const indexedWs = wsFrames.map((frame, i) => ({ frame, i }));
    const advisory = detectComplexEnvelope({
      httpEntries: indexedHttp,
      wsFrames: indexedWs,
      textContains: literal,
      tryGeneratorStats: stats ?? undefined,
    });
    if (advisory && advisory.kind === 'binary_ws_frame') {
      throw new Error(
        `invalid_strategy: recorded-path saved over a binary WebSocket frame at ws_i: ${advisory.ws_i} ` +
          `(evidence: ${JSON.stringify(advisory.evidence)}). The captured literal rode the frame; recorded-path ` +
          `does not carry the encoder. See klura://reference#reverse-engineer-playbook for the available tools.`,
      );
    }
  }
}

/** Pull caller-arg literals from a recorded-path strategy: every
 * `notes.params[X].example` and every `steps[i].value` that doesn't
 *  contain a `{{placeholder}}`. */
function collectRecordedPathLiterals(data: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const params = (data.notes as { params?: Record<string, unknown> } | undefined)?.params;
  if (params && typeof params === 'object') {
    for (const entry of Object.values(params)) {
      if (entry && typeof entry === 'object') {
        const example = (entry as Record<string, unknown>).example;
        if (typeof example === 'string' && example.length >= 4 && !example.includes('{{')) {
          out.add(example);
        }
      }
    }
  }
  const steps = data.steps;
  if (Array.isArray(steps)) {
    for (const s of steps) {
      if (s && typeof s === 'object') {
        const value = (s as Record<string, unknown>).value;
        if (typeof value === 'string' && value.length >= 4 && !value.includes('{{')) {
          out.add(value);
        }
      }
    }
  }
  return Array.from(out);
}
