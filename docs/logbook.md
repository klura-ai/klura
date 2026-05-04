# Per-platform logbook

The logbook is klura's cross-session memory for a single platform. It records what capabilities have been attempted, how they fared, what the data looks like across sessions, and how recently the agent last touched the platform. It backs the inline `triage[<cap>]` block on the LIFT handoff (current_tier + prior_attempts + discovery_artifact), `get_platform_logbook` (pull-on-demand cross-session derived signals), the revisit prompt on warm execute, and the `lift_mode` decision path.

For overall framing and the lifecycle that produces it, see `../ARCHITECTURE.md` and [run-lifecycle.md](run-lifecycle.md). This file documents the logbook in detail: on-disk layout, schema, writers, readers, and what each consumer uses it for.

## Why it exists

Saved strategies (`~/.klura/skills/<platform>/{fetch,scripts,paths}/<capability>.json`) capture **what works** for a capability. The logbook (under `~/.klura/workdir/<platform>/`) captures **everything else** — every attempt, every outcome, every observed field shape, every session's contribution to the platform's accumulated knowledge. Without it:

- The end_drive RE handoff couldn't surface prior_attempts; the inline triage bundle would only carry current_tier.
- The revisit prompt couldn't ask "we tried this 3 times, want to try again?"
- `get_platform_logbook` would return nothing, so the agent would have to re-derive cross-session signals from zero every session.
- Newly-arrived agents would re-discover from zero every session even when the platform is well-trodden.

Strategies say "here's a working call." The logbook says "here's everything we've learned, including what didn't work."

## On-disk layout

```
~/.klura/workdir/<platform>/
├── logbook.json              # platform summary (this file)
├── sessions/<session_id>/    # raw archive of every closed session
│   ├── meta.json
│   ├── captures.json
│   ├── actions.json
│   ├── tool_trace.json
│   ├── storage-state.json
│   └── bundles/<sha>.js
└── derived/
    ├── field-stability.json   # per-endpoint per-field classification
    ├── bundle-history.json    # JS bundle SHA drift across sessions
    ├── signer-history.json    # named signer functions seen
    └── known-modules.json     # in-page module / global names referenced
                               # by saved strategies (lexical extract from
                               # require("X") / window.X / globalThis.X)
```

`logbook.json` is the fast-to-read derived rollup; session archives are the source of truth. The logbook gets recomputed/updated on every `end_drive`. Derived signals are recomputed lazily from session archives and cached.

## logbook.json schema

```ts
interface PlatformLogbook {
  schema_version: 1;
  platform: string;
  created_at: string;
  updated_at: string;
  sessions_total: number;
  per_capability: Record<string, CapabilityLogbookEntry>;
  platform_wide: {
    signer_functions_seen: Array<{
      name: string;
      first_seen: string;
      last_seen: string;
      sessions: number;
    }>;
    bundle_drift_events: Array<{
      at: string;
      bundle_url: string;
      prior_sha: string;
      new_sha: string;
    }>;
  };
  observed_capabilities: Array<{
    name: string;
    evidence: { source: string; [k: string]: unknown };
    why_not_lifted: string;
    hypothesis?: string;
    first_observed_at: string;
    last_observed_at: string;
    observed_in_sessions: number;
  }>;
}

interface CapabilityLogbookEntry {
  sessions_contributed: number;
  last_session_at: string;
  last_session_id: string;
  lift_attempts: Array<{
    session_id: string;
    attempted_at: string;
    outcome:
      | 'fetch_saved'
      | 'page_script_saved'
      | 'recorded_path_saved'
      | 'no_save'
      | 'user_deferred'
      | 'error';
    rounds_spent: number;
    notes?: string;
  }>;
  strategy_events: Array<{
    at: string; // ISO timestamp
    strategy: string; // 'fetch' | 'page-script' | 'recorded-path'
    kind:
      | 'discovered'
      | 'rediscovered'
      | 'tier_demote'
      | 'archived'
      | 'unarchived'
      | 'patched'
      | 'healed';
    detail?: string;
  }>;
  current_tier: 'fetch' | 'page-script' | 'recorded-path' | 'none';
  data_sufficiency: {
    captures_of_target_endpoint: number;
    field_stability_confidence: 'low' | 'medium' | 'high';
    known_rotating_fields: string[];
    known_stable_fields: string[];
    ambiguous_fields: string[];
  };
  last_lift_attempt_at?: string;
  days_since_last_attempt?: number;
  sessions_since_last_attempt?: number;
}
```

## `url_graph`

The logbook accretes a per-platform URL graph across sessions. The runtime folds `dom_navigation` events into the graph at close.

