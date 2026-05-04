# Discovery

Discovery is not an execution strategy — it's the process of _creating_ one. The agent drives the browser; the runtime captures everything that happens underneath; together they produce a saved strategy at the highest viable tier on the first save. Recorded-path is the floor, not the default.

For the strategy shapes themselves, see [strategies.md](strategies.md). For the reverse-engineering toolkit that handles cases where captures don't explain the bytes (binary frames, signed bodies), see [reverse-engineering.md](reverse-engineering.md).

## Discovery flow

Discovery is **LLM-orchestrated** — the LLM drives exploration via multiple tool calls. There is no single `discover()` command. The runtime provides the browser; the LLM provides the reasoning. The **mandatory last step** before `save_strategy` is a tier-classification pass: after a recorded-path interaction completes, the LLM must call `get_network_log` and pick the highest viable tier based on what the intercepted traffic looks like. Defaulting to recorded-path when fetch was possible makes the LIFT metric shallow, so the discovery prompt in `runtime/SKILL.md` is explicit about this.

```
LLM: start_session("https://facebook.com")
  → runtime opens browser, intercepts network, returns a11y tree
LLM reasons: "I see a login form with username and password"
LLM: perform_action(sessionId, "type", "input[name=username]", "alice")
LLM: perform_action(sessionId, "type", "input[name=password]", "alice123")
LLM: perform_action(sessionId, "click", "button[type=submit]")
  → runtime records each step with multi-locator capture
LLM reasons: "Logged in. I see a chat sidebar with users."
LLM: perform_action(sessionId, "click", "text=Bob")
LLM: perform_action(sessionId, "type", "#message-input", "test")
LLM: perform_action(sessionId, "click", "#send-btn")
LLM: get_network_log(sessionId)
  → [{method: "POST", url: "/api/conversations/bob/messages", body: {text: "test"}, status: 201}]
LLM analyzes: "Clean REST API, session cookie auth, no CSRF"
LLM: save_strategy("chat-app", "send_message", {
  strategy: "fetch",
  endpoint: "POST /api/conversations/:userId/messages",
  ...
})
LLM: end_drive(sessionId)
```

The strategy type emerges from the LLM's analysis of intercepted traffic — not from trying strategies in order. The LLM always does the full browser interaction and examines what happened underneath.

## Discovery flavors — `discover` vs `map` graph

Discovery comes in two flavors, selected by the `graph` parameter at `start_session`:

