// WebSocket executor. Split out of ../execution.ts because the ws flow (open
// detection, frame assembly, ack wait, browser-vs-node dispatch) is its own
// surface — 600+ lines of logic that doesn't share much code with the HTTP
// executors beyond the cascade's ExecuteResult contract.
//
// Imports cycle with ../execution.ts for shared node-transport plumbing and
// helpers (TransportFailureError, recordNodeTransportFailure, buildNodeHeaders,
// interpolateVars, resolveHeaders, resolveVariables, resolveAbsoluteUrl,
// currentDeviceSessionOpts, resolveCapabilityPrereq, stringifyScope,
// fetchPrereqFromNode, read/writeJsEvalCache, runJsEvalPrereq). The cycle is
// safe because every cross-module call happens from inside a function body at
// runtime — nothing at module-load time reaches across.

import type { BrowserDriver } from '../drivers/interface';
import type { Session } from '../drivers/types/session';
import * as skills from '../strategies/skills';
import { TokenCache } from '../strategies/tokens';
import { resolveGenerated } from '../strategies/generators';
import { resolveSecrets } from '../identity/secrets';
import { wrapAgentExpression } from '../response/js-eval-wrapper';
import { truncateString } from '../response/response-size';
import { sendNodeWebSocketFrame } from '../drivers/node-ws-client';
import { currentDeviceSessionOpts, resolveCapabilityPrereq, stringifyScope } from '../execution';
import {
  TransportFailureError,
  recordNodeTransportFailure,
  resolveNodeCompatiblePrereqs,
} from './fetch-node';
import { runBrowserPrereqs, scanCachedPrereqs } from './fetch-browser';
import { runInlineRecordedSteps } from './step-runner';
import { interpolateVars, resolveHeaders } from './vars';
import type { ExecuteResult, WebSocketStrategy, RecordedPathStep, AnyPool } from './types';

// ---- WebSocket executors (protocol:"websocket") ----
//
// Two transports, shared dispatch. `executeWebSocketBrowser` opens a Playwright
// session, polls the page-side registry that `playwright.ts` installs at
// session creation, and calls `driver.sendWebSocketFrame`.
// `executeWebSocketNode` dials through the `ws` package directly, no browser.
// The dispatcher wraps them with the same (node → browser on
// TransportFailureError) retry the HTTP path uses, so fingerprint-sensitive
// sites that reject Node handshakes fall through to the safe path.

interface WsDispatchResult {
  result: ExecuteResult;
  transport: 'node' | 'browser';
}

// Default poll / ack budgets. Match the plan: 10s to catch the WS open, 5s to
// see an ack frame after the send.
const WS_OPEN_DEFAULT_TIMEOUT_MS = 10_000;
const WS_OPEN_POLL_INTERVAL_MS = 200;
const WS_OPEN_STEPS_RETRY_MS = 3_000;
const WS_ACK_DEFAULT_TIMEOUT_MS = 5_000;
const WS_ACK_POLL_INTERVAL_MS = 100;

export async function dispatchWebSocket(
  strategy: skills.Strategy & WebSocketStrategy,
  tier: 'fetch' | 'page-script',
  args: Record<string, unknown>,
  platform: string,
  capability: string,
  pool: AnyPool | null,
  tokenCache: TokenCache | null,
  depth: number,
  errors: string[],
  identity?: string,
): Promise<WsDispatchResult | null> {
  // Environment is implicit in tier: `fetch` dials the WS from Node (via the
  // `ws` package), `page-script` rides the page's existing connection through
  // the registry. Node dial can trip TLS / bot-check signatures that require
  // Chrome's TCP/SSL stack — fall back to the browser path on
  // TransportFailureError and demote the strategy to page-script on disk.
  if (tier === 'page-script') {
    if (!pool) {
      errors.push(`${tier}/ws: requires browser pool`);
      return null;
    }
    const result = await executeWebSocketBrowser(
      strategy,
      tier,
      args,
      platform,
      capability,
      pool,
      tokenCache,
      depth,
      identity,
    );
    return { result, transport: 'browser' };
  }

  // tier === 'fetch'
  try {
    const result = await executeWebSocketNode(
      strategy,
      tier,
      args,
      platform,
      capability,
      pool,
      tokenCache,
      depth,
      identity,
    );
    return { result, transport: 'node' };
  } catch (err) {
    if (err instanceof TransportFailureError) {
      if (!pool) {
        errors.push(`${tier}/ws/node: ${err.signal} and no pool for browser fallback`);
        return null;
      }
      recordNodeTransportFailure(platform, capability, 'fetch', 'websocket', err.signal);
      const result = await executeWebSocketBrowser(
        strategy,
        tier,
        args,
        platform,
        capability,
        pool,
        tokenCache,
        depth,
        identity,
      );
      return { result, transport: 'browser' };
    }
    throw err;
  }
}

