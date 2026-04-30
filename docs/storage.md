# What gets stored — and where

Skills must be **portable** — shareable between users, publishable to a registry. User-specific data must be kept separate.

## Skill storage

Two parallel trees: `~/.klura/skills/` for saved strategies (clean, copy-pasteable, publishable to ClawHub) and `~/.klura/workdir/` for per-platform scratch state that may carry PII (session captures, discovery artifacts). Splitting them keeps the skills dir safe to ship as-is.

```
~/.klura/skills/facebook/
  fetch/
    send_message.json         ← fetch strategy (optional prereqs)
    on_new_message.json       ← listener spec (WebSocket/MQTT)
    list_chats.json
  scripts/
    send_message.json         ← page-script strategy (JS builds and fires request per call)
  paths/
    send_message.json         ← recorded-path (browser steps, fallback)
    login.json                ← login capability (recorded-path with {{placeholders}})
  policy.json                 ← per-platform USER policy (max_strategy_tier, forbid_capabilities, per-capability caps). Agent has NO write path.

~/.klura/workdir/facebook/    ← per-platform working dir — see logbook.md
  logbook.json                ← per-platform cross-session rollup (counters, lift_attempts, observed_capabilities, strategy_events)
  health.json                 ← per-platform strategy health (status/healthy/degraded/broken, per-protocol node transport counters)
  artifacts/
    <capability>.json         ← per-capability discovery artifact (agent-owned). Carries resume_pointers, verified_expressions, tool_call_trace.
    <capability>.bin          ← optional binary bytes cache
  sessions/<sid>/             ← raw session archives
  bundles/<sha>.js            ← content-addressable JS bundle archive
  derived/*.json              ← cached cross-session computed signals
```

A capability may have entries in multiple subdirectories — the runtime tries strategies in priority order: `fetch` > `page-script` > `recorded-path`. Prerequisites are a property of a `fetch` or `page-script` strategy (optional `prerequisites` array on the saved JSON), not a separate tier.

`fetch` ranks above `page-script` because its default transport is Node (100–300 ms), so it escapes the browser on the LIFT metric while `page-script` always pays for a page load. Each strategy JSON stamps `schema_version` and `tier_stamp: { tier, stampedAt }` at save time; the stamp is what powers `klura lift-rate` aggregation without re-reading any platform.

## Configuration and user data

```
~/.klura/
  config.json                 ← daemon settings, pool config, secret resolvers
  identities.json             ← per-platform PII (email, username) — auto-fills {{placeholders}}
  device.json                 ← this daemon's device profile (viewport, UA, touch, mobile, scale)
  remote-secret.key           ← HS256 signing secret for remote-viewer JWTs (mode 0600)
  storage-state/
    facebook.json             ← cookies + localStorage for facebook
    chat-app.json
  graduation/
    <platform>/<capability>.json   ← graduation observation state
```

Storage state is scoped per-platform within the daemon. The daemon is one device, so there is no per-device suffix in the filename. Multi-device setups run multiple daemons with different `KLURA_HOME` values — see [identities-and-device.md](identities-and-device.md).

## The portability rule

**If it's true for all users of a platform → `~/.klura/skills/<platform>/`** (sharable) **If it's specific to one user → `~/.klura/identities.json`, `~/.klura/storage-state/`** (never shared)

Sharing a skill is an explicit action — copy the skill directory, review it for leaked data, publish. It's not automatic. The save-time provenance guard (see [discovery.md](discovery.md#passive-lookup-accumulator--provenance-contract)) prevents the most common leak — opaque IDs from the discovery-time entity baked into the strategy — from ever reaching the on-disk skill in the first place.
