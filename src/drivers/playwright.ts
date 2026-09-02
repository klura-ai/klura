// Default driver uses plain `playwright`. A subclass (or caller) can pass a
// different BrowserType instance through the constructor — e.g. the external
// `@klura/driver-playwright-stealth` package passes playwright-extra's patched
// chromium — and inherit every other behavior unchanged (screencast, network
// capture, focus tracker, viewport sync, touch dispatch).
import { chromium as defaultChromium } from 'playwright';
import type {
  Browser,
  BrowserContext,
  BrowserType,
  CDPSession,
  Locator,
  Page,
  WebSocket as PlaywrightWebSocket,
} from 'playwright';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import * as cheerio from 'cheerio';
import type { ConnectConfig } from '../config/handler';
import { getKluraHome } from '../paths';
import { BrowserDriver, Capability, PageOpts } from './interface';
import { readProfileLockHolder } from './profile-lock';
import { writeTextUnderFileLock } from '../utils/owner-file-lock';
import type { InterceptedRequest, LoadedScript } from './types/network';
import type { WebSocketFrame, WebSocketFrameStream } from './types/websocket';
import type {
  BrowserLease,
  FocusListener,
  FocusState,
  Session,
  SessionOptions,
  SubPage,
  SubPagesListener,
} from './types/session';
import { attachCdpNetworkCapture, getInterceptedFromSink } from './cdp-network-capture';
import { hasOpenSocket, sendOnLiveSocket } from './cdp-websocket-capture';
import { parseStack } from '../response/stack-parse';
import { needsBlockBodyWrap, wrapAgentExpression } from '../response/js-eval-wrapper';

// Per-session transient state that we don't want to expose through the Session
// interface (CDP client for touch dispatch, focus listeners, and the flag
// recording whether the focus-tracker init script has been installed yet).
// Keyed by Session identity.
type NavVia = 'pushState' | 'replaceState' | 'popstate' | 'hashchange';

// --- connect-mode helpers (drive a normally-launched Chrome over CDP) ---

// Locate a Google Chrome binary for connect-mode 'spawn'. Returns the first
// existing platform-default path, or null so the caller can surface a clear
// "set pool.connect.chromePath" error.
function resolveChromeBinary(): string | null {
  let candidates: string[];
  if (process.platform === 'darwin') {
    candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  } else if (process.platform === 'win32') {
    candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
  } else {
    candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

// A profile dir klura owns exclusively — the default {KLURA_HOME}/connect-profile
// or anything else under KLURA_HOME. No human launches Chrome against these, so a
// live SingletonLock holder there is definitionally a klura-spawned orphan and
// safe to reap. A user-supplied profileDir outside KLURA_HOME might be their own
// Chrome profile, so it's never reaped.
function isKluraOwnedProfile(profileDir: string): boolean {
  const home = path.resolve(getKluraHome());
  const resolved = path.resolve(profileDir);
  return resolved === home || resolved.startsWith(home + path.sep);
}

// Reserve an ephemeral TCP port for the spawned Chrome's DevTools endpoint.
function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => {
        if (port) resolve(port);
        else reject(new Error('could not reserve a port'));
      });
    });
  });
}

// Attach over CDP, retrying until the freshly-spawned Chrome has opened its
// DevTools endpoint. The retry IS the readiness signal — Chrome exposes no
// pre-open event, so a bounded connect-retry at this launch barrier is the
// correct primitive (not a steady-state poll).
async function connectOverCdpWithRetry(url: string, timeoutMs: number): Promise<Browser> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await defaultChromium.connectOverCDP(url);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface SessionExtras {
  cdp?: CDPSession;
  focusListeners: Set<FocusListener>;
  focusInstalled: boolean;
  // Next popup-handle suffix to assign for this session. Monotonic (starts at
  // 1, never decremented), so popup ids never reuse — popup-1 closing leaves
  // its `subPages` entry behind with `closedAt` set, and the next popup is
  // popup-2. Keeps recorded-path step `page` references unambiguous.
  nextPopupSuffix: number;
  // The `context.on('page')` handler installed at session creation. Stashed
  // so resetSession (warm-pool recycle) can detach and reattach without
  // double-listening, mirroring `wsCaptureListener`.
  popupContextListener?: (page: Page) => void;
  // Subscribers notified when the sub-page list mutates (popup opens or
  // closes, popup url/title changes). Used by the remote viewer to refresh
  // its tab strip; runtime hot paths don't need it because every tool
  // response that returns session state already echoes `subPages`.
  subPagesListeners: Set<SubPagesListener>;
  // CDP session bound to Page.startScreencast. Push-based JPEG stream from the
  // compositor — delivers a frame whenever something invalidates (input,
  // scroll, caret blink, CSS transitions), so fast animations reach the viewer
  // without polling.
  screencastCdp?: CDPSession;
  // Most recent frame buffer delivered by the screencast. Served by
  // screenshotJpeg() on demand.
  lastScreencastFrame?: Buffer;
  screencastStarted?: boolean;
  // CDP session dedicated to Network domain capture. Separate from the touch
  // CDP session so detaching one doesn't kill the other.
  networkCdp?: CDPSession;
  // External scripts observed from CDP Network.requestWillBeSent events.
  // Separate from the compact intercepted-request log, which excludes passive
  // resource types by construction.
  loadedScripts?: LoadedScript[];
  // Buffer of frame-level navigations observed via `page.on('framenavigated')`
  // and same-document (History API) route changes captured via CDP
  // `Page.navigatedWithinDocument`. Drained by `consumePendingNavs` after each
  // `perform_action`. Entries suppressed when an explicit `driver.navigate()`
  // call is in flight so the index.ts perform_action(navigate) handler doesn't
  // double-count. `via` is set for same-document navs (`pushState` for
  // pushState/replaceState/popstate, `hashchange` for a fragment-only change);
  // omitted when the source is `framenavigated` and the perform_action
  // consumer derives `via` from the action that triggered the call.
  pendingNavs?: Array<{
    at: number;
    url: string;
    title?: string;
    via?: NavVia;
  }>;
  // True while a `driver.navigate()` call is awaiting `page.goto`. The
  // framenavigated listener checks this to decide whether to push: explicit
  // navigates produce their own dom_navigation event in index.ts; the listener
  // exists to catch the click → URL change and form-submit cases.
  navigateInFlight?: boolean;
  // The most recent URL the listener pushed (or that an explicit navigate
  // committed to). Lets the listener filter out playwright's same-URL refires
  // (about:blank → about:blank on context reset, identical URL on hash-only
  // change, etc.) without spamming the buffer.
  lastObservedNavUrl?: string;
  // Default WebSocket-capture listener installed at session creation so
  // resetSession can detach and reattach on warm-pool recycling without
  // double-listening.
  wsCaptureListener?: (ws: PlaywrightWebSocket) => void;
  // Per-session cache of fetched JS script bodies, keyed by URL. Lets paginated
  // `getJsSource` reads share one fetch round-trip. Cleared on session close.
  jsSourceCache?: Map<string, string>;
  // CDP session + state backing the debugger-surface tools (set_breakpoint,
  // wait_for_pause, evaluate_on_frame, step, resume). Lazily created when the
  // agent first calls set_breakpoint; torn down by cleanupDebuggerState.
  debuggerState?: DebuggerState;
  // Host-side ring of WebSocket send call-stacks captured out-of-band via CDP.
  // Drained by `popMatchingCallstack` in `_attachWebSocketCapture` on each
  // `framesent`, keyed by (url, byte length, first-16-byte hex), to attach
  // `frame.js_callstack`. Empty unless send-capture has been armed for
  // reverse-engineering — the built-in driver installs no page-observable
  // WebSocket instrumentation by default, so a normal session leaves this
  // untouched and frames carry no callstack (graceful absence).
  sendCaptures?: Array<{ raw_stack: string }>;
  /** Reentrancy counter for armed WebSocket send-capture. >0 means the
   *  Debugger breakpoint on native `WebSocket.prototype.send` is installed. */
  sendCaptureRefCount?: number;
}

interface DebuggerBreakpoint {
  file: string;
  line: number;
  column?: number;
  condition?: string;
}

interface CdpPausedEvent {
  reason: string;
  breakpointIds?: string[];
  // CDP's own field name for the breakpoints hit at this pause. Populated by
  // Debugger.setBreakpointOnFunctionCall (verified), so the shared onPaused
  // handler routes our armed send-capture breakpoint by matching this.
  hitBreakpoints?: string[];
  callFrames: CdpCallFrame[];
}

interface CdpCallFrame {
  callFrameId: string;
  functionName?: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
  url?: string;
  scopeChain?: Array<{
    type: string;
    object: { objectId?: string; className?: string; description?: string; type?: string };
  }>;
  functionLocation?: { scriptId: string; lineNumber: number; columnNumber?: number };
  this?: { objectId?: string; className?: string; description?: string; type?: string };
}

interface DebuggerState {
  cdp: CDPSession;
  enabled: boolean;
  // scriptId → url from Debugger.scriptParsed, needed to fill file on
  // callFrames (CDP call frames carry scriptId but not always url).
  scriptUrls: Map<string, string>;
  breakpoints: Map<string, DebuggerBreakpoint>;
  paused: CdpPausedEvent | null;
  pauseQueue: CdpPausedEvent[];
  pending: {
    resolve: (ev: CdpPausedEvent) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  } | null;
  onPaused: (ev: CdpPausedEvent) => void;
  onScriptParsed: (ev: { scriptId: string; url: string }) => void;
  // Breakpoint id of the armed WebSocket send-capture (setBreakpointOnFunction-
  // Call on native WebSocket.prototype.send), or null when disarmed. Pauses
  // whose hitBreakpoints include this are handled internally (stack captured,
  // auto-resumed) and never surface to the agent's wait_for_pause queue.
  sendBreakpointId?: string | null;
}

const DEBUGGER_PAUSE_QUEUE_CAP = 5;
const DEBUGGER_MAX_BREAKPOINTS = 10;

// Hard ceiling for page-driving ops that have no native playwright timeout.
// When the main JS thread is paused at a breakpoint, calls like page.evaluate /
// locator.evaluate / keyboard.* / mouse.* hang forever — playwright's
// auto-waiting does not cover evaluate and the input primitives dispatch into
// the paused event loop. The runtime's pre-check in performAction catches most
// cases before dispatch, but a breakpoint can fire between the pre-check and
// the op, so every unbounded call gets wrapped here as the in-flight safety
// net. 20s is generous for any legitimate interaction while remaining short
// enough that a user-visible hang self-recovers.
const PAGE_OP_TIMEOUT_MS = 20_000;
// A native accessibility snapshot is a passive read on the session-start
// critical path and normally completes in well under a second. Give it a
// tighter ceiling than interactive page operations so an engine-side
// ariaSnapshot stall can fall back to the inert DOM serializer promptly.
const A11Y_SNAPSHOT_TIMEOUT_MS = 10_000;

async function withPageOpTimeout<T>(
  promise: Promise<T>,
  opName: string,
  ms: number = PAGE_OP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `${opName}: timed out after ${ms}ms. The page's main JS thread may be paused at a breakpoint — ` +
            `check with list_breakpoints and call resume / remove_breakpoint before retrying.`,
        ),
      );
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    // `timer` is assigned inside the Promise executor (closure); flow analysis
    // doesn't follow that assignment, so a direct null-check on `timer` gets
    // flagged as always-falsy. Cast through an alias to reflect the runtime
    // truth that `timer` is populated by now.
    const handle = timer as ReturnType<typeof setTimeout> | null;
    if (handle !== null) clearTimeout(handle);
  }
}

/**
 * Ring-buffer cap for the passive per-session WebSocket frame capture. 2000
 * frames is plenty of headroom for a typical discovery session (chatty sites
 * fire 10-50 frames per user action) while bounding memory growth on long-lived
 * sessions. When the cap is hit the oldest frames are dropped first, which
 * matches the "I want to see what just happened" use case — recent frames are
 * the interesting ones.
 */
const WS_FRAMES_BUFFER_CAP = 2000;
const sessionExtras = new WeakMap<Session, SessionExtras>();

// Page-side helpers for evaluate_in_iframe / evaluate_in_iframe_chain /
// evaluate_in_worker. Each runs inside page.evaluate so the body is
// serialized + re-evaluated in the browser realm; the function body
// cannot close over any module-scoped binding from this file.
/* eslint-disable
   @typescript-eslint/no-explicit-any,
   @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-call */
async function runIframeEvaluatePagefn(args: {
  src: string;
  wrapped: string;
  waitForMs: number;
  cleanup: boolean;
}): Promise<unknown> {
  const g = globalThis as any;
  const doc = g.document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('evaluate_in_iframe: no document on page');
  }
  const iframe = doc.createElement('iframe');
  iframe.src = args.src;
  iframe.style.display = 'none';
  doc.body.appendChild(iframe);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('iframe_load_failed: load timeout (8s)'));
      }, 8000);
      iframe.addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      });
      iframe.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('iframe_load_failed: load error event'));
      });
    });
    if (args.waitForMs > 0) {
      await new Promise<void>((r) => setTimeout(r, args.waitForMs));
    }
    const win = iframe.contentWindow;
    if (!win) throw new Error('iframe_no_content_window');
    let runner;
    try {
      runner = new win.Function('return ' + args.wrapped);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        'iframe_eval_failed: cannot create Function in iframe (likely cross-origin): ' + msg,
        { cause: e },
      );
    }
    return await runner();
  } finally {
    if (args.cleanup && iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  }
}

async function runIframeChainPagefn(args: {
  src: string;
  steps: ReadonlyArray<{ wrapped: string; waitForMs: number }>;
  cleanup: boolean;
  returnAll: boolean;
}): Promise<unknown> {
  const g = globalThis as any;
  const doc = g.document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('evaluate_in_iframe_chain: no document on page');
  }
  const iframe = doc.createElement('iframe');
  iframe.src = args.src;
  iframe.style.display = 'none';
  doc.body.appendChild(iframe);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('iframe_load_failed: load timeout (8s)'));
      }, 8000);
      iframe.addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      });
      iframe.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('iframe_load_failed: load error event'));
      });
    });
    const win = iframe.contentWindow;
    if (!win) throw new Error('iframe_no_content_window');
    const results: unknown[] = [];
    for (let i = 0; i < args.steps.length; i++) {
      const step = args.steps[i];
      if (!step) continue;
      if (step.waitForMs > 0) {
        await new Promise<void>((r) => setTimeout(r, step.waitForMs));
      }
      let runner;
      try {
        runner = new win.Function('return ' + step.wrapped);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`iframe_chain_step_${i}_failed: cannot create Function in iframe: ` + msg, {
          cause: e,
        });
      }
      try {
        const r = await runner();
        results.push(r);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`iframe_chain_step_${i}_threw: ` + msg, { cause: e });
      }
    }
    return args.returnAll ? results : results[results.length - 1];
  } finally {
    if (args.cleanup && iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  }
}

async function runWorkerPagefn(args: { source: string; message: unknown }): Promise<unknown> {
  const g = globalThis as any;
  if (typeof g.Worker !== 'function' || typeof g.Blob !== 'function' || !g.URL) {
    throw new Error('evaluate_in_worker: Worker / Blob / URL not available in this realm');
  }
  const blob = new g.Blob([args.source], { type: 'application/javascript' });
  const url = g.URL.createObjectURL(blob);
  let worker: any = null;
  try {
    worker = new g.Worker(url);
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('worker: no message returned within 8s'));
      }, 8000);
      worker.addEventListener('message', (e: any) => {
        clearTimeout(timer);
        resolve(e?.data);
      });
      worker.addEventListener('error', (e: any) => {
        clearTimeout(timer);
        const msg: string =
          typeof e?.message === 'string' ? e.message : 'unknown error in worker source';
        reject(new Error('worker_error: ' + msg));
      });
      worker.postMessage(args.message);
    });
  } finally {
    if (worker) {
      try {
        worker.terminate();
      } catch {
        /* terminate may throw on already-failed worker; non-fatal */
      }
    }
    try {
      g.URL.revokeObjectURL(url);
    } catch {
      /* revoke may throw if already revoked; non-fatal */
    }
  }
}
/* eslint-enable
   @typescript-eslint/no-explicit-any,
   @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-call */
function getExtras(session: Session): SessionExtras {
  let e = sessionExtras.get(session);
  if (!e) {
    e = {
      focusListeners: new Set(),
      focusInstalled: false,
      nextPopupSuffix: 1,
      subPagesListeners: new Set(),
    };
    sessionExtras.set(session, e);
  }
  return e;
}

// Total bytes of fetched JS source retained per session. The cache spares
// repeat search_js_source / read_js_function calls a re-fetch; bundles run to
// several MB each, so retaining every one for the session's lifetime is
// unbounded. Keep the most recently fetched sources within this budget and
// evict oldest-first (Map preserves insertion order).
const MAX_JS_SOURCE_CACHE_BYTES = 16 * 1_048_576;

function cacheJsSource(cache: Map<string, string>, url: string, body: string): void {
  cache.set(url, body);
  let total = 0;
  for (const v of cache.values()) total += v.length;
  while (total > MAX_JS_SOURCE_CACHE_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value as string;
    total -= cache.get(oldest)?.length ?? 0;
    cache.delete(oldest);
  }
}

// Script injected into every page to watch focus changes and report them back
// through an exposed binding. Runs on every navigation via addInitScript, plus
// once on the current document at install time.
const FOCUS_TRACKER_SCRIPT = `
(() => {
  if (window.__kluraFocusTrackerInstalled) return;
  Object.defineProperty(window, '__kluraFocusTrackerInstalled', { value: true, configurable: true });
  const isEditable = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      // Skip non-text inputs (checkbox, radio, button, file, color, ...).
      return ['text','password','email','tel','url','search','number'].includes(t);
    }
    return false;
  };
  const describe = (el) => {
    if (!isEditable(el)) return null;
    let inputType = 'text';
    if (el.isContentEditable) inputType = 'contenteditable';
    else if (el.tagName === 'TEXTAREA') inputType = 'textarea';
    else if (el.tagName === 'INPUT') inputType = (el.type || 'text').toLowerCase();
    return {
      editable: true,
      inputType,
      inputMode: el.inputMode || el.getAttribute('inputmode') || undefined,
      placeholder: el.placeholder || undefined,
      maxLength: typeof el.maxLength === 'number' && el.maxLength > 0 ? el.maxLength : undefined,
    };
  };
  let last = null;
  const report = () => {
    const state = describe(document.activeElement);
    const now = state ? JSON.stringify(state) : null;
    if (now === last) return;
    last = now;
    try { window.__kluraFocusChange(state); } catch (e) { /* binding not ready */ }
  };
  document.addEventListener('focusin', report, true);
  document.addEventListener('focusout', () => {
    // A focusout is often followed by focusin on the next element — defer so we
    // report the final state, not a transient null.
    setTimeout(report, 0);
  }, true);
  // Initial report in case something is already focused when we attach.
  report();
})();
`;