// Resolve the frame source into ready-to-send bytes (or a text frame). Three
// sources are mutually exclusive at save time: `frame` string template,
// `generated.frame` Node-VM generator, and `frameFromPage` live-page JS. The
// first two are sync; `frameFromPage` calls into the driver and is async —
// hence the whole function is async. Callers without a live page (Node ws
// transport) pass `driver`/`session` as undefined; encountering frameFromPage
// there throws, which the save-time tier-gate should have prevented.
async function resolveWsFrame(
  strategy: WebSocketStrategy,
  args: Record<string, unknown>,
  driver: BrowserDriver | undefined,
  session: Session | undefined,
): Promise<
  | { ok: true; frame: string }
  | {
      ok: false;
      needsGeneration: { generators: Record<string, { instruction: string; examples?: string[] }> };
    }
> {
  if (strategy.frameFromPage) {
    if (!driver || !session) {
      throw new Error(
        'frameFromPage requires a live browser session — save-time tier-gate should have rejected this for Node transport',
      );
    }
    const ffp = strategy.frameFromPage;
    const interpolated = resolveSecrets(interpolateVars(ffp.expression, args));
    const wrapped = wrapAgentExpression(interpolated);
    const timeoutMs = ffp.timeout_ms ?? 5000;
    const result = await driver.evaluateExpression(session, wrapped, { timeoutMs });
    if (typeof result !== 'string') {
      throw new Error(
        `frameFromPage.expression returned ${typeof result}; expected a string (hex or base64 per strategy.frameFromPage.returns).`,
      );
    }
    const encoding = ffp.returns === 'base64' ? 'base64' : 'hex';
    const bytes = Buffer.from(result, encoding);
    // sendWebSocketFrame's binary path decodes `body` via atob(), so pass
    // base64 here regardless of the source encoding the expression declared.
    // The driver knows how to rebuild the Uint8Array from that.
    return { ok: true, frame: bytes.toString('base64') };
  }
  const generated = strategy.generated;
  const generatedFrame = generated?.frame;
  if (generatedFrame) {
    // `resolveGenerated` walks the whole generated map — to avoid minting
    // unrelated generators we carve out a one-entry map that resolves only the
    // `frame` generator. Other generators (if any) remain available for
    // template interpolation when they're referenced — but ws frames don't
    // typically use `{{__gen.X}}` inline, they put the whole payload in
    // `generated.frame.code`.
    const overrides = args._generated as Record<string, string> | undefined;
    const { resolved, needsLlm } = resolveGenerated({ frame: generatedFrame }, overrides, args);
    if ('frame' in needsLlm) {
      return { ok: false, needsGeneration: { generators: needsLlm } };
    }
    const out = resolved.frame;
    if (typeof out !== 'string') {
      throw new Error(`generated.frame resolved to non-string (${typeof out})`);
    }
    return { ok: true, frame: out };
  }
  if (typeof strategy.frame !== 'string') {
    // Save-time validator rejects this, but keep the runtime guard so a
    // misplaced patch doesn't crash with a cryptic reference error.
    throw new Error(
      'ws strategy is missing all of `frame`, `generated.frame`, and `frameFromPage` — save-time schema should have rejected this',
    );
  }
  return { ok: true, frame: resolveSecrets(interpolateVars(strategy.frame, args)) };
}

// Execute the recorded-step list that `wsOpen.steps` declares. Runs inline (no
// pause/blocker machinery) — these steps only exist to *trigger* a lazy
// WebSocket open, so on failure we just surface ws_not_open and let the cascade
// fall through to the next tier.
async function runWsOpenSteps(
  driver: BrowserDriver,
  session: Session,
  steps: RecordedPathStep[],
  args: Record<string, unknown>,
): Promise<void> {
  await runInlineRecordedSteps(driver, session, steps, args, 150);
}

