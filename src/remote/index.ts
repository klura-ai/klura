import fs from 'fs';
import { spawn } from 'child_process';
import { openTunnel, type Tunnel } from '../tunnel';
import type { BrowserDriver } from '../drivers/interface';
import type { Session } from '../drivers/types/session';
import { startViewer, stopViewer } from './viewer';
import { registerRemoteBackend } from './backend';
import { loadConfig, type RemoteConfig } from '../config/handler';

export type { RemoteConfig };

function hostDoneFile(sessionId: string): string {
  // /tmp (not os.tmpdir) so it matches the SKILL.md polling path on every OS.
  // On macOS os.tmpdir() is /var/folders/…/T which the LLM's bash `while [ ! -f
  // /tmp/... ]` wouldn't see. /tmp is the conventional cross-platform path.
  return `/tmp/klura-remote-done-${sessionId}`;
}

/**
 * Where the viewer URL is reachable from. Used to shape the verbatim-relay
 * preface — local URLs need a "klura runs on the user's machine" framing
 * (otherwise agents claim the user can't reach localhost), public URLs need
 * a "don't paste in a public channel" caution.
 *
 * Computed from the actual outcome (which exposure path won), not the
 * configured mode — `auto` mode falls back to local when the tunnel fails,
 * and a missing `publicUrl` in `direct` mode also falls back to local.
 */
export type ViewerExposure = 'local' | 'public';

interface RemoteSession {
  sessionId: string;
  viewerUrl: string;
  /**
   * Short single-use redirect URL (when `remote.short_url` is enabled).
   * Returned to the agent in place of `viewerUrl` so the LLM relay only
   * carries 16-ish chars instead of a 250-400-char JWT URL. Falls back
   * to the long URL when short_url is disabled.
   */
  shortUrl: string | null;
  exposure: ViewerExposure;
  /**
   * Whether the runtime tried to open the URL in the user's default
   * browser at session start. The agent's preface mentions this so the
   * user knows to look for a popup tab rather than wait on a paste.
   */
  autoOpened: boolean;
  tunnel: Tunnel | null;
  timeoutTimer: NodeJS.Timeout;
  /**
   * Base host string used to build `shortUrl` (`<baseHost>/r/<token>`).
   * Captured at session-mint time so a refresh can rebuild the short
   * URL without re-deriving the host from tunnel / config state.
   */
  baseHost: string;
  /** Re-mint the 16-char relay token + reset the 60s TTL. Returns the
   *  new token, or null when this session was started without a short
   *  URL (`remote.short_url: false`). The full JWT URL stays unchanged. */
  refreshShortToken: () => string | null;
  /** True when the active short link is past its 60s TTL. */
  shortTokenStale: () => boolean;
}

/**
 * Best-effort: open the URL in the user's default browser via the OS
 * URL handler. Bypasses the LLM relay channel — no chance of single-char
 * corruption between mint and browser-load. Detached + stdio:'ignore' so
 * the runtime doesn't keep the child alive or block on its output.
 *
 * Returns true on successful spawn (not on browser load — we can't
 * observe that from here). Logs and returns false on spawn error.
 */
function openInBrowser(url: string): boolean {
  try {
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (platform === 'win32') {
      // `start` is a cmd builtin, not an exe; the empty "" is the window
      // title required when start receives a quoted argument.
      cmd = 'cmd';
      args = ['/c', 'start', '""', url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      console.warn(`[remote] auto-open failed: ${String(err)}`);
    });
    child.unref();
    return true;
  } catch (err) {
    console.warn(`[remote] auto-open failed: ${String(err)}`);
    return false;
  }
}

function shouldAutoOpen(mode: RemoteConfig['auto_open'], exposure: ViewerExposure): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return exposure === 'local';
}

const activeSessions = new Map<string, RemoteSession>();

function loadRemoteConfig(): RemoteConfig {
  return loadConfig().remote;
}

