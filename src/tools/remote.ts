import { pool } from '../runtime-state';
import { startRemoteSession, stopRemoteSession, waitForRemoteDone } from '../remote';

/**
 * Plugin hook for callers that need to override `start_remote_session`'s
 * default behavior — typically autonomous runs (benchmark / CI) where no
 * human is available to complete the viewer flow. When a handler is
 * registered, `startRemote` invokes it instead of opening the viewer; the
 * handler can throw (the MCP layer surfaces the error to the agent) or
 * return a custom payload. Mirrors `setViewerOpener` in
 * `runtime/src/checkpoints/default-handlers.ts`.
 */
export type StartRemoteHandler = (
  sessionId: string,
  options: { prompt?: string },
) => Promise<{ viewerUrl: string }>;
let startRemoteHandler: StartRemoteHandler | null = null;
export function setStartRemoteHandler(fn: StartRemoteHandler | null): void {
  startRemoteHandler = fn;
}

const VIEWER_URL_HINT =
  "Render `viewerUrl` to the user verbatim — it carries a JWT and any retype/edit/abbreviation breaks the signature. The URL is reachable because klura runs on the user's machine. Login happens inside the viewer's browser, not the user's regular Chrome.";

export async function startRemote(
  sessionId: string,
  options: { prompt?: string } = {},
): Promise<{ viewerUrl: string; _hint: string }> {
  if (startRemoteHandler) {
    const handled = await startRemoteHandler(sessionId, options);
    return { ...handled, _hint: VIEWER_URL_HINT };
  }
  const session = pool.getSession(sessionId);
  const driver = pool.driverFor(sessionId);
  const remote = await startRemoteSession(sessionId, driver, session, {
    prompt: options.prompt,
  });
  return { viewerUrl: remote.viewerUrl, _hint: VIEWER_URL_HINT };
}

export async function stopRemote(sessionId: string): Promise<{ ok: true }> {
  await stopRemoteSession(sessionId);
  return { ok: true };
}

export async function waitForRemote(
  sessionId: string,
  options: { timeoutSeconds?: number } = {},
): Promise<{ done: boolean; reason?: string }> {
  const timeoutMs = (options.timeoutSeconds ?? 600) * 1000;
  return waitForRemoteDone(sessionId, timeoutMs);
}