- **Goal-directed discovery** (default, `graph: "discover"`). The user has a specific goal. The agent completes the task end-to-end in the browser; the runtime captures traffic; `end_drive` auto-synthesizes a strategy at the highest viable tier. Everything above this section describes the discover graph.
- **Surface mapping** (`graph: "map"`). No specific task. The agent explores a platform — landing pages, menus, forms, search, the orders / settings / account surfaces — and calls `record_observed_capability` for each capability it spots. `end_drive` skips auto-synth (map clicks aren't replay material), but the platform logbook accretes `observed_capabilities`, the URL graph, and the form inventory across sessions.

The payoff is on the next visit: `start_session` inlines a `platform_map` summary whenever the platform's logbook carries any observed capabilities, URL graph nodes, or forms. The first real task on an already-mapped platform short-circuits the cold-start "what does this site do?" phase — the agent already has the surface map.

The map graph tightens the side-effect consent gate: any `perform_action({action: "click"})` whose selector or value matches a destructive-text pattern (`/buy|order|pay|delete|submit|place\s*order|confirm/i`) raises an `action_consent_required` checkpoint. Navigation, typing, scrolling, and key presses are not gated.

For the surface-map schema, the `platform_map` teaser shape, and the `re_persistence_gate` escape contract, see [logbook.md](logbook.md#the-map-graph) and [klura://reference#platform-surface-map](../REFERENCE.md#platform-surface-map). For the full FSM topology of each graph, see [session-phases.md](session-phases.md) and [klura://reference#graphs](../REFERENCE.md#graphs).

## Tracing opaque body values back to the DOM

A captured request body routinely contains values the user didn't provide — CSRF nonces, session IDs, internal resource IDs, GraphQL node IDs. To classify correctly, the LLM has to turn each of those into a prereq that reproduces the value at execute time. Two runtime primitives make this tractable:

- **`get_attribute(sessionId, selector, attr?)`** — verify a candidate selector resolves to a non-empty value on the live page before committing it to a `page-extract` prereq. Meta tags, hidden inputs, and `data-*` attributes aren't in the a11y tree, so this is the only way to pre-validate them without a save-and-reject cycle.
- **`find_in_page(sessionId, needle, limit?)`** — scan every element in the current page for attributes or text content containing `needle`, return up to `limit` matches with a usable CSS selector (prefers `tag[name="…"]` / `#id` / `data-*` in that order). The LLM calls it with each opaque value from the captured request body; if the raw value isn't found, it retries with progressively narrower needles (numeric substrings, alphanumeric fragments, base64-decoded forms). When a match lands in a meta/hidden-input/data-attr, the selector goes straight into a `page-extract` prereq. When a _related_ shorter value matches (e.g. a numeric id embedded in a longer opaque body field), the LLM writes a generator that re-applies the deterministic transform — `generated.<name>.code` runs after prereqs and sees extracted tokens via `args.<varName>`, so extract-then-transform flows chain naturally.

This workflow is what lets discovery land at fetch on sites that don't expose their opaque IDs through any public REST endpoint. The value is always on the page — the site's own JS read it from there — it just isn't in the accessibility tree.

## Passive lookup accumulator + provenance contract

Every captured request is classified in the background by `runtime/src/response/lookup-classifier.ts` and accumulated per-session when its input shape (`q`/`query`/`name`/`slug` key + id-shaped output) suggests a name→id resolution. At save time of a write strategy, the hardcoded-id guard queries this accumulator: when the agent embedded an opaque id literal AND captured traffic returned the same literal, the rejection message includes a ready-to-paste companion-strategy skeleton (`lookup_<entity>_by_<key>`) with the correct `baseUrl`, `endpoint`, and `response.extract` path pre-filled. The agent reviews, tweaks params, saves the lookup, then rewrites the write to reference it via a `{method: "capability"}` prereq. The save-time guard enforces the contract: every `{{opaque_id}}` placeholder must trace to caller_arg / prereq / generator / explicit single-entity scope — agents cannot ship a silently-broken strategy that only works for their own discovery-time entity.

## Read-only capabilities are `fetch` strategies too

Klura's strategy taxonomy is not write-biased — `fetch` handles reads and writes symmetrically. A capability like `get_videos({username: "alice"})` discovered against `GET /api/videos?u=alice` saves as `GET /api/videos?u={{username}}` and warm-executes in ~200 ms, same as any write. The `synth_fetch` synthesizer at end_drive scans BOTH the request URL AND the request body for declared-arg literals, templating wherever a match lands.

When a capability is declared _without_ typed-literal args (pure reads like "get popular videos" or "list latest posts" where the user provides no input), `synth_fetch` does **not** auto-save. The runtime cannot reliably pick among multiple list-shaped JSON responses without mimicking the LLM's semantic judgment (which one contains the data I reported to the user?). Tuning a scorer around that turns into endless heuristic whack-a-mole. Instead, `end_drive` returns a candidate **review**:

```json
{ok: false, review_required: "data_load_candidates",
 capability: "get_user_videos",
 candidates: [
   {i: 20, method: "GET", url: "/api/post/item_list/?...",
    body_bytes: 413977, body_preview: "{\"itemList\":[{\"desc\":\"a reminder to romanticize...\"}...}",
    signals: ["list_shaped_body","body_gte_500_bytes","method_get"],
    needs_browser_session: false, score: 5},
   ...
 ]}
```

The LLM reviews the shortlist (`runtime/src/response/data-load-classifier.ts` narrows ~150 requests to ~10 plausible data-loads — same-origin, JSON, list-shaped, non-trivial body), identifies the one whose `body_preview` contains text it just surfaced to the user, and calls `save_strategy` explicitly with a `fetch` (or `page-script` when `needs_browser_session: true`) + `response.extract` rules projecting the fields it cares about. Second `end_drive` bypasses the review and tears down normally.

The classifier stays as a bounded structural heuristic under the "delegate to the LLM" exception list (see [principles.md](principles.md)): its role is candidate enumeration, not winner-picking.

## Runtime-led scaffolding

Most of the discovery loop is automatic. The agent declares intent and drives the browser; the runtime handles the join between typed literals and captured traffic.

- **Intent up front.** `start_session(url, {platform, capability, args})` or `declare_capability` names the capability slug and declares the user-supplied literals before any interaction. Without this, auto-save has no slug to key under and no param names to template — the fallback is a recorded-path-only save.
- **Auto-execute at start_session.** If a complete strategy already exists for `{platform, capability}`, `start_session` runs it in-session and returns `executed: true` with the result. The agent skips straight to `end_drive`.
- **The `execute` graph.** `start_session({graph: "execute", platform, capability, args})` makes the saved-strategy invocation the whole session. On success the FSM terminates `closed`; on stale-strategy failure (rolling success rate below `pool.rediscoverThreshold`) it auto-falls into triage so the agent can re-plan and re-lift; arg / auth / structural failures terminate `failed`. Warm benchmarks and CI checks use this graph to measure saved-strategy quality without the agent "improving" things mid-session.
- **Auto-save at end_drive.** The runtime inspects `perform_action` history for the typed literals + the intercepted network log, derives the highest viable strategy (`fetch` or `page-script`) from the request that carried the literal, and writes it. If the literal rode a binary WebSocket frame (capture didn't explain it literally), the runtime falls back to a `recorded-path` auto-synth from the action history. The response's `_diagnostics.synth` reports every pass's attempt + reason.
- **Close-session nag + user-consent rethink.** First end_drive attempt is rejected with a structured `recorded_path_only_lift_possible` nag when the session's captured traffic trips any of the eleven envelope-complexity detectors (binary WS, signed HTTP, persisted GraphQL, escaped JSON, binary body, multipart binary, high-entropy body, body-hash field, rotating field, JWT, double-submit CSRF, session cookie rotated) AND the agent didn't touch the RE toolkit. The nag carries a one-sentence `suggested_user_prompt` the agent relays verbatim and `advice` with two branches: user consents → RE lift on the same session; user declines → `set_capability_policy({max_strategy_tier: "recorded-path"})` persists the decision so future runs don't re-ask. Klura assumes a user is reachable through the host agent — `on_complexity_signal: "skip"` at start_session is the per-call opt-out. Per-capability cap so one capability's decline doesn't block sibling capabilities on the same platform.
- **Pre-action consent.** When `save_strategy` is about to fire a post-save validation call against a mutating capability, the runtime emits a `post_save_validation_consent` checkpoint. The next tool response carries `_checkpoint: {kind: "post_save_validation_consent", prompt, checkpoint_token, ...}` with Tier 1 / Tier 2 classification guidance in `prompt`. The agent classifies — Tier 1 (low-stakes — bot recipient, sandbox, idempotent) gets a one-line "About to: ..." explanation in chat; Tier 2 (destructive / irreversible / monetary / real-human recipient) requires the explanation AND a stop-and-wait confirmation from the user before the validation call fires. Three reply shapes: yes → ack via `ack_checkpoint({user_response: "yes"})`; alternative ("post in /r/abc instead") → re-plan with new args; decline → `ack_checkpoint({cancelled: true, reason})`. The runtime detects mutating args; the LLM classifies stakes (test bot vs real human is context the runtime can't see); the user decides on Tier 2. See `klura://reference#checkpoints`.
- **Decline path.** When the user declines a Tier-2 confirmation, call `add_discovery_note({session_id, capability, kind: "user_declined_send", body: reason})` to record the user's reason on the discovery artifact. The captured `perform_action` history (typing, navigation, everything before submit), `verified_expressions`, and `notes` the agent saved survive in the discovery_artifact; end_drive's auto-synth drops a recorded-path fallback from the perform_action history. The next session inlines the artifact on its LIFT handoff and picks up further along instead of from zero.
- **Cross-run memory — the discovery artifact.** Every session contributes a `discovery_artifact` per capability: resume pointers (js_source url+line, frame index), observations (what the agent saw about the site), iteration state (convergence %, last diff offset), tool-call trace, prose notes from `add_discovery_note`, and verified expressions from `save_verified_expression` (cap 8192 chars to fit full binary-protocol encoders). `list_platform_skills` and `start_session` inline the artifact; the next session's agent reads it and picks up where the last left off.
- **Cross-session resume.** When a prior session left partial RE progress (verified expressions or notes+pointers) but no higher-tier strategy landed, the next `list_platform_skills` / `start_session` response carries `discovery_artifact.re_continuation_available: true`, a one-line `re_progress_summary`, and a `suggested_user_prompt` the agent relays. User says continue → agent reads `verified_expressions` + `notes` and picks up. User says use replay → `set_capability_policy` persists the decline.
- **User-arbitration at save time.** Every `save_strategy` runs through the `user_confirmation` classifier in the save-strategy audit (`runtime/src/audit/save-strategy.ts`). The classifier composes a 2–4 sentence summary of the proposed save (tier + endpoint + prereq count + page-script anchor type / recorded-path step count) and asks the user yes/no. The agent supplies `audit_answers.user_confirmation: {user_decision: "approve" | "reject", user_quote}`; on reject the save fails and the session **stays in the current phase** (DRIVE / TRIAGE / LIFT) — phase transitions are governed by their own surfaces (`submit_triage_plan`, `end_drive`, `end_drive`), never as a side effect of a save rejection. Test harnesses register a `SaveConfirmationDecider` that auto-resolves the prompt for autonomous runs; see `runtime/src/audit/save-confirmation-decider.ts`.

## Surface fidelity

**Clarification:** this rule is about **where the agent navigates the browser**, not about **which URLs appear in captured traffic**. It is always fine — and often the goal — for a saved strategy's endpoint, `prerequisites[].url`, or any other captured URL to target an `api.*`, `svc.*`, or CDN host the canonical page's JS itself called. Those XHRs are part of the canonical surface the moment the canonical page fires them.

The URL the user passed to `start_session` is the canonical surface. Alternate UI subdomains (`old.*`, `classic.*`, `m.*`, `touch.*`) are **different products**, not cosmetic variants. Treat navigating to one of those mid-discovery the same as navigating to a completely different site.

**Why:**

- Different anti-bot rulesets on alternate subdomains; sessions passing the canonical login wall often get a hard 403 on alternates.
- Different auth flows; CSRF shape / token issuance endpoint / header conventions differ between canonical API and legacy form-POST surface.
- Strategies whose `baseUrl` points at legacy/mobile subdomains post to a surface the user's real browser has never touched.
- Benchmark integrity: silent substitution of an easier surface inflates numbers.

**The rule.** Do not run `start_session` or `perform_action({action: "navigate"})` against a different UI hostname of the same platform during discovery. If the canonical surface is blocked, escalate via `start_remote_session` or abandon discovery and report why.

**What the rule does NOT forbid:**

- Capturing and saving API-host endpoints (`api.example.com/v1/posts`) that the canonical page's JS fires.
- Following redirects the site itself issues (302 from `www.example.com` → `www2.example.com`).
- Fetching subresources the canonical page embeds (scripts, fonts, iframe docs, XHRs).
- Same-host, different-path navigation (`/x/submit` → `/svc/graphql`).

**When IS switching navigation legitimate?** Exactly two cases:

1. The user's natural-language prompt explicitly named the alternate.
2. The canonical surface issues an HTTP redirect chain (server redirect, not client-side link).

Training-data knowledge that "the alternate is easier" is NOT a legitimate reason. The runtime's observation check catches most invented-endpoint cases via `verifyStrategyUrlsObserved`, but it cannot catch "agent legitimately navigated to an alternate subdomain, captured requests there, and saved them" — at that point everything is technically observed. The only defense is this rule.
