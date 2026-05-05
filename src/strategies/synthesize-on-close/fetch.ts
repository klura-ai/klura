// Fetch / page-script synthesis: joins typed literals to captured traffic via
// findLiteralInSessionCaptures and stamps a templated request strategy when
// the literal lands verbatim in an HTTP body or URL. Tier choice (fetch vs
// page-script) is decided from the captured Cookie header — ground truth, not
// heuristic.

import * as skills from '../skills';
import { assignAutoStepIds } from '../auto-step-id';
import type { Session } from '../../drivers/types/session';
import type { InterceptedRequest } from '../../drivers/types/network';
import {
  findLastIndex,
  parseBodyForStrategy,
  pickDiscoveredFromUrl,
  stringifyIfPresent,
} from './helpers';
import {
  attachSaveWarningsToStrategy,
  detectTypedTextDrift,
  findLiteralInSessionCaptures,
  type LiteralMatch,
} from './literals';
import { detectParameterizationDisclosureRequired } from '../../gate/save-warnings-parameterization';
import { buildStepsFromHistory } from './recorded-path';
import type { AutoSynthResult, SaveMarker, SynthDiagnosticEntry } from './types';
import { templateRequestFromVEs, type EvaluatedVE } from './verified-expressions';

type ScanResult = {
  paramName: string;
  literal: string;
  matches: LiteralMatch[];
};

type CandidateMatch = {
  request: InterceptedRequest;
  requestIdx: number;
  paramName: string;
  literal: string;
  matchLocation: 'post_data' | 'url';
};

function collectCandidateMatches(
  session: Session,
  scans: ScanResult[],
): {
  matches: CandidateMatch[];
  sawWsSent: boolean;
  sawVisitedUrl: boolean;
} {
  const matches: CandidateMatch[] = [];
  let sawWsSent = false;
  let sawVisitedUrl = false;

  for (const s of scans) {
    if (s.matches.length === 0) continue;
    if (s.matches.some((m) => m.source === 'ws_frame_sent')) sawWsSent = true;
    if (s.matches.some((m) => m.source === 'visited_url')) sawVisitedUrl = true;

    const httpMatches = s.matches.filter(
      (m) => m.source === 'http_request_body' || m.source === 'http_url',
    );
    for (const m of httpMatches) {
      const req = session.intercepted[m.source_index];
      if (!req) continue;
      matches.push({
        request: req,
        requestIdx: m.source_index,
        paramName: s.paramName,
        literal: s.literal,
        matchLocation: m.source === 'http_request_body' ? 'post_data' : 'url',
      });
    }
  }

  return { matches, sawWsSent, sawVisitedUrl };
}

function countDistinctHostPaths(matches: CandidateMatch[]): number {
  const distinctHostPaths = new Set<string>();
  for (const m of matches) {
    try {
      const u = new URL(m.request.url);
      distinctHostPaths.add(`${u.host}${u.pathname}`);
    } catch {
      distinctHostPaths.add(m.request.url);
    }
  }
  return distinctHostPaths.size;
}

function shouldSkipNoisyLiteralMatches(
  matches: CandidateMatch[],
  save: SaveMarker,
  diag: SynthDiagnosticEntry[],
): boolean {
  const distinctHostPaths = countDistinctHostPaths(matches);
  if (matches.length <= 20 || distinctHostPaths < 3) return false;

  diag.push({
    pass: 'synth_fetch',
    capability: save.capability,
    phase: 'skip',
    outcome: 'generic_literal_too_noisy',
    detail: {
      match_count: matches.length,
      distinct_host_paths: distinctHostPaths,
      advice:
        'Typed literal matches too many captures across too many endpoints — likely a generic string (brand, domain, locale). Auto-save skipped; agent should pick the right endpoint via end-drive review (capture_candidates list).',
    },
  });
  return true;
}

function firstScanPointer(
  scans: ScanResult[],
  source: LiteralMatch['source'],
): { paramName: string; m: LiteralMatch } | undefined {
  return scans
    .flatMap((s) => s.matches.map((m) => ({ paramName: s.paramName, m })))
    .find(({ m }) => m.source === source);
}

