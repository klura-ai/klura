# Klura Reference

Detailed strategy schemas, authentication flows, healing formats, and graduation guidance. Read this before saving or debugging strategies.

## graphs

A klura session belongs to one of three named graphs. The `graph` parameter on `start_session` selects the FSM topology the session walks; per-graph behavior (mutating-action consent gates, auto-synth at close, re-persistence threshold) is data-driven from the graph's `GraphConfig`, not from session-level flags. Adding a new graph is one new file in `runtime/src/graphs/`.

| Graph | Topology | Use it when |
| --- | --- | --- | --- |
| `discover` (default) | `drive → triage → lift → terminal{closed}` | **ANY user-driven request with a specific goal, even when the agent has to navigate around an unfamiliar site to find the right page.** Drive the UI, hand off to triage to read the defense surface, lift via the RE playbook, save a strategy. Single primary capability declared up front via `start_session({capability, args})` or `declare_capability`. |
| `map` | `drive ⇄ triage ⇄ lift → terminal{closed}` | **Bred platform-exploration where the agent decides what's worth saving as it goes.** Walk the site, record observations via `record_observed_capability`, and when an observed capability is ready to graduate to a saved strategy call `lift_observed_capability({name, args})` to enter triage+lift for that one slug. After save, the session stays open — call `lift_observed_capability` again for the next slug, or `end_drive` to close. Mutating `perform_action` calls (POST/PUT/DELETE-shaped clicks, `type` into write-shaped inputs, etc.) gate behind a per-(action, selector) consent prompt. Auto-synth at close is skipped. The re-persistence gate fires when ≥5 perform_actions land with zero persistence calls and no saved strategies. |
| `execute` | `execute → triage → lift → terminal{closed | failed}` | Runs a saved strategy as the whole session. On stale-strategy failure (rolling success rate below `pool.rediscoverThreshold`) the FSM auto-falls into triage with the failure as defense-surface input — the agent re-plans and re-lifts. Arg/auth/structural failures terminate `failed`. |

**Picking between `discover` and `map`.** Discover when the user has a specific goal in mind ("send a message", "search for X") — declare the capability up front, drive straight to it, save. Map when the user wants a broad walk of the platform ("map out X", "see what's here") — explore first, then graduate observed capabilities to saved strategies via `lift_observed_capability` as you find them. Discover ends on save (one capability per session); map ends when the agent says so via `end_drive` (any number of capabilities). When unsure, default to `discover` — but the cost of picking map and only lifting one capability is small, so the bias matters less than it used to.

### lift_observed_capability — map-graph lift initiator

On a `map` session, `lift_observed_capability({session_id, name, args?})` opens a triage+lift cycle for one slug that already exists on `platform_logbook.observed_capabilities[]` (i.e. the agent called `record_observed_capability` earlier this session or a prior one). The runtime adds the slug to `session.declaredCapabilities` and transitions the FSM to triage. The agent then runs the normal triage → `submit_triage_plan` → lift → `save_strategy` flow. After save, the session remains open in lift; the agent calls `lift_observed_capability` again for the next slug or `end_drive` to close.

Rejected cases:

- Non-map graph — `lift_observed_capability` is map-only. On a `discover` session, declare via `start_session({capability})` or `declare_capability`.
- Phase ≠ drive | lift — calling from triage means an active plan is in flight; submit or re-submit before pivoting to a new capability.
- Unknown slug — `name` must match an `observed_capabilities[].name` entry. If you haven't recorded the slug yet, call `record_observed_capability` first.

Args are optional but recommended: without them the auto-save can't template captured request bodies into a reusable strategy. Pass the same `{paramName: literalValue}` map you'd pass to `declare_capability`.

The runtime tracks the active graph on `session.graph` and the lifecycle status on `session.status` (`'active' | 'closed' | 'failed'`). Universal tools (`ack_checkpoint`, memory reads, control plane) admit on terminal sessions; phase-scoped tools reject. Mid-session, the active phase plus the active graph's `GraphConfig` together determine which tools are admissible and how `perform_action` / `end_drive` behave. Generate a Mermaid diagram of any graph by reading `runtime/src/graphs/<name>.ts` and the dumper at `runtime/src/graphs/dump.ts`.

## Strategy schemas — overview

Klura classifies every discovered capability at the highest viable tier in the cascade: `fetch` > `page-script` > `recorded-path`. Cheapest first — `fetch` fires from Node (optionally with browser prerequisites / browser transport), `page-script` always pays for a page load, and `recorded-path` replays the DOM. Each tier has its own schema section below — addressable directly for incremental reads:

- `klura://reference#fetch-schema` — pure HTTP, browser prerequisites, and transport selection (~100ms warm execute when pure-Node)
- `klura://reference#page-script-schema` — HTTP from inside a live browser page
- `klura://reference#recorded-path-schema` — DOM replay fallback

**`page-script` vs `fetch` + `transport: 'browser'`:** `page-script` is for APIs that require a user-facing page load before the call — to seed fingerprint-bound cookies, run sensor scripts, or when the API host differs from the origin host (`origin` ≠ `baseUrl`). `fetch` with `transport: 'browser'` is a pure TLS-fingerprint workaround for an otherwise-Node-shaped call; the `executeDirect` path fires from the API host itself and is picked automatically when the save-time probe (or a runtime TLS failure) signals that Node can't reach the endpoint.

See `klura://reference#network-log` for the discovery workflow that produces these strategies.

**Origin field per tier.** The field naming the HTTP(S) URL the page is loaded from has a different name depending on the tier:

- **WebSocket strategies** (`fetch` / `page-script` with `protocol:"websocket"`): use **`origin`**. `baseUrl` is rejected on ws strategies — hard rename, no alias. Strategies predating the rename need to be re-saved with the new field name.
- **HTTP strategies** (`fetch` / `page-script` without `protocol:"websocket"`): use **`baseUrl`** (paired with `endpoint` as URL + path). `origin` is accepted as a forward-compat alias; the validator canonicalizes `origin` → `baseUrl`.

**`notes` vs `runtime_meta`.** Two separate top-level fields, with strict ownership:

- `notes` is **agent-owned input**. Allowed keys: `params`, `description`, `anchor_type`, `save_warnings_acked`. Unknown keys are rejected at save.
- `runtime_meta` is **runtime-stamped output**. The runtime fills it in at save time (capture-page URL, recorded-path anchor, save-time probe outputs, audit advisories). The agent reads it via `list_platform_skills` / `get_strategy` but must not emit it on `save_strategy` — payloads carrying `runtime_meta` are rejected up front.

## fetch schema

For the live field-level schema, see `klura://reference#save-strategy-schema`.

When a session expires, `execute` returns `{needs_reauth: true}` instead of a raw 4xx.

#### Generated values

When a request contains dynamic values (timestamps, fingerprints, request IDs), declare them in a `generated` block. Reference via `{{__gen.<name>}}`:

```json
{
  "strategy": "fetch",
  "method": "POST",
  "baseUrl": "https://example.com",
  "endpoint": "/api/search",
  "generated": {
    "client_id": {
      "code": "return Date.now() + '.' + crypto.randomBytes(5).toString('hex').slice(0,9) + '.' + crypto.randomBytes(4).toString('base64url').slice(0,6)"
    },
    "request_id": { "code": "return crypto.randomUUID()" }
  },
  "headers": {
    "x-client-id": "{{__gen.client_id}}",
    "x-request-id": "{{__gen.request_id}}"
  },
  "body": { "query": "{{query}}" }
}
```

**Sandbox API**: `crypto` (`randomUUID`, `randomBytes`, `createHash`, `createHmac`), `Date`, `Math`, `Buffer`, `args` (read-only). No `require`, `process`, `fs`, or network. 100ms timeout. Code must `return` a string.

**Generators see prereq-extracted tokens via `args`.** Generators run after prerequisites, so `args.<varName>` resolves to whatever a `page-extract` / `fetch-extract` / `browser` prereq put into the tokens namespace. Enables extract-then-transform flows (e.g. extract a numeric id from a meta tag, then base64-encode it into an API-shaped node id).

**Instruction form** (values that can't be computed — costs tokens every execution):

```json
"generated": {
  "weird_token": {
    "instruction": "32-char hex from a JS challenge eval'd at runtime",
    "examples": ["a1b2c3...", "d4e5f6..."]
  }
}
```

When `execute` returns `{needs_generation: true, generators_needed: {...}}`, generate matching values and re-call with `_generated: {name: value}` in args.

#### HTML responses (read-only GETs)

Declare `response.format: "html"` with CSS selector extractors to get a structured dict back instead of raw HTML:

```json
{
  "strategy": "fetch",
  "method": "GET",
  "baseUrl": "https://trade.example.com",
  "endpoint": "/myaccount/order/list.htm",
  "response": {
    "format": "html",
    "extract": {
      "title": { "selector": "h1.page-title" },
      "orders": { "selector": "tr.order-row td.product-name", "multiple": true },
      "ship_to": { "selector": "meta[name='ship-to']", "attr": "content" }
    }
  }
}
```

- `response.format`: `"json"` (default) or `"html"`. For `"html"`, `extract` is required, and the strategy **must be a GET** (save rejects non-GET — the probe fires the real request).
- Each extract entry: `{selector, attr?, multiple?}`. CSS selectors only. Absent `attr` pulls trimmed `textContent`.
- Missing single → empty string; missing multi → empty array.
- **Save-time probe** fires the real GET with session cookies, runs every selector, rejects non-2xx / non-HTML / all-empty responses.
- **Execute errors**: `extract_failed` (parser/selector threw), `response_too_large_html_trimmed` (HTML body overflowed budget; response falls back to `body.a11y_tree` for selector picking), `response_too_large` (≥20 KB JSON or non-HTML string — narrow selectors or tighten query).

### fetch prerequisites

For the live field-level schema, see `klura://reference#save-strategy-schema`.

Four prereq methods, in order of usefulness:

1. **`page-extract`** — declarative one-shot. Navigate to a single URL, extract N values from the loaded DOM. Cleanest for CSRF / nonce / persisted-query scrapes where the token is rendered in a meta tag or hidden input. Output keys go into the body/headers via `{{varName}}`.
2. **`fetch-extract`** — make a non-browser HTTP request, parse the JSON response, extract values via dot-path. Use for resource-ID lookups that live in API responses but not in DOM selectors — any time the API wants an opaque internal ID (GraphQL `node_id`, numeric DB id, UUID) and the user only knows a slug or URL. Runs inside the browser session so cookies flow automatically.
3. **`browser`** — imperative `steps` array (navigate / click / type / extract). Use when the page needs interaction before the value is in the DOM (form prefill, click-to-reveal, etc).
4. **`cached`** — read a value from the token cache (or a static `value`). Use for long-lived API keys or values shared across multiple capabilities.

`page-extract` example (most common — preferred for any endpoint that requires a CSRF / fetch-nonce / persisted-query token rendered into the page HTML):

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
    "query": "mutation CreateThing { ... }",
    "variables": { "input": { "title": "{{title}}" } }
  },
  "prerequisites": [
    {
      "name": "getCsrf",
      "kind": "page-extract",
      "url": "https://example.com/{{owner}}/{{repo}}/new",
      "vars": {
        "csrfToken": { "selector": "meta[name='csrf-token']", "attr": "content" }
      }
    }
  ]
}
```

Each var entry: `{selector, attr?}`. Absent `attr` pulls text content. The var name becomes the placeholder (`{{csrfToken}}`) — not the prereq's `name` (which is just a label). Add more entries to `vars` to extract N values from one page load. The save-time probe rejects any selector that doesn't resolve.

`fetch-extract` example — lookup + CSRF sharing one browser session:

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
    "variables": { "input": { "resourceId": "{{resourceId}}", "name": "{{name}}" } }
  },
  "prerequisites": [
    {
      "name": "resolveResourceId",
      "kind": "fetch-extract",
      "url": "https://api.example.com/things/{{slug}}",
      "method": "GET",
      "headers_map": { "Accept": "application/json" },
      "vars": { "resourceId": "data.node_id" }
    },
    {
      "name": "extractCsrf",
      "kind": "page-extract",
      "url": "https://example.com/{{slug}}/new",
      "vars": { "csrfToken": { "selector": "meta[name='csrf-token']", "attr": "content" } }
    }
  ]
}
```

fetch-extract schema:

- `url` (required): supports `{{placeholder}}` interpolation from execute args.
- `vars` (required): `{varName: "dot.path"}` — string dot-path into the JSON response (NOT `{selector, attr}`). Supports array indexing: `data.items[0].node_id`.
- `method` (optional, HTTP verb): `GET` (default), `POST`, `PUT`, `DELETE`, `PATCH`.
- `headers_map` (optional): defaults to `{Accept: "application/json"}`.
- `fetch_body` (optional): JSON body for non-GET.

Runs via `fetchInBrowser` from the current page context so cookies flow automatically. Network error / non-2xx / unresolved dot-path halts the cascade with the prereq name and failing path.

`browser` example (interaction required):

```json
{
  "strategy": "fetch",
  "baseUrl": "https://example.com",
  "endpoint": "/api/endpoint",
  "headers": { "X-CSRF": "{{csrf_token}}" },
  "body": { "data": "{{text}}" },
  "prerequisites": [
    {
      "name": "csrf_token",
      "kind": "browser",
      "steps": [
        { "action": "navigate", "url": "https://example.com" },
        {
          "action": "extract",
          "selector": "input[name='csrf']",
          "attribute": "value",
          "as": "csrf_token"
        }
      ],
      "ttl": 1800
    }
  ]
}
```

For `browser` with a single extract, `as` (the placeholder name) defaults to the prereq's `name` field. For multiple extracts, give each its own `as`.

`js-eval` is the prereq for values produced by a JS function call on the live page rather than rendered into the DOM. See `klura://reference#js-eval` for the full schema, examples, and discovery guidance.

`cached` example:

```json
{ "name": "api_key", "kind": "cached", "value": "static-value-from-discovery" }
```

Use fetch when the API requires a token from a page load (CSRF, persisted-query nonce, session tokens in HTML). Keep prerequisites minimal: load + extract. Don't include per-request values (counters, sequences) — they'll go stale.

**Common pitfalls**:

- Forgetting `name` or `kind` on a prerequisite — the validator reports all missing required keys in one error, so fix them together in your retry.
- Using `kind: "browser"` without a `steps` array. Browser prerequisites need at least one step.

## capability prereq

The `{kind: "capability", ...}` prereq recursively invokes another saved klura strategy and binds values extracted from its response into the caller's template namespace. This is the chained-capability primitive: a `send_message(recipient_name, text)` strategy that needs `thread_id` declares a capability prereq on `lookup_thread_by_name(name)` — at warm execute time the runtime calls the lookup first, harvests `thread_id` out of the response, substitutes into the send's envelope, fires.

**Shape:**

```json
{
  "name": "thread_lookup",
  "kind": "capability",
  "capability": "lookup_thread_by_name",
  "args": { "name": "{{recipient_name}}" },
  "vars": { "thread_id": "results[0].thread_id" },
  "optional": false
}
```

Fields:

- `capability` (required, slug) — the capability the runtime recursively invokes.
- `vars` (optional, `{<name>: "<dot.path>"}`) — bindings harvested from the sub-execute's JSON body. Each key becomes `{{<name>}}` in the caller's endpoint / body / headers; each value is a dot-path into the response (use `""` to bind the whole body). Omit (or pass `{}`) for **side-effect-only** prereqs (see below). The same shape fetch-extract uses — one map, one mental model across prereq kinds.
- `args` (optional object) — args passed to the recursive execute. Supports `{{placeholder}}` substitution against the caller's own tokens + args, so the caller can forward its own `recipient_name` down to the lookup.
- `platform` (optional slug) — defaults to the caller's platform. Set when chaining cross-platform (rare).
- `optional` (optional boolean, default false) — when true, a failed sub-execute (non-2xx, missing strategy) binds every `vars` entry to null instead of failing the caller. Used when the caller can tolerate missing context.

**Multi-entry vars.** One capability response can feed multiple placeholders — declare each binding as its own entry:

```json
{
  "name": "member_lookup",
  "kind": "capability",
  "capability": "lookup_member_by_name",
  "args": { "name": "{{recipient_name}}" },
  "vars": {
    "member_id": "results[0].id",
    "member_display_name": "results[0].display_name"
  }
}
```

Two extractions, one sub-execute — the runtime calls `lookup_member_by_name` once and binds both values into the caller's scope.

**Save-time rules.** Self-loops and missing targets are rejected (override with `optional: true` to save out-of-order). `execute()` recursively calls the target with interpolated `args`, up to `MAX_PREREQ_DEPTH = 5`; non-2xx sub-execute fails the caller (or binds null if `optional`).

**Binding-oriented vs side-effect-oriented.** Capability prereqs come in two shapes. The binding-oriented shape (above) extracts values via `vars` that the caller substitutes through `{{<name>}}` placeholders. The **side-effect-oriented** shape runs a capability purely for its browser-context effects — most commonly a `login` capability whose recorded-path logs the user in and leaves an auth cookie on the shared `BrowserContext`. There is no return value worth binding; the caller (any tier — `fetch`, `page-script`, or another `recorded-path`) simply runs afterwards with the cookie jar already warm. For side-effect-only prereqs, **omit `vars` entirely** (or pass `{}`):

```json
{ "name": "ensure_logged_in", "kind": "capability", "capability": "login" }
```

The execute runtime shares the same warm `BrowserContext` across a capability prereq and its caller (the sub-execute checks out the warm slot, runs, returns the slot to the pool; the caller then checks out the same slot — `resetSession` navigates to `about:blank` but does not clear context-level cookies). Any cookies the sub-execute set are visible when the caller's request fires. The caller strategy referencing a side-effect-only prereq does **not** declare any `{{<name>}}` placeholder tied to it.

**Recorded-path callers.** A recorded-path strategy can declare capability prereqs the same way fetch/page-script do — the canonical use case is splitting an auth-gated multi-step flow into a `<site>_login` (recorded-path that ends with the user authenticated) plus a `<site>_<action>` (recorded-path with `prerequisites: [{kind: "capability", capability: "<site>_login"}]` that picks up post-auth). Each capability gets its own surface for triage, the literal_provenance audit doesn't cross-contaminate between login and action, and the cookie state flows through the platform's storage-state file. Prereqs run BEFORE the recorded-path opens its own session, so the steps execute against an already-warmed cookie jar.

**Requires warm-pool mode.** Cookie propagation relies on the caller reusing the same `BrowserContext` the prereq ran in. Warm-pool mode (`pool.warm.enabled: true` in `~/.klura/config.json`) enables this reuse. In cold-pool mode each sub-execute creates + destroys its own context and the caller receives a fresh one — side-effect-only prereqs silently fail to share state. If you're authoring a shared-login pattern, confirm warm pool is enabled; otherwise use a binding-oriented prereq (extract the session token, bind it, caller sends as header) which works in either mode.

**Worked example** — chat site, `send_message` needs `thread_id` but the caller only knows the recipient's name:

```json
// First: the lookup
save_strategy("example-chat", "lookup_thread_by_name", {
  "strategy": "fetch",
  "baseUrl": "https://www.example-chat.com",
  "endpoint": "/api/search?q={{name}}",
  "method": "GET",
  "response": { "format": "json", "extract": { "thread_id": { "path": "results.0.thread_id" } } },
  "notes": { "params": { "name": { "description": "recipient display name", "kind": "text", "example": "alice" } } }
})

// Then: the write, referencing it
save_strategy("example-chat", "send_message", {
  "strategy": "fetch",
  "baseUrl": "https://www.example-chat.com",
  "endpoint": "/api/messages/{{thread_id}}",
  "body": { "text": "{{text}}" },
  "prerequisites": [
    { "name": "resolve_thread", "kind": "capability", "capability": "lookup_thread_by_name",
      "args": { "name": "{{recipient_name}}" }, "vars": { "thread_id": "thread_id" } }
  ],
  "notes": { "params": {
    "recipient_name": { "description": "recipient display name", "kind": "text", "example": "alice" },
    "text": { "description": "message body", "kind": "text", "example": "hi there" }
  } }
})

// Warm execute — caller only needs recipient_name + text.
execute("example-chat", "send_message", { recipient_name: "alice", text: "hi" })
```

## tag prereq

The `{kind: "tag", ...}` prereq is the typed-edge alternative to `kind: "capability"`. The caller declares which **tag** it depends on; the runtime resolves to a specific saved capability at execute time by scanning the platform's capabilities for one that advertises that tag in its top-level `provides: ["<tag>"]` list. Use this when the dependency is on the _role_ a capability fulfills (an auth flow, a list source, a generic lookup) rather than on a specific slug — the indirection lets multiple implementations of the same role coexist, and lets the runtime auto-inject the dependency without name guessing.

**Shape:**

```json
{
  "name": "auth",
  "kind": "tag",
  "tag": "auth",
  "args": {},
  "vars": {},
  "optional": false
}
```

Fields mirror the capability prereq (`name`, `args`, `vars`, `platform`, `optional`) — only the discriminator differs (`tag` instead of `capability`). Side-effect-only tag prereqs omit `vars`.

**Capability side: `provides: [...]`.** A capability advertises tags it fulfills via a top-level array on the strategy body:

```json
{
  "strategy": "recorded-path",
  "provides": ["auth"],
  "steps": [
    /* ... login flow ... */
  ]
}
```

Tags are snake_case identifiers; one capability can advertise multiple tags. Validation: each tag must be a non-empty identifier, no duplicates within the array.

**Resolution at execute time.** The runtime calls `findCapabilitiesProviding(platform, tag)`:

- **Zero providers** → throws `no saved capability on this platform declares provides: ["<tag>"]`. Save such a capability or change the prereq to `{kind: "capability", capability: "<slug>"}`.
- **One provider** → resolves to that slug, runs it via the same machinery as a capability prereq (cache, args interpolation, `vars` binding).
- **Two or more providers** → throws with the list of slugs and instructs you to disambiguate by switching to `{kind: "capability", capability: "<specific-slug>"}`. The runtime won't pick one arbitrarily.

**The canonical `auth` tag.** Login flows save with `provides: ["auth"]`. Multi-method-auth platforms (gmail-OAuth + SSO + password) save each as its own capability, all advertising `["auth"]`; dependents either chain `{kind: "tag", tag: "auth"}` (resolves whenever there's exactly one provider on a given run, OR errors with the list to disambiguate) or `{kind: "capability", capability: "<specific-method>"}` (pinned to one method). The auto-injection layer (see `save_strategy` response field `auto_injected`) inserts the typed-tag form when an agent saves an auth-gated strategy on a platform that has at least one capability advertising `auth`.

**Auth-wall lazy retry.** When a sibling strategy hits an auth wall (401 / 403 / login-wall redirect) at warm execute, the runtime evicts the auth-providing capability's cache entry, re-fires the auth prereq, and retries the main strategy once. Bounded to one retry per `execute()` call — the second auth-wall returns `needs_reauth: true` to the LLM as before. This applies to both `kind: "tag"` and `kind: "capability"` prereqs whose target advertises `auth`.

**Save-time validation.** A self-loop check fires when the strategy being saved itself advertises the tag it requires (`provides: ["auth"]` AND `prerequisites: [{kind: "tag", tag: "auth"}]` on the same platform). At-least-one-provider must exist at save time unless the prereq is marked `optional: true`.

## enum params

Enum grounding stops the agent from hallucinating values at warm execute. User says "this one is on fire" → the agent needs to pick `priority=p0` because `{value: "p0", label: "🔥 Drop-everything"}` is in `observed_values`, not because the model invented `"urgent"` or `"critical"` from the prompt. Without this gate, a warm call fires with a value the server rejects and the caller pays a full round-trip to find out.

**Capture → observation pipeline.** As you drive the browser, the runtime correlates each UI click / select with the XHRs that fire within the next few seconds and records `{param_name, value, label, source}` tuples in a per-session index. `value` is the string the server received on that param; `label` is the clicked element's a11y name (or the `<option>` text for a `<select>`). Duplicate tuples are deduped; different labels for the same value are kept (one category can have both a plain name and a themed tile). You read these tuples back from the pre-save audit's checklist — the `param_observations_by_name` block echoes every recorded `{value, label}` per param so you can see exactly which entries you may declare.

**The kind rule.** Every `caller_input:X` classification requires `notes.params[X].kind`. Declare `"enum"` when the value is selected from a discoverable set (the observations show which), or `"text"` when it's free-form input the user types verbatim (a message body, a person's name, a search query). `"enum"` triggers the grounding check below. `"text"` is fine on its own — **except** when the runtime has UI-click observations for X, in which case clicks imply a selectable option set and you must supply a `text_kind_justification` (see below).

