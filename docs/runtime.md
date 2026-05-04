# Runtime architecture

Klura runs as a long-lived background **daemon**. The CLI is a thin HTTP client — every command (except `daemon start/stop/status`) auto-starts the daemon if it isn't running and forwards the request. The daemon listens on either a unix socket (`~/.klura/klura.sock`, default) or TCP (`0.0.0.0:9400`, configured via `daemon.listen`). TCP mode lets the LLM and klura run on different machines. The daemon owns browser sessions, WebSocket listeners, and the token cache, so state persists across CLI invocations.

For driver internals, see [drivers.md](drivers.md). For pool internals, see [pool.md](pool.md).

## How it fits together

```
┌─ Agent ----------──────────────────────────────────────────┐
│                                                            │
│  LLM (any model)                                           │
│  │                                                         │
│  ├─ reads SKILL.md → knows klura's tools                   │
│  ├─ user: "message adam on facebook"                       │
│  │                                                         │
│  ├─ no skill for facebook? → discovery:                    │
│  │   ├─ start_session("https://facebook.com")              │
│  │   ├─ perform_action(id, "click", ...)                   │
│  │   ├─ get_network_log(id) → analyzes API                 │
│  │   └─ save_strategy("facebook", "send_message", {...})   │
│  │                                                         │
│  ├─ skill exists? → execute:                               │
│  │   └─ execute("facebook", "send_message", {to, text})    │
│  │                                                         │
│  ├─ "Message sent to Adam!"                                │
│                                                            │
└────────────────────────────────────────────────────────────┘

┌─ Klura Runtime ────────────────────────────────────────────┐
│                                                            │
│  CLI / LLM client                                          │
│  │                                                         │
│  └─ HTTP to daemon (unix socket or TCP)                    │
│                                                            │
│  ┌─ Daemon (orchestrator) ────────────────────────────────┐│
│  │ Manages sessions, listeners, tokens, pool              ││
│  └────────────────────────────────────────────────────────┘│
│                                                            │
│  ┌─ Browser sessions ───────────────────────────────────  ┐│
│  │ In-process Playwright against real Chrome              ││
│  └────────────────────────────────────────────────────────┘│
│                                                            │
│  ┌─ Skill storage (~/.klura/skills/) ────────────────────  ┐│
│  │ See docs/storage.md for the full tree          ││
│  └────────────────────────────────────────────────────────┘│
│                                                            │
└────────────────────────────────────────────────────────────┘
```

## Daemon lifecycle

The daemon is **auto-started** on first tool call and stays alive:

```
LLM calls klura tool for the first time
  │
  ├─ Klura skill checks: is daemon running? (pid file / health check)
  │
  ├─ Not running → start daemon as background process
  │   └─ daemon writes pid to ~/.klura/daemon.pid
  │   └─ listens on ~/.klura/klura.sock (unix socket)
  │
  ├─ Running → connect to existing daemon
  │
  └─ Send request, wait for response
```

The daemon shuts down after `daemon.idleTimeout` seconds with no active sessions or listeners (default 1800 = 30 min). Active listeners keep the daemon alive indefinitely. The session-level `pool.idleTimeout` (default 300 = 5 min) is a separate timer for individual session hang-detection.

## Tool interface — what the LLM sees

The full tool surface is exported from `runtime/src/index.ts` and re-exposed via the MCP server in `mcp/index.js`. The MCP transport translates camelCase TS exports to snake_case tool names (`startSession` → `start_session`, etc).

Tools group into eight clusters:

### Session lifecycle

| Tool | Purpose |
| --- | --- |
| `start_session(url, {platform?, capability?, args?, mode?, lift_mode?, on_complexity_signal?})` | Open browser, navigate, return `{sessionId, a11yTree, url, ...}`. Auto-executes if a saved strategy exists. |
| `end_drive(sessionId, platform?)` | Save storage state, run auto-synth, write working/sessions archive, surface LIFT handoff. |
| `declare_capability(args)` | Tell the runtime the capability slug + arg names without driving the browser yet. Required for auto-save when not declared at start_session time. |
| `status()` | Daemon-level read: active session count + listener count. |
| `wait_for_remote(sessionId, timeout?)` / `start_remote_session(sessionId, prompt)` / `stop_remote_session(sessionId)` | Hand control to a human via the tunneled viewer. See [remote.md](remote.md). |

### DOM interaction & inspection

