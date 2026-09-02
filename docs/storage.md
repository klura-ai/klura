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
  config.json                 ← daemon settings, pool config, secret resolvers (mode 0600)
  identities.json             ← per-platform PII; auto-fills {{placeholders}} (mode 0600)
  device.json                 ← this daemon's device profile (viewport, UA, touch, mobile, scale)
  remote-secret.key           ← HS256 signing secret for remote-viewer JWTs (mode 0600)
  storage-state/
    facebook.json             ← cookies + localStorage for facebook
    chat-app.json
  graduation/
    <platform>/<capability>.json   ← graduation observation state
```

Storage state is scoped per-platform within the daemon. The daemon is one device, so there is no per-device suffix in the filename. Multi-device setups run multiple daemons with different `KLURA_HOME` values — see [identities-and-device.md](identities-and-device.md).

Runtime writes to `config.json` and `identities.json` use an owner-only temporary file followed by an atomic rename. Initial creation and every update therefore leave both files at mode `0600`.

## Locking and shared-state mutation

Klura state is mutated by more than one process — the daemon, CLI invocations, tests, occasionally a second daemon attempt after a crash. Two rules keep that safe, both implemented in `runtime/src/utils/owner-file-lock.ts`:

**One lock primitive.** Every cross-process lock is an _owner file_: created with `O_EXCL`, containing `{schema_version, pid, process_nonce, process_marker, created_at_ms}`. There is exactly one staleness policy:

- The owner pid is dead (`ESRCH`) → stale. `EPERM` means the pid exists → live.
- The owner pid equals this process but the nonce differs (pid reuse across a restart) → stale.
- The owner verifiably does not hold its process-marker file open (checked via `/proc` on linux, `lsof` on darwin) → stale. Markers live in `<lock dir>/.process-owners/<pid>-<nonce>.lease` and are held open by the owning process, so a reused pid cannot impersonate a dead holder.
- A malformed or empty lock file fails closed until its mtime is 30s old, then becomes recoverable.
- Recovery is serialized through a `<lock>.recover` guard so concurrent reclaimers admit exactly one critical section.
- Release verifies the on-disk owner record before unlinking — a process never removes a lock it no longer owns.

Consumers: the per-capability mutation lock (`strategy-candidates/.mutation-locks/`), consumer `session.lock` / `resume.lock` / `run-operations.lock` / `activation.lock` / `daemon-start.lock`, the daemon singleton `daemon.lock`, and every `<file>.lock` guard below. Each call site maps live contention to its own error type (`capability_mutation_locked`, `session_in_use`, `operation_in_progress`, `activation_lock`, …) via `onLocked`.

**Serialized read-modify-write for shared JSON.** Files with multiple writers — per-platform `workdir/<platform>/health.json` and `logbook.json`, `user-data/<platform>/token-cache.json`, `skills/<platform>/tokens.json`, `graduation/<platform>/<capability>.json`, `storage-state/<platform>.json`, `config.json`, `identities.json` — mutate only through `updateJsonFile` (or a `withOwnerFileLock`-wrapped load→save cycle), which takes `<file>.lock`, applies the mutation, and writes via a random-suffix temporary file plus atomic rename. Lost updates and torn files are structurally impossible; best-effort surfaces (health, graduation, cookie merges) drop the update on contention rather than failing the surrounding execute.

**Daemon singleton.** `startDaemon()` acquires `~/.klura/daemon.lock` before anything else — before consumer-run startup recovery and before touching the socket — and holds it until shutdown. A second daemon over the same `KLURA_HOME` refuses to start instead of appending `interrupted` frames into journals a live daemon is writing.

**Lock order** (deadlock avoidance): graduation lock → capability mutation lock → per-platform logbook/health/storage-state locks. Code holding a lower lock never acquires a higher one.

## The portability rule

**If it's true for all users of a platform → `~/.klura/skills/<platform>/`** (sharable) **If it's specific to one user → `~/.klura/identities.json`, `~/.klura/storage-state/`** (never shared)

Sharing a skill is an explicit action — copy the skill directory, review it for leaked data, publish. It's not automatic. The save-time provenance guard (see [discovery.md](discovery.md#passive-lookup-accumulator--provenance-contract)) prevents the most common leak — opaque IDs from the discovery-time entity baked into the strategy — from ever reaching the on-disk skill in the first place.
