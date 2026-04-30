# Save-time validation

Everything the LLM writes goes through a layered validation pipeline before it lands on disk. Each layer catches a different class of hallucination, and error messages are phrased as actionable corrections — the agent reads the error, fixes the artifact, and retries `save_strategy` within the same discovery turn.

The full flow lives in `runtime/src/strategies/skills.ts:saveStrategy`. For the underlying validate-everything-the-LLM-emits principle, see [principles.md](principles.md). For health tracking after a strategy lands on disk see [health.md](health.md).

---

## The five layers

**Layer 1 — primitive validators.** `runtime/src/validators.ts` is a tiny dependency-free module that provides `asPlatformSlug`, `asIdentifierSlug`, `asUrl`, `asEnum`, `asPositiveInt`, `assertNoReservedKeys`, and friends. Every LLM-supplied artifact (platform slug, capability name, identity key, secret-resolver scheme, URL template) is routed through these. `asPlatformSlug` enforces kebab-case filesystem-safe platform names; `asIdentifierSlug` enforces snake_case identifiers (capabilities, binds, step ids); both reject path traversal. `asUrl` enforces an http/https allowlist; `assertNoReservedKeys` blocks `__proto__`/`constructor`/`prototype` prototype pollution.

**Layer 2 — shape check per strategy type.** `validateStrategyShape` enforces:

| Strategy type | Required fields |
| --- | --- |
| `fetch` | `baseUrl` (string), `endpoint` (string). `prerequisites` array required for the with-prereqs variant — non-empty array of `{name, method}`. |
| `page-script` | `baseUrl` (string), `endpoint` (string) |
| `recorded-path` | `steps` (non-empty array of `{action, ...}`) |

Plus deep checks on optional fields: `generated` entries must be `{code}` XOR `{instruction, examples?}` (not both, with a code-length cap so accidental page-source paste doesn't land in a JS sandbox); `notes.params.<key>.kind` must be from `id|slug|email|url|uuid|enum|text`; `headers` values must be strings; `baseUrl` / `origin` must have http/https scheme. Per-prereq-method shapes are enforced at save (no `method:"browser"` without non-empty `steps`; no `method:"page-extract"` without `vars`; no `method:"fetch-extract"` without `vars` of string dot-paths; etc.).

**Layer 3 — placeholder reference check.** Every `{{X}}` interpolation in `endpoint` / `baseUrl` / `headers` / `body` / `params` / prereq URLs is cross-checked against the set of declared names: keys of `notes.params`, keys of `strategy.generated` (referenced as `{{__gen.<name>}}`), page-extract `vars`, fetch-extract `vars`, browser-step `as` fields, and cached prereq names. An undeclared `{{foo}}` is rejected with a list of the valid alternatives. Catches the common `{{__prereq.X}}` hallucination class where the agent invents a non-existent prefix.

**Layer 4 — auth-header heuristic.** Header names matching an auth-shaped regex (`*csrf*`, `*nonce*`, `*fetch-token*`, `Authorization`, `Bearer`, `*signature*`, etc.) cannot reference a `{{__gen.X}}` generator. Server-issued tokens are validated by the server against state IT issued — the LLM cannot synthesize them client-side, and a UUID generator trying to "reproduce the pattern" will never work. The validator points the agent at a `page-extract` prereq instead.

**Layer 5 — save-time DOM probe.** `runtime/src/strategies/probe.ts` spins up a real browser session with the platform's saved cookies and actually verifies LLM-written artifacts against the live DOM / the live API. Read-only by design — never clicks submit buttons, never fires POSTs.

- **`page-extract` prereqs**: navigate to the prereq URL (interpolated from `notes.params.example` values), run each var's selector via `getAttribute`/`getText`, reject the save with the failing selector if anything returns empty. Closes the "agent invented a selector from a header name" class.
- **`fetch-extract` prereqs**: only when `http_method` is GET or missing (never probe POST/PUT/DELETE at save time — side effects). Fire the fetch from inside a browser session with `credentials:"omit"`, verify 2xx and that every dot-path resolves in the response body. Closes the "agent saved a public-REST lookup for a private resource" (HTTP 404) class and the "dot-path doesn't match the response shape" class.
- **`recorded-path` steps**: walk the steps in order. `navigate` and `wait-for-selector` actually execute (read-only). For the first mutating `click`/`type`/`select`, verify the selector resolves via `waitForSelector` but **do NOT perform the action**, then stop — subsequent steps depend on state changes we deliberately skipped, and verifying them would false-flag a valid strategy.

The probe runs in ~5–15 seconds per save depending on prereq count. Every rejection names the specific failing selector or dot-path so the LLM can correct it in the same discovery turn, rather than shipping a strategy that silently fails at warm-execute time when the session is long gone.

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

Both paths short-circuit if a higher-tier strategy already exists on disk — manual saves and LLM-shaped `notes.params` always beat auto-synthesis. Graduation never throws into the execute path — failures are best-effort logged once per (platform, capability) and swallowed.