```ts
url_graph: {
  nodes: Array<{
    url: string;
    title?: string;
    first_visited: string;
    last_visited: string;
    session_count: number;
  }>;
  edges: Array<{
    from: string;
    to: string;
    via?: 'nav' | 'click' | 'submit';
  }>;
}
```

**Dedup rule.** URLs are normalized by `normalizeUrlForGraph` in `runtime/src/working-dir/url-graph.ts` before they become node keys. Normalization strips session-ish query parameters (name allowlist: `token`, `sid`, `sess`, `session`, `auth`, `csrf`, `nonce`, `state`, `t`, `ts`, `timestamp`) and parameters whose values match opaque-id shapes (UUID, long hex ≥ 12, url-safe token ≥ 24 chars, JWT). Remaining query keys are sorted so two visits with reordered params fold onto one node. `session_count` increments once per distinct session that lands on the normalized URL.

**Edge semantics.** `via` records how the agent moved between nodes:

| `via`    | Source                                                                  |
| -------- | ----------------------------------------------------------------------- |
| `nav`    | Direct navigation (location change without an intermediate user action) |
| `click`  | Navigation immediately following a `perform_action({action: "click"})`  |
| `submit` | Navigation immediately following a form submission                      |

Edges dedup on `(from, to, via)`.

## `forms_seen`

Cross-session DOM form inventory. The logbook accretes form observations as `dom_form_observed` events flow in.

```ts
forms_seen: Array<{
  url: string; // normalized page URL where the form was observed
  action: string; // normalized form action attribute
  method: string; // GET / POST / ...
  fields: Array<{ name: string; type: string; required?: boolean }>;
  first_seen: string;
  last_seen: string;
}>;
```

**Dedup key.** `(normalized url, normalized action, method)`. Same form observed across N sessions collapses to one entry; `last_seen` advances and `fields` accretes — the field union grows across observations and the latest `type` wins on conflict.

## The map graph

`start_session(url, {graph: "map"})` opens a session whose purpose is to enrich the platform map rather than land a strategy. The flow:

1. `start_session({platform, graph: "map"})` — agent receives a session id; if a logbook already exists, the response carries a `platform_map` summary (top observed capabilities, `url_graph_size`, `forms_seen` count).
2. Drive exploration with `perform_action({action: "navigate"})`, clicks, and reads. Mutating clicks (POST/PUT/DELETE-bound, destructive-text matches like `buy`, `order`, `pay`, `delete`, `submit`, `confirm`) raise an `action_consent_required` checkpoint that the agent must ack before the click dispatches.
3. For each capability the agent spots in network or DOM, call `record_observed_capability({platform, name, evidence, why_not_lifted, hypothesis?})`.
4. `end_drive` flushes — `url_graph` and `forms_seen` accretions land in the logbook, `observed_capabilities` is updated, and **auto-synth is skipped** (no recorded-path falls out of the action history; map clicks are probes, not replay material).

The map graph's `GraphConfig` turns these knobs on:

- `gateMutatingActions: true` — emit the per-(action, selector) consent checkpoint.
- `skipAutoSynth: true` — skip recorded-path auto-synth at `end_drive`.
- `inferObservedCapabilitiesAtClose: true` — derive `observed_capabilities` from the runtime-collected URL graph + forms when the agent didn't call `record_observed_capability` directly.
- `skipDeclarationGuard: true` — closing without a declared capability is allowed (mapping has no goal capability).
- `rePersistenceThreshold: {reCalls: 1, actions: 5}` — fires the re-persistence audit when a session did ≥5 `perform_action`s with zero persistence calls.

The `re_persistence_gate` blocks `end_drive` when the threshold fires AND the session persisted nothing — no `record_observed_capability`, no `save_verified_expression`, no `add_discovery_note`, no `add_resume_pointer`. Escape: persist at least one record, or retry with the server-minted `acknowledge_no_progress` token from the rejection.

