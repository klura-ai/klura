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
  if (active > 0 && !args.force) {
    return {
      ok: false,
      active_sessions: active,
      message: `Refusing to restart: ${active} active session(s). Close them first, or pass force=true to restart anyway (open sessions will be killed).`,
    };
  }
  // Respond, then exit after the HTTP layer flushes. Next klura call respawns
  // the daemon via the normal auto-start path in bin/klura.js.
  setImmediate(() => {
    console.log('[runtime] restart requested — exiting for respawn');
    process.exit(0);
  });
  return {
    ok: true,
    active_sessions: active,
    message: 'Runtime is restarting. Re-issue your next tool call to auto-start a fresh runtime.',
  };
}
