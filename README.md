<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="wordmark-dark-bg.png">
    <img alt="klura" src="wordmark-light-bg.png" width="320">
  </picture>
</p>

<p align="center"><strong>Turn any website into an API</strong></p>

<p align="center">
  <a href="https://discord.gg/YJQ2zZYJ"><img alt="Discord" src="https://img.shields.io/discord/1496415213765791774?color=5865F2&label=Discord&logo=discord&logoColor=white&style=flat-square"></a>
  <a href="LICENSE"><img alt="License: BUSL-1.1" src="https://img.shields.io/badge/license-BUSL--1.1-blue?style=flat-square"></a>
</p>

---

Klura makes browser automation a discovery step, not a permanent tax.

On a fresh task, the agent starts from scratch: opens the site, clicks buttons, types into fields, and finishes the job in the browser. Klura records what happened underneath: requests, responses, cookies, page state, and the action trail. Afterward, klura runs **[LIFT](#lift)** (Learn Interface From Traffic) — its own analysis pass that reads the captured trace and turns the repeatable parts of the flow into a saved strategy that bypasses the UI.

```text
First run:
> message Amanda in the team chat using klura
  browser opens, task completes, traffic is captured

Lift:
> yes, analyze the capture

Later:
> message Bob in the team chat using klura
  klura → saved skill → ~0.3 s · 0 tokens
```

If the lift succeeds, future runs start from the saved strategy instead of rediscovering the page. Your agent stays in the loop in case the site changes, and self-heals any degraded skills.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="hero-dark.gif">
    <img alt="klura: one run, lift, then blaze through the saved skill" src="hero-light.gif" width="900">
  </picture>
</p>

<p align="center"><sub>
  <a href="#quick-start">Quick Start</a> &nbsp;·&nbsp;
  <a href="#benchmarks">Benchmarks</a> &nbsp;·&nbsp;
  <a href="#lift">LIFT</a> &nbsp;·&nbsp;
  <a href="#under-the-hood">Under the Hood</a> &nbsp;·&nbsp;
  <a href="#how-it-works">How It Works</a> &nbsp;·&nbsp;
  <a href="#use-cases">Use Cases</a> &nbsp;·&nbsp;
  <a href="#model-variance--reliability">Model Variance</a> &nbsp;·&nbsp;
  <a href="#is-it-legal-will-i-get-banned">Legal &amp; ToS</a> &nbsp;·&nbsp;
  <a href="#docs">Docs</a>
</sub></p>

---

## Quick Start

Add klura to your MCP client (Claude Code, Claude Desktop, Cursor, Windsurf, OpenClaw, ...), then restart the client:

```json
{
  "mcpServers": {
    "klura": { "command": "npx", "args": ["-y", "@klura/mcp"] }
  }
}
```

Now ask your agent for a website task:

> message Adam in the team chat using klura

If klura already knows the task, it runs the saved strategy. If not, the agent opens a browser and completes the task normally while klura records the traffic. Klura records the underlying traffic — requests, responses, cookies, and state — and analyzes it to infer the real interface behind the UI. Some sites need to see the same action two or three times before klura can pin down the underlying call — the agent will ask you to do it again. If a clean lift isn't possible yet, klura still saves the flow as a slower replay you can use right away, and revisit lifting later.

The next time, you can ask:

> message Bob in the team chat using klura

This time, no LLM tokens are spent walking the DOM — klura will fire directly against the API, returning an answer in milliseconds.

You can also scout a site up front without picking a task — ask your agent to map a website with klura and it walks the surface area and records what's there. The next real task starts, klura is already familiar with the platform. See [Under the hood](#under-the-hood).

---

## Why klura exists

Agents are slow because they keep using the UI as the interface. The UI is not the real interface; it is the human layer over requests, responses, tokens, and state. Klura captures that lower layer and turns it into something reusable.

|            | Browser agent              | klura                                        |
| ---------- | -------------------------- | -------------------------------------------- |
| First run  | Browser exploration        | Browser exploration + network capture        |
| Lift step  | Starts over next time      | Optional traffic analysis after the task     |
| Later runs | Browser exploration again  | Same saved strategy, with runtime safeguards |
| Tokens     | ~10–25k per run, every run | ~10–25k once at lift, then **0**             |
| Latency    | Seconds per UI step        | One request, ~hundreds of ms                 |

The saved output is not "agent memory." It is executable strategy data built from the observed session — the agent calls it, and the runtime handles tier escalation, prereqs, and recovery when the page drifts.

---

## Benchmarks

The point of LIFT is that the second run looks nothing like the first. Once a task is saved as a `fetch` or `page-script` strategy, the agent stops driving the browser and the runtime fires the request directly — no page load, no DOM walk, no LLM tokens spent on UI. **You don't need to know any of this.** The cold agent (Claude Sonnet 4.6, no human in the loop) figures it out: locates encoders, decodes envelope structure, derives rotating IDs, saves a runnable strategy. Call it vibe reverse-engineering — the LLM does the protocol work; you just ask for a github issue or a messenger send. All measured on Sonnet 4.6 through the same agent SDK loop (rows 1-2) and via the runtime's programmatic API with no LLM in the loop (row 3). Benchmark suite will be released soon for reproducability.

|  | HackerNews search | github/create_issue (`page-script`, auth + signed) [^github-re] | messenger/send_message (`page-script`, binary WebSocket) [^messenger-re] |
| --- | --- | --- | --- |
| Raw Playwright agent (no klura) | 22.9 s · 63k tok · $0.054 | 160 s · 634k tok · $0.29 | 134 s · 435k tok · $1.06 |
| Klura cold — discovery + LIFT [^cold-includes-lift] | 43.8 s · 363k tok · $0.191 | 318 s · 1.29M tok · $0.84 | 1469 s · 1.78M tok · $1.56 |
| Klura warm — runtime, no LLM [^runtime-only] | **0.33 s · 0 tok · $0** | **1.23 s · 0 tok · $0** | **5 ms · 0 tok · $0** |

Cold pays for tier — public reads lift cheaply; signed mutations need `page-script` plus signal-extraction prereqs; binary-WebSocket protocols need full RE work (locate the encoder, decode the envelope, reproduce the byte layout). **Warm collapses regardless of how exotic cold was**: the runtime's `execute()` call fires the saved strategy directly, no LLM in the loop, no agent rounds. github's page-script runs the persisted GraphQL query inside a live browser context with two `js-eval` prereqs extracting the rotating nonce and client-version; messenger's page-script rebuilds the binary MQTT frame from scratch and sends it through the page's already-authenticated WebSocket — many orders of magnitude faster than the cold agent doing the same work via UI.

When klura is wrapped in an agent SDK (the Claude SDK loop, an MCP host, etc.), the warm path adds 2-3 LLM round-trips for the agent to recognise the saved skill, dispatch `execute`, and report the answer — roughly 15-20 s on top, dominated by per-turn LLM latency. Numbers above are the runtime call itself; that's what the saved strategy actually does.

[^cold-includes-lift]: Klura cold time includes **discovery + triage + LIFT** — the agent first completes the user's task (comparable cost to the raw Playwright row), then reverse-engineers the protocol and persists a runnable strategy. The "actual sending" portion of cold is roughly the raw Playwright number; the remainder is one-time RE work that amortizes across every future warm call.

[^runtime-only]: No agent SDK in the loop, n=5 sequential, median wall-clock. github's number is the median of a clean 5/5-ok page-script. When this same path is dispatched from inside an agent loop, add 15–20 s of LLM turns on top — the runtime call itself is what these numbers reflect.

[^github-re]: GitHub's web flow posts to `/_graphql` with a persisted-query hash, an `X-Fetch-Nonce` header that the in-page bundle rotates, and a numeric repository ID pulled from the rendered page. Sonnet 4.6 identifies the call, isolates the rotating signal, and saves a `page-script` with two `js-eval` prereqs that read the nonce and client-version off the live page on every invocation. You ask for an issue; the runtime returns one.

[^messenger-re]: Messenger's send is an MQTT PUBLISH (QoS 1) on `/ls_req`, with a JSON body whose snowflake `epoch_id` and `otid` exceed `Number.MAX_SAFE_INTEGER` (so the saved script builds them with `BigInt`), a packet-id counter that lives on the in-page MQTT client, and binary framing via the page's `MqttProtocolCodec`. Sonnet 4.6 located the encoder via `search_js_source`, intercepted `MqttConnection.publish` to capture a live connection handle, decoded the LightSpeed envelope, and saved a script that builds the QoS-1 PUBLISH packet from scratch and dispatches it through the page's already-authenticated socket. The user never sees a frame or a packet ID.

---

## LIFT

**LIFT** means **Learn Interface From Traffic** — the analysis pass that turns a captured browser session into a saved strategy.

Most websites are a UI over a smaller set of HTTP or WebSocket calls. Klura reads the captured trace and binds each repeatable action to the underlying call:

```text
Before LIFT:                    After LIFT:
  click button                    POST /api/messages
  wait for UI update              {"text": "hello"}
  read confirmation               ~200ms, 0 LLM tokens
```

The saved strategy is a small JSON file under `~/.klura/skills/<platform>/`. A `fetch`-tier example:

```json
{
  "strategy": "fetch",
  "method": "POST",
  "baseUrl": "https://chat.so",
  "endpoint": "/api/conversations/v1/send",
  "prerequisites": [
    {
      "kind": "capability",
      "capability": "list_conversations",
      "args": { "name": "{{recipient}}" },
      "vars": { "thread_id": "conversations[0].id" }
    }
  ],
  "body": { "to": "{{thread_id}}", "text": "{{text}}" },
  "auth": { "type": "session-cookie" }
}
```

The runtime reads this file on every later run, runs the prerequisite first to look up `thread_id` from a sibling capability, fills the rest of the placeholders from the call args, and fires the request directly. See [REFERENCE.md](REFERENCE.md#fetch-schema) for the full schema and [REFERENCE.md#capability-prereq](REFERENCE.md#capability-prereq) for the prereq machinery.

Strategies fall into three tiers, picked by what the page actually requires:

| Tier | Strategy        | Used when                                         |
| ---- | --------------- | ------------------------------------------------- |
| T0   | `fetch`         | A templated HTTP or WebSocket call is enough      |
| T1   | `page-script`   | The page must run JS to build or sign the request |
| T2   | `recorded-path` | The safest available path is replaying the UI     |

If the page can't be lifted to `fetch` or `page-script` cleanly, klura still saves the flow as a `recorded-path`. That's slower than a direct call, but it still avoids re-planning the page from scratch on every run, and the same skill can graduate to a faster tier on a later session.

For the detailed mechanics, see [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/strategies.md](docs/strategies.md).

---

## Under the hood

Klura is built around a few simple ideas: keep the LLM in charge of the smart bits, refuse silent failures, and put real engineering into the parts of the loop that benefit from it. A handful of the things the runtime does underneath:

- **The runtime is plumbing; the LLM is the brains.** Klura offers tools, validates output, and stays out of the way. There's no workflow engine — capability composition (search a contact, then message them) happens in the agent's turn, where conversation context already lives. The runtime stays simple, and gets smarter with whatever model you bring.
- **Audits push the agent toward a clean API surface.** Discovery breaks flows into the smallest stand-alone capabilities — searching for a contact gets its own skill, separate from sending a message. So even if your first session only messaged Adam, klura quietly captured the contact-search step underneath. The next time you ask to message Bob, the agent composes the two without re-opening the page. Any ambiguity (two contacts named Bob) gets resolved by the LLM in the moment.
- **Loud failures, never silent acceptance.** Every saved strategy passes a structural audit before it hits disk; issues are batched into one rejection so the agent fixes everything in one retry.
- **Push streams, not just request/response.** Listener capabilities subscribe to WebSocket, SSE, and polled feeds. _Saved skills like `on_new_message` are first-class._
- **Sessions accrete a per-platform memory.** Every run contributes to a logbook under `~/.klura/workdir/<platform>/` — form observations, URL graph nodes, observed capabilities the agent spotted but didn't lift. The next session inlines a `platform_map` summary so the agent walks in already knowing the surface area. Run `start_session({graph: "map"})` to scout a platform up front before picking a real task. See [docs/logbook.md](docs/logbook.md).
- **Browser sessions persist between runs.** Cookies, login state, and storage stay warm across agent turns because the daemon outlives any single conversation. A site that asks for 2FA once a week stays logged in for days, not until the next restart.
- **Refreshes tokens before they expire.** Klura tracks each token's estimated lifetime and quietly refreshes a few minutes early, so long-running sessions don't fail-then-retry every time a CSRF rotates.
- **Picks the right network stack per request.** Some sites work fine over plain Node `fetch`; others sniff the TLS handshake and reject anything that isn't a real browser. Klura picks at execute time and falls over to the in-browser path automatically.
- **Skills get faster over time.** A skill saved as a slow click-replay today can be re-lifted to a direct HTTP call later — same skill ID, same args, less work. No re-discovery.
- **Locators survive DOM churn.** Recorded paths key on accessibility-tree names first, CSS as a fallback, so they don't break when a site rewrites its class names overnight.
- **Hands off to a human when the site needs one.** CAPTCHAs, 2FA, "confirm this is you" prompts, password walls — klura opens a live viewer of the in-progress browser session, you solve the blocker in your own hands, and the agent picks up from the same session. The viewer reaches you wherever you are: solve a 2FA prompt on your phone while the agent runs on your laptop. Passwords specifically resolve via three modes in order: remote viewer, user-supplied shell command, ask-in-chat as the last resort. See [docs/remote.md](docs/remote.md) and [docs/interruptions.md](docs/interruptions.md).

And when a site is genuinely hard — signed requests, binary WebSocket frames with rotating IDs, encoders hidden in minified bundles — there's a deeper toolkit:

- **Reads encoders the page hides from itself.** When a site signs requests inside a private function no one ever exports, klura sets a breakpoint at the moment the request fires and reads the signing code straight out of the live page.
- **Tells the agent it's making progress.** Failed probe attempts come back labelled — _getting closer_, _stuck_, _oscillating_ — so the agent stops looping blind and either keeps iterating or folds.
- **Forgiving when bytes don't round-trip.** When two payloads look the same in shape but differ in bytes (binary envelopes, JSON wrapped in JSON, gRPC-Web), klura matches on shape so the loop doesn't stall on cosmetic noise.

Deeper toolkit and plumbing in [docs/reverse-engineering.md](docs/reverse-engineering.md).

---

## How It Works

Every klura session belongs to one of three small state machines — **graphs** — picked at `start_session`. The graphs share a handful of phases (`drive`, `triage`, `lift`, `execute`) but compose them differently because they do different jobs.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="learn-graph-dark.gif">
    <img alt="Learn graph: drive the task in the browser, klura captures traffic, lift turns it into a saved strategy file." src="learn-graph-light.gif" width="900">
  </picture>
</p>

### Learn — the `discover` graph

The default mode, used whenever the user names a task and no saved strategy fits. Three phases:

- **Drive** — the agent uses MCP tools (`perform_action`, `read_page`, etc.) to complete the task in the live browser. Klura records every action and every network exchange underneath.
- **Triage** — when the agent calls `close_session`, klura asks it to read the captured traffic and propose a per-surface plan: which capability to lift, what the defense surface looks like (cookies, signed headers, dynamic IDs).
- **Lift** — the runtime and agent collaborate to turn the plan into a saved strategy. See [LIFT](#lift) above for the mechanics.

A clean lift terminates the session with a saved `fetch`, `page-script`, or `recorded-path` strategy under `~/.klura/skills/` (ordinary JSON files). The next time the user asks for the same capability, the saved strategy fires and the LLM stays out of the loop.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="execute-relearn-dark.gif">
    <img alt="Execute graph: saved strategy fires; on stale-shape failure klura re-drives the UI, captures the new call, and patches the strategy file in place." src="execute-relearn-light.gif" width="900">
  </picture>
</p>

### Execute + Relearn — the `execute` graph

The fast path. When a saved strategy matches the user's request, klura starts the session in `execute` and the runtime fires the strategy directly — no DOM, no LLM tokens, no agent turn at all. The runtime can be called programmatically too, bypassing the LLM completely.

On success, the session terminates clean. On failure, klura classifies the error:

- **Structural** (bad arg, auth missing, schema mismatch) terminates with `failed` and a structured error the agent can act on.
- **Stale strategy** (page changed, token rotated, response shape drifted) routes the session into `triage → lift` to repair the strategy in place. Same skill ID, refreshed mechanics, no rediscovery from scratch.

This is what "klura self-heals" means: the relearn branch is part of the graph, not a manual step.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="map-graph-dark.gif">
    <img alt="Map graph: scout a platform's surface area; the logbook accretes URL graph nodes and observed capabilities for the next session." src="map-graph-light.gif" width="900">
  </picture>
</p>

### Map — the `map` graph

A scout mode for platforms an operator wants to scope out before picking a real task. The agent walks the surface area — homepage, search, settings, account flows — and the runtime records what it sees in the **platform logbook**: form observations, URL graph nodes, and a list of `observed_capabilities` the agent spotted but didn't act on. No strategy is saved; mutating clicks gate behind an explicit consent checkpoint. The logbook persists across sessions and feeds the next `discover` run on the same platform.

---

## Use Cases

- Automate internal tools and legacy systems that don't expose usable APIs.
- Send messages or submit forms on web products that do not expose an API.
- Automate workflows inside SaaS tools that sit behind login, cookies, 2FA, and dynamic tokens.
- Give your agent a fast, reusable tool for any browser task it has done once before.

---

## Model variance & reliability

Klura depends on the model driving it. Models extract capabilities differently — some follow instructions tightly, others improvise; some handle signed/encoded flows, others struggle. Even the same model can produce different results across runs.

Klura's audits push the agent toward a clean, reusable API surface — separate capabilities for separate intents, no dynamic values baked into requests, strategies that generalize across inputs. The audits catch most structural issues and force retries when something's off, but while the system nudges; it doesn't fully control the model.

**Current snapshot:**

- **Sonnet 4.6 and newer** — strongest overall; often one-shots complex LIFTs and heavy reverse-engineering on signed-payload sites reliably.
- **GLM 4.7** — solid across most tasks.
- **GPT models** — not yet extensively tested.

Expect some variability on first runs. Retry when lifts fail — convergence is normal. Saved strategies replay deterministically — variance lives only in the discovery phase. When a saved strategy drifts (the page changes, a token rotates), klura surfaces the failure so the agent can re-lift, not silently retry.

---

## Is it legal? Will I get banned?

**Legal?** — Probably. **Banned?** — Please respect the platform's Terms of Service. If you do, and you're using the tool as intended: likely not.

Klura drives a real browser session you're already logged into and replays the same calls your own UI makes on your own account — generally on the authorized side of unauthorized-access laws (CFAA, UK Computer Misuse Act, StGB §202a–c). The runtime explicitly blocks endpoint enumeration, ID enumeration outside your scope, and input fuzzing — the behaviors that typically cross legal lines.

Platform ToS is a separate matter. Most major platforms restrict automation in their terms; whether your usage triggers enforcement depends on the platform and how you use the tool. Stealth fingerprinting makes the browser look like a real session (because it is), but it does not protect you from ToS violations.

Practical: read the policy of any site you automate, avoid doing at scale what you wouldn't reasonably do manually, and use klura's built-in policy tools to cap the strategy tier per platform.

See [docs/policy.md](docs/policy.md), [docs/trust.md](docs/trust.md), and [docs/principles.md#stealth-not-bot-evasion](docs/principles.md#stealth-not-bot-evasion).

---

## Configuration

Runtime settings live in `~/.klura/config.json`. You can edit it directly or ask your agent to use klura's `describe_config`, `configure`, and `restart_runtime` tools.

See [docs/run-lifecycle.md#settings-reference-kluraconfigjson](docs/run-lifecycle.md#settings-reference-kluraconfigjson) and [REFERENCE.md#configure](REFERENCE.md#configure).

---

## Docs

Start here:

- [ARCHITECTURE.md](ARCHITECTURE.md) - lifecycle, strategy tiers, secondary capabilities, and the docs map.
- [REFERENCE.md](REFERENCE.md) - strategy schemas and agent-facing reference details.
- [docs/discovery.md](docs/discovery.md) - how discovery works and what gets saved.
- [docs/reverse-engineering.md](docs/reverse-engineering.md) - the deeper toolkit for signed, encoded, or binary requests.
- [docs/principles.md](docs/principles.md) - the design principles behind the runtime.

---

## Built By

[Narek Mailian](mailto:hello@klura.ai) - freelance engineer. Klura is a standalone project.

Commercial licensing, strategic partnerships, or integration conversations: [hello@klura.ai](mailto:hello@klura.ai).

---

## Contributing

Before opening a PR, skim [docs/principles.md](docs/principles.md). Contributions that fit especially well: drivers, pool backends, listener transports, prereq methods, better validation, and focused benchmark or test sites.

Please avoid endpoint probing, ID enumeration outside the user's own scope, mainline bot-evasion features, platform-specific runtime heuristics, and brand names in agent-facing docs.

Contributors sign the **klura Individual Contributor License Agreement** before a PR can be merged. Full text: [CLA.md](CLA.md).

---

## License

Business Source License 1.1 (BUSL-1.1) with an Additional Use Grant. The Licensed Work converts to the Apache License, Version 2.0 on the Change Date specified in [LICENSE](LICENSE). See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the full terms.

You may copy, modify, and use the Licensed Work freely for non-production use. Production use is permitted under the Additional Use Grant, except that you may **not**:

- offer the Licensed Work, in whole or in part, to third parties as a hosted or managed service;
- expose the Licensed Work's functionality to third parties via an API, SDK, or other interface;
- use the Licensed Work to build, offer, or operate a Competing Service; or
- sublicense, sell, or resell access to the Licensed Work or its functionality.

For a commercial license that lifts these restrictions, contact [hello@klura.ai](mailto:hello@klura.ai).
