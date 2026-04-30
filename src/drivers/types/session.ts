import type { BrowserDriver } from '../interface';
import type { InterceptedRequest } from './network';
import type { WebSocketFrame } from './websocket';

export interface SessionOptions {
  storageState?: string;
  /**
   * Enable touch-event dispatch in the context. Set to true for mobile-emulated
   * sessions so the browser advertises touch support (`navigator.maxTouchPoints
   * > 0`, TouchEvent defined) and so the remote viewer forwards user gestures
   * as touch events instead of mouse events. Leave false/undefined for normal
   * desktop sessions.
   */
  hasTouch?: boolean;
  isMobile?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
  deviceScaleFactor?: number;
  /**
   * Platform slug — the short slug the caller passes to `save_strategy`. Used
   * by warm-pool implementations of `BrowserPool` to key cached containers per
   * platform. Safe to omit — pools that don't support warm reuse ignore this
   * field.
   */
  platform?: string;
  /**
   * Account name on the platform. Default-when-omitted is `"default"`,
   * matching the historical platform-only single-account behavior — single-
   * account use sees zero change. Named identities (`"work"`, `"personal"`)
   * scope the cookie jar (`<platform>--<identity>.json`), the identity
   * profile slot (`identities.json["<platform>--<identity>"]`), and the
   * pool's warm-slot key so two accounts on the same platform don't share
   * state. See klura://reference#identities.
   */
  identity?: string;
  /**
   * Marks the session as internal housekeeping (e.g. a save-time selector probe
   * from `strategy-probe.ts`) rather than user-facing work. Internal sessions
   * **bypass** the pool's `maxSessions` cap so they don't compete with the
   * agent's active sessions for the user's session budget. Lifecycle is
   * otherwise identical — they still count toward warm-pool reuse and close
   * like any other session. Default: false.
   */
  internal?: boolean;
}

/**
 * Abstract contract for any browser pool implementation. `Pool` (in-process
 * Playwright) satisfies this shape today; `KubernetesPool` will when the scale
 * architecture demands it. See `internal-docs/scale-architecture.md` for why
 * the interface exists at this layer.
 *
 * Warm-pool semantics (cache idle sessions, reset between reuses, evict on LRU
 * / TTL) are an **implementation detail** of a given pool — the interface stays
 * minimal on purpose. Callers should not be able to tell whether a given
 * `createSession` call hit a warm slot or spawned a fresh one; that's the whole
 * point.
 */
export interface BrowserPool {
  /**
   * Create a new klura session. The pool decides internally whether to reuse an
   * idle backend or provision a fresh one.
   */
  createSession(opts?: SessionOptions): Promise<Session>;

  /**
   * Close a session. The pool decides internally whether to tear down the
   * backend or return it to a warm slot for reuse.
   */
  closeSession(sessionId: string): Promise<void>;

  /** Look up a session by id. Throws if unknown. */
  getSession(sessionId: string): Session;

  /** Return the `BrowserDriver` responsible for a given session. */
  driverFor(sessionId: string): BrowserDriver;

  /** Tear down every resource the pool owns. Called on daemon shutdown. */
  shutdown(): Promise<void>;

  /** Number of currently-active klura sessions. */
  readonly activeSessions: number;

  /** Seconds since the most recent pool activity. */
  readonly idleSince: number;

  /**
   * Optional js-eval cache + refresh scheduler. Backs the `js-eval` fetch
   * prereq: execute reads cached values from here first, and a successful warm
   * mint installs a background refresh tied to the warm-slot lifecycle. Shape
   * is the structural `JsEvalCache` interface from `execution.ts` — kept as an
   * `unknown`-shaped optional here so this file doesn't circularly import the
   * executor.
   *
   * Optional because test stubs and single-purpose pools may not need it. When
   * absent, js-eval prereqs simply run synchronously on every call without
   * caching.
   */
  jsEvalCache?: unknown;

