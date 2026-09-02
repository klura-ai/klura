import http from 'http';
import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { loadConfig } from './config/handler';
import type { NetworkLogOptions } from './drivers/types/network';
import { KLURA_DIR } from './paths';
import { markStandaloneDaemon } from './runtime-state/process-role';
import { errorText } from './utils/error-text';
import { canonicalJson, type JsonValueV1 } from './public/contracts/json';
import { releaseOwnerFileLock, tryAcquireOwnerFileLock } from './utils/owner-file-lock';
import { DAEMON_START_ERROR_FILE } from './consumer/daemon-client';
const PID_FILE = path.join(KLURA_DIR, 'daemon.pid');
const SOCKET_PATH = path.join(KLURA_DIR, 'klura.sock');
const DAEMON_LOCK = path.join(KLURA_DIR, 'daemon.lock');

// A unix socket address is a fixed-size `sockaddr_un.sun_path` — 104 bytes on
// darwin/BSD, 108 on Linux — and `listen()` answers EINVAL for anything longer.
// The limit is on the BYTE length of the path, so a home containing non-ASCII
// characters runs out sooner than its character count suggests. One byte is
// reserved for the NUL terminator.
const SUN_PATH_MAX_BYTES = process.platform === 'linux' ? 108 : 104;

/** True when binding this path would exceed the platform's sun_path limit. */
function unixSocketPathTooLong(socketPath: string): boolean {
  return Buffer.byteLength(socketPath, 'utf8') >= SUN_PATH_MAX_BYTES;
}
/** IPC message kind a freshly-forked daemon sends its parent once its server
 *  is listening. `ensureDaemon` resolves on this message. */
const DAEMON_READY_MESSAGE_KIND = 'ready';