async function executeWebSocketBrowser(
  strategy: WebSocketStrategy,
  _tier: 'fetch' | 'page-script',
  args: Record<string, unknown>,
  platform: string,
  capability: string,
  pool: AnyPool,
  tokenCache: TokenCache | null,
  depth: number,
  identity?: string,
): Promise<ExecuteResult> {
  const { opts: devOpts, device: resolvedDevice } = currentDeviceSessionOpts();
  const storageStatePath = skills.loadStorageStatePath(platform, identity);

  // Ready-page checkout (see docs/pool.md). Try to reuse an existing
  // warm/shared session whose page is already on `origin` AND whose target
  // WebSocket is OPEN. If found, skip navigation + WS handshake entirely —
  // drops a ~2.5s cold run to sub-200ms. Probe throws are treated as "not
  // ready" by the protocol.
  let session: Session | null = null;
  const wsOpenPre = strategy.wsOpen ?? 'navigate';
  const needsOrigin = wsOpenPre !== 'none';
  const originUrl = strategy.origin;
  if (needsOrigin && typeof originUrl === 'string' && originUrl.length > 0) {
    // Resolve wsUrl without args first — purely for the probe. The real resolve
    // (with genInputArgs including prereq tokens) happens below.
    const wsUrlForProbe = resolveSecrets(interpolateVars(strategy.wsUrl, args));
    const originForProbe = originUrl;
    if (pool.tryCheckoutReadySession) {
      session = await pool.tryCheckoutReadySession(
        platform,
        async (s, d) => {
          const r = await d.probePageReady(s, originForProbe, wsUrlForProbe);
          return r.page_on_url && r.ws_open === true;
        },
        identity,
      );
    }
  }
  if (!session) {
    session = await pool.createSession({
      platform,
      ...(identity ? { identity } : {}),
      ...devOpts,
      ...(storageStatePath ? { storageState: storageStatePath } : {}),
    });
  }
  session.device = resolvedDevice;
  const driver = pool.driverFor(session.id);

  try {
    // Prereqs (when present) run before we navigate to baseUrl, since many of
    // them navigate themselves (page-extract). On finish, `tokens` merges into
    // the args scope used by the frame template. Any tier that carries
    // non-empty prereqs runs this step; empty/absent prereqs short-circuit.
    const hasPrereqs =
      Array.isArray((strategy as { prerequisites?: unknown[] }).prerequisites) &&
      ((strategy as { prerequisites?: unknown[] }).prerequisites?.length ?? 0) > 0;
    const tokens: Record<string, string> = {};
    if (hasPrereqs) {
      const scanned = await scanCachedPrereqs(
        strategy.prerequisites,
        platform,
        args,
        pool,
        tokenCache,
        depth,
      );
      Object.assign(tokens, scanned.tokens);
      await runBrowserPrereqs(
        scanned.browserPrereqs,
        session,
        driver,
        platform,
        args,
        pool,
        tokenCache,
        tokens,
      );
    }

    // Generators run after prereqs so frame generators can reference
    // prereq-extracted values (same contract as HTTP fetch).
    const genInputArgs: Record<string, unknown> = { ...tokens, ...args };

    // Navigate to baseUrl so the page's own JS opens the WebSocket. Skip for
    // wsOpen:'none' — caller has arranged a warm session already on the target
    // page.
    //
    // baseUrl is required at save-time for any ws strategy that doesn't set
    // wsOpen:'none' (see strategies/validate.ts). The defensive guard below
    // catches pre-validator strategies already on disk or hand-edited JSON that
    // slipped through with a missing baseUrl — a clear error beats Playwright's
    // cryptic "url: expected string, got undefined".
    const wsOpen = strategy.wsOpen ?? 'navigate';
    // Borrowed sessions came through the ready-page checkout — the probe
    // already verified page_on_url + ws_open, so navigating again would be
    // wasted work (and would tear down the live WS).
    if (wsOpen !== 'none' && !session.borrowed) {
      const originForNav = strategy.origin;
      if (typeof originForNav !== 'string' || originForNav.length === 0) {
        return {
          status: 0,
          body: {
            error: 'ws_navigate_failed',
            detail:
              'strategy.origin is missing or empty. A ws strategy must set origin (the HTTP(S) URL to navigate to before polling the page for the live WebSocket) OR wsOpen:"none" (warm session already on the target page). Re-save the strategy with origin populated.',
            origin: originForNav,
          },
        };
      }
      try {
        await driver.navigate(session, originForNav, { waitUntil: 'domcontentloaded' });
      } catch (err) {
        return {
          status: 0,
          body: {
            error: 'ws_navigate_failed',
            detail: err instanceof Error ? err.message : String(err),
            origin: originForNav,
          },
        };
      }
    }

    // Poll the page's WebSocket registry until a live one matching wsUrl is
    // OPEN, or the wsOpenTimeoutMs budget expires.
    const resolvedWsUrl = resolveSecrets(interpolateVars(strategy.wsUrl, genInputArgs));
    const wsOpenBudget = strategy.wsOpenTimeoutMs ?? WS_OPEN_DEFAULT_TIMEOUT_MS;
    let opened = await waitForWsOpen(driver, session, resolvedWsUrl, wsOpenBudget);
    if (!opened && typeof wsOpen === 'object' && Array.isArray(wsOpen.steps)) {
      // Fallback: explicit steps that trigger the page's lazy WS open.
      try {
        await runWsOpenSteps(driver, session, wsOpen.steps, genInputArgs);
      } catch (err) {
        return {
          status: 0,
          body: {
            error: 'ws_open_steps_failed',
            detail: err instanceof Error ? err.message : String(err),
            hint: "wsOpen.steps threw before completing. Check that each step's selector still resolves against the current page.",
          },
        };
      }
      opened = await waitForWsOpen(driver, session, resolvedWsUrl, WS_OPEN_STEPS_RETRY_MS);
    }
    if (!opened) {
      return {
        status: 0,
        body: {
          error: 'ws_not_open',
          wsUrl: resolvedWsUrl,
          detail:
            typeof wsOpen === 'object'
              ? 'Executed wsOpen.steps, still no OPEN WebSocket matching wsUrl. Inspect the page manually and update the wsUrl prefix or the steps.'
              : 'No live WebSocket matching wsUrl after navigating to baseUrl. Add `wsOpen: {steps: [...]}` (recorded-path-shaped) describing how to trigger the site\'s lazy ws open (e.g. click "Open chat").',
        },
      };
    }

    // Resolve the outgoing frame.
    const frameResolution = await resolveWsFrame(strategy, genInputArgs, driver, session);
    if (!frameResolution.ok) {
      return {
        status: 0,
        body: {
          needs_generation: true,
          platform,
          capability,
          generators_needed: frameResolution.needsGeneration.generators,
          retry_with: 'Provide values via args._generated and re-call execute',
        },
      };
    }

    // Snapshot the ring-buffer length so the ack wait only considers frames
    // received AFTER the send completes. Driver's wsFrames is a bounded ring
    // buffer populated by the session-creation hook.
    const preSendFrameCount = (session.wsFrames ?? []).length;

    const sendResult = await driver.sendWebSocketFrame(
      session,
      resolvedWsUrl,
      frameResolution.frame,
      {
        encoding: strategy.frameEncoding ?? 'text',
      },
    );
    if (!sendResult.ok) {
      return {
        status: 0,
        body: {
          error: 'ws_send_failed',
          detail: sendResult.error ?? 'unknown send error',
          wsUrl: resolvedWsUrl,
        },
      };
    }

    // Ack wait is opt-in (fire-and-forget when absent). Poll the ring buffer
    // for received frames (direction !== 'sent') whose payload contains the
    // substring.
    if (strategy.ackMatch) {
      const ackBudget = strategy.ackTimeoutMs ?? WS_ACK_DEFAULT_TIMEOUT_MS;
      const ack = await waitForAck(
        driver,
        session,
        preSendFrameCount,
        strategy.ackMatch,
        ackBudget,
      );
      if (!ack.matched) {
        return {
          status: 0,
          body: {
            error: 'ack_timeout',
            sent: true,
            wsUrl: resolvedWsUrl,
            ackMatch: strategy.ackMatch,
            ackTimeoutMs: ackBudget,
            detail: `Sent the frame, but no received frame contained "${strategy.ackMatch}" within ${ackBudget}ms.`,
          },
        };
      }
      return {
        status: 200,
        body: {
          ok: true,
          sent: true,
          wsUrl: resolvedWsUrl,
          ack: { payload: truncateString(ack.payload, 2048) },
        },
      };
    }

    return {
      status: 200,
      body: { ok: true, sent: true, wsUrl: resolvedWsUrl },
    };
  } finally {
    await pool.endDrive(session.id);
  }
}

