# Session phases — the state machine

Every klura session walks one of three named graphs (**discover**, **map**, **execute**). Each graph is a small declarative state machine over a shared phase set: **drive | triage | lift | execute**. Terminal-ness is a property of the Graph node, not the phase enum — `session.status` carries `'active' | 'closed' | 'failed'` when the FSM hits a terminal. Each phase has its own admissible-tool set, round budget, and entry hook; per-graph behavior (consent gates, auto-synth, re-persistence threshold) lives in each Graph's `GraphConfig`, not in the phase spec.

Phase transitions are driven by explicit events (agent calls a tool, runtime classifies an outcome) and are owned by a single dispatcher in `runtime/src/session-phase/state-machine.ts`. **No other module writes `session.phase` or `session.status`** — out-of-band writes are forbidden by code review.

This page is the canonical reference for the phase machine: what each graph contains, what each phase admits, when transitions fire, and how to extend the system. The agent-facing prose lives in `runtime/SKILL.md` (compact) and `runtime/REFERENCE.md#triage` / `#graphs` (full).

## The three graphs

Graphs are data — `runtime/src/session-phase/graphs/<name>.ts` exports each as a `Graph` literal (nodes, transitions, per-graph `GraphConfig`). Adding a graph is one new file. The Mermaid dumper in `runtime/src/session-phase/dump.ts` reads any Graph and emits flowchart source.

| Graph | Topology | Notable per-graph config |
| --- | --- | --- |
| **discover** (default) | `drive → triage → lift → terminal{closed}` | None special — the canonical reverse-engineering flow. |
| **map** | `drive → terminal{closed}` | `gateMutatingActions: true`, `skipAutoSynth: true`, `inferObservedCapabilitiesAtClose: true`, `skipDeclarationGuard: true`, `rePersistenceThreshold: {reCalls: 1, actions: 5}`, `obligationStyle: 'flush_reminder'`. |
| **execute** | `execute → triage → lift → terminal{closed \| failed}` | The `execute_failed` event has a guarded transition (rediscover-failure gate fires → triage) and an unguarded fallback (terminal{failed}). |

## The four phases

| Phase | Purpose | Round budget (default) | Used in |
| --- | --- | --- | --- |
| **drive** | Agent drives the UI to deliver the user's answer. Click, type, navigate, read the page. | `0` — unlimited | discover, map |
| **triage** | Agent reads the page's defense surface (origins, scripts, cookies, request patterns) and submits a per-surface plan. Diagnostic reads only; saves are blocked here and gate on a bound surface plan. | `10` rounds | discover, execute (after fail-into-triage) |
| **lift** | Agent executes the RE playbook against the approved plan. Full toolkit (`try_generator`, debugger, monkey-patch). | `0` — unlimited | discover, execute |
| **execute** | The runtime invokes a saved strategy. Agent surface is narrow (auth recovery + screenshots) — the strategy runs as one logical operation. | `0` — unlimited (no rounds budget) | execute |

Default for any new session is the active graph's `entryPhase` (`session.phase` undefined ≡ `GRAPHS[session.graph].entryPhase`).

## Transition tables

`discover` graph:

```
drive  ──[end_drive_unresolved]──→ triage
drive  ──[resolved_via_save]────→ terminal{closed}
triage ──[plan_submitted]───────→ triage              (self-loop — counter reset, checkpoint fires)
triage ──[plan_handoff]─────────→ lift                (agent reads user's ack downstream)
triage ──[surface_changed]──────→ triage              (self-loop — perform_action crossed surfaces mid-triage)
triage ──[resolved_via_save]────→ terminal{closed}
lift   ──[plan_submitted]───────→ triage              (re-plan path after user said no)
lift   ──[surface_changed]──────→ triage              (un-triaged surface; re-fingerprint)
lift   ──[resolved_via_save]────→ terminal{closed}
```

`map` graph:

```
drive  ──[end_drive_unresolved]──→ terminal{closed}
drive  ──[resolved_via_save]────→ terminal{closed}
```

`execute` graph:

