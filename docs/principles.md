# Design principles & prior art

These are the load-bearing principles that shape every other decision in the runtime. The full architecture lives in `../ARCHITECTURE.md` and the sibling files; this file is the "why" the others reference.

## Runtime is plumbing, the LLM is intelligence

The runtime provides tools — browser control, strategy persistence, network interception, credential resolution. The LLM provides reasoning — exploration decisions, blocker classification, workflow orchestration, argument disambiguation. This split is load-bearing: when something can be decided by the LLM reading page state, it should not be hardcoded in the runtime.

Concretely, this means we do **not** build:

- **Blocker classification heuristics** in the runtime. No overlay z-index detectors, no keyword matching for "accept" or "terms". The LLM reads the a11y tree and decides what a modal is.
- **Argument resolution caches** or **contact databases** in the runtime. The LLM discovers `search_users` as a regular capability, calls it, and passes the result to `execute`. A runtime-side contact cache duplicates what the LLM already does with its conversation context.
- **Self-learning systems** for argument defaults, output relevance, or action-triggered follow-ups. The LLM already learns user preferences through conversation memory. Building a parallel preference engine in the runtime adds complexity for a problem that doesn't exist at current scale.
- **Capability composition metadata** (`requires`, `triggers_listener`, `related` fields). The LLM figures out workflow ordering from capability names and its own reasoning.

The test for whether something belongs in the runtime: "does this require persistent state or browser/OS access that the LLM can't have?" If yes → runtime. If no → let the LLM handle it.

## Validate everything the LLM emits

LLMs WILL hallucinate. They will invent CSS selectors that look right but don't exist on the page. They will invent JSON keys that don't match any schema. They will invent enum values that aren't in the allowed set. **Treat every LLM-emitted string as untrusted input until it passes a runtime check against ground truth.**

Every LLM-supplied artifact (strategy file, prereq selector, header value, endpoint URL, platform slug, identity key, policy tier) goes through `runtime/src/validators.ts` at save time. Save-time DOM probing for `page-extract` selectors lives in `runtime/src/strategies/probe.ts` — it catches "agent invented a selector that doesn't exist" before the strategy ever lands on disk. See [validation.md](validation.md) for the full save-time validation pipeline.

### The canonical pattern

Every validation routes through `validators.ts`:

```ts
import {
  asPlatformSlug,
  asIdentifierSlug,
  asString,
  asNonEmptyString,
  asBoundedString,
  asObject,
  asArray,
  asEnum,
  asPositiveInt,
  asUrl,
  assertNoReservedKeys,
  ValidationError,
} from './validators';
```

Each helper takes `(value, field)` and either returns the narrowed type or throws `ValidationError` with a consistent `field: message` format. Public-facing functions wrap the block so the LLM receives a domain-specific error it can act on:

