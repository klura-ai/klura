import { pool } from '../runtime-state';
import { ensureAccumulator, ringPush, digestSelector } from '../strategies/discovery-artifact';
import {
  windowJsSource,
  searchJsSource,
  readJsFunction,
  type JsSourceWindow,
  type JsSourceMatch,
  type JsFunctionSlice,
} from '../response/js-source-shape';
import {
  composeSendEncoderResponse,
  type SendEncoderResponse,
} from '../response/send-encoder-shape';
import { guardLargeResult, MAX_TOOL_OUTPUT_CHARS } from '../response/response-size';
import { wrapAgentExpression } from '../response/js-eval-wrapper';
import { recordObservations } from '../response/observation-trace';
import { maybeFireSurfaceChanged } from '../phases/surface-changed';
import type { CheckpointEnvelope } from '../checkpoints';

export interface GetJsSourceArgs {
  session_id: string;
  /** Script URL — typically the `file` field of a `js_callstack` frame
   *  surfaced by `inspect_ws_frame`. The script must be one the page has
   *  already loaded; the runtime fetches via `fetch()` from inside the
   *  page context, so the browser's HTTP cache + cookies are reused. */
  url: string;
  /** 1-indexed line to center the window on. Default 1. */
  line?: number;
  /** Lines of surrounding context (above + below). Default 60, max 200. */
  context_lines?: number;
  /** When the source is a single minified line, pretty-print it before
   *  windowing so the agent gets multiple lines of structure to read.
   *  Default 'pretty'. Pass 'raw' to skip pretty-printing entirely. */
  format?: 'raw' | 'pretty';
}

/**
 * Fetch the JS source of a script the page has loaded, then return a windowed
 * slice around `line` with surrounding context. Used by the agent to read the
 * encoder behind a captured `WebSocket.send` callstack:
 * `inspect_ws_frame.js_callstack.frames[0]` names a `file:line:col`, then
 * `get_js_source(file, {line})` reads the surrounding source so the agent sees
 * the actual derivations (e.g. `epoch_id = Date.now() * 1e6n`) instead of
 * guessing them from output bytes.
 *
 * Per-session cache means paginated reads share one fetch round-trip. Cleared
 * on session close.
 */
