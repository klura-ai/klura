---
name: klura
description: 'Turn any website into an API for your AI agent. Discovers how sites work, saves reusable strategies, executes them.'
emoji: 🌱
---

# Klura

Klura lets you automate any website. When the user asks you to do something on a site, klura either runs a previously-saved strategy (warm path) or helps you drive the browser to discover how the site works and save the strategy for next time (fresh path). **The runtime does the heavy lifting** — auto-executes known strategies on start, auto-saves new ones at close by joining what you typed to what the server received. Your job: drive the browser to complete the user's task.

## Happy path

1. `list_platform_skills()` — see what klura already knows. Free, always first. If a capability you need is there with a `discovery_artifact` attached, prior sessions left you context — read it.
2. `start_session(url, { platform, capability, args })` — open a session. Pass the slug for the capability you're about to discover or run, and a map of the user-supplied literals you'll type (e.g. `{text: "hello", recipient: "Bob"}`). If klura already has a complete strategy for that `{platform, capability}`, the runtime **auto-runs it** in-session and the response carries `executed: true`, an `_hint` line, and `execute_result` with the body. **Read the `_hint` first.** When `executed: true` and `execute_result.body.ok === true`, the strategy completed — call `end_drive` and you're done. Do NOT re-drive the UI manually to "verify" just because the screenshot looks off: either trust the result, or if the outcome is genuinely wrong (`body.ok` is false, or your verification shows a stale/bad page) the saved strategy has a bug — fix it via `patch_step` / `save_strategy`, don't ad-hoc-redo the flow.
3. If not auto-executed: drive the browser. Call `perform_action` to click/type/submit until the task is accomplished. Type the user's literals verbatim — the runtime correlates them to captured traffic.
4. `end_drive(session_id, platform)` — klura auto-derives a `fetch` or `page-script` strategy from the captured request that carried your typed literal, auto-synthesizes a `recorded-path` from your action history, and persists a discovery artifact for the next run. Response's `artifacts_updated` and `auto_synthesized` fields report what landed.

That's it. The runtime handles capability + args → strategy; you handle the browser interaction.

**Definition of klura-task-complete:** `save_strategy` returned `ok: true`. A user-visible action (the message sent through the viewer, the form submitted, etc.) is not enough — without a saved strategy the next run starts from zero. If you're tempted to end your turn telling the user "done" while a session is in TRIAGE or LIFT with no save, re-read the `[klura obligation]` block on the latest tool response.

## When the goal is ambiguous about _who_ or _what_

If the user's goal names a target ambiguously (first-name-only person, unqualified product, unspecified account), ask once and end the turn text-only — no tool calls in the same turn, or the harness won't forward the question. Carve-out for overwhelmingly obvious referents (mononyms, single-referent surnames in context).

## When the user names a target by name

When the user names a target by a human-facing label, expect a lookup step — the pre-save audit enumerates literals in your strategy and requires you to classify each as `static` / `caller_input:<param>` / `prereq_output:<binds>` / `single_entity`. See `klura://reference#save-strategy-audit` and `klura://reference#capability-prereq`.

Every `save_strategy` also goes through a `user_confirmation` audit Classifier. The first call returns `audit_token` + an `items.user_confirmation.prompt_for_user` field — relay that prose VERBATIM to the user as your text turn, wait for their fresh yes/no about THIS save, and retry with `audit_answers.user_confirmation: {user_decision: "approve" | "reject", user_quote: "<their fresh reply>"}`. **Do NOT reuse the user's reply to a prior `ack_checkpoint` (triage_plan, surface_changed) or any earlier turn** — the runtime cannot detect recycled replies; freshness is on the agent. Token binds to the whole strategy hash, so any structural change forces a fresh ask. A `save_strategy_rejected` is a hard reject with a retry path, not a "save in flight" notice; ending the turn after the first rejection persists nothing. Full audit-response handling: `klura://reference#reverse-engineer-playbook` (After save_strategy responds).