  /**
   * Per-session try_generator call counter. Returns the running stats for
   * `sessionId`, or null when no calls have been recorded yet. Pools that do
   * not host the iteration loop (e.g. test stubs) may return null
   * unconditionally. Save-time validation reads this to ground-truth the
   * agent's `verify_iterations` claims; the network-log advisory reads it to
   * nudge the agent based on how many iterations they've actually run.
   *
   * Shape kept as `unknown` here to avoid pulling the strategies module into
   * the driver-interface file. Concrete return type is `TryGeneratorStats |
   * null` from `strategies/try-generator-stats.ts`.
   */
  getTryGeneratorStats?(sessionId: string): unknown;

  /** Bump `total` for a session. Called by tryGenerator. */
  recordTryGeneratorCall?(
    sessionId: string,
    flags: { hadVerifyAgainst: boolean; ok: boolean },
  ): void;

  /** Append the diff produced by an ok:false try_generator(verify_against)
   *  call to the per-session ring buffer. The runtime computes the
   *  convergence signal (`progress: converging | stuck | oscillating`)
   *  from this history. Concrete arg type is `RecentDiffEntry`; kept as
   *  `unknown` here to avoid pulling the strategies module in. */
  recordTryGeneratorDiff?(sessionId: string, entry: unknown): void;

  /** Return the per-session recent-diff ring buffer (oldest first). The
   *  array is at most `RECENT_DIFFS_RING_SIZE` long. Concrete element
   *  type is `RecentDiffEntry`. */
  getRecentDiffs?(sessionId: string): unknown[];

  /** Approximate count of tool calls against this session — incremented
   *  on every getSession()/getDriver() lookup. Used by the envelope
   *  advisory to escalate when the agent has spent many rounds without
   *  a verified iteration. */
  getSessionRoundCount?(sessionId: string): number;

  /**
   * Ready-page checkout protocol. Ask the pool "is there an existing
   * warm/shared session for this platform whose page already satisfies my
   * readiness requirement?" — and if so, hand it out WITHOUT calling
   * `driver.resetSession` (which would navigate to about:blank).
   *
   * The `probe` is the transport's definition of "ready":
   *   - HTTP fetch/page-script:
   *       `async (s, d) => (await d.probePageReady(s, baseUrl)).page_on_url`
   *   - WebSocket:
   *       `async (s, d) => {
   *          const r = await d.probePageReady(s, baseUrl, wsUrlPrefix);
   *          return r.page_on_url && r.ws_open === true;
   *        }`
   *   - Recorded-path opts out (doesn't call this method at all).
   *
   * Semantics: iterate every session the pool can see for this platform — warm
   * slots AND any active sessions the listener or caller opted into sharing via
   * `registerSharedSession`. For each, run `probe`. First `true` → mark the
   * session `borrowed: true` and return it. All `false`, probe throws, no
   * candidates, or warm pool disabled → return `null` and the caller falls
   * through to `createSession`.
   *
   * Returned sessions follow the borrow/release rules documented on
   * `Session.borrowed`: `closeSession` is a no-op for listener-shared sessions
   * and a warm-slot return (without resetSession) for pool- warm sessions when
   * the release-time probe still passes.
   *
   * Optional — test-stub pools may omit. When absent, execute paths skip the
   * fast-path and go straight to cold `createSession`.
   *
   * See `runtime/docs/pool.md` for the full protocol, future-work list (N slots
   * per platform, LRU eviction, etc.), and the worked examples per transport.
   */
  tryCheckoutReadySession?(
    platform: string,
    probe: (session: Session, driver: BrowserDriver) => Promise<boolean>,
    /** Account name on the platform — see klura://reference#identities. The
     *  warm-slot key composes `(platform, identity)` so same-platform-
     *  different-identity calls correctly miss and cold-spawn. Default-when-
     *  omitted matches the historical platform-only behavior. */
    identity?: string,
  ): Promise<Session | null>;

  /**
   * Register a long-lived session owned by something OTHER than the pool
   * (canonical case: a `browser-event` listener that holds a page+WS open for
   * its lifetime) as a candidate for `tryCheckoutReadySession`. Purely additive
   * — the session's lifecycle is still owned by the caller; the pool just gets
   * a weak reference so the checkout protocol can find it.
   *
   * Unregister via the returned dispose function OR by calling `closeSession`
   * on the session (which the listener does at teardown).
   *
   * Optional — test-stub pools may omit.
   */
  registerSharedSession?(session: Session, platform: string): () => void;
}

