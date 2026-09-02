# Save-time validation

Everything the LLM writes goes through a layered validation pipeline before it lands on disk. Each layer catches a different class of hallucination, and error messages are phrased as actionable corrections — the agent reads the error, fixes the artifact, and retries `save_strategy` within the same discovery turn.

The full flow lives in `runtime/src/strategies/skills.ts:saveStrategy`. For the underlying validate-everything-the-LLM-emits principle, see [principles.md](principles.md). For health tracking after a strategy lands on disk see [health.md](health.md).

Audit rejection envelopes put concrete warning codes and their per-warning hints immediately after the not-committed status, before general retry guidance. This ordering keeps the required repair or acknowledgment visible when an MCP client compacts a long tool response.

---

## The five layers

**Layer 1 — primitive validators.** `runtime/src/validators/index.ts` is a tiny dependency-free module that provides `asPlatformSlug`, `asIdentifierSlug`, `asUrl`, `asEnum`, `asPositiveInt`, `assertNoReservedKeys`, and friends. Every LLM-supplied artifact (platform slug, capability name, identity key, secret-resolver scheme, URL template) is routed through these. `asPlatformSlug` enforces kebab-case filesystem-safe platform names; `asIdentifierSlug` enforces snake_case identifiers (capabilities, binds, step ids); both reject path traversal. `asUrl` enforces an http/https allowlist; `assertNoReservedKeys` blocks `__proto__`/`constructor`/`prototype` prototype pollution.

**Layer 2 — shape check per strategy type.** `validateStrategyShape` enforces:

| Strategy type | Required fields |
| --- | --- |
| `fetch` | `baseUrl` (string), `endpoint` (string). `prerequisites` array required for the with-prereqs variant — non-empty array of `{name, method}`. |
| `page-script` | `baseUrl` (string), `endpoint` (string) |
| `recorded-path` | `steps` (non-empty array of `{action, ...}`) |

