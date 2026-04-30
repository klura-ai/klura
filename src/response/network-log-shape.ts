// Pure shaping logic for `get_network_log`. No runtime / driver / pool deps.
//
// Design rationale lives in the plan and ARCHITECTURE — short version: the
// LLM-facing tool returns either a tiny summary (default), a verbatim raw entry
// (`{i, full:true}`), or an auto-selected detail-lite page when the caller
// narrows the log with a filter and the narrowed set fits the tool- output
// budget with responseBody clipped. No name-based header filtering anywhere;
// classification is the LLM's job, the runtime just decides how much raw data
// fits without blowing budget.

import type {
  InterceptedRequest,
  NetworkLogOptions,
  NetworkLogResponse,
  NetworkLogSummary,
} from '../drivers/types/network';
import type { WebSocketFrame, WsFrameSummary } from '../drivers/types/websocket';
import { hashWsFrame } from './ws-pin';
import { detectComplexEnvelope } from './envelope-advisories';
import type { EnvelopeAdvisory } from './envelope-advisories';
import { MAX_TOOL_OUTPUT_CHARS, sliceLargeString } from './response-size';

// Headroom for everything OTHER than responseBody in a {i, full:true} detail
// response — method/URL/headers/postData JSON overhead. Budget minus this is
// the max responseBody slice we'll emit per call. Observed oversize: 1,021,635
// chars for a single capture blew the MCP output budget, forcing the agent to
// rediscover from scratch. Now the body is served in budget-sized slices via
// `{i, full:true, body_offset}` round-trips.
const DETAIL_NONBODY_HEADROOM = 4_000;
const DETAIL_FULL_BODY_DEFAULT_MAX = MAX_TOOL_OUTPUT_CHARS - DETAIL_NONBODY_HEADROOM;

const SUMMARY_DEFAULT_PAGE_SIZE = 50;
const SUMMARY_MAX_PAGE_SIZE = 200;
const DETAIL_LIST_DEFAULT_PAGE_SIZE = 5;
const DETAIL_LIST_MAX_PAGE_SIZE = 20;

// Detail-lite tuning.
//
// Each entry is "request side + small responseBody preview". If the whole
// narrowed set doesn't fit the tool-output budget, we greedy-pack the entries
// we can fit into a single page and stamp has_more / total_pages so the caller
// can page the remainder. Real-world heavy-header sites (Facebook / Meta
// graphql carries 30+ sec-ch-ua-*, friendly-name, lsd, long session IDs — 2-4
// KB of headers per entry) don't fit the whole filtered set in one response, so
// without pagination they'd fall all the way back to summary and give up the
// classifier signal. With pagination they still get full headers and postData
// per entry in the first page — just fewer entries at once.
//
// The response preview cap is tight (512 chars): enough to see
// `{"data":{"<mutation>":{...}}}` or `{"error":...}` at the head of the body,
// which is all you need to confirm the mutation succeeded or classify the
// endpoint. Agents that need the full responseBody pay for it explicitly with
// `{i, full: true}`.
const DETAIL_LITE_RESPONSE_BODY_CAP = 512;
const DETAIL_LITE_TOTAL_BUDGET_CHARS = 20_000;
// Payload preview cap for ws frames. Same 512-char budget as HTTP responseBody
// previews — enough to see JSON shape / MQTT envelope / chat text, while
// keeping a chat-heavy page's 50+ captured frames under tool-output budget.
const WS_FRAME_PAYLOAD_PREVIEW_CAP = 512;
// Hard cap on how many ws frame summaries to return per call when there's no
// narrowing filter. Chat / realtime pages produce dozens-to-hundreds of
// heartbeat / presence frames during a session, and dumping all of them crowds
// the HTTP entries out of the response. With a filter (text_contains /
// url_contains / last), this cap is bypassed — matching frames always surface.
const WS_FRAMES_UNFILTERED_CAP = 30;
// Hard floor — a single entry larger than this is pathological; skip it and
// include it in the warning so the caller can fetch it with `{i, full: true}`
// if they really want it. Without this, one monster response could starve every
// other entry out of the page.
const DETAIL_LITE_PER_ENTRY_SOFT_CAP = 15_000;

function byteSize(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v.length;
  try {
    return JSON.stringify(v).length;
  } catch {
    return undefined;
  }
}