/**
 * Shape reported by the server-side focus tracker whenever the focused element
 * changes in the page. `null` means no editable element is focused.
 */
export interface FocusState {
  editable: boolean;
  inputType: string; // 'text' | 'password' | 'email' | 'tel' | 'number' | 'search' | 'url' | 'textarea' | 'contenteditable'
  inputMode?: string; // from inputmode attribute, if present
  placeholder?: string;
  maxLength?: number;
}

export type FocusListener = (state: FocusState | null) => void;

/**
 * Tracked sub-page (popup, target=_blank tab, OAuth consent window). Drivers
 * keep the raw playwright/CDP page handle in their private per-session map;
 * what surfaces here is metadata only — the agent and rest of the runtime
 * address sub-pages by their `id` ("popup-1", "popup-2", ...). Ids are
 * monotonic per session and never reused: a popup that opened, was assigned
 * `popup-1`, and closed leaves the entry in `subPages` with `closedAt` set,
 * and the next popup that opens is `popup-2`. Fixing the id space matters for
 * recorded-path replay — a step pinned to `popup-1` resolves to that exact
 * entry, not whichever popup happens to be open.
 */
export interface SubPage {
  /** Stable handle for this session: `"popup-1"`, `"popup-2"`, ... */
  id: string;
  /** URL at the most recent observation. Updated on `framenavigated` within the popup. */
  url: string;
  /** Page title at the most recent observation, when known. */
  title?: string;
  /** Page that opened this one — `"main"` or a previously-assigned popup id. */
  openerId: string;
  /** Wall-clock ms when the popup was first observed. */
  openedAt: number;
  /** Wall-clock ms when the popup closed; absent while still open. */
  closedAt?: number;
}

export type SubPagesListener = (pages: SubPage[]) => void;