// Detect a11y-style selectors that mirror the aria-snapshot tree:
//   role only:           textbox
//   role + name:         button "Submit"
//   role + index:        textbox[2]
//   role + name + index: button "Continue"[1]
// The aria tree shows entries as `- <role>` or `- <role> "<name>"`, so the
// LLM can copy that notation directly. Index is 0-based.
//
// Any CSS selector may also take a `:!nth(N)` suffix to address the Nth match
// in result-set order (Playwright's locator.nth(N), NOT CSS's own nth-of-type,
// which is sibling-relative and brittle). Used by callers that hit "multiple
// matches, first() is wrong" — e.g. a page with two contenteditable Lexical
// editors where .first() picks the title and the caller wants the body.
// Example: `div[contenteditable="true"]:!nth(1)`.
const A11Y_ROLES =
  'button|textbox|searchbox|link|checkbox|radio|combobox|heading|img|tab|switch|slider|spinbutton|progressbar|menuitem|menuitemcheckbox|menuitemradio|option|dialog|alertdialog|alert|banner|navigation|main|complementary|contentinfo|form|region|search|paragraph|list|listitem|table|row|cell|columnheader|rowheader|separator|toolbar|menu|menubar|tablist|tabpanel|tree|treeitem|treegrid|group|article|figure|status|timer|tooltip|log|marquee|math|note|directory|document|feed|grid|gridcell|mark|meter|scrollbar|term|definition|insertion|deletion|emphasis|strong|subscript|superscript|time|code|blockquote';
const A11Y_SELECTOR_RE = new RegExp(`^(${A11Y_ROLES})(?:\\s+"(.+?)")?(?:\\[(\\d+)\\])?$`);
// Alias form — `<role>[<attr>="<value>"]…`. Agents trained on Playwright
// snapshot-style output often reach for this syntax when they want "the
// textbox whose placeholder is X" or "the link with href Y". We accept it
// by prepending the role's canonical HTML-element set (W3C ARIA tag
// mapping) via CSS `:is(...)`. The [attr=value] segment passes through
// verbatim as CSS. Not a heuristic — standard ARIA mapping, narrow, and
// fails fast for unknown roles.
const A11Y_WITH_ATTR_RE = new RegExp(`^(${A11Y_ROLES})((?:\\[[^\\]]+\\])+)$`);
const ROLE_TO_CSS_ISLIST: Record<string, string> = {
  textbox:
    ':is(input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="password"], textarea, [contenteditable="true"], [role="textbox"])',
  searchbox: ':is(input[type="search"], [role="searchbox"])',
  button:
    ':is(button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"])',
  link: ':is(a[href], [role="link"])',
  checkbox: ':is(input[type="checkbox"], [role="checkbox"])',
  radio: ':is(input[type="radio"], [role="radio"])',
  combobox: ':is(select, input[role="combobox"], [role="combobox"])',
  listbox: ':is([role="listbox"])',
  option: ':is(option, [role="option"])',
  img: ':is(img, [role="img"])',
  heading: ':is(h1, h2, h3, h4, h5, h6, [role="heading"])',
  tab: ':is([role="tab"])',
  tabpanel: ':is([role="tabpanel"])',
  dialog: ':is(dialog, [role="dialog"], [role="alertdialog"])',
  slider: ':is(input[type="range"], [role="slider"])',
  spinbutton: ':is(input[type="number"], [role="spinbutton"])',
  switch: ':is([role="switch"])',
  list: ':is(ul, ol, [role="list"])',
  listitem: ':is(li, [role="listitem"])',
  table: ':is(table, [role="table"])',
  row: ':is(tr, [role="row"])',
  cell: ':is(td, [role="cell"])',
  form: ':is(form, [role="form"])',
  navigation: ':is(nav, [role="navigation"])',
  main: ':is(main, [role="main"])',
  paragraph: ':is(p, [role="paragraph"])',
  article: ':is(article, [role="article"])',
};
const CSS_NTH_SUFFIX_RE = /:!nth\((\d+)\)$/;

// Raw HTML tag → ARIA role analog. Lets `input[name="x"]` widen to also
// match `[role="textbox"][name="x"]` etc., so agents trained on standard
// HTML still hit a role-based element when the page uses ARIA-only widgets
// (custom div+contenteditable text fields, role="button" spans, etc.).
const TAG_TO_ROLE: Record<string, string> = {
  input: 'textbox',
  textarea: 'textbox',
  select: 'combobox',
  button: 'button',
  a: 'link',
};
const TAG_ATTR_RE = /^([a-z]+)((?:\[[^\]]+\])+)$/;

function resolveLocator(page: Page, selector: string): Locator {
  const match = A11Y_SELECTOR_RE.exec(selector);
  if (match) {
    const role = match[1] as Parameters<Page['getByRole']>[0];
    const name = match[2];
    const idx = match[3] !== undefined ? parseInt(match[3], 10) : undefined;
    // Exact name match so `button "Submit"` doesn't also match `button "Submit
    // and continue"` (substring matches by default).
    const base = name ? page.getByRole(role, { name, exact: true }) : page.getByRole(role);
    return idx !== undefined ? base.nth(idx) : base.first();
  }
  const aliasMatch = A11Y_WITH_ATTR_RE.exec(selector);
  if (aliasMatch && aliasMatch[1] && aliasMatch[2]) {
    const role = aliasMatch[1];
    const attrSegment = aliasMatch[2];
    const isList = ROLE_TO_CSS_ISLIST[role];
    if (isList) {
      return page.locator(`${isList}${attrSegment}`).first();
    }
    // Unknown role — fall through to plain CSS (will likely fail, but the
    // error surfaces the agent's typo).
  }
  const nthMatch = CSS_NTH_SUFFIX_RE.exec(selector);
  if (nthMatch && nthMatch[1]) {
    const cssBody = selector.slice(0, nthMatch.index);
    return page.locator(cssBody).nth(parseInt(nthMatch[1], 10));
  }
  // `<tag>[<attr>=...]` widening — when the tag has a role analog whose
  // canonical CSS list covers the same elements, OR the original CSS with
  // the role-analog form so a model that wrote `input[name="search"]`
  // still matches a `[role="searchbox"][name="search"]` widget. Bare tag
  // selectors (no attr) are intentionally NOT widened — too coarse.
  const tagAttrMatch = TAG_ATTR_RE.exec(selector);
  if (tagAttrMatch && tagAttrMatch[1] && tagAttrMatch[2]) {
    const tag = tagAttrMatch[1];
    const attrs = tagAttrMatch[2];
    const role = TAG_TO_ROLE[tag];
    const isList = role ? ROLE_TO_CSS_ISLIST[role] : undefined;
    if (isList) {
      return page.locator(`${selector}, ${isList}${attrs}`).first();
    }
  }
  return page.locator(selector).first();
}

function stripNthSuffix(selector: string): string {
  const m = CSS_NTH_SUFFIX_RE.exec(selector);
  return m ? selector.slice(0, m.index) : selector;
}

// Per-session Playwright Page and BrowserContext references. Kept in
// driver-private WeakMaps, NOT on the public Session interface, so non-driver
// code cannot reach into `session.page.goto(...)` and silently break the
// remote/docker path. Callers must go through the BrowserDriver abstract
// methods (navigate, getUrl, delay, fetchInBrowser, etc).
//
// `sessionPages` is keyed by session, then by handle: `"main"` for the page
// the session opened with, `"popup-N"` for any subsequently-opened popup or
// `target=_blank` tab tracked via `context.on('page')`. Public API addresses
// non-main pages by id through `BrowserDriver` methods that take a `{page}`
// opt; `_page(session, handle)` resolves the handle to the raw Page.
const MAIN_PAGE = 'main' as const;
const sessionPages = new WeakMap<Session, Map<string, Page>>();
const sessionContexts = new WeakMap<Session, BrowserContext>();

// Per-session init-script tracking. Playwright's `addInitScript` does not
// expose a removal API, so removal is best-effort: the wrapper checks a
// session-scoped removed-handles set on every navigation and short-circuits
// when the handle has been removed. Exposed via `installInitScript` /
// `removeInitScript`.
const sessionRemovedInitScripts = new WeakMap<Session, Set<string>>();

/**
 * Everything the playwright driver keys by Session identity, bundled so a
 * warm-stashed lease can move it between Session objects. Covers all four
 * Session-keyed WeakMaps (extras, pages, context, removed-init-scripts) —
 * missing any one would orphan a BrowserContext or make `_context()` throw
 * on the re-attached session — plus the capture arrays whose IDENTITY the
 * attached page/CDP listeners bind (network sink, WS ring, sub-page list).
 * Transferring the arrays keeps live listeners feeding the new Session on
 * the ready-page borrow path, where no `resetSession` re-instrumentation
 * runs.
 */
interface LeaseRecord {
  context: BrowserContext;
  pageMap: Map<string, Page>;
  extras?: SessionExtras;
  removedInitScripts?: Set<string>;
  intercepted: InterceptedRequest[];
  intercepting: boolean;
  wsFrames: WebSocketFrame[];
  subPages: SubPage[];
}

export interface PlaywrightDriverOptions {
  /** Optional custom chromium instance (used by the stealth variant). */
  chromium?: BrowserType;
  /** Launch a visible browser window. Default false (headless). */
  headful?: boolean;
  /** Chromium channel preference: 'auto' | 'chrome' | 'chromium'.
   *  Default 'auto'. */
  channel?: 'auto' | 'chrome' | 'chromium';
  /**
   * Opaque per-driver config from `pool.driver_config`. The runtime treats
   * this as a black box; drivers that care declare and validate their own
   * shape (e.g. a remote-CDP driver reads `{ apiKey, region, project }` here).
   * Built-in PlaywrightDriver ignores it.
   */
  config?: Record<string, unknown>;
  /** Connect-mode settings. When `enabled`, `_ensureBrowser` drives a
   *  normally-launched Chrome over CDP instead of launching one via Playwright. */
  connect?: ConnectConfig;
}

export class PlaywrightDriver extends BrowserDriver {
  _browser: Browser | null = null;
  protected readonly chromium: BrowserType;
  protected readonly headful: boolean;
  protected readonly channel: 'auto' | 'chrome' | 'chromium';
  protected readonly config: Record<string, unknown>;
  protected readonly connect?: ConnectConfig;
  /** Child process for a spawned connect-mode Chrome; killed on closeBrowser. */
  private _connectChild: ChildProcess | null = null;

  constructor(opts: PlaywrightDriverOptions = {}) {
    super();
    this.chromium = opts.chromium ?? defaultChromium;
    this.headful = opts.headful ?? false;
    this.channel = opts.channel ?? 'auto';
    this.config = opts.config ?? {};
    this.connect = opts.connect;

    // The built-in driver registers NO init scripts: a fresh page runs zero
    // klura-authored script before the site's own JS and exposes no patched
    // globals, so it is byte-identical to a normal browser for bot detection.
    // Instrumentation that needs in-page presence installs lazily on first use
    // (focus-tracker in `onFocusChange`), and everything else is sourced
    // out-of-band via CDP. Subclasses may append their own via
    // `this.registerInitScript` after calling `super(opts)`.
  }

  get capabilities(): readonly Capability[] {
    return [
      'dom_selectors',
      'network_intercept',
      'screenshots',
      'storage_state',
      'file_download',
      'mouse_coordinates',
      'multi_context',
    ] as const;
  }

  protected async _ensureBrowser(): Promise<Browser> {
    if (!this._browser || !this._browser.isConnected()) {
      // Connect mode: drive a normally-launched Chrome over CDP. A Chrome
      // launched the ordinary way clears managed browser challenges that a
      // Playwright-launched Chrome fails —
      // the distinguishing signal is Playwright's launch profile (its flag set
      // + synthetic user-data-dir), not the CDP connection itself.
      if (this.connect?.enabled) {
        this._browser = await this._connectBrowser();
        return this._browser;
      }
      // Prefer the user's real Chrome install so the TLS fingerprint, JA3/JA4,
      // HTTP/2 SETTINGS frame, and ALPN order match a normal browser visit —
      // Playwright's bundled chromium is distinguishable at the transport layer
      // before any JS runs. The `pool.channel` config field selects: 'chrome' |
      // 'chromium' | 'auto' (default).
      //
      // --headless=new runs the same binary and engine as headed Chrome with a
      // hidden window. Without it, Playwright's `headless: true` launches the
      // separate `chrome-headless-shell` binary, which is a lightweight wrapper
      // around //content tuned for PDF/screenshot workloads and isn't
      // feature-complete for interactive rendering (caret blink, fast CSS
      // transitions, compositor animations).
      //
      // pool.headful: true drops the flag to get a visible debug window.
      const args: string[] = [];
      if (!this.headful) args.push('--headless=new');

      const tryChrome = this.channel === 'auto' || this.channel === 'chrome';
      if (tryChrome) {
        try {
          this._browser = await this.chromium.launch({
            headless: false,
            channel: 'chrome',
            args,
          });
          if (process.env.KLURA_VERBOSE) {
            console.warn(`[klura] launched real Chrome (channel=chrome, headful=${this.headful})`);
          }
          return this._browser;
        } catch (err) {
          // channel 'chrome' is an explicit request — never paper over a miss.
          if (this.channel === 'chrome') throw err;
          // auto mode falls back to bundled chromium, but that is a real
          // degradation: bundled chromium is distinguishable at the transport
          // and brand layer (reports as Chromium, not Google Chrome) and will
          // fail managed browser challenges that real Chrome clears. Never let
          // this pass silently — the operator needs to know their traffic no
          // longer looks like a real browser. Install Chrome or set
          // pool.channel: 'chrome' to make the miss a hard error instead.
          console.warn(
            `[klura] DEGRADED: real Chrome unavailable, falling back to bundled chromium — ` +
              `expect managed browser challenges to fail. Install Google Chrome or set ` +
              `pool.channel:'chrome' to fail loudly instead. Cause: ${String(err)}`,
          );
        }
      }

      this._browser = await this.chromium.launch({ headless: false, args });
    }
    return this._browser;
  }

  /**
   * Acquire a Browser by connecting over CDP to a normally-launched Chrome,
   * rather than launching one via Playwright. Uses the plain `defaultChromium`
   * (never the injected/stealth chromium) so no page-level evasions are applied
   * — the browser is a genuine Chrome and must stay untouched.
   *
   * mode 'attach' connects to an operator-run Chrome at `connect.endpoint`.
   * mode 'spawn' (default) launches the real Chrome binary the ordinary way
   * (persistent profile, no automation flags), waits for its DevTools endpoint,
   * and attaches. The spawned process is tracked for teardown in closeBrowser.
   */
  /**
   * SIGKILL a klura-spawned Chrome orphaned by a previous run that's still
   * holding `profileDir`'s singleton lock, and clear the stale lock so the next
   * launch starts clean. No-op unless the profile is klura-owned (never touch a
   * user's own Chrome) and a live holder that isn't this driver's own tracked
   * child is present.
   */
  private _reapOwnedProfileOrphan(profileDir: string): void {
    if (!isKluraOwnedProfile(profileDir)) return;
    const holder = readProfileLockHolder(profileDir);
    if (!holder) return;
    // A child this driver still tracks isn't an orphan — leave it be.
    if (this._connectChild && this._connectChild.pid === holder.pid) return;
    try {
      process.kill(holder.pid, 'SIGKILL');
    } catch {
      /* already gone or not ours to signal */
    }
    // The killed holder leaves a stale SingletonLock symlink behind; remove it so
    // the fresh spawn doesn't hand off to a dead pid's lock. Best-effort — a race
    // or absence falls through to Chrome's own stale-lock handling.
    try {
      fs.rmSync(path.join(profileDir, 'SingletonLock'), { force: true });
    } catch {
      /* nothing to clear */
    }
    if (process.env.KLURA_VERBOSE) {
      console.warn(
        `[klura] connect: reaped orphaned Chrome (pid ${holder.pid}) holding ${profileDir}`,
      );
    }
  }

  private async _connectBrowser(): Promise<Browser> {
    const cfg = this.connect;
    if (!cfg?.enabled) throw new Error('_connectBrowser called without connect.enabled');

    if (cfg.mode === 'attach') {
      const endpoint = cfg.endpoint;
      if (!endpoint) {
        throw new Error(
          "connect mode 'attach' requires pool.connect.endpoint (e.g. http://localhost:9222)",
        );
      }
      const browser = await defaultChromium.connectOverCDP(endpoint);
      if (process.env.KLURA_VERBOSE) console.warn(`[klura] connect: attached to ${endpoint}`);
      browser.on('disconnected', () => {
        if (this._browser === browser) this._browser = null;
      });
      return browser;
    }

    // spawn mode
    const chromePath = cfg.chromePath ?? resolveChromeBinary();
    if (!chromePath || !fs.existsSync(chromePath)) {
      const at = chromePath ? ` at ${chromePath}` : '';
      throw new Error(
        `connect mode: could not find a Google Chrome binary${at}. Set pool.connect.chromePath.`,
      );
    }
    const profileDir = cfg.profileDir ?? path.join(getKluraHome(), 'connect-profile');
    fs.mkdirSync(profileDir, { recursive: true });
    // Reap a connect-Chrome orphaned by a previous run before spawning. Without
    // this, the orphan still holds the profile's singleton lock and our fresh
    // launch hands its command line off to the orphan and exits without opening
    // the debug port — the exact "failed to attach" wedge.
    this._reapOwnedProfileOrphan(profileDir);
    const port = await freeTcpPort();

    // A normal Chrome launch: real profile, no --enable-automation, no
    // Playwright default-arg soup. Only the DevTools port + the flags a normal
    // first-run needs. This is what makes managed challenges treat it as human.
    const child = spawn(
      chromePath,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--restore-last-session=false',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    this._connectChild = child;
    child.on('exit', () => {
      if (this._connectChild === child) this._connectChild = null;
    });

    let browser: Browser;
    try {
      browser = await connectOverCdpWithRetry(`http://127.0.0.1:${port}`, 20000);
    } catch (err) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      this._connectChild = null;
      const holder = readProfileLockHolder(profileDir);
      const hint = holder
        ? ` — another Chrome (pid ${holder.pid}) is holding the connect profile at ${profileDir}. ` +
          `Close that window or run \`kill ${holder.pid}\`, then retry. ` +
          `(Changing pool.connect.profileDir won't help in-process: it's a boot-time setting that ` +
          `needs a full runtime relaunch to take effect.)`
        : '';
      throw new Error(`connect mode: failed to attach to spawned Chrome on port ${port}${hint}`, {
        cause: err,
      });
    }
    if (process.env.KLURA_VERBOSE) {
      console.warn(`[klura] connect: spawned real Chrome (port ${port}, profile ${profileDir})`);
    }
    browser.on('disconnected', () => {
      if (this._browser === browser) this._browser = null;
    });
    return browser;
  }

  protected _page(session: Session, handle: string = MAIN_PAGE): Page {
    const pages = sessionPages.get(session);
    if (!pages) {
      throw new Error(`no playwright pages for session ${session.id} (already destroyed?)`);
    }
    const page = pages.get(handle);
    if (!page) {
      const open = Array.from(pages.entries())
        .filter(([, p]) => !p.isClosed())
        .map(([id]) => id)
        .join(', ');
      throw new Error(`unknown page handle "${handle}" on session ${session.id}; open: [${open}]`);
    }
    if (page.isClosed()) {
      throw new Error(`page handle "${handle}" on session ${session.id} is closed`);
    }
    return page;
  }

