# Pre-commit gates

A **gate** is a runtime check that fires at a save / commit boundary and refuses to proceed unless the agent has engaged with a checklist. Distinct from the interruption framework (see [interruptions.md](interruptions.md)): interruptions fire mid-execute against live session state and route through plugins; gates fire at save time against payload shape and are direct, non-plugin-routed.

Save-time concerns (Levels 2 and 3) compose into the `Audit` class (`runtime/src/audit/index.ts`) under one rejection envelope — see "The Audit class" below. Lifecycle gates outside that envelope (`trigger_reference_send` consent, `checkpoint_ack`, `interruption_ack`) reuse `buildTokenGate` from `runtime/src/gate/` directly. Reviewers should reject PRs that roll their own hash, token mint, or store.

## Taxonomy

Three gate levels exist, in order of increasing friction and cost. Pick the lowest-friction level that makes the cost of cheating bigger than the benefit; reserve the heaviest tier for places where a wrong commit has real, hard-to-recover cost.

**Level 1 — self-attest boolean.** Agent sets `flag: true` to proceed. Maximally bypassable — pure self-attestation. Use only when the gate's purpose is to force a pause that the runtime fundamentally can't verify from the call alone. No Level-1 gates live in the runtime today. Level-1 is the fallback when you genuinely can't detect the thing AND can't structurally verify the ack.

**Level 2 — acked warning with reason.** Runtime detects the issue; the agent either fixes the strategy or writes a non-empty `reason` string to ack. The reason text is tamper-evident — inspectable across runs, survives the session, leaves a paper trail even when the agent fabricates. Use when the runtime CAN detect the issue and wants the agent to fix or justify. Runtime cost: zero (single-call). Agent cost: one extra field per unacked warning.