export interface Session {
  id: string;
  // Driver-internal state (Playwright Browser/Context/Page, etc) does NOT
  // belong here. Drivers keep that in their own private WeakMap<Session, T> so
  // non-driver code physically cannot reach through `session.page` and
  // accidentally hardcode Playwright assumptions that break the docker path. If
  // you find yourself wanting to add a backend-specific field here, add a new
  // abstract method to BrowserDriver instead.
  intercepted: InterceptedRequest[];
  intercepting: boolean;
  /**
   * Always-on buffer of every WebSocket frame the page sent or received during
   * the session's lifetime, populated by a default listener the driver attaches
   * at session creation. Separate from `streamWebSocketFrames` which is a live
   * callback surface for listener capabilities — this buffer exists so
   * `close_session`'s diagnostic dump can preserve the frames for post-run
   * inspection on sites whose real work happens over WS (chat apps, real-time
   * dashboards, collaborative editors, MQTT-over-WS channels).
   *
   * Drivers keep this capped at `WS_FRAMES_BUFFER_CAP` entries total to avoid
   * unbounded memory growth on long-lived sessions on chatty sites; oldest
   * frames are dropped first (ring-buffer semantics).
   */
  wsFrames?: WebSocketFrame[];
  /**
   * Pinned WebSocket frames — content-addressed map from ws_hash to the
   * verbatim frame, kept out of the FIFO rotation so RE tools can refer
   * back to a specific frame across long sessions even after thousands of
   * new frames arrive. Populated by:
   *   - `close_session`'s RE nag (auto-pins the target frame)
   *   - `pin_ws_frame(session_id, {ws_i | ws_hash})` (explicit pin)
   * Capped at `WS_PINNED_FRAMES_CAP` entries per session (LRU eviction on
   * overflow). Resolver functions in response/network-log-shape.ts try this
   * map first, then fall back to the ring.
   */
  pinnedWsFrames?: Map<string, WebSocketFrame>;
  /**
   * Per-session log of (ws_i → ws_hash) pairs previously resolved via
   * `resolveWsFrame`. Used by the staleness auto-upgrade: when a tool receives
   * `{ws_i: N}` and the current frame at `ring[N]` has a different content hash
   * than what we resolved at N last time, the runtime scans the ring for the
   * prior hash and auto-upgrades to that frame — the positional reference was
   * pointing at the wrong frame after ring rotation. Bounded; entries age out
   * when the ring doesn't contain the remembered hash anymore.
   */
  wsIndexLog?: Map<number, string>;
  /**
   * Per-session override of the driver's default WS-frame ring-buffer cap. When
   * unset, drivers use their built-in default (2000 frames — picked to bound
   * memory on chatty long-lived sessions). Bumped to a higher value (10000) by
   * the runtime when it detects a binary-WS / signed- request / other
   * structural advisory — the agent is about to enter an RE loop and probe-send
   * activity would otherwise evict the reference frames out from under it.
   * Pin-vs-rotation is a second line of defence (see pinnedWsFrames); raising
   * the cap gives legitimately related frames (ack, diff candidates) a chance
   * to stay in the ring without needing explicit pins.
   */
  wsFramesCap?: number;
  /**
   * Platform this session is bound to, set when the session is opened with a
   * platform option. Used to auto-persist storage state when the session closes
   * (or fails) so the LLM doesn't have to remember to pass it again.
   */
  platform?: string;
  /**
   * Identity (account) this session is bound to, set when the session is
   * opened with an identity option. `"default"` (or omitted) targets the
   * historical platform-only paths; named identities (`"work"`, `"personal"`)
   * scope the cookie jar + profile slot + warm-pool key. Read by cookie-write
   * paths (`writeStorageStateCookies`) and by the credential-autofill plugin
   * to pick the right account's username/password. See
   * klura://reference#identities.
   */
  identity?: string;
  /**
   * Whether this context was created with touch support enabled. Drivers should
   * honor this when forwarding pointer events from the remote viewer: dispatch
   * as touch events if true, mouse events otherwise. Set once at session
   * creation; do not mutate.
   */
  hasTouch?: boolean;
  /** Device profile name from the device registry, set at session creation. */
  device?: string;
  /**
   * URLs the driver has explicitly navigated to during this session (via
   * `driver.navigate` or session creation with a starting URL). Maintained by
   * driver implementations as a ground-truth list of pages the agent actually
   * visited — distinct from `intercepted[]`, which is the CDP network log of
   * XHR/fetch subresource requests and does NOT include top-level document
   * navigations on all drivers.
   *
   * Used by the save-time observation validator in strategy-probe.ts to
   * cross-reference page-extract prereq URLs against pages the agent really
   * saw. Without this, page-extract prereqs targeting the initial start_session
   * navigate URL get rejected as "not observed" even though the agent was
   * literally on that page.
   */
  visitedUrls?: string[];
  /**
   * Sub-pages (popups, `target=_blank` tabs, OAuth consent windows) the
   * driver has observed for this session, in the order they opened. Populated
   * by the driver's `context.on('page', ...)` listener attached at session
   * creation. Closed popups remain in this array with `closedAt` set so that
   * handle ids stay monotonic — see `SubPage` doc.
   *
   * Drivers keep the raw playwright `Page` objects in a private
   * `WeakMap<Session, Map<string, Page>>` keyed by `subPages[].id` (with the
   * main page stored under id `"main"`); non-driver code addresses sub-pages
   * exclusively by id and goes through `BrowserDriver` methods that take a
   * `{page}` opt.
   */
  subPages?: SubPage[];
  /**
   * Every `perform_action` call the session has received so far. Source of
   * truth for auto-synthesizing a `recorded-path` fallback strategy at
   * `close_session` time — the runtime replays this sequence to build a
   * step-by-step replay of what the agent did during discovery, so the agent
   * never has to manually save a recorded-path themselves.
   *
   * Populated by the perform_action handler in index.ts AFTER the action
   * executes successfully. Cleared on close_session (after synthesis runs).
   */
  performActionHistory?: PerformActionRecord[];
  /**
   * Rolling window of `(action, selector)` pairs that recently failed with a
   * locator timeout. Used by perform_action's repeat-selector guard: a model
   * that re-issues the same failed selector inside this window gets rejected
   * before dispatch, with the candidate-list hint, instead of burning another
   * 5s timeout. Capped at the last few entries by the writer.
   */
  recentFailedSelectors?: Array<{ action: string; selector: string; at: number }>;
  /**
   * Per-session record of URL transitions for the platform_map url_graph
   * and the surface-routing index. Populated by perform_action(navigate),
   * by the playwright `framenavigated` listener for click-driven and
   * form-submit navs, and by the SPA-route init script for
   * `history.pushState` / `replaceState` / `popstate` / `hashchange`.
   * Flushed to working-dir as `dom_navigation` capture events at close.
   */
  domNavigations?: Array<{
    at: number;
    url: string;
    title?: string;
    via?: 'nav' | 'click' | 'submit' | 'pushState' | 'replaceState' | 'popstate' | 'hashchange';
  }>;
  /**
   * Per-session record of `<form>` elements observed in DOM snapshots.
   * Flushed to working-dir as `dom_form_observed` events at close_session,
   * which folds them into the platform-level forms_seen inventory.
   * One entry per (url, action, method) observation; deduped at flush.
   */
  domFormsObserved?: Array<{
    at: number;
    url: string;
    action: string;
    method: string;
    fields: Array<{ name: string; type: string; required?: boolean }>;
  }>;
  /**
   * Mutating-action consent cache. Keyed by `${action}|${normalizedSelector}`
   * for every (action, target) tuple the agent acked via `ack_checkpoint`
   * this session. Populated only when the active graph's drive-phase config
   * has `gateMutatingActions: true`. Subsequent matching `perform_action`
   * calls skip the consent prompt — kills the loop where each click on the
   * same target re-prompted with a fresh nonce. Cleared with the rest of
   * session state on close_session.
   */
  gatedActionConsentCache?: Set<string>;
  /**
   * Mutating-action consent staging. Pending consents indexed by their
   * 4-char nonce — when `perform_action` raises the consent checkpoint, the
   * runtime stores `{action, selector}` here so `ack_checkpoint` can echo
   * the nonce back, validate it, and populate `gatedActionConsentCache`.
   * Local to the session so the global gate-token store stays unused for
   * this surface.
   */
  pendingActionConsents?: Map<string, { action: string; selector: string }>;
  /**
   * Capability names saved successfully during this session, in save order.
   * Populated by `saveStrategy` when `sessionId` is passed. Source of truth for
   * close_session auto-synthesis — partitions the performActionHistory by the
   * time window between saves so multi- capability sessions don't bleed actions
   * across capabilities.
   */
  savedCapabilities?: Array<{ capability: string; at: number; tier: string }>;
  /**
   * Total `save_strategy` calls the agent made on this session, including
   * attempts that threw (audit rejection, validation failure). Incremented
   * unconditionally at the top of every saveStrategy entry — separate from
   * `savedCapabilities`, which only records successes. close-session
   * compares these two: attempts > 0 AND savedCapabilities empty means the
   * agent tried to save and never landed one. Refuse to close without an
   * explicit ack so the agent doesn't accidentally leak a session whose
   * strategy work was rejected by audit and never recovered.
   */
  saveAttemptCount?: number;
  /**
   * Capabilities the agent declared at session-open (via `start_session`
   * with `{capability, args}`) or mid-session (via `declare_capability`).
   * Runtime uses these to:
   *  - auto-execute on start when a saved strategy matches the declared
   *    (capability, args) pair.
   *  - partition `performActionHistory` by declaration window at close so
   *    auto-synth derives one strategy per capability.
   *  - template captured request bodies: substitute each arg value with
   *    `{{<argName>}}` to produce a reusable body template.
   * Order is declaration order; `declared_at` is the wall-clock timestamp
   * at declaration (used to partition the action history).
   */
  declaredCapabilities?: Array<{
    capability: string;
    args: Record<string, string>;
    declared_at: number;
  }>;
  /**
   * Running total of extraction-tool-return character counts that the agent
   * actually saw during this session — a11y trees from start_session /
   * perform_action / get_a11y_tree, page text reads, etc. Feeds the
   * close_session ungrounded-read advisory: for a declared read-shaped
   * capability (args declared, no write-shape actions), if this counter stayed
   * low AND no arg literal matched any XHR body / WS frame, the agent cannot
   * have grounded their answer in extracted content — so the handoff flags it.
   * Incremented only when the returned text is non-empty; trimming-truncated
   * a11y trees still count for their trimmed length (that's what the agent
   * actually saw).
   */
  extractedContentBytes?: number;
  /**
   * Active graph — selects the FSM topology + per-phase configuration for
   * this session. See runtime/src/session-phase/graphs/. `'discover'`
   * (default) walks drive→triage→lift→closed; `'map'` walks drive→closed
   * with mutating-action consent + skipped auto-synth + tightened
   * re-persistence threshold; `'execute'` walks execute→triage→lift→closed
   * (or terminal{failed}) with auto-fall into triage on stale-strategy
   * failure.
   */
  graph?: import('../../session-phase/types').GraphName;
  /**
   * Session lifecycle status. `'active'` while the graph is in progress;
   * stamped to `'closed'` or `'failed'` when the FSM hits a terminal node.
   * Distinct from `phase` (which carries the active node when status is
   * 'active'). Universal-tools middleware uses status to short-circuit
   * admissibility on a finalized session.
   */
  status?: import('../../session-phase/types').SessionStatus;
  /**
   * LIFT mode selector. Controls what close_session does when a
   * declared capability is unresolved at session end.
   *
   *   - `'explicit_learn'` (default): interactive "let the user pick" mode.
   *     The LIFT handoff fires with suggested_user_prompt worded as "the
   *     answer has been delivered; I can spend N rounds trying to lift this
   *     to page-script (sub-second warm calls forever), or stop here with
   *     recorded-path (~30s per warm call). Want me to try?" The agent
   *     asks, waits for user, then proceeds.
   *
   *   - `'skip'`: no handoff at all — close_session just tears down, any
   *     auto-synthesized recorded-path still lands. Used when the caller
   *     has permanently opted out for this session.
   *
   * For autonomous runs without a human (benchmark / CI), register a
   * checkpoint stub that resolves every kind to `{status: 'continue'}` —
   * see e.g. field-reports/lib/checkpoint-stubs.js. The runtime routes
   * mid-flow events through the interruption registry; plugins decide
   * what to do with them.
   */
  liftMode?: 'explicit_learn' | 'skip';
  /**
   * Capabilities whose saved strategy auto-executed during this session
   * but failed in a way that signals the strategy is stale (HTTP 4xx/5xx
   * or an executor throw). Read by `computeReverseEngineerHandoff` to
   * route end_drive into LIFT even when a saved strategy already exists,
   * so the agent can override the broken strategy. Without this the
   * existence of the broken strategy satisfies `hasAny` and LIFT is
   * skipped — the agent has no surface to call `save_strategy` on.
   */
  staleStrategyCapabilities?: Set<string>;
  /**
   * Number of close_session calls the agent has made on this session. The first
   * close may be rejected with a nag when the runtime detects the agent skipped
   * the reverse-engineer path on a WS-carried send (diagnostic
   * `literal_in_ws_frame_only` + no fetch/page-script saved + no RE-toolkit
   * use). Second and later closes always succeed.
   */
  closeAttempts?: number;
  /**
   * Per-session accumulator for discovery-artifact construction. Every tool
   * handler that does investigative work (inspect_ws_frame, try_generator,
   * get_js_source, get_send_encoder, find_in_page, get_network_log,
   * get_attribute) appends a neutral record of WHICH call was made (tool name +
   * args digest + outcome flag — never the response content) after completing
   * its primary work. On save_strategy / close_session the
   * strategies/discovery-artifact.ts module reads this and merges it into
   * <capability>.json for the next session to consume. Sub-arrays ring-cap at
   * 200 entries each to bound memory on long sessions.
   */
  artifactAccumulator?: ArtifactAccumulator;
  /**
   * Count of get_action_history tool calls this session. Surfaces whether the
   * agent ever looked at action timing; used by close_session diagnostics.
   */
  getActionHistoryCallCount?: number;
  /**
   * LIFT phase state. Set by close_session when it returns the LIFT
   * (`phase: "lift"`) handoff response; tracks the agent's round count since
   * the role shift so the phase middleware can enforce the `lift.max_rounds`
   * budget.
   */
  lift?: {
    handoffAt: number;
    roundsSinceHandoff: number;
    /** Per-phase round budget; 0 = unlimited. Stamped at phase entry from
     *  config.lift.max_rounds. */
    budget: number;
    /** Set by middleware when roundsSinceHandoff >= budget && budget > 0.
     *  Causes subsequent calls outside `allowedToolsWhenExhausted` to be
     *  hard-blocked. */
    softBlockEngaged: boolean;
  };