function pushNoHttpMatchDiagnostic(
  save: SaveMarker,
  scans: ScanResult[],
  sawWsSent: boolean,
  sawVisitedUrl: boolean,
  diag: SynthDiagnosticEntry[],
): void {
  if (sawWsSent) {
    const wsHit = firstScanPointer(scans, 'ws_frame_sent');
    diag.push({
      pass: 'synth_fetch',
      capability: save.capability,
      phase: 'skip',
      outcome: 'literal_in_ws_frame_only',
      detail: {
        ws_i: wsHit?.m.source_index,
        offset: wsHit?.m.offset,
        paramName: wsHit?.paramName,
        advice:
          'Literal is carried inside a binary WebSocket frame. Auto-save skipped (would need iteration). Use inspect_ws_frame + try_generator to lift; the discovery artifact preserves pointers for the next run.',
      },
    });
    return;
  }

  if (sawVisitedUrl) {
    const visitedHit = firstScanPointer(scans, 'visited_url');
    diag.push({
      pass: 'synth_fetch',
      capability: save.capability,
      phase: 'skip',
      outcome: 'literal_in_visited_url_only',
      detail: {
        visited_url_i: visitedHit?.m.source_index,
        offset: visitedHit?.m.offset,
        paramName: visitedHit?.paramName,
        advice:
          'Literal appeared only in a top-level document URL — the SSR HTML signal: the page loads by navigating to an arg-templated URL and the data likely lives in the initial document response. The IDEAL save is `fetch` with `{baseUrl, endpoint: "/{{argName}}/...", response: {format: "html", extract: {...}}}` — one HTTP call, ~100ms warm, no browser. synth_recorded will still land a navigation-only recorded-path as a fallback, but prefer saving the fetch+html-extract explicitly via save_strategy before end_drive. See klura://reference#fetch-schema.',
      },
    });
    return;
  }

  diag.push({
    pass: 'synth_fetch',
    capability: save.capability,
    phase: 'skip',
    outcome: 'no_literal_match_in_captures',
    detail: {
      advice:
        'Typed literal never appeared verbatim in any captured byte. Could be binary-framed, encrypted, or base64/hex-encoded. No auto-save possible; agent needs to reverse-engineer.',
    },
  });
}

/**
 * Auto-derive a `fetch` or `page-script` strategy per declared capability by
 * joining typed literals to captured traffic via the generic
 * `findLiteralInSessionCaptures` primitive. Strictly ground-truth: we save only
 * when the literal appears verbatim in an HTTP request body or URL. WS-only
 * matches emit a diagnostic and skip — the agent's job is to lift the binary
 * envelope via `inspect_ws_frame` + `try_generator`. No heuristic tries to
 * decode, base64-unpack, or guess; the primitive reports what it found and the
 * agent picks up from there.
 */