| Tool | Purpose |
| --- | --- |
| `perform_action(sessionId, action, selector?, value?)` | click / type / select / key*press / scroll / mouse*\* / mouse_drag in the browser. Returns `{a11yTree, url}`. |
| `get_a11y_tree(sessionId, {page?, page_size?})` | Re-fetch the current a11y tree without performing an action. Paginated. |
| `get_screenshot(sessionId)` | Current page screenshot (base64 PNG). |
| `get_attribute(sessionId, selector, attr?)` | Read an attribute or text content from a CSS selector on the live page. Used during discovery to verify a candidate selector exists before committing it to a `page-extract` prereq. |
| `find_in_page(sessionId, needle, limit?)` | Scan every element in the current page for attributes / text containing `needle`. Returns up to `limit` matches with usable CSS selectors. The key primitive for tracing opaque request-body values back to the DOM that rendered them. |
| `get_action_history(sessionId)` | The performActionHistory accumulated on the session (what the agent has clicked/typed so far). |

### Network & request introspection

| Tool | Purpose |
| --- | --- |
| `get_network_log(sessionId, {i?, full?, url_contains?, last?, page?, page_size?})` | Summary by default; pass `{i: N, full: true}` for the raw entry with all headers and body. Two-call workflow is mandatory for tier classification — the summary alone can't tell a plain fetch from a fetch that needs prereqs from recorded-path; only `{full: true}` reveals CSRF headers and body shapes. |

### WebSocket frame & RE toolkit