  /** Execute-phase bookkeeping — entry phase for graph: 'execute'. The
   *  saved-strategy invocation lives here; on success, the FSM transitions
   *  to terminal{closed}; on failure, the rediscover-gate classifier on the
   *  `execute_failed` event routes to triage (stale-strategy) or
   *  terminal{failed} (arg/auth/structural). */
  execute?: {
    enteredAt: number;
    roundsSinceEntry: number;
    budget: number;
    softBlockEngaged: boolean;
  };

  /** Phase-machine state. `undefined` ≡ the active graph's entry phase;
   *  the registry's `currentPhase` resolves to `GRAPHS[session.graph].entryPhase`
   *  for fresh sessions. The session-phase state machine in
   *  `runtime/src/session-phase/` is the only writer of this field and the
   *  per-phase bookkeeping below. Terminal-ness is carried by `session.status`,
   *  not by this enum. See PhaseSpec / Graph in `session-phase/types.ts`. */
  phase?: import('../../session-phase/types').SessionPhase;

  /** Drive-phase bookkeeping — agent driving the UI to the goal. */
  drive?: {
    enteredAt: number;
    roundsSinceEntry: number;
    budget: number;
    softBlockEngaged: boolean;
  };

  /** Triage-phase bookkeeping — agent reads captures and writes a plan.
   *  `liftBudgetSnapshot` mirrors `config.lift.max_rounds` at triage
   *  entry so the exhausted-prefix prose can name the next phase's
   *  budget without reaching back into the config module.
   *  `triggeredBy` records what PhaseEvent put the session into triage,
   *  so lift's onEnter can distinguish re-plan re-entry (preserve
   *  counter) from surface-change re-entry (fresh budget). */
  triage?: {
    enteredAt: number;
    roundsSinceEntry: number;
    budget: number;
    softBlockEngaged: boolean;
    liftBudgetSnapshot?: number;
    triggeredBy?: import('../../session-phase/types').PhaseEventKind | null;
  };