```ts
export function savePolicy(platform: string, policy: PlatformPolicy): void {
  try {
    asPlatformSlug(platform, 'platform');
    const obj = asObject(policy, 'policy');
    if (obj.max_strategy_tier !== undefined) {
      asEnum(obj.max_strategy_tier, 'policy.max_strategy_tier', TIER_ORDER);
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_policy: ${e.message}`, { cause: e });
    }
    throw e;
  }
}
```

`{ cause: e }` is load-bearing for debugging and is enforced by the `preserve-caught-error` ESLint rule.

**`asEnum` does did-you-mean suggestions automatically** (Levenshtein distance ≤ 3 AND ≥ 30% character overlap), so `asEnum(value, 'strategyType', ['fetch', 'page-script', 'recorded-path'])` on `"recorded-pathe"` throws `strategyType = "recorded-pathe" is not allowed; … — did you mean "recorded-path"?`. Inline `.includes()` enum checks lose that suggestion — always use `asEnum`.

### Save-time vs execute-time

- **Save-time shape (cheap, always)**: shape checks, enum membership, length caps, slug regex, path-traversal rejection, reserved-key rejection, URL scheme allowlist. Pure functions, no I/O.
- **Save-time DOM probe (cheap, read-only only)**: for `fetch` strategies with `page-extract` prereqs, `probeStrategySelectors` navigates to each prereq URL and verifies every selector resolves. Never clicks submit buttons or fires POSTs — save-time probing must be side-effect-free.
- **Execute-time replay is off-limits at save time**: firing the actual API call or recorded-path steps to "verify it works" would replay mutations (create issues, send messages, place orders). Execute-time failures surface as `auth_failed` / `endpoint_stale` / `all_strategies_failed` through the classifier in `runtime/src/execution.ts:finalizeCascadeFailure`.

### Rules

- **Reject, don't coerce.** If the LLM passed `"max_strategy_tier": "FLYING"`, throw. Never default to `"fetch"` — coercion hides bugs.
- **Error messages name the specific bad value AND the correct form.** `"missing required key"` is useless. `invalid_strategy: fetch.prerequisites[0].method = "GET" is not allowed; must be one of: "browser", "cached", "page-extract"` lets the agent fix it on the first retry.
- **Silent acceptance is the worst possible outcome.** The agent walks away thinking it succeeded and the user discovers the bad strategy at execute time.
- **Layered defense.** `validators.ts` → `validateStrategyShape` → `probeStrategySelectors` → execute-time classifier. Each layer catches what the previous couldn't.

The runtime is plumbing, the LLM is intelligence — but intelligence without ground truth becomes confident fiction. The runtime's job is to provide the ground truth that bounds the intelligence.

## If the LLM keeps making the same "mistake", the runtime is wrong

LLMs are trained on millions of codebases, docs, and Stack Overflow answers. When they consistently reach for a specific name, shape, or pattern, that behavior is a statement about what the natural API _is_ — not a symptom to correct. Klura's runtime authors are one data point; the LLM's prior is an average over every public API written in the last decade. When they disagree, the runtime loses by default.

Concrete triggers — "the agent tried a different field name on three separate discovery sessions", "the agent passed `const x = 1; x` to `js_eval` across runs", "the agent kept forgetting a required field after finding the right expression" — are each a signal that the runtime is imposing a shape the LLM doesn't natively think in. Two fixes, applied in this order:

1. **Rename to what the LLM calls it.** If the LLM consistently uses a different term, rename the canonical field rather than keeping your name + accepting theirs as an alias. Aliases are the retreat option when renaming would break something external; the real fix is to use the term the LLM writes. The LLM's intuition is usually right about what things should be called; resisting it costs tokens on every retry across every user, forever.

2. **Make the runtime smarter.** If the agent passes a statement to a tool that only accepts expressions, wrap it in an IIFE server-side instead of throwing a syntax error. If they keep forgetting an optional-but-required field, derive it or make it truly optional. If they reach for a shape the runtime doesn't support, support it.

What you do **not** do: leave the friction and add another sentence to SKILL.md or a more elaborate "did you mean" to the validator message. Every friction you don't remove compounds — more tokens per round, more rounds per task, more ways the discovery flow stalls. The LLM is the customer; its behavior is the user-acceptance test. Hints are the runtime author winning a debate they shouldn't have been in.

Exceptions exist. Sometimes the LLM's term collides with an existing field with different semantics, or the LLM is genuinely hallucinating a nonsense field that doesn't map to anything. In the collision case, the renamed field can't win — keep both names with separate meanings and document why in `runtime/REFERENCE.md`. In the hallucination case, the existing "validate everything they emit" principle applies — reject loudly, but check three sessions later whether "hallucination" was actually "this is the right name and you're refusing to see it."

This principle operationalizes as: **whenever you add or edit a validator, tool schema, or error message, imagine an agent hitting this exact rejection three times in a row across independent sessions. If you can, the rejection is the bug.**

Worked examples in the codebase:

- **`origin` vs `baseUrl` on ws strategies (rename).** The field naming the HTTP(S) URL the page loads from _used to be_ called `baseUrl` across every strategy tier. On ws strategies the executor only uses the field for page navigation, and the LLM consistently wrote `origin` because that matches the HTTP `Origin` header and web URL terminology. After observing the rename attempts across repeated discovery sessions, ws strategies now require `origin` as the canonical field name — hard rename, no alias. The validator rejects `baseUrl` on a ws strategy and points the agent at `origin` in the error message. HTTP tiers kept `baseUrl` as canonical and accept `origin` as a forward-compat ergonomic alias. See `runtime/src/strategies/validate.ts` and `runtime/src/execution/websocket.ts`.
- **`js_eval` accepting top-level statements (make the runtime smarter).** `js_eval` used to reject expressions with a top-level `const` / `let` / `var` — "expressions only, wrap in an IIFE." The LLM kept passing the shape you'd paste into a Node REPL: `const x = foo(); x`. `wrapAgentExpression` (`runtime/src/response/js-eval-wrapper.ts`) now detects top-level declarations and auto-wraps in an async IIFE block. Same end result; no round wasted on the syntax error.

## Forgive surface variance, reject semantic regression

The previous principle covers the case where the LLM writes one thing and the runtime wants another — rename or widen until the runtime matches the LLM's prior. This one covers what happens when **different LLMs reach for different priors for the same idea.** Models trained on different corpora write the same intent in different surfaces — `{{recipient_name}}` vs `{{0}}` for caller args, `notes.params: {name: {...}}` vs `notes.params: [{name: "name", ...}]` for parameter declarations, `input[name="search"]` vs `[role="textbox"][name="search"]` for the same DOM node. Picking one as canonical and rejecting the others is the runtime author privileging their own family of training data over every other.

Two surfaces are **equivalent** when they resolve to the same runtime behavior on the same inputs. Equivalent surfaces should both be accepted; the validator normalizes to a single internal shape and the public error messages list every accepted form. The cost is a small amount of normalization code at one entry point; the benefit is that each new model family doesn't burn discovery rounds re-learning klura's specific dialect.

A surface is **regression** when it produces a result the agent didn't intend, breaks under realistic site change, or hides information the runtime needs to reason about portability. Examples that look harmless but aren't: hardcoding `93210` into an endpoint when the agent has the value in `notes.params` (will break on the next caller), saving `results[0].id` as the JSONPath when the response carries a stable `id` field that could be matched on (works once, breaks when the server reorders), passing `headers: {x-csrf: "abc123..."}` baked from a captured value (will break when the server rotates). Reject these even when the agent is confident — the next session is the user-acceptance test, not this one.

The decision rubric:

1. Is the alternative form going to produce the same result as the canonical form on this and every future call? → accept.
2. Will it work today but break under a realistic deploy / data change / second caller? → reject with a hint pointing at the stable form.
3. Are you sure it's "wrong" or just "not how I'd write it"? → likely (1).

This principle operationalizes alongside `validate-everything-the-LLM-emits` and `if-the-LLM-keeps-making-the-same-mistake`. Together: validate everything; rename or widen when the LLM's prior is consistent with itself; widen further when different families have different priors that all map to the same intent; and within that latitude, keep rejecting the forms that ARE actually worse — those costs land on the user weeks later when the saved skill silently breaks.

Worked examples in the codebase:

- **Selector-dialect widening (forgive variance).** `resolveLocator` in `runtime/src/drivers/playwright.ts` accepts a11y-role syntax (`button "Submit"`), role+attr (`searchbox[name="q"]`), CSS, and now widens `<tag>[<attrs>]` to also match the role analog (`input[name="x"]` also resolves elements that match `[role="textbox"][name="x"]`). Different model families write each form first; the runtime treats them as equivalent because they all bind the same DOM node when present.
- **`notes.params` array form (forgive variance).** Some models write the canonical object form `notes.params: {recipient_name: {kind, example}}`; others write the JSON-Schema-style array form `notes.params: [{name: "recipient_name", kind, example}]`. Both convey the same parameter declarations — the validator normalizes the array form to the object form before the rest of the pipeline runs. Placeholders bind the same way in either case (`{{recipient_name}}` works regardless of which surface was used to declare it).
- **Named + positional placeholders (forgive variance).** `notes.params` declarations expose both `{{recipient_name}}` and `{{0}}` as resolvable placeholders. Models trained on REST templates write the named form; models trained on positional API conventions write the index form; both resolve to the same caller arg. The error message lists named placeholders first so the dominant prior gets seen first.
- **Hardcoded literal in endpoint (reject regression).** The save-strategy audit's `literal_provenance` classifier (`runtime/src/audit/save-strategy.ts`) requires the agent to classify each literal in the endpoint / prereq URL: `static`, `caller_input`, `prereq_output`, or `single_entity`. Anything that classifies as `single_entity` (one specific user, one specific thread id) gets rejected unless the agent confirms the strategy is intentionally single-purpose. The same literal expressed via `{{member_id}}` referencing a `notes.params.member_id` declaration sails through. Same surface, opposite verdict — because one will break the moment a second caller uses the strategy and the other won't.

## Reject with remedy

Every audit rejection carries the structural alternative the agent needs to recover. If the runtime knows X is wrong, it must also surface the data the agent needs to fix it — not just say "X is wrong." Withholding what's known turns a one-shot recoverable failure into a multi-round guess-and-retry loop, costs tokens, and pushes the agent toward fold paths (recorded-path, `kind: "text"`, abandoning the save) that bypass the rejection rather than satisfy it.

Type-enforced. The `Detector` and `Classifier` interfaces in `runtime/src/audit/index.ts` require a `remedy` field that returns a `Remedy` discriminated union. The build won't pass without one — every audit author must explicitly answer "what should the agent do instead?" New audits that can't articulate the question are almost always missing structural data they should be threading through.

The remedy variants name what's available:

- `observed_alternatives` — values / labels actually captured this session, with provenance per entry. The literal_provenance audit's remedy is the canonical example: when the agent classifies a literal as `static` but the runtime saw the same value via a click→XHR observation, the remedy lists every observed (param, value) tuple from this session.
- `classification_options` — small enumerable set of valid choices, each with rationale. Used when the agent picked a category outside the allowed set; the remedy lists the categories that are valid + why each fits.
- `closest_matches` — nearest captured candidates by some structural distance (host-prefix overlap, substring match against captured strings). Used by `unobserved_url`: when the agent declares a URL the audit hasn't seen, the remedy surfaces the URLs the audit DID see this session so the agent can pick the right one or notice their typo.
- `capability_alternative` — the right shape is a different prereq kind. Used when a baked literal should be a `{kind: "capability"}` prereq pointing at a sibling lookup, or when an inline expression should be a `{kind: "js-eval"}` prereq.
- `cross_session_evidence` — values observed across prior sessions for this platform via the logbook. Strictly informational (not eligible for inline `observed_values` declaration), but routes the agent toward Path B (`source: "capability:list_<entity>"`) when the universe is too large for any single session to capture.
- `no_programmatic_remedy` — explicit opt-out with a non-empty `reason`. Use when no structural alternative exists (user_confirmation classifier — the user's decision isn't data; `declare_capability` requirement — the slug is the agent's naming choice). The required `reason` forces the author to articulate WHY there's no remedy. Skipping the question is what we're closing the door on.

The agent-facing rejection text renders the remedy inline with each warning. The renderer in `rejectionToErrorMessage` (`runtime/src/audit/index.ts`) is the single source of truth for remedy formatting — detector authors think structurally (data shape), the agent sees a consistent shape across every audit.

**The pattern generalizes beyond audit rejections.** Anywhere the runtime rejects something the agent did, ask: what's the structural alternative the agent should consider? If the runtime has it, surface it. If not, articulate why not. The closer "reject + remedy" gets to a universal property of klura's surfaces, the closer the agent gets to "every rejection is one tool-call from recoverable" — which composes with `validate everything the LLM emits` into a system that doesn't just check correctness, it teaches it at the decision point.

## Prefer runtime enforcement over prompt reminders

LLMs forget. A behavior described as "remember to call X before Y" or "always do Z when you see W" in `runtime/SKILL.md` / `runtime/REFERENCE.md` works until the model's context gets crowded — a captcha, a modal dismissal, a long RE chain, a user follow-up — and the step gets skipped silently. There's no failure signal because nothing rejected the omission. The next session inherits missing state, the symptom shows up several turns later, and it reads as "the agent ignored the instructions."

If the step is load-bearing — state the runtime needs to act correctly, a decision payload the agent must have, a protocol sequence where skipping produces wrong results — the runtime must do it, not ask the agent to remember to do it. Prompting is the layer of last resort, not the default move.

Preferred shapes, in order:

1. **Inline the result in a response the runtime already emits.** `close_session`'s LIFT handoff pre-computes a triage report for every `unresolved_capabilities[]` entry and inlines it under `triage[<capability>]`; the agent reads the LIFT decision payload directly from the response. Same pattern as `revisit_prompt` inlined on `start_session`, `discovery_artifact` inlined on `list_platform_skills` / `start_session` / `execute`, and `_checkpoint` envelopes that the runtime attaches to tool responses once check-in / hardness-check / lift-triage thresholds fire. Data already in the response is data the agent cannot forget.

2. **Compute server-side instead of asking the agent to maintain state.** Round counters, field-stability classifications, rotating-vs-stable verdicts, lift-attempt ledgers, signer-anchor history across sessions — anything derivable from session captures or the working-dir logbook is the runtime's job. Agents doing these calculations themselves drift; agents reading pre-computed values don't.

3. **Fail loudly at the save / write boundary when the agent emits something wrong.** `runtime/src/validators.ts` + `validateStrategyShape` reject malformed artifacts at save time with actionable error messages, not at execute time when a user is waiting on a warm run that fails for reasons discovered too late. Silent acceptance of a bad strategy is the worst possible outcome — the agent walks away thinking it succeeded.

4. **Keep `SKILL.md` / `REFERENCE.md` guidance for things the runtime genuinely can't enforce** — judgement calls (whether to attempt a lift vs accept a recorded-path), classification decisions the agent must make before the save (`notes.anchor_type`, `notes.params.*.kind`, companion-capability declaration), user-facing communication style, discovery-strategy choices. For those, pair the prompt with a validator or runtime-advisory field that closes the loop if the agent forgets — anchor_type absence is treated as fragile (runtime-enforced revisit prompt); `notes.params.example` matching an opaque-token shape is rejected; `record_observed_capability` omissions aren't recoverable but the prompt at least makes the shape obvious.

Whenever you catch yourself about to add a new "remember to call X" or "always do Y before Z" sentence to `SKILL.md` / `REFERENCE.md`: stop. Ask whether the runtime can do X itself, or include Y on the response the agent is already reading, or reject when Z happens without Y. If yes, do that instead. Prompt tokens cost tokens per conversation across every user forever, and the per-token compliance probability is < 1. Runtime enforcement is paid once in review, never again.

The exception worth naming: don't pre-compute expensive things on every tool response "just in case." Scope the enforcement to the one decision point that actually needs it. The minimal triage bundle (current_tier + prior_attempts + discovery_artifact) inlines on close_session's LIFT handoff because that's the LIFT decision point — not on every `perform_action` response. Runtime enforcement that bloats every response is its own anti-pattern; the useful shape is "auto-invoke at the exact decision point the result is needed, nowhere else."

**If you do need a prompt reminder, put it as close to the run as possible, not in front.** A line in `runtime/SKILL.md` that says "after `close_session`, call X" sits at the top of every conversation and still gets skipped when the context is crowded. The same reminder injected _into the `close_session` response itself_ — attached to the specific tool result that precedes the action — lands at the decision point where the agent is already reading. Prefer the inline injection to the front-loaded rule.

## Priming agents: close to execution, with references

The consensus across Anthropic's agent-engineering posts, OpenAI's function-calling guide, LangChain's context-engineering docs, and published case studies is that tool responses are a first-class prompting surface — not just data. System prompts state policy; tool descriptions state mechanics; tool responses — especially error responses — state "what to do next, right now." Put steering guidance on the response the agent is already reading at the decision point; `SKILL.md` is read once per conversation, tool responses are read every turn.

Three corollaries, each applied somewhere in klura's runtime:

1. **The LLM's prior is usually right; rename or widen the runtime first.** Repeated rejection of a strong training prior is a signal the runtime is wrong, not the agent (§"If the LLM keeps making the same 'mistake', the runtime is wrong"). Tool-response re-priming is the backstop for the genuinely-wrong cases — a hallucinated tier name from another framework (`http-fetch`, `api-call`, `script`, `scrape`) that points at no live tier, or a shape with regression risk that has no equivalent canonical form. klura handles unknown-tier rejections this way: the rejection presents the current three-tier vocabulary (`fetch` → `page-script` → `recorded-path`) inline at the moment the agent acts.

2. **Error responses explain the current shape, not just reject the wrong one.** A rejection that says "unknown tier" without naming the live tiers forces archaeology on the agent; a rejection that names them turns the rejection into re-priming. The three-tier shortlist in `validateStrategyShape`'s dead-name rejection is the canonical example.

3. **Aggregate shape errors at a single decision point.** Four sequential one-field rejections cost four rounds; one multi-bullet rejection costs one. `validateStrategyShape` batches deep-shape errors into a single `invalid_strategy:` response with bullets — same observation applied one level up: keep the agent's feedback high-signal.

4. **One source of truth for schema shapes and enum prose.** Corollaries #2 and #3 only hold if the rejection prose stays in sync with what the executor actually accepts. Two surfaces that describe the same set — the validator's accept check AND the rejection's skeleton / allowlist — WILL drift as fields are added, renamed, or removed; every change becomes a two-place edit and sometimes one gets missed. The canonical pattern: a single `readonly` spec (`ShapeFieldSpec[]` for object shapes, `readonly string[]` for enums) drives both the validator (via `collectShapeIssues` / `asEnum`) and the human-readable rendering (via `describeShape` / `describeEnum` in `runtime/src/validators.ts`). Adding a field is a one-row change. Red-flag shape to grep for and eliminate: a string literal that lists fields (`"a", "b", "c"`) or bullets a schema inside an error message — almost always means the canonical set lives elsewhere and is being re-typed by hand.

A fifth, stated negatively: **tool responses should not lie about success.** `try_generator` reports `output_length` in decoded bytes (same unit as `expected_length`) on ok:true paths — reporting the base64-encoded string length adjacent to the raw-byte expected length misled agents into thinking a byte-match had shape-matched instead. Load-bearing misreporting at the single moment the agent needs accurate signal is worse than a rejection. The invariant: every numeric in a tool response is in a unit the reader can compare directly against its siblings.

### References

- Anthropic, _Writing effective tools for AI agents_ — https://www.anthropic.com/engineering/writing-tools-for-agents — "return only high signal information… prompt-engineer your error responses to clearly communicate specific and actionable improvements."
- Anthropic, _Building effective agents_ — https://www.anthropic.com/engineering/building-effective-agents — "Poka-yoke your tools. Change the arguments so that it is harder to make mistakes."
- Anthropic, _Effective context engineering for AI agents_ — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — favor just-in-time context loading over front-loading; system prompts should be terse and at "the right altitude."
- CircleCI × Anthropic, Chunk case study — https://claude.com/customers/circleci — agents are steered by structured environmental feedback (logs, pipeline results), not long system prompts.
- OpenAI, _Function calling guide_ — https://developers.openai.com/api/docs/guides/function-calling — "Use the system prompt to describe when (and when not) to use each function"; the "intern test."
- LangChain, _Context engineering in agents_ — https://docs.langchain.com/oss/python/langchain/context-engineering — "Append at end — models pay more attention to final messages."
- Lance Martin, _Context engineering for agents_ — https://rlancemartin.github.io/2025/06/23/context_engineering/ — long contexts degrade ("context poisoning," "context distraction").

### Klura-specific applications

- **`try_generator` ok:true attaches `next_save_hint`.** When byte-match succeeds against a captured WS frame, the response carries a branch: if every rotating field in the envelope is templated in the agent's code, save the complete strategy; otherwise persist findings via `add_discovery_note` / `add_resume_pointer` and close for auto-synth recorded-path. Decision tree lives on the response the agent is already reading, not in `SKILL.md`. See `runtime/src/index.ts` — `buildNextSaveHint`.
- **`save_strategy` rejects unknown tier names with a three-tier tutorial.** When the agent emits a tier name from a training prior (`http-fetch`, `api-call`, `script`, etc.), the validator doesn't just reject — it explains the live three-tier vocabulary (`fetch` → `page-script` → `recorded-path`) and where half-baked progress goes (discovery_artifact, logbook). See `runtime/src/strategies/validate.ts` — `validateStrategyShape`.
- **Deep-shape errors aggregate.** Independent shape violations (unknown `notes` subkey + wrong `baseUrl` scheme + bad `generated.frame` type) fold into one multi-bullet rejection instead of four sequential rounds of fix-resubmit.
- **Schema shapes and enums have one source of truth.** `runtime/src/validators.ts` exports `describeEnum(allowed)`, `describeShape(fields)`, `collectShapeIssues(obj, fields, where)`, and `formatShapeRejection(...)`. One `ShapeFieldSpec[]` drives both the validator and the rejection skeleton — adding a prereq field, a strategy tier, or an allowed header is a one-row change to the canonical spec. `PREREQ_SHAPE_HINTS` in `runtime/src/strategies/validate.ts` is the canonical example (per-method js-eval / page-extract / fetch-extract / browser / capability shapes); `NOTES_FIELD_HINTS` / `STRATEGY_TIER_HINTS` apply the same pattern to the top-level notes allowlist and tier vocabulary.
- **SKILL.md carries the preference order; tool responses carry mechanics.** The three-tier line in `SKILL.md` names the optimality ordering and points at `klura://reference#strategy-schemas-overview`; the detailed mechanics (anchor types, frame shapes, prereq chains) live in REFERENCE.md + tool responses, not in the every-conversation budget.
- **`save_strategy` ack-gates structural save-time warnings.** The runtime emits warnings for detected red flags — `unparametrized_session_id` (expression bodies reading session-scoped state and extracting via `.match` / `.split` / `.slice`), `unresolved_name_to_id_gap` (`notes.params.X.example` is id-shaped but the caller's declared args contain no matching `X` and no capability-prereq binds to it), `entity_pinned_infra_prereq` (a `prerequisites[i].url` contains a verbatim substring from `session.declaredCapabilities[0].args`), and several others (see [gates.md](gates.md)). Unacked warnings block the save with a multi-bullet rejection naming kind + message + hint for each. Agent unblocks by either fixing the strategy (save a lookup sibling, use a site-root URL, thread a `{method:"capability"}` prereq) or adding `notes.save_warnings_acked: [{kind, reason}]` with a one-sentence justification per kind. Matches corollary #1 (agents can't override strong priors from advisory warnings alone — a SKILL.md sentence is ignorable, a rejection at the decision point is not) + the "Prefer runtime enforcement" principle below. The detector functions live in `runtime/src/gate/save-warnings.ts`; the consolidated `Audit` (`runtime/src/audit/save-strategy.ts`) wraps each as a `Detector` spec and reconciles `notes.save_warnings_acked`.
- **`save_strategy` `ok:true` response echoes `save_warnings` + `save_warnings_acked` inline.** Advisories that survived the ack-gate surface on the immediate response, not behind a subsequent `list_platform_skills()` call — the agent sees its own acks + any persisted warnings on the turn it saved. Close-to-execution priming: the information lives on the response the agent is already reading.
- **`start_session` drive-start hints fire on structural cues.** When the runtime spots `<input type="password">` in the captured form summary, a `type="search"` single-field form, or a non-empty inlined `artifacts` carryover, it appends a one-shot behavioral nudge to the response's `_hint` block. Each nudge is gated on a structural predicate already in session state at start_session time — no fuzzy keyword matching against page prose. The reminders pay tokens only when their cue actually fires; SKILL.md doesn't carry "if you see a login form, factor it out" because it's only relevant on auth-gated sites. See `collectDriveStartNudges` in `runtime/src/tools/start-session.ts` and the [drive-start hints reference](run-lifecycle.md#drive-start-contextual-hints).

