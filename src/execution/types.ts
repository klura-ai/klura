// Shared strategy + step + result interfaces used across the execution
// subsystem. Hoisted out of execution.ts so every submodule can import types
// without pulling values.

import type { BrowserPool } from '../drivers/types/session';
import type { StrategyNotes } from '../strategies/skills';
import type { GeneratorEntry } from '../strategies/generators';
import type { JsEvalReturnShape } from '../strategies/js-eval-validators';

export type AnyPool = BrowserPool;

export interface ResponseExtractSpec {
  selector: string;
  attr?: string;
  multiple?: boolean;
}

export interface ResponseSpec {
  format?: 'json' | 'html';
  extract?: Record<string, ResponseExtractSpec>;
}

// Shared shape for HTTP-class strategies. `fetch` and `page-script` differ only
// in which transport owns the request (Node vs in-browser) and a couple of
// tier-specific fields (response extraction for fetch, origin hint for
// page-script). Prereqs run BEFORE the main call in both.
interface HttpStrategyBase {
  method?: string;
  endpoint: string;
  baseUrl: string;
  contentType?: 'json' | 'form';
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  params?: Record<string, unknown>;
  prerequisites?: Prerequisite[];
  generated?: Record<string, GeneratorEntry>;
  notes?: StrategyNotes;
  [key: string]: unknown;
}

export interface FetchStrategy extends HttpStrategyBase {
  strategy: 'fetch';
  response?: ResponseSpec;
}

export interface PageScriptStrategy extends HttpStrategyBase {
  strategy: 'page-script';
  origin?: string;
}

export interface Prerequisite {
  name: string;
  /**
   * - `cached`: read a token from the cache (or fall back to a static value)
   * - `browser`: run an explicit list of steps (navigate/click/type/extract)
   * - `page-extract`: declarative one-shot — navigate to `url`, extract every
   *   entry in `vars` from the loaded page, return them as tokens.
   * - `fetch-extract`: make a non-browser HTTP request to `url`, parse the
   *   JSON response, extract values via dot-path. Use for resource-ID
   *   lookups like `GET /repos/{owner}/{repo} → node_id` where the id isn't
   *   rendered in any DOM selector but IS returned by a simple REST call.
   * - `js-eval`: run a short JS expression inside a live page context
   *   (`await window.foo.mint()`), validate the return value against a
   *   declared shape, and bind the serialized result to `binds`. Use
   *   when the value is produced by a JS function call rather than
   *   rendered into the DOM — the only case `page-extract` can't handle.
   * - `capability`: recursively call another saved klura strategy as a
   *   prereq. The caller declares `capability` (the slug to invoke),
   *   optional `platform` (defaults to caller's), optional `args` (with
   *   {{placeholder}} substitution against caller's tokens + args), and
   *   required `binds` (the key name to bind the sub-execute result
   *   under in the caller's tokens namespace). Enables name→id lookup
   *   chains: `send_message(name, text)` declares a capability prereq
   *   on `lookup_thread_by_name(name)` that produces `thread_id`.
   *
   * Field is `kind` (not `method`) — `method` is reserved for the HTTP verb on
   * fetch-extract prereqs and on top-level fetch/page-script strategies.
   */
  kind: 'browser' | 'cached' | 'page-extract' | 'fetch-extract' | 'js-eval' | 'capability' | 'tag';
  value?: string;
  // browser-kind:
  steps?: Array<{
    action: 'navigate' | 'extract' | 'click' | 'type';
    url?: string;
    selector?: string;
    attribute?: string;
    as?: string;
    value?: string;
  }>;
  // page-extract / fetch-extract / capability — `vars` is `unknown`-shaped at
  // the type level because it arrives from a JSON file written by the LLM and
  // we runtime-validate it when we actually read the entries. page-extract
  // entries are `{selector, attr?}` objects; fetch-extract and capability
  // entries are strings (dot-paths into the JSON response, binding the
  // extracted value under the entry's key).
  url?: string;
  vars?: Record<string, unknown>;
  ttl?: number | null;
  // fetch-extract specific:
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers_map?: Record<string, string>;
  fetch_body?: Record<string, unknown>;
  // js-eval specific:
  expression?: string;
  binds?: string;
  return_shape?: JsEvalReturnShape;
  timeout_ms?: number;
  refresh?: { enabled?: boolean; interval_seconds?: number; jitter_seconds?: number };
  // Per-call payload exposed to the expression as the `args` identifier.
  // Templated against the caller scope at execute time. Presence of this
  // field switches js-eval into per-call mode — cache + refresh are skipped
  // (mutually exclusive at save-time validation).
  args_template?: Record<string, unknown>;
  // CSS selector for an iframe element on the page. When set, the expression
  // evaluates inside the iframe's contentFrame instead of the main frame —
  // needed when the global the expression names lives in a cross-origin
  // iframe and is therefore unreachable from main-world script.
  frame?: string;
  // capability-method specific:
  capability?: string; // target slug (required when kind === 'capability')
  platform?: string; // defaults to caller's platform
  args?: Record<string, unknown>; // passed to the recursive execute(); supports {{placeholders}}
  optional?: boolean; // if true, failed sub-execute binds null instead of throwing
  // tag-method specific. The runtime scans the platform's saved capabilities
  // at execute time, picks the unique one that advertises this tag in its
  // top-level `provides: [...]` declaration, and delegates to capability
  // resolution. If 0 or 2+ capabilities advertise the tag, resolution throws
  // with a disambiguation pointer.
  tag?: string;
}