When a caller-input param has a constrained shape, declare `notes.params.X.kind` — recognized kinds are listed in the live catalog (`klura://reference#save-strategy-schema`, also surfaced inline at lift entry). For `enum` also provide `observed_values: [{value, label}, ...]` grounded in captured click→XHR correlations (or `source: "capability:list_<entity>"` for dynamic enums). See `klura://reference#enum-params`.

## Prereq kinds

Strategies chain prereqs via `prerequisites: [{kind, ...}]`. Recognized kinds: `js-eval`, `page-extract`, `fetch-extract`, `capability`, `tag`, `browser`, `cached`. Per-kind full field schemas surface dynamically on the `submit_triage_plan` ok-response (under `save_strategy_schema`) and inline on every `save_strategy` shape rejection — derived live from the canonical Zod validators so every required field is enumerated. Full catalog on demand: `klura://reference#save-strategy-schema`.

The `tag` kind is worth a callout — capabilities advertise tags via top-level `provides: ["<tag>"]`. The canonical tag is `auth`: save your login flow with `provides: ["auth"]`, dependents chain via `{kind: "tag", tag: "auth"}`. Multi-method auth (password / OAuth / SSO) coexist as separate capabilities. When you save an auth-gated fetch / page-script after an auth-providing capability is on disk, the runtime auto-injects the tag prereq for you.

## Checkpoints (runtime-emitted) and Interruptions (agent-detected)

A tool response with `_checkpoint: {kind, prompt?, viewer_url?, checkpoint_token}` means the runtime paused at a known lifecycle boundary — read the `prompt` and ack via `ack_checkpoint`. The `ack_checkpoint` tool description lists every kind and the matching ack shape.

When YOU spot ambient ambiguous state (captcha, login form, 2FA prompt — NOT dismissable cookie banners), call `list_interruption_resolvers()` → pick a resolver → `resolve_interruption({session_id, context: {reason, ...}, resolver})`. On handover, next tool call echoes `interruption_token` + ack. See `klura://reference#interrupts`.

## When the send is an encoded payload the capture doesn't explain literally

Applies equally to binary WebSocket frames, signed HTTP bodies, persisted GraphQL requests, MQTT-shaped payloads — any transport where the captured bytes aren't a literal echo of the user's input. You are a reverse engineer.

**Two paths, same goal — pick based on the shape of the unknown fields.** Agent-controllable values (strings, ids, flags the request supplies) converge via black-box iteration: capture a reference → `try_generator` → diff → refine, guided by the convergence coach. Runtime-computed values (rolling counters, HMACs, nonces, epoch counters, session-derived ids) don't converge by iteration — read the encoder directly: `set_breakpoint` at the send callsite, `get_frame_scope` + `evaluate_on_frame` to see the builder's locals, walk up the call stack. Real sites often want both. Full pattern-choice rubric: `klura://reference#re-pattern-choice`.

The toolkit composes freely across transports:

- **Map / Anchor**: `list_loaded_scripts`, `inspect_ws_frame(ws_hash, {text_contains:"<typed>"})` — `js_callstack` pins the send call site at `file:line`. Every frame carries a stable `ws_hash` content-handle. The runtime auto-upgrades stale `ws_i` references when the ring rotates (surfaces a `stale_upgrade_note` on the response), but prefer `ws_hash` for RE-loop references so the transparent upgrade doesn't fire in the first place. The RE nag auto-pins the target frame on end_drive, but you can explicit-pin with `pin_ws_frame(ws_i | ws_hash)` when you want extra frames (ack, diff target) to survive rotation.
- **Locate**: `get_js_source(file, {line})` (raw-source windowing), `search_js_source(file, pattern)` (find candidate sites by protocol literal — `"/ls_req"`, `"encodeSend"`, field names), `read_js_function(file, line)` (extract the enclosing function directly — no more guessing line ranges).
- **Probe**: `js_eval(session_id, expression)` runs against the LIVE page. Returns raw JS values; binary (ArrayBuffer/Uint8Array) comes back as hex automatically. Test hypotheses: does `window.<path>.<encode>` exist? what does it return? what's the byte length vs the captured frame? When patches need to survive page navigation (SPA reload stomps `js_eval`-installed wrappers), use `install_page_init_script` instead — runs on every fresh document before the page's own bundle.
- **Verify**: `try_generator` against the captured frame confirms byte-for-byte match on a Node-side generator; `js_eval` with your templated expression against fresh args confirms the encoder produces structurally-matching bytes with non-captured inputs.
- **Save**: `save_strategy` with the page-side expression. (The strategy shape that wires `js_eval` into a warm-executable frame is `frameFromPage` — see `klura://reference#reverse-engineer-playbook` for the schema.)
- **Handoff**: use `add_resume_pointer` for typed pointers (js_source url+line, frame_index), `add_discovery_note` for prose hints, and `save_verified_expression` for confirmed encoder expressions. All persist across sessions in the discovery artifact.