For the full schema, the `platform_map` teaser shape on `start_session`, and worked examples, see [klura://reference#platform-surface-map](../REFERENCE.md#platform-surface-map). For the FSM topology and per-graph `GraphConfig` reference, see [session-phases.md](session-phases.md).

## Hard validation on read

`isPlatformLogbook` and `isSessionArchive` validate shape on every read. For now, on-disk drift is handled by **discarding and rebuilding** rather than tolerant migration — a logbook that doesn't match the current schema is treated as missing and re-derived from session archives on the next close.

## Writers

The only writer is `end_drive`, via the capture-event adapter in `runtime/src/index.ts` that reshapes live session state into a `CaptureEvent[]` stream. The working-dir module (`runtime/src/working-dir/`) consumes that stream — it has zero dependency on runtime Session / pool / driver / MCP types. The asymmetry is deliberate: the adapter knows about both layers, the working-dir module doesn't.

Per close, the adapter emits:

- One `session_meta` event with the session id, capability, args, outcome, ended_at, optional prose notes.
- N `http_request` events (every captured request).
- N `ws_frame` events (every captured WS frame, with optional callstack).
- N `perform_action` events (every UI action).
- N `tool_call` events (the tool-call ledger, args digested for PII).
- N `bundle_seen` events (every JS bundle the session loaded; actual bytes archived in `bundles/<sha>.js` content-addressably).
- One `storage_state` event (cookies + localStorage at close).
- One `lift_attempt` event (outcome + rounds spent).

The working-dir module partitions the stream into the session archive, updates `logbook.json` (per-capability counters, lift_attempts ledger, recency stats), and recomputes derived signals.

### Strategy events

Strategy life-cycle events — `discovered`, `rediscovered`, `tier_demote`, `archived`, `unarchived`, `patched`, `healed` — are appended to the capability's `strategy_events[]` by the runtime as it mutates saved strategies on disk. Producers:

- `saveStrategy` — writes `discovered` on first save, `rediscovered` on overwrite.
- `demoteFetchToPageScript` — writes `tier_demote` when Node-fire fails persistently.
- `archiveStrategy` / `unarchiveStrategy` — writes `archived` / `unarchived`.
- `patchStep` — writes `patched` after in-place step edits.
- `markHealed` — writes `healed` when a strategy recovers.

The agent reads these via the `get_strategy_events` MCP tool (see Readers below) and the `klura history <platform>` CLI. Entries are append-only; consumers sort by `at` descending and cap at the requested limit.

## Readers

Three agent-facing tools read the logbook:

| Tool | What it returns |
| --- | --- |
| `get_platform_logbook({platform})` | The full `PlatformLogbook` — counters, lift_attempts, data_sufficiency for every capability. Useful when the agent wants to scan the whole platform's history. |
| `get_strategy_events({platform, capability?, limit?})` | Most-recent-first slice of `strategy_events[]` across the platform (or narrowed to one capability). Useful for "what changed about this skill lately?" — discoveries, demotions, heals. |
| `end_drive` RE handoff | For each unresolved capability, inlines `triage[<cap>]: { current_tier, prior_attempts, discovery_artifact? }` — cross-session facts only, no verdicts. The LLM reads the raw captures + `get_platform_logbook` + the artifact and decides whether to lift. Detail: `klura://reference#triage-protocol`. |
| `start_session(...)` | When auto-executing a warm strategy that is below the LIFT threshold AND the logbook shows ≤ N prior failed attempts, returns `revisit_prompt` so the agent can ask the user whether to re-attempt the lift. |

Internal readers:

- `end_drive`'s LIFT handoff: inlines the minimal triage bundle for every unresolved capability. When a checkpoint handler auto-resolves the `triage_plan` kind (no human in the loop), the agent acts directly on the bundle + captures + logbook without a user round-trip.

## Relation to other on-disk state

| State | Owner | Lifetime | Purpose |
| --- | --- | --- | --- |
| Saved strategy (`<subdir>/<capability>.json`) | LLM (via `save_strategy`) or runtime (via graduation / close-synth) | Permanent until re-saved or reset | What works |
| `policy.json` | User (via CLI) | Permanent | What's allowed |
| `working/logbook.json` | Runtime (via end_drive adapter) | Recomputed on every close | What's been tried + observed |
| `working/health.json` | Runtime (per execute + heal) | Persistent; wiped by `clearSkills` | Per-strategy status (healthy / degraded / broken) |
| `working/artifacts/<capability>.{json,bin}` | Agent (via discovery tools) | Persistent across sessions | Cross-run resume pointers + verified expressions |
| `working/sessions/<sid>/` | Runtime | Permanent | Raw history; source of truth for derived signals |
| `working/derived/*.json` | Runtime (lazy, from archives) | Recomputed when stale | Cached cross-session views |

The logbook is the readable summary. Session archives are the audit trail.

## What the logbook does NOT do

- It does not gate execution. `execute()` reads policy + saved strategies; the logbook is advisory context for the agent and the triage flow.
- It does not store strategy implementations. Those live in the strategy JSON files.
- It does not replace the discovery artifact (the per-capability handoff blob). Artifacts carry resume pointers and verified expressions; the logbook carries cross-session counters and outcomes.
- It does not auto-clean. Session archives accumulate; cleanup is a future concern (likely user-CLI-driven).