interface KluraModule {
  startSession: (
    url: string,
    opts: {
      platform?: string;
      identity?: string;
      capability?: string;
      args?: Record<string, unknown>;
      policy?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  performAction: (
    id: string,
    action: string,
    selector: string,
    value?: string,
    opts?: { returnTree?: boolean; replace?: boolean; page?: string },
  ) => Promise<unknown>;
  getNetworkLog: (id: string, opts?: NetworkLogOptions) => Promise<unknown>;
  getScreenshot: (id: string) => Promise<unknown>;
  getAttribute: (id: string, selector: string, attr?: string) => Promise<unknown>;
  findInPage: (id: string, needle: string, limit?: number) => Promise<unknown>;
  endDrive: (
    id: string,
    opts: { platform?: string; auditToken?: string; auditAnswers?: Record<string, unknown> },
  ) => Promise<unknown>;
  saveStrategy: (
    platform: string,
    capability: string,
    data: unknown,
    changelog?: string,
    sessionId?: string,
  ) => Promise<unknown>;
  execute: (
    platform: string,
    capability: string,
    args?: Record<string, unknown>,
    opts?: { full?: boolean; identity?: string },
  ) => Promise<unknown>;
  listPlatformSkills: () => unknown;
  liftRate: () => unknown;
  resumeExecution: (sessionId: string) => Promise<unknown>;
  patchStep: (
    platform: string,
    capability: string,
    strategyType: string,
    stepId: string,
    patch: Record<string, unknown>,
  ) => unknown;
  markHealed: (platform: string, capability: string, strategyType: string) => void;
  getStrategyEvents: (platform: string, capability?: string, limit?: number) => unknown;
  startRemote: (id: string, opts?: { prompt?: string }) => Promise<unknown>;
  stopRemote: (id: string) => Promise<unknown>;
  startListener: (
    platform: string,
    capability: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;
  stopListener: (listenerId: string) => Promise<unknown>;
  getEvents: (since?: number) => unknown;
  status: () => { activeSessions: number };
  _pool: {
    activeSessions: number;
    busy: () => boolean;
    shutdown: () => Promise<void>;
    /** Busy→idle notification for edges with no accompanying RPC (warm-
     *  sweeper eviction). Optional so stub factories stay minimal. */
    onBecameIdle?: (cb: () => void) => () => void;
  };
}

interface ConsumerDaemonRoutes {
  invoke(
    method: string | undefined,
    route: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  followItems?: (body: unknown, signal?: AbortSignal) => AsyncIterable<unknown>;
  activeRunCount?: () => number;
}

type ConsumerDaemonInvoker = (
  method: string | undefined,
  route: string,
  body: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

type ConsumerItemStreamInvoker = (body: unknown, signal?: AbortSignal) => AsyncIterable<unknown>;

const CONSUMER_ROUTES = new Set([
  'POST /consumer/search',
  'POST /consumer/show',
  'POST /consumer/install',
  'POST /consumer/installed',
  'POST /consumer/remove',
  'POST /consumer/doctor',
  'POST /consumer/session/clear',
  'POST /consumer/login/open',
  'POST /consumer/login/complete',
  'POST /consumer/call',
  'POST /consumer/run',
  'POST /consumer/runs/resume',
  'POST /consumer/runs/wait',
  'POST /consumer/runs/wait-state',
  'POST /consumer/runs/cancel',
  'POST /consumer/runs/show',
  'POST /consumer/runs/list',
  'POST /consumer/runs/items',
  'POST /consumer/runs/discard',
]);

interface RequestParams {
  url?: string;
  platform?: string;
  sessionId?: string;
  action?: string;
  selector?: string;
  value?: string;
  /** Sub-page handle for `perform_action` ("main" or "popup-N"). See
   *  klura://reference#popups. */
  page?: string;
  /** Account name on the platform — multi-account scoping. Default-when-
   *  omitted (or `"default"`) routes through historical platform-only paths.
   *  See klura://reference#identities. */
  identity?: string;
  capability?: string;
  policy?: Record<string, unknown>;
  data?: unknown;
  args?: Record<string, unknown>;
  listenerId?: string;
  since?: number;
  prompt?: string;
  changelog?: string;
  strategyType?: string;
  stepId?: string;
  patch?: Record<string, unknown>;
  limit?: number;
  needle?: string;
  auditToken?: string;
  auditAnswers?: Record<string, unknown>;
}

/** Parse a "host:port" listen string. Supports "0.0.0.0:9400", ":9400",
 *  "localhost:9400". */
export function parseListen(listen: string): { host: string; port: number } {
  const idx = listen.lastIndexOf(':');
  if (idx === -1) return { host: '0.0.0.0', port: parseInt(listen, 10) };
  return { host: listen.slice(0, idx) || '0.0.0.0', port: parseInt(listen.slice(idx + 1), 10) };
}

export { loadConfig };

export function startDaemon(): void {
  markStandaloneDaemon();
  const config = loadConfig();
  fs.mkdirSync(KLURA_DIR, { recursive: true });

  // Singleton exclusion for this KLURA_HOME. Held for the daemon's lifetime so
  // a second daemon can never run startup recovery against journals a live
  // daemon is appending to, or unlink the live daemon's socket. A lock left by
  // a crashed daemon is recovered through the owner-file staleness policy.
  const acquiredDaemonLock = tryAcquireOwnerFileLock(DAEMON_LOCK);
  if (acquiredDaemonLock === null) {
    throw new Error(
      `another klura daemon already owns ${KLURA_DIR} — refusing to start a second instance`,
    );
  }
  const daemonLock = acquiredDaemonLock;

  recoverConsumerRunsBeforeIpc();

  // A deep KLURA_HOME pushes the socket past sun_path and every bind answers
  // EINVAL, which takes down all consumer tooling for that home. Loopback TCP
  // has no such limit and the client already discovers it through
  // `daemon.addr`, so fall back rather than fail. Announced on stderr because
  // the transport differs from what the config asked for.
  const unixRequested = config.runtime.listen === 'unix';
  const socketTooLong = unixRequested && unixSocketPathTooLong(SOCKET_PATH);
  if (socketTooLong) {
    console.error(
      `[klura] unix socket path is ${Buffer.byteLength(SOCKET_PATH, 'utf8')} bytes, over this ` +
        `platform's ${SUN_PATH_MAX_BYTES}-byte limit (${SOCKET_PATH}) — listening on loopback TCP ` +
        `instead. Set runtime.listen to a host:port to choose the address yourself, or use a ` +
        `shorter KLURA_HOME.`,
    );
  }
  const useUnix = unixRequested && !socketTooLong;
  if (useUnix) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      /* Socket may not exist */
    }
  }

  let factory: KluraModule | null = null;
  let consumer: ConsumerDaemonRoutes | null = null;
  const getFactory = (): KluraModule => {
    if (factory !== null) return factory;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    factory = require('./index') as KluraModule;
    // The pool's busy→idle edge from a warm-sweeper eviction arrives with no
    // RPC, so no `touch()` re-arms an idle-shutdown timer that fired while
    // warm slots kept `busy()` true. Re-arm from the pool's own notification;
    // the timer still measures from `lastActivity`, so a genuinely idle
    // daemon shuts down immediately after the eviction.
    factory._pool.onBecameIdle?.(armIdleShutdown);
    return factory;
  };
  const activeFactorySessions = (): number => factory?._pool.activeSessions ?? 0;
  // Pool.busy() is the single idle/teardown authority — it covers live
  // sessions AND warm slots, which activeSessions alone does not. A daemon
  // idle shutdown while the warm pool is live would kill warm contexts the
  // pool is deliberately keeping. A never-loaded factory owns no browser
  // state, so it reads as not busy.
  const factoryPoolBusy = (): boolean => factory?._pool.busy() ?? false;
  const activeConsumerRuns = (): number => consumer?.activeRunCount?.() ?? 0;
  const getConsumer = (): ConsumerDaemonRoutes => {
    if (consumer !== null) return consumer;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('./consumer/daemon-routes') as {
      ConsumerDaemonRoutesV1: new (
        services?: unknown,
        runInspection?: unknown,
        onActiveRunChange?: () => void,
      ) => ConsumerDaemonRoutes;
    };
    consumer = new loaded.ConsumerDaemonRoutesV1(undefined, undefined, touch);
    return consumer;
  };
  let lastActivity = Date.now();
  let activeConsumerRequests = 0;
  let activeConsumerStreams = 0;
  const startTime = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function touch(): void {
    lastActivity = Date.now();
    armIdleShutdown();
  }

  function armIdleShutdown(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    if (config.runtime.idleTimeout === 0) return;
    const timeoutMs = config.runtime.idleTimeout * 1_000;
    const delayMs = Math.max(0, timeoutMs - (Date.now() - lastActivity));
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (
        factoryPoolBusy() ||
        activeConsumerRequests > 0 ||
        activeConsumerStreams > 0 ||
        activeConsumerRuns() > 0
      ) {
        return;
      }
      console.log('Idle timeout reached, shutting down');
      void shutdown();
    }, delayMs);
  }

  const invokeConsumer: ConsumerDaemonInvoker = async (method, route, body, signal) => {
    activeConsumerRequests += 1;
    try {
      return await getConsumer().invoke(method, route, body, signal);
    } finally {
      activeConsumerRequests -= 1;
      touch();
    }
  };
  const streamConsumerItems: ConsumerItemStreamInvoker = (body, signal) => {
    const consumerRoutes = getConsumer();
    if (consumerRoutes.followItems === undefined) {
      throw new Error('consumer item stream is unavailable');
    }
    const events = consumerRoutes.followItems(body, signal);
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator {
        activeConsumerStreams += 1;
        try {
          for await (const event of events) yield event;
        } finally {
          activeConsumerStreams -= 1;
          touch();
        }
      },
    };
  };

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    touch();
    handleRequest(
      req,
      res,
      getFactory,
      invokeConsumer,
      streamConsumerItems,
      activeFactorySessions,
      startTime,
      lastActivity,
      shutdown,
    ).catch((err: unknown) => {
      // Defence in depth: handleRequest catches its own routing errors, so this
      // only fires if the request/response plumbing itself rejects (e.g. a
      // client that resets the socket mid-body). Log and keep serving — a
      // single dropped request must not take the daemon and its live sessions
      // down with it.
      console.error(`[klura] request plumbing error: ${errorText(err)}`);
    });
  });

  // A daemon that cannot bind has nothing to serve. Exiting non-zero here lets
  // the caller fail immediately with this reason on stderr; the
  // `uncaughtException` handler below would otherwise log it and leave the
  // process alive but never ready, turning a stateable error into a timeout.
  server.once('error', (err: unknown) => {
    const reason = `daemon could not listen: ${errorText(err)}`;
    console.error(`[klura] ${reason}`);
    // Leave the reason where whoever forked this daemon can read it. Their
    // stdio is not connected to ours — a detached daemon has no terminal — so
    // without this the caller sees only a generic timeout.
    try {
      fs.writeFileSync(path.join(KLURA_DIR, DAEMON_START_ERROR_FILE), reason);
    } catch {
      /* best effort — the console line above is the fallback */
    }
    try {
      releaseOwnerFileLock(daemonLock);
    } catch {
      /* exiting anyway */
    }
    process.exit(1);
  });

  if (useUnix) {
    server.listen(SOCKET_PATH, () => {
      fs.writeFileSync(PID_FILE, String(process.pid));
      announceDaemonReady();
      console.log(`klura daemon started (pid ${process.pid})`);
      console.log(`  socket: ${SOCKET_PATH}`);
      console.log(`  idle timeout: ${config.runtime.idleTimeout}s`);
    });
  } else {
    // Port 0 on the sun_path fallback: the config asked for a unix socket and
    // named no port, so the kernel picks a free one and `daemon.addr` carries
    // the resolved address the client dials.
    const { host, port } = socketTooLong
      ? { host: '127.0.0.1', port: 0 }
      : parseListen(config.runtime.listen);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      fs.writeFileSync(PID_FILE, String(process.pid));
      // Write the listen address so sendToDaemon can find it
      fs.writeFileSync(path.join(KLURA_DIR, 'daemon.addr'), `${host}:${boundPort}`);
      announceDaemonReady();
      console.log(`klura daemon started (pid ${process.pid})`);
      console.log(`  listen: ${host}:${boundPort}`);
      console.log(`  idle timeout: ${config.runtime.idleTimeout}s`);
    });
  }

  armIdleShutdown();

  async function shutdown(): Promise<void> {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    console.log('klura daemon shutting down...');
    try {
      await factory?._pool.shutdown();
    } catch {
      // Best effort
    }
    server.close();
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(path.join(KLURA_DIR, 'daemon.addr'));
    } catch {
      /* ignore */
    }
    releaseOwnerFileLock(daemonLock);
    // Short tick so any in-flight responses flush, then exit.
    setTimeout(() => process.exit(0), 50).unref();
  }

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // A long-lived daemon holds live browser sessions no one else can recover.
  // A stray async rejection or thrown callback must not terminate the process
  // and drop every session; log it and keep serving. (Fatal V8 conditions such
  // as heap exhaustion still abort — those are unrecoverable by design.)
  process.on('unhandledRejection', (reason: unknown) => {
    console.error(`[klura] unhandledRejection: ${errorText(reason)}`);
  });
  process.on('uncaughtException', (err: unknown) => {
    console.error(`[klura] uncaughtException: ${errorText(err)}`);
  });
}

