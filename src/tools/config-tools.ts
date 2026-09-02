import { pool } from '../runtime-state';
import {
  loadConfig,
  configureOne as configureOneHandler,
  describeConfig as describeConfigHandler,
  type ConfigureResult,
  type ConfigSchemaDescription,
  type DaemonConfig,
} from '../config/handler';
import { asNonEmptyBoundedString } from '../validators';
import { isStandaloneDaemon } from '../runtime-state/process-role';

export function getConfig(): DaemonConfig {
  return loadConfig();
}

export function describeConfigTool(): ConfigSchemaDescription {
  return describeConfigHandler();
}

export function configureSetting(args: { path: string; value: unknown }): ConfigureResult {
  const dotPath = asNonEmptyBoundedString(args.path, 'path', 120);
  return configureOneHandler(dotPath, args.value);
}

export function restartRuntime(args: { force?: boolean } = {}): {
  ok: boolean;
  active_sessions: number;
  message: string;
} {
  const active = pool.activeSessions;
  // Exiting the process only self-heals when a separate CLI client re-dials and
  // auto-respawns the daemon. When the runtime is embedded in the caller's
  // process (klura chat / execute --agent / an MCP host over stdio), the pool,
  // the tools, and the caller's session all live here — exiting would kill the
  // session with nothing to respawn it. Refuse and point at the real remedy.
  if (!isStandaloneDaemon()) {
    return {
      ok: false,
      active_sessions: active,
      message:
        'restart_runtime is only available when klura runs as a standalone background daemon. ' +
        'This runtime is embedded in the current process, so exiting it would terminate your session with nothing to auto-respawn it. ' +
        'Boot-time config (runtime.listen, runtime.idleTimeout) takes effect the next time this process starts — exit and relaunch it; do not call restart_runtime here.',
    };
  }
  if (active > 0 && !args.force) {
    return {
      ok: false,
      active_sessions: active,
      message:
        `Refusing to restart: ${active} active session(s). ` +
        'To proceed, either (a) end the relevant drive sessions first via end_drive — note this discards any in-progress drive work, so confirm with the user before doing so, or (b) pass force=true to restart anyway (open sessions will be killed). ' +
        'Note: refreshing a corrupted remote viewer URL does NOT require a restart — call stop_remote_session then start_remote_session, which keeps the drive alive.',
    };
  }
  // Respond, then exit after the HTTP layer flushes. Next klura call respawns
  // the daemon via the normal auto-start path in bin/klura.js. Drain the pool
  // first so spawned browsers — including connect-mode Chrome, which holds the
  // profile's singleton lock — are killed rather than orphaned; a leaked Chrome
  // wedges the respawned daemon's next connect-spawn ("failed to attach").
  setImmediate(() => {
    console.error('[runtime] restart requested — exiting for respawn');
    // Drain, then exit regardless of the drain's outcome so the respawn can
    // proceed. void — the setImmediate callback itself stays synchronous.
    void pool
      .shutdown()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
  return {
    ok: true,
    active_sessions: active,
    message: 'Runtime is restarting. Re-issue your next tool call to auto-start a fresh runtime.',
  };
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tools/types';
import { getSecret } from '../public-api';

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.getConfig,
    phasePolicy: { category: 'universal' },
    description:
      'Read the current klura runtime config (the merged ~/.klura/config.json, with defaults filled in). Returns the full DaemonConfig object — pool settings, driver, warm-pool, remote viewer, runtime boot fields, etc.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => getConfig(),
  },

  {
    name: TOOL_NAMES.describeConfig,
    phasePolicy: { category: 'universal' },
    description:
      'List every tunable config field with its type, valid values, default, and whether it needs a runtime restart to take effect. Call this before `configure` so you know the exact dot-path and what values are allowed — it prevents hallucinated field names. Returns `{fields: [{path, type, enum?, range?, default, description, needsRestart}], current}`.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => describeConfigTool(),
  },

  {
    name: TOOL_NAMES.configure,
    phasePolicy: { category: 'universal' },
    description:
      'Set a single klura config field by dot-path. Example: `{path: "pool.driver", value: "playwright-stealth"}` to enable the stealth driver, or `{path: "pool.headful", value: true}` to show a visible browser window. Call `describe_config` first if you are unsure of the path or valid values. Returns `{config, changed, runtime_restart_required, runtime_restart_fields, suggested_user_prompt}`. When `runtime_restart_required` is true, relay `suggested_user_prompt` to the user as an assistant text turn and wait for their yes/no before calling `restart_runtime`.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Dot-path of the config field, e.g. "pool.driver" or "pool.warm.enabled".',
        },
        value: {
          description:
            'New value. String, number, or boolean depending on the field type (see describe_config).',
        },
      },
      required: ['path', 'value'],
    },
    handler: (args: any) => configureSetting({ path: args.path, value: args.value }),
  },

  {
    name: TOOL_NAMES.restartRuntime,
    phasePolicy: { category: 'universal' },
    description:
      'Restart the klura runtime so boot-time config (runtime.listen, runtime.idleTimeout) takes effect. Only works when klura runs as a standalone background daemon — refuses when the runtime is embedded in the caller (klura chat / execute --agent / an MCP host), since exiting would kill your session. Also refuses if any sessions are active unless `force: true` (which will kill them). After a daemon restart, the runtime auto-respawns on your next tool call — expect a ~1s delay.',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Kill any active sessions and restart anyway.' },
      },
    },
    handler: (args: any) => restartRuntime({ force: args.force }),
  },

  {
    name: TOOL_NAMES.getSecret,
    phasePolicy: { category: 'universal' },
    description:
      'Fetch a secret from a configured shell-command resolver (macOS keychain, 1password CLI, pass, etc). Use during discovery when you hit a login form and the user has a password manager resolver configured — fetch the password with `get_secret(scheme, ref)` and type it into the form instead of escalating to the remote viewer. The response value is the raw secret; pass it directly to `perform_action({action: "type", selector: "input[type=password]", value})` and **never log, persist, or echo it**. If no resolver is configured for `scheme`, this throws with a setup hint — fall back to `start_remote_session` in that case. Call `get_config` first to see the `secrets` map (scheme → command template) so you know which schemes are configured; ask the user in chat once per platform per session for the `ref` if you don\'t already know it (never guess — wrong guesses are a silent exfil risk).',
    inputSchema: {
      type: 'object',
      properties: {
        scheme: {
          type: 'string',
          description:
            'Resolver name as configured via `klura secret add <scheme>`. Common schemes: "keychain" (macOS), "op" (1password CLI), "pass" (passwordstore).',
        },
        ref: {
          type: 'string',
          description:
            'Per-scheme key. Keychain: the service name (e.g. "klura-<platform>"). 1password: a vault/item path (e.g. "<platform>/password"). Ask the user in chat if unclear — do not guess.',
        },
      },
      required: ['scheme', 'ref'],
    },
    handler: (args: any) => getSecret(args.scheme, args.ref),
  },
];
