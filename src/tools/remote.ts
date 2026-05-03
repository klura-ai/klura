import { pool } from '../runtime-state';
import { startRemoteSession, stopRemoteSession, waitForRemoteDone } from '../remote';
import type { ViewerExposure } from '../remote';

/**
 * Plugin hook for callers that need to override `start_remote_session`'s
 * default behavior — typically autonomous runs (benchmark / CI) where no
 * human is available to complete the viewer flow. When a handler is
 * registered, `startRemote` invokes it instead of opening the viewer; the
 * handler can throw (the MCP layer surfaces the error to the agent) or
 * return a custom payload. Mirrors `setViewerOpener` in
 * `runtime/src/checkpoints/default-handlers.ts`.
 *
 * `exposure` is optional — when omitted, the verbatim-relay preface
 * defaults to the more cautious "public" wording (assume the URL leaves
 * the host). Local handlers should set `'local'` explicitly.
 */
export type StartRemoteHandler = (
  sessionId: string,
  options: { prompt?: string },
) => Promise<{ viewerUrl: string; exposure?: ViewerExposure }>;
let startRemoteHandler: StartRemoteHandler | null = null;
export function setStartRemoteHandler(fn: StartRemoteHandler | null): void {
  startRemoteHandler = fn;
}

interface StartRemoteResult {
  viewerUrl: string;
  _render_verbatim_block: { preface: string; content: string };
}

/**
 * Build the verbatim-relay preface for the viewer URL. The reachability
 * sentence varies by exposure: `'local'` URLs are reachable only from the
 * same host as klura (the user's machine); `'public'` URLs come from a
 * cloudflare tunnel or direct-mode public hostname and warrant a "don't
 * paste in a public channel" caution. Exposure is derived from the actual
 * outcome in `startRemoteSession` (which exposure path won, including
 * fallbacks like `auto` mode tunnel-failure → local), not the configured
 * `cfg.mode`.
 */
export function buildPreface(exposure: ViewerExposure): string {
  const reachability =
    exposure === 'local'
      ? "The URL is reachable because klura runs on the user's machine — the MCP server runs in the same process as their editor, so localhost is THEIR localhost."
      : 'The URL is a public tunnel — anyone with both the URL and the JWT can connect, so do not paste it into a public channel.';
  return (
    'Surface the URL below to the user. Paste it exactly as-is — it carries a JWT, and any retype / edit / abbreviation breaks the signature. ' +
    'Wrap it with newlines only. **Do NOT** put backticks, code fences, markdown link syntax, angle brackets, or quotation marks around it — the user copy-pastes the URL out of chat, and any wrapping characters get pasted along with it and break the request. ' +
    reachability +
    " Login happens inside the viewer's browser — klura uses its own playwright profile, not the user's regular Chrome, so existing cookies don't carry over."
  );
}

function decorate(viewerUrl: string, exposure: ViewerExposure): StartRemoteResult {
  return {
    viewerUrl,
    _render_verbatim_block: { preface: buildPreface(exposure), content: viewerUrl },
  };
}

export async function startRemote(
  sessionId: string,
  options: { prompt?: string } = {},
): Promise<StartRemoteResult> {
  if (startRemoteHandler) {
    const handled = await startRemoteHandler(sessionId, options);
    return decorate(handled.viewerUrl, handled.exposure ?? 'public');
  }
  const session = pool.getSession(sessionId);
  const driver = pool.driverFor(sessionId);
  const remote = await startRemoteSession(sessionId, driver, session, {
    prompt: options.prompt,
  });
  return decorate(remote.viewerUrl, remote.exposure);
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