**Path A — static `observed_values`.** Small, stable enum: inline the tuples in the strategy. Each `{value, label}` you declare must match a runtime-recorded observation exactly. You cannot fabricate entries; the audit rejects any value that wasn't observed, and any `(value, label)` pair where the label doesn't match a captured pairing.

```json
"notes": {
  "params": {
    "priority": {
      "kind": "enum",
      "description": "ticket priority bucket",
      "observed_values": [
        {"value": "p0", "label": "🔥 Drop-everything"},
        {"value": "p1", "label": "Same-week response"}
      ]
    }
  }
}
```

**Path B — `source: "capability:<slug>"`.** Large or volatile enum, or one you discovered by crawling a list page rather than by clicking every tile: save a sibling `list_<entity>` capability (typically `fetch` + `response.extract` against the HTML tile markup) and point the caller param at it. Resolution is deferred to an execute-time prereq — the freshly-fetched list is authoritative.

```json
"notes": {
  "params": {
    "priority": {
      "kind": "enum",
      "source": "capability:list_priorities"
    }
  }
}
```

Prefer Path B when the set is large (hundreds of options), volatile (new items added frequently), or already list-page-sourced; prefer Path A for small stable sets where the observed tuples genuinely cover the universe. The runtime emits a `save_warning` when inline `observed_values.length > 50` nudging toward Path B.

**`text_kind_justification` escape hatch.** Rare but legitimate: a param that's genuinely free-form text yet also receives traffic triggered by UI clicks. The classic case is a search endpoint that fires both from typed queries (Enter) and from clicking a suggestion tile; the same param carries both literal user input and a selected-suggestion label. Declare `kind: "text"` and add a `text_kind_justification` explaining why clicks flow through this param but it's still free text.

The justification path is **structurally gated** — it's not a free pass:

