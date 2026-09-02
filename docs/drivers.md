# Browser driver abstraction

Klura doesn't depend on any specific browser automation framework. All browser interaction goes through a **driver** — a pluggable adapter that implements the `BrowserDriver` interface in `runtime/src/drivers/interface.ts`. For driver selection (`pool.driver`), see [runtime.md#drivers](runtime.md#drivers). For pool / session checkout, see [pool.md](pool.md).

## Why pluggable

Different environments call for different drivers:

- A Pi running headless needs a lightweight automation framework
- A user's desktop can use their existing browser via an extension (Claude in Chrome)
- A cloud deployment might use managed browser infrastructure (Steel, Browserbase)
- Discovery might use an AI-native tool (Stagehand) while execution replays via a faster DOM-based driver

## Driver interface

Every driver declares which **capabilities** it supports. The capability set lives in `runtime/src/drivers/interface.ts`:

| Capability          | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `dom_selectors`     | Click/type/read via CSS/accessibility-tree selectors             |
| `network_intercept` | Capture XHR/fetch traffic (needed for graduation)                |
| `screenshots`       | Take screenshots                                                 |
| `storage_state`     | Save/restore cookies + localStorage across restarts              |
| `remote_view`       | Expose session for remote viewing                                |
| `file_download`     | Download files via browser                                       |
| `mouse_coordinates` | Precise mouse actions (drag handles, canvas tools, drawing apps) |
| `multi_context`     | Multiple isolated browser contexts in parallel                   |

The interface itself (conceptual TypeScript surface — the canonical version is in `runtime/src/drivers/interface.ts`):

```ts
interface BrowserDriver {
  capabilities: Set<string>;

  // Session lifecycle
  createSession(options?: { storageState?: string }): Session;
  destroySession(session: Session): void;
  resetSession(session: Session): void; // navigate to about:blank, reset interception state

  // Navigation
  navigate(session, url: string): void;
  waitForNavigation(session, options?): void;

  // DOM interaction (requires: dom_selectors). Every action and inspection
  // method takes an optional `{page}` opt — `"main"` (default) for the page
  // the session opened with, or a popup id from `session.subPages[].id`
  // (`"popup-1"`, `"popup-2"`, ...) for tracked popups / `target=_blank`
  // tabs. The driver keeps raw page references in a private
  // `WeakMap<Session, Map<handle, Page>>` so non-driver code only addresses
  // pages by handle.
  click(session, selector: string, opts?: { page?: string }): void;
  type(session, selector: string, text: string, opts?: { page?: string; replace?: boolean }): void;
  select(session, selector: string, value: string, opts?: { page?: string }): void;
  getText(session, selector: string, opts?: { page?: string }): string;
  getAccessibilityTree(session, opts?: { page?: string }): Tree;

  // Sub-page tracking (popups, target=_blank tabs, OAuth consent windows).
  // Drivers attach a `context.on('page')` listener at session creation and
  // push observed sub-pages onto `session.subPages` with stable monotonic
  // ids. Closed entries stay in the array with `closedAt` set so handle
  // ids never reuse.
  onSubPagesChange(session, listener): Promise<() => void>;

  // Observation
  screenshot(session): Buffer; // requires: screenshots
  startIntercepting(session): void; // requires: network_intercept
  getInterceptedRequests(session): Request[]; // requires: network_intercept
  getLoadedScripts(session): LoadedScript[]; // dedicated resource-event ledger

  // State
  saveStorageState(session, path): void; // requires: storage_state
  restoreStorageState(session, path): void; // requires: storage_state

  // Remote viewing
  startRemoteView(session): { url: string }; // requires: remote_view

  // Pool support
  probePageReady(session, urlPrefix, wsUrlPrefix?): { page_on_url: boolean; ws_open?: boolean };

  // RE / debugger surface (Playwright driver only)
  evaluateExpression(session, expression: string): unknown;
  // ...plus the CDP Debugger wrappers for set_breakpoint et al.
}
```

## Built-in driver

| Driver       | Capabilities | Best for                                    |
| ------------ | ------------ | ------------------------------------------- |
| `playwright` | All          | Default. Full-featured, headless or headed. |