export async function getJsSource(args: GetJsSourceArgs): Promise<JsSourceWindow> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.url !== 'string' || args.url.length === 0) {
    throw new Error('url is required (non-empty string)');
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id) as unknown as {
    getJsSource?: (s: typeof session, u: string) => Promise<string>;
  };
  if (typeof driver.getJsSource !== 'function') {
    throw new Error(
      `driver does not implement getJsSource — this tool requires the playwright driver (or another driver that implements page.evaluate-based fetch)`,
    );
  }
  let source: string;
  try {
    source = await driver.getJsSource(session, args.url);
  } catch (e) {
    throw new Error(`failed to fetch ${args.url}: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  ringPush(ensureAccumulator(session).getJsSourceCalls, {
    url: args.url,
    line: args.line,
    at: new Date().toISOString(),
  });
  return windowJsSource(args.url, source, {
    line: args.line,
    context_lines: args.context_lines,
    format: args.format,
  });
}

export interface GetSendEncoderArgs {
  session_id: string;
  ws_i: number;
}

/**
 * Read the per-ws_i encoder side-channel that the page-side WebSocket.send
 * wrapper stashed at send time. Returns the captured WebSocket URL, sent-args
 * preview/type/length, and a stable js_eval handle pointing at the live
 * WebSocket instance + the original args. Pair with
 * `inspect_ws_frame.js_callstack` (file:line of the call) and `get_js_source`
 * (the actual encoder source) to skip byte-level reverse engineering. The agent
 * reasons about where the encoder lives in the page from the source it reads —
 * the runtime never names a global path.
 */
export async function getSendEncoder(args: GetSendEncoderArgs): Promise<
  | SendEncoderResponse
  | {
      encoder: null;
      reason:
        | 'frame_out_of_range'
        | 'frame_received'
        | 'wrapper_not_installed'
        | 'no_matching_fingerprint';
      advice: string;
    }
> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.ws_i !== 'number' || args.ws_i < 0) {
    throw new Error('ws_i is required and must be a non-negative index');
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id) as unknown as {
    getSendEncoderInfo?: (
      s: typeof session,
      i: number,
    ) => Promise<
      | {
          sent_args_preview: string;
          sent_args_type: string;
          sent_args_byte_length: number;
          ws_url: string;
          head_hex: string;
          ts: number;
          handle_alive: boolean;
          encoder_key: string;
        }
      | {
          reason:
            | 'frame_out_of_range'
            | 'frame_received'
            | 'wrapper_not_installed'
            | 'no_matching_fingerprint';
        }
    >;
  };
  if (typeof driver.getSendEncoderInfo !== 'function') {
    throw new Error(
      `driver does not implement getSendEncoderInfo — this tool requires the playwright driver`,
    );
  }
  const info = await driver.getSendEncoderInfo(session, args.ws_i);
  const wasEncoder = !('reason' in info);
  ringPush(ensureAccumulator(session).getSendEncoderCalls, {
    ws_i: args.ws_i,
    handle_alive: wasEncoder ? !!(info as { handle_alive?: boolean }).handle_alive : false,
    at: new Date().toISOString(),
  });
  if ('reason' in info) {
    const reason = info.reason;
    const advice = (() => {
      switch (reason) {
        case 'frame_out_of_range':
          return `ws_i ${args.ws_i} is beyond the captured-frame buffer. Call get_network_log to see the current ring buffer's range of ws frames.`;
        case 'frame_received':
          return `ws_i ${args.ws_i} is a received frame (direction:"received"). The encoder stash only carries sent frames — pick a ws_i whose direction is "sent" (filter get_network_log's wsFrames by direction).`;
        case 'wrapper_not_installed':
          return `The page-side WebSocket.send wrapper hasn't been installed on this page yet (no JS has opened a WebSocket, or the page loaded before the init script ran). If you just opened the session, interact once to trigger the app's JS, then retry.`;
        case 'no_matching_fingerprint':
          return `No encoder entry matched this frame's fingerprint. Either the send happened before the wrapper was installed, the page JS re-wrapped WebSocket.prototype.send and bypassed the stash, or the entry aged out of the 2000-entry cap on a chatty session. Treat the encoder as unavailable for this specific frame; read the encoder source via get_js_source + inspect_ws_frame.js_callstack instead.`;
      }
    })();
    return { encoder: null, reason, advice };
  }
  return composeSendEncoderResponse(info, args.ws_i);
}

export interface SearchJsSourceArgs {
  session_id: string;
  url: string;
  pattern: string;
  case_sensitive?: boolean;
  max_matches?: number;
}

/**
 * Substring-search a JS script the page already loaded. Returns `{line, column,
 * preview}` for each match (up to `max_matches`, default 20, max 100). Line
 * numbers are raw-source coordinates — same system `get_js_source({line})` and
 * `Error.stack` frames use.
 *
 * Agents use this to find candidate encoder call sites by searching for
 * protocol literals observed in captured bytes (e.g. `"/ls_req"`,
 * `"encodeSend"`, field names, opcode identifiers).
 */