```
execute ──[execute_succeeded]──→ terminal{closed}
execute ──[execute_failed]─────→ triage              (when rediscoverFailureGate predicate returns true)
execute ──[execute_failed]─────→ terminal{failed}    (otherwise — arg/auth/structural failures)
triage  ──[plan_submitted]──────→ triage              (same as discover from here)
triage  ──[plan_handoff]────────→ lift
triage  ──[surface_changed]─────→ triage
triage  ──[resolved_via_save]───→ terminal{closed}
lift    ──[plan_submitted]──────→ triage
lift    ──[surface_changed]─────→ triage
lift    ──[resolved_via_save]───→ terminal{closed}
```

**No `plan_rejected` event.** The runtime never classifies the user's ack reply as approve / reject — that's the agent's job. The agent reads `user_response` from `ack_checkpoint`, decides, and either calls `submit_triage_plan` again (`plan_submitted` re-enters triage) or proceeds with RE moves (the original `plan_handoff` already transitioned to LIFT).

**Guarded transitions.** A single `(from, on)` pair can declare multiple destinations with a `when(session, payload)` predicate. The first matching entry wins; an unguarded entry serves as the fallback. This is how `execute_failed` routes between triage and `terminal{failed}` in the execute graph: the guard wraps `runtime/src/session-phase/guards/rediscover.ts`, which checks the saved-strategy's rolling success rate against `pool.rediscoverThreshold`. Stale strategies fall into triage with the failure as defense-surface input; structurally bad calls (wrong args, expired auth) terminate `failed`.

Anything not in any graph's transition table is illegal for that graph — `dispatch` throws `SessionPhaseTransitionError`. Programmer bugs surface loudly.

## Per-phase admissibility (hard tool blocking)

Every MCP tool dispatch goes through `assertToolAdmissibleBySessionId` (`runtime/src/session-phase/middleware.ts`). The middleware:

1. Looks up the session (skips check if no live session — e.g. `start_session` itself).
2. Checks **universal tools** first (`UNIVERSAL_TOOLS` in `tool-catalog.ts`). These are admissible in every non-terminal phase: `ack_checkpoint`, `resolve_interruption`, `list_platform_skills`, `get_platform_logbook`, `start_remote_session`, plus admin / read-only-config tools.
3. Otherwise consults `currentSpec(session).checkAdmissibility(toolName, session)`:
   - Tool not in `phase.allowedTools` → reject with `tool '<name>' is not available in phase '<phase>'. ...`
   - Tool in `allowedTools` but `softBlockEngaged === true` AND tool not in `allowedToolsWhenExhausted` → reject with the phase's exhausted-prefix message.
