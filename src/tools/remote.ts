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
 * the host). Local handlers should set `'local'` explicitly. `shortUrl`
 * and `autoOpened` are optional metadata that shape the preface;
 * handlers without short-URL or auto-open support omit them.
 */
export type StartRemoteHandler = (
  sessionId: string,
  options: { prompt?: string },
) => Promise<{
  viewerUrl: string;
  exposure?: ViewerExposure;
  shortUrl?: string;
  autoOpened?: boolean;
}>;
let startRemoteHandler: StartRemoteHandler | null = null;
export function setStartRemoteHandler(fn: StartRemoteHandler | null): void {
  startRemoteHandler = fn;
}

interface StartRemoteResult {
  viewerUrl: string;
  shortUrl?: string;
  autoOpened?: boolean;
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
 *
 * `autoOpened` reshapes the lead — when the runtime already spawned the
 * URL into the user's default browser, the agent should tell the user to
 * look for the popup tab rather than copy-paste. The URL is still surfaced
 * as a fallback (cross-device handoff, blocked popup, multi-monitor
 * misses).
 *
 * `isShort` notes that the relayed URL is the short single-use redirect
 * (16-char base32, 60s TTL); the verbatim contract is more forgiving for
 * a short URL but the no-wrapping-characters rule still applies because
 * the user pastes it the same way.
 */
export function buildPreface(
  exposure: ViewerExposure,
  opts: { autoOpened?: boolean; isShort?: boolean } = {},
): string {
  const reachability =
    exposure === 'local'
      ? "The URL is reachable because klura runs on the user's machine — the MCP server runs in the same process as their editor, so localhost is THEIR localhost."
      : 'The URL is a public tunnel — anyone with both the URL and the JWT can connect, so do not paste it into a public channel.';
  const lead = opts.autoOpened
    ? "A browser tab should already have opened on the user's machine — the runtime spawned the OS URL handler. Tell the user to look for the popup; if they don't see it (popup blocker, headless terminal, wrong monitor), surface the URL below as a fallback. "
    : 'Surface the URL below to the user. ';
  const integrityClause = opts.isShort
    ? 'It is a short single-use redirect (≈16 chars, 60s TTL) — paste it exactly as-is and the user clicks once. '
    : 'Paste it exactly as-is — it carries a JWT, and any retype / edit / abbreviation breaks the signature. ';
  return (
    lead +
    integrityClause +
    'Wrap it with newlines only. **Do NOT** put backticks, code fences, markdown link syntax, angle brackets, or quotation marks around it — the user copy-pastes the URL out of chat, and any wrapping characters get pasted along with it and break the request. ' +
    reachability +
    " Login happens inside the viewer's browser — klura uses its own playwright profile, not the user's regular Chrome, so existing cookies don't carry over."
  );
}

function decorate(
  viewerUrl: string,
  exposure: ViewerExposure,
  opts: { shortUrl?: string; autoOpened?: boolean } = {},
): StartRemoteResult {
  // Prefer the short URL in the verbatim block when the runtime minted
  // one — the LLM relay channel is the single biggest source of URL
  // corruption, and a 16-char redirect token sails through where a
  // 250-400-char JWT URL does not. The full JWT URL is still surfaced
  // on the result object for callers that want it.
  const relayUrl = opts.shortUrl ?? viewerUrl;
  const isShort = !!opts.shortUrl;
  return {
    viewerUrl,
    ...(opts.shortUrl ? { shortUrl: opts.shortUrl } : {}),
    ...(opts.autoOpened ? { autoOpened: true } : {}),
    _render_verbatim_block: {
      preface: buildPreface(exposure, { autoOpened: opts.autoOpened, isShort }),
      content: relayUrl,
    },
  };
}

export async function startRemote(
  sessionId: string,
  options: { prompt?: string } = {},
): Promise<StartRemoteResult> {
  if (startRemoteHandler) {
    const handled = await startRemoteHandler(sessionId, options);
    return decorate(handled.viewerUrl, handled.exposure ?? 'public', {
      shortUrl: handled.shortUrl,
      autoOpened: handled.autoOpened,
    });
  }
  const session = pool.getSession(sessionId);
  const driver = pool.driverFor(sessionId);
  const remote = await startRemoteSession(sessionId, driver, session, {
    prompt: options.prompt,
  });
  return decorate(remote.viewerUrl, remote.exposure, {
    shortUrl: remote.shortUrl ?? undefined,
    autoOpened: remote.autoOpened,
  });
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