export async function searchJsSourceTool(args: SearchJsSourceArgs): Promise<{
  url: string;
  total_matches: number;
  matches: JsSourceMatch[];
  truncated?: true;
  runtime_hint?: string;
}> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.url !== 'string' || args.url.length === 0) {
    throw new Error('url is required');
  }
  if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
    throw new Error('pattern is required (non-empty literal substring)');
  }
  if (args.pattern.length > 500) {
    throw new Error('pattern must be ≤ 500 chars');
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id) as unknown as {
    getJsSource?: (s: typeof session, u: string) => Promise<string>;
  };
  if (typeof driver.getJsSource !== 'function') {
    throw new Error('driver does not implement getJsSource');
  }
  const source = await driver.getJsSource(session, args.url);
  const matches = searchJsSource(source, args.pattern, {
    case_sensitive: args.case_sensitive,
    max_matches: args.max_matches,
  });
  const cap = Math.min(Math.max(args.max_matches ?? 20, 1), 100);
  const priorSearchCalls = ensureAccumulator(session).searchJsSourceCalls.length;
  ringPush(ensureAccumulator(session).searchJsSourceCalls, {
    url: args.url,
    pattern_digest: digestSelector(args.pattern),
    at: new Date().toISOString(),
  });

  // Enumerate-don't-guess nudge: when the agent is hunting on a minified bundle
  // by pattern-spraying and not finding much, point at live enumeration as a
  // faster lever. Minification heuristic: average line length > 2k chars
  // (typical minified bundle lines run 5k–200k chars; pretty-printed code avg
  // is ~60–120). Thin-result: ≤ 2 matches. Spray-mode: the agent has already
  // made 3+ search_js_source calls this session. Hint fires when (thin AND
  // minified) OR (thin AND spray-mode).
  const sourceLen = source.length;
  const newlineCount = (source.match(/\n/g) || []).length;
  const avgLineLen = newlineCount > 0 ? sourceLen / (newlineCount + 1) : sourceLen;
  const isMinified = avgLineLen > 2000;
  const thinResult = matches.length <= 2;
  const spraying = priorSearchCalls >= 3;
  let runtime_hint: string | undefined;
  if (thinResult && (isMinified || spraying)) {
    const preamble = isMinified
      ? `Bundle is heavily minified (avg line length ~${Math.round(avgLineLen)} chars); literal-pattern search returns noise on VMd/obfuscated code. `
      : `You've made ${priorSearchCalls}+ search_js_source calls this session without strong convergence. `;
    runtime_hint =
      preamble +
      'Pivot to LIVE ENUMERATION via js_eval — the VM has to expose callables on real objects regardless of how opaque the source reads. Try (in order of reach):\n' +
      '  • Object.keys(globalThis).filter(k => /LS|SDK|MQ|Chat|Sign|Token|Crypto|Auth/i.test(k)) — broad; broaden the regex if empty.\n' +
      '  • Object.keys(__d?._r?._r || __d?._d || __d || {}).filter(k => /<keyword>/i.test(k)) — bundler-specific module registry (Webpack / Metro / AMD / site-internal loaders).\n' +
      '  • Once a candidate is found, Object.getOwnPropertyNames(candidate).sort() + Object.getOwnPropertyNames(Object.getPrototypeOf(candidate)).sort() — enumerates methods + properties the VM actually holds.\n' +
      '  • Monkey-patch-capture (klura://reference#reverse-engineer-playbook): wrap the located method to record ground-truth inputs on the next real send. Cuts the "what does the page pass this function" question in one round.';
  }
  // Belt-and-suspenders emit-side check. Each match preview is bounded to ~120
  // chars by searchJsSource, and match count is capped via max_matches, but
  // pathological patterns (one super-wide line) could still push the aggregated
  // response past budget. If it does, trim the match tail and flag
  // clipped_to_fit_budget so the caller can narrow the pattern.
  let resultMatches = matches;
  let clippedToFitBudget = false;
  let serialized = JSON.stringify(resultMatches);
  while (serialized.length > MAX_TOOL_OUTPUT_CHARS - 4_000 && resultMatches.length > 1) {
    resultMatches = resultMatches.slice(0, Math.floor(resultMatches.length / 2));
    serialized = JSON.stringify(resultMatches);
    clippedToFitBudget = true;
  }
  return {
    url: args.url,
    total_matches: matches.length,
    matches: resultMatches,
    ...(matches.length >= cap ? { truncated: true as const } : {}),
    ...(clippedToFitBudget ? { clipped_to_fit_budget: true as const } : {}),
    ...(runtime_hint ? { runtime_hint } : {}),
  };
}

export interface ReadJsFunctionArgs {
  session_id: string;
  url: string;
  line: number;
  max_body_chars?: number;
}

/**
 * Given a line inside a JS source, extract the enclosing function: name (if
 * any), params, start/end line, body preview (capped). Uses bracket-matching —
 * no parser. Handles `function(...)` + `function name(...)` + arrow `(...) =>
 * {...}` + expression-body arrows. Returns null when we can't confidently
 * anchor a function around the target line.
 */
export async function readJsFunctionTool(
  args: ReadJsFunctionArgs,
): Promise<{ url: string; slice: JsFunctionSlice | null }> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.url !== 'string' || args.url.length === 0) {
    throw new Error('url is required');
  }
  if (typeof args.line !== 'number' || args.line < 1) {
    throw new Error('line is required (positive integer)');
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id) as unknown as {
    getJsSource?: (s: typeof session, u: string) => Promise<string>;
  };
  if (typeof driver.getJsSource !== 'function') {
    throw new Error('driver does not implement getJsSource');
  }
  const source = await driver.getJsSource(session, args.url);
  // Clamp max_body_chars so a caller passing 9_999_999 can't blow the MCP
  // output budget. Ceiling leaves 4k headroom for url/line/metadata.
  const requestedBodyChars = args.max_body_chars ?? 2000;
  const cappedBodyChars = Math.max(
    200,
    Math.min(Math.floor(requestedBodyChars), MAX_TOOL_OUTPUT_CHARS - 4_000),
  );
  const slice = readJsFunction(source, args.line, cappedBodyChars);
  ringPush(ensureAccumulator(session).readJsFunctionCalls, {
    url: args.url,
    line: args.line,
    at: new Date().toISOString(),
  });
  return { url: args.url, slice };
}