- **The path is closed** if every observation for the param in this session was a UI click. With no captured non-click traffic for the param, there's no honest claim that the param is "also free-form text." Reclassify as `kind: "enum"`.
- **When the path is open** (the param has at least one observation that wasn't a click — typed-input XHR or api_response label), the justification must be ≥ 60 characters AND reference at least one observed click label verbatim. Same anti-canned mechanism as `save_warnings_acked` reasons: copy-pasting a label proves you read the captured signal, not a generic "this is a slug accepted as free-form." Canned excuses are runtime-rejected.

```json
"notes": {
  "params": {
    "q": {
      "kind": "text",
      "description": "search query",
      "text_kind_justification": "same endpoint fires from typed queries AND from clicking suggestion tiles; the typed path is the primary caller shape."
    }
  }
}
```

**Warm execute.** Agent reads `notes.params.X.observed_values` (echoed in execute response) and fuzzy-matches user intent against the `label` side. On tied labels, end the turn with a disambiguation question rather than guessing. Path B fetches the list fresh on each call; same fuzzy-match.

## save-strategy-audit

Every `save_strategy` call funnels through a single consolidated audit (`runtime/src/audit/lift/save-strategy.ts`). It composes structural detectors (Level-2 acked warnings) and classifier dimensions (Level-3 token-gated commitments) into ONE rejection envelope. The first call is ALWAYS rejected with a server-minted `audit_token` plus a unified checklist; the second call must echo the token and include `audit_answers` for the classifier dimensions plus inline acks for any detector warnings whose `ackReason: 'required'`.

The token is bound to a per-classifier `hashFields` slice of the strategy — sibling concerns mutating unrelated fields don't cascade-invalidate. Edit a literal-bearing field and only the `literal_provenance` token is invalidated; rewrite a prereq expression and the literal-classification answers stay valid.

**Classifier dimensions (token-gated):**

1. **`literal_provenance`** — every literal in an interpolable field (endpoint, wsUrl, body, generator code, prereq url / selector, recorded-path step values / selectors) must be classified as one of:
   - `"static"` — same for every caller (API version, locale, fixed path segment).
   - `{"caller_input": "<param>"}` — substituted from `notes.params.<param>` via `{{param}}`. Runtime checks `{{<param>}}` appears in the field AND `notes.params[<param>]` is declared.
   - `{"prereq_output": "<binds>"}` — substituted from a prereq's `binds`. Runtime checks `{{<binds>}}` appears in the field AND some prereq declares that `binds`.
   - `"single_entity"` — strategy intentionally works for one entity only. Runtime requires the literal to appear as-is in some `notes.params.<slug>.example`.

   `"static"` is rejected when the literal contains a substring that the runtime correlated to a UI click during this session (a `ParamObservation` with `source.kind: "ui_click"`). Clicks imply a selectable option set; the matched substring must be templated as `{{<paramName>}}` and reclassified as `{caller_input: "<paramName>"}` with `notes.params.<paramName>` declared as `{kind: "enum", observed_values: [{value, label}, ...]}` grounded in the captured pair. Same provenance principle as `observed_property_keys` / `observed_literal_values`, applied to the literal_provenance classifier so the audit can't be escaped by classifying a click-observed literal as static.

2. **`capability_name_justification`** — when the capability slug contains a lookup-implying segment (`by_<x>`, `for_<x>`, `lookup_<x>`) AND no prereq uses `kind: "capability"` or `fetch-extract`, the agent must supply a non-empty justification. Absent segment or lookup prereq present → field is ignored.
3. **`observed_siblings`** — runtime diffs the session's captured endpoints against the strategy and already-saved siblings. Every remaining entry must be answered `"recorded"` (called `record_observed_capability` for it) or `"not_worth_recording:<one-sentence reason>"`.
4. **`user_confirmation`** — every save requires explicit user approval before commit. Tier-agnostic: covers `fetch` / `page-script` / `recorded-path` uniformly. The first call returns `items.user_confirmation.required_facts` — a struct holding the load-bearing facts about the proposed save (`{capability, tier, target, anchor_type, warning_kinds}`) plus an `agent_note` re-stating the contract. Compose a 1-3 sentence prompt **in your own voice** that mentions every required fact, end with an explicit yes/no ask, relay it to the user, and retry with `audit_answers.user_confirmation: {agent_prompt: "<the prose you showed them>", user_decision: "approve" | "reject", user_quote: "<their fresh reply, ≥1 char>"}`. The runtime structurally checks `agent_prompt` covered every fact (capability slug verbatim, tier verbatim, target host or path, anchor word when page-script, a warning synonym — `"warning"` / `"flagged"` / `"issue"` / `"concern"` — when `warning_kinds` is non-empty). Same pattern as `tierJustificationUnciteable` on the triage-plan audit: phrase freely, runtime verifies the load-bearing facts arrived.
   - `user_decision: "approve"` + fact-covering `agent_prompt` + non-empty `user_quote` → save proceeds (other classifiers permitting).
   - `user_decision: "reject"` → save rejects with prose pointing back to LIFT — try a different tier or anchor based on the user's reason.
   - The classifier binds to the **whole strategy hash** (no `hashFields` scoping) — every distinct save shape needs its own approval. Mutating any field forces a fresh ask.

   **`user_quote` must be the user's fresh reply to THIS save's `agent_prompt`.** Do NOT reuse the user's reply to a prior `ack_checkpoint` (triage_plan, surface_changed) or any earlier turn. The runtime cannot detect recycled replies — there is no structural fingerprint that distinguishes a fresh user reply from a recycled one — so the contract is on the agent. Self-resolving the gate by recycling a reply defeats the gate's purpose: the gate exists because the user's call on the proposed strategy shape is the load-bearing decision, and that decision needs a separate elicitation per save. The `items.user_confirmation.agent_note` field on the rejection envelope re-states this contract inline. (`items.user_confirmation.debug_prompt` carries a deterministic runtime-composed rendering of the same facts as a fallback / example — useful when you want a starting phrasing — but the load-bearing answer is your own `agent_prompt`.)

   **Test harnesses / autonomous runs** can register a `SaveConfirmationDecider` via `registerSaveConfirmationDecider({name, decide(strategy, ctx)})` to auto-decide based on a scenario predicate. When a decider is registered, the runtime synthesizes the answer (including a deterministic `agent_prompt`) before the audit runs and the agent never sees the rejection. Production runs leave the slot empty so the agent always prompts the human; if you're operating an autonomous benchmark or scheduled run with no live human, register the decider at the embedder layer rather than self-attesting through the agent path.

**Token-bound warning Classifiers (each requires an `audit_answers.<kind>` reason):**

- `mutating_verification_required` — strategy is mutating-shaped (HTTP POST/PUT/PATCH/DELETE on fetch/page-script, recorded-path with type/submit, page-script `.publish()` / `.send()`, fetch with `protocol: "websocket"`). Answer with a one-sentence reason naming the verification approach by structural anchor — either reference a real path of the saved strategy (`response.extract.<field>`, `prerequisites[N]`, `frameFromPage.expression`) or include a recognized shape tag (`transaction-shape` / `chat-shape` / `dom-poll` / `intrinsic-to-caller` / `rpc-read` / `fire-and-forget`). `fire-and-forget` requires a justifying noun (telemetry, beacon, idempotent, etc.). Anchor-match: `module`/`protocol`-anchored strategies acked with `dom-poll` only are rejected — DOM polling becomes the fragility bottleneck.
- `parameterization_disclosure_required` — `notes.params` is empty/undefined. Most capabilities have at least one caller-varying axis (count, cursor, query text, id, locale, ordering); a paramless save means warm callers can't customize the call. Answer with a one-sentence reason naming a structural anchor of the saved strategy (a body field, header key, endpoint segment, prereq name) that proves the capability is genuinely parameterless. Bare prose like "no params apply" is rejected.
- `observed_property_keys` — prereq expression bakes property-access keys the agent observed at runtime in this session (via `js_eval` results / `find_in_page` matches). Answer with a one-sentence reason that references at least one flagged key by name with a word-boundary match — proves the rejection was read. Templates for shape-walks below.
- `observed_literal_values` — strategy header / body / step value matches a string the agent observed at runtime. By construction a per-session artifact (rotating token, signed nonce). Answer with a one-sentence reason referencing at least one flagged literal value verbatim, OR template via a prereq.

**Detector warnings (each requires `notes.save_warnings_acked: [{kind, reason}]` OR a strategy fix):**

- `unobserved_url` — strategy `endpoint` or prereq `url` was not captured in the session network log. **No ack-through path** — fix the URL or the save fails (per "Observe, not probe": URL hallucination from training data is runtime-rejected, not justifiable).
- `unparametrized_session_id`, `unresolved_name_to_id_gap`, `entity_pinned_infra_prereq`, `prereq_bind_key_mismatch`, `inline_multi_fetch`, `lookup_embedded_in_prereq`, `name_id_mismatch`, `session_scoped_id_extraction`, `lookup_prereq_must_be_capability` — structural red flags from `runtime/src/gate/save-warnings.ts`. Each fixed-or-acked.
- `unreferenced_prereq_binding` — a `js-eval` prereq declares `binds: "<name>"` but `{{<name>}}` is never referenced in `endpoint` / `baseUrl` / `body` / `headers` / `params` / `frameFromPage.expression` / a sibling prereq's `args_template` / `url` / `expression` / `fetch_body` / `headers_map`. Two shapes both silently corrupt warm execute: (a) the binding name is misspelled at the call site, or (b) the prereq is doing the real work via side effects (firing the actual fetch + parse internally) and the declared HTTP envelope is dead, so the caller receives whatever the dead envelope returns instead of the prereq's value. Fix by referencing `{{<name>}}` in the request envelope, OR drop the envelope (clear `endpoint` / `method` / `body` / `headers`) and move the prereq's logic into a top-level `frameFromPage.expression` so the return value IS the caller's result. Ack-with-reason is the third path when the binding genuinely drives a side-effect-only refresh whose value warm callers don't read.
- `auth_gated_without_auth_prereq` — strategy targets an origin where the session captured one or more responses that set cookies, but the strategy declares no `{kind: "capability"}` or `{kind: "tag", tag: "auth"}` prereq. Cold-execute (fresh `storage_state`) and expired-cookie callers will hit the auth wall. The only opt-out without chaining auth is declaring `provides: ["auth"]` on the strategy itself (the agent is saving the auth-providing capability). Path-matching the strategy's endpoint against captured cookie-setters is **not** a bypass — gateways that multiplex operations under one path (GraphQL, JSON-RPC, generic `/api/v1/`) would silently suppress the warning when an unrelated operation on the same path happened to set cookies. Either factor the cookie-setting flow into a sibling capability with `provides: ["auth"]` and chain `{kind: "tag", tag: "auth"}`, declare the saved strategy itself as the auth provider, or ack via `notes.save_warnings_acked` if the cookie isn't auth (A/B test bucket, preference cookie this strategy doesn't depend on).
- `popup_addressing_without_trigger` — a recorded-path step pins to `page: "popup-N"` but no popup with that handle was observed during the discovery session. The flow is almost certainly missing the click that opens the popup. Either add the trigger step, re-discover, or ack via `notes.save_warnings_acked: [{kind: "popup_addressing_without_trigger", reason: "..."}]` if the popup is opened by a side channel (browser extension, prior tab). See `klura://reference#popups`.

**Why observation = fragility (`observed_property_keys` / `observed_literal_values`).** A name or value the agent saw at runtime is an _artifact of the site's current build_ — minified output, obfuscated identifier, deploy-versioned global, rotating signed token. Stable web API names (`document.cookie`, `event.target`, `location.pathname`) come from web standards and don't rotate. Stable HTTP wire vocabulary (`application/json`, `GET`, `no-cache`) is contract by definition. Anything in between is observation: minifier shuffles it, deploy renames it, server rotates it.

| Source | Contract or observation? | Example |
| --- | --- | --- |
| Documented public API name | Contract | `document.cookie`, `event.target.value`, `navigator.userAgent` |
| Page literals from `get_js_source` | **Observation** | `window.__app.me.o.nonce` baked in a `<script>` block |
| `Object.keys(x)` results | **Observation** | `["me", "xa"]` from a probe |
| HTTP wire vocabulary | Contract | `application/json`, `GET`, `Bearer` |
| Network response field names | Mixed — contract iff documented | `body.user.id` vs `body.__t.f.x` |
| Per-call header/cookie value seen mid-session | **Observation** | `x-nonce: c958faf6...` |
| Caller arg `{{placeholders}}` | Contract by definition | `args.text`, `args.thread_id` |

**Templates for shape-probing instead of baking observed names:**

```js
// Tier 1 — walk a known root
const nonce = Object.values(window.__app)
  .flatMap((v) => (v && typeof v === 'object' ? Object.values(v) : []))
  .find((v) => typeof v?.nonce === 'string')?.nonce;

// Tier 2 — walk all top-level globals
const nonce = Object.values(window)
  .flatMap((v) => (v && typeof v === 'object' ? Object.values(v) : []))
  .flatMap((v) => (v && typeof v === 'object' ? Object.values(v) : []))
  .find((v) => typeof v?.nonce === 'string')?.nonce;

// Tier 3 — pin via known-stable signal (instanceof, constructor.name on a documented class)
const conn = Object.values(window).find((v) => v?.constructor?.name === 'WebSocketClient');
```

**Templating an observed literal value via a prereq:**

```json
{
  "kind": "js-eval",
  "expression": "Object.values(window).flatMap(v=>v&&typeof v==='object'?Object.values(v):[]).find(x=>typeof x?.nonce==='string')?.nonce",
  "binds": "nonce",
  "return_shape": { "kind": "string" }
}
```

Then reference `{{nonce}}` in the header / body slot.

**When to ack and keep the baked path** (rare):

- Dev-mode site with non-minified source you've checked into git
- One-shot throwaway skill (you'll delete it after one use)
- Site has explicit version pinning and you're targeting a frozen version

The ack reason must reference a flagged value / key — generic "intentional" doesn't pass; the runtime checks for word-boundary substring match (anti-canned-ack guard).

**Rejection shape (first call):**

```
invalid_strategy: save_strategy_audit (pending)
  audit_token: aB12cD34
  warnings:
    - observed_property_keys: prerequisites[0].expression bakes chain "me.o" inside "window.__app.me.o.nonce"…
    - observed_literal_values: headers["x-nonce"] bakes value "c958faf6168bed67ea86dabacee3f5b7"…
  classifier_items:
    literal_provenance (classify each path):
      - endpoint: "/api/conversations/93210/messages"
      - body: "{\"text\":\"{{text}}\"}"
    capability_name segments:
      - "by_name" — implies a lookup step…
    observed_siblings (recorded | not_worth_recording:<reason>):
      - "POST https://api.example.com/users/search"
  how_to_respond: call save_strategy again with
    {audit_token, audit_answers: {literal_provenance: {...}, capability_name_justification?: "...", observed_siblings: {...}, acks?: {observed_property_keys: "...", observed_literal_values: "..."}}}
```

**Successful answer shape (second call):**

```json
{
  "audit_token": "aB12cD34",
  "audit_answers": {
    "literal_provenance": {
      "endpoint": { "prereq_output": "thread_id" },
      "body": { "caller_input": "text" }
    },
    "observed_siblings": { "POST https://api.example.com/users/search": "recorded" },
    "acks": {
      "observed_property_keys": "Keys 'me' and 'o' are frozen offsets in this dev fixture."
    }
  }
}
```

Rejection on the second call lists each failing answer with the exact mismatch. Fix the strategy OR reclassify and resubmit with the same token — the per-classifier hash is stable across edits to unrelated fields.

## self-verifying-strategies

Every mutating-shaped strategy must verify its side effect before returning `ok:true`. `status:200` proves the network call succeeded — not that the right entity was mutated. The save-time `mutating_verification_required` detector fires on:

- `fetch` / `page-script` with `method` ∈ `{POST, PUT, PATCH, DELETE}`
- `recorded-path` with any step whose `action` ∈ `{type, fill_editor, fill, submit, key_press}`
- `page-script` whose `frameFromPage.expression` contains `.publish(` or `.send(`

Acknowledge via `audit_answers` on the second-call retry (the first call mints the token and emits `items.mutating_verification_required` carrying `valid_paths` and the strategy's `anchor_type`):

```json
{
  "audit_answers": {
    "mutating_verification_required": "<shape tag>: <structural anchor>"
  }
}
```

The reason must contain either a path-shaped token naming a real element of the saved strategy (`response.extract.<field>`, `prerequisites[N]`, `frameFromPage.expression`, a bound prereq name) OR one of the recognized shape tags. Prose-only reasons are rejected. The runtime token-binds this Classifier to the strategy's mutating-shape slice (method, endpoint, body, headers, response, frameFromPage, steps), so the agent must consume a real rejection's token to commit — canned reasons that happen to substring-match an anchor without reading the rejection don't pass.

**Shape tags** and what they claim:

- `transaction-shape` — server's mutating response carries the confirmation: `response.extract.<id field>`. Cleanest. Example: `"transaction-shape: response.extract.message_id is the server-issued id; absence = failure"`.
- `chat-shape` — read OUR own outbound back from page state after the call. Use a `verify_*` js-eval prereq that polls a page global (e.g. `window.require("ChatStore").get(args.thread).messages.find(m => m.text === args.text && m.outbound)`). Example: `"chat-shape: frameFromPage.expression awaits publish ack via window.require module before returning"`.
- `dom-poll` — poll the DOM for a confirmation element after the call. Fragile (UI rewrites break it). Acceptable when nothing better exists. Example: `"dom-poll: verify_sent js-eval prereq polls .toast-success for 2s after publish"`.
- `intrinsic-to-caller` — the caller's natural next move IS the verification (e.g. a paired `read_messages` capability). The strategy itself doesn't verify.
- `rpc-read` — POST is the envelope but the operation reads, not writes. GraphQL queries, JSON-RPC reads, and "search" endpoints all POST to a single endpoint regardless of operation kind; the response payload IS the data being read. Nothing to verify because nothing was mutated. Example: `"rpc-read: GraphQL query; response.data carries the payload, no side effect to verify"`. Use this only when the operation truly reads — a GraphQL `mutation` is not `rpc-read`.
- `fire-and-forget` — rare. Server-side telemetry / idempotent housekeeping with no UI surface. Requires a justifying noun: one of `telemetry`, `idempotent`, `beacon`, `analytics`, `keepalive`, `heartbeat`, `log`, `metric`. Example: `"fire-and-forget — analytics telemetry beacon, idempotent on the server"`.

**Verification verifies the SEND, not the recipient's reply.** For chat: confirm OUR outbound message landed in the thread — not "wait for them to reply." The reply is its own capability (`read_messages`).

**Anchor-match.** Verification durability must match `notes.anchor_type`. A module/protocol-anchored strategy whose only verification is `dom-poll` makes the DOM the new fragility bottleneck. The match table:

| `notes.anchor_type` | Acceptable verification approaches |
| --- | --- |
| `module` | `transaction-shape` (response.extract from the module's response), `chat-shape` whose readback uses `window.require(...)` page-globals, `intrinsic-to-caller` |
| `protocol` | `transaction-shape` (response.extract or WS-frame-readback), `intrinsic-to-caller`, `chat-shape` parsing the wire response (NOT DOM polling) |
| `dom` | any approach (DOM is already the floor) |
| `unknown` | any approach (no claim to match) |

Module/protocol-anchored saves whose ack contains ONLY `dom-poll` (no module/protocol marker like `response.extract`, `window.require`, `frameFromPage.expression`, `wire`, `mqtt`) are rejected with an `anchor mismatch` ack-issue.

**Worked example — chat send with `transaction-shape` verification.** The strategy itself carries no inline ack; the agent submits the verification reason via `audit_answers` on the second-call retry:

```json
// Strategy:
{
  "strategy": "page-script",
  "method": "POST",
  "endpoint": "/api/messages",
  "frameFromPage": {
    "expression": "(async()=>{ const r = await window.__app.send({to: args.thread, text: args.text}); return {message_id: r.message_id}; })()"
  },
  "response": { "extract": { "message_id": "message_id" } },
  "notes": { "anchor_type": "module" }
}

// Retry call:
{
  "audit_token": "<from prior rejection>",
  "audit_answers": {
    "mutating_verification_required": "transaction-shape: response.extract.message_id is the server-issued id; missing = failure"
  }
}
```

**Worked example — recorded-path with `dom-poll`:**

```json
// Strategy:
{
  "strategy": "recorded-path",
  "steps": [
    { "id": "s1", "action": "type", "value": "{{text}}",
      "locators": { "a11y": { "role": "textbox", "name": "Message" } } },
    { "id": "s2", "action": "submit",
      "locators": { "a11y": { "role": "button", "name": "Send" } } },
    { "id": "s3", "action": "click",
      "locators": { "a11y": { "role": "status", "name": "Sent" } } }
  ],
  "notes": { "anchor_type": "dom" }
}

// Retry call:
{
  "audit_token": "<from prior rejection>",
  "audit_answers": {
    "mutating_verification_required": "dom-poll: steps[2] confirms the \"Sent\" status element appears"
  }
}
```

Also consider validating each declared `notes.params.<name>` value before the call fires (e.g., the recipient lookup actually found a thread before typing into the composer) — a missing recipient is exactly the misroute the verification step should catch.

## parameterization-disclosure-required

Every saved strategy must either declare its caller-varying axes via `notes.params` or explicitly justify why none apply. Most capabilities have at least one axis (count, cursor, query text, id, locale, ordering); a save without any means warm callers can't customize the call. The save-time `parameterization_disclosure_required` detector fires whenever `notes.params` is absent, missing, or empty — for every tier (`fetch`, `page-script`, `recorded-path`).

**Why this exists.** End-drive's auto-derive (`runtime/src/strategies/synthesize-on-close/fetch.ts`) populates `notes.params` only from caller-typed literals — the values the agent passed to `start_session({args:{…}})` during discovery. Sessions driven with `args:{}` synthesize a strategy with `notes.params` empty, and (until this gate fired) landed silently. The gate makes the parameterless case a deliberate ack, not a quiet default.

**Two fixes:**

1. **Declare the axes.** Re-discover with `start_session({args:{<param>: <example>}})`, type the example into the flow you want parameterized, save again — auto-derive correlates the literal to the captured request body and stamps `notes.params.<param>` for you. Or hand-edit the saved strategy: add `notes.params.<name> = {kind, description, example}`, replace the literal in body/endpoint with `{{<name>}}`.
2. **Answer as parameterless.** On the second-call retry:

   ```json
   {
     "audit_token": "<from prior rejection>",
     "audit_answers": {
       "parameterization_disclosure_required": "<structural anchor + why parameterless>"
     }
   }
   ```

   The reason must reference at least one structural anchor of the saved strategy: a body field key, header key, endpoint path segment, prereq name, recorded-path step id, the literal endpoint, or `method`. Bare prose ("this capability has no params") is rejected — the runtime checks the reason against the candidate-anchors list it emitted on the rejection. Token-bound: the agent must consume a real rejection's token to commit, and the token's hash binds to `{endpoint, body, headers, prerequisites, steps}` so a body change cascade-invalidates the token (fresh anchor list, fresh ask).

**Worked acks:**

- `"endpoint /api/me/logout: no path params, body absent, prereq csrf_token covers the only caller-invariant secret"`
- `"viewer-scoped — endpoint /api/viewer/profile returns the calling user's data; no input axis"`
- `"body fields query and doc_id are static GraphQL operation metadata; the captured request had no variables block"`

**Tier sensitivity.**

- `fetch` / `page-script`: typical case is body fields or URL query keys missing from `notes.params`. The fix is usually to declare them and template `{{name}}` into the body/endpoint.
- `recorded-path`: caller-varying values appear as `step.value` strings on `type` / `fill_editor` steps. Declare them as params and replace the literal step value with `{{name}}`.

Genuinely-parameterless capabilities exist (`logout`, `current_user_id`, `viewer_profile`); the ack path is for them. The detector fires unconditionally so the parameterless choice is always a deliberate one.

## end-drive-audit

Every `end_drive` call funnels through a single consolidated audit (`runtime/src/audit/drive/end-drive.ts`) — sibling shape to the `save-strategy-audit`. It composes structural detectors and token-gated classifiers into ONE rejection envelope.

**Detector — `capability_declaration_required` (no ack-through path).** Refuses close on attempts 1 and 2 when the session typed or submitted content but never declared a capability. Auto-save needs a capability slug to key under; without one, the session degrades to a keyless recorded-path that nobody can look up at warm execute. Fix is to call `declare_capability({session_id, capability, args})` before retrying — OR call `abort_session(session_id, reason)` if the session shouldn't have started in the first place. A third close attempt force-tears-down regardless — the orchestrator skips the audit on attempt 3.

**Detector — `save_attempted_none_landed` (no ack-through path).** Refuses close when the session called `save_strategy` at least once and zero saves landed. Stops the legacy-form-post failure mode where the agent gives up mid-recoverable-loop and end_drive papers over the silent failure with whatever stale strategy was on disk. Fix the most recent rejection (read its `audit_token` + `audit_answers` checklist), retry the save, OR call `abort_session(reason)` if the strategy is unsalvageable.

**Detector — `re_persistence` (no ack-through path).** Refuses close when the session did **heavy reverse-engineering work** that isn't reflected on disk and isn't being persisted. Triggers when ALL of:

- **Heavy RE happened**: ≥ 1 (discover graph) call to `set_breakpoint`, `get_js_source`, `search_js_source`, `read_js_function`, `evaluate_on_frame`, or a full-body `get_network_log` (which returns inline `<script>` source — equivalent to `get_js_source`). `js_eval` does **not** count toward this trigger — it's the everyday "read a value off the page / parse a response body" tool, not an RE signal in isolation. (`js_eval` calls _are_ named in the rejection message alongside the heavy count, so you see the full picture, but they never trip the gate on their own — any RE flow worth persisting first has to _find_ the code, which is a heavy tool.)
- **Zero persistence calls** (`save_verified_expression`, `add_discovery_note`, `add_resume_pointer`).
- **The work isn't already on disk**: some declared capability is still unresolved, OR no capability was declared. If every declared capability resolved to a non-stale saved strategy, the RE work is baked into those strategies — nothing is orphaned, the gate skips (and `triage_acknowledgment` handles the "all saved, confirm no further triage" case instead).

Map-mode sessions also trigger when ≥ `ACTION_CALL_THRESHOLD` (currently `5`) `perform_actions` landed with zero persistence calls — surface-mapping work that isn't persisted is invisible to the next session. (`reCalls` for map is `1` too, covering the rarer "did heavy RE while mapping but left no breadcrumb" case.)

**Why the re_persistence gate exists.** The discovery artifact is the only channel for cross-session continuity. A session that probed a signer, walked a bundle, or stepped through a debugger but saved nothing — neither a strategy nor a breadcrumb — forces the next session to redo that work from scratch; the RE toolkit is expensive enough that losing the findings is the single biggest cross-session waste mode. There is NO LLM-authored "no progress to save" verdict — klura is always-save-by-default. Either persist what you found, or call `abort_session` if the work was misguided. (Known, accepted gap: speculative graduation RE done in a session that _also_ landed a recorded-path slips through — persist it voluntarily via `add_discovery_note` / `save_verified_expression`; the triage round is the place for it.)

**Post-auto-synth — `silent_no_save` guard (no ack-through path).** After auto-synth runs, if the session declared a capability but neither a manual `save_strategy` nor an auto-synthesized fallback produced anything, close is rejected. This catches the post-hoc-declaration escape: agent declares retroactively to satisfy `capability_declaration_required`, never saves, auto-synth can't derive anything (the captures didn't carry templatable literals), and the session would otherwise close cleanly with zero strategies on disk. The third end_drive attempt force-tears-down regardless. Fix is to save manually OR call `abort_session(reason)`.

**Classifier — `triage_acknowledgment` (token-gated).** Fires when end_drive would otherwise skip triage entirely (every declared capability already has a non-stale saved strategy). Agent must echo `audit_token` + `{triage_acknowledgment: {acknowledged: true, reason: "<own words ≥20 chars>"}}`. Token binds to `{sessionId, declaredCapabilityCount, saveSuccessCount, endDriveAttempts}`.

**Rejection shape (first call):**

```
invalid_strategy: end_drive_rejected (pending)
  → Your end_drive call is NOT committed. Nothing was saved.
  → To commit: call end_drive again with {audit_token, audit_answers, acks} (fix the issues above).
  audit_token: aB12cD34
  warnings:
    - [capability_declaration_required] CANNOT CLOSE: this session typed or submitted content but no capability was declared…
      hint: Call declare_capability({session_id, capability: "<slug>", args: {...}}) before closing — OR call abort_session(session_id, reason) if the session was misguided.
    - [re_persistence] CANNOT CLOSE: 2 code-inspection / breakpoint calls on session …, but zero persistence calls.
      hint: Two valid next moves: (1) PERSIST: save_verified_expression / add_discovery_note / add_resume_pointer, then retry. (2) ABORT: abort_session(session_id, "<reason ≥20 chars>") for the honest exit.
  See klura://reference#end-drive-audit.
```

**Escape paths.** All three Detectors above (no ack-through) require state-fix on retry:

- **Persist + retry** (re_persistence): call `save_verified_expression` / `add_discovery_note` / `add_resume_pointer` to land progress; gate clears once `persistCallCount > 0`.
- **Save + retry** (save_attempted_none_landed, silent_no_save): land an actual `save_strategy` success.
- **Declare + retry** (capability_declaration_required): call `declare_capability` before retrying end_drive.
- **Abort** (any Detector above): call `abort_session(session_id, "<reason ≥20 chars>")`. This bypasses the audit entirely; reason logs to the platform's `abort_events` ledger for cross-session visibility. Legitimate reasons: existing capability covers the task, user explicitly said stop, site dead/blocked. NOT legitimate: "this is a one-off task" — that judgment isn't the agent's to make. klura is always-save-by-default.

The Detector design (no audit_answers escape) is deliberate: prior history showed agents satisfying ack classifiers with canned answers once they learned the shape, defeating the gate. State-fix-or-abort closes that hole. See `memory/feedback_klura_always_save_default.md` and `memory/feedback_llm_self_gate_cheating.md`.

**Module location.** `runtime/src/audit/drive/end-drive.ts` (the Audit instance), `runtime/src/phases/drive/end-drive-orchestrator.ts` (the silent_no_save guard), `runtime/src/audit/index.ts` (the framework). See `runtime/docs/gates.md` for the Detector/Classifier shapes and `runtime/docs/principles.md` §pre-commit gates for the taxonomy.

## js-eval

The `js-eval` prereq runs a short async expression inside the page, validates the return against a declared shape, and binds the result as a token. A strategy with any `js-eval` prereq is stamped `transport: "browser"` automatically.

**When to use vs. cheaper prereqs:**

- Value rendered into a meta tag / hidden input / data-attribute → `page-extract`.
- Value from a JSON response on an observed same-origin endpoint → `fetch-extract`.
- Value produced by a JS function call (`window.<something>.<method>()`) and never rendered into the DOM → `js-eval`.

**Discovery signal** (use when all three hold):

1. Captured request body contains a value the user didn't provide (hash, base64, token, long alphanumeric).
2. `find_in_page(session, <value>)` returns zero matches — never rendered into DOM.
3. Network log shows no separate request that fetched it.

When this holds, the page mints the value via its own JS; `js-eval` calls that function. **Do not fall back to recorded-path because the value looks complex — this is the case `js-eval` was built for.** Probe for the mint global with `Object.keys(window).filter(k => /token|captcha|sign|guard/i.test(k))` if you can't guess its name.

Example:

```json
{
  "strategy": "fetch",
  "method": "POST",
  "baseUrl": "https://www.example.com",
  "endpoint": "/api/submit",
  "headers": { "X-Page-Token": "{{pageToken}}" },
  "body": { "input": "{{text}}" },
  "prerequisites": [
    {
      "name": "mintPageToken",
      "kind": "js-eval",
      "url": "https://www.example.com/new",
      "expression": "await window.__pageGuard.mintSubmitToken()",
      "binds": "pageToken",
      "return_shape": { "kind": "string", "min_length": 20, "max_length": 4000 },
      "timeout_ms": 5000,
      "refresh": { "enabled": true, "interval_seconds": 60, "jitter_seconds": 10 }
    }
  ]
}
```

Schema:

- `url` (required): the page the expression will run inside. The runtime navigates here before evaluating, and skips the navigate if the session is already on a matching `{origin, pathname}` — so warm reuse on the same page does not re-load it.
- `expression` (required): a short **async-compatible JavaScript expression** (≤ 2 KB). The runtime wraps it in `(async () => (<expression>))()` and awaits the result. Raw `return` statements are rejected at the driver boundary — emit an expression whose _value_ is the token (`await window.foo.mint()`, `document.querySelector('meta').content`, etc.), not a function body. Syntax must have balanced quotes and brackets; the validator catches obvious garbage before the expression ever hits the page.
- `binds` (required): the token name the result is bound to. Used in the strategy body/headers via `{{<binds>}}` placeholders, exactly like the `varName` of a `page-extract` prereq.
- `return_shape` (required): `{kind: "string" | "number" | "boolean" | "object", min_length?, max_length?, required_keys?}`. Lets the runtime validate the value on every mint and refresh, catching the "expression used to return a string and now returns `undefined`" drift silently. For `kind: "object"`, `required_keys` is a whitelist of keys that must be present, and the object is JSON-serialized into the token slot. `min_length` / `max_length` are only valid for `kind: "string"`.
- `timeout_ms` (optional): cap on how long the expression can take per evaluation. Default 5000 ms, hard max 30000 ms. Reached-timeout rejects with a readable error; the strategy is marked degraded and the cascade falls down.
- `refresh` (optional): `{enabled, interval_seconds, jitter_seconds?}`. When `enabled: true`, a background loop tied to the warm pool re-runs the expression every `interval_seconds ± jitter_seconds` and stashes the latest value. Execute reads from the cache first — a warm call hits a pre-minted token with zero latency. When the warm context for the platform is evicted (LRU, TTL, shutdown), the refresh loop is cancelled automatically; the cache is dropped along with it. `interval_seconds` has a 5-second floor; shorter cadences hammer the site with no real benefit. Refresh is a **warm-pool optimization**: without warm mode, there's no background session to tick against, so execute always mints synchronously and the refresh flag is a no-op. **Mutually exclusive with `args_template`** — see below.
- `args_template` (optional): `{<name>: <value-or-template>}`. When present, the prereq runs in **per-call mode** and the resolved object is exposed to the expression as the `args` identifier — `await window.__sign(args.body)`. Values may template against the caller scope via `{{placeholder}}`, e.g. `args_template: {body: "{{request_body}}", path: "{{endpoint}}"}`. Per-call mode skips the cache and the refresh loop entirely — the value depends on per-call inputs, so a cached result would bind the wrong value to the wrong call. **Use when the page-side mint function reads from the request being signed**. For inputs-independent mints, keep `args_template` omitted and use `refresh` instead.
- `frame` (optional): a CSS selector for an `<iframe>` element on the page. When present, the expression evaluates inside the iframe's `contentFrame` instead of the main page — needed when the global the expression names lives in a cross-origin iframe and is therefore unreachable from main-world script. Selector points at the outermost iframe element on the parent page (`iframe[src*="example.com/widget"]`, `iframe[title="Embedded widget"]`); chained frame paths are not supported. The runtime waits briefly for the iframe to attach, then dispatches `frame.evaluate`. Cross-origin iframes are reachable via Playwright's OOPIF support.

**Per-call signer example** — page-side `__sign` reads the request body before producing the signature:

```json
{
  "name": "request_signature",
  "kind": "js-eval",
  "url": "https://www.example.com/app",
  "expression": "await window.__sign({url: args.url, body: args.body})",
  "binds": "request_signature",
  "return_shape": { "kind": "string", "min_length": 28, "max_length": 64 },
  "args_template": {
    "url": "{{endpoint}}",
    "body": "{{request_body}}"
  }
}
```

**Iframe example** — `mintToken` lives inside an embedded widget at a different origin:

```json
{
  "name": "widget_token",
  "kind": "js-eval",
  "url": "https://www.example.com/checkout",
  "frame": "iframe[src*='widget.example-host.com']",
  "expression": "await new Promise(r => window.widget.mintToken(r))",
  "binds": "widget_token",
  "return_shape": { "kind": "string", "min_length": 100 },
  "refresh": { "enabled": true, "interval_seconds": 240 }
}
```

**Save-time probe** navigates to `url`, evaluates `expression` once (passing a stub `args` object built from `args_template`'s keys when per-call mode is in use, and dispatching to the iframe's contentFrame when `frame` is set), verifies the return matches `return_shape`.

**Common pitfalls**: writing a function body (`return X`) instead of an expression (`X`) — the runtime wraps in an async IIFE and rejects raw `return`. Hardcoding an intermediate token value instead of calling the live global each time. Setting `refresh.enabled: true` without warm mode (the refresh loop requires a warm context; without warm it's a no-op). Setting `args_template` AND `refresh.enabled: true` together — rejected at save time as incoherent (per-call args can't be cached on a clock). Pointing `frame` at a non-iframe element, or at an iframe that has not attached by the time the prereq fires (the runtime waits up to the eval timeout for it to attach, then errors with the resolved selector). **`args_template` values pass through as strings** — `args_template: {count: "{{count}}"}` arrives at the expression as `args.count === "3"` even when the caller arg is numeric, because the template engine substitutes textually. Cast inside the expression (`const count = Number(args.count)`) whenever you need numeric semantics; `array.length >= args.count` will silently misbehave at boundaries with a stringly-typed count. **`return_shape.min_length` floor for serialized JSON arrays** — `JSON.stringify([])` is `"[]"` (length 2), so `min_length: 2` lets empty results through silently. When the expression returns a JSON-serialized array, set `min_length` ≥ 3 to fail loud on the empty-array case; better still, return the structured value and use `kind: "object"` with `required_keys` so the runtime validates the shape rather than just the byte count.

## interrupts

`strategy.interrupts[]` is an optional top-level array of reactive observer/handler entries that fire at well-defined lifecycle edges during `execute`. Consistent with klura's stealth-not-bot-evasion stance (see `runtime/docs/principles.md`) — the bundled `user-assist` handler never solves a challenge automatically; it opens the remote viewer, shows a prompt, waits for the operator. Use interrupts for:

- **CAPTCHA / click-through gates** (hCaptcha, reCAPTCHA, Turnstile, site-specific puzzle) — the operator solves, optional `bind_from` extracts a minted token, the request fires with it.
- **Mid-flow challenges** in a `recorded-path` — a CAPTCHA iframe that only appears _after_ a step (e.g. after clicking Publish). `at: "between_steps"` catches it.
- **Login / session refresh** — the operator re-authenticates in the viewer; execution resumes against the now-valid session.
- **Side-effect gates** — interstitials that need a human touch but don't mint a token; omit `binds`/`bind_from`.

### Shape

```json
{
  "name": "hcaptcha_gate",
  "at": "between_steps",
  "observe": { "kind": "selector_visible", "selector": "iframe[src*=\"hcaptcha.com\"]" },
  "handler": {
    "kind": "user-assist",
    "message": "Solve the hCaptcha and press Done.",
    "binds": "hcaptcha_token",
    "bind_from": { "kind": "cookie", "name": "hcaptcha-response" },
    "timeout_ms": 180000
  },
  "priority": 0
}
```

- `name` **required** — unique within the strategy's `interrupts[]` list; surfaced in error messages.
- `at` **required** — the lifecycle edge where the runtime evaluates the observer:
  - `pre_execution`: once, before any step / eval / request fires. Replaces gate-level guards.
  - `between_steps`: after each `recorded-path` step completion. For challenges that only appear mid-flow.
  - `after_response`: reserved for LIFT on `page-script` / `fetch` (evaluated on the response-received edge).
- `observe` optional — skip the interrupt when the predicate is falsy. Absent = always fire (unconditional gate). Predicate kinds live in the predicate registry (see below).
- `handler` **required** — `{kind, ...}` dispatched via the handler registry. `kind` names a registered handler; the rest is that handler's shape.
- `priority` optional integer — higher fires first when multiple interrupts match at the same edge; default 0; array order breaks ties.

### Bundled predicate kinds (observers)

- `selector_visible` — `{selector: string}`. Truthy when the element is present AND has a non-zero bounding box. Use for "is this challenge rendered?"
- `response_body_matches` — `{pattern: string}`. Regex match against the page's current HTML. Use for server-rendered challenge banners.
- `js_eval` — `{expression: string}`. Bounded async expression; truthy return value. Use when neither selector nor HTML regex is precise enough.

### Bundled handler kind

- `user-assist` — `{message, url?, binds?, bind_from?, timeout_ms?}`.
  - `message` **required** — operator-visible prompt in the viewer.
  - `url` optional — opens in the viewer before the operator starts; defaults to the session's current URL. Supports `{{placeholder}}` against caller args.
  - `binds` + `bind_from` present-together or absent-together. When set, the minted value becomes `{{<binds>}}` in the strategy's endpoint/body/headers and in subsequent recorded-path steps' selector/value fields. When absent, this is a side-effect gate.
  - `bind_from.kind`: `"cookie"` (read by name), `"selector"` (CSS selector + optional `attr`), `"js-eval"` (bounded async expression returning the token).
  - `timeout_ms` optional — default 120_000, hard cap 600_000. On timeout the strategy fails with a clear "operator did not signal done" error.

### The episodic-challenge pattern

The canonical `observe` use: a capability whose write path is unprotected 99% of the time and occasionally hits a challenge (new IP, VPN, rate-limited account). Saving the strategy without `observe` means every warm call blocks on a human; with a well-chosen `observe`, the hot path stays human-free and the viewer only opens when the challenge is actually present. For the wikipedia-edit case, `observe: { kind: "selector_visible", selector: "iframe[src*=\"hcaptcha.com\"]" }` at `at: "between_steps"` catches the CAPTCHA that appears after the Publish click.

### Interplay with js-eval prereqs

Interrupts and prereqs are complementary:

- A `js-eval` **prereq** mints a token by calling JS the page already has — appropriate when the page's own signer exists and the LLM can call it.
- A `user-assist` **interrupt** mints a token by asking a human — appropriate when the token needs a solve the LLM can't do.

A strategy can have both: a `js-eval` prereq that mints a normal-case token + an interrupt with `observe` + `user-assist` handler that mints the challenge-response token when a challenge fires.

### Registering custom handler / predicate kinds / handoff backends

The vocabulary is a registry, not a hardcoded enum. Deployments can register additional kinds at startup without editing validator or executor source:

- `registerPredicateKind({kind, shape, evaluate, subscribe?})` in `runtime/src/strategies/predicate-registry.ts` — adds a new `observe.kind` the validator accepts and the runtime evaluates. `shape` is a `ShapeFieldSpec[]` (same pattern as prereq shapes); `evaluate` is the edge-triggered evaluator. Optional `subscribe` is the LIFT hook for true in-flight observation (MutationObserver, CDP events).
- `registerInterruptHandler({kind, shape, run})` in `runtime/src/strategies/interrupt-registry.ts` — adds a new `handler.kind` the validator accepts and the runtime dispatches. `run` returns a `{boundTokens?}` result that the executor merges into the tokens table.
- `registerRemoteBackend({name, start, waitForDone, stop})` + `setActiveRemoteBackend(name)` in `runtime/src/remote/backend.ts` — swaps the entire human-handoff mechanism. Strategies never name a backend; it's purely a deployment concern. Select via `~/.klura/config.json` `remote.backend` or programmatically at startup.

All three registries follow the same pattern (see `runtime/docs/principles.md` §"Priming agents" corollary #4): validator rejections, `listXKinds()` enumerations, and runtime dispatch all read from the same registered entry, so adding a kind is a one-row change with no drift.

## page-script schema

For the live field-level schema, see `klura://reference#save-strategy-schema`.

Use when the same HTTP call works in the browser but returns 403/429 from Node (PerimeterX, Cloudflare, Akamai, DataDome) AND the call doesn't need a page-extracted token — if it does, save as `fetch` with `transport: 'browser'` instead. The runtime navigates to `origin`, then runs `fetch()` via `page.evaluate`.

- **`origin`**: the user-facing site (e.g. the main web app URL), not the API host. Falls back to `baseUrl` if omitted.
- **Don't set** `Cookie`, `Host`, `Origin`, `Referer`, `User-Agent` in headers — browser fills these automatically.
- **Can set**: `Authorization`, `x-api-key`, custom `x-*` headers.
- Credentials are automatic (`credentials: 'include'`). Cookies auto-refresh after the call.

### page-script vs fetch with `transport: "browser"`

The execution mechanics overlap — both end up running `fetch()` via `page.evaluate` through the same `fireRequestInSession()` path — but they encode different _discovery outcomes_ and are distinct rungs in `max_strategy_tier` policy ordering. Pick based on _why_ the call needs the page, not on the wire mechanism:

- **`page-script`** — the call only needs the page's **fingerprint-bound context** (cookies tied to TLS/JA3, `sec-ch-*` headers, bot-protection cookies issued by Cloudflare / Akamai / PerimeterX / DataDome). No value is scraped from the DOM. `origin` may be a different host than `baseUrl` (user-facing app → API host).
- **`fetch` with `transport: "browser"`** — the call needs a **value extracted from a page** (CSRF token, persisted-query `doc_id`, signed URL, session nonce) that is either JS-hydrated or otherwise not reachable from Node + cheerio, so the final call also rides from inside the page. `prerequisites` is non-empty; `baseUrl` is the API host; there is no `origin` field.

An `fetch` with `prerequisites: []` + `transport: "browser"` is not a substitute for `page-script`: it misrepresents the reason the strategy is browser-bound, and the shape validator will route it through the fetch path which assumes prereqs exist. If you're tempted to save one, the right tier is `page-script`.

Policy-wise, the two tiers let a user draw a clean line: `set_policy(platform, {max_strategy_tier: "page-script"})` forbids any Node-fired HTTP (blocks fetch and node-transport fetch) while still allowing page-scoped fetch. Collapsing the tiers would lose that lever.

## page-script-anchors

Classify every `page-script` save via `notes.anchor_type` so triage + revisit-prompt know how durable the script is.

| Value | Meaning | Durability |
| --- | --- | --- |
| `"module"` | Calls a module the page itself calls (transport-client singleton, task builder, signer function). Located via `search_js_source` / `require('ModuleName')` / debugger on a captured send. | High — survives UI refactors; breaks on module rename / protocol change. |
| `"protocol"` | Builds a wire-level payload (signed envelope, binary frame, encoded task) and hands it to a durable sender. | Highest — survives UI + module-rename refactors. |
| `"dom"` | Drives the UI from inside `js_eval` (set input → dispatch event → click submit → poll DOM for output) OR walks DOM/fiber (`element.__reactFiber.return.return.stateNode`, text traversals) to extract values. | Variable. UI-replay anchored on stable selectors (e.g. `#prompt-textarea`, `[data-testid="send-button"]`) is a legitimate save when the page's send code path is closure-locked and no module export is reachable. Fiber-walking is fragile and breaks on UI refactors. |
| `"unknown"` | Default when omitted; treated as fragile (equivalent to `"dom"`). |  |

**Examples:** module — `require('SendClient').publish(topic, buildTask({text, thread_id}))`. Protocol — `buildBinaryFrame({thread_id, text, otid: fresh_otid()}); wsConnection.send(bytes)`. DOM (UI-replay) — _expression sets `#prompt-textarea.textContent = '{{text}}'`, dispatches an input event, clicks `[data-testid="send-button"]`, polls `[data-message-author-role="assistant"]` for the response_. DOM (fiber-walk) — `document.querySelector('[contenteditable]').__reactFiber$xyz…`.

**Behavior:** triage `current_tier: "page-script"` returns `already_lifted` iff anchor is `module` or `protocol`; `dom`/`unknown` fall through. Revisit-prompt fires for `dom`/`unknown` on warm execute. Ceiling policy (`max_strategy_tier: "page-script"`) is unchanged — anchor is sub-tier metadata.

**When `dom` is the right answer.** Use `dom` confidently when the structural reason is "the page's send code path is closure-locked and the page's send-module export isn't callable from outside its module" — e.g. the bundle wraps fetch and only adds signing headers when invoked from its own code path, and you couldn't find a callable module export in `search_js_source` / `Object.keys(window)`. Document the reason in `notes.discovery`; the next session reads it from `triage[<cap>].discovery_artifact` and doesn't waste rounds re-investigating module-anchor reachability. UI-replay `dom` anchors are atomic and replay in one `js_eval`, so they're meaningfully faster than recorded-path replay (no per-step driver round-trips).

## recorded-path schema

A recorded-path strategy is a DOM-replay fallback for sites klura can't lift to an API tier. It carries an ordered list of `steps` (navigate, click, type, fill_editor, select, wait, key_press) plus optional `response` extract and optional `prerequisites`. At warm execute, the runtime first runs prerequisites (fetching tokens, invoking sibling capabilities for side-effect-only login flows, etc.), then replays the steps in a browser session and, if `response.format: "html"` is declared, pipes the final page's DOM through cheerio to return structured fields.

For multi-step flows that span an authentication boundary (BankID, OAuth, SSO), split into a side-effect-only `<site>_login` capability and a downstream `<site>_<action>` capability that declares the login as a `kind: "capability"` prereq. See `klura://reference#capability-prereq` for the composition pattern.

For the live field-level schema, see `klura://reference#save-strategy-schema`.

Use `fill_editor` instead of `type` when the target is a contenteditable rich-text editor (Lexical / Slate / ProseMirror / Draft). `type` on a contenteditable racks up zero-height bounding boxes and focus races; `fill_editor` routes through the editor-aware codepath and writes the value reliably. The step shape is identical to `type` (locators + value), only the action name differs.

Without a `response.extract`, a navigate-only recorded-path returns `{ok, url}` on success — useful for mutation flows but useless for data-extraction flows. Always pair navigate-only recorded-paths with `response.extract` when the goal is reading data from the page.

Every step requires a snake*case `id` (regex `/^[a-z]a-z0-9*]{2,39}$/`) that is unique within the strategy. `patch*step({step_id})`looks steps up by this id, and`runtime_meta.discovered_at_step_id`cross-references it. The auto-synth-on-close pipeline auto-generates ids from`{action}*{locator_slug}`(or pathname for`navigate`); hand-crafted `save_strategy` requires the agent to author them. Full rules (reserved words, numeric-only rejection, collision handling) are in the dedicated schema section below.

Always include both CSS and a11y locators. The runtime tries a11y first, falls back to CSS.

### Targeting popups / sub-pages

A step can pin to a tracked sub-page via `page: "popup-N"`. Default (omitted) is `"main"` — the page the session opened with. Use this for OAuth consent flows, Drive pickers, Stripe Checkout in popup mode, calendar detail tabs.

```json
{
  "id": "click_allow_in_oauth",
  "action": "click",
  "page": "popup-1",
  "locators": {
    "a11y": { "role": "button", "name": "Allow" },
    "css": "button[data-id='allow']"
  }
}
```

At replay, the runtime waits briefly for `popup-N` to appear in `session.subPages` (handles the race where the prior step triggered `window.open()` but the listener hasn't fired yet) before running the action. If the popup never opens or already closed, the runtime raises a `recorded_step_failed` checkpoint that names the offending handle and the currently-open list.

Save-time: the audit emits `popup_addressing_without_trigger` when a strategy references popup handles the discovery session never observed — almost always means the saved flow is missing the click that opens the popup. See `klura://reference#popups`.

### Post-navigation extract

Pair a recorded-path with `response: {format: "html", extract: {...}}` to pull structured fields out of the final page DOM after the step loop completes. The runtime calls `driver.getPageHtml(session)` to read the serialized page, then runs the cheerio selector helper.

```json
{
  "strategy": "recorded-path",
  "steps": [
    {
      "id": "navigate_flight_search",
      "action": "navigate",
      "url": "https://www.example.com/flight-search/{{origin}}-{{destination}}/{{date}}/1adults/economy?sort=price_a"
    }
  ],
  "response": {
    "format": "html",
    "extract": {
      "cheapest_price": { "selector": "[data-testid='price-cheapest']" },
      "airlines": { "selector": ".result-card .airline-name", "multiple": true },
      "durations": { "selector": ".result-card .duration", "multiple": true }
    }
  }
}
```

Warm execute for a strategy with `response.extract` returns:

```json
{
  "status": 200,
  "body": {
    "ok": true,
    "url": "https://...",
    "extracted": {"cheapest_price": "€240", "airlines": ["TAP", "Ryanair", "SAS"], "durations": ["3h 20m", "3h 45m", "4h 10m"]},
    "networkLog": {...}
  }
}
```

Without `response.extract`, warm execute returns just `{ok, url, networkLog}` and the agent has to open a new session to read the page — expensive and defeats the "second run is free" promise. Always declare extract when the agent's natural-language goal is "tell me X from this page".

Format is `"html"` only for recorded-path (the page DOM is always HTML). JSON extracts belong on fetch strategies where the HTTP response is already JSON.

### Step shape + id rules

Every recorded-path step carries a stable slug `id` plus the usual `action` / `locators` fields. Ids are the handle `patch_step` uses and the target `runtime_meta.discovered_at_step_id` references — both survive step reordering, which a positional index doesn't. For the live field-level schema, see `klura://reference#save-strategy-schema`.

### Step id rules (enforced at save)

- Regex `/^[a-z][a-z0-9_]{2,39}$/` — snake_case, starts with a letter, 3-40 chars.
- Must not be a reserved word (`id`, `init`, `end`, `start`, `finish`, `step`).
- Must not be purely numeric.
- Must be unique within the strategy. Collisions reject with a suggestion to append `_2` / `_3` or use a more specific name.
- On hand-crafted `save_strategy` saves the id is **required** — the agent authors it consciously.
- On the auto-synth-on-`end_drive` path the runtime generates ids deterministically from the step's action + locator name or URL pathname (`navigate_inbox`, `click_compose`, `type_recipient`, `click_send`). Collisions append `_2`, `_3`, …; empty slugs fall back to `{action}_{index}`.

### Locator rules (enforced at save)

- Must declare **at least one** of `locators.a11y` or `locators.css`. Declaring both is strongly preferred.
- `locators.a11y` must be `{role, name?}` with a non-empty `role` string.
- Each entry in `locators.alternatives` must itself declare at least one of `{a11y, css}`.
- The css must identify ONE element. Bare element-name fragments (`button`, `input`, `div`, `span`, `a`, `li`, `tr`, `td`, `form`, `label`, `h1`-`h6`, `nav`, `main`, `article`, `section`, `aside`, `header`, `footer`, `ul`, `ol`, `p`, `img`, `option`, `textarea`, `select`), the universal selector (`*`), and attribute-only selectors without an element qualifier (`[type="submit"]`) are rejected — they match every tag on the page and warm execute will click the wrong one when the UI grows. Comma-list fallbacks (`button[type="submit"], button`) are the usual culprit: the tail fragment is what's bare. Exception: if `locators.a11y` has a non-empty `name`, the a11y name anchors the element uniquely and the css may be broad.

Runtime behavior at execute: tries primary `a11y` → primary `css` → `alternatives[0]` → `alternatives[1]` → … in order, returning on the first selector that resolves. `patch_step` (keyed by step `id`) lets the LLM append new alternatives at heal time.

### `runtime_meta.discovered_at_step_id` — revisit-fallback anchor

When the capture-pipeline saves a `fetch` / `page-script` strategy it also stamps `runtime_meta.discovered_at_step_id`: the slug id of the recorded-path step that was live when the marker XHR fired during discovery. `execute()` uses this as a three-tier fallback ladder:

1. Primary strategy (fetch / page-script) → miss
2. Partial recorded-path replay up to (and including) the anchor step, then retry the primary → miss
3. Full recorded-path replay (no retry — recorded-path IS the fallback tier) → miss
4. `needs_rediscovery` (as today)

The partial replay is the new node in the ladder. It's a best-effort fix-up to restore session state (cookies, in-page tokens, navigation context) that a cold warm session lacks; when it sticks, the primary retry is ~100ms instead of ~5s of full replay. Partial replay skips entirely when the anchor id is absent, the sibling recorded-path is missing, or the anchor id no longer matches any step in the recorded-path (renamed / deleted via `patch_step`). Logging for each tier transition lands in `execute()`'s `errors[]` so field-reports can read the cascade trail.

### Sharable-skill robustness: locale variants

For dismiss-class buttons (cookie consent, newsletter popup, notification prompt, tutorial close), capture 2–3 locale-plausible label variants in `alternatives`:

- Cookie accept: `"Accept"`, `"Accept all"`, `"OK"`, `"Agree"`, `"I agree"`, `"Got it"`.
- Cookie decline: `"Decline"`, `"Reject"`, `"Reject all"`, `"No, thanks"`.
- Dismiss prompt: `"Dismiss"`, `"Close"`, `"Skip"`, `"Not now"`, `"Maybe later"`.
- Notification deny: `"Block"`, `"Don't allow"`, `"No"`, `"Later"`.

### Optional steps — "click if visible, else skip"

Cookie banners / tutorial dismisses / one-time modals are maybe-visible. Hard-requiring them breaks warm replay when the banner is gone. Mark `optional: true` on clicks that are state-dependent:

```json
{ "action": "click", "optional": true, "locators": { ... } }
```

Runtime probes each candidate with a 1000ms timeout; if no locator resolves within the combined budget, the step is skipped silently. Don't use `optional` on critical-path steps (the one that sends the message / places the order). `navigate` and `wait` steps ignore the field.

**Optionality is LLM-authored, not runtime-inferred.** Auto-synth on `end_drive` emits every captured step as required — if you traversed a dismiss overlay during discovery, save your own recorded-path explicitly with those clicks flagged.

### Wait step variants

```json
{"action": "wait", "condition": "navigation", "timeout": 8000}
{"action": "wait", "condition": "selector", "waitSelector": ".autocomplete-list", "timeout": 3000}
{"action": "wait", "timeout": 500}
```

Use `condition: "selector"` when the next click targets a dynamically rendered element (autocomplete). Use `condition: "navigation"` after a click that triggers a page load.

### Page fingerprint (internal runtime drift detection)

Every mutating recorded-path step (click / type / fill_editor / select) synthesized from `perform_action` history carries a runtime-stamped `step._fingerprint` — a ~200-byte structural skeleton of the page at the moment the action fired:

```json
{
  "url_path": "/settings/profile",
  "primary_heading": "Profile settings",
  "landmark_roles": ["form", "main", "nav"],
  "has_dialog": false,
  "form_signature": { "inputs": ["name", "email"], "buttons": ["Save", "Cancel"] },
  "visible_primary_buttons": ["Save", "Cancel", "Delete account"]
}
```

Runtime-captured, runtime-compared — the LLM never authors `_fingerprint`. Before each mutating step fires at warm-execute time, the runtime re-captures the live fingerprint and diffs against the saved one:

- **Hard drift** (abort before click) — `url_path` mismatch, a `dialog` / `alertdialog` materialized, the target form is gone, or the step's target label is no longer present in visible buttons / form controls. The step loop throws and routes a `recorded_step_failed` checkpoint with `context.reason: "page_drifted_before_step"` + `context.diff` naming what changed. Typical cause: a nag overlay, an interstitial ("Accept updated Terms"), or a whole intermediate page inserted between discovery and warm run.
- **Soft drift** (advisory, continue) — primary heading renamed, landmark ordering shifted, or new buttons appeared alongside all original ones. Surfaces as `_drift_advisory` on the success response.
- **None** — every field matches; step proceeds silently.

On hard drift heal via `patch_step` (tighten the locator, add a dismiss-prelude optional step, adjust the target) rather than full re-discovery — a single-step fix from fingerprint diff is the common case. Localization / copy-only changes stay non-blocking by design: heading text is soft, not hard.

A11y-tree parse failures yield an empty fingerprint — the check degrades to a no-op rather than aborting a warm run on a parser hiccup.

## popups

OAuth consent windows, Google-Drive pickers, Stripe Checkout in popup mode, calendar detail tabs — when a click triggers `window.open()` or follows an `<a target="_blank">` link, the new tab is tracked as a sub-page of the session. The agent addresses sub-pages by stable handle through the `page` opt on `perform_action`.

### Handles

- The page the session opened with is `"main"`.
- Each new sub-page gets the next monotonic id: `"popup-1"`, `"popup-2"`, `"popup-3"`, ...
- Ids never reuse. A popup that opened, was assigned `popup-1`, and closed leaves its `subPages` entry behind with `closedAt` set; the next popup is `popup-2`. This keeps recorded-path step pinning unambiguous — `popup-1` always means the first popup of the run.

### Discovering sub-pages

Every `perform_action` response carries the current sub-page list when at least one has been observed:

```json
{
  "url": "https://example.com/post/new",
  "a11yTree": "...",
  "subPages": [
    {
      "id": "popup-1",
      "url": "https://accounts.google.com/o/oauth2/v2/auth?...",
      "title": "Sign in - Google Accounts",
      "openerId": "main",
      "openedAt": 1714060123412
    }
  ]
}
```

The field is omitted when no sub-page has ever been observed, so the typical (no-popup) response shape is unchanged.

### Acting on a sub-page

```json
perform_action({
  "session_id": "sess_…",
  "action": "click",
  "selector": "button \"Allow\"",
  "page": "popup-1"
})
```

The action runs against the popup's DOM. The same `page` opt works for `click`, `type`, `fill_editor`, `select`, `key_press`, `mouse_click`, `mouse_drag`, and `scroll`. Inspection tools (`get_a11y_tree`, `get_screenshot`, `find_in_page`, `get_attribute`) read from the same handle.

`navigate` always targets `main` — popups change URL by clicking links or submitting forms inside themselves, not by being driven through a top-level navigation tool.

### Lifecycle

| Event | Effect |
| --- | --- |
| popup opens (`context.on('page')` fires) | new entry pushed onto `session.subPages` with id `popup-N`, url/title best-effort observed |
| popup navigates inside itself | entry's `url` updates; `title` refreshes |
| popup closes (`page.on('close')` fires) | entry stays in `subPages` with `closedAt` set; raw page reference released |

A `perform_action` against a closed handle rejects with `invalid_action: page handle "popup-N" is closed`. Pick another open page (or `main`).

### Errors

- **Unknown handle** — passing a `page` value that isn't `"main"` or an entry in `subPages`: `invalid_action: unknown page handle "popup-99". Allowed: "main" or one of [popup-1, popup-2]`.
- **Closed handle** — addressing a popup that already closed: `invalid_action: page handle "popup-1" is closed`. The entry is kept so handle ids stay stable, but cannot be acted on.

### Driver support

`playwright` driver: full sub-page tracking and routing. Custom drivers without a popup-tracking surface inherit the no-op default and can address only `main`.

## identities

Multi-account scoping for one platform — the agent invokes `start_session(url, {platform, identity})` or `execute(platform, capability, args, {identity})` to address a specific account on the platform. Two distinct accounts → two cookie jars, two profile slots, two warm-pool slots, no cookie-bleed across accounts.

The feature is **opt-in**. Single-account use sees zero change: omitting `identity` (or passing `"default"`) routes through the historical platform-only paths.

### Handles

- `"default"` — the sentinel for "no specific account." Resolves to the historical `<platform>.json` cookie jar and the bare `identities[platform]` profile slot. Omitting the field is equivalent to passing `"default"`.
- Named identities (`"work"`, `"personal"`, `"family"`, ...) — opt-in account labels. Slug shape: snake_case, lowercase letters/digits/underscores, 3–40 chars (`asIdentifierSlug`). Reserved: the literal string `"default"` is rejected at the API edge — omit the field instead.

### Three resolution layers

| Layer | Default identity | Named identity |
| --- | --- | --- |
| **Cookies / storage state** | `~/.klura/storage-state/<platform>.json` | `~/.klura/storage-state/<platform>--<identity>.json` |
| **Identity profile** (used by `credential-autofill` plugin + `{{identity.field}}` interpolation in saved strategy bodies) | `identities[platform]` | `identities[<platform>--<identity>]`; falls back to `identities[platform]` with a one-shot stderr warning if the scoped slot is empty |
| **Pool warm-slot key** | `"<platform>::default"` | `"<platform>::<identity>"` — same-platform-different-identity calls cold-spawn instead of sharing the wrong cookies |

### Secrets / passwords (convention only — no code change)

`get_secret(scheme, ref)` is convention-driven. To use per-identity passwords, configure your password resolver (1Password CLI, keychain, `pass`, etc.) to handle refs of the form `<scheme>.<identity>` — e.g. `<platform>.work` and `<platform>.personal`. No runtime change is needed; the agent constructs the ref string when calling `get_secret`.

### Examples

```text
// Open two accounts in one conversation:
start_session("https://www.example.com", {platform: "<platform>", identity: "work"})
// → loads ~/.klura/storage-state/<platform>--work.json
// → credential-autofill reads identities["<platform>--work"]

start_session("https://www.example.com", {platform: "<platform>", identity: "personal"})
// → loads ~/.klura/storage-state/<platform>--personal.json
// → independent warm-pool slot — no cookie bleed from the work session

// Run a saved strategy under a specific account:
execute("<platform>", "send_message", {to: "boss", text: "hi"}, {identity: "work"})
execute("<platform>", "send_message", {to: "brother", text: "yo"}, {identity: "personal"})
```

### First-time login on a named identity

When a named identity has no jar yet, the session opens unauthenticated. Drive a login (manually via the remote viewer, or programmatically if the saved strategy supports it). On `end_drive`, the cookies persist to `<platform>--<identity>.json`. The next `start_session` with the same identity opens already-logged-in.

### Profile fields under named identities

`identities.json` is hand-edited or written via the existing `setIdentity(platform, key, value)` API (which updates the platform-default slot). To populate a named identity's profile, edit `~/.klura/identities.json` directly:

```json
{
  "<platform>": { "name": "Default Name", "email": "user@example.com" },
  "<platform>--work": { "name": "Work Name", "email": "user@workdomain.com" },
  "<platform>--personal": { "name": "Personal Name", "email": "user@personal.example" }
}
```

When a named identity has no scoped slot, `getIdentity(platform, identity)` falls back to the platform-default profile and emits a one-shot stderr warning naming the missing slot. The credential-autofill plugin and `{{identity.email}}`-style strategy interpolation both honor the fallback so no flow hard-fails on a missing profile.

### Out of scope (deferred)

- **CLI subcommands** for managing identity jars (`klura identity list <platform>`, `klura identity rm <platform> <identity>`). Edit JSON files directly for now.
- **`setIdentity` API extension to scoped slots.** The write path stays platform-only in v1.
- **Listener identity scoping.** `runtime/src/listeners/index.ts` opens listeners per platform without an identity axis. Multi-account listening requires running multiple listener registrations for now.
- **Save-time probe identity scoping.** `runtime/src/strategies/probe/index.ts` runs internal probes against the platform-default jar — strategies are platform-shape, not account-shape, so probes don't grow the axis.
- **Migration tool.** No `<platform>.json` → `<platform>--default.json` rename. The default-identity sentinel reads the unsuffixed file forever.

## capability-cache

Opt-in return-value caching for stable lookups. The agent calls a capability (`search_contact`, `whoami`, `list_channels`) repeatedly with the same args; the second and later calls within the TTL return the memoized result without hitting the wire. Lives entirely on the read path — writes (`send_message`, `place_order`) never declare the hint and never cache.

### Hint shape

Top-level field on the strategy body:

```json
{
  "strategy": "fetch",
  "endpoint": "/api/search?q={{name}}",
  "method": "GET",
  "cache": { "ttl": "5m" },
  "notes": { "params": { "name": { "kind": "text", "example": "Bob" } } }
}
```

The hint sits at strategy-body level, not on the capability metadata, so each saved tier (fetch + page-script + recorded-path) is self-describing. When a capability has multiple saved tiers and at least one declares a TTL, that TTL applies — duplicate the hint on each tier rather than relying on first-tier-wins lookup.

### TTL grammar

`^\d+(s|m|h)$`. Examples: `"30s"`, `"5m"`, `"90m"`, `"1h"`. No `"ms"`, no `"d"`, no `"w"`, no bare numbers, no decimals. Rejected at save time with a descriptive error.

> 1 hour is almost always wrong: cookies rotate, server-side data drifts, the agent should re-execute on a fresh round.

### Cache key

`(platform, identity, capability, stable-hash(args))`.

- **Identity** is part of the key so alice's `thread_id` for "Bob" doesn't bleed into bob's session. Default-when-omitted resolves to the literal `"default"`, distinct from any named identity.
- **Args** are canonicalized via JSON.stringify with sorted keys before hashing — `{a: 1, b: 2}` and `{b: 2, a: 1}` collapse to the same key.
- **No collision protection across capabilities.** `search_contact({name: "Bob"})` and `find_user({name: "Bob"})` get separate keys because `capability` is part of the key.

### What gets cached

- HTTP-style status 2xx
- `body.error` undefined
- `body.needs_generation` undefined
- No `body.blocker` / `body.healable` flag

Anything else is something the agent must act on next round (regenerate, heal, escalate) — caching it would mask the next call's chance to succeed. Errors run fresh forever.

### Cache hit signal

A served-from-cache response carries:

- `_cache_hit: true` at the top level
- `_cache_age_ms: <ms-since-stored>` at the top level
- The same flags folded onto `body` when `body` is an object (so callers that read `result.body._cache_hit` work too)

Fresh execute calls don't add the field at all; absence = miss.

### Storage and lifetime

- In-memory per daemon. No disk persistence in v1 — daemon restart starts the cache empty.
- Periodic sweeper evicts expired entries every 60s. Reads also evict on hit-after-expiry.
- The two read sites — `runtime/src/tools/execute.ts` (direct `execute` calls) and `runtime/src/execution/index.ts:resolveCapabilityPrereq` (capability prereqs like `send_message`'s dependency on `search_contact`) — share one singleton, so a memoized direct lookup is also seen by a later call that uses the capability as a prereq.

### When to set this

Set `cache: {ttl: ...}` on a saved strategy iff **all** of the following:

1. The capability is a read — pure lookup, no side effects on the platform.
2. The result is stable for the user's session — name → id, account info, list of channels.
3. The lookup is genuinely repeated. A capability called once per session doesn't benefit; the cache only wins for prereq chains (`send_message` → `search_contact`) and bulk operations.

DO NOT set it on:

- Writes (`send_message`, `place_order`, `delete_post`).
- Lookups whose results time-shift (`get_unread_count`, `list_recent_messages`).
- Capabilities that drive auth state (`login`, `whoami` may be borderline — it's stable per session, but the value of caching is small unless something repeatedly calls it).

### Errors at save time

- `cache.ttl` missing: `invalid_strategy: cache requires "ttl" — like {"ttl": "5m"}`.
- `cache.ttl` malformed: `invalid_strategy: cache.ttl = "<value>" must be like "30s", "5m", "1h"`.
- `cache.<unknown>` field: `invalid_strategy: cache.<key> is not a valid field — allowed keys: "ttl"`.
- `cache` non-object: `invalid_strategy: cache must be a plain object like {"ttl": "5m"}`.

### Out of scope (deferred)

- **Disk persistence.** Daemon restart resets the cache.
- **Manual invalidation tool.** No `clear_capability_cache` MCP tool. If staleness is suspected, restart the daemon or wait for TTL.
- **Write-through bust.** A successful `send_message` doesn't bust `search_contact`'s cache for that recipient.
- **Negative caching.** Errors don't cache. A flapping endpoint won't poison the cache with stale failures.
- **Stale-while-revalidate.** No background refresh of expired entries.
- **HTTP `Cache-Control` / `ETag` integration.** Cache-Control would only apply to fetch-tier responses (page-script and recorded-path have no headers); ETag requires a revalidation round-trip which defeats the goal of skipping the call. Capability-author-declared TTL is the right primitive.

## Listener schema — real-time events

Four transports, in rough preference order:

1. `websocket` — daemon-side `ws` connection. Use when the WS URL + auth are reachable from outside the browser (bearer token, query-param userId, etc).
2. `fetch-stream` — daemon-side `fetch()` with chunked-encoding response, parsed as SSE or NDJSON. Covers the modern streaming-completion shape (POST + JSON body + streaming token-delta response) and long-lived event-source endpoints (GET + SSE response). Pick this for any upstream that emits a chunked text response over plain HTTP rather than a WebSocket.
3. `poll` — daemon-side periodic `fetch()`. Last resort for sites with no push channel.
4. `browser-event` — keep a Playwright page open on a logged-in feed/chat URL and stream every WebSocket frame the page receives. Use when the push channel is bound to browser context (cookies, sec-\* headers, JS-set origin, fingerprint-bound endpoints) — order-tracking pages, messenger/chat dashboards, notification feeds, anything where the WS URL is opened by page JS and isn't reachable from a Node-side client.

Examples:

```json
// websocket: daemon-side, bearer-style auth in a query param
{
  "strategy": "fetch",
  "type": "listener",
  "transport": "websocket",
  "endpoint": "ws://example.com",
  "auth": { "type": "query-param", "param": "userId", "value": "{{userId}}" },
  "events": { "match": { "type": "new_message" }, "delivers": ["sender", "text", "timestamp"] }
}
```

```json
// fetch-stream: POST + SSE response — the streaming-completion shape.
// Defaults are method=POST + parse=sse, so for this case both are
// optional. Body placeholders interpolated against listener args.
{
  "strategy": "fetch",
  "type": "listener",
  "transport": "fetch-stream",
  "endpoint": "https://api.example.com/v1/conversation",
  "method": "POST",
  "parse": "sse",
  "body": {
    "messages": [{ "role": "user", "content": "{{prompt}}" }],
    "model": "{{model}}"
  },
  "headers": { "Authorization": "Bearer {{access_token}}" },
  "events": { "match": { "delta": {} } }
}
```

```json
// fetch-stream: GET + NDJSON feed — newline-delimited JSON per line.
{
  "strategy": "fetch",
  "type": "listener",
  "transport": "fetch-stream",
  "endpoint": "https://api.example.com/feed",
  "method": "GET",
  "parse": "ndjson",
  "events": { "match": { "type": "update" } }
}
```

```json
// browser-event: cookie-bound push channel. The browser navigates to
// pageUrl with stored cookies, the page JS opens its own WebSocket, and
// every received frame is forwarded into the listener event queue.
{
  "strategy": "recorded-path",
  "type": "listener",
  "steps": [],
  "transport": "browser-event",
  "pageUrl": "https://example.com/orders/{{order_id}}/track",
  "endpoint": "",
  "events": {
    "match": { "type": "status_change" },
    "delivers": ["status", "etaSeconds", "label"]
  },
  "reconnect": { "initialDelay": 1000, "maxRetries": 10, "maxDelay": 30000 }
}
```

For `browser-event`: the `endpoint` field is unused but the schema requires it (pass `""`). The tier marker (`strategy`) is also irrelevant for listeners — pick `recorded-path` since it has the loosest validation. The runtime routes by `type: "listener"` and dispatches by `transport`.

### `fetch-stream` config

| Field | Default | Notes |
| --- | --- | --- |
| `method` | `"POST"` | Matches the streaming-completion shape (request body carries the query). Pass `"GET"` for long-lived event-source endpoints. |
| `parse` | `"sse"` | `"sse"` handles `data: <line>\n\n` events plus the `data: [DONE]` end-of-stream sentinel (delivered as a synthetic `{_done: true}` event). `"ndjson"` handles `<json>\n` per line. |
| `body` | — | `{{template}}` placeholders interpolated against args. Serialized as JSON unless `contentType: "form"`. Ignored on `GET`. |
| `contentType` | `"json"` | `"json"` → `application/json`. `"form"` → `application/x-www-form-urlencoded`. |
| `headers` | — | Caller headers override the auto-injected `Accept` / `Content-Type` so site-specific auth (`Authorization`, custom client-version headers) composes cleanly. |

Auth headers and `Cookie`s travel via `auth.header` / `auth.value` (interpolated against args) and the platform's saved storage state respectively — same shape as the websocket and poll transports.

Reconnect is via the shared exponential-backoff machinery; on `[DONE]` (SSE) or stream end (NDJSON) the listener reconnects unless explicitly stopped.

`poll` uses `transport: "poll"` with `pollInterval` (ms). All transports share the `events.match` filter and `reconnect` config (exponential backoff with jitter; for `browser-event`, the browser session is fully torn down and recreated on each reconnect attempt, with cookies reloaded from saved storage state).

After saving, use `start_listener` > `get_events` > `stop_listener`.

## Execute errors — classification and recovery

`execute` attaches diagnostic context to every post-cascade failure. Before re-running discovery, read the error body and pick the cheapest recovery.

Three error shapes:

| Body field(s) | What it means | What to do |
| --- | --- | --- |
| `needs_reauth: true`, `error: "auth_failed"` | Cookies stale; the strategy itself is fine | Reauth via the flow in `runtime/docs/credentials.md`. **Never re-discover on this signal.** |
| `needs_rediscovery: true`, `error: "endpoint_stale"` | The last-failing tier returned 404/410/405 or a shape-mismatch 400 | **First cross-check `params_used` (what you passed) against `params_doc` (what the strategy documents).** If the mismatch is obvious — wrong case, display name instead of id, wrong format — retry `execute` with corrected args. Only re-discover if the corrected retry also fails or the mismatch isn't clear. |
| `needs_rediscovery: true`, `error: "all_strategies_failed"` | Mixed failures the runtime couldn't classify | Go straight to full re-discovery; diagnostic context wasn't enough. |

**Example — correcting a shape mismatch before re-discovering:**

```
execute('chat-app', 'send_message', {to: 'Bob', text: 'hi'})
→ {
    error: 'endpoint_stale',
    needs_rediscovery: true,
    params_used: {to: 'Bob'},
    params_doc: {to: {kind: 'id', example: 'bob'}}
  }
```

The doc says `kind: 'id'` with example `'bob'` — you passed `'Bob'`. Retry with `{to: 'bob', text: 'hi'}` before touching discovery. `params_doc` is exactly what you wrote in `notes.params` at save time — lowercase `kind` + concrete `example` is the difference between an agent that can self-recover and one that burns another full discovery run.

## rediscover-gate

`execute` raises a `rediscover_required` error before firing when a saved strategy's rolling success rate has fallen below `pool.rediscoverThreshold` (default 0.7). Anti-bot vendors push updates monthly; saved strategies silently rot. The gate forces a user-acked decision instead of letting a degraded strategy keep firing.

**When the gate fires.** The runtime keeps a 20-call rolling window of execution outcomes per saved strategy (success / failure). When the worst tier's rate drops below threshold AND the capability has accumulated at least 5 outcomes AND the user hasn't silenced this capability AND no ack has been recorded this daemon lifetime, the next `execute` call rejects with `rediscover_required` instead of running.

The rejection includes:

- `rediscover_token` — bound to `(platform, capability)`. Hash-locked so further failures don't invalidate it.
- `health` block — worst rate, threshold, per-tier rate + samples + last error.
- `required_fields` — what the agent must echo back.
- `alternative` — the rediscover path (a separate `start_session` call, no token).

**Three responses.**

| Action | What happens | How to respond |
| --- | --- | --- |
| **rediscover** | Re-derive the strategy from scratch. | Call `start_session({platform, capability, revisit: true})`. The gate is bypassed for that session. No token needed. |
| **proceed** | Run the saved strategy as-is. Acked for the rest of this daemon lifetime. | Re-call `execute(...)` with `rediscover_token`, `rediscover_action: "proceed"`, `user_acknowledgement_quote: "<user's words>"`. |
| **silence** | Same as proceed, AND stop asking for this capability permanently (persists to `~/.klura/workdir/<platform>/health.json`). | Re-call `execute(...)` with `rediscover_token`, `rediscover_action: "silence"`, `user_acknowledgement_quote`. |

**`user_acknowledgement_quote`** is mandatory for both proceed and silence — paste the user's own words choosing the path. Same tamper-evident-paper-trail rationale as `trigger_reference_send` consent.

**Inspecting health proactively.** Call `get_strategy_health({platform?})` to list every saved strategy's status, success rate, samples, and `rediscover_gate_armed` (true when the next execute would raise the gate). Useful when the user asks "how are my saved skills holding up?" before the gate fires mid-flow.

**Tuning the threshold.** `configure({path: "pool.rediscoverThreshold", value: 0.5})` lowers the trigger; `0` disables the gate entirely. The threshold compares against the rolling rate, not consecutive failures — a strategy that flaps 4-fail-1-pass-4-fail forever stays "healthy" by `failureCount` (resets on success) but its rolling rate exposes the rot.

**Distinct from the broken-cascade.** A strategy with 5 consecutive failures is archived (`status: "broken"`, file renamed `.broken.json`) and the cascade silently skips it — no gate, no prompt. The rediscover gate sits in front of strategies that are still considered healthy by consecutive-count semantics but are degrading by rate.

## Step healing response format

When a recorded-path step fails, the runtime routes a `recorded_step_failed` checkpoint through the registry and returns:

```json
{
  "status": 0,
  "body": {
    "failed_step_index": 2,
    "failed_step_id": "click_send",
    "failed_step": {
      "id": "click_send",
      "action": "click",
      "locators": { "css": "#old-button", "a11y": { "role": "button", "name": "Send" } }
    },
    "remaining_steps": 3,
    "a11yTree": "...trimmed to ~8 KB with a marker line if clipped...",
    "a11y_total_chars": 47213,
    "a11y_truncated": true,
    "screenshot": "...base64 JPEG...",
    "platform": "chat-app",
    "capability": "send_message",
    "session_id": "abc123",
    "url": "https://app.example.com/chat",
    "remoteUrl": "https://<tunnel>/viewer/abc",
    "_checkpoint": {
      "kind": "recorded_step_failed",
      "context": { "kind": "recorded_step_failed", "failed_step_index": 2, "healable": true },
      "prompt": "A recorded-path step failed mid-execute. The remote viewer is open …",
      "viewer_url": "https://<tunnel>/viewer/abc",
      "checkpoint_token": "ck_…"
    }
  }
}
```

Direct dispatch: the runtime invoked the default `default-handover-viewer-checkpoint` handler, which opened the viewer inline and populated `viewer_url`. Ack with `ack_checkpoint({session_id, checkpoint_token, viewer_result: {...}})` once the user has solved the interaction. When a scenario plugin claims `recorded_step_failed` and returns `{status:'continue'}`, no envelope surfaces and the agent proceeds directly.

**Healing flow**:

1. Read the `a11yTree` + `screenshot` + `failed_step.locators` to find the new selector. Most single-step drifts heal from this alone.
2. If `a11y_truncated: true` **and** the failing element isn't visible in the trimmed tree, call `get_a11y_tree(session_id)` for the full paginated view.
3. `patch_step(platform, capability, strategy_type, step_id, {locators: {...}})` — fix just that step, leaving the rest of the strategy untouched. `step_id` is the slug `id` on the recorded-path step (also returned on the failure envelope as `failed_step_id`). 404 response names the known ids in the strategy so you can self-correct without opening the JSON.
4. `resume_execution(session_id)` — continue from the patched step, reusing the same browser session
5. On success, the strategy's health resets to healthy automatically

Only fall back to full re-discovery if multiple steps are broken or the page structure has changed fundamentally. One-step selector drift is almost always a patch, not a re-discovery.

### Size-budget fields

`start_session`, `perform_action`, and healable `execute` bodies include an a11y tree trimmed to a fixed character budget so the tool result fits under the agent-runtime output cap:

| Field | Meaning |
| --- | --- |
| `a11yTree` | The trimmed (or full) tree text. If trimmed, ends with `... [a11y tree truncated: N of M chars omitted; call get_a11y_tree(session_id) for the full tree]` |
| `a11y_total_chars` | Length of the full untrimmed tree — tells you how much was clipped |
| `a11y_truncated` | `true` if `a11yTree` was clipped to fit the budget |

When truncated, fetch more via `get_a11y_tree(session_id, {page, page_size})` which returns `{tree, total_chars, page, page_size, total_pages, has_more}`. A single page is capped at the tool-output budget (20 KB), so paginate if the whole tree is larger.

`get_attribute` follows the same pattern for oversized values: `{value, truncated?, total_chars?}` — if `truncated: true`, the returned `value` is the first ~10 KB of the real attribute.

## Capability parameters

A saved capability is a contract with every future caller. Test: would a different user with a different target get the right result? If no, the strategy is over-specialized.

### The name-vs-id split

Users type human-facing names; APIs take internal ids. A well-shaped capability takes the name as its user-arg and resolves to the id inside the strategy via a prereq:

```
user_arg:   recipient    = "Pelle Jönsson"      ← what the user knows
prereq:     thread_id    = search(recipient)    ← what the API needs
endpoint:   /send_message  body: {thread_id, message}
```

Resolve this way for people, communities, merchants, locations, tags, playlists, files.

### Naming the capability — don't bake values into the slug

The slug names what the capability does in the abstract: verb + noun, maybe a qualifier. It must NOT contain a string that's also one of the capability's own parameter values (or label tokens you saw on the page).

❌ `find_top_italian_restaurants` — `italian` is one observed value of the `category` enum param. Implies a parallel slug per value (`find_top_mexican_restaurants`, `find_top_sushi_restaurants`, …). ❌ `find_top_napoli_restaurants` — `napoli` only appears in the page label "Taste the pride of Napoli", not in any observation that goes over the wire. Naming the capability after prose you read, not the structure you observed. ✅ `find_top_restaurants` — `category` is a parameter; values live under `notes.params.category.observed_values` (or `source: "capability:list_categories"` if the values come from a listing endpoint you also saved as a sibling capability).

The wrong shape silently bakes a value into the capability identity, so when a future caller asks for a different value the agent fabricates a parallel capability slug instead of re-using the one that's already saved with the right param shape. Runtime catches this at save via `enum_value_baked_into_slug` (no ack-bypass — fix the slug or remove the param from `notes.params`).

When the values come from a listing endpoint (e.g. `/api/categories` returning the available choices), save that endpoint as its own `list_<entity>` capability and point the param at it via `source: "capability:list_<entity>"`. The values are then live (refreshed on every warm execute) instead of frozen at discovery time.

### Red flags

- `recorded-path` step with a numeric/opaque id embedded in a navigate URL.
- `fetch` body with a literal id field instead of a `{{placeholder}}` fed by a prereq.
- `notes.params.<x>.example` that's an opaque id — users can't paste those.
- Capability that "just happens to work" because of a sidebar / pinned / cached shortcut. Fresh sessions break.

### The search/lookup prereq pattern

**`fetch-extract`** — when the site exposes a same-origin search endpoint:

```json
{
  "prerequisites": [
    {
      "name": "thread_id",
      "kind": "fetch-extract",
      "url": "/api/search?q={{recipient}}&type=user",
      "extract": { "path": "results[0].thread_id" }
    }
  ],
  "body": { "thread_id": "{{thread_id}}", "text": "{{message}}" }
}
```

**`page-extract`** — when the resolution happens in the DOM: open the search UI, type the recipient, read the id off the result whose visible name _exactly matches_ what the user typed. Never hand back `:first-child` — autocomplete orders are fuzzy and picking the first row means your "send to {{recipient}}" strategy will silently send to whichever row the server happened to sort to the top.

```json
{
  "prerequisites": [
    {
      "name": "thread_id",
      "kind": "page-extract",
      "steps": [
        { "action": "click", "locators": { "a11y": { "role": "button", "name": "New chat" } } },
        {
          "action": "type",
          "locators": { "a11y": { "role": "searchbox" } },
          "value": "{{recipient}}"
        },
        {
          "action": "wait",
          "condition": "selector",
          "waitSelector": "[role='listbox'] [role='option']"
        },
        {
          "action": "extract",
          "match": { "role": "option", "name": "{{recipient}}" },
          "attribute": "data-thread-id"
        }
      ]
    }
  ]
}
```

The `match` form picks the option whose accessible name equals the user's arg. No exact match → `prereq_failed: no result matching "<arg>"`. Silent wrong-target is worse than a clean error.

### Search is a disambiguation step, not a typing step

"Type into the search box and click the first result" is autocomplete roulette. A real search-and-resolve has three stages: (1) enter the query, (2) wait for results on a listbox/results container, (3) pick by exact match — `name === query`, never `:first-child`. For recorded-path, use the `match: {role, name}` locator; for fetch-extract, filter the response array by `name === query` before extracting.

When the user's arg is ambiguous (two contacts named "Pelle"), fail loudly and ask for a more qualified name. Document which forms the strategy accepts in `notes.params.<x>.description`.

### What stays a literal

Hardcode when the value is the same for every caller: site-wide paths/hostnames, fixed-set enums (document others in `notes.params.<x>.enum`), public client ids (`client_id`, `app_id`), operation-shape fields (`action: "send_message"`).

### Self-check before `save_strategy`

1. Would the strategy still make sense with a different user-arg value?
2. Any literal id in a navigate URL / body / query string is probably a missing `{{placeholder}}`.
3. Did you use a sidebar/pinned/cached shortcut? Re-run discovery via search.

## Discovery artifact

A protocol-neutral cross-run handoff carrier. Every tool call the agent makes during investigative work — `inspect_ws_frame`, `try_generator`, `get_js_source`, `get_send_encoder`, `find_in_page`, `get_network_log`, `get_attribute` — appends a structural record (tool name, args digest, outcome flag) to the session's accumulator. On `save_strategy` / `end_drive`, the runtime merges the accumulator with any prior on-disk artifact for the same `(platform, capability)` pair and writes the result. Next-session responses (`list_platform_skills`, `start_session`, `execute`) inline the artifact so the agent sees the handoff without extra tool calls.

**On-disk layout** — under `<KLURA_HOME>/workdir/<platform>/artifacts/`:

- `<capability>.json` — structured artifact (schema below).
- `<capability>.bin` — optional binary sidecar carrying protocol-stable bytes (≤ 4096 bytes, PII-scanned).

Neither file is shipped via ClawHub; `workdir/` is separate from `skills/` so published skill folders never carry discovery scratch.

**Artifact JSON schema:**

```json
{
  "schema_version": 1,
  "capability": "<slug>",
  "created_at": "<ISO>",
  "updated_at": "<ISO>",
  "sessions_contributed": <int>,
  "iteration_state": {
    "verify_iterations": <int>,
    "verified_ok": <int>
  },
  "resume_pointers": [
    {"kind": "js_source"|"request_index"|"frame_index"|"page_url"|"other",
     "ref": "<string ≤ 500>",
     "line": <int, only valid when kind==="js_source">,
     "note": "<string ≤ 120, PII-scanned>",
     "at": "<ISO>"}
  ],
  "observations": ["<slug ≤ 30>", ...],
  "tool_call_trace": [
    {"tool": "inspect_ws_frame"|..., "args_digest": "<16 hex>", "outcome": "ok"|"failed"|"partial", "at": "<ISO>"}
  ],
  "recommended_next_steps": ["<string ≤ 200, PII-scanned>", ...]
}
```

Caps: `resume_pointers` ≤ 20, `observations` ≤ 40, `tool_call_trace` ≤ 80 (ring-buffer; oldest dropped), `recommended_next_steps` ≤ 6.

**Kind semantics — named after the tool that produced the pointer, NOT the protocol family:**

- `js_source` — came from `get_js_source`; `ref` is the script URL, `line` is the offset probed.
- `request_index` — came from `get_network_log`; `ref` is the captured request's index.
- `frame_index` — came from `inspect_ws_frame`; `ref` is the WS frame index.
- `page_url` — a page worth re-visiting; `ref` is the URL.
- `other` — anything else; `ref` carries the detail in bounded prose.

**Observations** — opaque slug array. Agents write whatever shapes their discovery flow; runtime just enforces slug regex + length cap + dedupe. Examples: `['epoch_id','otid','thread_id']`, `['x-csrf-token','x-request-signature']`, `['persisted_hash','operation_name']`.

**Inline delivery**: `list_platform_skills` / `start_session` / `execute` responses carry the relevant artifact inline. No explicit fetch tool.

**Budget elision**: per-capability target 8 KB. Drop order on overflow: `tool_call_trace` (oldest) → trailing `observations`. Always preserved: `iteration_state`, `resume_pointers`, `recommended_next_steps`. `_elided_fields: [...]` names what was trimmed; fetch via `get_discovery_artifact_field(platform, capability, field)`.

**Agent-initiated saves**: `add_resume_pointer({session_id, kind, ref, line?, note?})`, `add_discovery_note({session_id, capability, kind, body, verified?})` (verified notes reset hardness counter), `save_verified_expression({session_id, capability, expression, ...})` (expressions up to 8192 chars; runtime evaluates once at save time so broken expressions never land).

**Merge across sessions**: `iteration_state` values take `max`; `resume_pointers`/`observations` union-deduped; `tool_call_trace` keeps last 80 by `(tool, args_digest, outcome)`; `recommended_next_steps` replaced if current session supplied; `sessions_contributed` increments only when some field changed.

## Reverse-engineer playbook

A transport-agnostic playbook for captured sends whose bytes aren't a literal echo of user input: binary WS frames (MQTT-over-WS), signed HTTP requests (HMAC headers, signature query params, nonces), persisted GraphQL, or any page-side-built payload. When unknowns are runtime-computed, iteration can't converge — find the page's builder, verify it produces the right artifact for sample args, save an expression that re-invokes it at warm execute.

**Default tier for signed / page-bound endpoints: `page-script`.** Request-signing / fingerprint-bound cookies / per-request nonces → save as `page-script`, not decline-to-recorded-path. `page-script` fires from inside the live browser page, so the page's own signing runs on every warm call. "Request has a signature → can't replay from Node" is NOT a reason to decline — it's the reason to pick page-script over fetch. Decline to recorded-path only when data genuinely isn't in any XHR.

**For cookied READ endpoints, use `fetch` — not page-script.** Node-tier `fetch` automatically sends the platform's session cookies via the runtime's cookie jar, and supports `response.format: "html"` + `response.extract` for HTML scraping. "Endpoint needs cookies" is NOT a reason to reach for page-script — it's the default `fetch` behavior. Use page-script for READS only when the response shape is built by in-page JS (window.\* state, virtual-DOM render, in-page crypto on response bytes); for any GET that returns a server-rendered HTML/JSON page, `fetch` is the right tier. Saving page-script with a `response` field is rejected because page-script returns whatever the script evaluates — there's no post-execute extract phase to add.

See `klura://reference#re-pattern-choice` to decide iterate vs encoder-read BEFORE starting.

**The toolkit — eight named moves.** Transport-agnostic; compose iteratively.

1. **Map.** `list_loaded_scripts(session_id)` — every JS bundle the page fetched, with sizes. Widens the search beyond just the `js_callstack` origin script (signers and encoders often live in a different bundle than the call site). `get_network_log` — every captured HTTP request and WS frame, with timestamps.
2. **Anchor.** Find a captured sample of the send you want to reproduce.
   - **WS**: `inspect_ws_frame(session_id, ws_i | ws_hash, {text_contains:"<typed>"})` returns a starter view + `js_callstack`. The callstack's top non-native frame names the file:line:col where `WebSocket.send` fired.
   - **HTTP**: `get_network_log({text_contains:"<typed literal>"|"<signature param>"})` finds the matching XHR. The request's URL + headers + postData are the artifact; `find_in_page` can trace opaque fields back to DOM/meta sources.
3. **Locate the builder.** `get_js_source(file, {line})` reads a raw-source window around the anchor. `search_js_source(file, pattern)` finds related sites by protocol literal — route paths (`"/api/send"`, `"/ls_req"`), field names observed in the captured request (grab the exact header/param names you saw in step 2), signer function names (`"sign"`, `"signature"`, `"encode"`, `"hmac"`, `"nonce"`, `"token"`). `read_js_function(file, line)` extracts the enclosing function in one read — name, params, body preview. No more line-window guesswork.
4. **Probe.** `js_eval(session_id, expression)` runs against the LIVE page. Binary returns come back as hex automatically — no JSON-serialization holes. When testing endpoints with `fetch()`, prefer `{status, contentType, body: (await r.text()).slice(0, 500)}` over `.json()` — a failed/empty/HTML response throws on `.json()` with a bare SyntaxError that doesn't tell you what actually came back (the runtime augments this specific error with a hint, but avoiding the throw in the first place is cleaner). Test:
   - `Object.keys(window).filter(k => /sign|encode|build/i.test(k))` to find candidate globals. **When the bundle is VMd / obfuscated / minified past hand-reading**, this probe is still the cheapest unlock: the VM has to expose a callable from plain JS or the page couldn't use it. Broaden the regex to `/sign|sdk|token|crypto|sec|auth|fingerprint|bot/i` when the narrower shape turns up nothing; the public entry point is named by something, even when the implementation isn't readable.
   - **Starter-stall anti-pattern**: if you just called `inspect_ws_frame` and got a `starter` back, run `try_generator({code: starter.code, args: starter.args_for_iteration_1, verify_against: {ws_hash}})` IMMEDIATELY — don't pivot to reading the encoder source, setting breakpoints on the publisher, or probing the module system first. The starter is designed to be ITERATED against byte-diff feedback, not read. Most binary-WS envelopes (MQTT-over-WS, length-prefixed nested JSON) hit `ok:true` on iteration 1; convergence handles rotating fields (`epoch_id`, `otid`, timestamps, nonces) empirically. Reading the source is a fallback when iteration 1 diffs large; it's not a prerequisite. The runtime detects starter-stall (inspect_ws_frame called, try_generator not called) at the self-decide check-in and surfaces a specific nudge.
   - `typeof window.require === 'function'` or similar probes to detect module registries (Webpack / AMD / site-specific internal loaders).
   - Call candidate builders with sample args and compare output against the captured artifact (byte length for WS frames, URL equality for signed URLs, header presence for signed headers). `set_breakpoint` + `get_frame_scope` + `evaluate_on_frame` (see `klura://reference#debugger-surface`) pauses at the builder's callsite so you read the exact live args the page was about to pass in.
   - **Monkey-patch-capture from a one-shot `js_eval`**: when the page hasn't navigated since you found the call site, wrap the located method in `js_eval` to record ground-truth inputs into a `globalThis.__klura_captured` slot, trigger one real send, then read the slot. Restore the original method afterward — the saved `frameFromPage` should call the original, not the wrapper.
   - **Monkey-patch-capture across navigation** (`install_page_init_script`): when the send happens after `window.location.href = '/'` or any SPA route change, install the wrapper via `install_page_init_script` instead. Init scripts run on every fresh document before the page's own bundle, so the wrapper is in place before any other code runs and survives every navigation. The page's own fetch wrapper then wraps yours; when its wrapper calls through to the original, the "original" is your instrumented version. Canonical fetch wrapper:
     ```js
     if (!window.__klura_orig_fetch) {
       window.__klura_orig_fetch = window.fetch;
       window.__klura_captured = null;
       window.fetch = async function (...args) {
         const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
         if (url.includes('/<your-target-path>')) {
           const headers = {};
           const opts = args[1] || {};
           if (opts.headers instanceof Headers) opts.headers.forEach((v, k) => (headers[k] = v));
           else if (opts.headers) Object.assign(headers, opts.headers);
           window.__klura_captured = { url, method: opts.method, headers, body: opts.body };
         }
         return window.__klura_orig_fetch.apply(this, args);
       };
     }
     ```
     Then drive the UI normally (or call the page's send), then `js_eval('return JSON.stringify(window.__klura_captured)')` to read what fired. Returns a `handle`; pass to `remove_page_init_script` when done.
5. **Template.** Once an expression reliably produces the right output, parametrize: replace test literals with `{{<paramName>}}` placeholders matching the declared capability args. For WS: args bind into the encoder call. For HTTP: args bind into the fetch URL / body; any page-derived tokens bind via `page-extract` or `js-eval` prereqs.
6. **Verify.** Re-run the templated expression with FRESH args (different text, different recipient, different query). For WS, confirm byte length stays in range and the opcode header matches. For HTTP, fire the built URL/body through a page-side `fetch()` and confirm a 2xx response against fresh args (not the captured ones).
7. **Save.** The save shape depends on transport:
   - **WS binary:** `save_strategy({strategy:"page-script", protocol:"websocket", origin, wsUrl, frameFromPage:{expression, returns:"hex"|"base64"}, notes:{params:{...}}})`. Execute-time: `evaluateExpression` runs the encoder on the live page, decoded bytes dispatch via `sendWebSocketFrame`.
   - **HTTP signed:** `save_strategy({strategy:"page-script", baseUrl, endpoint, method, headers, ...prereqs:[{kind:"js-eval", expression:"...", binds:{signedUrl:"$.result"}}] })` OR save a `frameFromPage`-equivalent that builds the full signed URL+headers and `page-script` fires it from inside the live page. Re-signing runs on every warm execute because the page's own JS does it.
   - **HTTP signed where the signer is closure-locked to the page's send module:** some bundles wrap fetch and only run the signer (or only fire a WASM PoW solver) when the call originates from the page's own send module. Calling `fetch(captured_url, captured_headers)` from `js_eval` returns 403 because the wrapper checks call-site / module origin before signing. Don't keep tuning headers — the signer is structurally unreachable from arbitrary `js_eval` contexts. Two valid saves:
     1. **Module anchor** (preferred when reachable): find the send module via `search_js_source` for protocol literals (the captured URL path, the field names you saw on the wire). Save as `page-script` with `notes.anchor_type: "module"` and an expression that calls the module export directly: `await window.__webpack_require__('SomeModule').sendMessage('{{text}}')`. The page's own signer runs because the call is on the page's own code path.
     2. **DOM anchor** (when no module export is reachable): save as `page-script` with `notes.anchor_type: "dom"`. The expression drives the UI from inside one `js_eval`: set input text, dispatch input event, click submit, poll the DOM for the response, return the response text. The page's send code runs because the click triggers it. This is **not** "fragile recorded-path in disguise" — it's the structurally-correct save when the signer is closure-locked. Atomic, retryable in one `js_eval`. Don't iterate raw-fetch attempts past one failed try; if headers + body match the wire and you still get 403, the signer is closure-locked. Pivot.
   - Platform caveats on the save validator (disallowed hostnames, generic-literal guards, etc.) live under `klura://reference#strategy-schemas-overview`. **After save_strategy responds.** Expect 1–3 audit rejections before the save lands. Each rejection is `invalid_strategy: save_strategy_rejected (<reason>)` carrying an `audit_token`, an `items` checklist, and any `warnings`. The retry contract: re-call `save_strategy` with the **same strategy payload + the audit_token** plus `audit_answers` keyed by classifier kind for any open items, plus `notes.save_warnings_acked` for warnings you're overriding instead of fixing. Each rejection narrows what's open; the same token survives across retries until the strategy hash changes.

   - **Warnings**: each is fixable OR ackable. The `hint` line tells you the fix; `notes.save_warnings_acked: [{kind, reason}]` overrides when the warning genuinely doesn't apply (e.g. a `prereq_bind_key_mismatch` is intentional because the bind name is reused across sibling endpoints with different wire keys).
   - **`items.literal_provenance`**: keys are field PATHS (e.g. `"endpoint"`, `"headers.X-Foo"`, `"body.userId"`), not the literal values at those paths. Auto-classified entries (templated fields with one distinct `{{placeholder}}`) you can omit; the audit fills them in.
   - **`items.user_confirmation`**: contains a `required_facts` struct (`{capability, tier, target, anchor_type, warning_kinds}`) and an `agent_note` re-stating the freshness contract. Compose a 1-3 sentence prompt in your own voice that mentions every fact, relay it to the user, and supply both the prompt and reply in `audit_answers.user_confirmation: {agent_prompt, user_decision, user_quote}` on retry. The runtime structurally checks `agent_prompt` covered every required fact. **Do NOT reuse the user's reply to a prior `ack_checkpoint` (triage_plan, surface_changed) or any earlier turn** — the runtime cannot detect recycled replies; freshness is on the agent. Self-resolving the gate by recycling a reply defeats its purpose. (When an embedder has registered a save-confirmation decider, the runtime auto-resolves this classifier on retry without needing an agent-supplied answer — you don't need to detect this; just retry, and the audit either passes or re-rejects with a fresh prompt.)
   - **The rejection is NOT a "your save is being processed" notice — it's a hard reject with a retry path.** If you end the turn after the first rejection, no save lands. The `→ Your save_strategy call is NOT committed` line in the response is literal: nothing was written.

8. **Handoff.** If you run out of budget mid-process, drop `add_resume_pointer` entries for the file:line anchors you found. Drop `add_discovery_note` entries with prose reasoning — "builder is the function whose first arg is `{text, thread_id}`", "request signature header is derived from path+query+timestamp via fn at bundle-abc.js:9872". Next session's agent reads them from `list_platform_skills.discovery_artifact` inline.

**When a saved strategy fails on warm — patch, don't re-discover.** A warm `execute()` failing usually means a small structural shift the page deployed (rotating path keys on `window.__app.<keyA>.<keyB>.nonce`, renamed top-level global, moved DOM anchor) — not that the whole strategy is wrong. The patch flow is faster than re-RE'ing from zero:

1.  Read the saved strategy via `list_platform_skills` → find the prereq expression / endpoint / step that broke.
2.  Probe the live page with `js_eval` to find where the data moved (e.g. `Object.keys(window.__app)` to find the new top-level key, then walk down to the renamed nonce path). Lifting the structural search via `Object.keys` survives rename; reading from a hardcoded path doesn't.
3.  **For `page-script` / `fetch` strategies**: re-call `save_strategy` with the same `{platform, capability}` and the patched expression. The save overwrites the prior strategy. Discovery rounds for a patch should be ~half of the original lift's rounds — if you find yourself at parity, you're re-RE'ing instead of patching.
4.  **For `recorded-path` strategies**: use `patch_step({platform, capability, strategy_type, step_id, locators})` to fix just the broken step's locators without rewriting the rest. The `recorded_step_failed` checkpoint payload names the `failed_step_id` directly. See `klura://reference#step-healing-response-format`.

The signal you're patching well vs. re-RE'ing: discovery_artifact pickup. `list_platform_skills` surfaces the prior session's `resume_pointers` and `discovery_notes` — read them first. Re-deriving facts already in the artifact is the wasted-rounds anti-pattern.

**Smells: when to pivot tier.** If you've spent N rounds chasing a tier and any of these hold, pivot:

- You verified the DOM-drive sequence works (`set text → dispatch input → click submit → poll DOM`) but kept investigating other approaches anyway. **Save the `page-script` with `anchor_type: "dom"` and ship.**
- Hand-rolled `fetch` returns 403 from `js_eval` even with all observed headers verbatim. **The signer is closure-locked. Pivot to module-anchor or dom-anchor `page-script`.**
- You've persisted ≥3 `discovery_notes` but attempted 0 `save_strategy` calls. **Compose your best-guess strategy and submit — the rejection's diff is signal you can't get from inspection alone.**
- The captured request body literally contains the user's typed text and the headers replay clean from Node. **You're done. Save as `fetch` and stop reading the bundle.**
- Every time you switch RE strategy (monkey-patch → breakpoint → source-read), drop one `add_discovery_note` capturing what you learned and why you're switching. Three runs deep, conversation context is huge; the discovery_artifact is your only durable record.
- When the network log already has a clean captured send for the capability, copy `baseUrl` + `endpoint` + `method` + `headers` straight from the captured request into your `save_strategy` call. The captured request is your authoring template — the URL, query params, and body keys all transfer; you only have to decide which literal values become `{{placeholder}}` and which stay verbatim.

**Example — WS binary write, `page-script` save shape:**

```json
{
  "strategy": "page-script",
  "protocol": "websocket",
  "origin": "https://chat.example.com",
  "wsUrl": "wss://edge-chat.example.com/chat",
  "frameFromPage": {
    "expression": "await window.chatSdk.sendMessage({text: \"{{text}}\", thread_id: \"{{thread_id}}\"})",
    "returns": "hex"
  }
}
```

**Example — HTTP signed request with js-eval prereq:**

```json
{
  "strategy": "page-script",
  "baseUrl": "https://www.example.com",
  "endpoint": "/u/{{username}}",
  "method": "GET",
  "prerequisites": [
    {
      "kind": "js-eval",
      "expression": "await window.signRequest('/api/list?count={{count}}')",
      "binds": { "signed_url": "$.fullUrl" }
    }
  ]
}
```

Warm runs auto-execute: args interpolate into the expression, the page's signing runs on every call, the fetch fires from inside the browser with live cookies, the response projects via `response.extract`.

## debugger-surface

Source-level debugger on top of CDP's `Debugger` domain. Use when the bundle is minified past hand-reading and the encoder is easier to surface by _pausing at the send site_ than by grepping. Available tools: `set_breakpoint`, `remove_breakpoint`, `list_breakpoints`, `wait_for_pause`, `get_frame_scope`, `evaluate_on_frame`, `step`, `resume`.

**Shortest path from captured send to encoder:**

```
1. inspect_ws_frame(session_id, ws_i) → js_callstack.frames[0] has file:line:column
2. set_breakpoint({file, line, column}) → { breakpoint_id, resolved_location }
3. perform_action(...) to trigger the flow again (user re-types the message and sends)
4. wait_for_pause({timeout_ms: 15000}) → { hit: true, call_frames: [{frame_index, scope_chain, ...}] }
5. get_frame_scope({frame_index: 0, scope_type: "closure"}) → properties[] names encoder + captured args
6. evaluate_on_frame({frame_index: 0, expression: "JSON.stringify(arguments)"}) → exact pre-encode args
7. evaluate_on_frame({frame_index: 0, expression: "encodeSend.toString()"}) → encoder source
8. resume() → page continues
9. remove_breakpoint({breakpoint_id}) — or let end_drive clean up
```

**Mechanics:**

- `set_breakpoint` routes to CDP `Debugger.setBreakpointByUrl`. `file` is an exact URL match as CDP reports it — use `inspect_ws_frame.js_callstack.frames[*].file` or `list_loaded_scripts` for valid values. `line` / `column` are 0-indexed per CDP convention. Optional `condition` is a JS expression evaluated at the pause candidate — only truthy values pause. Max 10 active breakpoints per session. Condition cap 512 chars. `resolved_location` in the response reports where CDP actually placed the bp (CDP shifts to the nearest executable statement if `line` lands on whitespace or a comment).
- `wait_for_pause` blocks until the next `Debugger.paused` event or `timeout_ms` (default 10000, max 60000). Does NOT resume — the page stays paused. Pause events queue (cap 5) if they arrive before `wait_for_pause` is called; only the oldest 5 survive a flurry of hits. Only one outstanding `wait_for_pause` per session — a second concurrent call throws `already_waiting`.
- `get_frame_scope` returns a shallow property list (one level of preview) for one scope of one call frame. Pick the scope by `scope_type` (first match wins: `local`, `closure`, `global`, `block`, `catch`, `with`, `module`) OR by `scope_index`. Properties are capped at 200 entries (sets `truncated: true` when that cap bites). Drill into nested objects with `evaluate_on_frame`.
- `evaluate_on_frame` is CDP `Debugger.evaluateOnCallFrame` — the expression runs in the paused frame's scope, so locals and closure-captured names resolve directly. Since execution is frozen, there is no async IIFE wrap (unlike `js_eval`); expressions run synchronously. Result comes back as a string (JSON-stringified when possible, else the remote-object description). Timeout default 5000, max 30000.
- `step` advances by one line (`over`), descends into a function (`into`), or runs to the end of the current function (`out`). Returns `{paused_at: {file, line, column, function_name}}` on the next pause, or `{done: true}` when execution completes without pausing again (5s window).
- `resume` releases the pause. Idempotent — no-op when not paused.
- **Cleanup is automatic.** `end_drive` resumes any active pause, removes every breakpoint, and disables the Debugger domain before cookie save. You never need to manually tear down; `remove_breakpoint` is for mid-session hygiene only.

**What belongs on this surface vs. `js_eval`:** `js_eval` runs at global scope and sees only module exports the page chose to pin on globals. It cannot see closure-captured locals, private class fields, or values the minifier inlined. `evaluate_on_frame` _at a paused frame_ sees all of them because the frame is literally parked in that scope. Use `js_eval` for "probe a global I can name," use `evaluate_on_frame` for "read the closure I just parked in."

**Safety:** blocked in `execute_only` mode. Requires the playwright driver — the remote driver throws `not_implemented`. The surface is scoped to the paused frame; there is no global-scope escape hatch here (use `js_eval` for that).

## Observed capabilities

`record_observed_capability({platform, name, evidence, why_not_lifted, hypothesis?, session_id?})` logs a sibling capability observed during discovery but not lifted. Persists on the platform logbook (`~/.klura/workdir/<platform>/logbook.json` → `observed_capabilities[]`). Dedup-by-name; repeat calls bump `observed_in_sessions` once per `session_id`.

**Arguments**:

| Field | Required | Shape | Notes |
| --- | --- | --- | --- |
| `platform` | yes | slug | same as the `platform` arg for `save_strategy` |
| `name` | yes | slug `/^[a-z][a-z0-9_]{1,59}$/` | the canonical capability name, same shape as the `capability` arg you'd pass to `save_strategy` |
| `evidence` | yes | object with `source: string` + any source-specific fields | `source` is a free-form descriptor (common values: `"network"`, `"ui"`). Attach whichever pointers help the next agent re-find the observation — `endpoint`, `request_i`, `ws_i`, `method`, `response_shape`, `returns`, `ui_selector`, `ui_hint`, etc. Fields are carried opaquely by the logbook. |
| `why_not_lifted` | yes | enum: `separate_capability`, `turn_budget`, `unverified`, `blocked`, `other` | `separate_capability` is the canonical "this deserves its own strategy"; pick from the others when the observation is incomplete for a different reason |
| `hypothesis` | optional | ≤ 800 chars | structural prose — describe what the endpoint does, not the bytes it returned |
| `session_id` | optional | opaque string | current session id; ensures repeated calls within one session only bump `observed_in_sessions` once |

**Describe structurally, never paste.** `hypothesis` and evidence free-text fields describe what the endpoint does, not the bytes it returned. _"thread_id given a name"_ and _"list of order ids, each ≤ 24-char hex"_ are the right shape; _"returns thread_id 100012345678901"_ or _"sample id 550e8400-e29b-41d4-a716-446655440000"_ are not. A literal captured from the discovery session is scoped to the discoverer's entity — pasting it into documentation makes the observation un-portable for the next run.

**Cross-run pickup**: `list_platform_skills` surfaces each platform's `observed_capabilities` summary as `[{name, why_not_lifted, observed_in_sessions, last_observed_at}, ...]` so the next agent sees the full landscape — including the partially-discovered candidates — in their first call. If the user's task chains through one of these (they want to act on a named entity, and a prior run observed a `lookup_<entity>_by_name` endpoint), lift it as its own capability before discovering the action capability.

## platform-surface-map

A map-mode session explores a platform and enriches the per-platform logbook without producing strategy saves. Successor task-mode sessions see a compact summary of the map on `start_session` and can skip the "what does this site do" discovery phase.

### Opting in

`start_session(url, {platform, intent: "map"})` opens a map-mode session. `intent` is orthogonal to `mode` (`discover` / `execute_only`) — you can combine `{mode: "discover", intent: "map"}` to drive the browser in a map-shaped way.

Two behaviors differ from the default `intent: "task"`:

1. **No auto-synth on `end_drive`.** Task mode synthesizes a recorded-path from your action history when you didn't land a complete strategy; map mode skips this — map-mode clicks aren't meant to be replayed, they're probes. Nothing lands on `skills/<platform>/`.
2. **Per-action consent prompt.** Every mutating `perform_action` (`click`, `type`, `fill_editor`, `key_press`, `select`) raises a consent prompt before the driver dispatches. The runtime can't reliably judge destructiveness from selectors or DOM shape — that's a semantic property of the surrounding page context. The gate's job is to keep the constraint adjacent to every fresh decision. The prompt names the action + selector and asks the agent to either ack with a one-sentence rationale or cancel with a reason. Sticky cache: once a `(action, selector)` tuple is acked, subsequent identical `perform_action` calls fire without re-prompting (so a re-click on the same target is a one-step no-op pass). The cache is session-local; `end_drive` clears it.

Read-only actions (`navigate`, `scroll`, `wait`) are not gated.

### What the session writes

Logbook writes during a map session (same writers task mode uses):

| Collection | Populated by | Fields |
| --- | --- | --- |
| `observed_capabilities[]` | agent calls `record_observed_capability({platform, name, evidence, why_not_lifted, ...})` | `name`, `why_not_lifted`, `evidence`, `hypothesis`, `observed_in_sessions`, `last_observed_at` |
| `url_graph.nodes[]` + `url_graph.edges[]` | runtime folds `dom_navigation` session events | node per URL visited; edge per adjacent nav |
| `forms_seen[]` | runtime folds `dom_form_observed` session events | one entry per distinct form signature (action + method + field names) |

What does NOT land:

- No `skills/<platform>/<capability>.json` strategy files.
- No `artifacts/<capability>.json` discovery artifacts.

Storage state (cookies) still persists via the normal `end_drive` path so the next session doesn't have to re-login.

### `platform_map` on `start_session` response

When `start_session` loads a platform whose logbook carries any observed capabilities, url graph nodes, or forms seen, the response inlines a compact teaser:

```
{
  sessionId,
  ...,
  platform_map: {
    last_scanned: "2026-04-24T12:34:56.789Z",
    observed_capabilities: [
      { name: "search_restaurants", why_not_lifted: "separate_capability", last_observed: "..." },
      { name: "place_order",        why_not_lifted: "separate_capability", last_observed: "..." },
      // ... up to 5, most-recently-observed first
    ],
    url_graph_size: 14,
    forms_seen: 3,
    hint?: "8 observed_capabilities total; top 5 shown by recency. Call get_platform_logbook for full details."
  }
}
```

`observed_capabilities` is capped at 5 (most recent first); `hint` appears when the logbook has more than 5. The field is omitted when the logbook is empty or missing.

Call `get_platform_logbook({platform})` for the full logbook (all observed capabilities, complete url graph, complete forms list, plus field-stability + bundle / signer / known-module derivations).

### Worked example — two-session flow

Session 1 (map):

```
start_session("https://klura-eats.example/", {platform: "klura-eats", intent: "map"})
  → drive through home, menus, search, cart preview, orders page
  → record_observed_capability({platform: "klura-eats", name: "search_restaurants",
      evidence: {source: "network", endpoint: "/search", method: "GET"},
      why_not_lifted: "separate_capability",
      hypothesis: "GET /search?q=<query> returns JSON list of restaurants"})
  → record_observed_capability({platform: "klura-eats", name: "place_order", ...})
  → record_observed_capability({platform: "klura-eats", name: "list_orders", ...})
end_drive(session_id, "klura-eats")
  → logbook updated; no strategies saved; auto-synth skipped
```

Session 2 (task, warm):

```
start_session("https://klura-eats.example/",
  {platform: "klura-eats", capability: "search_restaurants", args: {query: "thai"}})
  → response carries platform_map teaser (observed_capabilities incl. search_restaurants,
    url_graph_size=14, forms_seen=3)
  → agent knows "search_restaurants" was already observed at /search → lifts directly
    by authoring save_strategy from the captured XHR on the first /search response
```

### Worked example — consent gate

Map session tries to click a sidebar link:

```
perform_action(session_id, "click", 'link "My orders"')
```

Returns:

```
invalid_action: map_mode_consent_required

You're in MAP mode and about to click "link \"My orders\"".

Map mode exists to discover what a platform CAN do, not to do it. Before
proceeding, read the page context around this element. Do NOT click, type
into, or submit anything that would commit money, place orders, delete
data, change account state, send messages on the user's behalf, or
otherwise act on the user's account. "Looks like navigation" is not
enough — confirm from the surrounding text and your knowledge of the
site that this fires nothing destructive.

If this action is genuinely safe (navigation, view-only, exploratory), ack with:
  ack_checkpoint({
    session_id: "sess_...",
    checkpoint_token: "a3f9",
    user_response: "<one sentence: what you expect this to do and why it is safe>"
  })

After ack, the same (click, selector) pair won't prompt again this session. A
new selector — even on the same page — will prompt fresh.

If this action would mutate state, cancel: ack_checkpoint({session_id,
checkpoint_token, cancelled: true, reason: "<why this is unsafe>"}). The
action is dropped; pick a different next step.
```

Agent acks with a substantive `user_response` (e.g., `"navigation to /orders to view past order list — read-only page based on link text"`); the click then fires. A subsequent `perform_action(session_id, "click", 'link "My orders"')` (e.g., after navigating elsewhere and coming back) goes straight through — no second prompt. A _different_ selector, even a different button on the same page, prompts fresh.

The 4-char nonce in `checkpoint_token` is just a "you read THIS prompt" handshake — it's not a payload-bound audit token (those still exist for `save_strategy`, where the binding to a strategy hash is load-bearing). For `map_mode_consent`, the agent echoing the nonce + writing a specific rationale is sufficient anti-canned proof. Bare canned strings like `"ok"` technically pass the non-empty check, but the rationale field is open-ended (no menu of canned options) and visible to scenario scoring.

### Re-persistence gate in map mode

Map sessions don't expect RE; they do expect records. The re-persistence gate in map mode triggers on `end_drive` when `perform_action` count ≥ 5 AND `record_observed_capability` count = 0 AND no strategies saved — i.e. the agent clicked through the site but wrote nothing to the logbook. Escape: call `record_observed_capability` at least once (gate clears once `persistCallCount > 0`), OR call `abort_session(session_id, reason)` for the honest exit when the map session was misguided.

## Network log — discovery workflow

Four response modes; the runtime auto-picks between them based on your filter.

| Mode | When | Shape |
| --- | --- | --- |
| **`summary`** | No narrowing filter, or narrowed filter with pathologically huge (>15 KB) entries | `{i, method, url, status, contentType, postDataSize, responseSize}`. No headers/bodies. Paginated 50/page (max 200). |
| **`detail-lite`** | Narrowing filter (`url_contains`, `text_contains`, or `last`) is present | Full request headers, full postData, 512-char responseBody preview. Entries carry `i` for round-trip, `responseBody_truncated`/`_total_chars` when clipped. Greedy-paginated with `has_more`/`total_pages`. |
| **`detail`** | `{i: N, full: true}` | Single verbatim entry — all headers, full postData, untrimmed responseBody. |
| **`detail-list`** | `{full: true}` without `i` | Paginated raw entries (default 5/page, max 20). |

Filter preference, narrowest first: `{text_contains: "<literal>"}` (your typed input) → `{url_contains: "<path>"}` → `{last: 10}` (tails recent traffic). All auto-promote to detail-lite.

**Per-entry fields in detail-lite**: `method`, `url`, `status`, `headers`, `postData`, `responseBody` (clipped to 512 chars), `responseBody_truncated`/`_total_chars`/`_hint` when clipped, `i` (absolute index).

**HTML form POSTs**: when an entry shows `isNavigation: true` and `method: "POST"`, lift as `fetch` with a `page-extract` prereq for the CSRF token. **Never call `{full: true}` without narrowing** — telemetry-heavy sessions balloon past the tool-output cap.

## WebSocket protocol

When the captured write is a WebSocket frame rather than an HTTP request — common on realtime / chat / collaborative surfaces — classify the strategy with `protocol: "websocket"`. The tier (fetch / page-script) still picks the prereq model; `protocol` picks the wire shape.

### When to pick `protocol: "websocket"`

Observable signal: after the interaction, `wsFrames` in the network dump carries a **sent** frame whose payload contains the literal you just typed (or a length-prefixed envelope whose text portion contains it). There is **no** corresponding HTTP POST / XHR in `get_network_log` — the full write happens over the persistent WebSocket. If both a POST _and_ a WS frame carry the literal, prefer the HTTP path — it's simpler to graduate and faster to execute.

### WebSocket-specific fields

Conditional on `protocol: "websocket"`:

- **`wsUrl`** (non-empty string, required) — URL prefix matched against the page's WS registry (`transport: 'browser'`) or the full URL to dial directly (`transport: 'node'`, after `{{placeholder}}` substitution). Strip ephemeral query params (`sid`, `cid`, `sessionid`) from the observed URL when saving — those rotate per session.
- **`frame`** (non-empty string, optional) — the outgoing payload as a string template with `{{placeholder}}` substitution. Mutually exclusive with `generated.frame`. Use for plain-text framing: JSON messages, pipe-separated protocols, etc.
- **`generated.frame`** block (optional) — extends the existing `generated.*` pattern. Returns a string (text frame) or a base64-encoded string (binary frame). Use when the frame layout depends on content-length prefixes or other length-sensitive framing (MQTT-class, CBOR, protobuf-over-ws). Evaluated in page context for `transport: 'browser'`, Node context for `transport: 'node'`.
- **`frameEncoding`** (`'text'` | `'binary'`, default `'text'`). Binary path base64-decodes the resolved frame to a `Uint8Array` before send.
- **`ackMatch`** (non-empty string, optional) — substring required in a received frame within `ackTimeoutMs` for success. Absent = fire-and-forget (success as soon as the send resolves). Pick a stable-looking substring from the server's ack envelope (a JSON key name, a command identifier) — not session-specific values.
- **`ackTimeoutMs`** (non-negative number, default `5000`).
- **`wsOpen`** (`'navigate'` | `'none'` | `{steps: [...]}`, default `'navigate'`). Only meaningful for `transport: 'browser'` — Node transport dials the socket itself.
  - `'navigate'` — navigate to `baseUrl` and poll the page registry up to `wsOpenTimeoutMs`.
  - `'none'` — assume the page already has the WS open (warm-session case where the caller pre-navigated).
  - `{steps: [recorded-step, ...]}` — if the registry poll misses, execute these steps (shape identical to `recorded-path.steps`) to trigger the page's lazy WS open, then re-poll.
- **`wsOpenTimeoutMs`** (non-negative number, default `10000`). Browser transport only.
- **`wsHeaders`** (object of strings, optional) — headers for the WS upgrade handshake. Only valid when `transport: 'node'` (the browser's WebSocket API doesn't let JS set arbitrary upgrade headers). Rejected at save time for `transport: 'browser'`.

Fields **rejected** when `protocol: "websocket"`: `endpoint`, `body`, `method`, `contentType`, `headers`, `params`, `response`. They belong to the HTTP request shape and the save-time validator rejects them with a specific pointer.

### Transport-specific rules

**`websocket` + `transport: 'browser'`** (default):

1. The runtime navigates to `baseUrl` at execute time (unless `wsOpen: 'none'`) and polls a page-side registry that klura installs at session creation via `addInitScript` — the registry wraps `window.WebSocket` so every instance is visible to the runtime.
2. `driver.sendWebSocketFrame(session, wsUrl, payload, {encoding})` walks the registry, picks the first OPEN socket whose URL starts with `wsUrl`, and calls `.send()`.
3. `wsHeaders` is rejected — the browser sets handshake headers (Cookie, UA, Origin, sec-ch-ua-\*) itself.

**`websocket` + `transport: 'node'`**:

1. No page. Runtime opens a fresh WebSocket via the `ws` package directly at execute time.
2. `wsHeaders` is forwarded verbatim on the handshake. Typical contents: `Cookie`, `User-Agent`, `Origin`, optionally `sec-ch-ua-*`. Server-issued tokens (CSRF, session ids) that live in cookies get captured via a `page-extract` prereq earlier in discovery and interpolated into `wsHeaders.Cookie` at execute time.
3. `wsOpen` and `wsOpenTimeoutMs` are rejected at save time — there's no page registry to poll.
4. Same TLS / fingerprint caveat as HTTP-Node transport: JA3-sensitive sites reject Node-originated handshakes. On a handshake drop the runtime retries in browser and persists the demotion after 3 repeats (independent counter per protocol — ws-Node failures don't increment the http-Node counter, vice versa).
5. **Unsafe `wsHeaders` entries** rejected at save time: `host`, `connection`, `content-length`, `upgrade`, `sec-websocket-key`, `sec-websocket-version`, `sec-websocket-protocol`, `sec-websocket-extensions`, `sec-fetch-*`, `upgrade-insecure-requests`, HTTP/2 pseudo-headers (`:authority`, etc.). The ws library owns these on the handshake itself; setting them from user data either lies or collides.

### Worked example 1 — plain-text JSON frame, browser transport

```json
{
  "schema_version": 1,
  "strategy": "fetch",
  "protocol": "websocket",
  "baseUrl": "https://www.example.com/chat",
  "wsUrl": "wss://ws.example.com/chat",
  "frame": "{\"type\":\"publish\",\"text\":\"{{message}}\"}",
  "ackMatch": "upsertMessage",
  "notes": {
    "params": {
      "message": {
        "description": "the message to send",
        "kind": "text",
        "example": "hello there"
      }
    }
  }
}
```

At execute time: pool creates a session → navigates to `baseUrl` → polls the registry for a socket whose URL starts with `wss://ws.example.com/chat` → sends the interpolated frame → watches for a received frame containing `upsertMessage` within 5 seconds (default).

### Worked example 2 — length-prefixed binary envelope (generated.frame)

When the payload is MQTT / CBOR / protobuf-over-ws and length bytes depend on content, use `generated.frame` instead of the string `frame` template. Set `frameEncoding: "binary"` — the runtime base64-decodes the generator's output into a `Uint8Array` before `.send()`. The generator code uses the same sandbox + `args` model as top-level `generated.*.code` (see above); for iteration on byte layout, see `klura://reference#try-generator`.

### Worked example 3 — Node transport with extracted session cookie

Set `transport: "node"`, declare `wsHeaders` (`Cookie`, `Origin`, `User-Agent`), and feed the session id in via a `page-extract` prereq: `wsHeaders.Cookie: "sid={{sid}}"`. Use Node transport only on sites you've observed accept out-of-browser handshakes on cookie-bearing URLs — the default `browser` is correct for most fingerprint-bound realtime endpoints.

### Gotchas

- **Lazy WS open.** Default `wsOpen: 'navigate'` polls for `wsOpenTimeoutMs` (10s); if the page opens its WS on user interaction, set `wsOpen: {steps: [...]}` with recorded-path-shaped triggers.
- **Ack selection.** Pick a substring that survives across calls — a JSON key from the ack envelope, a command id. Not user-specific ids or timestamps.
- **Node-transport fingerprint fragility.** JA3-sensitive sites reject Node handshakes. Runtime retries in browser, demotes after 3 consecutive failures (per-protocol counter).
- **Binary ackMatch.** Substring test on the raw received frame; for binary envelopes, match on the stable ASCII key the envelope text portion contains.
- **Complex envelopes.** Length-prefixed binary / nested-escaped JSON / varint-encoded / compressed framing → use `try_generator` (`klura://reference#try-generator`).

## RE pattern choice

Reverse-engineering an encoded payload — binary WebSocket frame, signed HTTP body, persisted GraphQL request, MQTT-shaped write — offers two legitimate attack patterns. They aren't ordered; they're matched to the envelope. Picking the wrong one wastes rounds.

**Black-box iteration.** Capture a reference payload, write a candidate generator, `try_generator` against the reference, read the diff, refine, repeat. The convergence coach (`klura://reference#try-generator`) guides the loop: `shape: "envelope_correct"` after a few rounds means the framing is right and only body values differ, at which point `match: "structural"` accepts value-level differences and returns ok:true. Works when every unknown field is either the user's input literally, or a value the agent can construct from the user's input (ids looked up via companion strategies, flags, flags-of-flags).

**White-box encoder read.** `set_breakpoint` at the send callsite (sourced from `js_callstack` on the captured frame), let the page break on the next real send, `get_frame_scope` to see what's in scope, `evaluate_on_frame` to read the exact builder arguments, and walk up the call stack until you find the function that constructs the payload. Then lift the encoder into a `frameFromPage` expression. Works — and only works — when at least one unknown field is runtime-computed without a derivable formula: rolling counters, HMACs over session state, monotonic epoch ids, nonces seeded from private state, timestamps-with-skew. No amount of iteration converges on a value the agent can't compute.

**Signals for each:**

- Agent-controllable unknowns → iterate. Payload diffs after one round show only the bytes the user's request controls changing; other fields are stable across the capture window.
- Runtime-computed unknowns → read the encoder. Two captures of "the same" action produce different bytes at positions that aren't the user's input — the delta is the signature of a counter, HMAC, or hash-of-state. Field names like `otid`, `nonce`, `sig`, `ts`, `epoch_id`, `seq`, `mac` are structural tells.
- Mixed envelope (both kinds of unknowns in the same payload) → read the encoder once to learn the runtime-field formulas, then iterate on the rest. Most mature sites land here.

The toolkit supports both patterns; the runtime doesn't steer. Pick based on the envelope, not on habit.

## try-generator

A dry-run + byte-diff harness for `generated.<name>.code` snippets. Runs a candidate in the warm-execute vm sandbox, then optionally diffs its output against a captured ws frame (or explicit base64 ground truth).

**Loop for ws-frame generators:**

1. `get_network_log({text_contains: "<typed literal>"})` → finds the sent frame at `ws_i`.
2. `inspect_ws_frame(session_id, ws_i)` + `find_in_ws_frame(session_id, ws_i, needle)` — hex dump + needle offsets. Everything before the first offset is the envelope prefix; the needle is where `args.<param>` goes; everything after is the suffix.
3. Draft a candidate. Sandbox exposes `Date`, `Math`, `Buffer`, `JSON`, `crypto` (`randomUUID` / `randomBytes` / `createHash` / `createHmac`), frozen `args`. Return a string — for binary frames, return base64.
4. `try_generator({session_id, code, args, verify_against: {ws_i: N}})`. On match: `{ok: true, output, output_length, expected_length}`. On mismatch: `first_diff_offset`, `expected_byte`, `got_byte`, `diff_context.{expected, got}` (16-byte hex windows).
5. Iterate. **Stay in the loop until `ok: true`** — running without `verify_against` to sanity-check is not a substitute.

**Tool shape:**

```
try_generator({
  session_id?: string,            // required when verify_against.ws_i is set
  code: string,
  args?: object,                  // default {}
  encoding?: 'text' | 'binary',   // default 'binary' — base64-decode before diff
  match?: 'bytes' | 'structural', // default 'bytes'
  verify_against?: { ws_i: number } | { base64: string },
})
  → { ok: true, output, output_length, expected_length? }
  | { ok: false, output?, output_length?, error?, first_diff_offset?, expected_byte?, got_byte?, diff_context? }
```

**Convergence signal** on ok:false: `convergence: {length_match_pct, diff_offset_pct, shape, progress, hint}`.

- `shape: "envelope_correct"` — length within 5%, diff past header; 1–2 iterations from done (usually a rotating field).
- `shape: "envelope_wrong"` — length < 50% match OR header diverges in first 4 bytes; structural issue. Re-read `inspect_ws_frame`.
- `progress: "converging"` — diff moved forward. `"stuck"` — same `first_diff_offset` as prior iteration. `"oscillating"` — A→B→A pattern; step back.

**Rotating-field checklist.** Scan a captured binary-WS payload for names implying per-request rotation: `timestamp`, `epoch_id`, `otid`, `nonce`, `sequence`, `request_id`, `client_id`, `client_clock`, `message_id`, `signed_request`, anything `*_id` whose value differs across captures. Common derivations: `Date.now()` (ms), `Date.now() * 1e6` (ns-cast), `Math.random().toString(36)`, per-connection counter from a server-issued seed.

**Match modes:**

- `bytes` (default) — byte-for-byte equality; the established convergence loop.
- `structural` — use after ~3 iterations where the advisory says "encoder header verified; diffs are in the body." Runtime parses JSON out of both sides (handles length-prefixed binary envelopes, recursively unwraps stringified-JSON-in-strings), compares parsed shapes. Value differences within the same type accepted; different types, missing keys, array-length changes still fail. Response carries `structural_match: { kind, expected_json_bytes, got_json_bytes, depth_compared }` on success or `structural_match.diff` on failure. Raw-binary protocols (protobuf without text, pure MQTT control frames) fall back with `info.kind: "no_json_found"`.

**Auto-persist on `ok:true`.** When the session has a declared capability, the match is written to the session's discovery artifact under `verified_expressions[<capability>]` automatically — the response carries `auto_persisted_as_verified_expression: {capability, binds_args, returns}`. Hardness-check counter resets; the expression survives `end_drive` via the artifact. Without a declared capability (or when code exceeds the per-expression length cap), auto-persist is skipped silently. Declare via `declare_capability({session_id, capability, args})`.

**Constraints.** No side effects — pure sandbox exec + byte-compare. 100ms execution budget. Must return a string (base64 for binary). `args` are frozen.

## triage

Triage is a defense-surface fingerprinting pass. The agent inspects what third-party origins, scripts, and cookies a page loads; characterizes the bot-detection posture using its own knowledge (the runtime never names vendors); and submits one plan per surface via `submit_triage_plan`. The verdict (an `expected_tier` of `fetch` (T0) / `page-script` (T1) / `recorded-path` (T2) plus a strongly-cited `tier_justification`) is **informational** — the agent still aims T0 (fetch) → T1 (page-script) → T2 (recorded-path) in lift, in order. The verdict shapes user expectation and escalation hygiene: on aggressive surfaces, T0 / T1 attempts may burn the session, and the agent should plan to retry from a fresh ephemeral context.

### Surface keying

A capability can span multiple URLs (`/cart` → `/checkout` → `/payment`) with different defense postures. The agent supplies a semantic `surface_label` (e.g. `"checkout"`, `"search"`, `"settings/billing"`); the runtime binds every URL in the plan's `observed_at_urls` to that label in an in-session map. When `perform_action` lands on a path-distinct URL no surface owns, the runtime fires the `surface_changed` checkpoint, transitions LIFT → triage, and waits for the agent to submit a plan for the new surface before any RE-active or save tool re-admits.

URL canonicalization for the surface map: origin + pathname; query / fragment stripped; host lowercased; trailing slash on a non-root path stripped. So `/search?q=foo` and `/search?q=bar` collapse to one surface; `/search` and `/checkout` don't. SPA route changes (`history.pushState` / `replaceState` / `popstate` / `hashchange`) feed the same map via a driver-side init script; modern SPAs are first-class.

### `submit_triage_plan` schema

```ts
{
  session_id: string,
  capability: string,
  surface_label: string,                      // semantic, agent-chosen
  defense_surface: {
    observed_origins: string[],
    observed_scripts: string[],
    cookies_set: string[],
    request_patterns: string[],               // free-text observations
    mechanism_hypothesis: string,             // free-text; agent's read of what defenses are present
  },
  expected_tier: 'fetch' | 'page-script' | 'recorded-path',
  tier_justification: string,                 // cite-validated
  summary_for_user: string,                   // 1-3 sentence handoff prompt
}
```

`observed_at_urls` is **server-derived** from `session.domNavigations` between triage entry and submission — the agent doesn't supply it, the runtime knows what was navigated to.

### Cite-validation

`tier_justification` must reference at least one verbatim artifact actually present in the session's captured traffic — an origin / host from `intercepted[].url`, a JS script URL or filename, a cookie name from `setCookieNames`, or a URL from `domNavigations`. Empty or uncited justifications reject with the candidate list. Match is word-bounded so substrings inside English words don't count.

### Worked example

For a checkout surface where the agent observed a fingerprint-collection script and a sensor cookie:

```
defense_surface: {
  observed_origins: ["https://collector.example.net"],
  observed_scripts: ["https://collector.example.net/sensor.js"],
  cookies_set: ["__sd_pix"],
  request_patterns: ["POST to /collect every ~2s with binary blob (~1.4KB body)"],
  mechanism_hypothesis: "behavioral telemetry + per-page sensor token; the API endpoint validates the cookie + a body field derived from it"
},
expected_tier: "recorded-path",
tier_justification: "checkout API rejects requests without __sd_pix; the sensor.js script populates the cookie based on user interaction events accumulated over time. fetch / page-script attempts immediately after page load will produce empty sensor data and 403."
```

The runtime accepts this because `__sd_pix` and `sensor.js` both appear in the session's captured traffic.

### Persistence

Plans are stored at `~/.klura/workdir/<platform>/logbook.json` under `per_capability[<cap>].triage_plans_by_surface[<surface_label>]`, with per-surface history capped at 5 prior plans. Re-submitting a plan for the same `surface_label` rotates the prior into history and overwrites the current entry. The next session reads these via `get_platform_logbook`.

### Re-entry from LIFT

Calling `submit_triage_plan` again from LIFT drops back to triage with a fresh round budget. Trigger cases: (1) navigation crossed to a new surface (the `surface_changed` checkpoint already forced this transition); (2) the prior verdict was contradicted by reality (e.g. `expected_tier: "fetch"` but T0 (fetch) attempts silently 403 — re-fingerprint with the new evidence).

### Save-time gate

Every `save_strategy` call passes through `surface_triage_missing` on the consolidated audit (`runtime/src/audit/lift/save-strategy.ts`). It derives a representative URL from the strategy, looks up the surface, and rejects if either the URL isn't bound or the bound surface has no current plan. Tier-agnostic. Full URL-extraction rules: `klura://reference#triage-surface-binding`.

### Behavior by lift_mode

`lift_mode` controls whether the end-drive LIFT handoff fires at all.

- `explicit_learn` (default) — end-drive emits the LIFT handoff prompt for relay to the user.
- `skip` — end-drive tears down silently; no handoff.

For autonomous runs (benchmark / CI), register a checkpoint handler claiming `triage_plan` + `surface_changed` whose `continue` resolution pre-empts the default interactive handover — see `field-reports/lib/checkpoint-stubs.js`.

### How data accumulates

Each natural user invocation writes a session archive under `working/sessions/<sessionId>/`. The logbook (and its per-capability triage plans) recomputes lazily on `get_platform_logbook`. N ≥ 3 samples is usually enough for URL-param classification to converge. Passive accumulation costs nothing; each repeat is another free sample.

## triage-surface-binding

A triaged surface binds to a strategy at save time via URL match. The `surface_triage_missing` detector derives a representative URL from the strategy, canonicalizes via `urlKey` (origin + pathname; query / fragment stripped; host lowercased; trailing slash on a non-root path stripped), and looks it up in the session's surface map. The map was populated by `submit_triage_plan` from `defense_surface.request_patterns` (extracted URL tokens) plus the runtime-derived `observed_at_urls`.

The URL extracted from the strategy is **tier-aware**:

| Strategy tier | URL extracted from | Bound to surface whose `request_patterns` contains |
| --- | --- | --- |
| `fetch` | `baseUrl + endpoint` (resolved) | `<METHOD> <URL>` — the strategy's `method` |
| `page-script` | `baseUrl + endpoint`, or `wsUrl` for websocket | `<METHOD> <URL>` |
| `recorded-path` | first `steps[i].url` where `action === "navigate"` | `GET <URL>` |

For recorded-path strategies specifically: the triage plan's `request_patterns` MUST include the navigate-step URLs (as `GET <URL>` entries) alongside any XHR / fetch endpoints captured during discovery — otherwise `save_strategy` rejects with `surface_triage_missing` even though the surface is "triaged." The proactive `recorded_path_navigate_url_unbound` detector at triage submit time catches this when `expected_tier === "recorded-path"` and no captured `domNavigations` URL appears in `request_patterns`.

`request_patterns` entries can be either `<METHOD> <URL>` or just `<URL>`; the URL is what binds. Method tokens are documentation; the runtime matches on the canonicalized URL key alone.

## revisit-prompt

When `start_session` warm-executes a saved strategy whose tier is below the ceiling (`fetch`) AND any of the following holds — (a) the platform logbook records prior `lift_attempts`, (b) the served tier is `recorded-path`, or (c) the served page-script has `notes.anchor_type` of `"dom"` / `"unknown"` (fragile; see `page-script-anchors`) — the response carries a `revisit_prompt` field:

```ts
revisit_prompt?: {
  served_tier: 'recorded-path' | 'page-script';
  ceiling_tier: 'fetch';
  prior_attempts: number;
  last_attempt_days_ago: number | null;
  // Present only when served_tier is 'page-script'. Fragile anchors
  // ("dom" / "unknown") are one of the triggers for this prompt.
  served_anchor_type?: 'module' | 'protocol' | 'dom' | 'unknown';
  last_outcome?: string;
  last_notes?: string;
  user_prompt_suggestion: string;
}
```

The agent should relay `user_prompt_suggestion` VERBATIM as a text-only turn after delivering the user's answer. Reply shapes:

- **YES / try / lift** — proceed with the LIFT playbook (inspect_ws_frame / try_generator / set_breakpoint, then `save_strategy` against the captured request). Even though execute succeeded, this session enters LIFT to attempt a tier upgrade. (Triage runs automatically on end_drive's LIFT handoff; no separate call needed.)
- **NO / skip / later** — call `end_drive`. The next natural invocation surfaces the same prompt; no urgency.

Recorded-path is ~10× slower and brittle to DOM drift. DOM-anchored page-scripts survive until the next UI refactor. Surface this prompt every time it fires; we always want to hunt for durable-anchor upgrades when the saved strategy is below ceiling or fragile.

## checkpoints

Runtime-emitted mid-flow events with a known `kind` from a closed enum. Runtime is the detector, dispatch is direct (no menu). When a handler returns `handover`, the next tool response carries:

```json
{
  "...tool fields...": "...",
  "_checkpoint": {
    "kind": "triage_plan",
    "context": { "kind": "triage_plan", "capability": "send_message", "...": "..." },
    "prompt": "Triage plan submitted for `send_message`. Relay this summary …",
    "viewer_url": "https://viewer.klura.io/…",
    "checkpoint_token": "ck_…"
  }
}
```

Ack shape:

```
ack_checkpoint({
  session_id,
  checkpoint_token,
  user_response?: "...",    // for triage_plan, surface_changed, post_save_validation_consent
  viewer_result?: {...},    // for recorded_step_failed, session_expired (after user finished in the viewer)
  cancelled?: true, reason?: "..."
})
```

Without an ack, every other tool call on the session rejects with `invalid_strategy: pending_checkpoint …`.

Architecture, handler registration, and test-override patterns: see `runtime/docs/checkpoints.md`.

### `CheckpointKind` reference

Closed enum. Emit sites in the runtime own the `context` shape for each kind.

| `kind` | When it fires | Extra `context` keys |
| --- | --- | --- |
| `recorded_step_failed` | A recorded-path step threw mid-execute; execution is paused. Default handler opens the viewer; user solves it, then agent acks + calls `patch_step` + `resume_execution` | `failed_step_index`, `failed_step_id` (slug id of the step — pass this to `patch_step`), `healable: true` (and in the tool body: `failed_step`, `error_message`, `a11y_tree`, `screenshot`, `url`) |
| `triage_plan` | `submit_triage_plan` committed; user ack requested before LIFT begins | `capability`, `surface_label`, `summary_for_user`, `expected_tier`, `tier_justification`, `defense_surface`, `is_replan` |
| `surface_changed` | `perform_action` landed on a path-distinct URL no triage plan covers (LIFT or triage). Forces transition back to triage | `new_url`, `prior_surface?` |
| `post_save_validation_consent` | `save_strategy` is about to fire a mutating validation call. See sub-section below | `pendingAction`, `contextSummary`, `declineHandler`, `validation_target` |
| `session_expired` | 401/403 with session-expired signature | `url`, `status`, `response_headers` |

### pre_action_consent (save_strategy post-save validation)

DRIVE side-effects the user asked for — `start_session({capability, args})` with mutating args — do **not** trigger a consent event. The act of declaring the capability + args is the user's consent; re-asking is redundant friction. `post_save_validation_consent` fires only on **agent-initiated** side-effects: `save_strategy`'s post-save validation handoff for mutating capabilities (the validation call would fire a second real request the user didn't ask for).

(The other agent-initiated side-effect path — `trigger_reference_send` — is a Level-3 token-gated gate, not a checkpoint. See `runtime/docs/gates.md`.)

When a `post_save_validation_consent` checkpoint handler returns `handover`, `_checkpoint.prompt` contains the tier-classification prose and `_checkpoint.context.validation_target` holds the concrete `{method, url}` the agent should fire once the user consents. Echo the `checkpoint_token` + `user_response` on the next tool call via `ack_checkpoint`. Tier rules:

**Tier 1 — explanation only.** Low-stakes mutations (test/sandbox account on the user's own infra, idempotent read-only validation, replayable draft). Emit one-line "About to: …" heads-up and proceed.

**Tier 2 — stop-and-wait.** Any action where:

- the recipient is any third party, human OR bot (DMs, emails, comments on someone's post, messages to LLM assistants, chats with support bots),
- the side-effect is irreversible at the wire level (post, publish, transaction, e-signature),
- money or stored-value moves,
- the action deletes user data,
- the action makes a public statement on the user's behalf,
- or the agent is unsure which tier applies.

For Tier 2, end your turn with a question. Reply shapes:

- **Yes** → proceed with the validation call.
- **Alternative ("use this text instead: …")** → re-plan with new args; re-confirm.
- **Decline** → skip the validation call and `add_discovery_note` documenting why. The save stands; next session can re-validate.

### Example tool response with `_checkpoint`

```json
{
  "ok": true,
  "path": "/home/u/.klura/skills/twitter/scripts/send_tweet.json",
  "save_warnings": [],
  "validation_target": { "method": "POST", "url": "https://x.com/api/..." },
  "_checkpoint": {
    "kind": "post_save_validation_consent",
    "context": {
      "kind": "post_save_validation_consent",
      "pendingAction": "firing the post-save validation call (POST https://x.com/api/...)",
      "validation_target": { "method": "POST", "url": "https://x.com/api/..." }
    },
    "prompt": "BEFORE firing the post-save validation call (POST https://x.com/api/...), classify per Tier 1 …",
    "checkpoint_token": "ck_…"
  }
}
```

## interruptions

Agent-detected ambient page state the agent wants a registered plugin to resolve (captcha in the a11y tree, login form visible, 2FA prompt). Menu-driven dispatch: `list_interruption_resolvers()` returns `[{name, description}, ...]`; the agent picks one by reading descriptions + the context it built.

```
list_interruption_resolvers({session_id?})
// → [{name, description}, ...]

resolve_interruption({
  session_id,
  context: { reason: "captcha_challenge", sitekey: "...", iframe_src: "..." },
  resolver: "<picked-name>"
})
// → { resolution: {status, ...}, interruption_token? }
```

Handler return shapes:

- `{status: 'resolved', value, patch}` — runtime folds the answer in; no envelope.
- `{status: 'continue', hint}` — silent continue.
- `{status: 'handover', target, prompt, viewer_url?}` — the next response carries `interruption_token` and every subsequent tool call **must** echo the token plus an ack (`user_response` / `viewer_result`) OR `{cancelled: true, reason}`. Without an ack every subsequent tool rejects with `invalid_strategy: pending_interruption …`.

Use this surface ONLY when the AGENT spotted something ambiguous on the page — captcha, auth-wall / login form, 2FA. Runtime-emitted events (recorded_step_failed, triage_plan, surface_changed, session_expired, post_save_validation_consent) arrive as `_checkpoint` and ack via `ack_checkpoint`. Do NOT route cookie banners, newsletter popups, or other dismissable UI noise through either surface — click them away yourself during normal navigation.

Architecture, handler registration, and plugin config: see `runtime/docs/interruptions.md`.

### `context.reason` reference (agent-emitted)

Free-form prose describing what the agent saw. Typical values:

| `context.reason` | When the agent emits it | Extra `context` keys |
| --- | --- | --- |
| `captcha_challenge` | Captcha iframe visible in the a11y tree | `sitekey?`, `provider?`, `iframe_src?` |
| `auth_wall_seen` / `login_form_visible` | Login form / auth wall visible | `platform`, `login_url?` |
| `2fa_prompt_visible` | 2FA / OTP input prompt visible | `channel`, `phone?`, `email?` |

## reverse-engineer-mode

Role-shift handoff returned by `end_drive` when any declared capability is unresolved (no saved strategy + no `max_strategy_tier: "recorded-path"` policy decline). This section covers the **handoff shape** + **LIFT-specific protocol** (check-ins, save-from-capture shortcut, multi-capability time-correlation, third-close escape).

### The LIFT flow rhythm

DRIVE ends when `end_drive` returns the LIFT handoff. From there, the intended rhythm is:

1. **Quick triage (explicit_learn only).** Emit a text-only turn in your own voice: _"Worth lifting? Rough rounds estimate?"_ Include what you saw (signed requests / binary WS / rotating fields, from the `re_signal` + `candidate_xhrs` on the handoff). Wait for the reply.
   - YES / lift / try → step 2.
   - NO / skip / later → call `end_drive` again; auto-synth drops a recorded-path fallback from your action history.

2. **Plow through on YES.** Attempt every RE trick. There is no pre-emptive fold:
   - `inspect_ws_frame` → get the byte layout + a pre-wired starter generator.
   - `try_generator` → verify envelope shape (iteration 1 with the starter is free; `ok:true` confirms envelope).
   - `js_eval` → probe page globals, module system.
   - `set_breakpoint` + `wait_for_pause` + `evaluate_on_frame` → read encoder scope.
   - `get_js_source` / `search_js_source` / `read_js_function` → find the signer / builder.

   **Rotating fields (epoch_id, otid, request_id, task_id, version_id, nonces, per-send timestamps, signatures, …) are templated via js-eval prereqs that re-derive the value from the live page** — one prereq per field, each with `binds`, referenced in `generated.frame.code` via `{{name}}`. The page has the machinery that produced each captured value; your prereq calls that machinery at execute time. Rotating fields are _never_ saved as hardcoded literals, and they're _never_ a reason to fold.

3. **User-arbitration is at save time, not on a runtime cadence.** Every `save_strategy` runs through the `user_confirmation` classifier (see [`#save-strategy-audit`](#save-strategy-audit) above). The first call returns `items.user_confirmation.required_facts` — a struct with the load-bearing facts about the proposed save (capability, tier, target, anchor_type, warning_kinds) — alongside an `agent_note` re-stating the freshness contract. Compose a 1-3 sentence prompt in your own voice that mentions every fact, ask the user, and retry with `audit_answers.user_confirmation: {agent_prompt: "<the prose you showed them>", user_decision, user_quote: "<their fresh reply>"}`. The runtime structurally checks `agent_prompt` covered every fact. **Do NOT reuse the user's reply to a prior `ack_checkpoint` (triage_plan, surface_changed) or any earlier turn** — the runtime cannot detect recycled replies; freshness is on the agent. Reject keeps the session in the current phase — try a different tier or anchor based on the user's reason.

4. **Quit conditions — exhaustive:**
   - **SUCCESS**: complete, runnable strategy saved. Expected exit.
   - **User rejects every shape you propose at save time.** If multiple tiers fail user_confirmation, persist findings via `save_verified_expression` / `add_discovery_note` / `add_resume_pointer` and `end_drive` — the next session inlines the artifact and continues.
   - Nothing else. Don't fold pre-emptively because the protocol looks complex — the `envelope-advisories` heuristic already flags complexity on `get_network_log`'s `_advisory` specifically to counteract the "fold on complexity" prior. The canonical response to that flag is to reach for the RE toolkit, not to capitulate.

5. **Mid-work user-assistance asks (always allowed).**
   - _"Mind if I send another message to verify the protocol?"_ — after the user agrees, call `trigger_reference_send`; the first call returns a `consent_token` + checklist, the second commits with `consent_answers` including the user's own words as `user_acknowledgement_quote` (Tier-2 per `#checkpoints`).
   - _"Could you perform action X in the viewer?"_ — text-only turn; user drives the browser via the remote viewer; agent observes the new capture afterward.

   These asks aren't consent-gated infrastructure — they're just you clarifying the protocol with the user when a specific observation would shortcut the lift.

### Why LIFT exists (the motivation)

klura sessions have two phases:

- **DRIVE.** The user asks for something; the agent drives the browser to get it. Ends when the agent calls `end_drive`. User satisfaction at this boundary is binary: did they get their answer? If yes, DRIVE succeeded.
- **LIFT.** end_drive didn't end the session; it handed off. The user is already off reading the answer. LIFT exists to convert what you just learned (a working browser path to a capability) into **infrastructure** — a saved strategy that future callers run warm-fast without re-discovery.

**Who LIFT benefits.** Not the current caller — they're done. Future callers: the same user's next query against the same capability (warm execute → ~100ms vs. ~30s re-discovery), benchmark runs measuring warm latency, other agents using klura's shared skills directory, automated flows firing the capability on a schedule. Every saved strategy amortizes across everyone who ever invokes it. A single save compounds forever.

**What declining costs.** Every future invocation of a recorded-path-capped capability re-runs the full UI flow: ~30s of wall-clock time, 10-20 LLM rounds, rate-limit exposure on the target site, storage-state churn. Recorded-path also breaks on DOM drift (cookie banners change labels, pagination widgets swap implementations, A/B tests move buttons). A declined capability that should have been page-script isn't just slow — it's fragile.

**What saving costs.** One-time RE work, amortized over every future call. For the common unencoded-send case: one `save_strategy` call authored from the captured XHR. For signed endpoints: 10-30 rounds to find the page's signing function and template a js-eval prereq. Expensive once, then free forever.

**The cost-benefit misread to avoid.** Agents often compute: "the user already got their answer; spending N rounds to lift this is N rounds wasted on an already-satisfied request." That frame treats infrastructure as a sunk cost for the current user. It's wrong — infrastructure belongs to everyone who comes after. The right frame is: "does a warm-callable version of this capability have durable value?" Almost always yes for any capability worth declaring in the first place.

**The mental model to adopt.** You are no longer a task-completer finishing a user query. You are a reverse engineer writing library code. The API you're about to save will be called by other agents, benchmark runs, and scheduled tasks — your job is to make sure the library call works for all of them, not just the caller whose UI drive you just finished.

**When decline IS the right call.** Data that genuinely isn't in any XHR (DOM-only content, server-rendered-once HTML with no JSON backing), capabilities where every captured request is a known dead-end (all 4xx, all WebSocket receive-only, no send), or cases where the agent genuinely inspected and found no liftable shape. Document the decline reason specifically — "inspected candidate XHRs i=X, i=Y, i=Z; none contain the rendered content" beats "too hard to lift."

**Required reading when you enter the LIFT-phase** (both apply to HTTP + WebSocket symmetrically):

1. `klura://reference#re-pattern-choice` — decide which attack fits the envelope BEFORE spending rounds. Black-box iterate when unknowns are agent-controllable; white-box read the encoder when unknowns are runtime-computed (HMACs, counters, session-derived ids); most mature sites are mixed and want both.
2. `klura://reference#reverse-engineer-playbook` — the 8 named moves (Map → Anchor → Locate → Probe → Template → Verify → Save → Handoff). Written for WebSocket frames, but the playbook is transport-agnostic — same flow applies to HTTP signed requests, signed GraphQL, MQTT-over-WS, or any captured send whose bytes aren't a literal echo of the user's input.

Further toolkit references:

- `klura://reference#try-generator` — iteration loop, convergence coach, match modes.
- `klura://reference#debugger-surface` — CDP-debugger (set_breakpoint, evaluate_on_frame, etc.) for minified bundles.
- `klura://reference#network-log-discovery-workflow` — get_network_log filter / pagination patterns.

### Response shape

Top-level: `{ok: false, phase: "lift", session_id, platform, unresolved_capabilities: [...], captures: {http_requests, ws_frames, actions}, triage: {<capability>: TriageBundle}, triage_errors?: {<capability>: string}, tools: {investigate, re_lift, save, escape}, end_drive_attempts, message}`.

`triage_errors` is present only when a per-capability `computeTriageBundle` call threw (malformed logbook, missing archive, etc.). The keyed capability is absent from `triage`; treat it as "no triage available" rather than "no action recommended." Errors also go to the runtime's stderr so benchmark / field-report runners surface them in their own logs.

### Earlier phase: `capability_declaration_required`

Before the LIFT-phase handoff fires, `end_drive` checks whether the session observed write-shape `perform_action`s (`type`, `fill_editor`, `fill`, `submit`) without any declared capability. If so, it refuses to tear down with a distinct handoff shape:

```
{
  ok: false,
  phase: "capability_declaration_required",
  session_id, platform,
  captured_write_actions: [{action, value_preview?}, ...],
  end_drive_attempts,
  message: "CANNOT CLOSE: ... call declare_capability({session_id, capability, args}) first."
}
```

Runtime rationale: auto-save keys strategies by capability slug; without one, a session with writes silently degrades to a keyless recorded-path nothing can look up at warm execute. The guard refuses attempts 1 and 2; attempt 3 force-tears-down like the LIFT handoff path. `lift_mode: "skip"` opts out of the guard (intentional "I'm just exploring" sessions).

Fix: call `declare_capability({session_id, capability: "<slug>", args: {...}})` with a verb-phrase slug (`send_message`, `submit_form`) and the user's arg values verbatim. Then re-call `end_drive`.

Per `unresolved_capabilities[]` entry:

- `capability`, `declared_args`, `saved_strategies` (empty here), `policy_max_tier` (null here).
- `candidate_xhrs` — top-5 captured XHRs from the data-load classifier. Each carries `i` (index into `session.intercepted`), `method`, `url`, `body_bytes`, `body_preview` (400-char clip), `needs_browser_session` (Cookie header present → page-script tier), classifier `signals`, `score`. **Body preview is the key** — scan it to find the XHR carrying the data you did/reported for this capability.
- `re_signal` — optional `{kind, evidence, ws_i?, ws_hash?, note}` from the envelope-advisory detector. Weak without a typed-literal anchor; the `note` flags when the signal may be spurious.
- `questions_to_answer` — four decision prompts (which XHR, session-scoped params, JSON vs binary, signed vs clean).

### Authoring `save_strategy` from a captured request

After picking an `i` from `candidate_xhrs[*]`, copy the captured request into your `save_strategy` call: `baseUrl` from the request's origin, `endpoint` from path + query, `method` and `headers` verbatim, body from `postData`. Tier is `page-script` when the captured request carried a Cookie header (warm replay needs a live page to attach the same auth state) and `fetch` otherwise.

Decide which literal values become `{{placeholder}}` and which stay verbatim before saving:

- Hardcode only what won't rotate across callers — API paths, query-param keys (`?sort=`, not `?sort=newest`), hostnames, HTTP methods, scheme tokens.
- Body values, query-param values, args you typed, single-time observations all parameterize via `{{placeholder}}` + a `notes.params` entry.
- If a query-param value is a value you saw in a click→XHR observation (e.g. clicking a category tile fired `?category=italian`), declare the param as `kind: "enum"` and copy the observation pairs into `observed_values: [{value, label}, …]`.
- If a value rotates per call (timestamps, nonces, signatures, anti-bot tokens, session-scoped ids), template it via a js-eval / page-extract / fetch-extract prereq instead of inlining.

The save-time `literal_provenance` classifier asks the agent to classify every baked literal as `static | caller_input | prereq_output | single_entity`. Pre-decide while authoring and you save a round.

### Side-effect consent applies during RE

The `pre_action_consent` Tier-1 / Tier-2 taxonomy (see `klura://reference#checkpoints`) is NOT scoped to the first action. Any LIFT tool call that causes an external write (`trigger_reference_send` with a submit-shaped step sequence, `perform_action` to re-submit for fresh diff data, `execute_strategy` against a write capability to verify) needs the same consent rule. Side-effect-free tools (`try_generator`, `js_eval` on pure expressions, `inspect_ws_frame`, `set_breakpoint` family, source-read tools, `get_network_log`, `get_action_history`) are safe to call freely.

### Multi-capability sessions

When multiple capabilities were declared (`login` + `search_user` + `list_videos`), each gets its own `unresolved_capabilities[]` entry. Work through them independently:

1. `get_action_history({since, until})` returns timestamped perform_action history — use it to bound each capability's time window.
2. `get_network_log` summaries carry `ts` (Unix ms) per entry — cross-reference with action windows to associate each XHR with the right capability.
3. Save each capability's strategy independently.
4. At warm-execute time, chain them via capability prereqs: `{kind: "capability", capability: "search_user", args: {...}, vars: {"user_id": "results[0].id"}}`. See `klura://reference#capability-prereq`.

### Third-close escape

`endDriveAttempts >= 3` force-tears-down regardless of unresolved state. Legitimate for genuinely unliftable sessions (total site breakage, failed login, unrecoverable state). Auto-synth still runs on forced teardown — recorded-path from perform_action history, literal-match fetch — so what can be derived mechanically gets saved.

## configure

`~/.klura/config.json` holds user settings (driver, pool mode, warm-pool tunables, remote-viewer tunnel). Users can hand-edit; agents use the `configure` tool family.

**Flow:**

1. `describe_config()` → every tunable field's `{type, valid values, default, description, needsRestart}` plus `current` merged config.
2. `configure({path, value})` → atomic write. Returns `{config, changed, runtime_restart_required, runtime_restart_fields, suggested_user_prompt}`.
3. If `runtime_restart_required: true`, relay `suggested_user_prompt` as a text turn; wait for yes/no before `restart_runtime()`.

**Restart semantics.** `pool.*` / `graduation.*` / `lift.*` / `defaults.*` / `remote.*` reload per-session. Only `runtime.listen` and `runtime.idleTimeout` need `restart_runtime`. `describe_config` flags per field.

**`restart_runtime({ force? })`.** Refuses by default when any session is active; pass `force: true` to kill them. Runtime exits cleanly; next klura call auto-respawns.

**Secrets.** `config.json`'s `secrets` map is handled by `addSecretResolver` / `removeSecretResolver` (via `klura secret add` CLI) — don't touch it with `configure`.
