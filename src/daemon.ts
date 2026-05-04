import http from 'http';
import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { loadConfig } from './config/handler';
import type { NetworkLogOptions } from './drivers/types/network';
import { KLURA_DIR } from './paths';
const PID_FILE = path.join(KLURA_DIR, 'daemon.pid');
const SOCKET_PATH = path.join(KLURA_DIR, 'klura.sock');

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
  _pool: { activeSessions: number; shutdown: () => Promise<void> };
}

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
  const config = loadConfig();
  fs.mkdirSync(KLURA_DIR, { recursive: true });

  const useUnix = config.runtime.listen === 'unix';
  if (useUnix) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      /* Socket may not exist */
    }
  }

  // Pool/driver settings come from config.json directly via createPool() when
  // index.ts requires below — no env var bridging needed.

  // Dynamic require to avoid circular deps — index.ts creates a pool on load
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const klura = require('./index') as KluraModule;
  let lastActivity = Date.now();
  const startTime = Date.now();

  function touch(): void {
    lastActivity = Date.now();
  }

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    touch();
    void handleRequest(req, res, klura, startTime, lastActivity, shutdown);
  });

  if (useUnix) {
    server.listen(SOCKET_PATH, () => {
      fs.writeFileSync(PID_FILE, String(process.pid));
      console.log(`klura daemon started (pid ${process.pid})`);
      console.log(`  socket: ${SOCKET_PATH}`);
      console.log(`  idle timeout: ${config.runtime.idleTimeout}s`);
    });
  } else {
    const { host, port } = parseListen(config.runtime.listen);
    server.listen(port, host, () => {
      fs.writeFileSync(PID_FILE, String(process.pid));
      // Write the listen address so sendToDaemon can find it
      fs.writeFileSync(path.join(KLURA_DIR, 'daemon.addr'), config.runtime.listen);
      console.log(`klura daemon started (pid ${process.pid})`);
      console.log(`  listen: ${host}:${port}`);
      console.log(`  idle timeout: ${config.runtime.idleTimeout}s`);
    });
  }

  const idleCheck = setInterval(() => {
    const idleMs = Date.now() - lastActivity;
    if (klura._pool.activeSessions > 0) {
      touch();
      return;
    }
    if (idleMs > config.runtime.idleTimeout * 1000) {
      console.log('Idle timeout reached, shutting down');
      void shutdown();
    }
  }, 60000);

  async function shutdown(): Promise<void> {
    clearInterval(idleCheck);
    console.log('klura daemon shutting down...');
    try {
      await klura._pool.shutdown();
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
    // Short tick so any in-flight responses flush, then exit.
    setTimeout(() => process.exit(0), 50).unref();
  }

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  klura: KluraModule,
  startTime: number,
  lastActivity: number,
  shutdown: () => Promise<void>,
): Promise<void> {
  let body = '';
  for await (const chunk of req) body += String(chunk);

  const json = (data: unknown): void => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const error = (statusCode: number, msg: string): void => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  };

  try {
    const params: RequestParams = body ? (JSON.parse(body) as RequestParams) : {};
    const url = new URL(req.url ?? '/', 'http://localhost');

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
    } else if (req.method === 'GET' && url.pathname === '/status') {
      json({
        uptime: Math.floor((Date.now() - startTime) / 1000),
        activeSessions: klura.status().activeSessions,
        idleSince: Math.floor((Date.now() - lastActivity) / 1000),
      });
    } else if (req.method === 'POST' && url.pathname === '/shutdown') {
      // Respond first so the client sees {ok:true}, then run the async
      // shutdown() which closes the server, drains the pool, and exits cleanly
      // with process.exit(0). Bare process.exit(0) here would skip all of that.
      json({ ok: true });
      void shutdown();
    } else {
      error(404, `Unknown endpoint: ${req.method ?? 'UNKNOWN'} ${url.pathname}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    error(500, message);
  }
}

export function isDaemonRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    return false;
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

export function ensureDaemon(): void {
  if (isDaemonRunning()) return;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('child_process') as typeof import('child_process');
  const daemonScript = path.join(__dirname, '..', 'bin', 'klura-daemon.js');
  const child = cp.fork(daemonScript, [], { detached: true, stdio: 'ignore' });
  child.unref();
  // cp.fork always attaches an IPC channel to the parent; unref()'ing the child
  // is not enough — the IPC channel's handle keeps the parent's event loop
  // alive until the child exits. Disconnect it so a short-lived CLI can exit
  // cleanly after the spawned daemon is confirmed up.
  try {
    child.disconnect();
  } catch {
    /* ignore — already disconnected or no channel */
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    // Check for either socket (unix mode) or addr file (TCP mode)
    if (fs.existsSync(SOCKET_PATH) || fs.existsSync(path.join(KLURA_DIR, 'daemon.addr'))) return;
    cp.execSync('sleep 0.2');
  }
  throw new Error('Daemon failed to start within 10s');
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