function announceDaemonReady(): void {
  if (typeof process.send === 'function') process.send({ kind: DAEMON_READY_MESSAGE_KIND });
}

function recoverConsumerRunsBeforeIpc(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const consumerRecovery = require('./consumer/scrape/startup-recovery') as {
    interruptUnfinishedRunsAtStartup: (home: string) => unknown;
  };
  consumerRecovery.interruptUnfinishedRunsAtStartup(KLURA_DIR);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  getFactory: () => KluraModule,
  invokeConsumer: ConsumerDaemonInvoker,
  streamConsumerItems: ConsumerItemStreamInvoker,
  activeFactorySessions: () => number,
  startTime: number,
  lastActivity: number,
  shutdown: () => Promise<void>,
): Promise<void> {
  const json = (data: unknown): void => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const error = (statusCode: number, msg: string): void => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  };

  try {
    // Drain inside the try so a client that resets the socket mid-body surfaces
    // as a handled 500 rather than an unhandled rejection off the request
    // stream's async iterator.
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const params: RequestParams = body ? (JSON.parse(body) as RequestParams) : {};
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/status') {
      json({
        uptime: Math.floor((Date.now() - startTime) / 1000),
        activeSessions: activeFactorySessions(),
        idleSince: Math.floor((Date.now() - lastActivity) / 1000),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/shutdown') {
      json({ ok: true });
      void shutdown();
      return;
    }

    if (
      await handleConsumerRequest(
        req,
        res,
        url.pathname,
        params,
        invokeConsumer,
        streamConsumerItems,
      )
    )
      return;

    const klura = getFactory();
    if (req.method === 'POST' && url.pathname === '/session/start') {
      json(
        await klura.startSession(params.url ?? '', {
          platform: params.platform,
          ...(params.identity !== undefined ? { identity: params.identity } : {}),
          ...(params.capability !== undefined ? { capability: params.capability } : {}),
          ...(params.args !== undefined ? { args: params.args } : {}),
          ...(params.policy !== undefined ? { policy: params.policy } : {}),
        }),
      );
    } else if (req.method === 'POST' && url.pathname === '/session/action') {
      json(
        await klura.performAction(
          params.sessionId ?? '',
          params.action ?? '',
          params.selector ?? '',
          params.value,
          params.page !== undefined ? { page: params.page } : undefined,
        ),
      );
    } else if (req.method === 'GET' && url.pathname === '/session/network') {
      const sid = url.searchParams.get('sessionId') ?? '';
      const opts: NetworkLogOptions = {};
      const i = url.searchParams.get('i');
      if (i !== null) opts.i = parseInt(i, 10);
      if (url.searchParams.get('full') === 'true') opts.full = true;
      const last = url.searchParams.get('last');
      if (last !== null) opts.last = parseInt(last, 10);
      const urlContains = url.searchParams.get('url_contains');
      if (urlContains) opts.url_contains = urlContains;
      const page = url.searchParams.get('page');
      if (page !== null) opts.page = parseInt(page, 10);
      const pageSize = url.searchParams.get('page_size');
      if (pageSize !== null) opts.page_size = parseInt(pageSize, 10);
      json(await klura.getNetworkLog(sid, opts));
    } else if (req.method === 'GET' && url.pathname === '/session/screenshot') {
      json(await klura.getScreenshot(url.searchParams.get('sessionId') ?? ''));
    } else if (req.method === 'GET' && url.pathname === '/session/attribute') {
      const sid = url.searchParams.get('sessionId') ?? '';
      const selector = url.searchParams.get('selector') ?? '';
      const attr = url.searchParams.get('attr') ?? undefined;
      json(await klura.getAttribute(sid, selector, attr));
    } else if (req.method === 'POST' && url.pathname === '/session/find') {
      const sid = params.sessionId ?? '';
      const needle = params.needle ?? '';
      const limit = params.limit;
      json(await klura.findInPage(sid, needle, limit));
    } else if (req.method === 'POST' && url.pathname === '/remote/start') {
      json(await klura.startRemote(params.sessionId ?? '', { prompt: params.prompt }));
    } else if (req.method === 'POST' && url.pathname === '/remote/stop') {
      json(await klura.stopRemote(params.sessionId ?? ''));
    } else if (req.method === 'POST' && url.pathname === '/listener/start') {
      json(await klura.startListener(params.platform ?? '', params.capability ?? '', params.args));
    } else if (req.method === 'POST' && url.pathname === '/listener/stop') {
      json(await klura.stopListener(params.listenerId ?? ''));
    } else if (req.method === 'GET' && url.pathname === '/listener/events') {
      const since = url.searchParams.get('since');
      json(klura.getEvents(since ? Number(since) : undefined));
    } else if (req.method === 'POST' && url.pathname === '/session/close') {
      json(
        await klura.endDrive(params.sessionId ?? '', {
          platform: params.platform,
          auditToken: params.auditToken,
          auditAnswers: params.auditAnswers,
        }),
      );
    } else if (req.method === 'POST' && url.pathname === '/strategy/save') {
      json(
        await klura.saveStrategy(
          params.platform ?? '',
          params.capability ?? '',
          params.data,
          params.changelog,
          params.sessionId,
        ),
      );
    } else if (req.method === 'POST' && url.pathname === '/execute') {
      json(
        await klura.execute(
          params.platform ?? '',
          params.capability ?? '',
          params.args,
          params.identity !== undefined ? { identity: params.identity } : undefined,
        ),
      );
    } else if (req.method === 'POST' && url.pathname === '/strategy/patch-step') {
      json(
        klura.patchStep(
          params.platform ?? '',
          params.capability ?? '',
          params.strategyType ?? '',
          params.stepId ?? '',
          params.patch ?? {},
        ),
      );
    } else if (req.method === 'POST' && url.pathname === '/strategy/mark-healed') {
      klura.markHealed(params.platform ?? '', params.capability ?? '', params.strategyType ?? '');
      json({ ok: true });
    } else if (req.method === 'POST' && url.pathname === '/execute/resume') {
      json(await klura.resumeExecution(params.sessionId ?? ''));
    } else if (req.method === 'GET' && url.pathname === '/history') {
      const p = url.searchParams.get('platform') ?? '';
      const cap = url.searchParams.get('capability') || undefined;
      const lim = url.searchParams.get('limit');
      json(klura.getStrategyEvents(p, cap, lim ? Number(lim) : undefined));
    } else if (req.method === 'GET' && url.pathname === '/platform-skills') {
      json(klura.listPlatformSkills());
    } else if (req.method === 'GET' && url.pathname === '/lift-rate') {
      json(klura.liftRate());
    } else {
      error(404, `Unknown endpoint: ${req.method ?? 'UNKNOWN'} ${url.pathname}`);
    }
  } catch (err: unknown) {
    // errorText guarantees a non-empty string — an empty `{"error":""}` reads
    // as an inexplicable crash to the agent and is what it can least act on.
    error(500, errorText(err));
  }
}

