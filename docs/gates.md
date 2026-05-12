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

Detectors in `runtime/src/gate/save-warnings.ts` (consumed by the save-strategy audit):

- `unparametrized_session_id` — expression bodies reading session-scoped state (`location.href`, `document.URL`) + id-extraction shapes (`.match(`, `.split(`, `.slice(`, …). Catches "id read from whatever page the session happens to be on."
- `unresolved_name_to_id_gap` — `notes.params.X.example` is id-shaped but the caller's declared args contain no matching `X` and no capability-prereq binds to it. Catches missing lookup siblings.
- `entity_pinned_infra_prereq` — a `prerequisites[i].url` contains a verbatim substring from `session.declaredCapabilities[0].args`. Catches strategies that bake a single-entity id into an infra URL.
- `inline_multi_fetch_prereq` — a single prereq packs multiple sequential fetches that should be split into siblings.
- `prereq_bind_key_mismatch` — `prereq.binds` doesn't match the placeholder names the strategy actually references.
- `lookup_embedded_in_prereq` — a lookup-shaped slug + inline lookup-shaped prereq; the inline lookup should be a capability sibling.
- `auth_gated_without_auth_prereq` — strategy targets an origin where the session captured cookie-setting requests, but declares no `{kind: "capability"}` or `{kind: "tag", tag: "auth"}` prereq, and the strategy itself doesn't advertise `provides: ["auth"]`.

## The Audit class — one machinery, all save-time concerns

Every save-time concern lives inside ONE `Audit` instance: `runtime/src/audit/lift/save-strategy.ts`. As of this writing, that instance composes 13 Detectors (literal provenance prerequisites, observed-property-keys, observed-literal-values, surface-triage-bound, URL observation, popup addressing, plus the seven structural save-warnings) and 4 Classifiers (literal_provenance, capability_name_justification, observed_siblings, user_confirmation). The class (`runtime/src/audit/index.ts`) absorbs the token mint + hash binding + rejection envelope; each concern is a small spec entry the class consumes.

Two spec shapes:

- **`Detector`** — pure structural check. `detect(payload, ctx) → Issue[]`. With `ackReason: 'required'`, the rejection asks for a `{kind, reason}` ack on each issue (Level 2). With `ackReason: 'none'`, the issue is unconditional (no ack-through path; agent fixes or save fails). Optional `validateAck(reason, emittedIssues)` enforces anti-canned-ack guards (the reason must reference a flagged value / key).
- **`Classifier`** — the agent commits to a structural classification the runtime cross-checks. Emits a checklist on first call; second call must echo the token plus answers consistent with the payload. Per-classifier `hashFields` scopes which payload slices invalidate the token, so sibling concerns don't cascade-invalidate.

Adding a new save-time concern is one row: write the detector or classifier, register it in the audit's `detectors` / `classifiers` arrays. Runtime threads the token, formats the rejection, scopes the hash, and persists ack reasons onto `notes.save_warnings_acked` automatically.

The audit emits ONE rejection envelope regardless of how many spec entries fired — the agent sees a unified shape, not a stack of per-gate response shapes.

## Known limitation — `user_confirmation` can't verify the quote

The `user_confirmation` classifier asks the agent to compose a yes/no prompt, relay it to the user, and submit the user's reply as `user_quote`. The token binds the payload hash, so the agent can't audit version A and commit version B — but nothing stops the agent from _fabricating_ `user_quote` outright, or recycling the user's reply to an earlier turn (`triage_plan`, `surface_changed`). The runtime has no structural way to tell a real fresh reply from an invented one; the agent-facing prose says "freshness is on you," and that's the whole enforcement.

This is intentional and we're fine with it. The gate's job here isn't cryptographic proof that a human approved — it's a **stop-gap**: a forced pause that makes the agent surface the save to the user before committing, and leaves a tamper-evident `user_quote` on the strategy for anyone reviewing later. An agent determined to skip the human can, just as it can fabricate any free-text field; the gate raises the cost and creates a paper trail, which is enough for the threat model klura actually has (a cooperating agent that occasionally cuts corners under context pressure, not an adversary). If this turns out to matter more later — e.g. a remote-orchestration mode where the human channel is structurally available — `user_confirmation` can grow a real out-of-band confirmation path (a `SaveConfirmationDecider` that round-trips an actual human, the way the test harness's stub does). Until then, don't pile heavier machinery onto this gate expecting it to become unfakeable; that's not what it's for.

## Current gates in the runtime

| Gate | Level | Where | Why |
| --- | --- | --- | --- |
| `save_strategy` audit | 2 + 3 | `runtime/src/audit/lift/save-strategy.ts` | Single Audit instance composing 13 detectors + 4 classifiers. Wrong commit = silently-broken strategy every future caller runs. |
| `end_drive` audit | 2 + 3 | `runtime/src/audit/drive/end-drive.ts` | Second Audit instance — `capability_declaration_required` Detector (`ackReason: 'none'`) + `re_persistence` Classifier (token-gated). Same machinery as save-strategy audit, different lifecycle decision point. |
| `trigger_reference_send` consent | 3 | `runtime/src/tools/trigger-reference-send.ts` | Re-fires a real submit on every call. Wrong commit = side-effect fired against a real service without user knowing. |

**Centralization is non-negotiable.** All save-time concerns funnel through the `Audit` class — no roll-your-own gate factories, no roll-your-own rejection envelopes, no roll-your-own token threading. `buildTokenGate` is the underlying primitive; the `Audit` class wraps it with detector composition + ack handling for save-time gates, and standalone gates outside that envelope (`trigger_reference_send` consent, `checkpoint_ack`, `interruption_ack`) reuse `buildTokenGate` directly.

**Token-gating is selective, not default.** It is the heaviest gate in the toolkit and is reserved for places where a wrong commit has real, hard-to-recover cost. Don't token-gate every runtime check — friction overkill ruins the agent's ability to make forward progress. Lighter gates are fine for checks where cheating-through is tolerable or post-hoc detectable. For most checks, Level 2's tamper-evident reason text is enough. Reach for Level 3 only when a canned answer would materially damage the output and you need to be sure the agent actually read the checklist.