  protected _context(session: Session): BrowserContext {
    const context = sessionContexts.get(session);
    if (!context) {
      throw new Error(`no playwright context for session ${session.id} (already destroyed?)`);
    }
    return context;
  }

  async createSession(options: SessionOptions = {}): Promise<Session> {
    const session = await this._createBrowserContext(options);
    await this._instrumentSession(session);
    return session;
  }

  /**
   * Acquire a `BrowserContext` + main `Page`, build the `Session` envelope, and
   * register both into the driver's session-keyed weakmaps. Subclasses override
   * this to swap the browser-creation step — e.g. a remote-CDP driver replaces
   * `_ensureBrowser` + `browser.newContext` with `chromium.connectOverCDP(url)`
   * + `browser.newContext` and inherits everything else by calling super or
   * by re-implementing only the launch portion.
   *
   * Post-launch instrumentation (network capture, init scripts, focus tracker,
   * popup tracking, frame-navigation capture) is deliberately NOT in this
   * method — it lives in `_instrumentSession`, which the public `createSession`
   * orchestrates after this returns. That split is the seam for BYO drivers.
   */
  /**
   * Pluggable hook — resolve the context viewport from the caller's options.
   * Returns the value to pass to `newContext`, or a falsy value to let the
   * browser apply its own default. Drivers may override to substitute a
   * different size when the caller did not pin one.
   */
  protected _resolveViewport(
    options: SessionOptions,
  ): { width: number; height: number } | undefined {
    return options.viewport;
  }

  protected async _createBrowserContext(options: SessionOptions): Promise<Session> {
    const browser = await this._ensureBrowser();

    const contextOpts: Parameters<Browser['newContext']>[0] = {
      // Block service workers so they cannot intercept fetch calls or form
      // POSTs. Service workers proxy requests below page.on('request'), making
      // them invisible to network capture. With 'block', pages fall back to
      // direct requests that Playwright sees and we can classify as T1/T0.
      serviceWorkers: 'block',
    };
    if (options.storageState) contextOpts.storageState = options.storageState;
    if (options.hasTouch) contextOpts.hasTouch = true;
    if (options.isMobile) contextOpts.isMobile = true;
    const viewport = this._resolveViewport(options);
    if (viewport) contextOpts.viewport = viewport;
    if (options.userAgent) contextOpts.userAgent = options.userAgent;
    if (options.deviceScaleFactor) contextOpts.deviceScaleFactor = options.deviceScaleFactor;

    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();

    const session: Session = {
      id: 'sess_' + crypto.randomBytes(6).toString('hex'),
      intercepted: [],
      intercepting: false,
      hasTouch: options.hasTouch === true,
      isMobile: options.isMobile === true,
      wsFrames: [],
      subPages: [],
    };
    if (options.platform) session.platform = options.platform;
    if (options.identity) session.identity = options.identity;
    const pageMap = new Map<string, Page>();
    pageMap.set(MAIN_PAGE, page);
    sessionPages.set(session, pageMap);
    sessionContexts.set(session, context);

    return session;
  }

  /**
   * Wire klura's per-session instrumentation onto a `Session` produced by
   * `_createBrowserContext` (or by a subclass override). Idempotent in spirit
   * but not in implementation — call once per session-creation or warm-reset.
   *
   * Subclasses that swap the browser-creation step inherit this verbatim; they
   * almost never need to override it. If a custom driver needs to add its own
   * post-launch instrumentation, register init scripts via
   * `this.registerInitScript` in the constructor (the cheapest path), or
   * override and call `super._instrumentSession(session)` first.
   */
  protected async _instrumentSession(session: Session): Promise<void> {
    await this._attachNetworkCapture(session);
    this._attachWebSocketCapture(session);
    await this._installRegisteredInitScripts(session);
    this._attachFrameNavigatedCapture(session);
    await this._attachSameDocNavCapture(session);
    this._attachPopupCapture(session);
  }

  /**
   * Passive WebSocket capture — attaches a default listener at session creation
   * that pushes every frame into `session.wsFrames` for later inspection.
   * Parallel to `_attachNetworkCapture` but for the WS side. Survives for the
   * session's lifetime. Ring-buffered at `WS_FRAMES_BUFFER_CAP` frames; oldest
   * are evicted so long-lived chatty sessions don't drive memory up
   * unboundedly.
   *
   * This is independent of `streamWebSocketFrames` (the listener surface used
   * by browser-event listener capabilities), which attaches its own handlers —
   * both run in parallel when a listener is active. Pure side- effect; failures
   * are swallowed because WS capture is diagnostic, not load-bearing.
   */
  protected _attachWebSocketCapture(session: Session): void {
    try {
      const page = this._page(session);
      if (!session.wsFrames) session.wsFrames = [];
      const buffer = session.wsFrames;
      const pushFrame = (frame: WebSocketFrame): void => {
        buffer.push(frame);
        // Per-session cap overrides the driver default when set. The runtime
        // bumps it when a complex-envelope advisory fires so RE probe activity
        // doesn't evict reference frames out from under the agent mid-loop.
        const cap = session.wsFramesCap ?? WS_FRAMES_BUFFER_CAP;
        if (buffer.length > cap) {
          // Evict the oldest entries; splice in-place so `session.wsFrames`
          // keeps the same array identity the buffer variable was bound to.
          buffer.splice(0, buffer.length - cap);
        }
      };
      // Drain the oldest host-side send-capture and attach it to this framesent.
      // The ring is populated out-of-band via CDP (Debugger.setBreakpointOn-
      // FunctionCall on native WebSocket.prototype.send) only while send-capture
      // is armed for reverse-engineering — a bounded window (trigger_reference_
      // send / an active get_send_encoder) in which sends and framesent events
      // stay 1:1 and in order, so oldest-first correlation is exact. The native
      // send frame exposes no readable `this`/args, so we correlate by order
      // rather than by (url, len, head_hex). A normal session leaves the ring
      // empty → no js_callstack on the frame (graceful absence).
      // Resolve extras once at attach time. The listener may outlive the
      // Session object it was attached under (a lease moves the extras to a
      // successor Session on warm reuse), so the closure binds the extras
      // object itself rather than re-resolving through the session key.
      const extras = getExtras(session);
      const popMatchingCallstack = (): { raw_stack: string } | null => {
        const buf = extras.sendCaptures;
        if (!buf || buf.length === 0) return null;
        const e = buf.shift();
        return e && e.raw_stack.length > 0 ? { raw_stack: e.raw_stack } : null;
      };
      const wsListener = (ws: PlaywrightWebSocket): void => {
        const url = ws.url();
        ws.on('framereceived', (data: { payload: string | Buffer }) => {
          try {
            pushFrame({
              url,
              direction: 'received',
              payload: data.payload.toString(),
              timestamp: Date.now(),
            });
          } catch {
            // ignore
          }
        });
        ws.on('framesent', (data: { payload: string | Buffer }) => {
          try {
            const payload = data.payload.toString();
            const frame: WebSocketFrame = {
              url,
              direction: 'sent',
              payload,
              timestamp: Date.now(),
            };
            // Push the frame immediately so concurrent reads see it; attach the
            // callstack asynchronously when the page-side buffer drain
            // completes. This keeps framesent ordering deterministic and bounds
            // latency for callers that don't care about callstacks.
            pushFrame(frame);
            const cs = popMatchingCallstack();
            if (cs) {
              frame.js_callstack = { raw_stack: cs.raw_stack, frames: parseStack(cs.raw_stack) };
            }
          } catch {
            // ignore
          }
        });
      };
      page.on('websocket', wsListener);
      // Stash the listener reference so resetSession can clean it up on
      // warm-pool recycling without double-attaching after a reset.
      extras.wsCaptureListener = wsListener;
    } catch {
      // Page already gone or driver in weird state — capture just won't fire,
      // which is the same as not being attached. Non-fatal.
    }
  }

  /**
   * Install a `context.on('page')` listener so popups, `target=_blank` tabs,
   * and OAuth-style consent windows are tracked as `session.subPages` entries
   * with stable handles (`popup-1`, `popup-2`, ...). The driver keeps the raw
   * Playwright `Page` in its private per-session map under the same handle so
   * subsequent action methods can resolve `{page: 'popup-N'}` opts.
   *
   * Mirrors `_attachWebSocketCapture` in shape: best-effort attach (failures
   * swallowed; capture absence is the same as no listener), with the listener
   * stashed on extras so warm-pool recycle can detach it cleanly.
   *
   * Each popup gets its own `'close'` handler that stamps `closedAt` and
   * notifies subPages subscribers; the entry stays in `subPages` (and the
   * raw-Page map keeps the handle reserved) so popup ids never reuse — a
   * recorded-path step pinned to `popup-1` means the first popup of the run,
   * not whichever popup happens to be open at replay time.
   */
  protected _attachPopupCapture(session: Session): void {
    let context: BrowserContext;
    try {
      context = this._context(session);
    } catch {
      return;
    }
    const extras = getExtras(session);
    const notify = (): void => {
      const list = session.subPages ?? [];
      for (const cb of extras.subPagesListeners) {
        try {
          cb(list.slice());
        } catch {
          /* listener errors are not fatal to popup tracking */
        }
      }
    };
    const onPage = (popup: Page): void => {
      try {
        if (!session.subPages) session.subPages = [];
        const id = `popup-${extras.nextPopupSuffix}`;
        extras.nextPopupSuffix += 1;
        const pageMap = sessionPages.get(session);
        if (!pageMap) return;
        pageMap.set(id, popup);
        const entry: SubPage = {
          id,
          url: popup.url(),
          openerId: MAIN_PAGE,
          openedAt: Date.now(),
        };
        session.subPages.push(entry);
        // Opener resolves async in playwright; refine the entry once it
        // returns. Any pre-async push referencing this popup-N already saw
        // openerId = "main", which is the right default for direct
        // window.open calls — only in the rare nested-popup case will this
        // refinement land.
        popup
          .opener()
          .then((opener) => {
            if (!opener) return;
            for (const [hid, p] of pageMap) {
              if (p === opener) {
                entry.openerId = hid;
                notify();
                break;
              }
            }
          })
          .catch(() => {
            /* opener can fail if the page is gone */
          });
        notify();
        // Best-effort url/title refresh once the popup has rendered. Some
        // popups open with `about:blank` and only commit the real URL after a
        // navigate inside the new page. domcontentloaded gives us a stable
        // observation point for both the URL and title without blocking the
        // listener.
        popup
          .waitForLoadState('domcontentloaded', { timeout: 5000 })
          .then(async () => {
            entry.url = popup.url();
            try {
              entry.title = await popup.title();
            } catch {
              /* title fetch can race with close on transient popups */
            }
            notify();
          })
          .catch(() => {
            /* popup may have closed before load; entry already recorded */
          });
        popup.on('framenavigated', (frame) => {
          if (frame !== popup.mainFrame()) return;
          const url = frame.url();
          if (!url || url === 'about:blank') return;
          if (entry.url === url) return;
          entry.url = url;
          // Title can lag the navigation commit; refresh on a microtask.
          popup
            .title()
            .then((t) => {
              if (typeof t === 'string') entry.title = t;
              notify();
            })
            .catch(() => {
              notify();
            });
        });
        popup.on('close', () => {
          entry.closedAt = Date.now();
          notify();
          // Leave the entry in `subPages` so id semantics stay stable, but
          // free the raw-Page reference so it can be GC'd. `_page(handle)`
          // throws "closed" for callers that retry against a dead handle.
          const map = sessionPages.get(session);
          if (map) map.delete(id);
        });
      } catch {
        /* popup observation is diagnostic, not load-bearing */
      }
    };
    try {
      context.on('page', onPage);
      extras.popupContextListener = onPage;
    } catch {
      /* context already gone */
    }
  }

  /**
   * Subscribe to sub-page list changes (popup opened, popup url/title
   * refreshed, popup closed). Returns an unsubscribe function. Used by the
   * remote viewer to refresh its tab strip; the runtime hot path reads
   * `session.subPages` directly, since every tool response that returns
   * session state echoes it.
   */
  onSubPagesChange(session: Session, listener: SubPagesListener): Promise<() => void> {
    const extras = getExtras(session);
    extras.subPagesListeners.add(listener);
    return Promise.resolve(() => {
      extras.subPagesListeners.delete(listener);
    });
  }

  /**
   * Install a `framenavigated` listener on the active page. Pushes top-level
   * frame URL changes onto a session-scoped buffer that `consumePendingNavs`
   * drains after each `perform_action`. Suppresses duplicates: same-URL
   * refires (Playwright fires framenavigated on every commit, including hash-
   * only changes that resolve to the same URL after normalization at fold
   * time) and entries that were already attributed to an explicit
   * `driver.navigate` call (the perform_action(navigate) handler in index.ts
   * already pushes its own dom_navigation event with `via:'nav'`).
   */
  protected _attachFrameNavigatedCapture(session: Session): void {
    try {
      const page = this._page(session);
      const extras = getExtras(session);
      if (!extras.pendingNavs) extras.pendingNavs = [];
      const buffer = extras.pendingNavs;
      const mainFrame = page.mainFrame();
      page.on('framenavigated', (frame) => {
        try {
          // Subframe navigations (iframes, ad frames) aren't part of the
          // surface map.
          if (frame !== mainFrame) return;
          const url = frame.url();
          if (!url || url === 'about:blank') return;
          // Explicit driver.navigate() commits its own dom_navigation event
          // upstream; the listener exists for click-driven SPA changes,
          // form-submit navs, and history-API transitions.
          if (extras.navigateInFlight) return;
          if (extras.lastObservedNavUrl === url) return;
          extras.lastObservedNavUrl = url;
          buffer.push({ at: Date.now(), url });
        } catch {
          // best-effort — capture failures are non-fatal
        }
      });
    } catch {
      // Page already gone or driver in weird state — capture just won't fire.
    }
  }

  /**
   * Tag same-document (History API) navigations via CDP
   * `Page.navigatedWithinDocument` — the tamper-free replacement for patching
   * `history.pushState`/`replaceState` in the page (a bot-detection tell).
   *
   * `_attachFrameNavigatedCapture` (`page.on('framenavigated')`) already pushes
   * an entry for these — Playwright fires `framenavigated` on History-API
   * transitions too — but without a `via`. This handler *enriches* the matching
   * entry with `via:'pushState'` (or pushes a fresh one if the CDP event won the
   * race). `Page.navigatedWithinDocument` fires ONLY for same-document navs, so
   * cross-document navigations stay via-less (their `via` is derived from the
   * triggering action by the perform_action consumer).
   *
   * `via` fidelity: same-document navs collapse to `pushState` — CDP can't
   * distinguish pushState / replaceState / popstate / hashchange, and it doesn't
   * matter: `NAV_ONLY_VIAS` treats all four identically and `via` is otherwise a
   * cosmetic url-graph edge label.
   */
  protected async _attachSameDocNavCapture(session: Session): Promise<void> {
    try {
      const extras = getExtras(session);
      if (!extras.pendingNavs) extras.pendingNavs = [];
      const buffer = extras.pendingNavs;
      const cdp =
        extras.networkCdp ?? (await this._context(session).newCDPSession(this._page(session)));
      await cdp.send('Page.enable');
      cdp.on('Page.navigatedWithinDocument', (raw: unknown) => {
        try {
          const url = (raw as { url?: string }).url;
          if (!url || url === 'about:blank') return;
          // Enrich the most recent same-URL entry that framenavigated pushed
          // without a via; if none (CDP won the race), push a fresh one.
          for (let i = buffer.length - 1; i >= 0; i -= 1) {
            const e = buffer[i];
            if (e && e.url === url && e.via === undefined) {
              e.via = 'pushState';
              return;
            }
          }
          if (extras.lastObservedNavUrl === url) return;
          extras.lastObservedNavUrl = url;
          buffer.push({ at: Date.now(), url, via: 'pushState' });
        } catch {
          // best-effort
        }
      });
    } catch {
      // Page.enable / listener attach is best-effort; framenavigated still
      // covers cross-document navigation if this fails.
    }
  }

  override consumePendingNavs(session: Session): Promise<
    Array<{
      at: number;
      url: string;
      title?: string;
      via?: NavVia;
    }>
  > {
    const extras = sessionExtras.get(session);
    if (!extras?.pendingNavs || extras.pendingNavs.length === 0) return Promise.resolve([]);
    const drained = extras.pendingNavs.slice();
    extras.pendingNavs.length = 0;
    return Promise.resolve(drained);
  }

  override async captureFormSummary(session: Session): Promise<
    Array<{
      at: number;
      url: string;
      action: string;
      method: string;
      fields: Array<{ name: string; type: string; required?: boolean }>;
    }>
  > {
    try {
      const page = this._page(session);
      const at = Date.now();
      /* eslint-disable
         @typescript-eslint/no-explicit-any,
         @typescript-eslint/no-unsafe-assignment,
         @typescript-eslint/no-unsafe-member-access,
         @typescript-eslint/no-unsafe-call,
         @typescript-eslint/no-unsafe-argument,
         @typescript-eslint/no-unnecessary-type-assertion */
      const result = (await withPageOpTimeout(
        page.evaluate(() => {
          const g = globalThis as any;
          const doc = g.document;
          if (!doc || typeof doc.querySelectorAll !== 'function') {
            return { url: '', forms: [] };
          }
          const forms = Array.from(doc.querySelectorAll('form')) as any[];
          return {
            url: doc.location?.href ?? '',
            forms: forms.map((f: any) => ({
              action: typeof f.action === 'string' ? f.action : '',
              method: (typeof f.method === 'string' ? f.method : 'GET').toUpperCase(),
              fields: Array.from(f.elements as ArrayLike<any>)
                .filter((e: any) => e && typeof e.name === 'string' && e.name.length > 0)
                .map((e: any) => {
                  const out: { name: string; type: string; required?: boolean } = {
                    name: e.name,
                    type: typeof e.type === 'string' ? e.type : 'text',
                  };
                  if (e.required === true) out.required = true;
                  return out;
                }),
            })),
          };
        }),
        'capture_form_summary',
      )) as {
        url: string;
        forms: Array<{
          action: string;
          method: string;
          fields: Array<{ name: string; type: string; required?: boolean }>;
        }>;
      };
      return result.forms.map((f) => ({
        at,
        url: result.url,
        action: f.action,
        method: f.method,
        fields: f.fields,
      }));
      /* eslint-enable
         @typescript-eslint/no-explicit-any,
         @typescript-eslint/no-unsafe-assignment,
         @typescript-eslint/no-unsafe-member-access,
         @typescript-eslint/no-unsafe-call,
         @typescript-eslint/no-unsafe-argument,
         @typescript-eslint/no-unnecessary-type-assertion */
    } catch {
      return [];
    }
  }

