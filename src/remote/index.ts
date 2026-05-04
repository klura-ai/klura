import fs from 'fs';
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
  exposure: ViewerExposure;
  tunnel: Tunnel | null;
  timeoutTimer: NodeJS.Timeout;
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
): Promise<RemoteSession> {
  const existing = activeSessions.get(sessionId);
  if (existing) return existing;

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
  });

  let viewerUrl = viewer.localUrl;
  let tunnel: Tunnel | null = null;
  let exposure: ViewerExposure = 'local';

  if (cfg.mode === 'direct' && cfg.publicUrl) {
    viewerUrl = `${cfg.publicUrl.replace(/\/$/, '')}:${viewer.port}/?token=${viewer.token}&v=${viewer.integrity}`;
    exposure = 'public';
  } else if (cfg.mode === 'auto' || cfg.mode === 'cloudflared') {
    try {
      tunnel = await openTunnel(viewer.port);
      viewerUrl = `${tunnel.url.replace(/\/$/, '')}/?token=${viewer.token}&v=${viewer.integrity}`;
      exposure = 'public';
      console.error(`[remote] Tunnel open: ${tunnel.url}`);
    } catch (err) {
      if (cfg.mode === 'cloudflared') throw err;
      console.warn(`[remote] Tunnel failed, using localhost: ${String(err)}`);
    }
  }
  // cfg.mode === 'local' falls through with the localhost viewerUrl + exposure.

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
    exposure,
    tunnel,
    timeoutTimer,
  };

  activeSessions.set(sessionId, remote);
  console.error(`[remote] Session started: ${viewerUrl}`);
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
    return { sessionId, viewerUrl: remote.viewerUrl, exposure: remote.exposure };
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