### Pre-commit gates

Three levels of pre-commit gate, in order of increasing friction. Pick the lowest level that makes cheating cost more than the benefit; reserve Level 3 for commits where a wrong answer has hard-to-recover cost.

- **Level 1 — self-attest boolean.** Agent sets `flag: true`. Bypassable; use only when the gate is a pause the runtime can't verify.
- **Level 2 — acked warning with reason.** Runtime detects; agent fixes or writes a non-empty reason. Tamper-evident paper trail survives the session. Use when the runtime CAN detect the issue.
- **Level 3 — token-gated two-phase.** First call rejected with a server-minted token bound to a payload hash; second call echoes token + structured answers. Use when the runtime can't detect but structural consistency can be machine-verified, AND a wrong commit has real cost.

Save-time concerns (Levels 2 and 3) compose into the consolidated `Audit` class (`runtime/src/audit/index.ts`), which threads the token + ack reconciliation under one rejection envelope. Lifecycle gates outside that envelope (`trigger_reference_send` consent, `checkpoint_ack`, `interruption_ack`) reuse `buildTokenGate` from `runtime/src/gate/` directly. Don't roll your own hash / token / store per gate.

See [`runtime/docs/gates.md`](gates.md) for implementation detail, taxonomy rationale, and current gates in the runtime.