  override async inspectActionTarget(
    session: Session,
    selector: string,
  ): Promise<{
    tag: string;
    href: string | null;
    onclick: string | null;
    formaction: string | null;
    inputType: string;
    inWriteForm: boolean;
    submitLike: boolean;
    isDisclosureToggle: boolean;
  } | null> {
    try {
      const page = this._page(session);
      const locator = page.locator(selector).first();
      const handle = await locator.elementHandle({ timeout: 1000 });
      if (!handle) return null;
      /* eslint-disable
         @typescript-eslint/no-explicit-any,
         @typescript-eslint/no-unsafe-assignment,
         @typescript-eslint/no-unsafe-member-access,
         @typescript-eslint/no-unsafe-call,
         @typescript-eslint/no-unsafe-return,
         @typescript-eslint/no-unnecessary-type-conversion */
      const result = (await handle.evaluate((el) => {
        const e = el as any;
        const tag: string = e.tagName ? String(e.tagName).toLowerCase() : '';
        const getAttr = (name: string): string | null =>
          typeof e.getAttribute === 'function' ? (e.getAttribute(name) ?? null) : null;
        const href = getAttr('href');
        const onclick = getAttr('onclick');
        const formaction = getAttr('formaction');
        const form: any = typeof e.closest === 'function' ? e.closest('form') : null;
        let inWriteForm = false;
        if (form) {
          const m = String(form.getAttribute('method') ?? 'get').toLowerCase();
          inWriteForm = m === 'post' || m === 'put' || m === 'delete' || m === 'patch';
        }
        const inputType = tag === 'input' ? String(getAttr('type') ?? 'text').toLowerCase() : '';
        const submitLike =
          tag === 'button' ||
          (tag === 'input' && (inputType === 'submit' || inputType === 'image')) ||
          formaction !== null;
        // Disclosure toggles: accordion section headers, dropdown triggers,
        // expandable panels. ARIA-1.2 disclosure pattern is `aria-expanded`
        // (any value) or `aria-controls` pointing at the panel; HTML native
        // is `<summary>` inside `<details>`. All three flip local UI state
        // only; the map-mode gate exempts them.
        const ariaExpanded = getAttr('aria-expanded');
        const ariaControls = getAttr('aria-controls');
        const insideDetails: boolean =
          tag === 'summary' && typeof e.closest === 'function' && e.closest('details') !== null;
        const isDisclosureToggle =
          ariaExpanded !== null ||
          (ariaControls !== null && ariaControls.length > 0) ||
          insideDetails;
        return {
          tag,
          href,
          onclick,
          formaction,
          inputType,
          inWriteForm,
          submitLike,
          isDisclosureToggle,
        };
      })) as {
        tag: string;
        href: string | null;
        onclick: string | null;
        formaction: string | null;
        inputType: string;
        inWriteForm: boolean;
        submitLike: boolean;
        isDisclosureToggle: boolean;
      };
      try {
        await handle.dispose();
      } catch {
        /* non-fatal */
      }
      return result;
      /* eslint-enable
         @typescript-eslint/no-explicit-any,
         @typescript-eslint/no-unsafe-assignment,
         @typescript-eslint/no-unsafe-member-access,
         @typescript-eslint/no-unsafe-call,
         @typescript-eslint/no-unsafe-return,
         @typescript-eslint/no-unnecessary-type-conversion */
    } catch {
      return null;
    }
  }

  override async findByRoleTolerant(
    session: Session,
    role: string,
    name: string | undefined,
    nameMatch: 'substring' | 'any',
    opts?: PageOpts,
  ): Promise<{ accessibleName: string | null } | null> {
    try {
      const page = this._page(session, opts?.page);
      // Cast through `unknown` because Playwright types `getByRole`'s `role`
      // parameter as a string-literal union and the captured value comes from
      // a recorded step (typed `string` here). The downstream API performs the
      // same string comparison either way.
      const roleArg = role as Parameters<Page['getByRole']>[0];
      const locator =
        nameMatch === 'substring' && name
          ? page.getByRole(roleArg, { name, exact: false })
          : page.getByRole(roleArg);
      const count = await locator.count();
      if (count !== 1) return null;
      /* eslint-disable
         @typescript-eslint/no-explicit-any,
         @typescript-eslint/no-unsafe-assignment,
         @typescript-eslint/no-unsafe-member-access,
         @typescript-eslint/no-unsafe-call,
         @typescript-eslint/no-unsafe-return */
      const accessibleName = await locator
        .first()
        .evaluate((el) => {
          const e = el as any;
          const aria = typeof e.getAttribute === 'function' ? e.getAttribute('aria-label') : null;
          if (typeof aria === 'string' && aria.trim()) return aria.trim();
          const text = typeof e.textContent === 'string' ? e.textContent.trim() : '';
          if (text) return text;
          const title = typeof e.getAttribute === 'function' ? e.getAttribute('title') : null;
          if (typeof title === 'string' && title.trim()) return title.trim();
          return null;
        })
        .catch(() => null);
      return { accessibleName };
      /* eslint-enable
         @typescript-eslint/no-explicit-any,
         @typescript-eslint/no-unsafe-assignment,
         @typescript-eslint/no-unsafe-member-access,
         @typescript-eslint/no-unsafe-call,
         @typescript-eslint/no-unsafe-return */
    } catch {
      return null;
    }
  }

  /**
   * Install every script in `this.initScripts` on the session's context.
   * `addInitScript` runs before any page-owned JS on every navigation, so the
   * monkey-patched globals are in place before the site creates its
   * connections. We also `page.evaluate` each script once on the current
   * document (typically about:blank at session creation) so the patch is also
   * live for any code that manages to run before the first real navigation.
   * Built-in scripts short-circuit on a sentinel check on `window`; subclass-
   * registered scripts should follow the same idempotency convention.
   */
  protected async _installRegisteredInitScripts(session: Session): Promise<void> {
    try {
      const context = this._context(session);
      for (const { source } of this.initScripts) {
        // eslint-disable-next-line no-restricted-syntax
        await context.addInitScript(source);
      }
    } catch {
      // Context may already be gone in a teardown race — capture just won't
      // fire; non-fatal.
    }
    try {
      const page = this._page(session);
      for (const { source } of this.initScripts) {
        await page.evaluate(source);
      }
    } catch {
      // Current page may not be ready (or may already have run its own scripts
      // on a pre-existing doc). Future navigations still pick up the patch via
      // addInitScript, which is the load-bearing path.
    }
  }

  /**
   * Return true if any WebSocket in the page's registry whose `__kluraUrl`
   * startsWith `urlPrefix` is currently in readyState OPEN. Returns false when
   * the page has no registry (script failed to install), when no socket matches
   * the prefix, or when every match is still CONNECTING / CLOSING / CLOSED.
   */
  async hasOpenWebSocket(session: Session, urlPrefix: string): Promise<boolean> {
    try {
      const cdp = await this._cdp(session);
      return await withPageOpTimeout(hasOpenSocket(cdp, urlPrefix), 'has_open_websocket');
    } catch {
      return false;
    }
  }

  /**
   * Send `payload` on the first OPEN WebSocket in the page whose URL starts with
   * `urlPrefix`. Live sockets are enumerated over CDP (queryObjects on
   * WebSocket.prototype) — no page-side registry — so the page stays untampered.
   * For `encoding: 'binary'`, payload is treated as base64 and decoded to a
   * Uint8Array before send. Returns `{ok: true}` on send (no ack wait — that's
   * the executor's job), or `{ok: false, error}` on any failure.
   */
  async sendWebSocketFrame(
    session: Session,
    urlPrefix: string,
    payload: string,
    opts: { encoding?: 'text' | 'binary' } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const encoding: 'text' | 'binary' = opts.encoding === 'binary' ? 'binary' : 'text';
    try {
      const cdp = await this._cdp(session);
      return await sendOnLiveSocket(cdp, urlPrefix, payload, encoding);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  protected async _attachNetworkCapture(session: Session): Promise<void> {
    if (session.intercepting) return;
    session.intercepting = true;
    const extras = getExtras(session);
    try {
      const context = this._context(session);
      const page = this._page(session);
      const cdp = await context.newCDPSession(page);
      extras.networkCdp = cdp;
      if (!extras.loadedScripts) extras.loadedScripts = [];
      await attachCdpNetworkCapture(
        cdp as unknown as Parameters<typeof attachCdpNetworkCapture>[0],
        session.intercepted as Parameters<typeof attachCdpNetworkCapture>[1],
        extras.loadedScripts,
      );
    } catch {
      // Network.enable or CDP session creation failed — the session still
      // works, just without network capture. Matches docker driver-server's
      // behavior: it logs the error and continues.
      session.intercepting = false;
    }
  }

  // Lazily create a CDP session for touch dispatch. CDP is cheap but not free,
  // so we cache it per Session and reuse across events.
  private async _cdp(session: Session): Promise<CDPSession> {
    const extras = getExtras(session);
    if (extras.cdp) return extras.cdp;
    const context = this._context(session);
    extras.cdp = await context.newCDPSession(this._page(session));
    return extras.cdp;
  }

  /**
   * Warm-pool reset: clear per-session ephemeral state (network capture, CDP
   * sessions, focus listeners, intercepted log) and return the context/page to
   * a neutral idle state without tearing either down. Called by `Pool` when a
   * new klura session checks out an idle warm entry. Optional `storageState`
   * layers a fresh cookie jar on top of the existing profile — we never
   * `clearCookies` first because warm entries are per-platform and reusing the
   * profile is the point.
   *
   * Throws if the underlying context/page crashed while stashed. The caller is
   * expected to catch and fall back to a cold spawn.
   */
  async probePageReady(
    session: Session,
    urlPrefix: string,
    wsUrlPrefix?: string,
  ): Promise<{ page_on_url: boolean; ws_open?: boolean }> {
    // Side-effect-free readiness check for pool.tryCheckoutReadySession. Treat
    // any failure ("session's page was closed", "context crashed") as "not
    // ready" — the protocol explicitly promises not to throw.
    try {
      const page = this._page(session);
      const currentUrl = page.url();
      const page_on_url = typeof currentUrl === 'string' && currentUrl.startsWith(urlPrefix);
      if (wsUrlPrefix === undefined) {
        return { page_on_url };
      }
      if (!page_on_url) return { page_on_url, ws_open: false };
      const ws_open = await hasOpenSocket(await this._cdp(session), wsUrlPrefix);
      return { page_on_url, ws_open };
    } catch {
      return { page_on_url: false };
    }
  }

  async resetSession(session: Session, options: SessionOptions = {}): Promise<void> {
    // Debugger teardown runs first: a lease can arrive with breakpoints still
    // armed (a session stashed via a teardown path that skips the end-drive
    // debugger cleanup), and an inherited pause would freeze the recycled
    // page at a stop no consumer is waiting on. Idempotent no-op when the
    // Debugger domain was never enabled.
    await this.cleanupDebuggerState(session);
    const context = this._context(session);
    const page = this._page(session);

    const extras = sessionExtras.get(session);
    if (extras?.screencastCdp) {
      try {
        await extras.screencastCdp.send('Page.stopScreencast');
      } catch {
        /* screencast may not be running */
      }
      try {
        await extras.screencastCdp.detach();
      } catch {
        /* already detached */
      }
      extras.screencastCdp = undefined;
      extras.screencastStarted = false;
      extras.lastScreencastFrame = undefined;
    }
    if (extras?.networkCdp) {
      try {
        await extras.networkCdp.detach();
      } catch {
        /* already detached */
      }
      extras.networkCdp = undefined;
    }
    if (extras?.cdp) {
      try {
        await extras.cdp.detach();
      } catch {
        /* already detached */
      }
      extras.cdp = undefined;
    }
    if (extras) {
      extras.focusListeners.clear();
      extras.focusInstalled = false;
    }

    // Detach the passive WebSocket capture listener so frames from the previous
    // klura session's flow don't bleed into the new one. A fresh one gets
    // attached below after the neutral-page navigation.
    if (extras?.wsCaptureListener) {
      try {
        page.off('websocket', extras.wsCaptureListener);
      } catch {
        /* page may already be gone */
      }
      extras.wsCaptureListener = undefined;
    }

    // Close any popups left over from the previous flow and detach the
    // context-level popup listener — a fresh one gets attached below. Popups
    // and their entries don't survive a warm-pool recycle: the next klura
    // session expects an empty sub-page list and id counter restart.
    if (extras?.popupContextListener) {
      try {
        context.off('page', extras.popupContextListener);
      } catch {
        /* context may already be gone */
      }
      extras.popupContextListener = undefined;
    }
    if (extras) {
      extras.nextPopupSuffix = 1;
      extras.subPagesListeners.clear();
    }
    const pageMap = sessionPages.get(session);
    if (pageMap) {
      for (const [id, p] of pageMap) {
        if (id === MAIN_PAGE) continue;
        try {
          if (!p.isClosed()) await p.close();
        } catch {
          /* popup may already be closed */
        }
        pageMap.delete(id);
      }
    }

    session.intercepted.length = 0;
    session.intercepting = false;
    session.visitedUrls = undefined;
    session.subPages = [];
    if (session.wsFrames) session.wsFrames.length = 0;
    else session.wsFrames = [];
    // Clear armed send-capture state so a recycled context starts clean.
    const resetExtras = sessionExtras.get(session);
    if (resetExtras) {
      resetExtras.sendCaptures = [];
      resetExtras.sendCaptureRefCount = 0;
      resetExtras.loadedScripts = [];
      // Nav bookkeeping and the JS source cache are logical per-session
      // state riding the extras bundle — they belong to the released
      // session's flow, not the next one. `pendingNavs` truncates in place:
      // the attached framenavigated / navigatedWithinDocument listeners hold
      // the array by identity.
      if (resetExtras.pendingNavs) resetExtras.pendingNavs.length = 0;
      resetExtras.lastObservedNavUrl = undefined;
      resetExtras.jsSourceCache = undefined;
    }

    if (options.storageState) {
      try {
        const fs = await import('fs');
        if (fs.existsSync(options.storageState)) {
          const jar = JSON.parse(fs.readFileSync(options.storageState, 'utf-8')) as {
            cookies?: Parameters<BrowserContext['addCookies']>[0];
          };
          if (jar.cookies && jar.cookies.length > 0) {
            await context.addCookies(jar.cookies);
          }
        }
      } catch (err) {
        console.warn(
          `[playwright-driver] failed to layer storage state during reset: ${String(err)}`,
        );
      }
    }

    // Navigate to a neutral page to cancel in-flight requests and release
    // per-page memory. `about:blank` has no resources, so DCL resolves
    // immediately.
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });

    await this._instrumentSession(session);
  }

  async destroySession(session: Session): Promise<void> {
    await this.cleanupDebuggerState(session);
    const extras = sessionExtras.get(session);
    if (extras?.screencastCdp) {
      try {
        await extras.screencastCdp.send('Page.stopScreencast');
      } catch {
        /* screencast may not be running */
      }
      try {
        await extras.screencastCdp.detach();
      } catch {
        /* already detached */
      }
      extras.screencastCdp = undefined;
      extras.screencastStarted = false;
      extras.lastScreencastFrame = undefined;
    }
    if (extras?.networkCdp) {
      try {
        await extras.networkCdp.detach();
      } catch {
        /* already detached */
      }
      extras.networkCdp = undefined;
    }
    if (extras?.cdp) {
      try {
        await extras.cdp.detach();
      } catch {
        /* already detached */
      }
      extras.cdp = undefined;
    }
    if (extras) extras.focusListeners.clear();
    try {
      await this._page(session).close();
    } catch {
      // Page may already be closed
    }
    try {
      await this._context(session).close();
    } catch {
      // Context may already be closed
    }
    sessionExtras.delete(session);
    sessionPages.delete(session);
    sessionContexts.delete(session);
  }

  /** Detached warm-slot resource bundles, keyed by leaseId. Entries are
   *  consumed by `attachLease` and removed by `destroyLease`. */
  private readonly _leases = new Map<string, LeaseRecord>();

  override detachLease(session: Session): BrowserLease | null {
    const context = sessionContexts.get(session);
    const pageMap = sessionPages.get(session);
    if (!context || !pageMap) return null;
    const record: LeaseRecord = {
      context,
      pageMap,
      extras: sessionExtras.get(session),
      removedInitScripts: sessionRemovedInitScripts.get(session),
      intercepted: session.intercepted,
      intercepting: session.intercepting,
      wsFrames: session.wsFrames ?? [],
      subPages: session.subPages ?? [],
    };
    sessionContexts.delete(session);
    sessionPages.delete(session);
    sessionExtras.delete(session);
    sessionRemovedInitScripts.delete(session);
    const leaseId = 'lease_' + crypto.randomBytes(6).toString('hex');
    this._leases.set(leaseId, record);
    return { leaseId };
  }

  override attachLease(session: Session, lease: BrowserLease): void {
    const record = this._leases.get(lease.leaseId);
    if (!record) {
      throw new Error(`attachLease: lease ${lease.leaseId} is not held by this driver`);
    }
    this._leases.delete(lease.leaseId);
    sessionContexts.set(session, record.context);
    sessionPages.set(session, record.pageMap);
    if (record.extras) sessionExtras.set(session, record.extras);
    if (record.removedInitScripts) {
      sessionRemovedInitScripts.set(session, record.removedInitScripts);
    }
    // Rebind the capture arrays by identity: the page/CDP listeners attached
    // while the lease's previous session was live hold references to these
    // exact arrays, so the fresh Session must adopt them (not fresh empties)
    // for capture continuity on the borrow path. `resetSession` truncates
    // them in place when the checkout wants a clean slate.
    session.intercepted = record.intercepted;
    session.intercepting = record.intercepting;
    session.wsFrames = record.wsFrames;
    session.subPages = record.subPages;
  }

  override async destroyLease(lease: BrowserLease): Promise<void> {
    const record = this._leases.get(lease.leaseId);
    if (!record) return;
    this._leases.delete(lease.leaseId);
    // Bind the record onto a throwaway Session shell and run the ordinary
    // destroySession teardown — one teardown path, no drift between "close a
    // live session" and "evict an idle lease".
    const shell: Session = {
      id: 'lease_teardown_' + lease.leaseId,
      intercepted: record.intercepted,
      intercepting: record.intercepting,
      wsFrames: record.wsFrames,
      subPages: record.subPages,
    };
    sessionContexts.set(shell, record.context);
    sessionPages.set(shell, record.pageMap);
    if (record.extras) sessionExtras.set(shell, record.extras);
    if (record.removedInitScripts) {
      sessionRemovedInitScripts.set(shell, record.removedInitScripts);
    }
    await this.destroySession(shell);
  }

  async navigate(
    session: Session,
    url: string,
    options: {
      waitUntil?: 'commit' | 'domcontentloaded' | 'networkidle';
      timeout_ms?: number;
    } = {},
  ): Promise<void> {
    const extras = getExtras(session);
    extras.navigateInFlight = true;
    try {
      await this._page(session).goto(url, {
        waitUntil: options.waitUntil ?? 'domcontentloaded',
        ...(options.timeout_ms === undefined ? {} : { timeout: options.timeout_ms }),
      });
    } finally {
      // Stamp the post-navigation URL so the framenavigated listener doesn't
      // re-emit it as a click-driven nav after this method returns.
      try {
        extras.lastObservedNavUrl = this._page(session).url();
      } catch {
        // page may already be gone — fall back to the requested URL
        extras.lastObservedNavUrl = url;
      }
      extras.navigateInFlight = false;
    }
    // Track explicitly-navigated URLs on the session so the save-time
    // observation validator can cross-reference page-extract prereqs against
    // pages the agent visited. The CDP network log doesn't include top-level
    // document navigations in klura's capture, so without this list the
    // validator false-positives on legitimate page-extract prereq URLs. See
    // Session.visitedUrls for the full rationale.
    session.visitedUrls ??= [];
    session.visitedUrls.push(url);
  }