`@klura/driver-playwright-stealth` ships as a separate npm package — install it and set `pool.driver` to its package name (or to an absolute path / relative path / BYO npm name) to swap drivers. See [runtime.md#drivers](runtime.md#drivers) for the full driver-selection mechanics.

**Stealth vs bot-evasion:** Stealth (making the browser's fingerprint consistent and realistic) is fine and encouraged — the user is a real human using a real browser. Bot-evasion (faking human mouse movements, solving CAPTCHAs programmatically, residential proxies) is not the marketed feature surface. When a site challenges the session, a human solves it via the remote viewer. See [principles.md](principles.md#stealth-vs-bot-evasion).

## Connect mode

By default the driver **launches** the browser through Playwright. Playwright's launch applies its own flag set (`--enable-automation`, a large default-args list) and a synthetic `--user-data-dir`; some managed challenges — notably an aggressive full-page interstitial — fingerprint that launch profile and loop forever, even with a fully native page and real-Chrome channel. The distinguishing signal is the **launch**, not the CDP connection: a Chrome launched the ordinary way clears the same challenge even with CDP attached afterward.

Connect mode makes klura **attach to a normally-launched Chrome over CDP** instead of launching one itself. Enable via config (`pool.connect`):

```json
{ "pool": { "connect": { "enabled": true, "mode": "spawn" } } }
```

- **`mode: "spawn"`** (default) — klura launches the real Chrome binary the ordinary way (a dedicated persistent profile under `{KLURA_HOME}/connect-profile`, no automation flags), waits for its DevTools endpoint, and `connectOverCDP`s to it. The spawned process is torn down on `closeBrowser`. Override the binary with `connect.chromePath` and the profile with `connect.profileDir`.
  - **Orphan reaping.** Chrome enforces one instance per profile via a `SingletonLock`. If a previous run left a Chrome holding the profile (an abnormal exit that skipped pool drain), a fresh spawn would hand its command line to that holder and exit without opening the debug port — surfacing as "failed to attach." So before spawning, klura reaps a **klura-owned** orphan: if a live lock holder is present and the profile is under `{KLURA_HOME}` (a path no human launches Chrome against), it SIGKILLs the holder and clears the stale lock. A holder on a **user-supplied** `profileDir` outside `{KLURA_HOME}` is never killed — it might be your own Chrome; the failure message names its pid so you can close it yourself. Note that changing `profileDir` to dodge a holder needs a runtime relaunch (it's a boot-time field), so closing/killing the holder is the in-process fix.
- **`mode: "attach"`** — connect to a Chrome you launched yourself with `--remote-debugging-port`, via `connect.endpoint` (e.g. `http://localhost:9222`). Use this to drive your own real, already-signed-in browser.

Connect mode always attaches with the **plain** Playwright chromium — never a stealth-wrapped one — because the browser is a genuine Chrome and must stay untouched; layering page-level evasions onto it would re-introduce detectable artifacts. It composes with the "no page-observable instrumentation by default" invariant (the built-in driver injects no init scripts), so the driven page stays byte-identical to a normal browser. This is squarely the "drive a real browser / human-in-the-loop" model, not behavioral bot-evasion: the browser passes because it genuinely is one. Cookie/login persistence still works via klura's per-platform `storageState`.

Connect mode stays **off by default** — it needs a local Chrome install and a browser relaunch, so it's a user-consented change rather than a baseline. To make the opt-in discoverable at the moment it's warranted, the challenge detector (`origin-blocked-detector`) appends a nudge toward `pool.connect.enabled` in its advisory **only** when the landing is challenge-shaped (interstitial / cross-origin-iframe) **and** connect mode is currently off. It never nudges when connect is already on, nor on server-status blocks (`http_failure`, HTTP 451) that connect mode can't clear.

## Accessibility snapshot failure containment

The built-in driver bounds the browser's native `ariaSnapshot()` read at 10 seconds. If that read stalls or fails, it falls back to the existing inert serialized-DOM tree builder; the fallback does not run page scripts or replace the live page. The HTML read has the ordinary 20-second page-operation ceiling. `start_session` treats both representations as contextual output rather than a session-lifecycle boundary: a static fallback returns `a11y_snapshot.source: "static_dom"`, while failure of both paths returns an empty tree with `a11y_snapshot.source: "unavailable"` and leaves the navigated session active for screenshots, targeted DOM reads, or `js_eval`.

## Multi-locator capture

During discovery, the LLM saves **multiple locator types** for each recorded-path step. This maximizes resilience — if one locator breaks, alternatives survive.

```json
{
  "id": "click_send",
  "action": "click",
  "locators": {
    "a11y": { "role": "button", "name": "Send" },
    "css": "#compose-btn-x3f2"
  },
  "alternatives": [{ "a11y": { "role": "button", "name": "Send message" }, "css": ".send-btn" }]
}
```

Two locator types:

```
Locator type │ Resilience │ Precision │ Requires
─────────────┼────────────┼───────────┼─────────────────
a11y         │ High       │ Semantic  │ dom_selectors
css          │ Low        │ Exact     │ dom_selectors
```

**Priority at execution:** a11y is preferred over CSS because semantic locators survive UI redesigns. The `alternatives` array is populated by `patch_step` during healing — each successful heal adds a new locator set as a fallback.

The session-pool checkout protocol that lifts warm slots into ~100 ms execute paths lives in [pool.md](pool.md).