async function handleConsumerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  body: unknown,
  invokeConsumer: ConsumerDaemonInvoker,
  streamConsumerItems: ConsumerItemStreamInvoker,
): Promise<boolean> {
  if (request.method === 'POST' && pathname === '/consumer/runs/items/follow') {
    const abort = createRequestAbortSignal(request, response);
    try {
      const events = streamConsumerItems(body, abort.signal);
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      for await (const event of events) {
        if (!(await writeNdjsonLine(response, event, abort.signal))) return true;
      }
      if (!response.destroyed) response.end();
    } finally {
      abort.dispose();
    }
    return true;
  }
  if (!CONSUMER_ROUTES.has(`${request.method ?? 'UNKNOWN'} ${pathname}`)) return false;
  const abort = createRequestAbortSignal(request, response);
  try {
    const result = await invokeConsumer(request.method, pathname, body, abort.signal);
    const payload = JSON.stringify(result);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(payload);
  } finally {
    abort.dispose();
  }
  return true;
}

async function writeNdjsonLine(
  response: ServerResponse,
  value: unknown,
  signal: AbortSignal,
): Promise<boolean> {
  if (response.destroyed || signal.aborted) return false;
  const encoded = `${canonicalJson(value as JsonValueV1)}\n`;
  if (response.write(encoded)) return true;
  return await new Promise<boolean>((resolve) => {
    const finish = (writable: boolean): void => {
      response.removeListener('drain', onDrain);
      response.removeListener('close', onClose);
      signal.removeEventListener('abort', onAbort);
      resolve(writable);
    };
    const onDrain = (): void => {
      finish(true);
    };
    const onClose = (): void => {
      finish(false);
    };
    const onAbort = (): void => {
      finish(false);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (response.destroyed || signal.aborted) finish(false);
  });
}

function createRequestAbortSignal(
  req: IncomingMessage,
  res: ServerResponse,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  req.once('aborted', abort);
  res.once('close', abort);
  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    },
  };
}