export interface RecordedPathStep {
  /**
   * Stable slug id for the step. Required at save-time — the handle
   * `patch_step` uses and the target `notes.discovered_at_step_id`
   * references. Must match /^[a-z][a-z0-9_]{2,39}$/ and not be a reserved
   * word (id, init, end, start, finish, step). See
   * klura://reference#recorded-path-schema.
   */
  id: string;
  action: 'navigate' | 'click' | 'type' | 'fill_editor' | 'select' | 'wait' | 'key_press';
  url?: string;
  selector?: string;
  locators?: Locators;
  value?: string;
  /**
   * For `action: "key_press"` — the key or chord to send, matching Playwright's
   * page.keyboard.press() syntax (e.g. "Enter", "Escape", "Control+End",
   * "Tab"). Focus-relative: an earlier step usually clicks the target field
   * first, and the keypress goes to whatever element currently has focus.
   */
  key?: string;
  condition?: string;
  // For condition: 'selector' — CSS selector to wait for
  waitSelector?: string;
  timeout?: number;
  /**
   * Optional steps are "click if visible" semantics — cookie banners, tutorial
   * dismisses, notification-permission prompts, one-time modals. The runtime
   * probes the locator with a short timeout and, if nothing resolves, skips
   * silently and moves to the next step. On warm replay where cookie-jar
   * persistence suppresses the banner, an optional step is a no-op instead of a
   * healable blocker. Only meaningful for click/type/select; navigate and wait
   * ignore it.
   */
  optional?: boolean;
  /**
   * Page handle the step targets. `"main"` (default, omitted) drives the page
   * the session opened with. `"popup-N"` drives a popup observed during
   * discovery — replay waits briefly for the popup to open if a prior step
   * was supposed to trigger it, then routes the action through
   * `driver.<method>(session, ..., {page: 'popup-N'})`. See
   * klura://reference#popups.
   */
  page?: string;
}

export interface RecordedPathStrategy {
  strategy: 'recorded-path';
  steps: RecordedPathStep[];
  /**
   * Optional post-navigation extract. After the last step completes, the
   * runtime reads the page's serialized HTML via `driver.getPageHtml` and pipes
   * it through the cheerio selector helper to produce a structured body.
   * Mirrors the `response: {format: 'html', extract: {...}}` shape already used
   * by fetch. Without this field, recorded-path warm execute returns `{ok,
   * url}` and the agent has to read the page itself — useful for mutation
   * flows, useless for data-extraction ones. See
   * REFERENCE.md#recorded-path-schema for when to use it.
   */
  response?: ResponseSpec;
  [key: string]: unknown;
}