export function extractContentType(entry: InterceptedRequest): string | undefined {
  for (const [k, v] of Object.entries(entry.headers)) {
    if (k.toLowerCase() === 'content-type' && typeof v === 'string') {
      // Drop charset/boundary noise; keep just the media type.
      const head = v.split(';')[0];
      return head ? head.trim() : v.trim();
    }
  }
  return undefined;
}

function toSummary(entry: InterceptedRequest, i: number): NetworkLogSummary {
  const summary: NetworkLogSummary = {
    i,
    method: entry.method,
    url: entry.url,
    status: entry.status,
  };
  const ct = extractContentType(entry);
  if (ct) summary.contentType = ct;
  const postSize = byteSize(entry.postData);
  if (postSize !== undefined && postSize > 0) summary.postDataSize = postSize;
  const respSize = byteSize(entry.responseBody);
  if (respSize !== undefined && respSize > 0) summary.responseSize = respSize;
  if (entry.isNavigation) summary.isNavigation = true;
  if (entry.redirectUrl) summary.redirectUrl = entry.redirectUrl;
  if (typeof entry.timestamp === 'number') summary.ts = entry.timestamp;
  return summary;
}

function resolvePageSize(
  requested: number | undefined,
  defaultSize: number,
  maxSize: number,
): { size: number; warning?: string } {
  if (requested === undefined || requested <= 0) {
    return { size: defaultSize };
  }
  if (requested > maxSize) {
    return { size: maxSize, warning: `page_size clamped from ${requested} to ${maxSize}` };
  }
  return { size: requested };
}

/**
 * Stringify arbitrary value for substring matching. Strings are returned as-is;
 * non-string values are JSON-stringified. Returns the empty string for anything
 * that fails to serialize (circular refs, exotic types).
 */