export function isDaemonRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
  if (!Number.isInteger(pid) || pid < 1) {
    removeStalePidFile();
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves the pid is gone. EPERM (and any other probe failure)
    // means a process exists — treat the daemon as running rather than
    // clobbering a live instance's pid file.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
    removeStalePidFile();
    return false;
  }
}

function removeStalePidFile(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
}

/** Read the daemon's listen address. Returns 'unix' or 'host:port'. */
function getDaemonAddr(): string {
  const addrPath = path.join(KLURA_DIR, 'daemon.addr');
  try {
    return fs.readFileSync(addrPath, 'utf-8').trim();
  } catch {
    return 'unix';
  }
}

export function ensureDaemon(): Promise<void> {
  if (isDaemonRunning()) return Promise.resolve();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('child_process') as typeof import('child_process');
  const daemonScript = path.join(__dirname, '..', 'bin', 'klura-daemon.js');
  // cp.fork always attaches an IPC channel to the parent — the daemon uses it
  // to announce readiness (see announceDaemonReady) the moment its server is
  // listening, so the wait below subscribes to that lifecycle edge instead of
  // sampling the filesystem.
  const child = cp.fork(daemonScript, [], { detached: true, stdio: 'ignore' });
  child.unref();

  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      const kind = (message as { kind?: unknown } | null)?.kind;
      if (kind === DAEMON_READY_MESSAGE_KIND) settle();
    };
    const onExit = (): void => {
      // The child exits without a ready message when it loses the KLURA_HOME
      // singleton race — a concurrently-started daemon owns the home and may
      // already be serving. Accept that daemon if it is; otherwise the spawn
      // genuinely failed.
      if (isDaemonRunning()) settle();
      else settle(new Error('Daemon process exited before becoming ready'));
    };
    const onError = (err: Error): void => {
      settle(new Error(`Daemon process failed to spawn: ${err.message}`));
    };
    // Bounded fallback: if the ready message never arrives, check once at the
    // deadline whether a daemon is up anyway (socket in unix mode, addr file
    // in TCP mode) before giving up.
    const timer = setTimeout(() => {
      if (fs.existsSync(SOCKET_PATH) || fs.existsSync(path.join(KLURA_DIR, 'daemon.addr'))) {
        settle();
      } else {
        settle(new Error('Daemon failed to start within 10s'));
      }
    }, 10_000);

    function settle(err?: Error): void {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      // The IPC channel's handle keeps the parent's event loop alive even
      // after unref(). Disconnect it so a short-lived CLI can exit cleanly
      // once the spawned daemon is confirmed up (or the spawn has failed).
      try {
        child.disconnect();
      } catch {
        /* already disconnected or no channel */
      }
      if (err) reject(err);
      else resolve();
    }

    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

export function sendToDaemon(method: string, urlPath: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const addr = process.env.KLURA_DAEMON_ADDR || getDaemonAddr();

    let options: http.RequestOptions;
    if (addr === 'unix') {
      options = {
        socketPath: SOCKET_PATH,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json' },
      };
    } else {
      const { host, port } = parseListen(addr);
      options = {
        hostname: host,
        port,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json' },
      };
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