async function executeWebSocketNode(
  strategy: WebSocketStrategy,
  tier: 'fetch' | 'page-script',
  args: Record<string, unknown>,
  platform: string,
  capability: string,
  pool: AnyPool | null,
  tokenCache: TokenCache | null,
  depth: number,
  _identity?: string,
): Promise<ExecuteResult> {
  // Node-transport WebSocket dial doesn't load storage state — cookies on a
  // ws:// handshake travel via the `Cookie` header, which the strategy must
  // explicitly declare. Identity is accepted for signature parity with the
  // browser path but is unused here; node ws frames don't write back to the
  // jar either. (When/if Node-transport ws starts reading cookies from the
  // jar, that read site needs `identity` threaded too.)
  // Prereq resolution: Node-shaped prereqs only. browser / js-eval prereqs
  // force a demotion to browser transport via TransportFailureError, mirroring
  // executeFetchNode's rule.
  const tokens: Record<string, string> =
    tier === 'fetch'
      ? await resolveNodeCompatiblePrereqs(
          strategy.prerequisites,
          args,
          platform,
          tokenCache,
          pool,
          depth,
          resolveCapabilityPrereq,
          stringifyScope,
        )
      : {};

  const genInputArgs: Record<string, unknown> = { ...tokens, ...args };
  const frameResolution = await resolveWsFrame(strategy, genInputArgs, undefined, undefined);
  if (!frameResolution.ok) {
    return {
      status: 0,
      body: {
        needs_generation: true,
        platform,
        capability,
        generators_needed: frameResolution.needsGeneration.generators,
        retry_with: 'Provide values via args._generated and re-call execute',
      },
    };
  }

  const resolvedWsUrl = resolveSecrets(interpolateVars(strategy.wsUrl, genInputArgs));
  const resolvedHeaders = resolveHeaders(strategy.wsHeaders, genInputArgs);

  // Binary frames arrive over the wire as base64 — decode before send.
  const framePayload: string | Uint8Array =
    strategy.frameEncoding === 'binary'
      ? Uint8Array.from(Buffer.from(frameResolution.frame, 'base64'))
      : frameResolution.frame;

  const result = await sendNodeWebSocketFrame(resolvedWsUrl, resolvedHeaders, framePayload, {
    ackMatch: strategy.ackMatch,
    ackTimeoutMs: strategy.ackTimeoutMs ?? WS_ACK_DEFAULT_TIMEOUT_MS,
    openTimeoutMs: 5000,
  });

  if (!result.ok) {
    // Classify handshake failures as transport-shaped so the dispatcher retries
    // in browser (captures the fingerprint-block case automatically, same as
    // HTTP-Node).
    if (
      result.error.startsWith('ws_construct_failed') ||
      result.error.startsWith('ws_open_timeout')
    ) {
      throw new TransportFailureError('ws_handshake_failed', result.error);
    }
    if (result.error.startsWith('ws_error') || result.error.startsWith('ws_closed_before_ack')) {
      throw new TransportFailureError('ws_handshake_failed', result.error);
    }
    if (result.error.startsWith('ack_timeout')) {
      return {
        status: 0,
        body: {
          error: 'ack_timeout',
          sent: true,
          wsUrl: resolvedWsUrl,
          ackMatch: strategy.ackMatch,
          ackTimeoutMs: strategy.ackTimeoutMs ?? WS_ACK_DEFAULT_TIMEOUT_MS,
          detail: result.error,
        },
      };
    }
    return {
      status: 0,
      body: { error: 'ws_send_failed', wsUrl: resolvedWsUrl, detail: result.error },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      sent: true,
      wsUrl: resolvedWsUrl,
      ...(result.ackPayload ? { ack: { payload: truncateString(result.ackPayload, 2048) } } : {}),
    },
  };
}