**Level 3 — token-gated two-phase.** The first call is ALWAYS rejected with a server-minted ephemeral token bound to a hash of the payload. The second call must echo the token plus structured answers the runtime can cross-check against the payload shape. Use when (a) the runtime cannot detect the issue itself (needs the agent's domain knowledge to classify), (b) the answer shape is structural so consistency can be machine-verified, and (c) cost of a wrong commit is high enough to justify a mandatory round-trip. Runtime cost: one forced rejection per commit. Agent cost: one round-trip minimum.

**Why token-gating and not just another optional field. LLMs cheat when they hit a hindrance.** Once a model has seen an `audit: true` or `confirmed: true` field in its training data or prior conversations, it will start canned-answering the same field whenever it sees a rejection that mentions it, without actually doing the classification work. An optional attestation field fails exactly at the moment the gate matters: the agent is struggling, the context is tight, the temptation to ship a canned answer is highest. Token-gating defeats this because the token doesn't exist until the runtime mints it on the first rejection — the model can't pre-fabricate it, and the hash-binding ensures it can't audit version A and commit version B. The round-trip itself is what enforces engagement.

**Once-per-session vs N-per-session is the real Level-2-vs-Level-3 criterion.** The muscle-memory failure mode token-gating defends against requires the agent to see the gate fire MULTIPLE times within one session — call 1 rejected with rejection text; call 2 includes the canned ack from memory of call 1's rejection; call 3 with a different payload reuses the same canned ack without re-classifying. If a gate fires AT MOST ONCE per session (e.g., a per-session-lifecycle obligation, a one-shot consent), there's no prior firing to draw a canned answer from — the LLM sees the rejection text for the first time within the same session that resolves it. Level 2's tamper-evident reason field is sufficient. Reach for Level 3 specifically when (a) the gate can fire on the same session more than once, AND (b) cost of a canned cross-firing answer is high. Most save-time gates are multi-fire (any save_strategy can hit them) → Level 3. Most lifecycle gates are single-fire → Level 2.

`triage_acknowledgment` on the `end_drive` audit is the worked example: it fires at most once per session (end_drive is the session's last act), so supplying the ack IS the acknowledgment and the token round-trip adds a rejection round without adding signal. `audit.triageAckAsDetector` (default `true`) selects the Level-2 Detector shape; setting it `false` selects the Level-3 Classifier shape. Exactly one is live per call — each consults the flag and stays silent when the other owns the concern — so the two can be measured against each other over the fixture suite.

## Token-gated gates (Level 3)

`buildTokenGate<TPayload, TAnswers>(spec)` — the factory in `runtime/src/gate/build.ts`. Spec has three fields:

- `kind: string` — stable id; used as the store namespace and in telemetry.
- `buildChecklist(payload)` — first-call: returns the checklist the agent sees in the rejection.
- `validateAnswers(payload, answers)` — second-call: returns `[]` on success, a list of issue bullets otherwise.

The factory wraps the two-phase pattern:

1. **First call (no token).** Runtime calls `buildChecklist`, hashes the payload via `hashGatePayload` (stable JSON canonicalization), issues a token bound to the hash, and rejects with `{reason: 'pending_audit', token, checklist}`.
2. **Second call (with token + answers).** Runtime looks up the token, verifies (a) the token is known and not expired, (b) the current payload hash matches the hash the token was minted against. Any mismatch invalidates the token and re-issues fresh — agent can't audit version A and commit version B. Then `validateAnswers` runs; `[]` → commit; issues → reject with `{reason: 'answers_inconsistent', token, checklist, issues}`.
3. **On commit.** `consumeToken(token)` — tokens are single-use.

The hash function (`hashGatePayload`) is swappable — it can become a keyed HMAC without touching gate consumers. The token store (`issueToken` / `lookupToken` / `consumeToken`) is shared across gates, namespaced by `kind`, and TTL-swept.

### First-call answers — when the round trip proves nothing

The forced first rejection buys one thing: proof that the agent's answers describe the payload the runtime hashed. When the answers and the payload arrive in the SAME call, that proof is already structural — the classifier's `validate()` cross-checks the answer against the very bytes it describes, and there is no window in which the agent could swap the payload out from under an answer it already gave. `Classifier.firstCallAnswerable` marks the classifiers where that holds, and `audit.firstCallAnswers` decides whether the runtime acts on it:

| `audit.firstCallAnswers` | Behavior |
| --- | --- |
| `off` (default) | Every classifier round-trips. `firstCallAnswerable` is read and ignored. |
| `safe_subset` | Only `firstCallAnswerable: true` classifiers may be answered on the first call. |
| `all_except_confirmation` | Every classifier except those that opt out with `firstCallAnswerable: false`. |

Three invariants hold in all three modes:

- **A call with no answers always mints and rejects `pending`.** The first-call accept is reachable only when the agent actually supplied answers, which keeps the whole mechanism away from the common case.
- **Consent-shaped classifiers opt out.** `user_confirmation`'s `hashFields` binds the strategy identity the user approved; a first-call accept would let the prompt and quote be composed against a payload nothing has bound yet. `mutating_verification_required` is a verdict about an effect the runtime cannot re-observe. Both are `false`.
- **Stage 0 and Stage 1 are untouched.** Shape checks and detectors still run first, and still short-circuit before any classifier — answers or not.

A first call whose answers are inconsistent is rejected `answers_inconsistent` with a token, carrying the answerable subset's issues plus every active classifier's items, so one round fixes everything. That rejection also carries `first_call_answers: true`, which the bounce policy reads (see below).

`buildTokenGate` deliberately has NO first-call-answer path. Its consumers (`checkpoint_ack`, `interruption_ack`, `strategy_candidate.semantic_review`, `trigger_reference_send.consent`) each bind an artifact the RUNTIME authored and the agent must read before it can answer; the first call is the call that hands that artifact over, so an answer supplied before it describes nothing the agent has seen. A new consumer that wants a first-call accept is a consumer whose payload the agent authored — that belongs in an `Audit` instance.

Consumer pattern:

```ts
const auditGate = buildTokenGate<Strategy, AuditAnswers>({
  kind: 'save_strategy.audit',
  buildChecklist: (strategy) => ({
    /* inline prompt the agent reads */
  }),
  validateAnswers: (strategy, answers) => collectIssues(strategy, answers),
});

// At the commit site:
const result = auditGate.process(strategy, {
  token: args.audit_token,
  answers: args.audit_answers,
});
if (result.status !== 'committed') return formatRejection(result.rejection);
```

## Acked warnings (Level 2)

`notes.save_warnings[]` + `notes.save_warnings_acked[]` is the canonical Level-2 pattern. The `Audit` class (next section) consumes Detector specs with `ackReason: 'required'` and reconciles `notes.save_warnings_acked` against the emitted issues — same surface, same shape, but composed alongside Level-3 classifiers under one rejection envelope.

Ack shape is `{kind, reason}` — `kind` must match an emitted warning, `reason` must be a non-empty string (one-sentence justification). The reason is persisted onto the strategy and surfaces on subsequent `list_platform_skills` / `get_strategy` reads, giving future agents tamper-evident context for why the warning was dismissed.

Semantics:

- **Orphan acks rejected.** If `acked[i].kind` doesn't match any emitted warning, the save is rejected with a kind-spelling hint.
- **Reason required.** Empty or whitespace-only reason → rejected with "one-sentence justification" prompt.
- **Unacked warning → save rejected.** The unacked warning's `message` + `hint` are bundled into the rejection; the agent either fixes the strategy OR re-submits with a valid ack.
- **Anti-canned-ack via `validateAck`** (optional per detector). The reason must reference a flagged value / key — a bare `"intentional"` doesn't pass.

Detectors in the `runtime/src/gate/save-warnings*.ts` family (re-exported through `save-warnings.ts`, consumed by the save-strategy audit):

- `unparametrized_session_id` — expression bodies reading session-scoped state (`location.href`, `document.URL`) + id-extraction shapes (`.match(`, `.split(`, `.slice(`, …). Catches "id read from whatever page the session happens to be on." Suppressed when the expression body reads caller `args.` or the strategy declares a `{kind: "capability"}` / `{kind: "tag"}` prereq — a caller-derived source or lookup sibling is already in play.
- `unresolved_name_to_id_gap` — `notes.params.X.example` is id-shaped but the caller's declared args contain no matching `X` and no capability-prereq binds to it. Catches missing lookup siblings.
- `entity_pinned_infra_prereq` — a `prerequisites[i].url` has a path segment or query value equal to a value from `session.declaredCapabilities[0].args`. Hostname matches are excluded because the hostname identifies the platform, not a caller entity.
- `multi_fetch_inline_prereq` — a single executable-JS field inlines 2+ `fetch()` calls that should be split into sibling capabilities.
- `prereq_bind_key_mismatch` — `prereq.binds` doesn't match the placeholder names the strategy actually references.
- `lookup_embedded_in_prereq` — a downstream capability inlines a lookup-shaped prereq; the lookup should be a capability sibling. First-class `search_<entity>`, `lookup_<entity>`, `list_<entity>`, and equivalent `<entity>_search` capabilities own their retrieval surface and are excluded.
- `auth_gated_without_auth_prereq` — strategy targets an origin where the session captured cookie-setting requests, but declares no `{kind: "capability"}` or `{kind: "tag", tag: "auth"}` prereq, and the strategy itself doesn't advertise `provides: ["auth"]`.
- `caller_arg_baked` — a whole strategy field is, verbatim, a value this caller passed to `start_session` / `declare_capability`. Crisp by construction: whole-field exact match against a declared arg value, minimum 3 characters, templated fields and secret references excluded. A Detector rather than a `literal_provenance` validation issue so it fires in Stage 1, before any classifier token mints — the agent re-templates on a token-free rejection instead of invalidating a fresh token by fixing the body. The ack path covers the one legitimate exception: the value is genuinely fixed for every caller and merely coincides with what this caller asked for.

## The Audit class — one machinery, all save-time concerns

Every save-time concern lives inside ONE `Audit` instance: `runtime/src/audit/lift/save-strategy.ts`. That instance composes a few dozen Detectors (surface-triage binding, tier-verdict enforcement, URL observation, sensitive-shape refusal, popup addressing, the structural save-warnings, …) and a handful of Classifiers (literal_provenance, capability_name_justification, observed_siblings, user_confirmation, plus the token-bound warning classifiers) — `Audit.detectorKinds()` / `classifierKinds()` enumerate the live set. The class (`runtime/src/audit/index.ts`) absorbs the token mint + hash binding + rejection envelope; each concern is a small spec entry the class consumes.

Two spec shapes:

- **`Detector`** — pure structural check. `detect(payload, ctx) → Issue[]`. With `ackReason: 'required'`, the rejection asks for a `{kind, reason}` ack on each issue (Level 2). With `ackReason: 'none'`, the issue is unconditional (no ack-through path; agent fixes or save fails). Optional `validateAck(reason, emittedIssues)` enforces anti-canned-ack guards (the reason must reference a flagged value / key).
- **`Classifier`** — the agent commits to a structural classification the runtime cross-checks. Emits a checklist on first call; second call must echo the token plus answers consistent with the payload. Per-classifier `hashFields` scopes which payload slices invalidate the token, so sibling concerns don't cascade-invalidate. `firstCallAnswerable` marks the classifiers whose answers describe items derived from the same call's payload — see "First-call answers" above for when the runtime acts on it.

Adding a new save-time concern is one row: write the detector or classifier, register it in the audit's `detectors` / `classifiers` arrays. Runtime threads the token, formats the rejection, scopes the hash, and persists ack reasons onto `notes.save_warnings_acked` automatically.

The audit emits ONE rejection envelope regardless of how many spec entries fired — the agent sees a unified shape, not a stack of per-gate response shapes.

### The save policy — one entry for every producer

Strategies land on disk from five producers: the attended agent pipeline (`save_strategy` tool), the two auto-synth passes at `end_drive` (fetch/page-script capture-join and recorded-path replay), graduation (recorded-path → fetch/page-script after N consistent observations), and the programmatic API (daemon HTTP / embedder code). **All five route through `evaluateSavePolicy({origin, platform, capability, strategy, evidence})`** (`runtime/src/audit/lift/save-policy.ts`), which drives the same `saveStrategyAudit` instance; differences between producers are expressed via the `origin` (a `SAVE_ORIGINS` value from `runtime/src/vocab/index.ts`), never by skipping the audit:

- `agent_explicit` — delegates to `Audit.process` unchanged: Stage 0 shape, Stage 1 detectors with ack semantics, Stage 2 token-gated classifiers.
- `auto_synth_fetch` / `auto_synth_recorded` / `graduation` — the unattended pipeline: Stage 0 shape checks, then `Audit.runUnattended`, which runs every Detector and splits issues by the detector's `unattendedPolicy` (default derives from `ackReason`: `'none'` → blocking, `'required'` → warning; `'skip'` opts agent-workflow checks out). Blocking issues throw `SavePolicyBlockedError`; the auto-synth origins persist warn-tier issues onto `runtime_meta.save_warnings` for the next attended session. Classifiers don't run a token flow unattended (nothing would consume the token); a classifier whose structural signal still matters on the artifact supplies an `unattendedWarnings` projection (e.g. `parameterization_disclosure_required`).
- `programmatic` — embedder code persisting a hand-constructed strategy, not LLM-emitted content: blocking issues demote to warnings in the returned `AuditResult` instead of refusing the caller's deliberate write.

The payoff: a new save-time invariant lands ONCE as a Detector row and protects every producer by construction. `sensitive_action_must_be_recorded_not_saved` is the canonical example — one detector blocks the sensitive shape on the agent path, both synth passes, and graduation, with no per-producer copies.

### The save-rejection bounce — structural dead ends

The audit's rejection envelope is an iteration loop, and most agents clear it in 1–3 retries. The failure mode it doesn't self-correct is the agent iterating **the same rejection** with cosmetic edits — chasing a detector false-positive, a schema contradiction, or a shape the runtime genuinely can't save. `runtime/src/audit/lift/save-rejection-bounce.ts` guards that loop: every surfaced `save_strategy` rejection increments a per-session `(capability, family)` counter, and on the 3rd same-family rejection the thrown message escalates to `save_strategy_structural_dead_end` instead of echoing the audit prose again.

The **family key** is a signature of what actively failed: the saved tier (`strategy.strategy` — a fetch → recorded-path pivot is a fresh family) plus the components carrying an active issue in _this_ rejection — unacked warning kinds on `unacked_warnings`; on `answers_inconsistent`, the classifier kinds (or `notes.params.<param>` paths for enum-grounding bullets) attributed from the issue bullets, never the full `items` checklist, so an auto-classified-and-resolved classifier doesn't inflate the family. `pending` and `payload_changed` rejections are audit-flow bookkeeping, not substantive failures — they never count.

**One-time per-family grace for first-call answers.** `answers_inconsistent` is the substantive rejection the bounce exists to count, so it is NOT exempt. But a first call carrying answers and no token can be scored that way, and a token-less first call is free by design — the agent has no way to know that attempt is being graded. So the FIRST `answers_inconsistent` per family that carries `first_call_answers: true` records the grace on the session and does not count; every later rejection in that family counts normally, token-bearing or not. The budget is exactly as generous as the mint-then-echo flow's, and omitting the token repeatedly buys nothing — the grace can be earned once per `(capability, family)` and `resetSaveRejectionFamilies` clears the spent-grace records alongside the counts. Exempting `answers_inconsistent` wholesale would gut the bounce; exempting token-less calls unconditionally would let an agent that never echoes a token loop forever.

The **exit menu leads with the rejection's own remedy**: active warning hints and liftable classifier remedies (`capability_alternative`, `observed_alternatives`, `cross_session_evidence`, `classification_options`) render as the first options, a return-to-drive option is added when the rejection is enum-grounding-shaped, and the generic defer (`add_discovery_note`) / tier-switch / abandon (`abort_session`) triad closes the list. The bounce fires on the _rejection_, never preemptively on the attempt — the 3rd retry is evaluated in full, so a genuine structural fix commits normally.

Two integration points: `applySaveRejectionBounce` (`runtime/src/audit/lift/save-policy.ts`) is the origin-gated policy entry — only `agent_explicit` saves with a live session count (unattended origins have no agent looping); the `rejectAudit` funnel in `runtime/src/tools/save-strategy.ts` routes every rejection it throws to the agent through it, so internal policy evaluations (acker discovery, pre-probe checks) never spend the budget. An accepted `submit_triage_plan` for the capability calls `resetSaveRejectionFamilies` — a re-plan is a deliberate pivot and restarts the budget.

### Concern modules — one fact source per lockstep concern

Concerns whose facts feed both an audit issue and an authoring hint (the triage / save authoring contracts in `runtime/src/phases/`) own one shared extractor under `runtime/src/audit/concerns/`: `slug-collision.ts` (tokenizer + query-value matcher), `citeable-artifacts.ts` (the tier-justification citation universe), `tier-rank.ts` (the tier speed ordering), `triage-verdict.ts` (logbook verdict lookup). The contracts project the same facts the detectors enforce; `runtime/test/authoring-contract-parity.test.js` asserts two-way detector↔constraint coverage on the triage side and a reviewed projection subset on the save side (via `Audit.detectorKinds()` / `classifierKinds()`). A new concern that surfaces in both places starts as a concern module, not as parallel copies.

## Known limitation — `user_confirmation` can't verify the quote

The `user_confirmation` classifier asks the agent to compose a yes/no prompt, relay it to the user, and submit the user's reply as `user_quote`. The token binds the payload hash, so the agent can't audit version A and commit version B — but nothing stops the agent from _fabricating_ `user_quote` outright, or recycling the user's reply to an earlier turn (`triage_plan`, `surface_changed`). The runtime has no structural way to tell a real fresh reply from an invented one; the agent-facing prose says "freshness is on you," and that's the whole enforcement.

This is intentional and we're fine with it. The gate's job here isn't cryptographic proof that a human approved — it's a **stop-gap**: a forced pause that makes the agent surface the save to the user before committing, and leaves a tamper-evident `user_quote` on the strategy for anyone reviewing later. An agent determined to skip the human can, just as it can fabricate any free-text field; the gate raises the cost and creates a paper trail, which is enough for the threat model klura actually has (a cooperating agent that occasionally cuts corners under context pressure, not an adversary). If this turns out to matter more later — e.g. a remote-orchestration mode where the human channel is structurally available — `user_confirmation` can grow a real out-of-band confirmation path (a `SaveConfirmationDecider` that round-trips an actual human, the way the test harness's stub does). Until then, don't pile heavier machinery onto this gate expecting it to become unfakeable; that's not what it's for.

## Current gates in the runtime

| Gate | Level | Where | Why |
| --- | --- | --- | --- |
| `save_strategy` audit | 2 + 3 | `runtime/src/audit/lift/save-strategy.ts` | Single Audit instance composing every save-time detector + classifier, applied to every producer via the save policy. Wrong commit = silently-broken strategy every future caller runs. |
| `end_drive` audit | 2 (+ 3 behind config) | `runtime/src/audit/drive/end-drive.ts` | Second Audit instance — `capability_declaration_required` / `save_attempted_none_landed` / `re_persistence` / `map_session_no_observations` Detectors (`ackReason: 'none'`) plus the ackable `observed_capabilities_not_lifted`, `unsaved_xhr_endpoints`, `abandoned_save_attempts_not_retried` and `triage_acknowledgment`. Same machinery as save-strategy audit, different lifecycle decision point. Every concern here fires at most once per session, so Level 2 carries them; the Classifier shape of `triage_acknowledgment` stays reachable via `audit.triageAckAsDetector: false` for measurement. |
| `trigger_reference_send` consent | 3 | `runtime/src/tools/trigger-reference-send.ts` | Re-fires a real submit on every call. Wrong commit = side-effect fired against a real service without user knowing. |

**Centralization is non-negotiable.** All save-time concerns funnel through the `Audit` class — no roll-your-own gate factories, no roll-your-own rejection envelopes, no roll-your-own token threading. `buildTokenGate` is the underlying primitive; the `Audit` class wraps it with detector composition + ack handling for save-time gates, and standalone gates outside that envelope (`trigger_reference_send` consent, `checkpoint_ack`, `interruption_ack`) reuse `buildTokenGate` directly.

**Token-gating is selective, not default.** It is the heaviest gate in the toolkit and is reserved for places where a wrong commit has real, hard-to-recover cost. Don't token-gate every runtime check — friction overkill ruins the agent's ability to make forward progress. Lighter gates are fine for checks where cheating-through is tolerable or post-hoc detectable. For most checks, Level 2's tamper-evident reason text is enough. Reach for Level 3 only when a canned answer would materially damage the output and you need to be sure the agent actually read the checklist.