  /** URL→surface binding. Populated by `submit_triage_plan` from each
   *  plan's `observed_at_urls`; read by `perform_action` to decide whether
   *  a new navigation crosses to an un-triaged surface (firing the
   *  `surface_changed` checkpoint). Keyed by `urlKey()` from
   *  `session-phase/surface-binding.ts` (origin + pathname; query / hash
   *  stripped; host lowercased). The durable canonical store is
   *  `triage_plans_by_surface` in the logbook — this is the in-session
   *  routing index. */
  surfaceMap?: Map<string, string>;
  /** Most recent canonical URL the runtime evaluated for `surface_changed`
   *  routing, used by the path-distinct check in `perform_action`. */
  lastSurfaceUrl?: string;
  /** True iff at least one mutating action (click/type/fill_editor/select/
   *  key_press) has been performed on `lastSurfaceUrl` since the last
   *  `surface_changed` fire or session start. Drives the DRIVE-phase
   *  surface-change detection: only fire when the agent did real work on
   *  the surface they're leaving — pure navigate-through journeys (landing
   *  page → linked page) shouldn't kick the agent into TRIAGE. Reset on
   *  each `surface_changed` fire and on path-distinct nav. */
  priorSurfaceHadMutation?: boolean;
  /**
   * True when this session was handed out by `pool.tryCheckoutReadySession` — a
   * shared warm/listener-owned session the caller is borrowing, not owning.
   * `pool.closeSession` on a borrowed session does NOT tear the session down;
   * it either returns it to its warm slot (pool-owned) or is a no-op
   * (listener-owned via `registerSharedSession`). Cold-spawned sessions leave
   * this undefined and follow the usual teardown path.
   */
  borrowed?: boolean;
}

