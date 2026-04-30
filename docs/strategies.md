# Execution strategies

A klura skill is a JSON file on disk describing how to execute one capability. The strategy types, ordered by speed:

- **`fetch`** — static templated HTTP call (URL, method, headers, body with `{{placeholders}}`). May declare a `prerequisites` array when the request needs values the caller doesn't supply (CSRF tokens, persisted-query IDs, looked-up opaque IDs, etc.). Has a `transport` field (`'node'` | `'browser'`) stamped at save time by the probe — `'node'` rides pure HTTP (undici), `'browser'` rides an in-page `fetch()` call.
- **`page-script`** — JavaScript code that runs inside a live page and builds and fires the request per invocation. Used when the request itself cannot be expressed as a static template (in-page signer, frame-from-page, fingerprint-bound auth that re-signs per call).
- **`recorded-path`** — replay of UI actions through the browser driver. No API calls are extracted; the entire interaction happens through the DOM.

Prerequisites, transport, and protocol are properties of a strategy — not separate tiers. A `fetch` with `transport: 'browser'` + prereqs is structurally different from a `page-script`: the first is a static template that happens to ride in the page; the second emits executable JS per call.

For overall framing and the cascade behavior, see `../ARCHITECTURE.md`. This file covers each shape in detail, the prerequisite methods, how strategies are chosen, and the graduation pipeline that promotes recorded-paths into faster tiers when the runtime sees a clean shape.

**Capabilities compose.** A single saved capability can declare `{method: "capability", capability: "<another>", args, binds}` as one of its prerequisites — at execute time the runtime recursively invokes the referenced strategy and binds its return value into the caller's template namespace. This is how name→id resolution works: a `send_message(recipient_name, text)` strategy that needs an opaque `thread_id` declares a capability prereq on `lookup_thread_by_name(name)`; warm callers invoke `send_message` with the user-facing name, the runtime orchestrates the lookup chain. See `runtime/REFERENCE.md`'s "capability prereq" section for the full shape and worked examples. The save-time provenance guard (see [discovery.md](discovery.md)) turns this into a runtime-enforced contract: every opaque id in a saved strategy must trace to a documented source (caller arg, prereq, generator, or explicit single-entity scope) — agents cannot ship strategies that silently only work for their own discovery-time entities.

---

## fetch

A static templated HTTP call. The JSON encodes the URL, method, headers, and body shape; placeholders (`{{...}}`) are filled at execute time from caller args, prereq-bound values, and generators. No JS runs per call beyond what `generated` fields compute.

**Example shapes:** clean REST endpoints (cookie or bearer auth, body replays verbatim), CSRF-gated GraphQL mutations that need a page-extracted token, HTML form POSTs that need a CSRF nonce scraped from a hidden input, signed requests whose signature is produced by a `js-eval` prereq.

**What gets saved:**

- Endpoint URL pattern (e.g. `POST /api/v1/messages`)
- Required headers (auth, content-type, CSRF)
- Body schema (which fields, what format)
- `prerequisites` — optional array of values to resolve before firing
- `transport` — `'node'` or `'browser'`, stamped by the save-time probe

**Execution:** run any prereqs, substitute placeholders into the template, fire the request. `transport: 'node'` uses undici with no browser involved (~100–300 ms). `transport: 'browser'` opens a page session and fires via `fetchInBrowser` so cookies, TLS fingerprint, and JS-hydrated context apply.

### Prerequisite methods

A fetch may declare any number of prereqs, each resolving one or more named values before the main request fires.