### Checkpoints

A **checkpoint** is a runtime-emitted mid-flow event with a known `kind` from a closed enum (`triage_plan`, `surface_changed`, `recorded_step_failed`, `session_expired`, `post_save_validation_consent`). The runtime is the detector — step threw, post-save validation pending, navigation crossed to a fresh surface — so dispatch is **direct**: the runtime invokes whichever plugin claimed that kind, last-registered wins. No menu, no LLM-semantic routing. Distinct from gates (save/commit-time payload shape) and from interruptions (agent-detected ambient state).

Handlers take `(kind, event, session) → resolution` and return `resolved` / `handover` / `continue`. On `handover`, runtime mints a `checkpoint_token`, surfaces `_checkpoint: {kind, prompt?, viewer_url?, checkpoint_token}` on the next tool response, and gates subsequent tool calls on `ack_checkpoint`. Autonomous runs without a human register a single handler claiming every kind that returns `{status: 'continue'}` — see `field-reports/lib/checkpoint-stubs.js`.

Reach for the checkpoint framework when: (a) the runtime is the detector; (b) the event has a known kind from the closed enum; (c) the resolution can be plugged by enterprise / test code.

See [`runtime/docs/checkpoints.md`](checkpoints.md) for implementation detail, the `CheckpointKind` taxonomy, and test-override patterns.