  async waitForNavigation(session: Session, options: { timeout?: number } = {}): Promise<void> {
    // Wait for an actual navigation (new URL committed), not just a DOM load
    // event on the current page. waitForLoadState('domcontentloaded') is a
    // no-op when the DCL event already fired on the current document, which
    // silently completes in ~0ms on recorded-path replays that click a submit
    // button without the page navigating — the step returns success even though
    // nothing happened.
    //
    // snapshot the pre-navigation URL and poll until either it changes or the
    // timeout fires. Polling avoids Playwright's
    // waitForNavigation()/waitForURL() quirks around navigations that fire as
    // XHR responses without a full document navigation; if the URL doesn't
    // change within the timeout, throw so the recorded-path executor surfaces a
    // healable blocker instead of falsely succeeding.
    const page = this._page(session);
    const startUrl = page.url();
    const timeout = options.timeout ?? 10000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (page.url() !== startUrl) {
        // URL changed — wait for the new document to reach DCL so the next step
        // sees a stable DOM, then return.
        await page
          .waitForLoadState('domcontentloaded', { timeout: Math.max(1000, deadline - Date.now()) })
          .catch(() => {
            /* new document may already be DCL — best-effort */
          });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `waitForNavigation: page did not navigate within ${timeout}ms (still at ${startUrl})`,
    );
  }

  async click(
    session: Session,
    selector: string,
    opts?: PageOpts,
  ): Promise<{ name?: string } | undefined> {
    const locator = resolveLocator(this._page(session, opts?.page), selector);
    // Capture the element's accessible name before the click fires. Short
    // timeout + catch(): if the element isn't resolvable fast, we fall
    // through to the click itself (which has a longer await-resolve).
    // Name resolution order matches WAI-ARIA a11y-name computation in the
    // common cases: explicit aria-label → visible text → title → placeholder.
    let name: string | null;
    try {
      /* eslint-disable
         @typescript-eslint/no-explicit-any,
         @typescript-eslint/no-unsafe-assignment,
         @typescript-eslint/no-unsafe-member-access,
         @typescript-eslint/no-unsafe-call,
         @typescript-eslint/no-unsafe-return */
      name = await locator.evaluate(
        (el: any): string | null => {
          const ariaLabel = el.getAttribute?.('aria-label');
          if (typeof ariaLabel === 'string' && ariaLabel.trim().length > 0) return ariaLabel.trim();
          const text = el.textContent;
          if (typeof text === 'string' && text.trim().length > 0) return text.trim();
          const title = el.getAttribute?.('title');
          if (typeof title === 'string' && title.trim().length > 0) return title.trim();
          if (typeof el.placeholder === 'string' && el.placeholder.trim().length > 0) {
            return el.placeholder.trim();
          }
          return null;
        },
        undefined,
        { timeout: 500 },
      );
      /* eslint-enable
         @typescript-eslint/no-explicit-any,
         @typescript-eslint/no-unsafe-assignment,
         @typescript-eslint/no-unsafe-member-access,
         @typescript-eslint/no-unsafe-call,
         @typescript-eslint/no-unsafe-return */
    } catch {
      name = null;
    }
    await locator.click({ timeout: 5000 });
    return name ? { name } : undefined;
  }