| Tool | Purpose |
| --- | --- | --- |
| `inspect_ws_frame({session_id, ws_i? | ws_hash?})` | Full WS frame metadata including `js_callstack`. |
| `find_in_ws_frame({session_id, ws_i, needle})` | Search for a literal inside a captured frame body. |
| `explain_ws_frame_structure({session_id, ws_i})` | Heuristic decode of frame envelope shape. |
| `pin_ws_frame({session_id, ws_i? | ws_hash?})` | Lift a frame out of the FIFO ring buffer. See [reverse-engineering.md](reverse-engineering.md#explicit-pin-and-trigger-primitives). |
| `trigger_reference_send({session_id, actions})` | Fire a perform_action sequence and return every new sent-frame within a settle window, each with its hash. |
| `try_generator(args)` / `try_generator_in_page(args)` | Run candidate generator code (Node-VM sandbox / live page) and compare against a reference frame. Stamps `ConvergenceSignal`. |
| `get_send_encoder({session_id, ws_i? | ws_hash?})` | Live handle to the captured encoder function from the frame's call site. |

### Source-level debugger

Eight tools wrapping CDP's `Debugger` domain. See [reverse-engineering.md#source-level-debugger](reverse-engineering.md#source-level-debugger).

`set_breakpoint`, `remove_breakpoint`, `list_breakpoints`, `wait_for_pause`, `get_frame_scope`, `evaluate_on_frame`, `step`, `resume`.

### JS source reading

| Tool | Purpose |
| --- | --- |
| `list_loaded_scripts({session_id})` | Every script the page loaded, deduped + sorted by size. |
| `search_js_source({session_id, url, pattern})` | Literal substring search across a cached bundle body. |
| `read_js_function({session_id, url, line})` | Bracket-match-based function extraction. |
| `get_js_source({session_id, url, line, context?})` | Windowed source read. |
| `js_eval({session_id, expression})` | Evaluate in the live page. Auto-wraps top-level statements in an IIFE. Hex-encodes binary returns. |

### Strategy management

| Tool | Purpose |
| --- | --- |
| `save_strategy(platform, capability, strategy)` | Save a discovered strategy to disk. Runs the full validation pipeline (see [validation.md](validation.md)); rejects malformed strategies with `invalid_strategy` errors in the same turn. |
| `execute(platform, capability, args)` | Run a saved capability. Returns `{status, body, elapsedMs, tier}`. |
| `list_platform_skills()` | All saved skills, with per-capability summary digests including the discovery_artifact and notes. |
| `get_strategy({platform, capability, strategy_type?})` | Load the full strategy JSON for inspection. |
| `get_strategy_events({platform, capability?, limit?})` | Strategy life-cycle events (discovered, rediscovered, tier_demote, archived, unarchived, patched, healed) folded into the per-platform logbook. |
| `get_platform_logbook({platform})` | Per-cap counters and recency stats from `working/logbook.json`. |
| `lift_rate()` / `lift_rate_formatted()` | Aggregate tier_stamp across the corpus. Powers `klura lift-rate` CLI. |
| `clear_skills()` / `clear_all()` | Destructive resets used by tests and benchmark setup. |

### Discovery & RE state

| Tool | Purpose |
| --- | --- |
| `add_discovery_note(args)` | Free-text note (with optional `verified: true`) attached to the per-capability discovery artifact. |
| `add_resume_pointer(args)` | js_source url+line+frame index pointer the next session reads to resume RE. |
| `save_verified_expression(args)` | Reproducible JS expression that produced a byte-equivalent encoder result. Capped at 8192 chars. |
| `get_discovery_artifact_field(args)` | Read a single field from the artifact (e.g. just `verified_expressions`). |
| `set_capability_policy(args)` | Persist a per-capability tier cap. Triggered by user decline of the end-drive RE nag. |
| `record_lookup_candidate(args)` | Internal: classifier feeds candidates into the per-session accumulator. |

### Strategy healing

| Tool | Purpose |
| --- | --- |
| `patch_step(platform, capability, strategy_type, step_id, {locators})` | Patch a broken recorded-path step by its stable `step_id` (snake_case slug). The patched locator is written back as an `alternatives` entry. |
| `mark_healed(platform, capability, strategy_type)` | Reset health to healthy after a successful manual heal. |
| `reset_health(platform, capability, strategy_type)` | Clear failure counters for a strategy tier. |
| `get_strategy_health(...)` | Read current health status. |
| `resume_execution(sessionId)` | Continue a paused execute (after patch_step or after a blocker resolved). |

### Listeners

| Tool | Purpose |
| --- | --- |
| `start_listener(platform, capability, filter)` | Start a listener. Returns `listener_id`. Events arrive via `get_events` (pull) or hook callbacks (push). |
| `stop_listener(listener_id)` | Stop a listener. |
| `list_listeners()` | Active listeners with status. |
| `get_events({listener_id?, since?})` | Drain queued events (pull mode). |

### Reference & secrets

| Tool | Purpose |
| --- | --- |
| `get_skill_md()` / `get_reference_md()` | Read SKILL.md / REFERENCE.md from the installed `klura` package — the canonical source the MCP server and benchmark harness use. |
| `get_secret(scheme, ref)` | Resolve a `{{secret:scheme:ref}}` placeholder via the configured shell-command resolver. |

**Discovery is LLM-orchestrated.** There is no single `discover()` call — the LLM drives exploration via `start_session` → `perform_action` → `get_network_log` → `save_strategy`. The LLM is the reasoning engine; klura provides the browser and persistence. This means:

- No LLM integration in the runtime (no API keys, no Anthropic SDK)
- The LLM can adapt its exploration strategy on the fly
- Discovery instructions live in SKILL.md, not in runtime code

## The agent loop — execute flow

When the LLM calls `execute(platform, capability, args)`:

```
1. Merge identity fields into args
   ├─ Load identities.json[platform] (email, username, etc.)
   ├─ mergedArgs = { ...identity, ...explicitArgs }
   └─ Explicit args always take priority

2. Check per-platform policy
   ├─ Is this capability forbidden? → return policy_violation error
   └─ Filter available strategies by max_strategy_tier

3. Select strategy (priority order)
   ├─ fetch saved? → use it
   ├─ page-script saved? → use it
   ├─ recorded-path saved? → use it
   └─ nothing? → return error (no strategy found)

4. Execute strategy
   ├─ Interpolate {{placeholders}} from mergedArgs
   ├─ Resolve {{secret:scheme:ref}} via shell-command resolvers
   ├─ Run prerequisites (if the strategy declares any)
   │   └─ borrow Chrome context → extract tokens → release
   ├─ Fire request / replay path
   │
   ├─ Success? → return result to LLM
   │
   ├─ Auth error (needs_reauth)? → return with session info for reauth
   │
   ├─ Step failure (recorded-path)?
   │   ├─ healable? → return a11y tree + screenshot for LLM to patch
   │   └─ not healable? → mark strategy degraded
   │
   └─ Structural failure? → mark strategy degraded
       └─ cascade to next strategy tier
```

## Listener event routing

When a listener receives an event, it needs to reach the LLM. But the LLM isn't always "listening" — it's idle between conversations.

```
Listener event arrives (e.g. new message on Facebook)
  │
  ├─ Klura daemon receives event
  ├─ Matches against filter (if any)
  ├─ Stores in event queue
  │
  ├─ Is the LLM currently in a conversation?
  │   ├─ yes → deliver event as a callback immediately
  │   └─ no → queue event
  │       └─ when LLM starts next conversation:
  │           "You have 3 new events since last time"
  │           └─ deliver queued events
```

Pull-mode delivery (the LLM calls `get_events`) works on every MCP client and is the portable fallback. For true push-to-agent, the daemon exposes `klura hook-events` — a hook helper that drains the queue and emits Claude Code hook-protocol JSON on stdout, so `Stop` / `SessionStart` / `UserPromptSubmit` hooks in `~/.claude/settings.json` land events in the agent's next turn without the LLM having to poll. The `Stop` hook is the one that delivers async events mid-conversation: when the agent tries to end a turn and the queue is non-empty, the helper returns `{decision: "block"}` with the events as `reason`, forcing another turn. README "Real-time events with Claude Code" has the full settings.json snippet. MCP `notifications/resources/updated` is **not** wired up — as of April 2026 no Claude client (Desktop, Code, or Anthropic API) consumes MCP server notifications, so implementing that path would ship a dead wire. OpenClaw plugs into the same `/listener/events` endpoint; other agent runtimes can tail the daemon's event stream through the programmatic `onEvent` or HTTP APIs.

## Process architecture

Klura runs Playwright in-process against the daemon's Node runtime — no containers, no external dependencies.

```
LLM ──TCP──▶ klura daemon ──▶ Pool ──▶ PlaywrightDriver (in-process)
                                             │
                                             ▼
                                   real Chrome (headless)
                                             │
                                             ├─ driver.screenshotJpeg ─▶ remote/viewer.ts ─▶ WS client
                                             └─ CDP Network.enable ───▶ network log
```

`pool.channel: "auto"` (the default) launches the user's installed **real Google Chrome** — the TLS handshake (JA3/JA4, HTTP/2 SETTINGS, ALPN order) matches a regular browsing session because it _is_ one, just driven via CDP. If real Chrome isn't installed the driver falls back to bundled Chromium with a warning. Override with `pool.channel: "chrome" | "chromium" | "auto"`.

Chrome runs headless via `--headless=new` — the "unified" headless mode (Chrome 112+, default meaning of `--headless` since Chrome 128) that runs the same binary and engine as headed Chrome with a hidden window, so page behaviour matches what a user would see. Set `pool.headful: true` for a visible debug window on the daemon's host.

**Remote viewing** uses `runtime/src/remote/viewer.ts` — an HTTP+WebSocket server on an auto-picked port, serving a single HTML page with a canvas that renders JPEG frames. Frames flow from the driver's CDP `Page.startScreencast` subscription — push-based, delivered on compositor invalidation (caret blink, CSS transitions, scroll, input) — so fast animations reach the viewer without polling. Input (pointer, keyboard, touch) flows back over the WebSocket and dispatches through the same `BrowserDriver` methods the rest of the runtime uses — so the viewer is driver-agnostic, and any custom driver implementing the abstract surface gets it for free. Mobile-keyboard handling, clipboard bridging, Catmull-Rom pointer interpolation, and viewport-size handshake are all in `viewer.ts`.

The URL is optionally wrapped in a cloudflared tunnel so clients on other devices can reach it. Tunnel modes live in `runtime/src/remote.ts:RemoteConfig`: `auto` (try cloudflared, fall back to localhost), `cloudflared` (force tunnel, error on failure), `local` (never tunnel), `direct` (use an external `publicUrl`).

**Isolation is logical, not real.** Browser contexts share a single Chrome process; compromise of one context could in principle reach another. For personal-automation workloads on your own machine driving your own accounts this is fine — the threat model assumes you trust the skills you're running.

**Network capture** uses CDP `Network.enable` via the shared `runtime/src/drivers/cdp-network-capture.ts` module. CDP catches requests from iframes, service workers (when not blocked), Turbo/Relay submissions, and unusual custom submission mechanisms that Playwright's higher-level `page.on('request')` misses. Each PlaywrightDriver session owns a dedicated Network CDP session separate from the touch and screencast sessions, so detaching one doesn't disturb the others.

## Drivers

`pool.driver` picks which BrowserDriver class backs the pool. One built-in short name ships with runtime, plus BYO support:

- **`playwright`** (default) — plain Playwright, no stealth patches. Clean baseline; `navigator.webdriver` reports honestly.
- **`@klura/driver-playwright-stealth`** (separate package) — install alongside `klura` and set `pool.driver` to the package name. Extends `PlaywrightDriver` with `playwright-extra` + `puppeteer-extra-plugin-stealth` applied to `chromium.launch()`, patching `navigator.webdriver`, `chrome.runtime`, plugin enumeration, WebGL vendor/renderer strings, and language/platform consistency so fingerprint-based bot detection doesn't trip on vanilla Playwright's automation markers. Kept out of the main runtime so users who don't need stealth don't pay the install cost for `playwright-extra` + the stealth plugin.

Bring-your-own drivers are supported by passing a filesystem path or a bare npm module name to `pool.driver`. The runtime `require()`s the target and expects either a default export or a named class extending `BrowserDriver`. Example: `pool.driver: "/Users/x/my-driver.js"` or `pool.driver: "my-klura-driver"`. BYO drivers inherit the full driver surface from `BrowserDriver` — the viewer, CDP network capture, and execution plumbing all work against any implementation of that abstract class. A BYO driver that connects to a remote browser via CDP (`chromium.connectOverCDP(url)`) instead of launching locally fits the same shape — it's still a Playwright `Browser` underneath the abstract interface.

BYO drivers must be `.js` / `.cjs` — TypeScript sources compile first.