Plus deep checks on optional fields: `generated` entries must be `{code}` XOR `{instruction, examples?}` (not both, with a code-length cap so accidental page-source paste doesn't land in a JS sandbox); `notes.params.<key>.kind` must be from `id|slug|email|url|uuid|enum|text|array|object`; parameter examples may be any bounded JSON value, with `array` and `object` examples checked against their declared container kind; `headers` values must be strings; `baseUrl` / `origin` must have http/https scheme. Per-prereq-method shapes are enforced at save (no `method:"browser"` without non-empty `steps`; no `method:"page-extract"` without `vars`; no `method:"fetch-extract"` without `vars` of string dot-paths; etc.). Inline enum observations require a `value`; their optional `label` defaults to that same value consistently during execute-time grounding and rejection rendering.

**Layer 3 — placeholder reference check.** Every `{{X}}` interpolation in `endpoint` / `baseUrl` / `headers` / `body` / `params` / prereq URLs is cross-checked against the set of declared names: keys of `notes.params`, keys of `strategy.generated` (referenced as `{{__gen.<name>}}`), page-extract `vars`, fetch-extract `vars`, browser-step `as` fields, and cached prereq names. A declared caller or prerequisite value may be traversed through an own-property path such as `{{searches.0}}` or `{{result.items.0.id}}`; empty and prototype-bearing path segments are rejected. Literal-provenance validation grounds the complete nested reference in its declared root parameter, and positional aliases resolve through declaration order, so the audit accepts the same caller paths that execution supports without requiring synthetic `notes.params` entries. Syntactic REST-style URL parameters such as `:user_id` are normalized into the same canonical inventory. An undeclared reference is rejected with a list of the valid alternatives. At execute time the runtime checks the fully resolved URL, body, headers, capability-prerequisite arguments, browser-prerequisite fields, recorded steps, and WebSocket URL/frame again. Any remaining placeholder produces `unresolved_placeholders` before transport or browser action; runtime never sends a literal template token to the target. A whole-value body or prerequisite `args_template` placeholder preserves the caller's JSON type, including arrays, objects, numbers, and booleans; an embedded placeholder remains string interpolation. A missing declared-optional query parameter is removed only when the complete query value is exactly one placeholder; whole-value optional body, header, capability-argument, and per-call fields follow the same recursive structural omission rule. Embedded placeholders and array elements are never removed because doing so would change field or positional meaning.

Click-correlated values participate in URL literal provenance only when the observed value occupies a complete query-value or pathname segment. Arbitrary substring overlap with a hostname or path token is not evidence that a fixed URL is a caller-selectable enum.

The triage-to-lift transition keeps `perform_action` available. This lets the agent generate additional request and DOM evidence on the bound surface before saving; save-time validation still evaluates the resulting strategy through the same structural and audit layers.

`update_strategy` accepts the complete body returned by `get_strategy` as an amendment starting point. It removes the top-level runtime-owned `runtime_meta` field before running the normal save pipeline, so callers can edit and resubmit a round-tripped strategy without forging or manually deleting metadata. New `save_strategy` payloads remain strict: agent-emitted non-empty `runtime_meta` is rejected.

**Layer 4 — auth-header heuristic.** Header names matching an auth-shaped regex (`*csrf*`, `*nonce*`, `*fetch-token*`, `Authorization`, `Bearer`, `*signature*`, etc.) cannot reference a `{{__gen.X}}` generator. Server-issued tokens are validated by the server against state IT issued — the LLM cannot synthesize them client-side, and a UUID generator trying to "reproduce the pattern" will never work. The validator points the agent at a `page-extract` prereq instead.

**Layer 5 — save-time DOM probe.** `runtime/src/strategies/probe.ts` spins up a real browser session with the platform's saved cookies and actually verifies LLM-written artifacts against the live DOM / the live API. Read-only by design — never clicks submit buttons, never fires POSTs.

- **`page-extract` prereqs**: navigate to the prereq URL (interpolated from the live session's declared capability args, with `notes.params.example` values as fallback), run each var's selector via `getAttribute`/`getText`, reject the save with the failing selector if anything returns empty. Closes the "agent invented a selector from a header name" class.
- **`fetch-extract` prereqs**: only when `http_method` is GET or missing (never probe POST/PUT/DELETE at save time — side effects). Fire the fetch from inside a browser session with `credentials:"omit"`, verify 2xx and that every dot-path resolves in the response body. Closes the "agent saved a public-REST lookup for a private resource" (HTTP 404) class and the "dot-path doesn't match the response shape" class.
- **`js-eval` prereqs**: navigate to the prereq URL and evaluate the expression against the live page. Per-call `args_template` values resolve from the session's declared capability args, then `notes.params.example`; unavailable values use a benign stand-in. Credential-shaped inputs are always replaced with stand-ins and the ephemeral probe scope is neither persisted nor included in rejection text.
- **`recorded-path` steps**: walk the steps in order. `navigate` and `wait-for-selector` actually execute (read-only). For the first mutating `click`/`type`/`select`, verify the selector resolves via `waitForSelector` but **do NOT perform the action**, then stop — subsequent steps depend on state changes we deliberately skipped, and verifying them would false-flag a valid strategy.

The probe runs in ~5–15 seconds per save depending on prereq count. Every rejection names the specific failing selector or dot-path so the LLM can correct it in the same discovery turn, rather than shipping a strategy that silently fails at warm-execute time when the session is long gone.

## Post-save factory verification

The factory classifier has six closed structural outcomes:

| Classification | Structural evidence | Runtime meaning |
| --- | --- | --- |
| `explicit_success` | HTTP 2xx and boolean `body.ok:true` | Explicit local success |
| `explicit_failure` | HTTP 2xx and boolean `body.ok:false` | Explicit local failure |
| `transport_accepted` | HTTP 2xx without boolean `body.ok` | Transport completed; semantic result is undecided |
| `transport_failure` | No numeric status or status outside 2xx | Transport did not complete successfully |
| `not_run` | `executionState:"not_run"` | No target request was sent |
| `delivery_unknown` | `executionState:"sent_unconfirmed"` | A target write may have been sent, but acknowledgement was not observed |

The classifier reads only status, runtime-owned execution state, and the boolean `body.ok` signal. Richer fields such as `outcome`, `code`, and message text pass through untouched for the LLM to interpret.

### Empty declared collections

The classifier is a pure function of the wire result, and its six states gate behavior in rediscovery, session start, the checkpoint API, and the execute cascade. Collection emptiness needs the strategy bytes, so it is assessed separately, at the two sites that hold a strategy object: post-save verification and the execute-cascade proof stamp.

A result counts as an empty declared collection when the strategy declared a collection and every instance of it came back with zero elements. Declaration is read structurally, in descending explicitness: a `response.extract` key carrying `multiple:true`; a `response.from` binding whose prerequisite declares `return_shape.kind:"array"`; or, derived, an object body with at least one array-valued own property where every array-valued own property is empty. The derived source covers a page script that assembles its own `{ok:true, items:[]}` envelope with no declared extraction. Only own properties are read, never key names — a nested empty array, a body with no arrays, or a body the runtime cannot inspect is not an empty collection.

An explicit `body.ok:true` over an empty declared collection carries exactly the strength of a bare 2xx: transport is proven and the semantic outcome is not. Post-save verification stamps `transport_passed` instead of `passed`, does not promote a candidate, and does not mark a tier healed; the candidate routes to `review_strategy_candidate`, whose response re-derives the reason from the same digest-bound candidate bytes and evidence body. The execute cascade withholds the proof stamp on the same condition but still marks the tier healthy — an empty read is a transport success and the tier stays usable.

`js-eval` prerequisites can declare `return_shape.kind:"array"` with an optional `min_items`. An empty array satisfies the shape unless `min_items` says otherwise, so zero rows reaches the review gate rather than failing as a prerequisite transport error.

### Verification context

Each runtime-owned post-save execution runs inside a verification-pool facade scoped to the whole verification run. Browser-backed strategies cannot see ready-page checkout candidates, the shared js-eval cache, or persisted browser storage. Each `createSession` is marked `freshContext`, which makes the backing pool call the driver for a new browser context and destroy it on close instead of checking out or registering a warm slot.

The facade keeps one context per `(platform, identity)` alive for the whole run, mirroring the warm-pool key. A prerequisite side effect — a consent click, a login, a dismissed interstitial — is therefore still in place when the request that depends on it fires, while a cross-platform capability prerequisite and a second identity each get their own context so no cookie jar is shared. `endDrive` is a no-op for run-owned sessions; teardown happens once, in `finally`, sequentially and exception-isolated, so a throwing verification cannot leak a context and one wedged context cannot strand the rest. Declared browser prerequisites still run inside the run's context before the candidate request, so the strategy must establish every page/DOM dependency it needs instead of inheriting the authoring session. Node-only strategies keep their ordinary context-free path.

Normal execute never marks `explicit_failure`, `not_run`, or `delivery_unknown` healthy, caches them, or admits them as successful capability prerequisites. It does not cascade or automatically retry `not_run` or `delivery_unknown`: the former needs missing caller or prerequisite data, while the latter could duplicate an already-applied write. Node and browser HTTP transports track dispatch structurally. A mutation-shaped deadline or ambiguous failure after dispatch becomes `sent_unconfirmed`; only a typed `not_sent` browser result or a structurally proven failure before the first Node `fetch()` invocation may fall through. Node retains that dispatch count across redirects, so admission failure on a later origin cannot replay an earlier mutating hop. Exception prose and broad transport-code families are never evidence that a mutation was not sent. A caller reconciles `delivery_unknown` through a separate read capability when the platform offers one. Ordinary explicit failure does not automatically mark the strategy broken because, without a signed outcome contract, runtime cannot structurally distinguish a legitimate domain result such as “not found” from a broken endpoint. That semantic repair decision remains with the LLM.

An optional capability prerequisite that fails, returns `not_run`, or cannot resolve a declared result path contributes no binding, so mode-specific prerequisite chains do not block unrelated modes. `delivery_unknown` is never skipped because the prerequisite may already have mutated state. If `response.from` names a missing optional binding, execution returns a structural `response_from_failed` path through the normal cascade rather than a successful empty body. A blank binding with `response.format:"json"` is likewise invalid JSON and cannot establish success; a genuine empty domain result must use an explicit structured outcome.

An automatically verifiable, non-mutating `fetch` or `page-script` save with a live session and satisfiable verification arguments is first written as a hash-addressed inactive candidate only after the complete prerequisite graph has a recursive structural safe-read proof. The proof follows exact cross-platform capability/tag edges and every active target tier; authentication, mutation, cycles, missing or ambiguous providers, WebSockets, recorded paths, and opaque browser actions fail closed to the existing non-candidate flow. Read-shaped `js-eval` prerequisites remain eligible unless the enclosing graph exposes a structural mutation signal. Argument satisfiability comes from the canonical placeholder inventory, including prerequisite fields, nested own-property paths, REST-style URL parameters, generated values, and exact optional-omission positions. If an active strategy already exists, a read replacement with incomplete verification arguments or unavailable read-safety proof is staged inactive and the active bytes remain unchanged. Candidate executable bytes are immutable; a candidate-bound sidecar records verification evidence and the capability's active-state digest or explicit absence at staging. Verification executes that exact candidate in a fresh anonymous browser context with health, archive, transport counters, shared caches, sibling fallback, and authoring-session state disabled.

Explicit `body.ok:true` evidence promotes immediately. A normal 2xx JSON or HTML result without that field remains inactive and writes an exact candidate-bound evidence artifact. Its SHA-256 digest is included in the save response. The agent calls `review_strategy_candidate` once to page through the exact evidence and receive a short-lived token, then again with the same evidence digest, token, one closed verdict (`verified_success`, `verified_failure`, or `inconclusive`), and a rationale. Runtime never parses the rationale or application payload. It validates the token and exact candidate/evidence/baseline hashes; only a bound `verified_success` promotes. Oversized or unserializable evidence cannot be approved: narrow the verification sample or add structural extraction and re-save.

Post-save failure previews put runtime-owned decision fields (`error`, `details`, `diagnosis`, execution state) before incidental payload fields and remain bounded. This preserves the concrete structural recovery signal in the immediate save response even when caller arguments or response samples are large; the immutable evidence artifact still retains the exact full body.

Promotion rechecks the full candidate and evidence digests and, under a per-platform/capability filesystem lock, compare-and-swaps the current active state against the staged baseline before atomically writing the complete active strategy. Validated commits, tier demotions, archive/unarchive, runtime-metadata stamps, migrations, and step patches use that same fail-closed cross-process lease plus complete-file atomic rename, so a competing writer either linearizes before promotion and trips the baseline CAS or fails with a lock conflict while promotion owns the critical section. The lease records its PID, per-process nonce, held-file owner marker, and creation time; recovery verifies that the live PID still holds that exact marker before treating the owner as current, then serializes the final reclaim recheck. PID reuse therefore cannot preserve an abandoned lease, while fresh malformed state fails closed. Explicit or reviewed failure, inconclusive review, transport failure, `not_run`, `delivery_unknown`, byte tampering, or a stale baseline leaves the previous active strategy byte-for-byte unchanged. Candidate files are outside active loading, listing, and export paths.

Mutating and authenticated saves remain on the consent/skipped-verification flow. A first read save without satisfiable verification arguments keeps that handling because there is no active baseline to preserve; a replacement read save is always staged inactive until it can be verified.

Local factory strategies intentionally do not duplicate public outcome contracts. Signed public packages declare their structural matchers, projections, assertions, and outcome classes in the package manifest, and the consumer evaluator requires exactly one matching case. During factory discovery, the LLM reads any richer typed body and decides whether it represents the intended result; runtime never maps words such as `failure`, `partial`, or `empty` to classes.

---

## Graduation — validation walkthrough

Before saving fetch from a network log capture, validate which values the server actually checks:

1. **Identify dynamic-looking values**: UUIDs, base64, headers like `x-request-id`, body fields like `nonce`, `signature`.
2. **Test what's validated**:
   - Omit entirely → 200? Optional, drop it.
   - Stub with right shape → 200? Format-only check, write a generator.
   - Wrong shape → 4xx? Server checks precisely, match carefully.
   - Replay original with different body → still works? Request-independent. Otherwise likely a body-derived signature.
3. Write a JS generator under `generated.<name>.code`.
4. Document in `notes.validation`: what you tested, what shapes you tried.
5. Instruction form only as last resort (costs tokens every execution).

### Automatic paths

The runtime graduates in the background on every successful recorded-path execute:

- **HTTP-echo** — `selectCandidateCall` walks the intercepted network log for a liftable 2xx POST/PUT/PATCH with a non-empty body. Three consecutive runs with the same (method, host+path, body-shape, header intersection) → synthesise `fetch` with empty prereqs and save it alongside.
- **WS-echo** — runs when the HTTP path finds nothing. Walks `session.wsFrames` for a sent frame whose payload contains a typed-literal from the replay (step-trace values from `type` / `select` actions, interpolated with the current `args`). Three consecutive runs with the same `(wsUrl prefix, frame template)` → synthesise `fetch + protocol:"websocket" + transport:"browser"` with the captured payload (literal values rewritten back as `{{argname}}` placeholders), optional `ackMatch` picked from a received frame within 1 s of the send. Conservative bias: skips opaque binary payloads, skips when multiple sent frames match the same needle.

Both paths short-circuit if a higher-tier strategy already exists on disk — manual saves and LLM-shaped `notes.params` always beat auto-synthesis. Graduated saves route through the save policy at the `graduation` origin (see [gates.md](gates.md) §"The save policy"), so blocking audit invariants (e.g. sensitive-shape strategies) refuse persistence on this path exactly as on the agent path. Graduation never throws into the execute path — failures (including policy blocks) are best-effort logged once per (platform, capability) and swallowed.