// Sync internally; kept with `async` at the call-site wrapper so end-drive
// can await it uniformly alongside actually-async passes.
// eslint-disable-next-line sonarjs/cognitive-complexity
export function synthesizeFetchFromCaptures(
  session: Session,
  platform: string,
  saves: SaveMarker[],
  diag: SynthDiagnosticEntry[],
  evaluatedByCapability?: Map<string, EvaluatedVE[]>,
): AutoSynthResult[] {
  const out: AutoSynthResult[] = [];
  const history = session.performActionHistory ?? [];
  const intercepted = session.intercepted;

  if (history.length === 0) {
    diag.push({ pass: 'synth_fetch', phase: 'skip', outcome: 'no_perform_action_history' });
    return out;
  }

  for (let i = 0; i < saves.length; i += 1) {
    const save = saves[i];
    if (!save) continue;

    // Skip if a fetch/page-script already exists for this capability — explicit
    // save wins.
    const existing = skills.loadStrategies(platform, save.capability);
    if (existing.some((s) => s.strategy === 'fetch' || s.strategy === 'page-script')) {
      diag.push({
        pass: 'synth_fetch',
        capability: save.capability,
        phase: 'skip',
        outcome: 'existing_fetch_strategy',
      });
      continue;
    }
    if (!save.args || Object.keys(save.args).length === 0) {
      // Read-only path: no typed literal to anchor on. Auto-save is
      // deliberately NOT attempted here — the runtime cannot tell which of
      // multiple list-shaped JSON responses is the one the agent actually
      // extracted data from. The LLM knows (it read the response body and
      // reported its content to the user); the runtime doesn't.
      //
      // `end_drive` surfaces a ranked candidate list via the review path
      // (see `computeCloseNag` in index.ts). The agent reviews candidate URLs +
      // body previews, picks the one carrying the data it reported, and calls
      // save_strategy explicitly. Second close tears down normally.
      diag.push({
        pass: 'synth_fetch',
        capability: save.capability,
        phase: 'skip',
        outcome: 'no_declared_args_review_required',
        detail: { intercepted_count: intercepted.length },
      });
      continue;
    }

    // Generic literal scan across ALL captured bytes (HTTP + WS). One
    // primitive, one shape — no per-source-type branches. For each arg value
    // the agent typed, find every place that value appears.
    const scans: ScanResult[] = [];
    for (const [paramName, paramValue] of Object.entries(save.args)) {
      if (typeof paramValue !== 'string' || paramValue.length === 0) continue;
      const matches = findLiteralInSessionCaptures(session, paramValue);
      scans.push({ paramName, literal: paramValue, matches });
    }
    diag.push({
      pass: 'synth_fetch',
      capability: save.capability,
      phase: 'start',
      outcome: 'scan_complete',
      detail: {
        intercepted_count: intercepted.length,
        ws_frames_count: (session.wsFrames ?? []).length,
        scans: scans.map((s) => ({
          paramName: s.paramName,
          literal_len: s.literal.length,
          match_count: s.matches.length,
          match_sources: s.matches.map((m) => m.source),
        })),
      },
    });

    // Filter scans to HTTP-body / URL matches — those we can template. WS
    // matches land in the diagnostic for the agent to pick up.
    const { matches, sawWsSent, sawVisitedUrl } = collectCandidateMatches(session, scans);

    // Generic-literal guard: when a typed-arg value is a common string (brand
    // name, domain, "en-US", a 3-letter word) it appears in dozens of captured
    // requests — hosts, headers, tracking params, analytics beacons — and the
    // "most-recent match wins" rule picks noise. If the literal matches > 20
    // HTTP entries across ≥ 3 distinct host+path combos, skip the auto-save;
    // the runtime has no reliable anchor. The end-drive refusal will
    // surface the data-load classifier's candidates instead, and the agent
    // picks from body_preview.
    if (shouldSkipNoisyLiteralMatches(matches, save, diag)) continue;

    if (matches.length === 0) {
      pushNoHttpMatchDiagnostic(save, scans, sawWsSent, sawVisitedUrl, diag);
      continue;
    }

    // Pick the most-recent match (highest request index). That's the one
    // temporally closest to "the agent hit send."
    matches.sort((a, b) => b.requestIdx - a.requestIdx);
    const best = matches[0];
    if (!best) continue;

    // Template the body AND the endpoint: replace every declared arg's literal
    // with `{{<paramName>}}`. For POST writes the arg usually lands in the
    // body; for GET reads the arg usually lands in the URL query string.
    // Template both symmetrically so read/write capabilities are treated the
    // same way by the with-args path.
    const req = best.request;
    const postDataStr = stringifyIfPresent(req.postData);
    let templatedBody = postDataStr;
    const paramsDoc: Record<string, { description: string; kind: string; example: string }> = {};
    for (const [paramName, paramValue] of Object.entries(save.args)) {
      if (typeof paramValue !== 'string' || paramValue.length === 0) continue;
      let bodyMatch = false;
      if (templatedBody && templatedBody.includes(paramValue)) {
        templatedBody = templatedBody.split(paramValue).join(`{{${paramName}}}`);
        bodyMatch = true;
      }
      // URL match is handled via the endpoint templating block below (needs
      // baseUrl/endpoint parsed first). Stub the paramsDoc entry here so both
      // kinds of match surface uniform notes.params.
      if (bodyMatch || (typeof req.url === 'string' && req.url.includes(paramValue))) {
        paramsDoc[paramName] = {
          description: `User-supplied value typed by the agent during discovery.`,
          kind: 'text',
          example: paramValue,
        };
      }
    }

    // Tier decision: if the captured request had a Cookie header the browser
    // context supplied, this is a page-script (the request rode page cookies).
    // Without Cookie header, fetch is safe. Check the captured headers directly
    // — this is ground truth, not a heuristic.
    const headers = req.headers;
    const lowerKeys: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lowerKeys[k.toLowerCase()] = v;
    const hasCookie = lowerKeys['cookie'] && lowerKeys['cookie'].length > 0;
    const strategyTier = hasCookie ? 'page-script' : 'fetch';

    // Build baseUrl + endpoint from the captured URL.
    let baseUrl: string;
    let endpoint: string;
    try {
      const u = new URL(req.url);
      baseUrl = `${u.protocol}//${u.host}`;
      endpoint = `${u.pathname}${u.search}`;
    } catch {
      // Couldn't parse URL — skip auto-save for this capability.
      continue;
    }

    // Template the endpoint (path + query) for arg literals that landed in the
    // URL. Symmetric with the body templating above — this is what makes read
    // capabilities like `get_videos({user: "alice"})` discovered against `GET
    // /api/videos?u=alice` save as `GET /api/videos?u={{user}}` instead of a
    // site-hardcoded URL.
    for (const [paramName, paramValue] of Object.entries(save.args)) {
      if (typeof paramValue !== 'string' || paramValue.length === 0) continue;
      if (endpoint.includes(paramValue)) {
        endpoint = endpoint.split(paramValue).join(`{{${paramName}}}`);
      }
    }

    // Body resolution: validator + executor's `resolveBody` both require a
    // plain-object `body`. JSON object captures parse straight through;
    // form-urlencoded captures convert via URLSearchParams with
    // `contentType:'form'` so the executor serializes correctly. Anything
    // else (binary, plaintext, JSON arrays/scalars, or templates that
    // landed in non-string JSON positions and broke the JSON shape) is
    // unparseable — skip auto-save with a diagnostic so the agent can lift
    // manually, rather than emit a strategy the validator will reject.
    let bodyField: Record<string, unknown> | undefined;
    let bodyContentType: 'form' | undefined;
    if (templatedBody !== undefined && templatedBody.length > 0) {
      const parsed = parseBodyForStrategy(templatedBody, lowerKeys['content-type'] ?? '');
      if (parsed.kind === 'json') {
        bodyField = parsed.obj;
      } else if (parsed.kind === 'form') {
        bodyField = parsed.obj;
        bodyContentType = 'form';
      } else {
        diag.push({
          pass: 'synth_fetch',
          capability: save.capability,
          phase: 'skip',
          outcome: 'body_unparseable',
          detail: {
            content_type: lowerKeys['content-type'] ?? null,
            body_preview: templatedBody.slice(0, 80),
            advice:
              "Captured request body is neither a JSON object nor application/x-www-form-urlencoded — auto-save can't express it as a templated strategy. Lift manually with save_strategy if the body has a known shape (binary protobuf, multipart, JSON array), or rely on the recorded-path fallback.",
          },
        });
        continue;
      }
    }

    // Stamp the page URL the session was on when the marker XHR fired so a
    // later session can try opening it directly instead of re-discovering
    // from the root. Best-effort: use the session's most recently visited
    // top-level URL (the document context the XHR rode on); fall back to
    // absent on parse failure.
    const discoveredFromUrl = pickDiscoveredFromUrl(session);
    const notesBlock: Record<string, unknown> = { params: paramsDoc };
    const runtimeMetaBlock: Record<string, unknown> = {};
    if (discoveredFromUrl) runtimeMetaBlock.discovered_from_url = discoveredFromUrl;
    // Compute the recorded-path anchor id: the last step that would be
    // emitted in the sibling recorded-path pass for this same capability.
    // Stamping the id (rather than an index) keeps the anchor stable across
    // later patch_step calls that reorder steps.
    const anchorId = computeRecordedPathAnchorIdForSave(session, platform, save);
    if (anchorId) runtimeMetaBlock.discovered_at_step_id = anchorId;

    // Verified-expression templating pass. Re-evaluated VEs (computed by the
    // synth orchestrator from `save_verified_expression` calls during LIFT)
    // get matched back into the captured request — wherever an evaluated
    // result landed verbatim in a header or body field, the literal is
    // replaced with `{{<placeholder>}}` and a js-eval prereq is added that
    // re-derives the value at execute time. Without this, rotating tokens
    // (short-TTL JWTs, sentinel proof tokens, etc.) would persist as stale
    // literals on disk and break warm execute.
    const evaluated = evaluatedByCapability?.get(save.capability) ?? [];
    let templatedHeaders: Record<string, string> = headers;
    let templatedBodyField = bodyField;
    let prerequisites: Array<Record<string, unknown>> | undefined;
    let finalTier: 'fetch' | 'page-script' = strategyTier;
    if (evaluated.length > 0) {
      const bodyForTemplating = bodyField !== undefined ? JSON.stringify(bodyField) : null;
      const tmpl = templateRequestFromVEs(evaluated, headers, bodyForTemplating, baseUrl);
      if (tmpl.matches.length > 0) {
        templatedHeaders = tmpl.headers;
        if (tmpl.body !== null) {
          try {
            const parsed = JSON.parse(tmpl.body) as unknown;
            templatedBodyField =
              parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : bodyField;
          } catch {
            // Templating produced an unparseable body — fall back to the
            // pre-template structure rather than ship an unparseable body.
            templatedBodyField = bodyField;
          }
        }
        prerequisites = tmpl.prerequisites.map((p) => ({ ...p }));
        // js-eval prereqs require a browser context to run — force the tier
        // up to page-script even when the original cookie heuristic chose
        // plain fetch.
        finalTier = 'page-script';
        diag.push({
          pass: 'synth_fetch',
          capability: save.capability,
          phase: 'save',
          outcome: 'verified_expressions_applied',
          detail: {
            matches: tmpl.matches.length,
            prereqs: tmpl.prerequisites.length,
            tier_promoted: strategyTier !== finalTier,
          },
        });
      }
    }

    const strategy: Record<string, unknown> = {
      strategy: finalTier,
      baseUrl,
      endpoint,
      method: req.method,
      headers: templatedHeaders,
      ...(bodyContentType ? { contentType: bodyContentType } : {}),
      ...(templatedBodyField !== undefined ? { body: templatedBodyField } : {}),
      ...(prerequisites && prerequisites.length > 0 ? { prerequisites } : {}),
      notes: notesBlock,
      ...(Object.keys(runtimeMetaBlock).length > 0 ? { runtime_meta: runtimeMetaBlock } : {}),
    };
    attachSaveWarningsToStrategy(strategy, detectTypedTextDrift(session, save.args));
    // Parameterization disclosure: auto-synth bypasses saveStrategyAudit
    // (no sessionId passed). Run the structural check here so paramless
    // auto-saves carry the warning into runtime_meta.save_warnings; next
    // session reading list_platform_skills sees the signal.
    attachSaveWarningsToStrategy(
      strategy,
      detectParameterizationDisclosureRequired(strategy as never),
    );

    try {
      const path = skills.saveStrategy(platform, save.capability, strategy as never);
      out.push({
        capability: save.capability,
        tier: strategyTier,
        path,
        reason: `auto-derived from captured request i:${best.requestIdx} (${best.matchLocation} contained arg:${best.paramName})`,
      });
      diag.push({
        pass: 'synth_fetch',
        capability: save.capability,
        phase: 'save',
        outcome: 'ok',
        detail: {
          tier: strategyTier,
          baseUrl,
          endpoint,
          method: req.method,
          matchLocation: best.matchLocation,
        },
      });
    } catch (err) {
      diag.push({
        pass: 'synth_fetch',
        capability: save.capability,
        phase: 'skip',
        outcome: 'validation_rejected',
        detail: {
          error: err instanceof Error ? err.message : String(err),
          tier: strategyTier,
          endpoint,
        },
      });
    }
  }
  return out;
}