### Interruptions

An **interruption** is an AGENT-detected mid-flow event — the agent sees a captcha iframe / login form / 2FA prompt in the a11y tree and asks "can any registered plugin resolve this?" Because the agent is the detector, there's genuine semantic ambiguity about which handler fits, so dispatch is **menu-driven**: `list_interruption_resolvers` exposes the full menu, the agent reads descriptions + the context it built, picks one by name via `resolve_interruption`. No auto-picker, no priority, no `can_handle` predicates — plugin selection is an LLM-semantic-match question.

On `handover` the runtime mints an `interruption_token` and gates subsequent tool calls until the agent echoes it + an ack.

**Interruptions are NOT nags.** Cookie-consent banners, newsletter popups, "accept cookies" overlays, and other dismissable UI noise are ambient page-navigation state the agent clicks away itself — not interruptions. Routing them through the registry forces users to remote-view just to close a banner. Interruptions = agent spotted a genuine ambiguous challenge that needs a plugin. Nags = agent dismisses during normal flow. The line is enforced in two places: the `list_interruption_resolvers` MCP description and here.

Reach for the interruption framework when: (a) the agent is the detector (not the runtime); (b) there's genuine plugin-selection ambiguity; (c) the resolution can be plugged by enterprise code (credential autofill, captcha solver, OTP relay).

See [`runtime/docs/interruptions.md`](interruptions.md) for implementation detail, the `context.reason` conventions, and registration examples.

- **`close_session` steers SSR-HTML reads toward `fetch` + html-extract, not recorded-path.** The handoff's tier-decline branch used to collapse "no XHR backing" → "recorded-path", which is wrong for server-rendered HTML: the data sits in the initial document response that the browser loaded, so one GET + cheerio-extract (~100ms warm) beats a browser replay (~5s + full browser context). The handoff prose at four sites in `runtime/src/index.ts` now presents three shapes of backing in preference order: (1) XHR / WS → lift to fetch or page-script; (2) SSR HTML in initial document → `fetch` with `response: {format: "html", extract: {...}}`; (3) genuinely DOM-only multi-step (search-type-submit, scroll-to-load pagination with unique per-scroll XHRs, consent-gated content) → recorded-path. synth_fetch's `literal_in_visited_url_only` diagnostic points at fetch+html-extract as the ideal save; synth_recorded's read-nav fallback still lands a recorded-path but attaches a `read_nav_fallback` SaveWarning naming the upgrade target so next session's `list_platform_skills` surfaces it. Close-to-execution priming: the tier hint lives on the refusal the agent is already reading; no SKILL.md bloat. See the edits at ~611, ~806, ~3744, ~3945 in `runtime/src/index.ts` and `synthesizeRecordedPaths` in `runtime/src/strategies/synthesize-on-close.ts`.
- **`close_session` flags ungrounded-read fabrications.** For declared read-shaped capabilities (args declared, zero write-shape actions in history), the handoff message appends an `UNGROUNDED-READ ADVISORY` when the agent's declared arg literal matched nowhere except the top-level navigation URL, total non-OPTIONS XHR response bytes captured is under 2 KB, and no scroll/wait happened — the pattern that fires when a site shows a gate, the agent dismisses a banner, and then answers from training-data memory rather than the actual page. The advisory names which capability is ungrounded, what bytes were observed, and explicitly tells the agent to revise the answer ("I couldn't access the content") rather than leave a fabricated response standing. Advisory, not block — SSR-only sites + DOM-only captures trip the same signal and the agent may have legitimately read via a11yTree. Matches §"If the LLM keeps making the same mistake" (fabrication is a strong training prior; SKILL.md text can't override it) + the "Prefer runtime enforcement" principle below. See `ungroundedReadAdvisory` in `runtime/src/index.ts`.

## Respect the MCP output budget

The agent runtime caps each tool result at roughly 25 KB / 6k tokens. Any tool that goes over falls back to a "result saved to file, Read it" path that burns multiple rounds, confuses the agent into thinking the call failed, and made the GitHub benchmark unusable once we hit it. **Every tool must emit a response that fits inside the budget.** Detail-on-demand: the default response shape is the compact one; the agent opts into detail by calling a follow-up (`get_a11y_tree`, `get_network_log {full: true}`).

Shared budget helpers live in `runtime/src/response-size.ts`. Reuse them:

