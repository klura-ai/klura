import type { InterceptedRequest } from './types/network';
import type { WebSocketFrame, WebSocketFrameStream } from './types/websocket';
import type { Session, SessionOptions, FocusListener, SubPagesListener } from './types/session';
import type { DebuggerLocation, DebuggerPause } from './types/debugger';

/**
 * Optional page-handle selector for action and inspection methods. Default
 * (omitted or `'main'`) targets the page the session opened with; pass an id
 * from `session.subPages[].id` (e.g. `'popup-1'`) to act on a tracked sub-
 * page. Drivers without sub-page support throw on a non-default handle.
 */
export interface PageOpts {
  page?: string;
}

export const CAPABILITIES = [
  'dom_selectors',
  'network_intercept',
  'screenshots',
  'storage_state',
  'remote_view',
  'file_download',
  'mouse_coordinates',
  'multi_context',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export abstract class BrowserDriver {
  abstract get capabilities(): readonly Capability[];

  hasCapability(name: Capability): boolean {
    return this.capabilities.includes(name);
  }

  /**
   * Init-script registry. Drivers that install scripts on every fresh document
   * (fingerprint patches, instrumentation, telemetry) call `registerInitScript`
   * from their constructor; the concrete driver iterates this list during
   * session creation and applies each entry via the underlying engine's init-
   * script API (`context.addInitScript` for Playwright). Subclasses register
   * their own scripts by calling `super()` then `this.registerInitScript(...)`.
   */
  protected initScripts: Array<{ name: string; source: string }> = [];

  protected registerInitScript(name: string, source: string): void {
    this.initScripts.push({ name, source });
  }

  abstract createSession(options?: SessionOptions): Promise<Session>;
  abstract destroySession(session: Session): Promise<void>;

  /**
   * Reset an existing session on an already-running backend without tearing
   * down the underlying browser. Called by warm-pool implementations when
   * reusing a backend across klura sessions. The driver should:
   *
   * - clear ephemeral per-session state (network log, interception,
   *   websocket listeners, focus tracker state),
   * - layer any newly-provided `storageState` onto the existing browser
   *   context via `addCookies` (the persistent profile's cookies
   *   survive by design),
   * - navigate to a neutral page (`about:blank`) to cancel pending
   *   network activity and reset page-level state,
   * - leave `ready`/`browser`/`context`/`page` alive.
   *
   * Default is a no-op — adequate for the in-process Playwright driver, whose
   * shared-driver model already reuses the same browser across sessions and
   * spawns a fresh context per `createSession`.
   */
  async resetSession(_session: Session, _options: SessionOptions = {}): Promise<void> {
    // no-op by default
  }

  /**
   * Lightweight, side-effect-free readiness check for the pool's ready-page
   * checkout protocol (`pool.tryCheckoutReadySession`). Returns what the page
   * currently looks like so the caller can decide whether its session is
   * reusable verbatim (no navigate, no WS handshake) — the "warm-page"
   * optimization that gets `executeFetch` / `executeWebSocket` down to
   * sub-200ms on repeat calls.
   *
   * Required signals:
   *  - `page_on_url`: `true` iff `page.url().startsWith(urlPrefix)`. All
   *    reusable sessions care about this — it means cookies are seeded
   *    and any scripts baked into the origin have already run.
   *  - `ws_open`: `true` iff `wsUrlPrefix` is provided AND the page-side
   *    WebSocket registry has at least one OPEN (`readyState === 1`)
   *    socket whose URL starts with that prefix. Only meaningful for
   *    transports that rely on a persistent page WebSocket. Undefined
   *    when `wsUrlPrefix` is omitted (the caller doesn't need it).
   *
   * MUST NOT navigate, MUST NOT mutate DOM, MUST NOT throw for ordinary "nope
   * not ready" states — the protocol treats throws as false. Drivers that can't
   * answer the question return `{page_on_url: false}` so the caller falls back
   * to cold spawn.
   *
   * Future readiness signals (cookie age, auth state, fingerprint) plug into
   * the same return shape via optional fields.
   */
  probePageReady(
    _session: Session,
    _urlPrefix: string,
    _wsUrlPrefix?: string,
  ): Promise<{ page_on_url: boolean; ws_open?: boolean }> {
    return Promise.resolve({ page_on_url: false });
  }

  abstract navigate(
    session: Session,
    url: string,
    options?: { waitUntil?: 'commit' | 'domcontentloaded' | 'networkidle' },
  ): Promise<void>;
  abstract waitForNavigation(session: Session, options?: { timeout?: number }): Promise<void>;

  /** Click the element resolved from `selector`. Returns the element's
   *  accessible name captured just before the click fires (textContent,
   *  aria-label, title, or placeholder — whatever the a11y tree would
   *  surface as the "name"). The correlator uses this to label
   *  `ParamObservation`s when an XHR fires shortly after the click —
   *  "user clicked <name>, and this XHR followed" — so agents see
   *  human-visible labels ("Taste the pride of Napoli") rather than CSS
   *  selectors in `observed_values`. Returns `null` when the element has
   *  no extractable name or resolution failed (soft-fail: click itself
   *  still awaits the real locator). */
  abstract click(
    session: Session,
    selector: string,
    opts?: PageOpts,
  ): Promise<{ name?: string } | undefined>;
  /**
   * Type `text` into the element resolved by `selector`.
   *
   * Default behavior matches human typing: the cursor lands at the end of any
   * existing content and the value is APPENDED. For empty fields this is
   * identical to clear-and-fill (the common login-form path).
   *
   * Pass `opts.replace: true` to force a clear-then-set (Playwright's
   * `locator.fill`) regardless of current content — rare; useful for
   * corrections where the agent explicitly intends to wipe the field.
   */
  abstract type(
    session: Session,
    selector: string,
    text: string,
    opts?: { replace?: boolean } & PageOpts,
  ): Promise<void>;
  abstract select(
    session: Session,
    selector: string,
    value: string,
    opts?: PageOpts,
  ): Promise<void>;
  abstract getText(session: Session, selector: string, opts?: PageOpts): Promise<string>;
  abstract getAccessibilityTree(session: Session, opts?: PageOpts): Promise<string>;

  /** Current top-level frame URL. */
  abstract getUrl(session: Session, opts?: PageOpts): Promise<string>;

  /** Sleep inside the browser's event loop for `ms` milliseconds. */
  abstract delay(session: Session, ms: number): Promise<void>;

  /** Block until a selector matches or the timeout elapses. */
  abstract waitForSelector(
    session: Session,
    selector: string,
    options?: { timeout?: number } & PageOpts,
  ): Promise<void>;

  /**
   * Read an attribute off the first element matching the selector. Returns an
   * empty string if the attribute is absent. Used for CSRF/auth token
   * extraction in fetch prerequisites.
   */
  abstract getAttribute(
    session: Session,
    selector: string,
    attr: string,
    opts?: PageOpts,
  ): Promise<string>;

  /**
   * Scan the current page for elements whose text content OR any attribute
   * value contains `needle`. Returns a list of matches with enough info for the
   * caller to turn them into a page-extract selector. Used during discovery to
   * trace opaque values seen in captured request bodies back to their DOM
   * source — the agent sees a value like `v2:<uuid>` in a POST body, calls
   * `findInPage(session, "v2:<uuid>")`, and gets back the meta tag or hidden
   * input that rendered it. Also supports searching for substrings and
   * numeric/alphanumeric fragments, which is how the agent connects a
   * base64-encoded body field to the numeric id rendered on the page.
   *
   * Implementations cap the returned list at `limit` (default 20) and truncate
   * long attribute values. Searches are case-sensitive.
   */
  abstract findInPage(
    session: Session,
    needle: string,
    limit?: number,
    opts?: PageOpts,
  ): Promise<Array<{ selector: string; attr?: string; value: string }>>;

  /**
   * Run a fetch() from inside the page context so the browser's cookies, sec-*
   * headers, and JS-set origin are applied. Used by the fetch executor (when it
   * falls back from Node) and the page-script executor. Deliberately narrow —
   * no generic evaluate() escape hatch, since that would let callers hardcode
   * backend-specific JS and tie the runtime to a single browser automation
   * engine.
   *
   * `credentials` maps directly to the fetch API:
   * - `"include"` (default): send cookies even cross-origin. Required for
   *   fetch / page-script main calls to authenticated
   *   endpoints that rely on browser session cookies.
   * - `"omit"`: never send cookies. Use for cross-origin public API lookups
   *   (fetch-extract prereqs). CORS spec **rejects** any response with
   *   `Access-Control-Allow-Origin: *` when credentials are included, so
   *   public API calls MUST use `"omit"`.
   * - `"same-origin"`: send cookies only on same-origin requests.
   */
  abstract fetchInBrowser(
    session: Session,
    url: string,
    options: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      credentials?: 'include' | 'omit' | 'same-origin';
    },
  ): Promise<
    | { ok: true; status: number; body: unknown; finalUrl: string }
    | {
        ok: false;
        error: string;
        /** Browser-side context captured on fetch failure. Surfaces
         *  same-origin vs cross-origin mismatches and credentials-mode
         *  decisions to the caller when "Failed to fetch" fires. */
        diagnostics?: {
          page_origin: string;
          page_url: string;
          target_url: string;
          target_origin: string | null;
          cross_origin: boolean;
          credentials_mode: string;
        };
      }
  >;

  /**
   * Evaluate a short JS expression inside the live page context and return its
   * JSON-serialized result. Used by `js-eval` fetch prereqs: the LLM emits an
   * async-compatible expression (`await window.foo.mint()`,
   * `document.querySelector('meta[name=x]')?.content`), the runtime wraps it in
   * an async IIFE, the driver runs it, and the returned value gets bound as a
   * token slot after shape validation.
   *
   * **Narrow by design.** This is NOT a generic `evaluate()` escape hatch — it
   * only accepts an expression (not a function body, not statements) and times
   * out on the caller's budget. The LLM's expression is validated structurally
   * before it gets here (see `asBoundedScript` in `validators.ts`) and
   * semantically at save time by the strategy probe. Runtime implementations
   * must reject expressions containing a raw `return` statement to prevent
   * agents from smuggling in function-body shapes.
   *
   * **Optional `args`.** A plain JSON-serializable object passed to the
   * expression as the `args` identifier. Lets a per-call signer prereq read
   * the request body it has to sign — `await window.__sig.mint(args.body)`.
   * The values are structured data, not code: they cross the driver boundary
   * via Playwright's serialized-args path, so an agent cannot smuggle in
   * functions or DOM references this way. When omitted, `args` is undefined
   * inside the expression.
   *
   * **Optional `frame`.** A CSS selector resolving an `<iframe>` element on
   * the page. When set, the expression evaluates inside the iframe's
   * contentFrame instead of the main frame — needed when the global the
   * expression names lives in a cross-origin iframe and is therefore
   * unreachable from main-world script. The runtime locates the iframe
   * element via `page.locator`, waits briefly for it to attach, and
   * dispatches `frame.evaluate`.
   *
   * Resolves with the expression's value, JSON-serialized through the driver
   * boundary. Rejects with a caller-readable error on:
   * - timeout expiry (message includes the timeout)
   * - syntax errors in the expression
   * - runtime exceptions thrown by the expression
   * - navigation away from the page mid-evaluation
   * - `frame` selector not resolving to an `<iframe>` element with a
   *   reachable contentFrame
   */
  abstract evaluateExpression(
    session: Session,
    expression: string,
    options: {
      timeoutMs: number;
      args?: Record<string, unknown>;
      frame?: string;
    } & PageOpts,
  ): Promise<unknown>;

  /**
   * Install an agent-supplied JavaScript expression that runs on every fresh
   * document — before the page's own bundle, on every navigation. Wraps the
   * underlying CDP `Page.addScriptToEvaluateOnNewDocument` (Playwright:
   * `context.addInitScript`).
   *
   * Use case: monkey-patching `window.fetch` / `XMLHttpRequest` for
   * capture-on-real-send during RE. A patch installed via one-shot `js_eval`
   * gets stomped when an SPA bundle re-runs after navigation; a patch
   * installed here runs first on every new document, so the page's own
   * wrappers wrap the agent's wrapper, and the agent gets visibility into
   * every send across navigation boundaries.
   *
   * The expression goes through the same syntax pre-validation and length
   * cap as `evaluateExpression`. The handle returned identifies the script
   * for `removeInitScript`. Note: Playwright does not expose a removal API
   * on `addInitScript`, so removal is best-effort — the runtime tracks the
   * handle → expression map and the wrapper checks a session-scoped flag,
   * but the install itself persists on the browser context for its
   * lifetime.
   */
  abstract installInitScript(session: Session, expression: string): Promise<{ handle: string }>;

  /**
   * Mark a previously-installed init script as inactive. Best-effort: see
   * `installInitScript` for the Playwright limitation. The runtime stores
   * a session-scoped removed-handles set; a session-scoped check inside
   * the install wrapper short-circuits when the handle has been removed.
   */
  abstract removeInitScript(session: Session, handle: string): Promise<void>;

  /**
   * Parse a raw HTML string and produce an ariaSnapshot-compatible tree
   * suitable for running through the existing trimA11yTree pipeline. Used by
   * the oversized-body fallback in execute(): when a fetch GET returns an HTML
   * page that blows the MCP tool output budget and the agent didn't declare
   * `response.format: "html"`, we hand them a trimmed structural summary of the
   * page instead of a dead `response_too_large`, so they can pick selectors and
   * re-save.
   *
   * Why not use Playwright's real ariaSnapshot?
   * ------------------------------------------ The "obvious" approach is
   * `page.setContent(html)` followed by `page.locator(':root').ariaSnapshot()`,
   * which gives you Chromium's canonical accessibility tree — computed roles,
   * resolved ARIA references, hidden-element filtering, everything. We
   * explicitly don't do that, for two reasons:
   *
   *   1. `setContent` runs inline scripts. Any analytics beacon,
   *      tracking pixel, or state mutation shipped in the fetched HTML
   *      fires inside the ephemeral execute() session. These side
   *      effects are silent, unobservable to the agent, and happen on
   *      every oversized-body fallback — exactly the path we reach
   *      when something has already gone wrong.
   *   2. `setContent` clobbers the current page. The fetched HTML
   *      takes over the session's live page state; anything the
   *      caller was about to do with the session (save cookies, check
   *      URL, navigate somewhere else) now sees the fallback page
   *      instead of what it expected. Works today inside executeDirect
   *      where the session is torn down immediately after, but is a
   *      landmine for any future caller that reuses this helper on a
   *      live session.
   *
   * The DOMParser path is fully inert: no scripts, no network, no page
   * mutation, no setContent. We lose computed ARIA (`role="button"` on a div
   * comes through as `div`, `aria-labelledby` isn't resolved, `aria-hidden`
   * isn't filtered) but for the "give the agent enough signal to read the page
   * and pick selectors" case, tag-based output is clean enough. Semantic HTML
   * (nav/main/header/footer/form/etc.) is mapped to the same role names
   * `trimA11yTree`'s landmark collapse already knows, so Pass D bites
   * unchanged.
   *
   * Output format matches Playwright's aria-snapshot YAML:
   *
   *   - <role>[ "<name>"][:]      # node line, children at deeper indent
   *     - /attr: <value>          # attribute child line (href, etc.)
   *
   * Return: the serialized tree as a single string, ready to hand to
   * `trimA11yTree(tree, MAX_TOOL_OUTPUT_CHARS)`.
   */
  /**
   * Return the live page's serialized HTML content. Used by the recorded- path
   * post-navigation extract path, which runs after the step loop has finished
   * and wants to pull structured fields out of the final DOM via cheerio.
   * Equivalent to Playwright's `page.content()`.
   */
  abstract getPageHtml(session: Session, opts?: PageOpts): Promise<string>;

  abstract htmlToAriaLikeTree(session: Session, html: string): Promise<string>;

  abstract screenshot(session: Session, opts?: PageOpts): Promise<string>;
  abstract screenshotJpeg(session: Session, quality?: number, opts?: PageOpts): Promise<Buffer>;
  abstract startIntercepting(session: Session): void | Promise<void>;
  abstract getInterceptedRequests(session: Session): Promise<InterceptedRequest[]>;

  /**
   * Return the always-on WebSocket frame buffer for the session. Populated by
   * the driver's session-creation hook (see `wsFrames` on the Session
   * interface). Default implementation returns `session.wsFrames ?? []` —
   * drivers that want custom behavior (e.g. remote driver proxying to a
   * different buffer) can override.
   */
  getInterceptedWebSocketFrames(session: Session): Promise<WebSocketFrame[]> {
    return Promise.resolve(session.wsFrames ?? []);
  }

  /**
   * Drain the driver-side buffer of frame-level navigations the page committed
   * since the last drain. Source: a `framenavigated` listener on the active
   * page (Playwright). Each entry represents a top-level URL change that
   * wasn't already attributed to an explicit `driver.navigate()` call — i.e.
   * SPA route changes from clicks, form submits that landed on a new URL,
   * `history.pushState` / `replaceState` / `popstate` / `hashchange`,
   * server-sent redirects after an XHR.
   *
   * When the driver knows the precise transition kind (e.g. an in-page
   * binding fired by an `addInitScript` patch on `history.pushState`),
   * it sets `via` on the entry. Otherwise the perform_action consumer
   * derives `via` from the action that triggered the surrounding tool
   * call (`click`, `submit`, `nav`). Drivers without a page-event
   * surface return an empty array.
   */
  consumePendingNavs(_session: Session): Promise<
    Array<{
      at: number;
      url: string;
      title?: string;
      via?: 'pushState' | 'replaceState' | 'popstate' | 'hashchange';
    }>
  > {
    return Promise.resolve([]);
  }

  /**
   * Snapshot the `<form>` elements present in the active page's main document.
   * Returns one entry per form: `{url, action, method, fields}` where fields
   * collects every named element under `form.elements`. Called by index.ts
   * after `start_session`'s initial navigation and after every successful
   * `perform_action` so SPA route changes that introduce new forms are
   * captured. Drivers without a page evaluation surface return an empty array.
   */
  captureFormSummary(_session: Session): Promise<
    Array<{
      at: number;
      url: string;
      action: string;
      method: string;
      fields: Array<{ name: string; type: string; required?: boolean }>;
    }>
  > {
    return Promise.resolve([]);
  }

  /**
   * Snapshot an action target's structural shape so the runtime can decide
   * whether the action would mutate state. Read-only — no DOM writes, no
   * navigation. Returns `null` when the selector resolves to nothing or the
   * driver can't introspect (e.g. transport-only drivers). Used by the
   * map-mode side-effect consent gate to exempt structurally-safe shapes
   * (anchor navigation, plain text input fills) from the per-tuple ack.
   */
  /**
   * Look up an element by accessible role and (optionally) name, requiring a
   * unique match. Used by warm-execute self-heal: when every captured locator
   * for a recorded-path step has failed, the step loop calls this with the
   * step's captured `{role, name}` to see if the live page still has a single
   * element matching the role. Returns the matched element's accessible name
   * (so the heal layer can rebuild a Playwright role= selector against the
   * current label) only when `count === 1`; null otherwise. Drivers without an
   * a11y surface return null.
   *
   * `nameMatch`:
   *  - `'substring'` — case-insensitive substring (Playwright `getByRole`
   *    `exact: false`). Catches whitespace/case/extension drift on the name.
   *  - `'any'` — ignore the name attribute entirely. Catches semantic renames
   *    on pages where the role uniquely identifies the element.
   *
   * Read-only — no DOM writes, no navigation.
   */
  findByRoleTolerant(
    _session: Session,
    _role: string,
    _name: string | undefined,
    _nameMatch: 'substring' | 'any',
    _opts?: PageOpts,
  ): Promise<{ accessibleName: string | null } | null> {
    return Promise.resolve(null);
  }

  inspectActionTarget(
    _session: Session,
    _selector: string,
  ): Promise<{
    tag: string;
    href: string | null;
    onclick: string | null;
    formaction: string | null;
    /** Lowercase `type` attribute for `<input>` elements (default "text" when
     *  unset). Empty string for non-input tags. Lets the gate distinguish
     *  plain text fills from password / file / hidden inputs. */
    inputType: string;
    /** True when the target sits inside a `<form method=POST>` (or PUT/DELETE/
     *  PATCH). GET forms and form-less elements are false. */
    inWriteForm: boolean;
    /** True when clicking would submit a form: `<button>` (default type=submit
     *  in form), `<input type=submit|image>`, or any element with a
     *  `formaction` attribute. */
    submitLike: boolean;
  } | null> {
    return Promise.resolve(null);
  }

  /**
   * Report whether any WebSocket in the page's registry whose URL starts with
   * `urlPrefix` is currently in readyState OPEN. Used by
   * `executeWebSocketBrowser` to poll for WS availability before triggering
   * `wsOpen.steps` fallback. Default implementation returns false — drivers
   * that don't maintain a page-side registry (e.g. a future non-browser driver)
   * fail over to the fallback paths.
   */
  hasOpenWebSocket(_session: Session, _urlPrefix: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * Send `payload` on a live page WebSocket whose URL starts with `urlPrefix`.
   * Used by `executeWebSocketBrowser` for `protocol:'websocket' on the
   * page-script tier` strategies. Encoding is 'text' or 'binary' (base64
   * payload that gets decoded to Uint8Array before send). Drivers without a
   * page context (e.g. a future transport-only driver) should throw; the
   * default implementation throws so an accidental unsupported call fails
   * loudly instead of silently no-op-ing.
   */
  sendWebSocketFrame(
    _session: Session,
    _urlPrefix: string,
    _payload: string,
    _opts?: { encoding?: 'text' | 'binary' },
  ): Promise<{ ok: boolean; error?: string }> {
    throw new Error(
      'sendWebSocketFrame is not implemented by this driver; only drivers with a live page context (e.g. Playwright local mode) support protocol:"websocket" strategies on the page-script tier',
    );
  }

  /**
   * Stream every WebSocket frame the page sends or receives to the given
   * callback, in real time. Returns a handle with a `dispose()` function to
   * stop the stream and a `closed` Promise that resolves when the stream
   * terminates for any reason (dispose, connection drop, page close). Used by
   * browser-event listeners to forward push-channel traffic into the
   * ListenerManager event queue without cracking the WS open from outside the
   * browser.
   */
  abstract streamWebSocketFrames(
    session: Session,
    onFrame: (frame: WebSocketFrame) => void,
  ): Promise<WebSocketFrameStream>;

  abstract mouseClick(session: Session, x: number, y: number, opts?: PageOpts): Promise<void>;
  abstract mouseMove(
    session: Session,
    x: number,
    y: number,
    steps?: number,
    opts?: PageOpts,
  ): Promise<void>;
  abstract mouseDown(session: Session, x: number, y: number, opts?: PageOpts): Promise<void>;
  abstract mouseUp(session: Session, x: number, y: number, opts?: PageOpts): Promise<void>;
  abstract mouseDrag(
    session: Session,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    opts?: PageOpts,
  ): Promise<void>;
  abstract keyPress(session: Session, key: string, opts?: PageOpts): Promise<void>;
  /**
   * Type a literal string, one character at a time, through the browser's
   * synthetic keyboard. Used by the remote viewer to forward multi-character
   * input (iOS autocorrect replacements, pasted text, composed input) as a
   * sequence of keypresses rather than a single fill().
   */
  abstract typeText(session: Session, text: string, opts?: PageOpts): Promise<void>;
  /**
   * Fill a contenteditable (Lexical, Slate, Draft.js, ProseMirror, TinyMCE,
   * CKEditor) by focusing the element via JS and typing through the browser's
   * synthetic keyboard, bypassing the actionability checks that `type`/`click`
   * apply. Modern rich-text editors render their root with zero intrinsic
   * height until first focus, which is a chicken-and-egg for `locator.click` /
   * `locator.fill` — both need a hit-testable box. This method resolves the
   * locator, calls `el.focus()` inside a `page.evaluate` (no visibility
   * requirement), then streams per-char keydown → beforeinput → input → keyup
   * events through `keyboard.type`. That event sequence is what Lexical-class
   * frameworks intercept to update their internal editor model — `fill()` does
   * not produce it.
   */
  abstract fillEditor(
    session: Session,
    selector: string,
    text: string,
    opts?: PageOpts,
  ): Promise<void>;
  abstract scroll(
    session: Session,
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    opts?: PageOpts,
  ): Promise<void>;
  abstract viewportSize(session: Session): { width: number; height: number };

  /**
   * Resize the session's browser viewport to the given dimensions. Used by the
   * viewer when the user's client canvas changes size. Drivers that can't
   * resize on the fly should treat this as a no-op (the next session would
   * honor the new viewport via `viewport` in SessionOptions).
   */
  async setViewport(_session: Session, _width: number, _height: number): Promise<void> {
    // default no-op
  }

  /**
   * Touch-event dispatch, for sessions created with `hasTouch: true`.
   * Implementations should produce events indistinguishable from a real
   * touchscreen on the target platform (CDP Input.dispatchTouchEvent on
   * Chromium). Callers are responsible for emitting start → move* → end in
   * order; `touchTap` is a convenience for discrete taps.
   */
  abstract touchStart(session: Session, x: number, y: number): Promise<void>;
  abstract touchMove(session: Session, x: number, y: number): Promise<void>;
  abstract touchEnd(session: Session, x: number, y: number): Promise<void>;
  abstract touchTap(session: Session, x: number, y: number): Promise<void>;

  /**
   * Install a listener that fires whenever the page's focused element changes,
   * reporting whether the new focus is an editable element and its input type.
   * Used by the remote viewer to auto-show/hide the mobile keyboard on devices
   * that have one. Listener fires with `null` when focus leaves any editable.
   * Safe to call multiple times per session; each call adds an additional
   * listener. Returns an async unsubscribe function.
   */
  abstract onFocusChange(
    session: Session,
    listener: FocusListener,
    opts?: PageOpts,
  ): Promise<() => void>;

  /**
   * Subscribe to changes in `session.subPages` — fires when a popup opens, the
   * popup's url/title is observed, or the popup closes. The callback receives
   * a snapshot copy of the current sub-page list. Used by the remote viewer
   * to refresh its tab strip; runtime tool handlers read `session.subPages`
   * directly, since tool responses already echo it.
   *
   * Default is a no-op subscription (returns an unsubscribe that does
   * nothing). Drivers without a popup-tracking surface (a transport-only
   * future driver) inherit this default.
   */
  onSubPagesChange(_session: Session, _listener: SubPagesListener): Promise<() => void> {
    return Promise.resolve(() => {
      /* no-op */
    });
  }

  abstract saveStorageState(session: Session, path: string): Promise<void>;

  /**
   * Set a source-location breakpoint. `file` is a URL or URL regex fragment as
   * accepted by CDP's `Debugger.setBreakpointByUrl`. `condition`, if present,
   * is a JS expression; the debugger only pauses when it evaluates truthy.
   * Drivers that can't host a CDP session throw `not_implemented`.
   */
  protected unsupportedDebuggerSurface<T>(method: string): Promise<T> {
    return Promise.reject(
      new Error(`not_implemented: ${method} requires the playwright debugger surface`),
    );
  }

  setBreakpoint(
    _session: Session,
    _params: { file: string; line: number; column?: number; condition?: string },
  ): Promise<{ breakpoint_id: string; resolved_location?: DebuggerLocation }> {
    return this.unsupportedDebuggerSurface('setBreakpoint');
  }

  removeBreakpoint(_session: Session, _breakpointId: string): Promise<void> {
    return this.unsupportedDebuggerSurface('removeBreakpoint');
  }

  listBreakpoints(_session: Session): Promise<
    Array<{
      breakpoint_id: string;
      location: { file: string; line: number; column?: number };
      condition?: string;
    }>
  > {
    return this.unsupportedDebuggerSurface('listBreakpoints');
  }

  /**
   * Block until the next `Debugger.paused` event or `timeoutMs` elapses. Caller
   * owns the resume — returning here does NOT release the pause. Subsequent
   * pauses queue; call again to drain the queue. Only one outstanding call
   * allowed per session (second concurrent call rejects).
   */
  waitForPause(_session: Session, _opts: { timeoutMs: number }): Promise<DebuggerPause> {
    return this.unsupportedDebuggerSurface('waitForPause');
  }

  getFrameScope(
    _session: Session,
    _params: { frameIndex: number; scopeType?: string; scopeIndex?: number },
  ): Promise<{
    properties: Array<{ name: string; type: string; preview: string; has_children: boolean }>;
    truncated?: boolean;
  }> {
    return this.unsupportedDebuggerSurface('getFrameScope');
  }

  evaluateOnFrame(
    _session: Session,
    _params: { frameIndex: number; expression: string; timeoutMs: number },
  ): Promise<{ ok: boolean; result?: string; error?: string }> {
    return this.unsupportedDebuggerSurface('evaluateOnFrame');
  }

  stepDebugger(
    _session: Session,
    _mode: 'over' | 'into' | 'out',
  ): Promise<{ paused_at?: DebuggerLocation & { function_name?: string }; done?: true }> {
    return this.unsupportedDebuggerSurface('stepDebugger');
  }

  resumeDebugger(_session: Session): Promise<void> {
    return this.unsupportedDebuggerSurface('resumeDebugger');
  }

  /**
   * Synchronous lookup of the current pause state. Returns null when the page
   * is not paused at a breakpoint, or a structured summary (top-frame location,
   * breakpoint ids that triggered) when it is. Used by runtime entry points
   * that drive the page (perform_action, navigate, etc.) to fail fast with an
   * actionable error instead of blocking on the paused main thread until
   * playwright's 5s locator timeout fires. Drivers without a debugger surface
   * return null.
   */
  getDebuggerPauseState(_session: Session): {
    breakpoint_ids: string[];
    location?: DebuggerLocation & { function_name?: string };
  } | null {
    return null;
  }

  /**
   * Idempotent teardown. Called by end_drive before storage save — resume
   * any active pause, remove all breakpoints, disable the Debugger domain. Must
   * not throw on a session that never touched the debugger.
   */
  cleanupDebuggerState(_session: Session): Promise<void> {
    return Promise.resolve();
  }

  abstract closeBrowser(): Promise<void>;
}
