# Configuration

Every user-facing klura setting lives in `~/.klura/config.json`. The file is created on first run with the defaults below; edit it directly, drive it from the agent (see [via the MCP](#via-the-mcp) below), or pass overrides programmatically to `createPool()`. The schema is defined and validated in `runtime/src/config/handler.ts`.

Per-platform data (identities, secrets, device profile, policy) lives in sibling files under `~/.klura/`, not in `config.json`. See [identities-and-device.md](identities-and-device.md) and [policy.md](policy.md).

## Via the MCP

The MCP server exposes the config as four agent-facing tools, so the user can change settings in plaintext without opening a JSON file:

| Tool | What it does |
| --- | --- |
| `describe_config` | Lists every tunable field with type, valid values, default, and whether a runtime restart is needed. The agent should call this before `configure` so it never hallucinates a path. |
| `get_config` | Returns the current merged `DaemonConfig`. |
| `configure` | Sets one field by dot-path: `{path: "pool.driver", value: "playwright-stealth"}`. Returns `{config, changed, runtime_restart_required, suggested_user_prompt}`. |
| `restart_runtime` | Restarts the daemon so boot-time fields (`runtime.listen`, `runtime.idleTimeout`) take effect. Refuses while sessions are active unless `force: true`. |

In practice the user can say "show me the browser," "turn on the warm pool," or "use the stealth driver" and the agent will pick the right field via `describe_config` and call `configure` for them. When `runtime_restart_required` comes back true, the agent surfaces `suggested_user_prompt` and waits for confirmation before restarting.

The same tools are reachable on the CLI as `klura configure <path> <value>`, `klura get-config`, etc., but the MCP path is the expected one.

## Field reference

Source of truth: `CONFIG_FIELDS` in `runtime/src/config/handler.ts`. `describe_config` renders the same list at runtime.

### `runtime.*` — daemon boot

Read once at daemon start; changing them needs `restart_runtime`.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `runtime.idleTimeout` | number, 0–86400 | `1800` | Seconds the daemon stays alive with no active sessions before self-exit. `0` disables. |
| `runtime.listen` | string | `"unix"` | `"unix"` → `~/.klura/klura.sock`; `"host:port"` → TCP socket. |

### `pool.*` — browser sessions

See [pool.md](pool.md) for the warm-pool / ready-page checkout protocol and [drivers.md](drivers.md) for driver selection.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `pool.channel` | `auto` \| `chrome` \| `chromium` | `auto` | Chromium channel. `chrome` uses the installed Google Chrome (real TLS); `chromium` uses Playwright's bundled binary; `auto` tries chrome first. |
| `pool.headful` | boolean | `false` | Show a visible browser window. Debug-only. |
| `pool.driver` | string | (unset) | Driver. `playwright` (default), `klura-driver-playwright-stealth`, or a BYO path / package name. |
| `pool.idleTimeout` | number, 0–86400 | `300` | Seconds a session may sit idle before the pool tears it down. |
| `pool.maxSessions` | number, 1–128 | `8` | Maximum concurrent browser sessions. |
| `pool.warm.enabled` | boolean | `false` | Keep browser backends alive across klura sessions (~2-3s warm vs ~10-20s cold). |
| `pool.warm.max_contexts` | number, 0–64 | `3` | Max idle warm backends. `0` = unlimited (bounded by TTL only). |
| `pool.warm.idle_ttl_seconds` | number, 0–86400 | `600` | Seconds a warm backend may sit idle before eviction. |

### `remote.*` — viewer tunnel

See [remote.md](remote.md) for the viewer protocol.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `remote.mode` | `auto` \| `direct` \| `cloudflared` \| `local` | `auto` | How the viewer URL is exposed. `auto` tries cloudflared then falls back to localhost. |
| `remote.publicUrl` | string | (unset) | Externally-reachable host for `remote.mode = "direct"` (e.g. a reverse proxy). |
| `remote.timeout` | number, 10–86400 | `600` | Seconds a remote viewer session may stay open. |
| `remote.prompt` | string | (unset) | Default prompt shown above the viewer. |

### `defaults.*` — session defaults

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `defaults.lift_mode` | `explicit_learn` \| `skip` | `explicit_learn` | Fallback when `start_session` doesn't supply one. `explicit_learn` asks the user before spending LIFT rounds; `skip` disables the LIFT handoff. For autonomous runs without a human, register a checkpoint handler that auto-resolves prompts to `continue` — see `field-reports/lib/checkpoint-stubs.js`. |

### `graduation.*`

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `graduation.observation_threshold` | number, 2–50 | `3` | Consecutive recorded-path runs with the same POST shape before synthesizing a fetch strategy. See [strategies.md](strategies.md). |

### `drive.*` / `triage.*` / `lift.*` — per-phase round budgets

Each non-terminal session phase carries a configurable round budget. When the agent crosses the budget while in that phase, the runtime hard-blocks tools outside the phase's `allowedToolsWhenExhausted` set — see `runtime/src/session-phase/phases/<phase>.ts` for the per-phase narrowed sets, and [session-phases.md](session-phases.md) for the full state machine.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `drive.max_rounds` | number, 0–10 000 | `0` (unlimited) | Round budget for the drive phase (agent driving the UI). Default unlimited because the agent's primary work happens here. When >0, only `end_drive` admits once the budget is hit. |
| `triage.max_rounds` | number, 0–10 000 | `10` | Round budget for the triage phase (agent inventories captures and writes a plan). Default tight — if the agent can't write a plan in 10 rounds with captures already in hand, they should submit what they have and let LIFT correct it. When the budget is hit, only `submit_triage_plan` and `save_strategy` admit (every save passes user_confirmation). |
| `lift.max_rounds` | number, 0–10 000 | `0` (unlimited) | Round budget for the lift phase (agent executes the RE playbook). Default unlimited because the agent's primary work happens here. When >0, only `save_strategy` and `submit_triage_plan` admit once the budget is hit. |

Convention: `max_rounds: 0` means unlimited — the middleware skips the soft-block check entirely. Counter resets on every transition INTO a phase (including self-loops on `plan_submitted`, the symmetric re-plan path).

### `secrets.*` — password-manager resolvers

Map of `scheme → shell command template` for `{{secret:scheme:ref}}` interpolation. Managed via the dedicated `add_secret_resolver` / `remove_secret_resolver` tools (which validate scheme + shell metacharacters); the `configure` tool treats this branch as opaque. See [credentials.md](credentials.md).

## Programmatic overrides

Embedding klura without the daemon? `createPool()` reads `config.json` and accepts an options object that overrides any pool field per call:

```ts
import { createPool } from 'klura';

const pool = await createPool({
  headful: true,
  channel: 'chrome',
  warm: { enabled: true, maxContexts: 5, idleTtlSeconds: 900 },
});
```

`new Pool({...})` accepts the same shape directly.

## Environment variables

`config.json` owns user preferences. Env vars are reserved for things config genuinely can't own — bootstrap paths, cloud-injected secrets, and opt-in diagnostics:

| Var | Purpose |
| --- | --- |
| `KLURA_HOME` | Base dir for `config.json`, skills, storage-state, logs. Defaults to `~/.klura`. Use to run multiple isolated daemons side-by-side. |
| `KLURA_DAEMON_ADDR` | CLI-side override for which daemon socket / TCP address `bin/klura.js` dials. Bypasses auto-start. |
| `KLURA_REMOTE_SECRET` | Signing secret for remote-viewer JWTs. Auto-generated and cached in `~/.klura/remote-secret.key` if unset. Set explicitly for cloud / multi-tenant deployments. |
| `KLURA_VERBOSE` | `1` surfaces `[pool]` trace lines on the daemon's stderr. Diagnostic only. |
| `KLURA_DUMP_LOGS_TO` | Directory path; on `close_session`, dumps the full intercepted-request list and captured DOM. Diagnostic only. |

Any setting that applies to every run belongs in `config.json` (or its sibling files), not in a `KLURA_*` var.