export interface ListLoadedScriptsArgs {
  session_id: string;
}

/**
 * Every JS script URL the page has loaded, as observed in the captured network
 * log. Filtered to `content-type: application/javascript` / `text/javascript` /
 * `.js` URLs. Deduped, ordered by load time.
 */
export async function listLoadedScriptsTool(
  args: ListLoadedScriptsArgs,
): Promise<{ scripts: Array<{ url: string; bytes?: number; loaded_at?: number }> }> {
  if (!args.session_id) throw new Error('session_id is required');
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  const intercepted = await driver.getInterceptedRequests(session).catch(() => []);
  const seen = new Set<string>();
  const out: Array<{ url: string; bytes?: number; loaded_at?: number }> = [];
  for (const req of intercepted) {
    const url = typeof req.url === 'string' ? req.url : '';
    if (!url) continue;
    const ct = (req.headers['content-type'] ?? req.headers['Content-Type'] ?? '').toLowerCase();
    const isJs = ct.includes('javascript') || /\.js(\?|$|#)/.test(url);
    if (!isJs) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const bytes = typeof req.responseBody === 'string' ? req.responseBody.length : undefined;
    out.push({ url, bytes });
  }
  ringPush(ensureAccumulator(session).listLoadedScriptsCalls, {
    at: new Date().toISOString(),
  });
  return { scripts: out };
}

export interface JsEvalArgs {
  session_id: string;
  expression: string;
  timeout_ms?: number;
  /** Optional char offset into the serialized result. Use when a previous
   *  call returned `result_truncated:true` with `result_total_chars` and
   *  `result_hint` — pass `result_offset:<slice_end>` to read the next
   *  chunk. Runs the expression AGAIN, so side-effect-free probes only. */
  result_offset?: number;
  /** Optional max char length of the serialized result slice. Default +
   *  hard cap: budget minus headroom. */
  result_length?: number;
}

/**
 * Evaluate a JS expression inside the live page. The runtime wraps the
 * expression so binary return values (ArrayBuffer, Uint8Array) come back as
 * hex-encoded strings — lets the agent probe encoders that produce bytes
 * without dealing with JSON-serialization holes. Strings, scalars, and plain
 * objects pass through as-is. Blocked in execute_only sessions.
 *
 * This is the primary reverse-engineer probe. Agents use it to verify globals
 * exist, test encoder function calls, and compare expression output byte
 * lengths against captured frames before committing to a `frameFromPage`
 * strategy.
 */
export async function jsEval(args: JsEvalArgs): Promise<
  | ({
      ok: true;
      duration_ms: number;
    } & Record<string, unknown>)
  | { ok: false; error: string }
> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.expression !== 'string' || args.expression.length === 0) {
    throw new Error('expression is required (non-empty string)');
  }
  if (args.expression.length > 4096) {
    throw new Error('expression must be ≤ 4096 chars');
  }
  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 5000, 50), 30_000);
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  const wrapped = wrapAgentExpression(args.expression);
  // Push the call into the accumulator first so failure / timeout still bumps
  // the counter (used by end-drive nag-suppression). Capture the
  // expression text in-memory so the close-time auto-promote pass can match
  // results against captured header values; the field is scrubbed before any
  // artifact-disk write.
  const evalAccumulator = ensureAccumulator(session).jsEvalCalls;
  const evalEntry: (typeof evalAccumulator)[number] = {
    expression_digest: digestSelector(args.expression),
    at: new Date().toISOString(),
    expression: args.expression,
  };
  ringPush(evalAccumulator, evalEntry);
  const t0 = Date.now();
  try {
    const result = await driver.evaluateExpression(session, wrapped, { timeoutMs });
    if (typeof result === 'string' && result.length > 0) {
      // String-shaped result is candidate templating fuel for the close-time
      // auto-promote pass. Object / array / number results are skipped — the
      // pass only matches verbatim string substrings against headers / body.
      evalEntry.result_string = result;
    }
    const guarded = guardLargeResult(result, args.result_offset, args.result_length, 'js_eval');
    // Record string keys/values from the eval result into the session's
    // observation trace. Used at save time by the observed-key gate to
    // distinguish "agent baked an observed property name" (fragile) from
    // "agent baked a stable contract name" (fine). See
    // runtime/src/response/observation-trace.ts.
    recordObservations(session, result);
    // Surface-map: js_eval can mutate `window.location` to drive a SPA
    // navigation. Drain the framenavigated buffer + capture forms so those
    // url_graph nodes / dom_form_observed events land alongside the
    // perform_action pathway. When the eval'd code crossed surfaces (e.g.
    // `window.location.href = '/checkout'` on a /search page), fire the
    // surface_changed checkpoint so the agent re-triages — the same
    // checkpoint that fires when navigation rides perform_action.
    let surfaceCheckpoint: CheckpointEnvelope | undefined;
    try {
      const pending = await driver.consumePendingNavs(session);
      if (pending.length > 0) {
        if (!session.domNavigations) session.domNavigations = [];
        for (const p of pending) {
          session.domNavigations.push({
            at: p.at,
            url: p.url,
            ...(p.title ? { title: p.title } : {}),
            via: 'nav',
          });
        }
        const newest = pending[pending.length - 1];
        if (newest) {
          surfaceCheckpoint = await maybeFireSurfaceChanged(session, newest.url);
        }
      }
      const forms = await driver.captureFormSummary(session);
      if (forms.length > 0) {
        if (!session.domFormsObserved) session.domFormsObserved = [];
        for (const f of forms) session.domFormsObserved.push(f);
      }
    } catch {
      // Surface-map is diagnostic — never fail js_eval because of it.
    }
    return {
      ok: true,
      ...guarded,
      duration_ms: Date.now() - t0,
      ...(surfaceCheckpoint ? { _checkpoint: surfaceCheckpoint } : {}),
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: augmentJsEvalErrorMessage(rawMessage),
    };
  }
}