function stringifyForMatch(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/**
 * True if `haystack` contains `lcNeedle` as a case-insensitive substring,
 * checking both the raw bytes and URL-decoded variants. The decoded variants
 * catch the common case of form-encoded request bodies
 * (`application/x-www-form-urlencoded`, `multipart/form-data` parts, and some
 * graphql transports that send `variables={"message":"Hello+world"}`) where the
 * literal the agent typed shows up on the wire as `Hello+from+a+klura`
 * (plus-for-space) or `Hello%20from%20a%20klura` (percent-encoded). A naive
 * substring match against the raw bytes would miss both forms.
 *
 * We try, in order: 1. Raw lowercase substring — exact bytes as captured. 2.
 * `+` → space, then lowercase — covers form-encoded spaces. 3.
 * `decodeURIComponent` after step 2 — covers percent-encoded chars.
 *
 * Step 3 can throw on malformed encodings (invalid percent sequences); we
 * swallow and keep the already-tried steps. The needle itself is assumed to
 * already be lowercase.
 */
export function substringMatchWithDecoding(haystack: string, lcNeedle: string): boolean {
  if (!haystack) return false;
  const lowerRaw = haystack.toLowerCase();
  if (lowerRaw.includes(lcNeedle)) return true;
  const plusAsSpace = lowerRaw.replace(/\+/g, ' ');
  if (plusAsSpace !== lowerRaw && plusAsSpace.includes(lcNeedle)) return true;
  try {
    const percentDecoded = decodeURIComponent(plusAsSpace);
    if (percentDecoded !== plusAsSpace && percentDecoded.includes(lcNeedle)) return true;
  } catch {
    // Malformed percent-encoding — raw and plus-decoded tries already ran.
  }
  return false;
}

/**
 * True if any field of `entry` contains `needle` as a case-insensitive
 * substring. Searches URL, request header names + values, request body, and
 * response body — each tried against raw, plus-decoded, and percent-decoded
 * variants so form-encoded bodies still match. Generic; no field-name
 * whitelist.
 */
function matchesText(entry: InterceptedRequest, needle: string): boolean {
  const lc = needle.toLowerCase();
  if (substringMatchWithDecoding(entry.url, lc)) return true;
  for (const [k, v] of Object.entries(entry.headers)) {
    if (k.toLowerCase().includes(lc)) return true;
    if (typeof v === 'string' && substringMatchWithDecoding(v, lc)) return true;
  }
  const pd = stringifyForMatch(entry.postData);
  if (substringMatchWithDecoding(pd, lc)) return true;
  const rb = stringifyForMatch(entry.responseBody);
  if (substringMatchWithDecoding(rb, lc)) return true;
  return false;
}

/**
 * Build a detail-lite copy of an intercepted request: full request side
 * (headers, postData, method, URL) preserved verbatim, response body clipped to
 * a preview with truncation markers so the caller can tell a clipped response
 * apart from a genuinely short one. Stamps the absolute index `i` on the entry
 * so the caller can round-trip to `{i, full: true}` for the untrimmed version.
 */
function toDetailLite(entry: InterceptedRequest, i: number): InterceptedRequest {
  const rawBody = entry.responseBody;
  let bodyStr: string | null = null;
  if (typeof rawBody === 'string') {
    bodyStr = rawBody;
  } else if (rawBody !== null && rawBody !== undefined) {
    try {
      bodyStr = JSON.stringify(rawBody);
    } catch {
      bodyStr = null;
    }
  }
  if (bodyStr === null) {
    // Nothing to trim — return shallow copy so callers can't mutate the
    // driver's live array.
    return { ...entry, i };
  }
  const sliced = sliceLargeString(bodyStr, {
    length: DETAIL_LITE_RESPONSE_BODY_CAP,
    defaultMaxLength: DETAIL_LITE_RESPONSE_BODY_CAP,
    hintFetchNext: (end, remaining) =>
      `preview clipped at char ${end} of ${bodyStr.length}; ${remaining} chars remaining. ` +
      `fetch the full body with {i: ${i}, full: true, body_offset: ${end}} or pivot to ` +
      `find_in_page for targeted extraction.`,
  });
  if (!sliced.truncated) {
    return { ...entry, i, responseBody: sliced.slice };
  }
  return {
    ...entry,
    i,
    responseBody: sliced.slice,
    responseBody_truncated: true,
    responseBody_total_chars: sliced.total_chars,
    responseBody_slice_start: sliced.slice_start,
    responseBody_slice_end: sliced.slice_end,
    responseBody_hint: sliced.hint,
  };
}

/**
 * Slice an intercepted request's responseBody to fit the tool-output budget for
 * `{i, full:true}` detail mode. Thin wrapper over the shared `sliceLargeString`
 * helper (canonical budget-safe string slicer) — this adapter stringifies
 * non-string responseBody and stamps the `responseBody_*` field names the
 * detail consumer expects.
 *
 * Why a wrapper: the external shape on `InterceptedRequest` is fixed
 * (responseBody_truncated, responseBody_total_chars, responseBody_slice_start,
 * responseBody_slice_end, responseBody_hint) and can't change without a
 * coordinated update to the MCP response type + all downstream consumers. The
 * core slicing logic is shared with js_eval / evaluate_on_frame / etc. via
 * `sliceLargeString` — observed failure 2026-04-19, a 1,021,635-char
 * responseBody blew the MCP budget; the fix generalizes.
 */
function sliceDetailResponseBody(
  entry: InterceptedRequest,
  bodyOffset?: number,
  bodyLength?: number,
): InterceptedRequest {
  const rawBody = entry.responseBody;
  let bodyStr: string | null = null;
  if (typeof rawBody === 'string') {
    bodyStr = rawBody;
  } else if (rawBody !== null && rawBody !== undefined) {
    try {
      bodyStr = JSON.stringify(rawBody);
    } catch {
      bodyStr = null;
    }
  }
  if (bodyStr === null) return { ...entry };
  const sliced = sliceLargeString(bodyStr, {
    offset: bodyOffset,
    length: bodyLength,
    defaultMaxLength: DETAIL_FULL_BODY_DEFAULT_MAX,
    hintFetchNext: (end, remaining) => {
      const parts: string[] = [];
      if (remaining > 0) {
        parts.push(
          `body truncated at char ${end} of ${bodyStr.length}; ${remaining} chars remaining. ` +
            `fetch next chunk with {i: ${entry.i ?? '<same>'}, full:true, body_offset: ${end}}`,
        );
      }
      if ((bodyOffset ?? 0) > 0) {
        parts.push(
          `this slice starts at char ${bodyOffset} (request had body_offset=${bodyOffset})`,
        );
      }
      parts.push(
        `for targeted extraction, run find_in_page against the session with the specific literal you're looking for — one call returns only matches, no scrolling`,
      );
      return parts.join(' | ');
    },
  });
  if (!sliced.truncated) {
    return { ...entry, responseBody: sliced.slice };
  }
  return {
    ...entry,
    responseBody: sliced.slice,
    responseBody_truncated: true,
    responseBody_total_chars: sliced.total_chars,
    responseBody_slice_start: sliced.slice_start,
    responseBody_slice_end: sliced.slice_end,
    responseBody_hint: sliced.hint,
  };
}

function summarizeWsFrame(frame: WebSocketFrame, i: number): WsFrameSummary {
  const payload = typeof frame.payload === 'string' ? frame.payload : '';
  const base: Omit<WsFrameSummary, 'payload'> = {
    i,
    ws_hash: hashWsFrame(frame),
    direction: frame.direction,
    url: frame.url,
    ts: frame.timestamp,
  };
  if (frame.direction === 'sent') {
    base.live_handle_hint = {
      tool: 'get_send_encoder',
      args: { ws_i: i },
      reason:
        'klura captured a live handle to the WebSocket that sent this frame and the exact bytes the page passed to `.send()`. ' +
        'Calling `get_send_encoder({ws_i})` returns `encoder_handle: window.__kluraSendEncoders[<key>]` plus structured advice. ' +
        "Use it to re-send through the page's already-authenticated socket — `<handle>.ws.send(<your_bytes>)` — without locating the encoder function in the bundle.",
    };
  }
  const sliced = sliceLargeString(payload, {
    length: WS_FRAME_PAYLOAD_PREVIEW_CAP,
    defaultMaxLength: WS_FRAME_PAYLOAD_PREVIEW_CAP,
    hintFetchNext: () => `payload clipped; fetch the full frame with {ws_i: ${i}, full: true}.`,
  });
  if (!sliced.truncated) {
    return { ...base, payload: sliced.slice };
  }
  return {
    ...base,
    payload: sliced.slice,
    payload_truncated: true,
    payload_total_chars: sliced.total_chars,
    payload_slice_start: sliced.slice_start,
    payload_slice_end: sliced.slice_end,
    payload_hint: sliced.hint,
  };
}

function filterAndShapeWsFrames(
  rawWs: ReadonlyArray<WebSocketFrame>,
  opts: NetworkLogOptions,
): {
  summaries: WsFrameSummary[];
  /** Post-filter, post-cap raw frames with their absolute index — used by the
   *  envelope-advisory detector, which needs un-clipped payload bytes. */
  surfacedRaw: { frame: WebSocketFrame; i: number }[];
  filtered: number;
  total: number;
  capped: number;
} {
  const total = rawWs.length;
  // Apply the same narrowing filters as HTTP, so a shared text_contains hits
  // both arms and the agent sees the whole picture in one call.
  let indexed = rawWs.map((f, i) => ({ f, i }));
  if (opts.url_contains) {
    const needle = opts.url_contains.toLowerCase();
    indexed = indexed.filter(({ f }) => f.url.toLowerCase().includes(needle));
  }
  if (opts.text_contains) {
    const lc = opts.text_contains.toLowerCase();
    indexed = indexed.filter(({ f }) => substringMatchWithDecoding(f.payload, lc));
  }
  if (opts.last !== undefined && opts.last > 0) {
    indexed = indexed.slice(-opts.last);
  }
  const filtered = indexed.length;
  const hasNarrowingFilter = !!(opts.url_contains || opts.text_contains || opts.last);
  // With no narrowing filter, trim to the last N frames (most recent activity
  // wins — chat sessions produce heartbeat noise up front).
  let capped = 0;
  if (!hasNarrowingFilter && indexed.length > WS_FRAMES_UNFILTERED_CAP) {
    capped = indexed.length - WS_FRAMES_UNFILTERED_CAP;
    indexed = indexed.slice(-WS_FRAMES_UNFILTERED_CAP);
  }
  const summaries = indexed.map(({ f, i }) => summarizeWsFrame(f, i));
  const surfacedRaw = indexed.map(({ f, i }) => ({ frame: f, i }));
  return { summaries, surfacedRaw, filtered, total, capped };
}

/**
 * Run the complex-envelope detector framework against the entries that are
 * about to be surfaced in this response. Returns a single advisory (highest-
 * priority detector wins) or null. Pure pass-through to `detectComplexEnvelope`
 * — kept here so the call sites in `shapeNetworkLog` read as one line.
 */
function buildAdvisory(
  surfacedHttp: { entry: InterceptedRequest; i: number }[],
  surfacedWs: { frame: WebSocketFrame; i: number }[],
  textContains: string | undefined,
  tryGeneratorStats: TryGeneratorStatsLite | null | undefined,
  sessionRoundCount: number | undefined,
): EnvelopeAdvisory | null {
  return detectComplexEnvelope({
    httpEntries: surfacedHttp,
    wsFrames: surfacedWs,
    textContains,
    tryGeneratorStats,
    sessionRoundCount,
  });
}

/** Pool counter snapshot — see envelope-advisories.ts for the full shape. */
interface TryGeneratorStatsLite {
  total: number;
  with_verify_against: number;
  ok_true: number;
  verified_ok: number;
}

export function shapeNetworkLog(
  raw: InterceptedRequest[],
  opts: NetworkLogOptions = {},
  rawWs: ReadonlyArray<WebSocketFrame> = [],
  tryGeneratorStats: TryGeneratorStatsLite | null = null,
  sessionRoundCount?: number,
): NetworkLogResponse {
  const total = raw.length;
  const wsFramesTotal = rawWs.length;

  // Detail-by-ws-index: agent already knows which frame they want, return it
  // verbatim and skip all other shaping.
  if (opts.ws_i !== undefined && opts.full) {
    const frame = rawWs[opts.ws_i];
    if (!frame) {
      return {
        requests: [],
        total,
        total_filtered: 0,
        returned: 0,
        page: 1,
        page_size: 1,
        total_pages: 0,
        has_more: false,
        mode: 'detail',
        wsFramesTotal,
        warning: `no ws frame at index ${opts.ws_i} (total: ${wsFramesTotal})`,
      };
    }
    return {
      requests: [],
      wsFrame: frame,
      wsFramesTotal,
      total,
      total_filtered: 0,
      returned: 1,
      page: 1,
      page_size: 1,
      total_pages: 1,
      has_more: false,
      mode: 'detail',
    };
  }

  // Detail-by-index always wins — bypasses filters AND pagination because the
  // agent already picked exactly which entry it wants.
  if (opts.i !== undefined && opts.full) {
    const entry = raw[opts.i];
    if (!entry) {
      return {
        requests: [],
        total,
        total_filtered: 0,
        returned: 0,
        page: 1,
        page_size: 1,
        total_pages: 0,
        has_more: false,
        mode: 'detail',
        wsFramesTotal,
        warning: `no entry at index ${opts.i} (total: ${total})`,
      };
    }
    return {
      requests: sliceDetailResponseBody(entry, opts.body_offset, opts.body_length),
      total,
      total_filtered: 1,
      returned: 1,
      page: 1,
      page_size: 1,
      total_pages: 1,
      has_more: false,
      mode: 'detail',
      wsFramesTotal,
    };
  }

  // Working list with absolute indices preserved so any `i` the agent sees in
  // the response can be passed back for detail without filter context.
  let indexed = raw.map((e, i) => ({ e, i }));
  if (opts.url_contains) {
    const needle = opts.url_contains.toLowerCase();
    indexed = indexed.filter(({ e }) => e.url.toLowerCase().includes(needle));
  }
  if (opts.text_contains) {
    const needle = opts.text_contains;
    indexed = indexed.filter(({ e }) => matchesText(e, needle));
  }
  if (opts.last !== undefined && opts.last > 0) {
    indexed = indexed.slice(-opts.last);
  }

  const totalFiltered = indexed.length;
  const hasNarrowingFilter = !!(opts.url_contains || opts.text_contains || opts.last);
  const isDetailList = !!opts.full;

  // Shape the ws frame side once; injected into every non-detail return path so
  // the agent always sees ws activity in one call.
  const wsShape = filterAndShapeWsFrames(rawWs, opts);
  const wsFramesEnvelope = (() => {
    const env: Pick<NetworkLogResponse, 'wsFrames' | 'wsFramesTotal' | 'wsFramesFiltered'> = {};
    if (wsShape.total === 0) return env;
    env.wsFramesTotal = wsShape.total;
    env.wsFramesFiltered = wsShape.filtered;
    env.wsFrames = wsShape.summaries;
    return env;
  })();
  const wsCapWarnings: string[] = [];
  if (wsShape.capped > 0) {
    wsCapWarnings.push(
      `wsFrames capped: ${wsShape.summaries.length} of ${wsShape.total} shown (${wsShape.capped} older frames omitted); filter with text_contains / last to surface specific frames or fetch one by {ws_i, full: true}`,
    );
  }

  // Detail-lite is the only multi-entry detail mode we emit — it clips
  // each entry's bodies via sliceLargeString and greedy-packs entries
  // into pages under MAX_TOOL_OUTPUT_CHARS. Triggers:
  //   - Auto-promotion on a narrowing filter that fits the budget (the
  //     "10-entry graphql summary, who knows which is the send" case).
  //   - Explicit `full: true` without `i` / `ws_i` — the caller wants
  //     multi-entry detail. Raw-unbounded detail-list was a footgun
  //     (blew MCP's 25KB cap on response-body-heavy captures, observed
  //     2026-04-21T09 messenger run: 107KB payload, fell through to
  //     file-dump + Read, burning rounds); detail-lite packs safely.
  //     Single-entry fetches via `{i, full: true}` stay unbounded —
  //     the caller picked exactly one entry, so there's no budget
  //     surprise.
  // Unfiltered calls without `full` still default to summary — the
  // whole log is unbounded and auto-expanding it would blow the budget
  // on telemetry-heavy sites. `opts.page_size` suppresses auto-promote
  // — caller is tuning a summary page. `opts.page` alone does NOT
  // suppress, because detail-lite pages its own output when the
  // narrowed set is larger than the per-response budget.
  const shouldAutoDetailLite =
    !opts.page_size &&
    ((hasNarrowingFilter && totalFiltered > 0 && totalFiltered <= SUMMARY_MAX_PAGE_SIZE) ||
      isDetailList);

  if (shouldAutoDetailLite) {
    const sizeOf = (v: unknown): number => {
      try {
        return JSON.stringify(v).length;
      } catch {
        return Number.MAX_SAFE_INTEGER;
      }
    };

    // Build all filtered entries in rich form, then greedy-pack into pages that
    // fit the budget. Envelope overhead (the total / pagination fields) is ~200
    // chars; reserve it.
    const ENVELOPE_RESERVE = 300;
    const perPageBudget = DETAIL_LITE_TOTAL_BUDGET_CHARS - ENVELOPE_RESERVE;
    const allRich: InterceptedRequest[] = indexed.map(({ e, i }) => toDetailLite(e, i));
    const entrySizes: number[] = allRich.map((entry) => sizeOf(entry));

    // Pathological single entry: > soft cap. Note it in the warning so the
    // caller can fetch it with `{i, full: true}` if they care.
    const skippedGiants: number[] = [];
    const pageable: { entry: InterceptedRequest; size: number }[] = [];
    for (let k = 0; k < allRich.length; k += 1) {
      const entry = allRich[k];
      const size = entrySizes[k];
      if (entry === undefined || size === undefined) continue;
      if (size > DETAIL_LITE_PER_ENTRY_SOFT_CAP) {
        skippedGiants.push(entry.i ?? k);
        continue;
      }
      pageable.push({ entry, size });
    }

    // Walk pageable entries, grouping as many as fit into each page until we
    // exhaust the list. Each "page" is a list of entries whose combined JSON
    // size is <= perPageBudget.
    const pages: InterceptedRequest[][] = [];
    let current: InterceptedRequest[] = [];
    let currentSize = 2; // "[]" framing
    for (const { entry, size } of pageable) {
      const addition = size + 1; // + comma
      if (current.length > 0 && currentSize + addition > perPageBudget) {
        pages.push(current);
        current = [];
        currentSize = 2;
      }
      current.push(entry);
      currentSize += addition;
    }
    if (current.length > 0) pages.push(current);

    if (pages.length > 0) {
      const totalPagesDetailLite = pages.length;
      const requestedPageLite = opts.page && opts.page > 0 ? opts.page : 1;
      const pageLite = Math.min(requestedPageLite, totalPagesDetailLite);
      const pageEntries = pages[pageLite - 1] ?? [];
      const warnings: string[] = [];
      if (totalPagesDetailLite > 1) {
        warnings.push(
          `narrowed set paginated into ${totalPagesDetailLite} detail-lite pages; call again with {page: N} to walk the rest`,
        );
      }
      if (skippedGiants.length > 0) {
        warnings.push(
          `${skippedGiants.length} entry/entries too large to include (indices: ${skippedGiants.join(', ')}); fetch with {i, full: true}`,
        );
      }
      warnings.push(...wsCapWarnings);
      const surfacedHttpForAdvisory = pageEntries
        .map((entry) => {
          const idx = entry.i;
          if (idx === undefined) return null;
          const rawEntry = raw[idx];
          if (!rawEntry) return null;
          return { entry: rawEntry, i: idx };
        })
        .filter((x): x is { entry: InterceptedRequest; i: number } => x !== null);
      const advisory = buildAdvisory(
        surfacedHttpForAdvisory,
        wsShape.surfacedRaw,
        opts.text_contains,
        tryGeneratorStats,
        sessionRoundCount,
      );
      return {
        total,
        total_filtered: totalFiltered,
        page: pageLite,
        page_size: pageEntries.length,
        total_pages: totalPagesDetailLite,
        has_more: pageLite < totalPagesDetailLite,
        requests: pageEntries,
        returned: pageEntries.length,
        mode: 'detail-lite',
        ...wsFramesEnvelope,
        ...(warnings.length ? { warning: warnings.join('; ') } : {}),
        ...(advisory ? { _advisory: advisory } : {}),
      };
    }

    // Every single entry was a giant — fall through to summary, the caller will
    // have to page or fetch individual entries by index.
  }

  const { size: pageSize, warning: clampWarning } = resolvePageSize(
    opts.page_size,
    isDetailList ? DETAIL_LIST_DEFAULT_PAGE_SIZE : SUMMARY_DEFAULT_PAGE_SIZE,
    isDetailList ? DETAIL_LIST_MAX_PAGE_SIZE : SUMMARY_MAX_PAGE_SIZE,
  );
  const totalPages = totalFiltered === 0 ? 0 : Math.ceil(totalFiltered / pageSize);
  const requestedPage = opts.page ?? 1;
  const page = requestedPage < 1 ? 1 : requestedPage;
  const pageStart = (page - 1) * pageSize;
  const pageSlice = indexed.slice(pageStart, pageStart + pageSize);
  const hasMore = page < totalPages;

  const warnings: string[] = [];
  if (clampWarning) warnings.push(clampWarning);
  if (totalPages > 0 && page > totalPages) {
    warnings.push(`page ${page} beyond total_pages ${totalPages}`);
  }

  warnings.push(...wsCapWarnings);
  const surfacedHttpForAdvisory = pageSlice.map(({ e, i }) => ({ entry: e, i }));
  const advisory = buildAdvisory(
    surfacedHttpForAdvisory,
    wsShape.surfacedRaw,
    opts.text_contains,
    tryGeneratorStats,
    sessionRoundCount,
  );
  const envelopeBase = {
    total,
    total_filtered: totalFiltered,
    page,
    page_size: pageSize,
    total_pages: totalPages,
    has_more: hasMore,
    ...wsFramesEnvelope,
    ...(warnings.length ? { warning: warnings.join('; ') } : {}),
    ...(advisory ? { _advisory: advisory } : {}),
  };

  if (isDetailList) {
    // Explicit `page_size` + `full` fell through the detail-lite auto-promote
    // above. Budget enforcement still applies here: slice each entry's bodies
    // via toDetailLite so the response respects MAX_TOOL_OUTPUT_CHARS even when
    // the caller explicitly tuned a page size.
    const entries = pageSlice.map(({ e, i }) => toDetailLite(e, i));
    return {
      ...envelopeBase,
      requests: entries,
      returned: entries.length,
      mode: 'detail-list',
    };
  }

  const summaries = pageSlice.map(({ e, i }) => toSummary(e, i));
  return {
    ...envelopeBase,
    requests: summaries,
    returned: summaries.length,
    mode: 'summary',
  };
}