export async function startRemoteSession(
  sessionId: string,
  driver: BrowserDriver,
  session: Session,
  config?: Partial<RemoteConfig>,
  options: { refresh?: boolean } = {},
): Promise<RemoteSession> {
  const existing = activeSessions.get(sessionId);
  if (existing) {
    // Default behavior: idempotent — return the cached session. The full
    // JWT URL stays valid for the JWT's hour-long TTL even after the
    // 60s short-link relay token expires; on cache hit, rotate just the
    // short token in-place when it's stale so a second call after a
    // missed click yields a fresh /r/<token>. Callers that want a full
    // session refresh (rare — recovering from chat-renderer URL
    // corruption, tunnel teardown) pass `refresh: true` and get a full
    // teardown + remint. `stop_remote_session` then `start_remote_session`
    // is the public equivalent.
    if (!options.refresh) {
      if (existing.shortTokenStale()) {
        const next = existing.refreshShortToken();
        if (next) existing.shortUrl = `${existing.baseHost}/r/${next}`;
      }
      return existing;
    }
    await stopRemoteSession(sessionId);
  }

  const cfg = { ...loadRemoteConfig(), ...config };

  // Clear any stale done file from a previous session so the bash wait loop /
  // waitForRemoteDone doesn't false-positive.
  const doneFile = hostDoneFile(sessionId);
  try {
    fs.unlinkSync(doneFile);
  } catch {
    /* nothing to clear */
  }

  const viewer = await startViewer(sessionId, driver, session, {
    prompt: cfg.prompt,
    enableShortUrl: cfg.short_url,
  });

  let viewerUrl = viewer.localUrl;
  let baseHost = `http://localhost:${viewer.port}`;
  let tunnel: Tunnel | null = null;
  let exposure: ViewerExposure = 'local';

  if (cfg.mode === 'direct' && cfg.publicUrl) {
    baseHost = `${cfg.publicUrl.replace(/\/$/, '')}:${viewer.port}`;
    viewerUrl = `${baseHost}/?token=${viewer.token}&v=${viewer.integrity}`;
    exposure = 'public';
  } else if (cfg.mode === 'auto' || cfg.mode === 'cloudflared') {
    try {
      tunnel = await openTunnel(viewer.port);
      baseHost = tunnel.url.replace(/\/$/, '');
      viewerUrl = `${baseHost}/?token=${viewer.token}&v=${viewer.integrity}`;
      exposure = 'public';
      console.error(`[remote] Tunnel open: ${tunnel.url}`);
    } catch (err) {
      if (cfg.mode === 'cloudflared') throw err;
      console.warn(`[remote] Tunnel failed, using localhost: ${String(err)}`);
    }
  }
  // cfg.mode === 'local' falls through with the localhost viewerUrl + exposure.

  const shortUrl = viewer.shortToken ? `${baseHost}/r/${viewer.shortToken}` : null;

  const autoOpened = shouldAutoOpen(cfg.auto_open, exposure)
    ? openInBrowser(shortUrl ?? viewerUrl)
    : false;

  const timeoutTimer = setTimeout(
    () => {
      console.error(`[remote] Session ${sessionId} timed out`);
      void stopRemoteSession(sessionId);
    },
    (cfg.timeout ?? 600) * 1000,
  );
  timeoutTimer.unref();

  const remote: RemoteSession = {
    sessionId,
    viewerUrl,
    shortUrl,
    exposure,
    autoOpened,
    tunnel,
    timeoutTimer,
    baseHost,
    refreshShortToken: viewer.refreshShortToken,
    shortTokenStale: viewer.shortTokenStale,
  };

  activeSessions.set(sessionId, remote);
  const shortNote = shortUrl ? ` (short: ${shortUrl})` : '';
  const openedNote = autoOpened ? ' [auto-opened]' : '';
  console.error(`[remote] Session started: ${viewerUrl}${shortNote}${openedNote}`);
  return remote;
}

export async function stopRemoteSession(sessionId: string): Promise<void> {
  const remote = activeSessions.get(sessionId);
  if (!remote) return;

  clearTimeout(remote.timeoutTimer);
  try {
    fs.unlinkSync(hostDoneFile(sessionId));
  } catch {
    /* not present */
  }

  await stopViewer(sessionId);

  if (remote.tunnel) remote.tunnel.kill();
  activeSessions.delete(sessionId);
  console.error(`[remote] Session stopped: ${sessionId}`);
}

/**
 * Block until the user clicks Done in the remote viewer (or until timeout).
 * Polls the host-side done file written by the viewer's Done handler. Returns
 * { done: true } on success, { done: false, reason: 'timeout' } if the user
 * didn't click Done before the timeout.
 *
 * This is the MCP-tool equivalent of the bash wait loop in SKILL.md — use it
 * when the LLM doesn't have bash available (e.g. benchmark agent context).
 */
// Register the built-in "local" backend (HTTP+WS viewer with optional tunnel).
// Adapter: the backend interface is handle-oriented; internally we key by
// sessionId against the `activeSessions` map. Third-party backends may carry
// richer state via `handle.backendState`.
registerRemoteBackend({
  name: 'local',
  async start(sessionId, driver, session, opts) {
    const remote = await startRemoteSession(sessionId, driver, session, opts);
    return {
      sessionId,
      viewerUrl: remote.viewerUrl,
      exposure: remote.exposure,
      ...(remote.shortUrl ? { shortUrl: remote.shortUrl } : {}),
      ...(remote.autoOpened ? { autoOpened: true } : {}),
    };
  },
  async waitForDone(handle, timeoutMs) {
    return waitForRemoteDone(handle.sessionId, timeoutMs);
  },
  async stop(handle) {
    await stopRemoteSession(handle.sessionId);
  },
});

export function waitForRemoteDone(
  sessionId: string,
  timeoutMs = 600_000,
): Promise<{ done: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const doneFile = hostDoneFile(sessionId);
    let settled = false;

    const done = (result: { done: boolean; reason?: string }): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(result);
    };

    // ref() so the event loop stays alive even if no other handles are active
    // (e.g. MCP server stdin is paused between requests). Without ref(), Node
    // may not schedule the interval callbacks and the poll silently stalls.
    const poll = setInterval(() => {
      try {
        fs.accessSync(doneFile, fs.constants.F_OK);
        done({ done: true });
      } catch {
        // file not yet present — keep polling
      }
    }, 1000).ref();

    const timer = setTimeout(() => {
      done({ done: false, reason: 'timeout' });
    }, timeoutMs).ref();
  });
}