// Pattern-match common agent-facing js_eval errors and append an actionable
// hint. The raw browser errors are accurate but the actionable next step isn't
// obvious — e.g. "Failed to execute 'json' on 'Response'" means the response
// body was empty or non-JSON; without context the agent may assume the endpoint
// is unreachable instead of checking what came back. Purely additive, preserves
// the original error verbatim.
function augmentJsEvalErrorMessage(raw: string): string {
  if (
    /Failed to execute 'json' on 'Response'/.test(raw) ||
    /Unexpected end of JSON input/.test(raw)
  ) {
    return (
      raw +
      `\n\nHint: a fetch() response body was empty or not JSON. Common causes: the server rejected the request with an empty 204/403 (anti-bot, missing signature, CORS), or responded with an HTML error page (e.g. login redirect). Retry the probe with an error-tolerant shape to see what actually came back:\n` +
      `  const r = await fetch(url, {credentials:"include"});\n` +
      `  return {status: r.status, contentType: r.headers.get("content-type"), body: (await r.text()).slice(0, 500)};\n` +
      `The status + body preview tells you whether the endpoint is unreachable (network error), unauthorized (4xx with a specific error body), or returning the wrong content type.`
    );
  }
  return raw;
}

export interface InstallPageInitScriptArgs {
  session_id: string;
  expression: string;
}

/**
 * Install an agent-supplied expression as a CDP init script — runs on every
 * fresh document, before the page's own bundle, on every navigation. The
 * canonical use is monkey-patching `window.fetch` / `XMLHttpRequest` for
 * capture-on-real-send during RE: a patch installed via one-shot js_eval gets
 * stomped when an SPA bundle re-runs after navigation, but a patch installed
 * here runs first on every new document and survives page transitions.
 *
 * Returns a `handle` the agent can pass to `remove_page_init_script` to
 * disable the wrapper. Note: Playwright does not expose a removal API on
 * `addInitScript`, so removal sets a session-scoped flag the wrapper checks
 * inside its install body — see `runtime/REFERENCE.md` for the canonical
 * fetch-wrapper template that respects this.
 */