export interface ArtifactAccumulator {
  inspectWsFrameCalls: Array<{
    ws_i: number;
    args_digest: string;
    starter_present: boolean;
    at: string;
  }>;
  tryGeneratorCalls: Array<{ args_digest: string; ok: boolean; at: string }>;
  getJsSourceCalls: Array<{ url: string; line?: number; at: string }>;
  getSendEncoderCalls: Array<{ ws_i: number; handle_alive: boolean; at: string }>;
  findInPageCalls: Array<{ needle_slug: string; matches_count: number; at: string }>;
  getAttributeCalls: Array<{ selector_digest: string; attr: string; at: string }>;
  getNetworkLogCalls: Array<{ filter_digest: string; full: boolean; at: string }>;
  // RE toolkit call counters. Drive close_session's nag suppression: if the
  // agent invoked any of these during the session, we infer an RE attempt was
  // made and don't pester them at close-time.
  /**
   * Per-call `js_eval` record. The persisted-to-disk shape is just
   * `{expression_digest, at}` (privacy: results may carry tokens). The
   * in-memory `expression` and `result_string` fields are populated for
   * the duration of the session and consumed by close-session auto-synth's
   * js-eval auto-promote pass (matches result strings to captured header
   * values, synthesizes implicit verified_expressions). Both fields are
   * scrubbed before any artifact / logbook write.
   */
  jsEvalCalls: Array<{
    expression_digest: string;
    at: string;
    expression?: string;
    result_string?: string;
  }>;
  searchJsSourceCalls: Array<{ url: string; pattern_digest: string; at: string }>;
  readJsFunctionCalls: Array<{ url: string; line: number; at: string }>;
  listLoadedScriptsCalls: Array<{ at: string }>;
  setBreakpointCalls: Array<{ file_digest: string; line: number; at: string }>;
  evaluateOnFrameCalls: Array<{ expression_digest: string; ok: boolean; at: string }>;
  /**
   * Typed, prose-length hints the agent has dropped this session. Persisted to
   * the discovery artifact at close_session for the next session to read. Keyed
   * by capability; per-capability ring cap 20 entries.
   */
  notes: Record<
    string,
    Array<{
      kind: string;
      body: string;
      at: string;
      verified?: boolean;
    }>
  >;
  /**
   * Expressions the agent has test-evaluated and confirmed work against sample
   * args this session. Keyed by capability. Persisted to the discovery artifact
   * so the next session can try them first.
   */
  verifiedExpressions: Record<
    string,
    Array<{
      expression: string;
      binds_args: string[];
      returns: 'hex' | 'base64' | 'string' | 'object';
      sample_byte_length?: number;
      notes?: string;
      tested_at: string;
    }>
  >;
  /**
   * Forward-looking pointers the agent recorded via add_resume_pointer, keyed
   * by the capability the agent said they apply to. Having the capability on
   * the pointer (rather than a flat session-wide array) matters: without it,
   * close_session can't tell which capability's artifact should carry the
   * pointer, and sessions where no save succeeded would lose agent-supplied
   * pointers entirely.
   */
  agentResumePointers: Record<
    string,
    Array<{
      kind: 'js_source' | 'request_index' | 'frame_index' | 'page_url' | 'other';
      ref: string;
      line?: number;
      note?: string;
      at: string;
    }>
  >;
  /** Agent-supplied forward-looking prose. */
  recommendedNextSteps: string[];
}