Full named-moves playbook and worked example: `klura://reference#reverse-engineer-playbook`.

## Sessions move through phases: drive → triage → lift → closed

A session has four phases. Tools are admissible **only in the phases listed below**; calls outside the admissible set are hard-rejected with a phase-mismatch error before the tool body runs.

1. **drive** (default) — agent driving the UI to the goal. `start_session`, `perform_action`, `get_a11y_tree`, diagnostic reads, `end_drive`. RE-active and triage-write tools are blocked here.
2. **triage** — entered when `end_drive` is called with unresolved capabilities, or auto-fired by the runtime as `surface_changed` when navigation crosses to a path-distinct URL no triage plan covers. Inspect third-party origins / scripts / cookies / request patterns; submit one plan per surface via `submit_triage_plan` ({surface_label, defense_surface, expected_tier, tier_justification (must cite a verbatim observed origin / script / cookie / URL), summary_for_user}). Tier suggestion is informational; aim T0 (fetch) → T1 (page-script) → T2 (recorded-path) in lift regardless. Default round budget: 10.
3. **lift** — entered when the `triage_plan` checkpoint approves. Full RE toolkit unlocks (`try_generator`, `set_breakpoint`, `evaluate_on_frame`, `install_page_init_script`). Save `fetch` / `page-script` / `recorded-path` against the bound surface via `save_strategy` — author the shape from the captured request you picked from `candidate_xhrs[]`. Cross-surface navigation re-fires triage. Calling `submit_triage_plan` again drops you back to triage with a fresh budget — the re-plan path when reality contradicts the prior verdict.
4. **closed** — terminal. Entered when `end_drive` is called and the close-time audit passes (declared capabilities have saves, RE work is persisted). `save_strategy` only commits the strategy file; the session stays open until you explicitly end it. Multi-capability sessions: save each capability, then `end_drive` to finalize.

`start_session` / `end_drive` are drive-only. `submit_triage_plan` is triage / lift only. RE-active tools are lift-only. `save_strategy` requires the targeted surface to be bound to a triage plan. Universal tools (`ack_checkpoint`, `list_platform_skills`, `get_platform_logbook`, `start_remote_session`, etc.) work everywhere. Per-phase budgets are configurable: `drive.max_rounds` (default 0 = unlimited), `triage.max_rounds` (default 10), `lift.max_rounds` (default 0). When a budget is hit, only the phase's exhausted-set tool (just `submit_triage_plan` in triage) admits until the next phase transition resets the counter.

See `klura://reference#triage` for the defense-surface schema, cite-validation rules, surface-keyed plans, and the `surface_changed` checkpoint contract.

## When end_drive returns `phase: "lift"`

DRIVE (Drive Real Interactions, View Endpoints) ended when you called end_drive. The response body inlines the full LIFT (Learn Interface From Traffic) playbook in its `message` field — read it. You'll find the per-capability `triage[<cap>]` block (cross-session facts), `unresolved_capabilities[]` with candidate XHRs + body previews, and the tool catalog for next moves. Quit ONLY on success (complete strategy saved) or at a runtime-injected check-in. Third close force-tears-down.

**When saving a `page-script`, declare `notes.anchor_type`** so triage + revisit know whether the strategy is durable: `"module"` (calls a module the page also calls), `"protocol"` (builds a wire-level payload + hands it to a durable sender), or `"dom"` (drives the UI from inside `js_eval` OR walks DOM/fiber). UI-replay `dom` is a legitimate save when the send code path is closure-locked and no module export is reachable — set input → dispatch event → click submit → poll DOM, all in one `js_eval`. Unclassified saves default to `"unknown"` and are treated as fragile. See `klura://reference#page-script-anchors`.