1. **`page-extract`** — navigate to a URL and pull N values from the loaded DOM in one trip. The common form for CSRF nonces, persisted-query IDs, and any token the server renders into a `<meta>` tag or hidden `<input>`. `vars: {varName: {selector, attr?}}`.
2. **`fetch-extract`** — fire an HTTP request from inside the page context (`credentials: "omit"` by default so cross-origin public REST APIs with `Access-Control-Allow-Origin: *` don't CORS-reject), parse the JSON response, extract values via dot-path. Use when the body needs an opaque ID that lives in an API response but isn't rendered in the page DOM. `vars: {varName: "data.node_id"}`.
3. **`js-eval`** — run a short async expression inside the live page and bind the return value. Because it needs a live page, any strategy with a `js-eval` prereq is stamped `transport: 'browser'` automatically.
4. **`browser`** — imperative `steps` array (navigate / click / type / extract). Use only when the value isn't in the DOM until after some interaction (form prefill, click-to-reveal).
5. **`cached`** — read a value from the token cache (with optional static `value` fallback). Use for long-lived API keys or values shared across capabilities.
6. **`capability`** — recursively invoke another saved capability and bind its return value. How name→id resolution works: a `send_message(recipient_name, text)` strategy that needs an opaque `thread_id` declares a capability prereq on `lookup_thread_by_name(name)`.

### What gets saved

Preferred `page-extract` shape for a CSRF-gated mutation:

```json
{
  "strategy": "fetch",
  "method": "POST",
  "baseUrl": "https://example.com",
  "endpoint": "/graphql",
  "headers": {
    "X-CSRF-Token": "{{csrfToken}}"
  },
  "body": {
    "operation": "createThing",
    "variables": { "input": { "resourceId": "{{__gen.resourceId}}", "title": "{{title}}" } }
  },
  "generated": {
    "resourceId": {
      "code": "return Buffer.from('prefix:' + args.shortId).toString('base64')"
    }
  },
  "prerequisites": [
    {
      "name": "extractPageTokens",
      "method": "page-extract",
      "url": "https://example.com/{{slug}}/new",
      "vars": {
        "csrfToken": { "selector": "meta[name='csrf-token']", "attr": "content" },
        "shortId": { "selector": "meta[name='object-id']", "attr": "content" }
      }
    }
  ]
}
```

**Generators see prereq-extracted tokens via `args`.** Generators resolve _after_ prerequisites, so `args.shortId` in generator code refers to the value a `page-extract` just pulled from a meta tag. This unlocks extract-then-transform flows: grab a short numeric id from the DOM, base64-encode it into whatever opaque form the API expects, all in one strategy — no external API calls, no user-supplied opaque IDs.

**Execution** fires all prerequisites and the main request on a **single browser session** so cookies, same-origin headers, and one-time nonces survive between the token grab and the fetch. Re-navigating between prereq and fetch would reset page-scoped state (nonces that are only valid on the issuing page load, sensor-script counters), so the executor deliberately holds one page open across both.

## recorded-path

The entire interaction happens through the browser. No API calls are extracted — klura replays a sequence of UI actions via the browser driver.

**Example platforms:** Legacy sites with no API, sites behind Cloudflare interactive challenges, complex multi-step flows where the API is too entangled to extract.

**What gets saved:**

- Ordered list of actions with multi-locator steps (see [drivers.md](drivers.md#multi-locator-capture))
- Wait conditions between steps
- Variable slots (e.g. `{{message_text}}`, `{{recipient}}`)
- Optional `page` field per step targeting a tracked sub-page (`"popup-1"`, ...) — for OAuth consent, picker, and other multi-tab flows. See [popups.md](popups.md).
- Optional `cache: {ttl: "5m"}` hint on the strategy body — when set, the runtime memoizes successful results per `(platform, identity, capability, args)` tuple. Only declare on stable read lookups (`search_contact`, `whoami`); never on writes. See klura://reference#capability-cache.

**Execution:** Open a browser session via the configured driver, replay the recorded steps. Slowest strategy but works on anything with a browser UI.

**Self-heal on locator drift.** Each step is replayed through the locator cascade — `a11y → css → alternatives` — and if every captured selector misses, the runtime tries an in-process structural rescan via the driver's `findByRoleTolerant` before emitting the `recorded_step_failed` checkpoint to the agent. Two layers, both gated on uniqueness:

1. Same role + tolerant name match (`getByRole(role, { name, exact: false })`). Catches whitespace / case / minor-extension drift.
2. Same role only (no name constraint). Catches semantic renames ("Submit" → "Send") on pages where the role identifies the element by itself.

On a unique match, the step's action retries through a synthesized `role=ROLE[name="LIVE_NAME"]` selector, the on-disk strategy is patched via `patchStep` (new locator becomes primary, original demoted to head of `alternatives`), and the response body carries `_heal_advisory[]`. If both layers miss, the existing checkpoint path runs unchanged — the session-driving LLM heals via `patch_step` + `resume_execution`. No internal LLM call. Disable with `pool.heal.structural = false`. See klura://reference#warm-execute-self-heal.

## page-script

A JavaScript snippet that runs inside a live page and emits the request per invocation. Use when the request itself cannot be expressed as a static template — the most common reason is that the page's own JS builds and signs the call per-invocation (in-page signer, frame-from-page, signed URL whose parameters rotate).

**What gets saved:**

- A snippet (or structured build instructions) that runs inside the page on every execute
- Optional `prerequisites` (same methods as fetch)
- Arg-binding rules so caller args flow into the snippet

**Execution:** open a browser session, run the snippet inside the page, read the response. Faster than a full recorded-path replay because there's no UI interaction, but still pays for a page session.

**Difference vs `fetch` + `transport: 'browser'`:** a `fetch` with browser transport still has a static URL/headers/body template — only the extraction and the ride happen in the page. A `page-script` ships executable code that constructs the request on every call. The shape validator enforces the distinction: a `fetch` must be expressible as a template, a `page-script` must not pretend to be one.

---

## Interrupts — reactive human-handoff

Any tier can carry an optional top-level `interrupts: []` array of reactive observer/handler entries. Each entry binds an `observe` predicate to a lifecycle edge (`at: "pre_execution" | "between_steps" | "after_response"`); when the edge is reached and the predicate is truthy, the runtime dispatches the named handler. The bundled `user-assist` handler routes through the active remote-handoff backend (default: the local JPEG-over-WebSocket viewer, swappable via `registerRemoteBackend`). Challenges visible at the gate use `at: "pre_execution"`; CAPTCHAs that appear mid-recorded-path (e.g. after a Publish click) use `at: "between_steps"`.

The vocabulary is pluggable: three registries (`predicate-registry.ts`, `interrupt-registry.ts`, `remote/backend.ts`) hold the kinds. Strategy schema only names `kind` strings; validator + executor look them up in the registries. Deployments can register additional kinds without editing validator or executor source — consistent with the "Pluggability is welcome" clause in `principles.md`. See `REFERENCE.md#interrupts` for the full shape and the registration APIs.

Evaluation is edge-triggered, not polled: every check fires at a moment when state just changed (step completed, response arrived, execution started). Subscription-based in-flight observation (MutationObserver, CDP events) is the LIFT direction for predicate kinds that expose a natural event source.

## Common capability shapes

The capability-prereq mechanism (`{kind: "capability", capability: "<slug>", ...}`) is the underlying composition primitive — see `REFERENCE.md#capability-prereq` for the full schema. Two recurring UI surfaces converge on **specializations** of this prereq, plus a third shape that's a sibling pattern (cross-session handoff via discovery artifact). Drive-start contextual hints in `runtime/src/tools/start-session.ts` fire structurally on the strongest cues for these — see `runtime/docs/run-lifecycle.md#drive-start-contextual-hints`. Recognising the surface up front leads to better tier choice, smaller strategy diff, and reusable building blocks across the platform's capability set.

### Search — the "name → id" prereq specialization

Single text-input UI that returns a result set after submit. Saved as its own capability AND used as a binding-oriented capability prereq for write capabilities that need an id but only know a human-facing name.

The capability:

- **Slug:** `search_<entity>` (e.g. `search_member`, `search_product`, `search_thread`). The `<entity>` is what's being searched, not what the page calls the input.
- **Single arg:** the user's query, declared `kind: "text"`. Param name `q`, `query`, or `name` — match the server's expected key.
- **Tier `fetch`.** The submit fires an XHR; that XHR is templatable. Don't fall through to `recorded-path` even when the page handles the submit via JS — the network log has the real surface.
- **Cacheable when stable.** Set `cache: {ttl: "5m"}` on stable result sets (member directories, product catalogs). Skip the cache on personal-feed-style searches.

Two response shapes:

| Server response | Strategy shape |
| --- | --- |
| JSON results array (typical SPA) | `fetch` with `response: {format: "json"}` and dot-paths in `extract` for fields the agent needs surfaced |
| HTML page with results inline (server-rendered, classic intranets) | `fetch` with `response: {format: "html", extract: {<name>: {selector, attr?, multiple?, fields?}}}` — sub-100ms warm runs, no browser session |

The prereq specialization — how write capabilities consume search:

```json
"prerequisites": [{
  "name": "thread_lookup",
  "kind": "capability",
  "capability": "search_thread",
  "args": { "q": "{{recipient_name}}" },
  "vars": { "thread_id": "results.0.thread_id" }
}]
```

This is the **binding-oriented** prereq shape — `vars` extracts a value from the sub-execute's response and binds it into the caller's template namespace. The search capability becomes the platform's standard name→id resolver and is reused by every write that needs the same lookup. One canonical example in `REFERENCE.md#capability-prereq`'s "Worked example" — `send_message(recipient_name, text)` chains to `lookup_thread_by_name(name)`.

Anti-pattern: monolithic recorded-path that drives the search via `perform_action` (type → click → scrape DOM). Pays a 5-10× latency tax on every warm call vs the fetch shape, AND can't be reused as a prereq because the result isn't accessible by dot-path. The XHR is in the captured network log; lift it.

### Auth — the "side-effect" prereq specialization

The other half of the capability-prereq shape. While search uses the prereq for its **return value**, an auth flow uses it for its **`BrowserContext` side effects** — the cookies the sub-execute leaves on the shared browser context, which the caller's HTTP / page-script then rides for free.

The capability:

- **Slug:** any meaningful name — `login`, `login_password`, `login_gmail`, `login_sso`, etc. The slug carries no runtime meaning; the typed edge does.
- **Top-level declaration:** `provides: ["auth"]`. This is the typed-edge marker — dependents reference the role, not the slug. Multiple capabilities on the same platform can advertise `auth` (one per login method); resolution at execute time picks the unique provider, or rejects with a disambiguation list when there are multiple.
- **Tier `recorded-path`.** Auth flows resist HTTP templating (CSRF, redirect chains, sometimes signed bodies). Recorded-path fills credentials and submits.

The prereq specialization — how dependents consume auth:

```json
"prerequisites": [{
  "name": "auth",
  "kind": "tag",
  "tag": "auth"
}]
```

No `vars` field. This is the **side-effect-only** prereq shape — the runtime invokes the resolved auth capability for its cookie-jar side effects, then runs the caller's strategy in the same warm `BrowserContext`. The dependent capabilities themselves are typically `fetch` against the auth-gated endpoints; the cookie set by the auth prereq makes them work.

When two auth methods coexist (gmail-OAuth + password), the agent disambiguates per-strategy: either chain the tag and let resolution surface the disambiguation error at first execute (then re-save with a specific slug), or chain `{kind: "capability", capability: "<specific-method>"}` from the start.

**Cookie propagation requires warm-pool mode.** `pool.warm.enabled: true` in `~/.klura/config.json` enables the `BrowserContext` reuse that makes side-effect prereqs work. In cold-pool mode each sub-execute gets a fresh context and side-effect-only prereqs silently fail to share state — confirm warm pool is on, or fall back to a binding-oriented prereq (extract the session token from the login response, bind it as `{{session_token}}`, dependents send as a header) which works in either mode.

**Auth-wall lazy retry.** When a sibling strategy hits 401/403 mid-flow because the cached auth result is stale, the runtime evicts the auth capability's cache entry, re-fires the prereq, and retries the main strategy once. Bounded to one retry per `execute()` — a second auth wall returns `needs_reauth: true` to the LLM as before.

Anti-pattern: each dependent saves a monolithic `recorded-path` that bakes in the login flow. Login is replayed on every warm call, blowing latency and risking CAPTCHA / rate-limit triggers from the repeated submissions.

The auth-as-prereq pattern is regression-gated by `llm-tests/scenarios/login-sharing/` (single-method) and `llm-tests/scenarios/multi-method-auth/` (multi-provider tag resolution). The drive-start hint fires when `<input type="password">` is captured during the initial nav — a once-per-session reminder, since this rule only matters on auth-gated sites.

### List + detail (sibling shapes, often paired with search)

Pages that show a list of items (orders, posts, products, contacts) with pagination, where each item links to a detail view. Two related capabilities, both stable enough to declare `cache: {ttl: "5m"}` when the platform's data doesn't churn rapidly:

- **`list_<entity>`** — `fetch` against the list endpoint. Args might include pagination cursors, filters, or sort. When the list is plain HTML, use `response.format: "html"` with a `multiple: true` selector to extract an array.
- **`get_<entity>` / `get_<entity>_by_<field>`** — `fetch` against the detail endpoint with the entity id (or slug) as the single arg. Often takes the id straight from the user; sometimes needs a name→id lookup, in which case it consumes a search-style binding-oriented prereq pointing at `search_<entity>` or `list_<entity>`.

### Cross-session handoff (discovery artifact)

Sibling pattern, not a prereq specialization. Long-tail discovery work that takes more than one session — heavy reverse engineering, signer extraction, multi-step encoder triangulation — is staged via the discovery artifact instead of being completed in a single session. Each session adds rows via `save_verified_expression`, `add_discovery_note`, `add_resume_pointer`. The next session's `start_session` inlines the artifact in `result.artifacts` so the agent sees prior progress without an extra tool call.

The pattern in practice:

1. Session N reaches a limit (rounds budget, user check-in, can't bridge a gap) — persists current findings as artifact rows and closes.
2. Session N+1's `start_session` carries `result.artifacts[capability]` with all prior rows. Agent reads, picks up where N left off, persists new rows.
3. When the strategy lands, the artifact's accumulated context gets folded into `notes.discovered_at_step_id` / `notes.signer_history` / similar so warm-execute callers benefit too.

The drive-start hint fires when `result.artifacts` is non-empty — same once-per-session pattern as the others.

## How strategies are chosen

```
User: "<natural request>"
         │
         ▼
   ┌─ fetch saved?        ──→ Run prereqs (if any), fire templated HTTP call
   │                            (Node transport ~100–300 ms; browser ~1–2 s)
   │
   ├─ page-script saved?  ──→ Open page, run the snippet, read response (~1–2 s)
   │
   ├─ recorded-path saved? ──→ Replay UI actions through the driver (slower)
   │
   └─ Nothing saved?      ──→ Discovery: explore the site
                                 │
                                 ▼
                           Produces one of the above strategies
```

Fetch ranks above page-script because its default transport is Node, so when the probe stamps `transport: 'node'` the call escapes the browser entirely. Page-script always needs a live page.

---

## Graduation

**Most capabilities never graduate** — the LLM classifies the highest viable tier on the first save, so a clean REST API lands at fetch immediately and a CSRF-gated mutation lands at fetch with a `page-extract` prereq immediately. First-save tier classification is the main path; graduation is the rare post-discovery correction that kicks in when a recorded-path happens to capture a cleaner API call than discovery recognised. The implemented upgrade paths (`runtime/src/strategies/strategy-graduation.ts`):

- **recorded-path → fetch**: the captured POST replays as a static template. If no header looks page-sourced, the synthesized strategy has empty prereqs; if one or more headers carry CSRF-shaped or persisted-query-shaped values, the strategy records a placeholder prereq pending save-time probe.
- **recorded-path → page-script**: the WebSocket-echo path used when the captured shape works only when a browser session is alive (fingerprint-bound, page-signed).

**Not yet implemented:** optimizing an over-specified fetch by detecting that its prereqs ran but were never referenced in the final request. The signal is subtle — a prereq-extracted token that never appears in the rendered request could be genuinely unused, or it could be a cookie the server set as a side effect of the prereq URL. A safe runtime check (shadow-probe the main call without prereqs on GET-shaped capabilities) is feasible but has not been built; writes stay off-limits because we don't replay mutations to check necessity. Until that lands, an over-specified fetch stays that way until a fresh discovery overwrites it.

Graduation is **runtime-initiated**, not LLM-initiated. The hook lives in `strategies/strategy-graduation.ts:recordRecordedPathSuccess` and fires on every successful recorded-path or fetch execute. It persists one observation per successful run in `~/.klura/graduation/<platform>/<capability>.json`, and when N consecutive runs describe the same capturable POST shape (default `graduation.observation_threshold = 3`, configurable in `~/.klura/config.json`), the runtime:

1. Synthesises the highest viable sibling strategy from the captured call.
2. Runs the result through the same `validators.ts` pipeline a hand-saved strategy would go through, because runtime-synthesised output is also untrusted input and must prove itself against ground truth before being persisted.
3. Saves it alongside the existing strategy via `skills.saveStrategy` with a `graduated from ...` changelog, so `get_strategy_events` shows the promotion and `list_platform_skills` surfaces both tiers.
4. Marks the state file with `graduatedTier` so the observation loop doesn't re-synthesise the same strategy on every future run.

The LLM has no role in this. SKILL.md used to instruct the agent to save a faster strategy itself when it noticed clean API calls during warm execute; that guidance has been removed because it raced the automatic hook and burned context tokens on every conversation asking for behaviour the runtime already provides. The only thing the agent is asked to do is classify correctly at discovery time — graduation picks up what discovery missed, silently.

Because the hook runs at execute time only, capabilities that are never executed will never graduate. There is no background sweep, no idle-time reassessment, and no daemon-scheduled reclassification. To force a reassessment, run the capability once more — the next successful recorded-path execute re-enters the hook with a fresh observation.

### When graduation doesn't happen

Some capabilities have no faster sibling by construction:

- **Pure DOM interactions with no network equivalent** — in-page canvas editors, drawing tools, client-only calculators. The "action" is DOM state, not an API call.
- **OS- or extension-mediated flows** — wallet popups, passkey dialogs, OS share sheets. The effectful call happens outside the page's request graph.
- **Legacy intranets whose "submit" is a real browser event sequence** — no backend API receives it in a replayable form.

For these, `recorded-path` isn't a failure mode — it's the correct saved shape. Warm replay is deterministic, zero-LLM, and the multi-locator capture makes it resilient across layout changes.

A separate class is "could graduate in theory but hasn't": discovery didn't converge (obfuscated signers, novel envelope formats), or the page's own logic resists being lifted cleanly. Those stay at `recorded-path` until a later discovery run picks up the cleaner path.

If a strategy later **degrades** (e.g. a fetch starts failing because the site changed), klura cascades to the next strategy:

```
fetch fails → try page-script → try recorded-path (always exists)
```

A separate per-protocol counter (`NODE_TRANSPORT_FAIL_THRESHOLD = 3` in `runtime/src/health.ts`) demotes a `fetch` from Node transport to in-browser transport after three consecutive transport-layer failures (TLS fingerprint mismatches, ECONNRESET on Node-side requests). This is finer-grained than the cascade above — same strategy, different transport — and the recorded-path is never deleted after graduation; it serves as the ultimate fallback. Each strategy tier has independent health tracking (see [health.md](health.md)). After 5 consecutive failures, a strategy is archived as broken (`BROKEN_THRESHOLD = 5`); use `reset_strategy_health` to restore it.