/**
 * Single entry in `Session.performActionHistory`. The action, selector, and
 * optional value captured as-passed by the agent — these translate 1:1 into
 * recorded-path steps during close_session auto-synthesis.
 */
export interface PerformActionRecord {
  at: number;
  action: string;
  selector?: string;
  value?: string;
  key?: string;
  url?: string;
  /**
   * The `locators` object the perform_action resolved against — a11y role /
   * name + css selector + alternatives. Preserving this instead of just the raw
   * selector makes the synthesized recorded-path robust to locale and minor DOM
   * shifts at warm time.
   */
  locators?: Record<string, unknown>;
  /**
   * Structural skeleton of the page at the moment this action fired. Stamped
   * only on mutating actions (click / type / fill_editor / select); absent on
   * navigate / key_press / wait. At close_session time, synthesize-on-close
   * copies this onto the generated recorded-path step as `_fingerprint`, and
   * the warm-execute step loop compares it against a live re-capture to
   * detect that the page drifted between discovery and warm run. Runtime-
   * internal; never authored by the LLM.
   *
   * Concrete shape is `PageFingerprint` from
   * `strategies/page-fingerprint.ts`; typed as `unknown` here to avoid a
   * cross-module import in the driver-interface file.
   */
  page_fingerprint?: unknown;
}