If a tool response carries `_checkpoint`, ack it via `ack_checkpoint` (see Checkpoints below). On `start_session` / `list_platform_skills` you may see `re_continuation_available: true` when a prior session left partial progress — ask the user whether to continue the lift or accept recorded-path.

**Close-session audit.** `end_drive` runs a consolidated audit. Two checks: `capability_declaration_required` (refuses close when session typed/submitted but no capability was declared — call `declare_capability` before closing) and `re_persistence` (refuses close when ≥2 RE tool calls landed with zero persistence calls — persist via `save_verified_expression` / `add_discovery_note` / `add_resume_pointer` and retry, or echo `audit_token` + `audit_answers: {re_persistence: {acknowledge_no_progress: true}}`). See `klura://reference#end-drive-audit`.

## Discovery escape hatches (read only when you need them)

- **Authentication gate** (login wall, 2FA, re-auth): see `runtime/docs/credentials.md`. For simple flows such as 2FA, tell the user the code and wait for the answer. For flows with passwords, use secret resolvers first. If not available, use remote viewer otherwise.
- **CAPTCHA / click-through / mid-flow human step**: declare `strategy.interrupts[]` entries — `{at: "pre_execution"|"between_steps", observe?: {kind, selector}, handler: {kind: "user-assist", bind_from?, bind_as?}}`. `observe` makes it conditional so the hot path stays human-free. `klura://reference#interrupts`.
- **Execute returned `needs_reauth` / `needs_rediscovery`**: `klura://reference#execute-errors-classification-and-recovery`.
- **Execute rejected with `rediscover_required`** (saved strategy's rolling success rate fell below the rediscover threshold): `klura://reference#rediscover-gate`.
- **Warm-run execute paused with `_checkpoint` where `kind === "recorded_step_failed"`**: `klura://reference#step-healing-response-format` — inspect, `patch_step` (takes `step_id`, the slug on the recorded-path step; see `klura://reference#recorded-path-schema`), `resume_execution`.
- **WebSocket-carried writes, binary envelopes, multi-field encoders**: `klura://reference#reverse-engineer-playbook` — `inspect_ws_frame`, `try_generator`, `get_send_encoder`, `get_js_source`, and the cross-run `discovery_artifact` mechanism.
- **Source-level debugger** (breakpoint at the send call site, pause, read the closure): `klura://reference#debugger-surface` — `set_breakpoint`, `wait_for_pause`, `get_frame_scope`, `evaluate_on_frame`. Use when the bundle is too minified to hand-read; the pause exposes the encoder in scope directly.
- **Cross-run memory** (resume pointers, handoff blob, iteration progress): `klura://reference#discovery-artifact`.
- **Explicit `save_strategy`** (the escape hatch for shapes the auto-save can't handle — hand-crafted WS generators, non-standard prereq chains): `klura://reference#strategy-schemas-overview`.
- **Full strategy schemas + validator rules**: `klura://reference#strategy-schemas-overview`.

## Tool list (happy path)

- `list_platform_skills()` — list saved skills for all platforms; inlines `discovery_artifact` on any capability that has one
- `start_session(url, { platform?, capability?, args?, policy?, graph?, identity? })` — open browser; passes `platform` for cookie-jar load; passes `{capability, args}` to enable auto-execute + auto-save; `policy` is create-only permanent platform policy bootstrap. The `start_session` tool description lists the live graph modes and behavior from the canonical runtime constant. Pass `identity: "work"` / `"personal"` to isolate cookies + profile per account on the same platform; default-when-omitted is the historical platform-only path. See `klura://reference#graphs`, `klura://reference#platform-surface-map`, `klura://reference#identities`.
  - `start_session` response may include `platform_map: {last_scanned, observed_capabilities[], url_graph_size, forms_seen, hint?}` — compact teaser of the cross-session logbook from prior `graph: "map"` sessions. Full detail via `get_platform_logbook`. See `klura://reference#platform-surface-map`.
- `perform_action(session_id, action, selector, value?, {page?})` — drive the browser: `click`, `type`, `fill_editor`, `select`, `mouse_click` (`"x,y"`), `key_press`, `scroll`, `navigate`. When a click opens a popup, `target=_blank` tab, or OAuth consent window, it shows up in the response's `subPages[]` as `popup-1`, `popup-2`, ... — pass `page: "popup-1"` to act on that popup. Default: `"main"`. See `klura://reference#popups`.
- `end_drive(session_id, platform)` — save cookies, auto-derive strategies, write discovery artifact
- `get_screenshot(session_id)` — PNG of the current page
- `get_a11y_tree(session_id, {page?})` — paginated untrimmed a11y tree, only when the trimmed tree returned by `perform_action` was insufficient
- `start_session(url, { graph: "execute", platform, capability, args, identity? })` — explicit execute. Auto-execute at any `start_session` (when a complete saved strategy matches the declared capability) is the default; the `graph: "execute"` shape is for cases where you want the saved-strategy invocation to be the whole session. On stale-strategy failure the FSM auto-falls into triage so the agent can re-plan and re-lift. Stable-lookup capabilities (`search_contact`, `whoami`) can declare `cache: {ttl: "5m"}` on the strategy body to memoize results within a daemon's lifetime — only set this on reads, never on writes. See `klura://reference#capability-cache`.

## Escape-hatch tools

The full tool catalog is available via the MCP tool list — read each tool's MCP description when you need it. Categories: network/DOM inspection, RE toolkit (ws frames, generators, debugger), discovery-artifact persistence, recorded-path patching, remote viewer, secret resolvers, listeners, config.

Tool-name index for MCP sync: `find_in_ws_frame`, `trigger_reference_send`, `try_generator_in_page`, `get_action_history`, `get_attribute`, `find_in_page`, `get_strategy_health`, `explain_ws_frame_structure`, `remove_page_init_script`, `remove_breakpoint`, `list_breakpoints`, `get_strategy`, `get_strategy_events`, `stop_remote_session`, `wait_for_remote`, `start_listener`, `stop_listener`, `get_events`, `get_config`, `get_secret`.

**If you can't fully lift a capability**, save only when complete — otherwise fold to recorded-path or keep iterating. **If the user explicitly tells you not to reverse-engineer a site** (ToS, compliance, personal preference), surface this CLI one-liner so they can make it permanent: `klura policy set <platform> <capability>.max_strategy_tier recorded-path --reason "<user reason>"`. You cannot write user policy yourself — the CLI is the trust path.

## Principles

- **Type user literals verbatim.** The runtime auto-joins what you type to what the server received. If you abbreviate or paraphrase, auto-save can't template the arg — and at end_drive the runtime attaches a `typed_text_drift` save_warning naming the missed values, so the next run surfaces the drift. Save yourself the round: type the value the user gave.
- **Declare the capability up front** via `start_session({capability, args})` or `declare_capability`. Without declaration AND with write-shape actions (type / fill / submit) observed, `end_drive` refuses to tear down with `phase: "capability_declaration_required"` — auto-save needs a slug. The capability name is usually the user's verb phrase (`send_message`, `check_order_status`, `list_invoices`).
- **Never invent endpoints from memory.** Every URL in a saved strategy has to trace back to the session's captured traffic. The save-time guards enforce this; auto-save is grounded in captures by construction.
- **Recorded-path locators must identify ONE element.** A11y locators (`{role, name}`) are the primary anchor — labels are the most durable. CSS is the fallback. A bare element-name css (`"button"`, `"input"`, `"div"`) or attribute-only selector (`"[type=\"submit\"]"`) without an a11y backup is rejected at save — there's nothing stable to match against when the UI grows. See `klura://reference#recorded-path-schema`.
- **Mutating saves must verify the side effect.** Every mutating-shaped strategy (POST/PUT/PATCH/DELETE on fetch/page-script, recorded-path with type+submit, page-script `.publish()` / `.send()`) trips a save-time warning that demands a verification approach. status:200 doesn't prove the action landed on the right entity. Ack inline as `notes.save_warnings_acked: [{kind: "mutating_verification_required", reason: "<shape tag + structural anchor>"}]` and match the verification durability to `notes.anchor_type` (module/protocol → response.extract or page-global readback; dom → dom-poll is fine). See `klura://reference#self-verifying-strategies`.
- **Strategy tier preference.** `fetch` (optimal when achievable — no browser, fastest; for simple/legacy sites and unsigned APIs; use `generated.frame` for byte-spliced binary envelopes) → `page-script` (realistic default for signed / anti-bot / rotating-token sites — the page's own JS runs the signer every call, so you don't have to lift it; anchor via `notes.anchor_type: "module" | "protocol"`, avoid `"dom"`) → `recorded-path` (UI-replay, last resort). Only complete, runnable strategies land on disk; iterative progress goes to the capability's discovery_artifact via `save_verified_expression` / `add_discovery_note` / `add_resume_pointer` and to the platform logbook via `record_observed_capability`. On end_drive with no complete save, auto-synth drops a recorded-path from your action history — if you clicked a dismiss button during discovery (cookie banner, consent modal), save your own recorded-path with those clicks marked `optional: true` instead. See `klura://reference#strategy-schemas-overview` and `klura://reference#recorded-path-schema`.

  Per-tier required + optional fields surface dynamically at lift entry — the `submit_triage_plan` ok-response carries a `save_strategy_schema` block scoped to your declared `expected_tier`, and every `save_strategy` shape rejection inlines the same catalog. Live-rendered from the canonical Zod validators; full set on demand at `klura://reference#save-strategy-schema`.

- **Scan the network log by the literal you just typed.** After a submit, `get_network_log({text_contains: "<your literal>"})` jumps straight to the matching request in one call — skip the unfiltered summary page. Full modes and filters: `klura://reference#network-log-discovery-workflow`.
- **Jot down sibling capabilities you saw but didn't lift.** Call `record_observed_capability({platform, name, evidence, why_not_lifted})` for endpoints you're not lifting this run — the pre-save audit's observed-siblings axis will otherwise force you to classify each unlifted endpoint as `recorded` or `not_worth_recording:<reason>`. Full schema: `klura://reference#observed-capabilities`.
- **Describe captured values by structure, not by pasting literals.** In `record_observed_capability` evidence / hypothesis, in discovery notes, and in verified-expression notes, describe _what_ the endpoint returns ("24-char hex ObjectId", "paginated list of order ids"), never paste the sample bytes — a captured literal is scoped to the discoverer and makes the observation un-portable. Only `notes.params[].example` accepts literal values (those are promised to be user-typed) and is checked mechanically.
- **When reverse-engineering binary WebSockets, walk the rotating-field checklist.** After iteration 1 of the `inspect_ws_frame` starter returns `ok:true`, scan the captured payload for field names that imply per-request rotation — `timestamp`, `epoch_id`, `otid`, `nonce`, `sequence`, `request_id`, `client_clock`, `message_id`, `signed_request`, anything `*_id` whose value would change across captures — and template each one before replay. Full checklist + common derivations: `klura://reference#reverse-engineer-playbook`.
- **Changing klura settings.** If the user asks for a setting change ("use stealth playwright", "raise warm-pool size", "show the browser"), call `describe_config` once to see valid paths and values, then `configure({path, value})`. If the response says `runtime_restart_required: true`, relay `suggested_user_prompt` and wait for their yes/no before `restart_runtime`. See `klura://reference#configure`.
- **Respect budgets.** Tool responses are capped at ~25KB. Details surface on demand via follow-up tools (`get_network_log {i, full:true}`, `get_discovery_artifact_field`, etc.). When a response says `_elided_fields: [...]`, that names what to fetch.

## When to call klura (and when not)

- Website automation where the agent needs persistent strategy reuse across sessions: **yes**.
- One-shot ephemeral scraping that doesn't need to be repeatable: use a direct MCP browser tool instead.
- CLI / API endpoints the agent could just `curl`: no browser needed.