4. Increments the per-phase counter on admitted calls (rejected calls don't burn budget).

Per-phase tool sets (composed from shared catalogs in `tool-catalog.ts`):

| Phase | Composes |
| --- | --- |
| **drive** | `DRIVE_ACTIVE` (start_session, perform_action, end_drive, declare_capability, resume_execution) ∪ `READ_ONLY_DIAGNOSTIC` |
| **triage** | `READ_ONLY_DIAGNOSTIC` (get_network_log, inspect_ws_frame, get_js_source, search_js_source, read_js_function, list_loaded_scripts, js_eval, find_in_page, get_attribute, get_screenshot, get_action_history) ∪ `TRIAGE_AND_LIFT_WRITE` (save_strategy, add_discovery_note, add_resume_pointer, record_observed_capability, save_verified_expression, submit_triage_plan) |
| **lift** | triage's set ∪ `LIFT_RE_ACTIVE` (try_generator, set_breakpoint family, evaluate_on_frame, install_page_init_script, trigger_reference_send, patch_step, start_listener / stop_listener / get_events) |
| **execute** | narrow: `end_drive`, `get_screenshot`, `start_remote_session`, `stop_remote_session`, `wait_for_remote`, `get_secret`. The strategy runs as one logical operation; the agent surface is auth-recovery + screenshots only. |

When the FSM hits a terminal node (`session.status` becomes `'closed'` or `'failed'`), only universal tools admit — phase-scoped tools reject.

When budget is exhausted (`session.<phase>.softBlockEngaged === true`), the admissible set narrows:

- **drive** exhausted: `{end_drive}` only.
- **triage** exhausted: `{submit_triage_plan}`.
- **lift** exhausted: `{save_strategy, submit_triage_plan}`.
- **execute** has no rounds budget by design (the strategy is one operation), so the exhausted state never engages.

The narrowing is the **only** soft enforcement — the agent isn't told the budget exists up front; they discover it when an out-of-set tool gets rejected. The rejection prose names the budget so the agent can route correctly without prior knowledge.

## Per-phase round budget

Each non-terminal phase carries a `budget` and `roundsSinceEntry` counter (or `roundsSinceHandoff` on lift, equivalent semantics). Budgets are configurable per phase:

```json
{
  "drive": { "max_rounds": 0 }, // 0 = unlimited (default)
  "triage": { "max_rounds": 10 }, // tight by design
  "lift": { "max_rounds": 0 }
}
```

`max_rounds: 0` short-circuits the soft-block check entirely — no exhausted state can engage.

Counter resets on every transition INTO the phase (including self-loops on `plan_submitted`). The state machine's `enterX` handler is the single point that does the reset; callers don't reset directly. Stamping the budget at entry means the middleware doesn't re-read config on every tool call — a config change between sessions takes effect on the next `enterX`.

## What `submit_triage_plan` does

`submit_triage_plan(args)` is a per-surface defense-fingerprinting commit:

1. Validate args (shape check via `parseArgs` — capability declared, surface_label non-empty, defense_surface fields present, expected_tier in the closed enum).
2. Look up session, assert phase is `triage` or `lift`.
3. **Cite-validate `tier_justification`** — must reference at least one verbatim artifact actually present in `session.intercepted` / `session.domNavigations` (origin, script URL, script filename, cookie name, or observed nav URL). Empty or uncited justifications reject with the candidate list. The agent's verdict has to be grounded.
4. **Server-derive `observed_at_urls`** from `session.domNavigations` between triage entry and submission — the agent doesn't supply visit lists; the runtime knows.
5. Persist to `per_capability[<cap>].triage_plans_by_surface[<surface_label>]` in the per-platform logbook. Prior plan for the same surface rotates into `triage_plan_history_by_surface[<surface_label>]` (capped at 5 per surface).
6. **Bind URLs to surface** — every URL in `observed_at_urls` is added to `session.surfaceMap` keyed by canonical `urlKey()` (origin + pathname; query / hash stripped). Subsequent navigations that land on these URLs don't re-fire `surface_changed`.
7. **Step A — drop back to triage.** `dispatch(session, { kind: 'plan_submitted' })`. From triage, this is a self-loop that resets the counter; from lift, it transitions back to triage. Either way: `currentPhase === 'triage'`, `roundsSinceEntry === 0`. This is the symmetric re-plan invariant — re-plans look identical to first plans from the state machine's perspective.
8. **Step B — fire the `triage_plan` checkpoint.** Default handler resolves `handover` (real human flow → surfaces `summary_for_user` as ask-user prose); benchmark / autonomous stub resolves `continue` (silent).
9. **Step C — transition to LIFT.** `dispatch(session, { kind: 'plan_approved' })` → phase becomes `lift`. Return `{ ok: true, phase: 'lift', _checkpoint }`. The agent surfaces the prompt to the user, the user replies in any language, the agent calls `ack_checkpoint({checkpoint_token, user_response: <verbatim reply>})` and **classifies the reply themselves**: clean approve → proceed with RE moves; reject → call `submit_triage_plan` again with revised plan; approve-with-comment → incorporate before first RE move. The runtime never keyword-matches the reply — that's the LLM's job.

Tier suggestion is **informational, not gating** — the agent still aims T0 (fetch) → T1 (page-script) → T2 (recorded-path) in lift in order. The verdict shapes user expectation + escalation hygiene; on aggressive surfaces, T0 / T1 attempts may burn the session and the agent should retry from a fresh ephemeral context.

```ts
{
  surface_label: string,
  defense_surface: {
    observed_origins: string[],
    observed_scripts: string[],
    cookies_set: string[],
    request_patterns: string[],          // free-text observations
    mechanism_hypothesis: string,        // free-text; agent draws on its own knowledge of vendors
  },
  expected_tier: 'fetch' | 'page-script' | 'recorded-path',
  tier_justification: string,            // cite-validated against session traffic
  summary_for_user: string,              // 1-3 sentences, plain language
}
```

## Surface-changed checkpoint

`runtime/src/tools/perform-action.ts` evaluates the post-action URL after the navs drain. When the URL is path-distinct from `session.lastSurfaceUrl` AND no triage plan covers it AND the session is in lift / triage, the runtime:

1. Updates `session.lastSurfaceUrl`.
2. Dispatches `{ kind: 'surface_changed' }` — transitions LIFT → triage (or self-loops in triage), resets the round budget.
3. Fires the `surface_changed` checkpoint with `{ new_url, prior_surface? }`.
4. Surfaces the `_checkpoint` envelope on the perform_action response. The next tool call must ack via `ack_checkpoint`.

Path-distinct rule: different `origin + pathname` after canonicalization (host lowercased, trailing slash stripped). Same pathname with different query is NOT path-distinct (filter UIs).

SPA route changes (`history.pushState` / `replaceState` / `popstate` / `hashchange`) feed the same flow via a driver-side `addInitScript` patch in `runtime/src/drivers/playwright.ts` — modern SPAs are first-class, not a deferred TODO.

## Auto-close on terminal `save_strategy`

When `save_strategy` succeeds and zero declared capabilities remain unresolved, the runtime:

1. Calls `dispatch(session, { kind: 'resolved_via_save' })` → the active graph routes to `terminal{closed}`; the dispatcher stamps `session.status = 'closed'`.
2. Tears down the BrowserContext via `pool.closeSession(sessionId)`.
3. Returns `{ ok: true, closed: true, ... }` so the agent knows the session is finalized.

Multi-cap sessions with remaining unresolved capabilities don't auto-close — the agent must save each one. Single-cap sessions on the happy path skip the explicit `end_drive` call entirely.

## The `surface_triage_missing` Detector

Every `save_strategy` must target a surface bound to a current triage plan. Tier-agnostic — fetch, page-script, and recorded-path all flow through this gate.

`runtime/src/audit/save-strategy.ts` adds a Detector to the consolidated `saveStrategyAudit` instance:

- **Trigger**: `firstObservableUrl(strategy)` is non-null AND either (a) `session.surfaceMap` doesn't bind that URL to a surface, or (b) the bound surface has no `triage_plans_by_surface[<label>]` plan in the platform logbook for the capability being saved.
- **Rejection prose**: tells the agent which surfaces are known and instructs them to `submit_triage_plan` for the targeted surface before retrying. Lists the target URL canonically.

The check composes into the existing audit (one rejection envelope, one token, one set of args) — it's a `Detector` spec on the existing instance, not a standalone gate file. See `runtime/docs/gates.md` §"The Audit class" for the consolidation pattern. The "deliberate ownership" the prior `recorded_path_in_triage` block protected is now subsumed by the justified verdict in the per-surface plan.

## Architecture: PhaseSpec + Graph are the primitives

```ts
// Phase behavior — what tools admit, how the round counter ticks. Phases are
// reused across graphs (drive lives in both discover and map); per-graph
// variation lives in GraphConfig, not in the PhaseSpec.
interface PhaseSpec {
  readonly name: SessionPhase;
  readonly allowedTools: ReadonlySet<string>;
  readonly allowedToolsWhenExhausted: ReadonlySet<string>;

  onEnter(
    session: Session,
    ctx: { config: DaemonConfig; graphConfig: GraphConfig; event: PhaseEvent | null },
  ): void;
  checkAdmissibility(
    toolName: string,
    session: Session,
    graphConfig: GraphConfig,
  ): AdmissibilityResult;
  exhaustedPrefix(session: Session): string;
}

// Graph topology — which phases exist, how transitions wire, what knobs the
// graph turns on. Graphs are data, not code.
interface Graph {
  readonly name: GraphName; // 'discover' | 'map' | 'execute'
  readonly entryPhase: SessionPhase;
  readonly nodes: ReadonlySet<SessionPhase>;
  readonly transitions: ReadonlyArray<{
    from: SessionPhase;
    on: PhaseEventKind;
    to: SessionPhase | TerminalNode; // { kind: 'terminal'; status: SessionStatus }
    when?: (session: Session, payload: unknown) => boolean;
  }>;
  readonly config: GraphConfig;
}
```

Each phase exports its `PhaseSpec` from `runtime/src/session-phase/phases/{drive,triage,lift,execute}.ts`. Each graph exports its `Graph` literal from `runtime/src/session-phase/graphs/{discover,map,execute}.ts`. Adding or modifying a tool's phase membership = a one-line edit to that phase's `allowedTools` set (or to the shared catalogs in `tool-catalog.ts`). No cross-cutting concerns.

The **graphs index** (`graphs/index.ts`) maps `GraphName` → `Graph`. The **registry** (`registry.ts`) resolves the active graph from `session.graph`, exposes `currentPhase`, `currentSpec`, `currentGraph`, `graphConfig`, and `checkAdmissibility`. The **state machine** (`state-machine.ts`) is a tiny dispatcher that looks up the active graph's transition table, runs guards, applies the destination (phase + onEnter, or terminal + `session.status`), and mutates `session.phase` — the single writer.

## Adding a new phase, graph, or tool

To add a new tool to an existing phase: edit `tool-catalog.ts`, drop the tool name into the appropriate set (`DRIVE_ACTIVE`, `READ_ONLY_DIAGNOSTIC`, `TRIAGE_AND_LIFT_WRITE`, `LIFT_RE_ACTIVE`, or `UNIVERSAL_TOOLS`). The phase modules pick it up automatically via the `unionSets` calls.

To add a new phase: create `phases/<name>.ts` exporting a `PhaseSpec`, register it in `registry.ts`'s `PHASES` table, add `<name>` to the `SessionPhase` union in `types.ts`, add transition entries in any graph that should reach the new phase, add a `PhaseEventKind` to `types.ts` if a new event drives the transition. Document the new phase in this file and (briefly) in `runtime/SKILL.md`.

To add a new graph: create `graphs/<name>.ts` exporting a `Graph` literal, add it to `graphs/index.ts`'s `GRAPHS` map, add `<name>` to the `GraphName` union in `types.ts`. The MCP `start_session` schema's `graph` enum picks it up via the type. Snapshot a Mermaid render via the dumper in `dump.ts` and add invariant tests to `test/graph-invariants.test.js`.

## Critical files

- `runtime/src/session-phase/types.ts` — `PhaseSpec`, `Graph`, `GraphConfig`, `PhaseEvent`, `TerminalNode`, error classes
- `runtime/src/session-phase/graphs/{index,discover,map,execute}.ts` — graph definitions + the `GRAPHS` map
- `runtime/src/session-phase/guards/rediscover.ts` — failure-gate predicate for the execute graph
- `runtime/src/session-phase/registry.ts` — `currentGraph`, `currentPhase`, `graphConfig`, accessor + admissibility helpers
- `runtime/src/session-phase/state-machine.ts` — `dispatch`, `forceTransition`; the only writers of `session.phase` and `session.status`
- `runtime/src/session-phase/middleware.ts` — `assertToolAdmissibleBySessionId`, `tickPhaseCounter`
- `runtime/src/session-phase/tool-catalog.ts` — single source of truth for tool categories
- `runtime/src/session-phase/phases/{drive,triage,lift,execute}.ts` — per-phase `PhaseSpec` modules
- `runtime/src/session-phase/dump.ts` — Mermaid renderer for any Graph
- `runtime/src/tools/submit-triage-plan.ts` — the triage-exit tool
- `runtime/src/audit/save-strategy.ts` — `surfaceTriageMissingDetector`
- `runtime/src/working-dir/schema.ts` — `TriagePlan` type + logbook fields
- `runtime/src/config/handler.ts` — `drive.max_rounds`, `triage.max_rounds`, `lift.max_rounds`

## Cross-references

- Agent-facing compact reference: `runtime/SKILL.md` §"Sessions move through phases"
- Agent-facing full reference: `runtime/REFERENCE.md#triage-phase`
- Per-call lifecycle (end_drive→end_drive teardown): `runtime/docs/run-lifecycle.md`
- Audit composition pattern (where `surfaceTriageMissingDetector` plugs in): `runtime/docs/gates.md`
- Checkpoint family (`triage_plan` is a kind here): `runtime/docs/checkpoints.md`