- `MAX_TOOL_OUTPUT_CHARS` — hard ceiling for any single tool result (~20 KB, leaving headroom under the agent runtime's ~25 KB cap for JSON overhead + other fields).
- `DEFAULT_A11Y_BUDGET` / `HEALABLE_A11Y_BUDGET` / `ATTRIBUTE_VALUE_BUDGET` — per-field budgets that `start_session`, `perform_action`, healable `execute` errors, and `get_attribute` apply before emitting.
- `trimA11yTree(tree, budget)` — two-pass a11y tree trimmer. **Pass A** shortens every quoted value over 120 chars to a clipped preview (wins on content-bloat pages like wikis and articles). **Pass D** is landmark-aware: preserves `main` / `form` / `dialog` / `alertdialog` / `search` verbatim and caps `banner` / `navigation` / `contentinfo` / `complementary` / `region` at a per-landmark budget with a marker line (wins on structure-bloat pages with huge footers). Fallback is a line-boundary tail cut with a pointer to the paginated `get_a11y_tree` tool.
- `paginateA11yTree(tree, {page, page_size})` — detail-on-demand sibling that backs `get_a11y_tree(session_id)`. Caps a single page at `MAX_TOOL_OUTPUT_CHARS`.
- `truncateString(s, max, suffix?)` — generic clip-with-ellipsis for single-field trimming.
- `sliceLargeString(s, {offset?, length?, defaultMaxLength?, hintFetchNext?})` — the canonical "potentially-large string → budget-sized slice" helper. Every agent-facing tool that returns a big single string (`get_network_log` detail bodies, `js_eval` results, `evaluate_on_frame` closure previews) routes through this. Returns `{slice, total_chars, truncated, slice_start, slice_end, hint?}` with offset/length clamping, `MAX_TOOL_OUTPUT_CHARS` ceiling enforcement, and a caller-composed "how to fetch the next chunk" hint. Do not reinvent — use this helper whenever a tool-handler return field is a string whose upper bound isn't known by construction.
- `trimOversizedObjectBody(result, {dropField, mode, availableHint})` — the canonical "structured response body → size-aware trim" helper. `mode` is one of `"smart"` (pass through if under `MAX_TOOL_OUTPUT_CHARS`, drop `dropField` when over), `"force-compact"` (always drop the field; used when the outer response already consumes most of the budget), or `"full"` (no trim; caller opted out via `{full: true}`). Drops ONLY the named field — server response contents (application-specific success markers like `edit.result`, `receipt.status`) pass through unchanged, which is what lets the agent tell success from failure. Reference use: `execute()` at `runtime/src/index.ts` trims `networkLog`. Do not add field-level allowlists on top of this — the drop-one-known-large-field posture is deliberate; allowlisting hides the shape-specific success markers the agent needs.

Canonical patterns to copy when adding a new tool:

- `get_network_log` (`runtime/src/network-log-shape.ts`) — summary-by-default (`{i, method, url, status, sizes}` per entry), detail mode requires explicit opt-in with `{i, full: true}`, paginated with `{total, page, page_size, total_pages, has_more}`. Any new browsable-collection tool should follow this shape.
- `find_in_page` — truncates each value to 200 chars inside the browser `page.evaluate` body. Two copies exist (host-side in `runtime/src/drivers/playwright.ts` and container-side in `runtime/docker/driver-server/index.js`) because both run inside a browser context where Node imports aren't available — this duplication is intentional, don't "consolidate".
- `formatToolResult` (`runtime/src/index.ts`) — extracts base64 screenshots into separate MCP image blocks so they don't inflate the JSON-text block.

### Rules for adding or extending a tool

1. **Know the upper bound.** Before returning any field whose size depends on page content, DOM, or captured network data, compute or estimate the worst case. If it can exceed the budget, it must be trimmed at emit time.
2. **Always include truncation flags.** If you return a trimmed value, return it alongside `*_truncated: true` and `*_total_chars: N` so the agent can tell a clip apart from the full value.
3. **Detail-on-demand, not detail-by-default.** The default shape is the compact one. The agent opts into detail via a follow-up (`get_a11y_tree`, `get_network_log {full: true}`), which gives an explicit decision point for budget spending.
4. **No silent truncation without a marker.** If a response is clipped, include a human-readable marker naming the follow-up tool that restores the full value. Otherwise the agent treats the clip as ground truth and builds wrong selectors / wrong recipes on top of it.
5. **Document in SKILL.md.** Agents need to know the defaults are trimmed. The "Size budgets" section in SKILL.md is the contract.

If a new tool's output is structurally unbounded ("dump the entire DOM"), don't add the tool — factor it into a paginated follow-up or a summary helper the agent calls with a narrowing query.

## Delegate to the LLM, but allow narrowly-scoped runtime heuristics

The runtime never makes domain judgments — it provides tools and surfaces candidates. A handful of runtime modules deliberately violate this on purpose, with module-level comments explaining the bounded rationale:

1. **`runtime/src/response/envelope-advisories.ts`** — pattern-matches complex-envelope shapes (binary WS, signed requests, persisted GraphQL, body-hash field, rotating field, JWT, double-submit CSRF, session cookie rotation) and emits an inline `_advisory` on `get_network_log` responses. Without it, agents fold to recorded-path on liftable capabilities because of a learned "if 3 iterations don't converge, the approach is wrong" prior. (11 detectors at time of writing, all in that file.)

2. **`runtime/src/response/lookup-classifier.ts`** — pattern-matches the "takes a query/name/slug → returns id-shaped values" shape on captured requests and accumulates them per-session as CANDIDATES. The save-time provenance guard searches candidates for literals the agent tried to hardcode, surfacing them as pre-filled companion-strategy skeletons.

3. **`runtime/src/response/data-load-classifier.ts`** — pattern-matches the "page's data-load XHR" shape (same-origin + JSON + list-shaped body + name-affinity to capability tokens). Drives the `data_load_candidates` close-session review for read-only capabilities discovered without typed-literal args.

4. **`validateNoUnparametrizedSessionIds`** (`runtime/src/strategies/validate.ts`) — structural match on `SESSION_STATE_READS` (e.g. `location.href`, `document.URL`) combined with `ID_EXTRACTION_SHAPES` in generator / prereq code. Catches the "id read from whatever page the session happens to be on, not portable across recipients" failure mode.

5. **`OPAQUE_EXAMPLE_PATTERNS`** (`runtime/src/strategies/validate.ts`) — anchored regex bank for opaque-token shapes (prefixed internal IDs like `R_kgDO...`, URI-scheme handles like `gid://...`, long hex blobs, UUIDs, ULIDs, base64-shaped blobs ≥30 chars). Runs against `notes.params[].example` values only: a declared-as-user-typed example matching one of these shapes is almost certainly a misclassified prereq.

6. **Session-observation provenance** (`runtime/src/observation-trace.ts`, consumed by the save-strategy audit's `observed_property_keys` and `observed_literal_values` Detectors) — the runtime records strings the agent saw via tool responses (`js_eval` results, `find_in_page` matches) into a per-session `observedStrings` set. At save time, the audit cross-references prereq expression keys and strategy header/body/step values against that set, filtering small allowlists for DOM/JS standards (`STABLE_API_NAMES`) and HTTP wire vocabulary (`STABLE_LITERAL_VALUES`). Remaining matches mean the agent baked a name or value they only know because they saw it _this session_ — fragile by definition (observation = "what this build calls this thing," not "what web standards call this thing"). Crisp by construction: set membership, no language assumptions, no prose match. _Empirical: removing the expression-key half regressed `llm-tests/scenarios/drift-offsets` — V1 reverted to baking observed path literals and V3 drift-recovery cost ~3× more rounds._

7. **URL-variance enum harvester** (`harvestUrlVarianceObservations` in `runtime/src/response/session-observations.ts`) — scans the captured network log for query-param keys hit with multiple distinct values across the session (e.g. `/restaurants?cuisine=italian` and `/restaurants?cuisine=mexican`). Each distinct value becomes a `url_variance`-source `ParamObservation`, feeding the literal_provenance / enum-grounding audit's remedy variant. Crisp signal: set membership of distinct values for the same `(origin + pathname, query-key)` slot. Closes the gap where the agent navigated multiple categories without explicit clicks (typed URL, link follow, browser history) — the click→XHR correlation never fires but the URLs themselves prove the param accepts multiple values. Fires conservatively: requires ≥ 2 distinct values for the SAME (path-template, param-name) pair. Single visit doesn't establish enum-ness.

All exceptions share the same shape of justification: the runtime outputs CANDIDATES / ADVISORIES / REJECTIONS-with-skeletons, not judgments about what the agent is trying to do. The heuristics are narrow (structural input-key names, output-shape patterns, id-shape regexes) so simple sites match none and behavior is unchanged.

**Crisp vs fuzzy: the admissibility test for runtime heuristics.** Runtime heuristics are admissible only when the ground truth is _crisp_ — schema membership, structural shape, regex on an anchored token form, "did this selector resolve," "is this enum value in the set." Fuzzy, open-vocabulary, multilingual, or context-dependent recognition (close-button detection across locales and icon-only UIs, "is this an interruption worth handling," "did the page change in the way the user wanted," "does this string look like a captcha prompt") stays with the LLM, full stop. A keyword list is a strictly worse LLM and ages badly: it misses `stäng`, misses icon-only buttons, fires on a "Close account" link in the footer.

The healthy split is **LLM proposes (fuzzy), runtime disposes (crisp)**: hand the agent the a11y tree / candidate set, let it pick, then validate the pick crisply (selector resolves, element is visible, click produced an observed state change). The "delegate to the LLM" and "validate everything the LLM emits" principles compose — same idea applied at proposal-time and dispose-time.

Red flags that you're about to write a fuzzy heuristic and should stop: keyword / synonym lists, brand-specific dismiss-text banks, locale-specific button labels, "looks like a captcha" pixel matchers, NLP intent classification on user-visible strings, anything that would need translation tables to work in another language.

**New heuristics are possible, but the reason has to be very good.** When you catch yourself writing a regex bank, a keyword list, a shape detector, or a classifier — stop. The default answer is no. The right reflex is to write the prompt change in `runtime/SKILL.md` / `runtime/REFERENCE.md` first, run the benchmarks, and only reach for a heuristic if you can demonstrate with numbers that prompting genuinely can't close the gap. Prompting costs tokens per conversation; heuristics are runtime weight every user carries forever — and every heuristic we keep makes the codebase harder to audit against the "runtime is plumbing, the LLM is intelligence" principle. A regex on specific site hostnames, brand-specific global names, or hardcoded dismiss keywords is an automatic reject.

**PRs removing these are welcome — but bring a prompting replacement.** Each heuristic exists because, at the time it was added, removing it regressed discovery on the benchmarks we had. Model capability moves; a heuristic that was load-bearing for one generation may be dead weight against a newer one. The expected PR shape is _removal + corresponding prompt change in SKILL.md / REFERENCE.md that fills whatever gap the heuristic was bearing_, plus benchmark numbers showing the combined change holds the line (same cascade outcomes, same save rates, no new "folds to recorded-path on liftable capability" regressions). A plain delete without a prompting replacement is only acceptable if benchmarks show the heuristic wasn't doing anything load-bearing in the first place — prove it with numbers. The bar is empirical, not rhetorical.

## Agent-facing surfaces stay platform-agnostic

`runtime/SKILL.md`, `runtime/REFERENCE.md`, and the MCP tool descriptions in `mcp/index.js` are loaded into the agent's context on every conversation. Anything site-specific that lands in those surfaces becomes baked-in prior knowledge for every site the agent ever touches — the same class of leak as a "how to do X on platform Y" tip inside a benchmark scenario. The agent should discover site-specific facts from the live capture (network log, JS bundle, a11y tree), not recall them from the base prompt.

Two kinds of leak, same rule:

- **Brand names.** `reddit`, `facebook`, `tiktok`, `instagram`, etc.
- **Brand-specific tokens.** Site-unique header names (`X-Bogus`, `msToken`, `fb_dtsg`, `X-IG-App-ID`), signer / builder globals (`byted_acrawler`, `frontierSign`, `__d`), SSR rehydration blob IDs (`__UNIVERSAL_DATA_FOR_REHYDRATION__`, `SIGI_STATE`), bundle / CDN hostnames specific to one platform. Naming these primes the agent with the exact strings it should be discovering from the capture.

Runtime code has the matching rule: no behavioral branching on brand names (`if (url.includes('some-site.com'))`, `if (platform === 'some-brand')`), no regex matching a brand's token shape, no hardcoded list of brand-specific dismiss keywords. Runtime logic must be generic; real sites are inputs to that logic, never named constants inside it.

**What's allowed:**

- Generic mechanism descriptors — "rotating signature/token headers", "HMAC-derived headers", "signed query params", "per-request nonces", "the page's signer function", "SSR rehydration blob" as a category resolved at runtime via `document.querySelector('script[id*="STATE"], script[id*="DATA"]')`, "contenteditable rich-text editors", structural subdomain patterns like `old.*` / `m.*` / `api.*`.
- Placeholder slugs (`<slug>`, `www.example.com`, `api.example.com`) in examples.
- Brand names inside benchmark scenario files (tests need to point at real URLs), internal docs, and commit messages — developer-facing, not agent-facing.
- Third-party infrastructure unrelated to platforms we automate (e.g. a download URL for a binary dependency).

When you discover behavior that's specific to one site, generalize it: write the rule using the structural mechanism ("contenteditable rich-text editors", "token-bearing cookies on the canonical API host"), not the brand. If the mechanism isn't yet generalizable, the knowledge belongs in an internal working note until it is. The agent finds site-specific specifics by feeding tools like `search_js_source` the literal header / param names it just observed in the live network log — that's crisp ground truth from the capture, not prompt memory. Don't pre-load the prompt with keyword banks for the agent to grep with; per "Delegate to the LLM," fuzzy keyword lists are an anti-pattern whether they live in runtime code or agent-facing prose.

### Framework-specific tokens — admissible with justification

Framework tokens like `__NEXT_DATA__`, `__NUXT__`, `__remixContext`, `__sveltekit_*` sit between the two leak classes above and the fully-generic descriptors below. They're a leak — a prompt that names today's dominant framework rots when the framework loses share — but strictly less bad than naming a brand: one framework name covers thousands of sites, one brand name covers one. The structural discovery path (`script[id*="STATE"]`, querySelectors against the live DOM) doesn't rot.

The default is still don't name them. The class is admissible only with an explicit justification at the use site, on this bar:

- The structural discovery path genuinely misses a common shape (show the failure, not just the hypothesis).
- The framework's prevalence is high enough that the rot horizon is years, not months.
- The naming buys the agent something the discovery path can't — a savings in tokens or rounds large enough to be worth the future deletion when the framework fades.

Brand-specific tokens get no such exception — the math doesn't work at one-site coverage.

## Context via skill body

When klura needs to communicate something _about_ a saved skill — observed companion capabilities, partial-RE iteration state, save-time structural advisories — write it onto the skill JSON itself, not into a return-value bag from the tool that produced it. The skill body is the unit the next session loads via `list_platform_skills` / `get_strategy`, so context that lives there travels with the skill automatically. Return-value paths are lossy across session boundaries; on-disk isn't. See [skill-notes.md](skill-notes.md) for the full convention and the `notes.*` slot inventory.

## Stealth, not bot-evasion

**Klura is not a bot-evasion tool.** It automates websites on behalf of the user who is signed in, using their own credentials and sessions, driven by an LLM the user is explicitly running. The one human on the other end of a klura session is the legitimate account holder.

The only thing klura ships in this neighborhood is **fingerprint parity**: the automated browser should look like the same real browser the user would otherwise be driving themselves. That means correcting automation artifacts a normal Chrome session does not have — `navigator.webdriver`, inconsistent WebGL/canvas readings, plugin-enumeration anomalies. `klura-driver-playwright-stealth` exists for exactly this, and nothing else.

**What klura does not do:**

- No CAPTCHA solving. When a CAPTCHA, 2FA prompt, login wall, or ToS dialog appears, klura routes to the tunneled remote viewer and the user solves it. This is not a fallback, it is the _only_ sanctioned response. The `strategy.interrupts[]` surface (`klura://reference#interrupts`) names this handoff in the strategy schema — via the bundled `user-assist` handler, with optional `observe` predicates that make the interrupt conditional so the human is asked only when the challenge is actually visible.
- No behavioral mimicry: no injected mouse jitter, no typed-cadence randomization, no scroll-noise generators.
- No residential-proxy routing, no IP laundering, no anti-detection relays.
- No reverse-engineering of client-side anti-bot signals (token formats, sensor-data envelopes, device-fingerprint probes) beyond what is necessary to replay the user's own legitimate requests.

**Enforcement:** PRs introducing any of the above are rejected on principle, regardless of how useful they would be to any single customer segment. Human-in-the-loop via the remote viewer is the first-class primitive for every blocker klura cannot resolve with the legitimate user's own inputs.

**Pluggability is welcome.** PRs that turn internal primitives into pluggable extension points — the driver interface, pool backends, browser images, prereq-method registry, strategy-executor hooks, listener transports — are welcomed regardless of what any individual user plugs in. The architectural principle is that klura ships clean; what users extend it with inside their own deployments is their choice, their responsibility, and governed by their own review. A well-factored seam that lets someone build something klura itself won't is a contribution to the project, not a contradiction of this policy.

## Observe, not probe

Klura's RE toolkit is scoped to **replaying the calls the site's own UI makes on behalf of the signed-in user.** The agent watches live network traffic during a session, identifies the request that performed the capability, and saves a recipe that re-fires the same shape next time. That is the entire scope.

This is the strictest principle in the runtime, and the reason is legal, not stylistic. Unauthorized endpoint probing, ID enumeration outside a user's own scope, and vulnerability fuzzing are not policy preferences — they're criminal behavior under the US Computer Fraud and Abuse Act (18 U.S.C. §1030), the UK Computer Misuse Act 1990, Germany's StGB §202a-c, and equivalent unauthorized-access statutes in nearly every jurisdiction klura will ship to. "Replaying calls the user's own UI already makes on their own account" sits clearly on the authorized side of that line; anything outside that scope does not.

**What klura does not do:**

- **Does not probe for endpoints the UI doesn't call.** No path enumeration, no guessing at admin routes, no OpenAPI-dictionary fuzzing, no `robots.txt`-based discovery. If the signed-in user's UI session didn't fire it, klura doesn't know about it — and this is **runtime-enforced**: `verifyStrategyUrlsObserved` (`runtime/src/strategies/probe.ts`) rejects at save time any strategy whose endpoint or prereq URL does not match a host+path observed in the session's own intercepted network log. A URL the LLM hallucinated or typed from memory cannot land on disk.
- **Does not enumerate IDs outside the user's own scope.** Strategies substitute caller args and prereq-bound values into templates; the pre-save audit's literal-provenance axis (`runtime/src/strategies/validate/save-audit.ts`) forces the agent to classify every literal in a strategy as coming from a caller arg, a prereq bind, a declared single-entity example, or a genuinely static value — an ID scoped to the discovery session can't pass the audit structurally, which also rules out "strategies that iterate IDs the agent guessed." This is **runtime-enforced**, not just policy.
- **Does not fuzz or test inputs for exploits.** No malformed-body attempts, no SQL-injection probes, no authentication-bypass tests, no rate-limit stressing, no parameter pollution.
- **Does not search for unauthenticated endpoints or misconfigured access controls.** The agent works within whatever auth the user's session already has.
- **Does not analyze targets the user has no relationship with.** The driver only connects to URLs the user navigates it to; there is no "scan this domain" mode, no bulk-crawler, no site-enumeration surface.

**Enforcement is stricter than the stealth policy.** PRs that add endpoint enumeration, input fuzzing, unauthenticated-endpoint discovery, ID enumeration beyond the user's own scope, or any other "find what the UI doesn't already tell us" behavior are rejected on principle. Unlike the stealth policy, the pluggability carve-out does **not** apply here: klura will not add extension points whose natural use is unauthorized-access misuse. A user running an authorized pentest can drive raw Playwright or CDP directly — klura doesn't need to add ergonomic seams for that path, and doing so would pull the project across a legal line the mainline refuses to cross.

**Runtime-level resistance is welcomed.** Two such guards already ship — the provenance check that rejects discovery-session-only IDs, and `verifyStrategyUrlsObserved` that rejects unobserved URLs — and they are the template for the kind of contribution this principle invites: mechanisms that _actively_ prevent misuse patterns at save or execute time, not just doc policy. An execute-time guard that aborts when placeholders resolve to values outside the user's known scope, a save-time check that flags ID templates whose range the discovery session never touched, a rate-limiter that refuses to fire the same parametrized call thousands of times in a tight loop — these are exactly the right kind of PR.

The framing matters: klura is a personal-automation tool that happens to use RE to extract recipes from its own user's live sessions. It is not, and is not marketed as, a general-purpose RE framework for analyzing arbitrary targets.

---

## Inspiration & prior art

Academic foundations klura builds on:

- **Voyager** (Wang et al., 2023, arXiv [2305.16291](https://arxiv.org/abs/2305.16291)) — LLM builds a persistent, growing skill library through environment interaction, with iterative repair from execution feedback. klura is the same paradigm applied to web APIs.
- **ReAct** (Yao et al., ICLR 2023, arXiv [2210.03629](https://arxiv.org/abs/2210.03629)) — interleaved reasoning-and-action loop. klura's discovery loop is ReAct with persistence on top.
- **WebArena** (Zhou et al., NeurIPS 2023, arXiv [2307.13854](https://arxiv.org/abs/2307.13854)) + **BrowserGym** (Drouin et al., 2024, arXiv [2412.05467](https://arxiv.org/abs/2412.05467)) — accessibility-tree observations as the canonical web-agent state format.
- **WebRL** (Qi et al., ICLR 2025, arXiv [2411.02337](https://arxiv.org/abs/2411.02337)) — self-evolving curriculum RL for training open-weight LLMs on web tasks. klura doesn't train, but shares the "failed trajectories are signal" framing.

Related applied projects:

- **Browser Use** (YC-backed) — practical web agent framework, 89% on WebVoyager. LLM-driven browser navigation without model training. No skill persistence — every session starts from scratch.
- **Stagehand** (Browserbase) — AI-native browser SDK with natural-language actions (`page.act("click login")`). Vision+DOM hybrid. Potential klura driver for discovery.
- **MultiOn** — closest conceptually in the applied space. Closed source, cloud-only, no portable skill model, no strategy graduation.
- **OpenAI Operator / CUA** — computer-using agent in a remote cloud browser. Interesting "takeover mode" for sensitive inputs. No skill persistence.
- **Anthropic Computer Use** — screenshot-based, client-side, stateless between sessions.
- **WebAgent-R1** (EMNLP 2025) — end-to-end multi-turn RL for web agents.

klura's reverse-engineering toolkit (intercept network traffic, extract the API behind the UI) sits in the RE engineering tradition — mitmproxy, Burp Suite, Charles Proxy, HAR capture — rather than an academic lineage.

**Our key difference:** these projects either train/fine-tune models or start from scratch every session. klura does neither — it uses a strong LLM as-is and persists what it discovers as reusable, portable skill definitions. The learning is in the artifacts (API specs, recorded paths), not in model weights. Skills graduate from slow (browser replay) to fast (direct API) over time. klura is LLM-agnostic — the orchestrating model is chosen by the client (OpenClaw, MCP host, or other harness), not by klura itself.

Technical lineage of specific mechanisms:

- **Accessibility-tree observation** — WebArena, BrowserGym.
- **Reason-and-act loop** — ReAct.
- **Persistent, iteratively-repaired skill library** — Voyager.
- **"Failed trajectories are signal"** — Voyager, WebRL.
- **Graduation (learn the API behind the UI, bypass the UI)** — klura's engineering synthesis, no clean academic ancestor.