  async type(
    session: Session,
    selector: string,
    text: string,
    opts?: { replace?: boolean } & PageOpts,
  ): Promise<void> {
    const locator = resolveLocator(this._page(session, opts?.page), selector);
    if (opts?.replace) {
      // Explicit clear-and-fill — form corrections, password resets.
      await locator.fill(text, { timeout: 5000 });
      return;
    }
    // Detect empty vs non-empty. `value` covers <input>/<textarea>;
    // `textContent` covers contenteditable. Both treated as emptiness
    // heuristics so the fast-path fill still wins on the login-form /
    // search-box shape, and pre-populated editors get the append-at-cursor path
    // (which is what every agent writing `type` expects when the field already
    // has content). DOM types are in-page; pass the predicate as a raw function
    // so Playwright serializes it and evaluates browser-side.
    const isEmpty = await locator.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el: any): boolean => {
        const v = (el as { value?: unknown }).value;
        if (typeof v === 'string') return v.length === 0;
        return ((el as { textContent?: string | null }).textContent ?? '').length === 0;
      },
      undefined,
      { timeout: 5000 },
    );
    if (isEmpty) {
      await locator.fill(text, { timeout: 5000 });
      return;
    }
    // Non-empty: focus + move caret to end, then type-sequentially so the value
    // appends instead of replacing. `press("End")` covers <input> / <textarea>;
    // contenteditable responds to the same key.
    await locator.focus({ timeout: 5000 });
    await locator.press('End', { timeout: 5000 });
    await locator.pressSequentially(text, { delay: 0, timeout: 10_000 });
  }

  async fillEditor(
    session: Session,
    selector: string,
    text: string,
    opts?: PageOpts,
  ): Promise<void> {
    const page = this._page(session, opts?.page);
    // Reject-don't-coerce: a fill_editor selector that matches more than one
    // element is a disambiguation bug, not an edge case. Pages with multiple
    // rich-text editors (submit forms with a title contenteditable and a body
    // contenteditable, both Lexical; composer drafts in side panels; modal
    // editors opened behind the canonical one) will silently focus the wrong
    // one and dump the typed text into the wrong field. Throw a specific error
    // that points at the `:!nth(N)` fix so the agent can retry with an
    // unambiguous selector on the next turn. NOTE: we count on the bare CSS
    // selector (pre-resolveLocator) so the count reflects the real match set,
    // not the .first()-narrowed singleton.
    const isA11ySelector = A11Y_SELECTOR_RE.exec(selector) !== null;
    const hasNthSuffix = CSS_NTH_SUFFIX_RE.exec(selector) !== null;
    const bareLocator = isA11ySelector
      ? resolveLocator(page, selector)
      : page.locator(stripNthSuffix(selector));
    const count = await bareLocator.count();
    if (count === 0) {
      throw new Error(`fill_editor: selector "${selector}" matched zero elements`);
    }
    if (count > 1 && !hasNthSuffix && !isA11ySelector) {
      throw new Error(
        `fill_editor: selector "${selector}" matches ${count} elements; ` +
          `disambiguate with the :!nth(N) suffix (0-based). Example: ` +
          `"${selector}:!nth(0)" targets the first match, "${selector}:!nth(1)" ` +
          `the second, etc. Pages with multiple rich-text editors ` +
          `(title + body both contenteditable) need this — otherwise the ` +
          `focus lands on the first match and the typed text ends up in the ` +
          `wrong field.`,
      );
    }
    const locator = resolveLocator(page, selector);
    // Focus + explicit Selection setup. el.focus() alone is not enough for
    // Lexical/Slate/ProseMirror: those frameworks listen for `selectionchange`
    // on `document` and sync their internal selection model from
    // `window.getSelection()`. If the Selection has no Range inside the
    // contenteditable when `selectionchange` fires, their `beforeinput`
    // handlers reject the subsequent keyboard events and the editor stays empty
    // — even though document.activeElement is correct.
    //
    // For an EMPTY Lexical root (e.g. a rich-text post body editor before first
    // interaction), Chromium's focus() heuristic places the Selection on
    // document.body instead of descending into the editable, so we have to set
    // the Range ourselves. `selectNodeContents(el)` + `collapse(false)` creates
    // a collapsed Range at the end of the editor's content, which is valid for
    // every contenteditable-based editor framework: Lexical's own `<p><br></p>`
    // default child, Slate's `<span data-slate-node>` defaults, ProseMirror's
    // `<p>` placeholder — all are valid Range targets. Dispatching
    // `selectionchange` after assigning the Range triggers the framework's
    // model-sync, so keyboard.type lands per-char insertText events into a
    // valid selection.
    //
    // The `any`-typed parameters are deliberate: this callback runs in
    // Chromium's context (via locator.evaluate) where `document`, `window`,
    // `Range`, `Selection`, and `Event` are native globals. The klura runtime
    // tsconfig excludes the DOM lib (this is a node project), so we disable the
    // unsafe-* rules for the browser-side closure and let the runtime
    // type-check them where they actually exist.
    /* eslint-disable @typescript-eslint/no-explicit-any,
                      @typescript-eslint/no-unsafe-call,
                      @typescript-eslint/no-unsafe-member-access,
                      @typescript-eslint/no-unsafe-assignment,
                      @typescript-eslint/no-unsafe-return */
    // Drill into contenteditable descendants (light + shadow DOM) so a selector
    // aimed at a custom-element composer wrapper still hits the
    // real Lexical root. `el.focus()` on a non-editable wrapper silently falls
    // through to <body>, `selectNodeContents(wrapper)` creates a Range around a
    // non-editable node, and keyboard.type goes nowhere — no throw, just a
    // no-op. Returning an ElementHandle to the element that actually received
    // focus lets the post-type verify check the right node and lets future
    // fills target it directly.
    const focusedHandle = await withPageOpTimeout(
      locator.evaluateHandle((el: any) => {
        const doc = (globalThis as any).document;
        const win = (globalThis as any).window;
        const isEditable = (node: any): boolean =>
          !!node &&
          (node.isContentEditable === true ||
            (node.hasAttribute && node.hasAttribute('data-lexical-editor')));
        const findEditable = (root: any): any => {
          if (!root) return null;
          if (isEditable(root)) return root;
          const direct =
            root.querySelector &&
            root.querySelector('[contenteditable="true"], [data-lexical-editor]');
          if (direct) return direct;
          const hosts = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (const host of hosts) {
            if (host.shadowRoot) {
              const inner = findEditable(host.shadowRoot);
              if (inner) return inner;
            }
          }
          return null;
        };
        const target = findEditable(el) || el;
        target.focus();
        try {
          const range = doc.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          const selection = win.getSelection();
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
          }
          doc.dispatchEvent(new (globalThis as any).Event('selectionchange', { bubbles: true }));
        } catch {
          // Selection API unavailable (old browsers, shadow DOM edge cases).
          // focus() alone may still work for simple contenteditables.
        }
        return target;
      }),
      'fill_editor:focus',
    );
    // Brief wait so the editor framework's selection-sync microtask runs before
    // we start firing key events. 20ms is enough in practice — the sync is a
    // single task boundary, not a network round-trip.
    await page.waitForTimeout(20);
    // Per-character typing so each keystroke fires keydown → beforeinput →
    // input → keyup. That is the event sequence Lexical-class editors intercept
    // to update their internal model; page.keyboard.insertText dispatches a
    // single consolidated input event that some editor frameworks ignore.
    await withPageOpTimeout(page.keyboard.type(text, { delay: 10 }), 'fill_editor:type');
    // Loud failure over silent no-op. If we typed non-empty text but the
    // focused element's text content is still empty, the drill-down missed:
    // either the editable lives behind a closed shadow root, or the wrapper
    // intercepts keyboard events without forwarding them. Throw with the list
    // of editable candidates on the page so the agent can retry with a direct
    // selector instead of spelunking shadow DOM by hand.
    if (text.length > 0) {
      const gotChars = await focusedHandle.evaluate(
        (el: any) => ((el && el.textContent) || '').length,
      );
      if (gotChars === 0) {
        const candidates: string[] = await page.evaluate(() => {
          const out: string[] = [];
          const walk = (root: any): void => {
            const matches = root.querySelectorAll
              ? root.querySelectorAll('[contenteditable="true"], [data-lexical-editor]')
              : [];
            for (const node of matches) {
              const tag = node.tagName ? node.tagName.toLowerCase() : '?';
              const id = node.id ? `#${node.id}` : '';
              const aria = node.getAttribute && node.getAttribute('aria-label');
              const name = node.getAttribute && node.getAttribute('name');
              const extras = [name ? `[name="${name}"]` : '', aria ? ` aria-label="${aria}"` : '']
                .filter(Boolean)
                .join('');
              out.push(`${tag}${id}${extras}`);
            }
            const hosts = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (const host of hosts) {
              if (host.shadowRoot) walk(host.shadowRoot);
            }
          };
          walk((globalThis as any).document);
          return out;
        });
        await focusedHandle.dispose();
        throw new Error(
          `fill_editor: typed ${text.length} chars into selector "${selector}" but the focused element's text is still empty. ` +
            `The resolved element isn't receiving input — likely a wrapper with no contenteditable descendant reachable through open shadow roots. ` +
            `Editable candidates found on the page: ${candidates.length ? candidates.join(', ') : '(none)'}. ` +
            `Retry with one of those selectors; use :!nth(N) to pick the right match when there are multiple.`,
        );
      }
      await focusedHandle.dispose();
    } else {
      await focusedHandle.dispose();
    }
    /* eslint-enable @typescript-eslint/no-explicit-any,
                     @typescript-eslint/no-unsafe-call,
                     @typescript-eslint/no-unsafe-member-access,
                     @typescript-eslint/no-unsafe-assignment,
                     @typescript-eslint/no-unsafe-return */
  }

  async select(session: Session, selector: string, value: string, opts?: PageOpts): Promise<void> {
    await resolveLocator(this._page(session, opts?.page), selector).selectOption(value, {
      timeout: 5000,
    });
  }

  async getText(session: Session, selector: string, opts?: PageOpts): Promise<string> {
    return (
      (await resolveLocator(this._page(session, opts?.page), selector).textContent({
        timeout: 5000,
      })) || ''
    );
  }

  getUrl(session: Session, opts?: PageOpts): Promise<string> {
    return Promise.resolve(this._page(session, opts?.page).url());
  }

  async listTopLevelIframes(
    session: Session,
    opts?: PageOpts,
  ): Promise<ReadonlyArray<{ src: string }>> {
    const page = this._page(session, opts?.page);
    /* eslint-disable
       @typescript-eslint/no-explicit-any,
       @typescript-eslint/no-unsafe-assignment,
       @typescript-eslint/no-unsafe-member-access,
       @typescript-eslint/no-unsafe-call */
    return page
      .evaluate(() => {
        const g = globalThis as any;
        const doc = g.document;
        if (!doc || typeof doc.querySelectorAll !== 'function') return [];
        return Array.from(doc.querySelectorAll('iframe') as ArrayLike<any>).map((el: any) => ({
          src: typeof el.src === 'string' ? el.src : '',
        }));
      })
      .catch(() => []);
    /* eslint-enable
       @typescript-eslint/no-explicit-any,
       @typescript-eslint/no-unsafe-assignment,
       @typescript-eslint/no-unsafe-member-access,
       @typescript-eslint/no-unsafe-call */
  }

  async snapVisibilityForInteractiveNodes(
    session: Session,
    opts?: PageOpts,
  ): Promise<ReadonlyArray<{ role: string; name: string; _v: 'o' | 'f' | 's' }>> {
    const page = this._page(session, opts?.page);
    /* eslint-disable
       @typescript-eslint/no-explicit-any,
       @typescript-eslint/no-unsafe-assignment,
       @typescript-eslint/no-unsafe-member-access,
       @typescript-eslint/no-unsafe-call */
    return page
      .evaluate(() => {
        const g = globalThis as any;
        const doc = g.document;
        const win = g.window;
        if (!doc || !win || typeof doc.querySelectorAll !== 'function') return [];
        const selectors = [
          'button',
          'a[href]',
          'input:not([type="hidden"])',
          'select',
          'textarea',
          '[role="button"]',
          '[role="link"]',
          '[role="checkbox"]',
          '[role="menuitem"]',
          '[role="tab"]',
          '[role="option"]',
          '[role="switch"]',
        ];
        const seen = new Set<any>();
        const out: Array<{ role: string; name: string; _v: 'o' | 'f' | 's' }> = [];
        for (const sel of selectors) {
          const els = doc.querySelectorAll(sel);
          for (let i = 0; i < els.length; i++) {
            if (out.length >= 100) return out;
            const el: any = els[i];
            if (seen.has(el)) continue;
            seen.add(el);
            let rect: any;
            try {
              rect = el.getBoundingClientRect();
            } catch {
              continue;
            }
            const w = Number(rect.width);
            const h = Number(rect.height);
            if (w === 0 || h === 0) continue; // hidden / display:none — skip silently
            const vw = Number(win.innerWidth || doc.documentElement.clientWidth);
            const vh = Number(win.innerHeight || doc.documentElement.clientHeight);
            const left = Number(rect.left);
            const top = Number(rect.top);
            const inX = left + w > 0 && left < vw;
            const inY = top + h > 0 && top < vh;
            let v: 'o' | 'f' | 's' | null = null;
            if (!inY) v = 'f';
            else if (!inX) v = 's';
            else {
              const cx = left + w / 2;
              const cy = top + h / 2;
              const topEl: any = doc.elementFromPoint(cx, cy);
              const sameOrNested =
                topEl && (topEl === el || el.contains(topEl) || topEl.contains(el));
              if (!sameOrNested) v = 'o';
            }
            if (v === null) continue;
            const explicitRole = el.getAttribute('role');
            const role = explicitRole || (el.tagName ? String(el.tagName).toLowerCase() : '');
            const ariaLabel = el.getAttribute('aria-label');
            const text = el.textContent || el.value || el.placeholder || '';
            const name = String(ariaLabel || text)
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 60);
            out.push({ role, name, _v: v });
          }
        }
        return out;
      })
      .catch(() => []);
    /* eslint-enable
       @typescript-eslint/no-explicit-any,
       @typescript-eslint/no-unsafe-assignment,
       @typescript-eslint/no-unsafe-member-access,
       @typescript-eslint/no-unsafe-call */
  }

  async delay(session: Session, ms: number): Promise<void> {
    await this._page(session).waitForTimeout(ms);
  }

  async waitForSelector(
    session: Session,
    selector: string,
    options: { timeout?: number } & PageOpts = {},
  ): Promise<void> {
    await this._page(session, options.page).waitForSelector(selector, {
      timeout: options.timeout ?? 5000,
    });
  }

  async getAttribute(
    session: Session,
    selector: string,
    attr: string,
    opts?: PageOpts,
  ): Promise<string> {
    const el = resolveLocator(this._page(session, opts?.page), selector);
    return (await el.getAttribute(attr, { timeout: 5000 })) ?? '';
  }

  /**
   * Describe the encoder output behind a captured sent frame: a preview of the
   * bytes, their length, the socket URL, and whether an OPEN socket for that URL
   * still exists (so the agent knows a live re-send is possible). Everything is
   * derived host-side from `session.wsFrames[wsI]` — WebSocket.send takes only
   * serialized data, so the frame's wire payload is exactly what the encoder
   * produced. `wsI` indexes `session.wsFrames[]` (sent + received); a received
   * frame returns `{reason:'frame_received'}`. The agent pairs this with the
   * frame's `js_callstack` (captured via trigger_reference_send) to locate the
   * encoder source.
   */
  async getSendEncoderInfo(
    session: Session,
    wsI: number,
  ): Promise<
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
    | { reason: 'frame_out_of_range' | 'frame_received' }
  > {
    // Re-source everything host-side from the captured sent frame. WebSocket.send
    // only accepts already-serialized data (string / ArrayBuffer / Blob), so the
    // frame's wire payload IS the bytes the encoder produced — no page-side stash
    // is needed, and the page stays untampered.
    const frame = session.wsFrames?.[wsI];
    if (!frame) return { reason: 'frame_out_of_range' };
    if (frame.direction !== 'sent') return { reason: 'frame_received' };
    const bytes = Buffer.from(frame.payload, 'binary');
    const headHex = bytes
      .subarray(0, Math.min(16, bytes.length))
      .reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');
    // Infer text vs binary from the wire bytes — the JS argument type is no
    // longer observable now that send is native.
    let nonPrintable = 0;
    for (const b of bytes) {
      if (b < 9 || (b > 13 && b < 32) || b === 127) nonPrintable += 1;
    }
    const isBinary = bytes.length > 0 && nonPrintable / bytes.length > 0.15;
    let preview: string;
    if (isBinary) {
      preview = bytes
        .subarray(0, Math.min(64, bytes.length))
        .reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');
    } else if (frame.payload.length > 200) {
      preview = frame.payload.slice(0, 200) + '\u2026';
    } else {
      preview = frame.payload;
    }
    // Is there still an OPEN socket for this URL (so the agent could re-send)?
    let handleAlive = false;
    try {
      handleAlive = await hasOpenSocket(await this._cdp(session), frame.url);
    } catch {
      /* readiness probe is best-effort */
    }
    return {
      sent_args_preview: preview,
      sent_args_type: isBinary ? 'binary' : 'text',
      sent_args_byte_length: bytes.length,
      ws_url: frame.url,
      head_hex: headHex,
      ts: frame.timestamp,
      handle_alive: handleAlive,
      encoder_key: String(wsI),
    };
  }

  /**
   * Fetch the raw text body of a JS script the page has already loaded. Used by
   * the runtime-level `getJsSource` tool to read the encoder behind a captured
   * `WebSocket.send` callstack — the agent's "what does this function do"
   * question after `inspect_ws_frame.js_callstack` named the file:line.
   *
   * Per-session cache keyed by URL. The fetch runs inside the page via
   * `page.evaluate(u => fetch(u, {credentials: 'include'}))` — hits the
   * browser's HTTP cache and reuses the page's cookies (necessary for scripts
   * behind auth-walled CDN paths).
   */
  async getJsSource(session: Session, url: string): Promise<string> {
    const extras = getExtras(session);
    if (!extras.jsSourceCache) extras.jsSourceCache = new Map();
    const cached = extras.jsSourceCache.get(url);
    if (cached !== undefined) return cached;
    // Primary path: fetch from the page context. Works for most sites; the
    // browser's HTTP cache handles the lookup so there's no extra network
    // round-trip and page-bound cookies come along for free.
    try {
      const body = await withPageOpTimeout(
        this._page(session).evaluate(
          (u) => fetch(u, { credentials: 'include' }).then((r) => r.text()),
          url,
        ),
        'get_js_source:fetch',
        30_000,
      );
      cacheJsSource(extras.jsSourceCache, url, body);
      return body;
    } catch (fetchErr) {
      // CDN-protected scripts (Meta's static.xx.fbcdn.net, etc.) throw
      // `TypeError: Failed to fetch` because the CDN answers with
      // Access-Control-Allow-Origin: null or doesn't include the page's origin
      // in its ACAO list. The browser already has the script content cached
      // from the original page load though — read it via CDP's
      // Network.loadNetworkResource, which bypasses CORS by running below the
      // browser's CORS layer.
      try {
        const cdp = await this._cdp(session);
        const frameIdResp = (await cdp.send('Page.getFrameTree')) as {
          frameTree: { frame: { id: string } };
        };
        const frameId = frameIdResp.frameTree.frame.id;
        const resp = (await cdp.send('Network.loadNetworkResource', {
          frameId,
          url,
          options: { disableCache: false, includeCredentials: true },
        })) as {
          resource: { success: boolean; stream?: string; httpStatusCode?: number };
        };
        if (!resp.resource.success || !resp.resource.stream) {
          throw new Error(
            `CDP Network.loadNetworkResource failed (http status: ${String(resp.resource.httpStatusCode ?? 'unknown')})`,
            { cause: fetchErr },
          );
        }
        const streamHandle = resp.resource.stream;
        let body = '';
        // Drain the CDP stream in ~1 MB chunks. Most bundles are < 5 MB.
        for (let i = 0; i < 128; i += 1) {
          const chunk = (await cdp.send('IO.read', {
            handle: streamHandle,
            size: 1_048_576,
          })) as { data: string; eof: boolean; base64Encoded?: boolean };
          body += chunk.base64Encoded
            ? Buffer.from(chunk.data, 'base64').toString('utf-8')
            : chunk.data;
          if (chunk.eof) break;
        }
        await cdp.send('IO.close', { handle: streamHandle }).catch(() => {});
        cacheJsSource(extras.jsSourceCache, url, body);
        return body;
      } catch (cdpErr) {
        // Both paths failed — surface the original fetch error with the CDP
        // fallback context so the agent knows both were tried.
        const fetchMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        const cdpMsg = cdpErr instanceof Error ? cdpErr.message : String(cdpErr);
        throw new Error(
          `fetch failed (${fetchMsg}); CDP fallback also failed (${cdpMsg}). ` +
            `The script may not have been loaded by this page (check the URL is one that appears in get_network_log), ` +
            `or it may be served with credentials the browser has but the CDP layer can't access.`,
          { cause: cdpErr },
        );
      }
    }
  }

  async findInPage(
    session: Session,
    needle: string,
    limit = 20,
    opts?: PageOpts,
  ): Promise<Array<{ selector: string; attr?: string; value: string }>> {
    // The closure body runs in Chromium's context via page.evaluate, where
    // `document` / Element / Attr are native globals. tsconfig deliberately
    // excludes the DOM lib (this is a node project), so we pass the
    // browser-side function as a string and keep the TypeScript boundary narrow
    // at { needle, limit } → Array<{ selector, attr?, value }>.
    return await withPageOpTimeout(
      this._page(session, opts?.page).evaluate(
        `((needle, limit) => {
        const out = [];
        const truncate = (s) => s.length > 200 ? s.slice(0, 200) + '…' : s;
        const buildSelector = (el) => {
          const tag = el.tagName.toLowerCase();
          const nm = el.getAttribute('name');
          if (nm && (tag === 'meta' || tag === 'input')) return tag + '[name="' + nm + '"]';
          const id = el.getAttribute('id');
          if (id) return '#' + id;
          for (const a of Array.from(el.attributes)) {
            if (a.name.startsWith('data-') && a.value.length < 80) {
              return tag + '[' + a.name + '="' + a.value + '"]';
            }
          }
          return tag;
        };
        const nodes = Array.from(document.querySelectorAll('*'));
        for (const el of nodes) {
          if (out.length >= limit) break;
          let attrHit = false;
          for (const attr of Array.from(el.attributes)) {
            if (attr.value.includes(needle)) {
              out.push({ selector: buildSelector(el), attr: attr.name, value: truncate(attr.value) });
              attrHit = true;
              break;
            }
          }
          if (attrHit) continue;
          if (el.children.length === 0 && el.textContent && el.textContent.includes(needle)) {
            out.push({ selector: buildSelector(el), value: truncate(el.textContent.trim()) });
          }
        }
        return out;
      })(${JSON.stringify(needle)}, ${limit})`,
      ),
      'find_in_page',
    );
  }

  async fetchInBrowser(
    session: Session,
    url: string,
    options: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      credentials?: 'include' | 'omit' | 'same-origin';
      timeout_ms?: number;
    },
  ): Promise<
    | {
        ok: true;
        status: number;
        body: unknown;
        finalUrl: string;
        delivery_state: 'response_received';
      }
    | {
        ok: false;
        error: string;
        timed_out: boolean;
        delivery_state: 'not_sent' | 'sent_unconfirmed';
        diagnostics: {
          page_origin: string;
          page_url: string;
          target_url: string;
          target_origin: string | null;
          cross_origin: boolean;
          credentials_mode: string;
        };
      }
  > {
    // page.evaluate runs the closure inside the page context so cookies, sec-*
    // headers, and JS-set origin are applied by the browser. This is the only
    // place in the runtime that reaches for `page.evaluate` — all other callers
    // go through this abstract method.
    return await this._page(session).evaluate(
      async ({
        url,
        method,
        headers,
        body,
        credentials,
        timeoutMs,
      }: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: string | undefined;
        credentials: 'include' | 'omit' | 'same-origin';
        timeoutMs: number;
      }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, timeoutMs);
        let deliveryState: 'not_sent' | 'sent_unconfirmed' = 'not_sent';
        try {
          const pendingResponse = fetch(url, {
            method,
            headers,
            body: body ?? null,
            credentials,
            signal: controller.signal,
          });
          deliveryState = 'sent_unconfirmed';
          const res = await pendingResponse;
          const text = await res.text();
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* not JSON — keep as text */
          }
          return {
            ok: true as const,
            status: res.status,
            body: parsed,
            finalUrl: res.url,
            delivery_state: 'response_received' as const,
          };
        } catch (err) {
          // "Failed to fetch" is the browser's generic rejection for network
          // error / CORS violation / aborted request. Surface the page origin +
          // target origin so callers can diagnose cross-origin credentials-mode
          // mismatches (the common cause when a same-origin flow unexpectedly
          // lands cross-origin because the page navigated to about:blank
          // mid-flight).
          const errName = err instanceof Error ? err.name : typeof err;
          const errMsg = err instanceof Error ? err.message : String(err);
          let targetOrigin: string | null = null;
          try {
            targetOrigin = new URL(url).origin;
          } catch {
            /* malformed URL */
          }
          // `window` is in-page DOM; cast through unknown so TS's Node lib
          // doesn't flag it as missing.
          const w = (
            globalThis as unknown as { window: { location: { origin: string; href: string } } }
          ).window;
          return {
            ok: false as const,
            error: `${errName}: ${errMsg}`,
            timed_out: controller.signal.aborted,
            delivery_state: deliveryState,
            diagnostics: {
              page_origin: w.location.origin,
              page_url: w.location.href,
              target_url: url,
              target_origin: targetOrigin,
              cross_origin: targetOrigin !== null && targetOrigin !== w.location.origin,
              credentials_mode: credentials,
            },
          };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        url,
        method: options.method,
        headers: options.headers,
        body: options.body,
        credentials: options.credentials ?? 'include',
        timeoutMs: options.timeout_ms ?? 30_000,
      },
    );
  }

  async getPageHtml(session: Session, opts?: PageOpts): Promise<string> {
    return await withPageOpTimeout(this._page(session, opts?.page).content(), 'get_page_html');
  }

  async evaluateExpression(
    session: Session,
    expression: string,
    options: {
      timeoutMs: number;
      args?: Record<string, unknown>;
      frame?: string;
    } & PageOpts,
  ): Promise<unknown> {
    // Two wrap shapes: block-body when the expression is a statement sequence
    // (top-level `return`, `const`/`let`/`var`/`function`/`class` declaration,
    // or `try`/`if`/`for`/`while`/`do`/`switch`/`throw` statement),
    // expression-body otherwise (the agent wrote a value expression — ternary,
    // IIFE, await-chain). Nested statements inside a legal IIFE or arrow body
    // are depth>0 and stay on the expression-body path. See
    // `needsBlockBodyWrap` in response/js-eval-wrapper.ts.
    const useBlockBody = needsBlockBodyWrap(expression);
    // The closure runs inside the page (or frame) context so cookies, sec-*
    // headers, and JS-set origin are applied by the browser. The closure reads
    // the expression string we pass in, wraps it in an async runner via `new
    // Function(...)` with `args` as the formal parameter so the agent's
    // expression can read the per-call payload, and awaits the result.
    const target = await this._evaluateTarget(session, options);
    const evalPromise = target.evaluate(
      async ({
        expr,
        blockBody,
        args,
      }: {
        expr: string;
        blockBody: boolean;
        args: Record<string, unknown> | undefined;
      }) => {
        const globalAny = globalThis as unknown as {
          Function: new (...args: string[]) => (...fnArgs: unknown[]) => unknown;
        };
        const body = blockBody
          ? `return (async () => { ${expr} })();`
          : `return (async () => (${expr}))();`;
        const runner = new globalAny.Function('args', body);
        return await (runner(args) as Promise<unknown>);
      },
      { expr: expression, blockBody: useBlockBody, args: options.args },
    );
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => {
          reject(
            new Error(
              `evaluateExpression: timed out after ${options.timeoutMs}ms while running ` +
                `expression ${JSON.stringify(expression.length > 80 ? expression.slice(0, 77) + '…' : expression)}`,
            ),
          );
        },
        Math.max(1, options.timeoutMs),
      );
      (timeoutHandle as unknown as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([evalPromise, timeoutPromise]);
    } finally {
      // Clear the timer when the race settles. A live timer roots the pending
      // timeout promise and, through the race's reaction chain, pins the
      // resolved result until the timer fires — a burst of large-payload evals
      // inside one timeout window would otherwise hold every result at once.
      clearTimeout(timeoutHandle);
    }
  }

  // Resolve the JS evaluation target for `evaluateExpression`. With no `frame`
  // option the main page is the target (default behavior — same as a direct
  // `page.evaluate`). With `frame: <css-selector>` we locate the matching
  // `<iframe>` element on the page, wait briefly for it to attach, and resolve
  // its `contentFrame()`. Cross-origin frames are reachable via Playwright's
  // OOPIF support — the returned `Frame` exposes `.evaluate` regardless of
  // origin policy. Throws a caller-readable error when the selector resolves
  // to a non-iframe element or when contentFrame is unreachable (sandboxed
  // iframe with no scriptable document).
  protected async _evaluateTarget(
    session: Session,
    options: { frame?: string; timeoutMs: number } & PageOpts,
  ): Promise<Page | import('playwright').Frame> {
    const page = this._page(session, options.page);
    if (!options.frame) return page;
    // Cap the locator wait at the caller's evaluate budget — a 30s default
    // applies otherwise and dwarfs the eval timeout. Floor at 250ms so a tight
    // budget still gives the iframe a beat to attach after navigation.
    const waitMs = Math.max(250, Math.min(options.timeoutMs, 5000));
    const handle = await page
      .locator(options.frame)
      .first()
      .elementHandle({ timeout: waitMs })
      .catch(() => null);
    if (!handle) {
      throw new Error(
        `evaluateExpression: frame selector ${JSON.stringify(options.frame)} did not resolve ` +
          `to an element on the page within ${waitMs}ms. The iframe may not have attached yet, ` +
          `the selector may be wrong, or the iframe lives inside another iframe (chained ` +
          `frame selectors are not supported — point the selector at the outermost iframe ` +
          `that holds the script you want to call).`,
      );
    }
    const frame = await handle.contentFrame();
    if (!frame) {
      throw new Error(
        `evaluateExpression: frame selector ${JSON.stringify(options.frame)} resolved to an ` +
          `element but its contentFrame is null. Either the element is not an <iframe>, or ` +
          `the iframe is sandboxed without scripting permission and the runtime cannot ` +
          `evaluate inside it.`,
      );
    }
    return frame;
  }

  async installInitScript(session: Session, expression: string): Promise<{ handle: string }> {
    const context = sessionContexts.get(session);
    if (!context) {
      throw new Error('installInitScript: session has no browser context');
    }
    // Stable per-install handle. The wrapper closes over this handle and the
    // session id; the runtime keeps a removed-handles set per session that the
    // wrapper consults on every navigation.
    const handle = `init-${crypto.randomBytes(6).toString('hex')}`;
    // The runtime exposes `__klura_init_removed` as a WeakSet-equivalent on
    // the page via a small helper that lives only on `globalThis`. The wrapper
    // checks the current handle against the set before running the agent's
    // expression. If the handle was added to the set via `removeInitScript`,
    // the wrapper short-circuits.
    const useBlockBody = needsBlockBodyWrap(expression);
    const wrappedSource = useBlockBody
      ? `(async () => { ${expression} })();`
      : `(async () => (${expression}))();`;
    const installSource = [
      `(() => {`,
      `  const __h = ${JSON.stringify(handle)};`,
      `  const g = globalThis;`,
      `  if (!g.__klura_init_removed) g.__klura_init_removed = new Set();`,
      `  if (g.__klura_init_removed.has(__h)) return;`,
      `  try { ${wrappedSource} } catch (e) { /* init scripts must not throw onto page bootstrap */ }`,
      `})();`,
    ].join('\n');
    // Sanctioned bypass of the init-script registry: this is the agent-
    // supplied `installInitScript` API, where the script is dynamic per call
    // and removable per session. The registry is for driver-baked-in scripts
    // installed at session creation; that's a different lifecycle.
    // eslint-disable-next-line no-restricted-syntax
    await context.addInitScript({ content: installSource });
    // Also fire on the current document; addInitScript only covers future
    // navigations, so without this the agent has to manually navigate to see
    // the script run for the first time.
    try {
      await this._page(session).evaluate(installSource);
    } catch {
      /* fire-on-current is best-effort; navigations will pick it up */
    }
    return { handle };
  }

  async removeInitScript(session: Session, handle: string): Promise<void> {
    let removed = sessionRemovedInitScripts.get(session);
    if (!removed) {
      removed = new Set();
      sessionRemovedInitScripts.set(session, removed);
    }
    removed.add(handle);
    // Best-effort: poke the current document so an already-installed wrapper
    // also notices via the in-page `__klura_init_removed` set.
    try {
      await this._page(session).evaluate((h: string) => {
        const g = globalThis as unknown as { __klura_init_removed?: Set<string> };
        if (!g.__klura_init_removed) g.__klura_init_removed = new Set();
        g.__klura_init_removed.add(h);
      }, handle);
    } catch {
      /* no-op when the page is not navigable */
    }
  }

  htmlToAriaLikeTree(_session: Session, html: string): Promise<string> {
    // See the long rationale comment in drivers/interface.ts — this is
    // deliberately NOT Playwright's real ariaSnapshot, to avoid running scripts
    // from the fetched HTML and to avoid clobbering the session's current page
    // via setContent. Cheerio is inert: no script execution, no network, no DOM
    // mutation.
    const $ = cheerio.load(html);

    // Tag → role table. Matches trimA11yTree's landmark sets so Pass D
    // recognizes banner/navigation/main/form/dialog/contentinfo/etc. Everything
    // not in the table is "generic" and flattened into its children so the tree
    // doesn't fill with div/span wrapper soup.
    const roleOf: Record<string, string> = {
      HEADER: 'banner',
      NAV: 'navigation',
      MAIN: 'main',
      FOOTER: 'contentinfo',
      ASIDE: 'complementary',
      FORM: 'form',
      DIALOG: 'dialog',
      SECTION: 'region',
      ARTICLE: 'article',
      A: 'link',
      BUTTON: 'button',
      TEXTAREA: 'textbox',
      SELECT: 'combobox',
      UL: 'list',
      OL: 'list',
      LI: 'listitem',
      TABLE: 'table',
      TR: 'row',
      TD: 'cell',
      TH: 'columnheader',
      IMG: 'img',
      P: 'paragraph',
      LABEL: 'label',
      FIGURE: 'figure',
      FIGCAPTION: 'figcaption',
      BLOCKQUOTE: 'blockquote',
      CODE: 'code',
      PRE: 'pre',
    };
    const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'META', 'LINK', 'BASE']);
    const TEXT_ONLY_ROLES = new Set(['link', 'button', 'paragraph', 'label', 'heading', 'code']);

    const MAX_NAME_CHARS = 120;
    const clipName = (s: string): string => {
      const oneLine = s.replace(/\s+/g, ' ').trim();
      return oneLine.length > MAX_NAME_CHARS ? oneLine.slice(0, MAX_NAME_CHARS - 1) + '…' : oneLine;
    };

    // cheerio's AnyNode typings flow through our `unknown`-typed walker via
    // `$(el as any)`. The walker is inert on types (it just reads attrs / text)
    // but strict lint objects to the any-cast. Disable the rule locally; none
    // of the other unsafe-* rules are relevant here (the cheerio calls return
    // strings we bound ourselves).
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const getRole = (tag: string, el: unknown): string | null => {
      if (tag === 'H1') return 'heading [level=1]';
      if (tag === 'H2') return 'heading [level=2]';
      if (tag === 'H3') return 'heading [level=3]';
      if (tag === 'H4') return 'heading [level=4]';
      if (tag === 'H5') return 'heading [level=5]';
      if (tag === 'H6') return 'heading [level=6]';
      if (tag === 'INPUT') {
        const t = ($(el as any).attr('type') || 'text').toLowerCase();
        if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'hidden') return null;
        return 'textbox';
      }
      if (tag === 'TH') {
        const scope = $(el as any).attr('scope');
        return scope === 'row' ? 'rowheader' : 'columnheader';
      }
      return roleOf[tag] ?? null;
    };

    const getDirectText = (el: unknown): string => {
      let s = '';
      const node = el as { childNodes?: Array<{ type: string; data?: string }> };
      if (node.childNodes) {
        for (const child of node.childNodes) {
          if (child.type === 'text') {
            s += child.data ?? '';
          }
        }
      }
      return clipName(s);
    };

    const lines: string[] = [];

    const walk = (el: unknown, depth: number): void => {
      const node = el as { name?: string; childNodes?: Array<{ type: string; name?: string }> };
      const tag = (node.name || '').toUpperCase();
      if (SKIP.has(tag)) return;

      const role = getRole(tag, el);
      const indent = '  '.repeat(depth);

      if (role === null) {
        // Generic — flatten (recurse into children at the same depth).
        const children = node.childNodes || [];
        for (const child of children) {
          if (child.type === 'tag') {
            walk(child, depth);
          }
        }
        return;
      }

      // Choose accessible name. For text-bearing roles, use full text. For
      // everything else, prefer direct text.
      let name: string;
      if (TEXT_ONLY_ROLES.has(role.split(' ')[0] ?? '')) {
        name = clipName($(el as any).text());
      } else if (tag === 'IMG') {
        name = clipName($(el as any).attr('alt') ?? '');
      } else {
        name = getDirectText(el);
      }

      // Collect element children.
      const elementChildren: unknown[] = [];
      const children = node.childNodes || [];
      for (const child of children) {
        if (child.type === 'tag' && !SKIP.has((child.name || '').toUpperCase())) {
          elementChildren.push(child);
        }
      }

      const textOnly = TEXT_ONLY_ROLES.has(role.split(' ')[0] ?? '');
      let line = `${indent}- ${role}`;
      if (name.length > 0) line += ` "${name}"`;
      const willHaveChildren = !textOnly && elementChildren.length > 0;
      const hasAttrChildren = tag === 'A' || tag === 'FORM';
      if (willHaveChildren || hasAttrChildren) line += ':';
      lines.push(line);

      // Attribute children.
      if (tag === 'A') {
        const href = $(el as any).attr('href');
        if (href) lines.push(`${indent}  - /url: ${clipName(href)}`);
      } else if (tag === 'FORM') {
        const action = $(el as any).attr('action');
        if (action) lines.push(`${indent}  - /action: ${clipName(action)}`);
      }

      if (!textOnly) {
        for (const child of elementChildren) {
          walk(child, depth + 1);
        }
      }
    };

    const root = $('body').length ? $('body').get(0) : $.root().get(0);
    if (root && (root as { type?: string }).type === 'tag') {
      walk(root, 0);
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    return Promise.resolve(lines.join('\n'));
  }

  async getAccessibilityTree(session: Session, opts?: PageOpts): Promise<string> {
    const page = this._page(session, opts?.page);
    try {
      const tree = await withPageOpTimeout(
        page.locator(':root').ariaSnapshot(),
        'get_accessibility_tree:native_snapshot',
        A11Y_SNAPSHOT_TIMEOUT_MS,
      );
      session.accessibilitySnapshot = {
        source: 'native',
        at: Date.now(),
      };
      return tree;
    } catch (nativeError) {
      try {
        const html = await this.getPageHtml(session, opts);
        const tree = await this.htmlToAriaLikeTree(session, html);
        const nativeMessage =
          nativeError instanceof Error ? nativeError.message : String(nativeError);
        session.accessibilitySnapshot = {
          source: 'static_dom',
          at: Date.now(),
          warning:
            `The native accessibility snapshot failed; klura returned an inert serialized-DOM ` +
            `fallback instead. Computed ARIA relationships and hidden-element filtering may be ` +
            `absent. Native failure: ${nativeMessage}`,
        };
        return tree;
      } catch (fallbackError) {
        const nativeMessage =
          nativeError instanceof Error ? nativeError.message : String(nativeError);
        const fallbackMessage =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        const warning =
          `The native accessibility snapshot and inert serialized-DOM fallback both failed. ` +
          `The browser session is still live and may be inspected with get_screenshot, ` +
          `find_in_page, or js_eval. Native failure: ${nativeMessage}. ` +
          `Fallback failure: ${fallbackMessage}`;
        session.accessibilitySnapshot = {
          source: 'unavailable',
          at: Date.now(),
          warning,
        };
        throw new Error(`get_accessibility_tree: ${warning}`, { cause: fallbackError });
      }
    }
  }

  async screenshot(session: Session, opts?: PageOpts): Promise<string> {
    const buffer = await this._page(session, opts?.page).screenshot({ type: 'png' });
    return buffer.toString('base64');
  }

  async screenshotJpeg(session: Session, quality = 60, opts?: PageOpts): Promise<Buffer> {
    const handle = opts?.page ?? MAIN_PAGE;
    const extras = getExtras(session);
    // The compositor screencast is bound to the main page (one CDP session per
    // session, attached at first request). For sub-pages we always serve a
    // direct screenshot — sub-page traffic is light, and avoiding a second
    // CDP screencast keeps memory bounded as popups come and go.
    if (handle !== MAIN_PAGE) {
      return this._page(session, handle).screenshot({ type: 'jpeg', quality });
    }
    // Screencast starts lazily on the first frame request so sessions that
    // never attach a viewer don't pay the compositor cost.
    if (!extras.screencastStarted) {
      await this._startScreencast(session, quality);
    }
    if (extras.lastScreencastFrame) return extras.lastScreencastFrame;
    // No frame has arrived yet — serve one synchronous screenshot so the caller
    // isn't blocked on the compositor's first invalidation.
    return this._page(session).screenshot({ type: 'jpeg', quality });
  }

  private async _startScreencast(session: Session, quality: number): Promise<void> {
    const extras = getExtras(session);
    if (extras.screencastStarted) return;
    extras.screencastStarted = true;
    try {
      const page = this._page(session);
      const context = this._context(session);
      const cdp = await context.newCDPSession(page);
      extras.screencastCdp = cdp;
      cdp.on('Page.screencastFrame', (params: { data: string; sessionId: number }) => {
        extras.lastScreencastFrame = Buffer.from(params.data, 'base64');
        // Each frame must be acked or chromium stalls the stream after its
        // internal buffer fills.
        cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {
          /* page may be gone */
        });
      });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality,
        everyNthFrame: 1,
      });
    } catch {
      // Screencast failed to start — reset the flag so a later call retries,
      // and screenshotJpeg falls through to a direct page.screenshot.
      extras.screencastStarted = false;
    }
  }

  async mouseClick(session: Session, x: number, y: number, opts?: PageOpts): Promise<void> {
    await withPageOpTimeout(this._page(session, opts?.page).mouse.click(x, y), 'mouse_click');
  }

  async mouseMove(
    session: Session,
    x: number,
    y: number,
    steps?: number,
    opts?: PageOpts,
  ): Promise<void> {
    await withPageOpTimeout(
      this._page(session, opts?.page).mouse.move(x, y, steps ? { steps } : undefined),
      'mouse_move',
    );
  }

  async mouseDown(session: Session, x: number, y: number, opts?: PageOpts): Promise<void> {
    const page = this._page(session, opts?.page);
    await withPageOpTimeout(page.mouse.move(x, y), 'mouse_down:move');
    await withPageOpTimeout(page.mouse.down(), 'mouse_down:press');
  }

  async mouseUp(session: Session, x: number, y: number, opts?: PageOpts): Promise<void> {
    const page = this._page(session, opts?.page);
    await withPageOpTimeout(page.mouse.move(x, y), 'mouse_up:move');
    await withPageOpTimeout(page.mouse.up(), 'mouse_up:release');
  }

  async mouseDrag(
    session: Session,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    opts?: PageOpts,
  ): Promise<void> {
    const page = this._page(session, opts?.page);
    await withPageOpTimeout(page.mouse.move(fromX, fromY), 'mouse_drag:from');
    await withPageOpTimeout(page.mouse.down(), 'mouse_drag:press');
    await withPageOpTimeout(page.mouse.move(toX, toY, { steps: 10 }), 'mouse_drag:to');
    await withPageOpTimeout(page.mouse.up(), 'mouse_drag:release');
  }

  async keyPress(session: Session, key: string, opts?: PageOpts): Promise<void> {
    await withPageOpTimeout(this._page(session, opts?.page).keyboard.press(key), 'key_press');
  }

  async typeText(session: Session, text: string, opts?: PageOpts): Promise<void> {
    if (!text) return;
    // page.keyboard.type fires keydown/keypress/input/keyup for each character
    // — same path a real keyboard takes, not fill().
    await withPageOpTimeout(this._page(session, opts?.page).keyboard.type(text), 'type');
  }

  async touchStart(session: Session, x: number, y: number): Promise<void> {
    const client = await this._cdp(session);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
  }

  async touchMove(session: Session, x: number, y: number): Promise<void> {
    const client = await this._cdp(session);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y }],
    });
  }

  async touchEnd(session: Session, _x: number, _y: number): Promise<void> {
    const client = await this._cdp(session);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  }

  async touchTap(session: Session, x: number, y: number): Promise<void> {
    // Playwright's high-level touchscreen.tap is simpler than CDP for the
    // discrete case and handles viewport translation correctly.
    await this._page(session).touchscreen.tap(x, y);
  }

  async onFocusChange(
    session: Session,
    listener: FocusListener,
    _opts?: PageOpts,
  ): Promise<() => void> {
    const extras = getExtras(session);
    extras.focusListeners.add(listener);

    if (!extras.focusInstalled) {
      extras.focusInstalled = true;
      const context = this._context(session);

      // exposeBinding is context-wide and survives navigations. Bind first so
      // the tracker script (which calls the binding) has a target.
      await context.exposeBinding('__kluraFocusChange', (_src, state: FocusState | null) => {
        const snapshot = Array.from(extras.focusListeners);
        for (const l of snapshot) {
          try {
            l(state);
          } catch {
            /* listener failures shouldn't kill the binding */
          }
        }
      });

      // Install the focus-tracker lazily — only once a viewer actually
      // subscribes — so an agent-only session (e.g. a bot-challenge page)
      // carries no focus artifact at all. addInitScript covers future
      // navigations; evaluate once for the current document.
      // eslint-disable-next-line no-restricted-syntax
      await context.addInitScript({ content: FOCUS_TRACKER_SCRIPT });
      try {
        await this._page(session).evaluate(FOCUS_TRACKER_SCRIPT);
      } catch {
        /* current-document install is best-effort */
      }
    }

    return () => {
      extras.focusListeners.delete(listener);
    };
  }

  async scroll(
    session: Session,
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    opts?: PageOpts,
  ): Promise<void> {
    // Two callers pass coordinates through to us: the mouse-coordinate scroll
    // path (agent targets a specific on-page position) and the page-level
    // scroll path (agent targets the document and passes no valid coordinate,
    // e.g. selector: "document" which split-parses to NaN). Chromium's
    // Input.dispatchMouseEvent rejects NaN parameters with "Invalid
    // parameters", so we detect non-finite coordinates and fall back to
    // window.scrollBy via page.evaluate — that's the equivalent of what a
    // user's trackpad would do when scrolling the viewport without pointing at
    // a specific element.
    const page = this._page(session, opts?.page);
    const dx = Number.isFinite(deltaX) ? deltaX : 0;
    const dy = Number.isFinite(deltaY) ? deltaY : 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      await withPageOpTimeout(
        page.evaluate(
          (arg: { dx: number; dy: number }) => {
            (globalThis as unknown as { scrollBy: (x: number, y: number) => void }).scrollBy(
              arg.dx,
              arg.dy,
            );
          },
          { dx, dy },
        ),
        'scroll:page',
      );
      return;
    }
    await withPageOpTimeout(page.mouse.move(x, y), 'scroll:move');
    await withPageOpTimeout(page.mouse.wheel(dx, dy), 'scroll:wheel');
  }

  viewportSize(session: Session): { width: number; height: number } {
    return this._page(session).viewportSize() ?? { width: 1280, height: 720 };
  }

  async setViewport(session: Session, width: number, height: number): Promise<void> {
    // Playwright's setViewportSize is fast (~10ms) and the page reflows in
    // place — no navigation, no state loss. Used by the viewer to keep the
    // headless browser's viewport in sync with the user's client canvas size.
    if (width <= 0 || height <= 0) return;
    await this._page(session).setViewportSize({ width, height });
  }

  async startIntercepting(session: Session): Promise<void> {
    await this._attachNetworkCapture(session);
  }

  getInterceptedRequests(session: Session): Promise<InterceptedRequest[]> {
    return Promise.resolve(getInterceptedFromSink(session));
  }

  override async getLoadedScripts(session: Session): Promise<LoadedScript[]> {
    if (!session.intercepting) return await super.getLoadedScripts(session);
    const scripts = getExtras(session).loadedScripts ?? [];
    return scripts.map((script) => ({ ...script }));
  }

  streamWebSocketFrames(
    session: Session,
    onFrame: (frame: WebSocketFrame) => void,
  ): Promise<WebSocketFrameStream> {
    const page = this._page(session);

    // The `closed` deferred fires when the caller disposes, the page closes, or
    // any other terminal event happens. The single `close` helper makes sure
    // resolve is idempotent.
    let closeResolve: ((info: { reason: string }) => void) | null = null;
    const closed = new Promise<{ reason: string }>((resolve) => {
      closeResolve = resolve;
    });
    let settled = false;
    const close = (reason: string): void => {
      if (settled) return;
      settled = true;
      closeResolve?.({ reason });
    };

    // Playwright fires `websocket` once per ws.open() in page JS. We attach
    // frame handlers inside the listener so they apply to every WS the page
    // opens during the listener's lifetime.
    const wsListener = (ws: PlaywrightWebSocket): void => {
      const url = ws.url();
      ws.on('framereceived', (data: { payload: string | Buffer }) => {
        try {
          onFrame({
            url,
            direction: 'received',
            payload: data.payload.toString(),
            timestamp: Date.now(),
          });
        } catch {
          // Callback errors are the caller's problem, not ours.
        }
      });
      ws.on('framesent', (data: { payload: string | Buffer }) => {
        try {
          onFrame({
            url,
            direction: 'sent',
            payload: data.payload.toString(),
            timestamp: Date.now(),
          });
        } catch {
          // same
        }
      });
    };
    page.on('websocket', wsListener);

    // Page-level close fires when the underlying tab dies (navigation away,
    // crash, container destroyed). Surface it so the listener can reconnect.
    const pageCloseHandler = (): void => {
      close('page_closed');
    };
    page.on('close', pageCloseHandler);

    return Promise.resolve({
      dispose: () => {
        try {
          page.off('websocket', wsListener);
        } catch {
          // page already gone
        }
        try {
          page.off('close', pageCloseHandler);
        } catch {
          // page already gone
        }
        close('disposed');
        return Promise.resolve();
      },
      closed,
    });
  }

  async saveStorageState(session: Session, path: string): Promise<void> {
    // The state is fetched as a value and persisted under the same
    // `<file>.lock` every other writer of this file takes (fetch-tier
    // Set-Cookie merges, whole-file jar saves), so a concurrent
    // read-modify-write can neither read a torn write of this snapshot nor
    // rename a stale jar over it.
    const state = await this._context(session).storageState();
    writeTextUnderFileLock(path, JSON.stringify(state, null, 2));
  }

  // ---------------------------------------------------------------------
  // Debugger surface (CDP Debugger domain). Lazily initialized on the first
  // set_breakpoint call; torn down by cleanupDebuggerState.
  // ---------------------------------------------------------------------

  private async _enableDebugger(session: Session): Promise<DebuggerState> {
    const extras = getExtras(session);
    if (extras.debuggerState?.enabled) return extras.debuggerState;
    const existing = extras.debuggerState;
    const cdp = existing?.cdp ?? (await this._context(session).newCDPSession(this._page(session)));
    const state: DebuggerState = existing ?? {
      cdp,
      enabled: false,
      scriptUrls: new Map(),
      breakpoints: new Map(),
      paused: null,
      pauseQueue: [],
      pending: null,
      // Placeholders overwritten below — TS requires initial values.
      onPaused: () => {},
      onScriptParsed: () => {},
    };

    state.onScriptParsed = (ev: { scriptId: string; url: string }) => {
      if (ev.url) state.scriptUrls.set(ev.scriptId, ev.url);
    };
    state.onPaused = (ev: CdpPausedEvent) => {
      // Armed WebSocket send-capture: this pause is our function-call breakpoint
      // on native WebSocket.prototype.send. Capture the encoder callstack (the
      // frames below the native send frame), auto-resume, and never let it reach
      // the agent's wait_for_pause queue.
      if (state.sendBreakpointId && ev.hitBreakpoints?.includes(state.sendBreakpointId)) {
        try {
          const rawStack = ev.callFrames
            .slice(1)
            .map(
              (f) =>
                `    at ${f.functionName || '<anonymous>'} (${f.url || '<anonymous>'}:` +
                `${f.location.lineNumber + 1}:${(f.location.columnNumber ?? 0) + 1})`,
            )
            .join('\n');
          const capExtras = getExtras(session);
          if (!capExtras.sendCaptures) capExtras.sendCaptures = [];
          capExtras.sendCaptures.push({ raw_stack: rawStack });
          while (capExtras.sendCaptures.length > 200) capExtras.sendCaptures.shift();
        } catch {
          /* capture is best-effort */
        }
        void state.cdp.send('Debugger.resume').catch(() => {});
        return;
      }
      state.paused = ev;
      if (state.pending) {
        const p = state.pending;
        state.pending = null;
        clearTimeout(p.timer);
        p.resolve(ev);
        return;
      }
      state.pauseQueue.push(ev);
      while (state.pauseQueue.length > DEBUGGER_PAUSE_QUEUE_CAP) state.pauseQueue.shift();
    };

    cdp.on('Debugger.scriptParsed', state.onScriptParsed as unknown as (p: object) => void);
    cdp.on('Debugger.paused', state.onPaused as unknown as (p: object) => void);
    await cdp.send('Debugger.enable');
    state.enabled = true;
    extras.debuggerState = state;
    return state;
  }

  /**
   * Arm out-of-band WebSocket send-callstack capture: a Debugger function-call
   * breakpoint on native `WebSocket.prototype.send`. Reentrant (refcounted) so
   * overlapping callers (trigger_reference_send + an active get_send_encoder)
   * compose. While armed, each send pauses momentarily on the shared debugger
   * session; the onPaused handler captures the encoder callstack and auto-
   * resumes. No page tampering — the page's `send` stays native. Best-effort:
   * failures leave capture disarmed rather than throw.
   */
  override async armSendCapture(session: Session): Promise<void> {
    const extras = getExtras(session);
    const next = (extras.sendCaptureRefCount ?? 0) + 1;
    extras.sendCaptureRefCount = next;
    if (next > 1) return; // already armed
    try {
      const state = await this._enableDebugger(session);
      const fn = (await state.cdp.send('Runtime.evaluate', {
        expression: 'WebSocket.prototype.send',
      })) as { result?: { objectId?: string } };
      const objectId = fn.result?.objectId;
      if (!objectId) throw new Error('could not resolve WebSocket.prototype.send');
      const bp = (await state.cdp.send('Debugger.setBreakpointOnFunctionCall', {
        objectId,
      })) as { breakpointId?: string };
      state.sendBreakpointId = bp.breakpointId ?? null;
    } catch {
      extras.sendCaptureRefCount = 0; // arming failed — treat as disarmed
    }
  }

  /** Disarm send-capture. Removes the breakpoint and clears the ring once the
   *  last caller releases. Best-effort; safe to call when not armed. */
  override async disarmSendCapture(session: Session): Promise<void> {
    const extras = getExtras(session);
    const next = Math.max(0, (extras.sendCaptureRefCount ?? 0) - 1);
    extras.sendCaptureRefCount = next;
    if (next > 0) return;
    const state = extras.debuggerState;
    if (state?.sendBreakpointId) {
      try {
        await state.cdp.send('Debugger.removeBreakpoint', {
          breakpointId: state.sendBreakpointId,
        });
      } catch {
        /* breakpoint may already be gone */
      }
      state.sendBreakpointId = null;
    }
    extras.sendCaptures = [];
  }

  async setBreakpoint(
    session: Session,
    params: { file: string; line: number; column?: number; condition?: string },
  ): Promise<{
    breakpoint_id: string;
    resolved_location?: { file: string; line: number; column?: number };
  }> {
    const state = await this._enableDebugger(session);
    if (state.breakpoints.size >= DEBUGGER_MAX_BREAKPOINTS) {
      throw new Error(
        `set_breakpoint: max ${DEBUGGER_MAX_BREAKPOINTS} active breakpoints per session; remove one first`,
      );
    }
    const result = (await state.cdp.send('Debugger.setBreakpointByUrl', {
      lineNumber: params.line,
      url: params.file,
      columnNumber: params.column,
      condition: params.condition,
    })) as {
      breakpointId: string;
      locations?: Array<{ scriptId: string; lineNumber: number; columnNumber?: number }>;
    };
    state.breakpoints.set(result.breakpointId, {
      file: params.file,
      line: params.line,
      column: params.column,
      condition: params.condition,
    });
    const first = result.locations?.[0];
    const resolved_location = first
      ? {
          file: state.scriptUrls.get(first.scriptId) ?? params.file,
          line: first.lineNumber,
          column: first.columnNumber,
        }
      : undefined;
    return { breakpoint_id: result.breakpointId, resolved_location };
  }

  async removeBreakpoint(session: Session, breakpointId: string): Promise<void> {
    const extras = getExtras(session);
    const state = extras.debuggerState;
    if (!state?.enabled) return;
    if (!state.breakpoints.has(breakpointId)) return;
    try {
      await state.cdp.send('Debugger.removeBreakpoint', { breakpointId });
    } catch {
      // Already gone on CDP side — drop from our map silently.
    }
    state.breakpoints.delete(breakpointId);
  }

  listBreakpoints(session: Session): Promise<
    Array<{
      breakpoint_id: string;
      location: { file: string; line: number; column?: number };
      condition?: string;
    }>
  > {
    const state = getExtras(session).debuggerState;
    if (!state) return Promise.resolve([]);
    return Promise.resolve(
      Array.from(state.breakpoints.entries()).map(([id, bp]) => ({
        breakpoint_id: id,
        location: { file: bp.file, line: bp.line, column: bp.column },
        condition: bp.condition,
      })),
    );
  }

  async waitForPause(
    session: Session,
    opts: { timeoutMs: number },
  ): Promise<import('./types/debugger').DebuggerPause> {
    const state = getExtras(session).debuggerState;
    if (!state?.enabled) {
      return {
        hit: false,
        reason: 'timeout',
        call_frames: [],
      };
    }
    if (state.pending) {
      throw new Error(
        'wait_for_pause: already_waiting — another call is outstanding on this session',
      );
    }
    let ev: CdpPausedEvent | undefined = state.pauseQueue.shift();
    if (!ev) {
      ev = await new Promise<CdpPausedEvent>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            state.pending = null;
            resolve({ reason: 'timeout', callFrames: [] });
          },
          Math.max(1, opts.timeoutMs),
        );
        (timer as unknown as { unref?: () => void }).unref?.();
        state.pending = { resolve, reject, timer };
      });
    }
    if (ev.reason === 'timeout' && ev.callFrames.length === 0) {
      return { hit: false, reason: 'timeout', call_frames: [] };
    }
    state.paused = ev;
    return {
      hit: true,
      reason: normalizePauseReason(ev.reason),
      breakpoint_ids: ev.breakpointIds ?? [],
      call_frames: this._shapeCallFrames(state, ev.callFrames),
    };
  }

  private _shapeCallFrames(
    state: DebuggerState,
    frames: CdpCallFrame[],
  ): import('./types/debugger').DebuggerCallFrame[] {
    return frames.map((f, i) => ({
      frame_index: i,
      location: {
        file: f.url ?? state.scriptUrls.get(f.location.scriptId) ?? '',
        line: f.location.lineNumber,
        column: f.location.columnNumber,
      },
      function_name: f.functionName || '(anonymous)',
      function_source_preview: previewSource(f),
      scope_chain: (f.scopeChain ?? []).map((s) => ({
        type: s.type,
        object_preview: s.object.description ?? s.object.className ?? s.object.type ?? '',
      })),
    }));
  }

  async getFrameScope(
    session: Session,
    params: { frameIndex: number; scopeType?: string; scopeIndex?: number },
  ): Promise<{
    properties: Array<{ name: string; type: string; preview: string; has_children: boolean }>;
    truncated?: boolean;
  }> {
    const state = getExtras(session).debuggerState;
    if (!state?.paused) throw new Error('get_frame_scope: not paused');
    const frame = state.paused.callFrames[params.frameIndex];
    if (!frame) throw new Error(`get_frame_scope: no frame at index ${params.frameIndex}`);
    const scopes = frame.scopeChain ?? [];
    let scope = params.scopeIndex !== undefined ? scopes[params.scopeIndex] : undefined;
    if (!scope && params.scopeType) {
      scope = scopes.find((s) => s.type === params.scopeType);
    }
    if (!scope) scope = scopes[0];
    if (!scope) throw new Error('get_frame_scope: frame has no scope chain');
    const objectId = scope.object.objectId;
    if (!objectId) {
      return { properties: [] };
    }
    const GET_PROPERTIES_CAP = 200;
    const props = (await state.cdp.send('Runtime.getProperties', {
      objectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: true,
    })) as {
      result: Array<{
        name: string;
        value?: {
          type: string;
          className?: string;
          description?: string;
          value?: unknown;
          objectId?: string;
        };
      }>;
    };
    const truncated = props.result.length > GET_PROPERTIES_CAP;
    const properties = props.result.slice(0, GET_PROPERTIES_CAP).map((p) => {
      const v = p.value;
      const type = v?.type ?? 'undefined';
      let preview = 'undefined';
      if (v !== undefined) {
        preview = v.description ?? v.className ?? type;
        if (v.value !== undefined && v.description === undefined && v.className === undefined) {
          preview = safeStringify(v.value);
        }
      }
      return {
        name: p.name,
        type: v?.className ? `${type}(${v.className})` : type,
        preview: preview.length > 256 ? preview.slice(0, 253) + '...' : preview,
        has_children: Boolean(v?.objectId),
      };
    });
    return truncated ? { properties, truncated: true } : { properties };
  }

  async evaluateOnFrame(
    session: Session,
    params: { frameIndex: number; expression: string; timeoutMs: number },
  ): Promise<{ ok: boolean; result?: string; error?: string }> {
    const state = getExtras(session).debuggerState;
    if (!state?.paused) return { ok: false, error: 'not paused' };
    const frame = state.paused.callFrames[params.frameIndex];
    if (!frame) return { ok: false, error: `no frame at index ${params.frameIndex}` };
    // Paused execution is frozen, so unlike js_eval we don't need the async
    // IIFE wrap. Sync-wrap handles the block-body vs expression-body split.
    const useBlockBody = needsBlockBodyWrap(params.expression);
    const wrapped = useBlockBody ? `(() => { ${params.expression} })()` : `(${params.expression})`;

    const evalPromise = (async () => {
      const r = (await state.cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression: wrapped,
        returnByValue: false,
        generatePreview: true,
      })) as {
        result: {
          type: string;
          description?: string;
          value?: unknown;
          objectId?: string;
          className?: string;
        };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      };
      if (r.exceptionDetails) {
        return {
          ok: false as const,
          error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
        };
      }
      const v = r.result;
      let result: string;
      if (v.type === 'undefined') result = 'undefined';
      else if (v.value !== undefined) result = safeStringify(v.value);
      else result = v.description ?? v.className ?? v.type;
      return { ok: true as const, result };
    })();

    const timeoutPromise = new Promise<{ ok: false; error: string }>((resolve) => {
      const t = setTimeout(
        () => {
          resolve({ ok: false, error: `evaluate_on_frame: timed out after ${params.timeoutMs}ms` });
        },
        Math.max(1, params.timeoutMs),
      );
      (t as unknown as { unref?: () => void }).unref?.();
    });
    return await Promise.race([evalPromise, timeoutPromise]);
  }

  async evaluateInIframe(
    session: Session,
    params: {
      src: string;
      expression: string;
      waitForMs?: number;
      timeoutMs?: number;
      cleanup?: boolean;
    },
    opts?: PageOpts,
  ): Promise<unknown> {
    const page = this._page(session, opts?.page);
    const waitForMs = Math.max(0, Math.min(params.waitForMs ?? 1500, 30_000));
    const timeoutMs = Math.max(1000, Math.min(params.timeoutMs ?? 10_000, 60_000));
    const cleanup = params.cleanup !== false;
    const wrapped = wrapAgentExpression(params.expression);
    const evalPromise = page.evaluate(runIframeEvaluatePagefn, {
      src: params.src,
      wrapped,
      waitForMs,
      cleanup,
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`evaluate_in_iframe: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      (t as unknown as { unref?: () => void }).unref?.();
    });
    return await Promise.race([evalPromise, timeoutPromise]);
  }

  async evaluateInIframeChain(
    session: Session,
    params: {
      src: string;
      steps: ReadonlyArray<{ expression: string; waitForMs?: number }>;
      timeoutMs?: number;
      cleanup?: boolean;
      returnAll?: boolean;
    },
    opts?: PageOpts,
  ): Promise<unknown> {
    const page = this._page(session, opts?.page);
    const timeoutMs = Math.max(1000, Math.min(params.timeoutMs ?? 15_000, 90_000));
    const cleanup = params.cleanup !== false;
    const returnAll = params.returnAll === true;
    const wrappedSteps = params.steps.map((s) => ({
      wrapped: wrapAgentExpression(s.expression),
      waitForMs: Math.max(0, Math.min(s.waitForMs ?? 0, 30_000)),
    }));
    const evalPromise = page.evaluate(runIframeChainPagefn, {
      src: params.src,
      steps: wrappedSteps,
      cleanup,
      returnAll,
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`evaluate_in_iframe_chain: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      (t as unknown as { unref?: () => void }).unref?.();
    });
    return await Promise.race([evalPromise, timeoutPromise]);
  }

  async evaluateInWorker(
    session: Session,
    params: { source: string; message?: unknown; timeoutMs?: number },
    opts?: PageOpts,
  ): Promise<unknown> {
    const page = this._page(session, opts?.page);
    const timeoutMs = Math.max(1000, Math.min(params.timeoutMs ?? 10_000, 60_000));
    const evalPromise = page.evaluate(runWorkerPagefn, {
      source: params.source,
      message: params.message ?? null,
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`evaluate_in_worker: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      (t as unknown as { unref?: () => void }).unref?.();
    });
    return await Promise.race([evalPromise, timeoutPromise]);
  }

  async stepDebugger(
    session: Session,
    mode: 'over' | 'into' | 'out',
  ): Promise<{
    paused_at?: { file: string; line: number; column?: number; function_name?: string };
    done?: true;
  }> {
    const state = getExtras(session).debuggerState;
    if (!state?.paused) throw new Error('step: not paused');
    state.paused = null;
    let cmd: 'Debugger.stepOver' | 'Debugger.stepInto' | 'Debugger.stepOut';
    if (mode === 'over') {
      cmd = 'Debugger.stepOver';
    } else if (mode === 'into') {
      cmd = 'Debugger.stepInto';
    } else {
      cmd = 'Debugger.stepOut';
    }
    await state.cdp.send(cmd);
    // Wait briefly for the next pause; if execution runs to completion, return
    // done.
    const STEP_TIMEOUT_MS = 5000;
    const next = await new Promise<CdpPausedEvent | null>((resolve) => {
      const timer = setTimeout(() => {
        state.pending = null;
        resolve(null);
      }, STEP_TIMEOUT_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
      state.pending = {
        resolve: (ev) => {
          resolve(ev);
        },
        reject: () => {
          resolve(null);
        },
        timer,
      };
      // Drain any queued event that arrived between commands.
      const queued = state.pauseQueue.shift();
      if (queued) {
        clearTimeout(timer);
        state.pending = null;
        resolve(queued);
      }
    });
    if (!next) return { done: true };
    state.paused = next;
    const f0 = next.callFrames[0];
    if (!f0) return { done: true };
    return {
      paused_at: {
        file: f0.url ?? state.scriptUrls.get(f0.location.scriptId) ?? '',
        line: f0.location.lineNumber,
        column: f0.location.columnNumber,
        function_name: f0.functionName || '(anonymous)',
      },
    };
  }

  async resumeDebugger(session: Session): Promise<void> {
    const state = getExtras(session).debuggerState;
    if (!state?.paused) return;
    state.paused = null;
    try {
      await state.cdp.send('Debugger.resume');
    } catch {
      // Already resumed — drop.
    }
  }

  getDebuggerPauseState(session: Session): {
    breakpoint_ids: string[];
    location?: { file: string; line: number; column?: number; function_name?: string };
  } | null {
    const state = sessionExtras.get(session)?.debuggerState;
    if (!state?.paused) return null;
    const f0 = state.paused.callFrames[0];
    const loc = f0
      ? {
          file: f0.url ?? state.scriptUrls.get(f0.location.scriptId) ?? '',
          line: f0.location.lineNumber,
          column: f0.location.columnNumber,
          function_name: f0.functionName || '(anonymous)',
        }
      : undefined;
    return {
      breakpoint_ids: state.paused.breakpointIds ?? [],
      ...(loc ? { location: loc } : {}),
    };
  }

  async cleanupDebuggerState(session: Session): Promise<void> {
    const extras = sessionExtras.get(session);
    const state = extras?.debuggerState;
    if (!state) return;
    // Disarm re-pause sources before resuming. A conditional breakpoint can
    // fire on every keepalive WS send; resuming without disarming just lands
    // the page at the next pause. setBreakpointsActive(false) and
    // setPauseOnExceptions('none') clear both classes. Done under a
    // short-circuited timeout so a dead CDP connection can't block the close
    // path.
    const tryCdp = async (method: string, params?: Record<string, unknown>): Promise<void> => {
      try {
        await Promise.race([
          state.cdp.send(method as Parameters<typeof state.cdp.send>[0], params),
          new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error('cdp_timeout'));
            }, 2000);
          }),
        ]);
      } catch {
        /* ignore — best-effort cleanup */
      }
    };
    await tryCdp('Debugger.setBreakpointsActive', { active: false });
    await tryCdp('Debugger.setPauseOnExceptions', { state: 'none' });
    for (const id of state.breakpoints.keys()) {
      await tryCdp('Debugger.removeBreakpoint', { breakpointId: id });
    }
    state.breakpoints.clear();
    // Resume unconditionally. state.paused may read as null (the driver thinks
    // the agent already resumed) while the page has re-paused at a new hit the
    // runtime didn't see. Firing Debugger.resume when the page isn't paused is
    // a harmless no-op in CDP.
    await tryCdp('Debugger.resume');
    state.paused = null;
    if (state.enabled) {
      await tryCdp('Debugger.disable');
      state.enabled = false;
    }
    try {
      state.cdp.off('Debugger.paused', state.onPaused as unknown as (p: object) => void);
      state.cdp.off(
        'Debugger.scriptParsed',
        state.onScriptParsed as unknown as (p: object) => void,
      );
    } catch {
      /* ignore */
    }
    try {
      await state.cdp.detach();
    } catch {
      /* ignore */
    }
    if (state.pending) {
      clearTimeout(state.pending.timer);
      state.pending = null;
    }
    state.pauseQueue.length = 0;
    extras.debuggerState = undefined;
  }

  async closeBrowser(): Promise<void> {
    if (this._browser) {
      await this._browser.close();
      this._browser = null;
    }
    // In connect-mode 'spawn', browser.close() only disconnects the CDP
    // session — the Chrome process is ours, so kill it. 'attach' mode leaves
    // no child (the operator owns that Chrome).
    if (this._connectChild) {
      try {
        this._connectChild.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      this._connectChild = null;
    }
  }
}

function normalizePauseReason(
  raw: string,
): 'breakpoint' | 'debugger_statement' | 'exception' | 'other' | 'timeout' {
  if (raw === 'other' || raw === 'ambiguous') return 'breakpoint';
  if (raw === 'debugger_statement' || raw === 'debuggerStatement') return 'debugger_statement';
  if (raw === 'exception' || raw === 'promiseRejection' || raw === 'assert') return 'exception';
  if (raw === 'timeout') return 'timeout';
  if (
    raw === 'Break on start' ||
    raw === 'instrumentation' ||
    raw === 'XHR' ||
    raw === 'DOM' ||
    raw === 'EventListener' ||
    raw === 'step'
  )
    return 'other';
  return 'other';
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (typeof s === 'string') return s;
  } catch {
    /* fall through */
  }
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `${value.toString()}n`;
  return Object.prototype.toString.call(value);
}

function previewSource(f: CdpCallFrame): string {
  const name = f.functionName || '(anonymous)';
  const loc = f.location;
  return (
    `${name} @ line ${loc.lineNumber}` +
    (loc.columnNumber !== undefined ? `:${loc.columnNumber}` : '')
  );
}
