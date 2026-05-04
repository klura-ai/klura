# Per-call session lifecycle

Every klura invocation runs through the same lifecycle. The flowchart and a high-level walkthrough live in `../ARCHITECTURE.md`. This file covers the mechanics in detail: what `start_session` loads, what `end_drive` persists, the per-platform working dir that backs cross-session memory, lift_mode, the full `~/.klura/config.json` settings reference, and the CLI-only controls that bypass the agent.

## start_session

`start_session(url, {platform, capability, args, graph, lift_mode, on_complexity_signal})` opens (or borrows) a browser session and returns the initial context the agent needs to drive. Internally:

1. **Load policy.** `~/.klura/skills/<platform>/policy.json` — user-set tier caps and forbid lists. If the requested capability is capped at `recorded-path` by user policy or by a fresh agent decline hypothesis, the response carries `prior_decline` so the agent doesn't try to RE again.
2. **Load saved strategies.** All on-disk strategies for `{platform, capability}` are read. If a complete strategy exists AND the served tier is at or above `fetch` (the LIFT threshold), the runtime auto-executes it and returns `executed: true` with the result. The agent skips straight to `end_drive`. See [Auto-execute session topology](#auto-execute-session-topology) for what "auto-executes" means at the session-graph level — `fetch` and `page-script` cold-spawn an isolated session that closes when execute returns; `recorded-path` does the same and additionally pauses the session intact when a step fails.
3. **Otherwise return drive context.** If no strategy auto-fires, the response carries the a11y tree, current URL, a `task_contract` describing what the agent is supposed to accomplish (graph-aware — `discover` and `map` shape it differently), and the active complexity-signal opt-out.

The `graph` parameter selects the FSM topology and per-graph behavior. Three graphs ship — `discover` (default goal-directed flow), `map` (surface mapping), `execute` (run-a-saved-strategy with auto-fall into triage on stale failure). Full topology + per-graph `GraphConfig` reference: [session-phases.md](session-phases.md). When the `discover` graph drives a session and the agent doesn't save a strategy, `end_drive` either auto-synthesizes a recorded-path from the action history or hands LIFT to the agent depending on `lift_mode`.

`on_complexity_signal: "skip"` at start_session disables the end-drive RE nag for this one call. Used when the caller doesn't want a complexity-driven re-prompt — benchmarks, anything with no human in the loop.

### Drive-start contextual hints

Discovery-mode `start_session` (no auto-execute available, agent is about to drive) emits a final `_hint` block built from structural signals on the landing page. The agent has the goal but has not yet picked a strategy shape — this is the highest-leverage moment to plant a behavioral nudge that's only relevant when the page actually has the matching shape. Implemented in `collectDriveStartNudges` in `runtime/src/tools/start-session.ts`.

Three detectors are wired today, each gated on a purely structural signal already captured during the initial nav (no fuzzy keyword matching against page prose):

| Detector | Structural signal | Nudge |
| --- | --- | --- |
| Auth-gated site | A captured `<form>` field with `type="password"` | "save the auth flow as its own capability with `provides: ["auth"]` and chain dependents via `prerequisites: [{name: "auth", kind: "tag", tag: "auth"}]` instead of duplicating the login flow into every recorded-path. Multi-method auth coexists as separate capabilities on the same platform." |
| Search-shaped UI | A captured form with one or two fields and at least one `type="search"` input (and no password / email field) | "the classical capability shape is `search_<entity>` with the user's query as a single arg, lifted to `fetch`." |
| Prior-session handoff | `result.artifacts` is non-empty (the runtime inlined at least one discovery artifact for this platform) | "read each artifact's notes / verified expressions / resume pointers BEFORE driving, and persist new findings via `add_discovery_note` / `save_verified_expression` / `add_resume_pointer`." |

The detectors fire only when the structural cue is present on this specific session — these reminders cost zero tokens on every other call. SKILL.md stays terse; this is the layered-teaching pattern from `principles.md` realized at the start_session lifecycle edge.

**Adding a new detector.** The signal MUST be structural (input type, ARIA role, form action attribute, presence of a captured artifact) — not prose matching against agent-emitted text or page copy, which is the fuzzy-heuristic anti-pattern the principles file forbids. Add the detector in `collectDriveStartNudges` next to the existing three, gate it on a single structural predicate, and write the nudge as a one-shot behavioral steer (what to do this session). Don't add prose that would still apply on the next call — that's SKILL.md territory, not a per-session hint.

## Auto-execute session topology

When `start_session` finds a complete saved strategy and auto-executes it, the call works through TWO browser sessions, not one.

- **The agent-driving session** (the "outer" one) is what `start_session` returned. Every `perform_action` / `get_a11y_tree` / `get_screenshot` the agent calls during a discovery flow runs against this session. Its id is the `sessionId` in the `start_session` response.
- **The auto-execute session** (the "inner" one) is created by the strategy executor itself when the cascade reaches a tier that needs a browser:
  - `fetch` (`transport: "browser"`) and `page-script` cold-spawn a session via `pool.createSession(...)`, fire the request inside it (or run the page-script), and close the session when execute returns. The agent never sees this id.
  - `recorded-path` ALWAYS cold-spawns a fresh session — `runtime/src/execution/recorded-path.ts:78`. The rationale lives in the comment at lines 74-77: step replay assumes a clean DOM (no leftover dialogs, scroll offsets, hover state), so the recorded-path tier opts out of ready-page reuse even when the outer session has already loaded the same origin.

The two sessions load from the same on-disk `storageState` (so they start with the same cookie jar) but diverge from there — they run in separate Playwright contexts, with separate page state, separate network logs.

For `fetch` and `page-script`, this is invisible: execute returns a final result, the inner session is destroyed, and only the outer remains. There's nothing to resume.

For `recorded-path`, the asymmetry surfaces when a step fails mid-flow. The runtime registers the paused execution in `pausedExecutions` keyed by the **inner** session id (`recorded-path.ts:444`), and the failure envelope's `session_id` field is also the inner id. The agent's `start_session` response, however, only carries the outer id. Two consequences:

- `resume_execution(<outer_id>)` returns `No paused execution for session ...`. The agent has to read `session_id` out of the failure envelope (or the `_checkpoint` context) and call `resume_execution(<inner_id>)` instead.
- `ack_checkpoint(<outer_id>, ...)` succeeds (checkpoint dispatch is keyed by checkpoint_token, not session id), but the inner session may carry its own pending checkpoint state that an additional ack against the inner id resolves.

This is a known sharp edge of the topology. A future change can either alias outer↔inner so resume_execution(outer_id) finds the right paused entry, or unify auto-execute and the agent-driving session for recorded-path. Until then, callers that programmatically drive auto-execute → resume should read the resume target from the failure envelope's `session_id`, not from `start_session`.

## end_drive

`end_drive(sessionId, platform?)` is the most consequential per-call surface. Four steps:

1. **Auto-synth recorded-path.** If the agent saved no strategy AND `performActionHistory` is structurally rich (multiple navigations / clicks / inputs), the runtime synthesizes a `recorded-path` strategy from the action history. If the captured WS frames carry a literal that's also in `args` (the `synth_fetch` path scans both URL and body), it instead synthesizes a `fetch`. The synth is best-effort and never fails end_drive. When the agent's `perform_action` selector matched Playwright's a11y-snapshot syntax (`<role> "<name>"` — the typical shape after reading an a11y tree), the synthesizer decomposes it into a structured `locators.a11y: {role, name}` alongside the original string in `locators.css`. This shape is what the cascade and warm-execute self-heal expect; without it, drift recovery on the warm path is css-only and skips the role-based rescan layers.
2. **Flush captures.** Every captured request, every WebSocket frame, every `perform_action` call, the tool-call trace, the JS bundles fetched during the session, and the storage state at close are written to `~/.klura/workdir/<platform>/sessions/<sid>/`. These are the inputs to cross-session memory and to the `discovery_artifact` that travels with each capability.
3. **Recompute derived signals.** `field-stability.json`, `bundle-history.json`, and `signer-history.json` get recomputed with this session's contributions folded in.
4. **Compute unresolved capabilities.** Anything the agent declared via `start_session({capability})` or `declare_capability` that didn't end up with a saved strategy AND isn't user-policy-capped becomes a candidate for the LIFT handoff.

If unresolved capabilities exist, the close response carries a handoff payload whose shape depends on `lift_mode` (see below). Otherwise end_drive returns clean.

## Per-platform working dir (logbook)

Persistent per-platform archive at `~/.klura/workdir/<platform>/` — the substrate for cross-session memory. `end_drive` flushes captures, recomputes derived signals, and updates the logbook. The logbook backs the inline `triage[<cap>]` block on the LIFT handoff (current_tier + prior_attempts + discovery_artifact), `get_platform_logbook` (pull-on-demand cross-session derived signals), the revisit prompt on warm execute, and the `lift_mode` decision path.

Full on-disk layout, schema, writers, and readers: see [logbook.md](logbook.md).

## Settings reference (`~/.klura/config.json`)

All keys, defaults, and meanings as written by `runtime/src/config.ts`.

| Key | Default | Meaning |
| --- | --- | --- |
| `daemon.idleTimeout` | `1800` | Daemon idle-shutdown seconds (30 min). Resets on any active listener. |
| `daemon.listen` | `"unix"` | `"unix"` (default `~/.klura/klura.sock`), or `host:port` for TCP. |
| `pool.idleTimeout` | `300` | Per-session idle-shutdown seconds (5 min). |
| `pool.maxSessions` | `8` | Max concurrent sessions. |
| `pool.headful` | `false` | Show visible browser window. |
| `pool.channel` | `"auto"` | `"chrome"` \| `"chromium"` \| `"auto"`. Auto = real Chrome with Chromium fallback. |
| `pool.driver` | (unset) | BYO driver path or npm package name. |
| `pool.warm.enabled` | `false` | Opt in to warm session reuse. |
| `pool.warm.max_contexts` | `3` | Per-platform warm slot cap. |
| `pool.warm.idle_ttl_seconds` | `600` | Warm slot idle-eviction TTL (10 min). |
| `graduation.observation_threshold` | `3` | Recorded-path observations before fetch graduation fires. |
| `tunnel.mode` | `"auto"` | `"auto"` \| `"cloudflared"` \| `"local"` \| `"direct"`. Remote-viewer tunnel selection. |

User-facing settings live in `~/.klura/config.json`, not in `KLURA_*` env vars. Programmatic callers pass options directly to `new Pool({...})` / `createPool({...})`. The handful of env vars that exist are reserved for things config genuinely can't own (`KLURA_HOME`, `KLURA_REMOTE_SECRET`, `KLURA_DAEMON_ADDR`).

## lift_mode

`lift_mode` controls whether the end_drive handoff fires and how it's framed. The on-disk effect is identical regardless of who answers the prompt; only the handoff message shape changes.

- `explicit_learn` (default) — handoff fires; the agent writes a user-facing prompt in its own voice from the inline triage bundle + captures and waits for a reply. Standard interactive user flow.
- `skip` — no handoff fires; end_drive tears down. Use for one-shot reads where you never want RE.

For autonomous runs without a human, register a checkpoint handler that auto-resolves the relevant kinds to `continue` — see `field-reports/lib/checkpoint-stubs.js` for the canonical example. Behavior is plugin-orchestrated via the checkpoint registry; no flag-driven branches in runtime hot paths.

## CLI-only controls (no agent write path)

Some controls are deliberately user-only — the agent has no MCP write path to them. The trust boundary is the user's own hand on the CLI.

- **`klura policy set <platform> <capability> max_strategy_tier=recorded-path --reason "<text>"`** — permanent ToS / compliance cap. Survives every refactor; agent cannot override.
- **`klura policy clear <platform> <capability>`** — remove the cap.
- **`klura status`** — read-only daemon status: active session count and active listener count.
- **`klura device set --preset <name>`** — write a fresh `device.json` from a built-in preset. See [identities-and-device.md](identities-and-device.md).
- **`klura device probe`** — interactive device-fingerprint capture from a real device. See [identities-and-device.md](identities-and-device.md).