async function waitForWsOpen(
  driver: BrowserDriver,
  session: Session,
  urlPrefix: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const open = await driver.hasOpenWebSocket(session, urlPrefix);
      if (open) return true;
    } catch {
      // Drivers without a registry return false from the default impl — a
      // thrown exception here is a deeper bug, but swallow so the poll loop
      // doesn't crash the execute path.
    }
    await delay(WS_OPEN_POLL_INTERVAL_MS);
  }
  return false;
}

async function waitForAck(
  driver: BrowserDriver,
  session: Session,
  sinceIndex: number,
  substring: string,
  timeoutMs: number,
): Promise<{ matched: true; payload: string } | { matched: false }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = await driver.getInterceptedWebSocketFrames(session);
    for (let i = sinceIndex; i < frames.length; i++) {
      const frame = frames[i];
      if (!frame) continue;
      // Only consider received frames — an echo of our own send would otherwise
      // match on substring for platforms that mirror user input back onto the
      // wire.
      const dir = (frame as { direction?: string }).direction;
      if (dir === 'sent') continue;
      const payload = typeof frame.payload === 'string' ? frame.payload : '';
      if (payload.includes(substring)) {
        return { matched: true, payload };
      }
    }
    await delay(WS_ACK_POLL_INTERVAL_MS);
  }
  return { matched: false };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