/**
 * Deterministic preview of the anchor id the synthesizeRecordedPaths pass
 * will stamp for this save marker. Used by the fetch-synth pass (which runs
 * first) so both sibling strategies carry the same anchor. Returns null when
 * no recorded-path would be emitted (e.g. slice has no click/type, or
 * buildStepsFromHistory drops every step for missing selectors).
 */
function computeRecordedPathAnchorIdForSave(
  session: Session,
  platform: string,
  save: SaveMarker,
): string | null {
  const history = session.performActionHistory ?? [];
  if (history.length === 0) return null;
  // Mirror the window partition in synthesizeRecordedPaths but restricted to
  // this specific save. We can't reuse the state between passes because
  // synth_fetch runs before synth_recorded; compute from scratch.
  const sorted = [...(session.savedCapabilities ?? [])]
    .map((s) => ({ capability: s.capability, at: s.at }))
    .concat(
      (session.declaredCapabilities ?? []).map((d) => ({
        capability: d.capability,
        at: Date.now(),
      })),
    );
  const targetIdx = sorted.findIndex((s) => s.capability === save.capability && s.at === save.at);
  let windowStart = 0;
  for (let i = 0; i < Math.max(targetIdx, 0); i += 1) {
    const m = sorted[i];
    if (!m) continue;
    while (windowStart < history.length && (history[windowStart]?.at ?? Infinity) <= m.at) {
      windowStart += 1;
    }
  }
  let windowEnd = windowStart;
  while (windowEnd < history.length && (history[windowEnd]?.at ?? Infinity) <= save.at) {
    windowEnd += 1;
  }
  const slice = history.slice(windowStart, windowEnd);
  // Short-circuit: only synth-recorded emits a strategy when the flow is
  // write-shaped OR read-nav-shaped; otherwise the recorded-path pass skips
  // and there's no anchor to stamp.
  const hasType = slice.some((a) => a.action === 'type' || a.action === 'fill_editor');
  const lastTypeIdx = findLastIndex(
    slice,
    (a) => a.action === 'type' || a.action === 'fill_editor',
  );
  const hasConfirmAfterType =
    lastTypeIdx >= 0 &&
    slice.slice(lastTypeIdx + 1).some((a) => a.action === 'click' || a.action === 'key_press');
  const lastVisitedForScan = (session.visitedUrls ?? [])
    .filter((u) => u && u !== 'about:blank')
    .at(-1);
  const declaredArgs = save.args ?? {};
  const navLiteralMatch = (() => {
    if (!lastVisitedForScan) return null;
    for (const [, value] of Object.entries(declaredArgs)) {
      if (typeof value !== 'string' || value.length < 4) continue;
      if (lastVisitedForScan.includes(value)) return true;
    }
    return false;
  })();
  const isWriteFlow = hasType && hasConfirmAfterType;
  const isReadNavFlow = !hasType && !!navLiteralMatch;
  if (!isWriteFlow && !isReadNavFlow) return null;
  // Existing recorded-path wins — read its last-step id.
  const existing = skills.loadStrategies(platform, save.capability);
  const already = existing.find((s) => s.strategy === 'recorded-path');
  if (already) {
    const st = already as unknown as { steps?: Array<{ id?: unknown }> };
    const stepList = st.steps ?? [];
    const lastId = stepList.length > 0 ? stepList[stepList.length - 1]?.id : undefined;
    return typeof lastId === 'string' ? lastId : null;
  }
  // Build the steps the same way synthesizeRecordedPaths will, then ask
  // assignAutoStepIds for the ids. Param examples don't affect id assignment
  // (ids come from locator names, not typed values) so pass an empty map.
  const paramExamples = new Map<string, string>();
  const steps = buildStepsFromHistory(slice, paramExamples);
  const lastVisited = (session.visitedUrls ?? []).filter((u) => u && u !== 'about:blank').at(-1);
  const alreadyStartsWithNavigate = steps.length > 0 && steps[0]?.action === 'navigate';
  if (lastVisited && !alreadyStartsWithNavigate) {
    steps.unshift({ action: 'navigate', url: lastVisited });
  }
  if (steps.length === 0) return null;
  assignAutoStepIds(steps);
  const last = steps[steps.length - 1] as { id?: string };
  return last.id ?? null;
}