export async function installPageInitScript(
  args: InstallPageInitScriptArgs,
): Promise<{ ok: true; handle: string } | { ok: false; error: string }> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.expression !== 'string' || args.expression.length === 0) {
    throw new Error('expression is required (non-empty string)');
  }
  if (args.expression.length > 4096) {
    throw new Error('expression must be ≤ 4096 chars');
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  try {
    const { handle } = await driver.installInitScript(session, args.expression);
    return { ok: true, handle };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RemovePageInitScriptArgs {
  session_id: string;
  handle: string;
}

export async function removePageInitScript(
  args: RemovePageInitScriptArgs,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.handle !== 'string' || args.handle.length === 0) {
    throw new Error('handle is required (non-empty string)');
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  try {
    await driver.removeInitScript(session, args.handle);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tools/types';

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.getJsSource,
    description:
      'Read the source body of a JS script the page has already loaded, windowed around `line` with surrounding context. The fast path for binary-WS / signed-request reverse engineering: `inspect_ws_frame.js_callstack.frames[0]` names the file:line of the encoder; `get_js_source(file, {line: that_line, context_lines: 80})` reads the surrounding source, so you SEE the actual derivations (`epoch_id = Date.now() * 1e6n`, `otid = nextOtid()`, etc.) instead of guessing them from output bytes. Pretty-prints minified single-line bundles before windowing so the slice has structure. Per-session cache means paginated reads share one fetch. Response: `{url, format, total_lines, start_line, end_line, source, truncated?}`.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        url: {
          type: 'string',
          description:
            'Script URL (typically the `file` field of a js_callstack frame). Must be a script the page has already loaded — the fetch runs inside the page context and reuses the browser cache + cookies.',
        },
        line: { type: 'number', description: '1-indexed line to center the window on. Default 1.' },
        context_lines: {
          type: 'number',
          description:
            'Lines of surrounding context (above + below the target line). Default 60, max 200. Combined window is ≤ MCP output budget; oversized requests get `truncated: true`.',
        },
        format: {
          type: 'string',
          enum: ['raw', 'pretty'],
          description:
            'Default "pretty" — single-line minified scripts get split + indented for legibility. Pass "raw" to skip pretty-printing.',
        },
      },
      required: ['session_id', 'url'],
    },
    handler: (args: any) =>
      getJsSource({
        session_id: args.session_id,
        url: args.url,
        line: args.line,
        context_lines: args.context_lines,
        format: args.format,
      }),
  },

  {
    name: TOOL_NAMES.getSendEncoder,
    description:
      'Read the per-ws_i side-channel that the page-side WebSocket.send wrapper stashed at send time. On a matching captured send: `{sent_args_preview, sent_args_type, sent_args_byte_length, ws_url, head_hex, ts, handle_alive, encoder_handle, advice}` — `encoder_handle` is a JS expression like `window.__kluraSendEncoders[471]` addressable via `js_eval` to read `<handle>.ws` (captured WebSocket instance) and `<handle>.sentArgs` (original data passed to send). When no stash entry matches, returns `{encoder: null, reason, advice}` — `reason` is one of `frame_out_of_range` (ws_i past buffer), `frame_received` (not a sent frame — pick a sent one), `wrapper_not_installed` (no WS-using JS on the page yet), `no_matching_fingerprint` (page may have re-wrapped WebSocket.send; fall back to reading encoder source via `get_js_source` with `inspect_ws_frame.js_callstack`). The `advice` field names the best next action for each reason. Pair with `inspect_ws_frame.js_callstack` + `get_js_source` for the reverse-engineer toolkit.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        ws_i: {
          type: 'number',
          description:
            'Index into the captured wsFrames array (same value used for inspect_ws_frame).',
        },
      },
      required: ['session_id', 'ws_i'],
    },
    handler: (args: any) =>
      getSendEncoder({
        session_id: args.session_id,
        ws_i: args.ws_i,
      }),
  },

  {
    name: TOOL_NAMES.searchJsSource,
    description:
      'Substring-search a JS script the page already loaded. Returns `{line, column, preview}` for each hit (max 100). Line numbers are raw-source coordinates matching `Error.stack` and `get_js_source({line})`. Use to find encoder call sites: search for protocol literals observed in captured bytes (e.g. `"/ls_req"`, `"encodeSend"`, a field name from the envelope JSON). Literal-substring only — no regex; run multiple searches when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        url: { type: 'string', description: 'Script URL the page loaded.' },
        pattern: { type: 'string', description: 'Literal substring (≤ 500 chars).' },
        case_sensitive: { type: 'boolean', description: 'Default true.' },
        max_matches: { type: 'number', description: 'Default 20, max 100.' },
      },
      required: ['session_id', 'url', 'pattern'],
    },
    handler: (args: any) =>
      searchJsSourceTool({
        session_id: args.session_id,
        url: args.url,
        pattern: args.pattern,
        case_sensitive: args.case_sensitive,
        max_matches: args.max_matches,
      }),
  },

  {
    name: TOOL_NAMES.readJsFunction,
    description:
      'Given a line inside a JS source, extract the enclosing function: name, params, start/end line, body preview (default 2000 chars cap). Handles `function(...)`, `function name(...)`, and arrow functions. Use after `search_js_source` finds a candidate call site — read ONE function instead of windowing source with guessed line ranges.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        url: { type: 'string' },
        line: { type: 'number', description: 'Raw-source line (1-indexed).' },
        max_body_chars: { type: 'number', description: 'Default 2000.' },
      },
      required: ['session_id', 'url', 'line'],
    },
    handler: (args: any) =>
      readJsFunctionTool({
        session_id: args.session_id,
        url: args.url,
        line: args.line,
        max_body_chars: args.max_body_chars,
      }),
  },

  {
    name: TOOL_NAMES.listLoadedScripts,
    description:
      'List every JS script URL the page loaded, observed via the captured network log. Filtered to JS content-types, deduped, in load order. Use when the `inspect_ws_frame.js_callstack` bundle turns out not to contain the encoder — widen the search to other bundles.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
    handler: (args: any) => listLoadedScriptsTool({ session_id: args.session_id }),
  },

  {
    name: TOOL_NAMES.jsEval,
    description:
      'Evaluate a JS expression inside the live page and return the result. Binary values (ArrayBuffer, Uint8Array) come back as hex strings automatically — no JSON-serialization holes. Strings, numbers, and plain objects pass through. Use this to probe the page during discovery: verify globals exist, inspect module registries, call encoder functions with sample args, compare output byte lengths against captured frames. This is the primary reverse-engineer probe — pair it with `search_js_source` + `read_js_function` + `get_js_source` to locate and verify the encoder path before committing to a `frameFromPage` strategy. Blocked in `execute_only` sessions (warm-measurement mode). Timeout default 5000ms, max 30000. Expression cap 4096 chars.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        expression: { type: 'string', description: 'JS expression. Async OK (runtime awaits).' },
        timeout_ms: { type: 'number', description: 'Max wall-clock ms. Default 5000, max 30000.' },
      },
      required: ['session_id', 'expression'],
    },
    handler: (args: any) =>
      jsEval({
        session_id: args.session_id,
        expression: args.expression,
        timeout_ms: args.timeout_ms,
        result_offset: args.result_offset,
        result_length: args.result_length,
      }),
  },

  {
    name: TOOL_NAMES.installPageInitScript,
    description:
      "Install a JS expression that runs on every fresh document — before the page's own bundle, on every navigation. Wraps Playwright `addInitScript` (CDP `Page.addScriptToEvaluateOnNewDocument`). Canonical use: monkey-patch `window.fetch` / `XMLHttpRequest` for capture-on-real-send during RE on SPA sites where a one-shot `js_eval` patch would be stomped when the bundle re-runs after navigation. The agent's wrapper runs first; the page's own wrappers wrap the agent's, so the agent gets visibility into every send across navigations. Returns `{handle}` for `remove_page_init_script`. See klura://reference#reverse-engineer-playbook for the canonical fetch-wrapper template. Blocked in execute_only mode. Expression cap 4096 chars.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        expression: {
          type: 'string',
          description:
            'JS expression to run on every fresh document. Wrapped in an async IIFE; runs once per page bootstrap.',
        },
      },
      required: ['session_id', 'expression'],
    },
    handler: (args: any) =>
      installPageInitScript({
        session_id: args.session_id,
        expression: args.expression,
      }),
  },

  {
    name: TOOL_NAMES.removePageInitScript,
    description:
      "Disable a previously-installed page init script by handle. Best-effort: Playwright does not expose a removal API on `addInitScript`, so the runtime adds the handle to a session-scoped removed-set; the wrapper checks this set on every navigation and short-circuits. Already-running wrappers in the current page also notice via an in-page `__klura_init_removed` set. The init script itself remains installed for the browser context's lifetime, but its body is a no-op once removed.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        handle: { type: 'string', description: 'Handle returned from `install_page_init_script`.' },
      },
      required: ['session_id', 'handle'],
    },
    handler: (args: any) =>
      removePageInitScript({
        session_id: args.session_id,
        handle: args.handle,
      }),
  },
];