export interface Locators {
  a11y?: { role: string; name?: string };
  css?: string;
  visual?: { description: string };
  alternatives?: Array<{ a11y?: { role: string; name?: string }; css?: string }>;
}

// Structural shape shared by FetchStrategy and PageScriptStrategy — and by the
// synthetic direct-shaped strategy the assisted path builds after running
// prereqs. The helpers only read the fields they need to build the request, so
// widening the input type avoids forcing callers through a cast.
export type RequestStrategy = {
  method?: string;
  endpoint: string;
  baseUrl: string;
  contentType?: 'json' | 'form';
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  params?: Record<string, unknown>;
  generated?: Record<string, GeneratorEntry>;
  response?: ResponseSpec;
};

export interface ExecuteResult {
  status: number;
  body: unknown;
  // Final URL after fetch redirects (fetch only). Used to detect auth failures
  // that show up as 200 OK on a /login page rather than 401.
  finalUrl?: string;
  // Wall-clock of the entire execute() call, including any prerequisite
  // bootstrap. Stamped on successful returns. Consumers (CLI green-text moment,
  // telemetry) read this to show warm-run latency.
  elapsedMs?: number;
  // Which strategy tier actually produced the successful result.
  tier?: 'fetch' | 'page-script' | 'recorded-path';
  // Which transport fired the final request — `'node'` for pure-Node fetch,
  // `'browser'` for in-browser fetch. The (tier, transport) pair is the honest
  // "run 1 → run 2 cliff" unit: fetch/node is the ~100ms cell on the race
  // dashboard, fetch/browser is ~10s. Undefined when the result is an
  // early-exit (policy violation, needs_generation, etc.) that never actually
  // fired a request.
  transport?: 'node' | 'browser';
  // Which wire protocol fired — `'http'` for every HTTP tier, `'websocket'` for
  // ws strategies. Together with tier/transport this gives the full (tier,
  // protocol, transport) signature of the execute path.
  protocol?: 'http' | 'websocket';
}

// WebSocket-shaped strategy view. When `protocol: 'websocket'` is set on a
// fetch / page-script strategy, the executor reads these fields instead of the
// HTTP ones (which the save-time validator rejects). Shape is orthogonal to
// `transport`: transport='browser' dials through the page-side registry
// (`driver.sendWebSocketFrame`); transport='node' opens a fresh WebSocket via
// the `ws` package.
export interface WebSocketStrategy {
  strategy: 'fetch' | 'page-script';
  protocol: 'websocket';
  /** HTTP(S) URL the page is loaded from — required unless wsOpen:'none'.
   *  Matches the HTTP `Origin` header. Rejected if the on-disk strategy
   *  uses `baseUrl`; see validate.ts. */
  origin?: string;
  wsUrl: string;
  /** String template sent verbatim after {{placeholder}} substitution. */
  frame?: string;
  /** Generator block — use when the frame layout depends on content-length
   *  prefixes (MQTT-class). Evaluated identically to HTTP `generated.*`. */
  frameEncoding?: 'text' | 'binary';
  /** Frame produced by evaluating a JS expression in the live page. Only
   *  valid for page-script (the page is the execution context). The
   *  expression is interpolated with {{args}} + prereq bindings, then run
   *  via driver.evaluateExpression. Result is a hex or base64 string; the
   *  runtime decodes to bytes before sendWebSocketFrame. */
  frameFromPage?: {
    expression: string;
    returns: 'hex' | 'base64';
    timeout_ms?: number;
  };
  ackMatch?: string;
  ackTimeoutMs?: number;
  wsOpen?: 'navigate' | 'none' | { steps: RecordedPathStep[] };
  wsOpenTimeoutMs?: number;
  /** Only meaningful for the `fetch` tier (Node dial) — forwarded as
   *  handshake headers. Ignored by the page-script transport (the page
   *  already owns the handshake). */
  wsHeaders?: Record<string, string>;
  method?: string;
  notes?: StrategyNotes;
  generated?: Record<string, GeneratorEntry>;
  prerequisites?: Prerequisite[];
  [key: string]: unknown;
}
