import { EventEmitter } from 'events';
import { randomInt } from 'crypto';
import WebSocket from 'ws';
import * as skills from './strategies/skills';
import type { TokenCache } from './strategies/tokens';
import type { BrowserPool, Session } from './drivers/types/session';
import { interpolateVars } from './execution/vars';
import { parseSseChunk, parseNdjsonChunk } from './listeners/parse-fetch-stream';

// Shared pool surface — any BrowserPool implementation. Listeners need it to
// spin up long-lived browser sessions for the browser-event transport, which
// keeps a Playwright page alive on a logged-in feed/chat URL and streams its
// WebSocket frames through the event queue.
type AnyPool = BrowserPool;

/**
 * Re-run a strategy's prerequisites and repopulate the token cache. Injected by
 * the daemon on startup so proactive refresh can happen without creating a
 * circular dependency between listeners.ts and execution.ts. Matches
 * `runPrerequisites` in `execution.ts`.
 */
type PrereqRunner = (args: {
  strategy: { prerequisites?: unknown[]; baseUrl?: string };
  args: Record<string, unknown>;
  platform: string;
}) => Promise<{ tokens: Record<string, string> }>;

/**
 * How often the proactive-refresh watcher checks whether any of a listener's
 * cached tokens are approaching expiry. Short enough that the 10%-of-TTL
 * refresh buffer in TokenCache.needsRefresh catches everything down to
 * ~5-minute tokens; long enough that idle listeners don't burn CPU on no-op
 * checks.
 */
const LISTENER_TOKEN_CHECK_INTERVAL_MS = 30_000;

export interface ListenerEvent {
  listenerId: string;
  platform: string;
  capability: string;
  data: unknown;
  timestamp: number;
}

interface ListenerStrategy {
  strategy: string;
  type: 'listener';
  /**
   * Wire transport. Four flavors:
   *  - `websocket` — daemon-side `ws` connection (klura's own ws client).
   *  - `fetch-stream` — daemon-side `fetch()` + chunked response parsed as
   *    SSE or NDJSON. Covers POST + JSON body + streaming token-delta
   *    response (the modern streaming-completion API shape) and
   *    SSE-over-GET (long-lived event-source endpoints).
   *  - `poll` — periodic `fetch()` (last resort for sites with no push).
   *  - `browser-event` — keep a Playwright page open and forward its
   *    incoming WebSocket frames. For cookie-bound chat / feed channels
   *    that aren't reachable from a Node-side client.
   */
  transport: 'websocket' | 'fetch-stream' | 'poll' | 'browser-event';
  /**
   * Endpoint URL for non-browser-event transports (websocket, fetch-stream,
   * poll). Browser-event strategies leave this empty and put the page URL
   * in `pageUrl` instead.
   */
  endpoint: string;
  /**
   * For the `browser-event` transport: the URL the browser navigates to so the
   * page's own JS opens its WebSocket connections. May contain {{args}}
   * templates resolved from the listener's args (e.g. order_id, room_id).
   */
  pageUrl?: string;
  pollInterval?: number; // ms, for poll transport (default 5000)
  /**
   * fetch-stream HTTP method. Defaults to `POST` — matches the modern
   * streaming-completion API shape where the request body carries the
   * conversation / query definition. Pass `GET` for upstreams that stream
   * from a long-lived event-source endpoint. Ignored by other transports.
   */
  method?: 'GET' | 'POST';
  /**
   * fetch-stream response framing. `sse` (default) handles `data: <line>`
   * events terminated by `\n\n`; `ndjson` handles newline-delimited JSON
   * (one complete JSON value per line). Ignored by other transports.
   */
  parse?: 'sse' | 'ndjson';
  /**
   * fetch-stream request body. `{{template}}` placeholders are
   * interpolated against the listener's args (same shape as the fetch-tier
   * strategy body). Serialized as JSON unless `contentType` is `'form'`.
   * Ignored on `GET` and on other transports.
   */
  body?: Record<string, unknown>;
  /**
   * fetch-stream body serialization. `'json'` (default) writes the body
   * as JSON with `Content-Type: application/json`; `'form'` writes
   * `application/x-www-form-urlencoded`. Ignored on `GET` and on other
   * transports.
   */
  contentType?: 'json' | 'form';
  /**
   * Extra headers to send on the request (fetch-stream + websocket +
   * poll). `{{template}}` placeholders interpolated against args. Caller-
   * supplied headers override the auto-injected `Accept` /
   * `Content-Type` defaults so platforms with custom auth headers
   * (`Authorization`, `x-client-version`, etc.) compose cleanly.
   */
  headers?: Record<string, string>;
  auth?: {
    type: 'query-param' | 'header';
    param?: string;
    value?: string;
    header?: string;
  };
  events?: {
    match?: Record<string, unknown>;
    delivers?: string[];
  };
  reconnect?: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number; // cap for backoff (default 30000)
  };
}

interface ActiveListener {
  id: string;
  platform: string;
  capability: string;
  args: Record<string, unknown>;
  strategy: ListenerStrategy;
  ws?: WebSocket;
  pollTimer?: ReturnType<typeof setInterval>;
  sseController?: AbortController;
  /** browser-event: pool session ID held for the listener's lifetime. */
  browserSessionId?: string;
  /** browser-event: dispose function from `driver.streamWebSocketFrames`. */
  browserStreamDispose?: () => Promise<void>;
  startedAt: number;
  reconnectAttempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  /**
   * Proactive-refresh watcher. Tick-fires every
   * LISTENER_TOKEN_CHECK_INTERVAL_MS, re-runs prereqs + triggers a reconnect
   * when any cached token needs refresh.
   */
  tokenWatchTimer?: ReturnType<typeof setInterval>;
  /** Guard so two concurrent ticks don't both launch a refresh. */
  refreshInFlight?: boolean;
}

const MAX_EVENTS = 100;

/**
 * Walk a listener body shape, interpolating `{{template}}` placeholders in
 * every string leaf against `args`. Mirror-of-shape with the existing
 * `resolveBody` in `runtime/src/execution/vars.ts` for fetch-tier
 * strategies — duplicated here only to avoid importing the heavier
 * execution-layer module from listeners.ts. Non-string values pass through
 * (numbers, booleans, nested objects, arrays).
 */
function resolveListenerBody(
  body: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = resolveListenerBodyValue(v, args);
  }
  return out;
}

function resolveListenerBodyValue(value: unknown, args: Record<string, unknown>): unknown {
  if (typeof value === 'string') return interpolateVars(value, args);
  if (Array.isArray(value)) return value.map((item) => resolveListenerBodyValue(item, args));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveListenerBodyValue(v, args);
    }
    return out;
  }
  return value;
}

export class ListenerManager extends EventEmitter {
  private active = new Map<string, ActiveListener>();
  private eventQueue: ListenerEvent[] = [];
  private counter = 0;
  private tokenCache: TokenCache | null = null;
  private pool: AnyPool | null = null;
  private prereqRunner: PrereqRunner | null = null;

  setTokenCache(cache: TokenCache): void {
    this.tokenCache = cache;
  }

  /**
   * Inject the runtime pool so browser-event listeners can spin up long-lived
   * browser sessions. Called once at daemon startup. Without a pool the
   * browser-event transport rejects with a clear error.
   */
  setPool(pool: AnyPool): void {
    this.pool = pool;
  }

  /**
   * Inject the prereq runner so the proactive-refresh watcher can repopulate
   * the token cache before cached values hit their TTL. Called once at daemon
   * startup. Without it, the watcher silently no-ops — listeners fall back to
   * the reactive 401 path.
   */
  setPrereqRunner(runner: PrereqRunner): void {
    this.prereqRunner = runner;
  }

  start(
    platform: string,
    capability: string,
    args: Record<string, unknown> = {},
  ): Promise<{ listenerId: string }> {
    const loaded = skills.loadStrategy(platform, capability) as unknown as { type?: string } | null;
    if (!loaded) {
      return Promise.reject(new Error(`No strategy found for ${platform}/${capability}`));
    }
    if (loaded.type !== 'listener') {
      return Promise.reject(new Error(`Strategy ${platform}/${capability} is not a listener`));
    }
    const strategy = loaded as unknown as ListenerStrategy;

    const transport = strategy.transport;
    const knownTransports = ['websocket', 'fetch-stream', 'poll', 'browser-event'];
    if (!knownTransports.includes(transport)) {
      return Promise.reject(new Error(`Unsupported transport: ${transport}`));
    }

    const listenerId = `listener_${++this.counter}_${Date.now()}`;

    const listener: ActiveListener = {
      id: listenerId,
      platform,
      capability,
      args,
      strategy,
      startedAt: Date.now(),
      reconnectAttempts: 0,
    };

    this.active.set(listenerId, listener);
    this.startTransport(listener);
    this.startTokenWatch(listener);
    return Promise.resolve({ listenerId });
  }

  /**
   * Proactive token-refresh watcher. Every LISTENER_TOKEN_CHECK_INTERVAL_MS,
   * check whether any cached token this listener references is approaching its
   * TTL. If so, re-run the strategy's prerequisites (which repopulates the
   * cache) and trigger an immediate reconnect so the next connection uses fresh
   * values. Gives deterministic refresh cadence without the 401-then-retry
   * latency hit.
   */
  private startTokenWatch(listener: ActiveListener): void {
    if (!this.tokenCache) return;
    if (!this.prereqRunner) return; // no runner → no way to repopulate cache
    if (!this.listenerUsesTemplates(listener)) return;
    listener.tokenWatchTimer = setInterval(() => {
      void this.tickTokenWatch(listener);
    }, LISTENER_TOKEN_CHECK_INTERVAL_MS);
  }

  /** True if the listener references any {{template}} the watcher should
   *  track. */
  private listenerUsesTemplates(listener: ActiveListener): boolean {
    const re = /\{\{(\w+)\}\}/g;
    for (const source of [listener.strategy.endpoint, listener.strategy.auth?.value ?? '']) {
      if (re.test(source)) return true;
    }
    return false;
  }

  private async tickTokenWatch(listener: ActiveListener): Promise<void> {
    if (!this.active.has(listener.id)) return;
    if (listener.refreshInFlight) return;
    if (!this.tokenCache) return;
    if (!this.prereqRunner) return;

    // Enumerate the {{template}} names referenced by this listener and ask the
    // cache whether any of them need refresh. Stay read-only if all tokens are
    // fresh.
    const templates = new Set<string>();
    const re = /\{\{(\w+)\}\}/g;
    for (const source of [listener.strategy.endpoint, listener.strategy.auth?.value ?? '']) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        if (match[1]) templates.add(match[1]);
      }
    }
    let anyStale = false;
    for (const name of templates) {
      if (this.tokenCache.needsRefresh(listener.platform, name)) {
        anyStale = true;
        break;
      }
    }
    if (!anyStale) return;

    listener.refreshInFlight = true;
    try {
      // ListenerStrategy doesn't formally declare `prerequisites` / `baseUrl`
      // on its TS type, but the saved listener JSON carries them when the
      // listener's auth depends on browser-extracted tokens. Hand the strategy
      // through as-is; the runner reads those fields directly.
      await this.prereqRunner({
        strategy: listener.strategy as unknown as {
          prerequisites?: unknown[];
          baseUrl?: string;
        },
        args: listener.args,
        platform: listener.platform,
      });
      if (!this.active.has(listener.id)) return;
      // Fresh tokens are now in the cache; trigger an immediate reconnect.
      // Reset reconnectAttempts first so the preemptive refresh isn't subject
      // to the reactive-path backoff.
      listener.reconnectAttempts = 0;
      this.scheduleReconnect(listener);
    } catch {
      // Prereq run failed — leave the listener running. The reactive 401 path
      // will catch the actual expiry when it arrives.
    } finally {
      listener.refreshInFlight = false;
    }
  }

  private startTransport(listener: ActiveListener): void {
    switch (listener.strategy.transport) {
      case 'websocket':
        listener.ws = this.connectWebSocket(listener);
        break;
      case 'fetch-stream':
        this.connectFetchStream(listener);
        break;
      case 'poll':
        this.startPolling(listener);
        break;
      case 'browser-event':
        void this.connectBrowserEvent(listener);
        break;
    }
  }

  /**
   * Browser-event transport: keep a Playwright page open on the listener's
   * pageUrl and forward every WebSocket frame the page receives into the event
   * queue. Used for cookie-bound chat / feed / notification channels that can't
   * be tapped from a Node-side WebSocket connection.
   *
   * On stream termination (page crash, connection drop, container death), the
   * closed Promise resolves and we re-enter scheduleReconnect with the existing
   * exponential-backoff machinery.
   */
  private async connectBrowserEvent(listener: ActiveListener): Promise<void> {
    if (!this.pool) {
      this.emit('disconnected', { listenerId: listener.id, reason: 'no_pool' });
      return;
    }
    const pageUrl = listener.strategy.pageUrl;
    if (!pageUrl) {
      this.emit('disconnected', { listenerId: listener.id, reason: 'missing_page_url' });
      return;
    }

    // Resolve {{template}} args into the page URL — same shape as buildUrl.
    const resolvedUrl = interpolateVars(pageUrl, listener.args);

    // Load stored cookies so the browser starts the listener already logged in
    // for this platform. If no storage state has been saved yet, the browser
    // starts fresh — the listener may need a manual login first.
    const storageStatePath = skills.loadStorageStatePath(listener.platform);
    const sessionOpts: Record<string, unknown> = {};
    if (storageStatePath) sessionOpts.storageState = storageStatePath;

    let session: Session;
    try {
      session = await this.pool.createSession(sessionOpts);
    } catch {
      if (this.active.has(listener.id)) this.scheduleReconnect(listener);
      return;
    }
    listener.browserSessionId = session.id;

    const driver = this.pool.driverFor(session.id);
    try {
      await driver.navigate(session, resolvedUrl);
    } catch {
      if (this.active.has(listener.id)) this.scheduleReconnect(listener);
      return;
    }

    let stream;
    try {
      stream = await driver.streamWebSocketFrames(session, (frame) => {
        // Only forward incoming frames — outgoing are the page's own sends
        // (e.g. heartbeats, ack messages) and would pollute the event queue.
        if (frame.direction !== 'received') return;
        this.handleIncomingData(listener, frame.payload);
      });
    } catch {
      if (this.active.has(listener.id)) this.scheduleReconnect(listener);
      return;
    }
    listener.browserStreamDispose = stream.dispose;
    listener.reconnectAttempts = 0;

    // Expose the listener's long-lived session to the pool's ready-page
    // checkout protocol. execute() calls for the same platform can then borrow
    // this session (page + WS already live) instead of cold- spawning. Purely
    // additive: the listener still owns the session's lifetime. The
    // registration drops automatically when the session is torn down
    // (endDrive clears shared-registry entries).
    if (this.pool.registerSharedSession) {
      this.pool.registerSharedSession(session, listener.platform);
    }

    // Watchdog: when the stream terminates for any reason and the listener is
    // still meant to be active, re-enter the reconnect machinery.
    void stream.closed.then(() => {
      if (!this.active.has(listener.id)) return; // explicitly stopped
      this.scheduleReconnect(listener);
    });
  }

  private connectWebSocket(listener: ActiveListener): WebSocket {
    const url = this.buildUrl(listener.strategy, listener.args);
    const headers: Record<string, string> = {};
    if (listener.strategy.auth?.type === 'header' && listener.strategy.auth.header) {
      headers[listener.strategy.auth.header] = this.resolveAuthValue(
        listener.strategy,
        listener.args,
      );
    }

    const ws = new WebSocket(url, { headers });

    ws.on('message', (data: Buffer) => {
      this.handleIncomingData(listener, data.toString());
    });

    ws.on('open', () => {
      listener.reconnectAttempts = 0; // reset on successful connect
    });

    ws.on('close', () => {
      if (!this.active.has(listener.id)) return; // already stopped
      this.scheduleReconnect(listener);
    });

    ws.on('error', () => {
      // error triggers close, which handles reconnect
    });

    return ws;
  }

  private connectFetchStream(listener: ActiveListener): void {
    const strategy = listener.strategy;
    const url = this.buildUrl(strategy, listener.args);
    const controller = new AbortController();
    listener.sseController = controller;

    const method = strategy.method ?? 'POST';
    const parseMode = strategy.parse ?? 'sse';
    const contentType = strategy.contentType ?? 'json';

    // Auto-injected defaults — caller's `headers` override on conflict.
    const headers: Record<string, string> = {};
    headers['Accept'] = parseMode === 'sse' ? 'text/event-stream' : 'application/x-ndjson';
    let bodyString: string | undefined;
    if (method === 'POST' && strategy.body) {
      // Same shape as fetch-tier body: `{{template}}` placeholders against
      // args, JSON-or-form serialized.
      const resolved = resolveListenerBody(strategy.body, listener.args);
      if (contentType === 'form') {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(resolved)) {
          flat[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
        bodyString = new URLSearchParams(flat).toString();
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else {
        bodyString = JSON.stringify(resolved);
        headers['Content-Type'] = 'application/json';
      }
    }
    if (strategy.headers) {
      for (const [k, v] of Object.entries(strategy.headers)) {
        headers[k] = interpolateVars(v, listener.args);
      }
    }
    if (strategy.auth?.type === 'header' && strategy.auth.header) {
      headers[strategy.auth.header] = this.resolveAuthValue(strategy, listener.args);
    }

    const fetchInit: RequestInit = { method, headers, signal: controller.signal };
    if (bodyString !== undefined) fetchInit.body = bodyString;

    const connect = (): void => {
      fetch(url, fetchInit)
        .then(async (res) => {
          if (!res.ok || !res.body) {
            throw new Error(`fetch-stream connection failed: ${res.status}`);
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          const push = (value: unknown): void => {
            // The existing handleIncomingData expects a string body that it
            // re-parses as JSON. parse-fetch-stream already produces parsed
            // values (or the raw string when JSON.parse failed). Round-trip
            // back to the existing surface so `events.match` and the
            // `ListenerEvent` envelope work identically to other transports.
            const raw = typeof value === 'string' ? value : JSON.stringify(value);
            this.handleIncomingData(listener, raw);
          };
          for (;;) {
            const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
            if (chunk.done) break;
            if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
            buffer =
              parseMode === 'sse' ? parseSseChunk(buffer, push) : parseNdjsonChunk(buffer, push);
          }
          // Stream ended — reconnect.
          if (this.active.has(listener.id)) {
            this.scheduleReconnect(listener);
          }
        })
        .catch(() => {
          if (this.active.has(listener.id) && !controller.signal.aborted) {
            this.scheduleReconnect(listener);
          }
        });
    };

    connect();
  }

  private startPolling(listener: ActiveListener): void {
    const url = this.buildUrl(listener.strategy, listener.args);
    const interval = listener.strategy.pollInterval ?? 5000;
    const headers: Record<string, string> = {};
    if (listener.strategy.auth?.type === 'header' && listener.strategy.auth.header) {
      headers[listener.strategy.auth.header] = this.resolveAuthValue(
        listener.strategy,
        listener.args,
      );
    }

    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(url, { headers });
        if (!res.ok) return;
        const text = await res.text();
        this.handleIncomingData(listener, text);
      } catch {
        // Poll failures are silent — next poll will retry
      }
    };

    // First poll immediately
    void poll();
    listener.pollTimer = setInterval(() => {
      void poll();
    }, interval);
  }

  private handleIncomingData(listener: ActiveListener, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }

    // For poll transport, result may be an array of events
    const items =
      listener.strategy.transport === 'poll' && Array.isArray(parsed) ? parsed : [parsed];

    for (const item of items) {
      // Apply event filter if specified
      if (listener.strategy.events?.match && typeof item === 'object' && item !== null) {
        const matches = Object.entries(listener.strategy.events.match).every(
          ([key, value]) => (item as Record<string, unknown>)[key] === value,
        );
        if (!matches) continue;
      }

      const event: ListenerEvent = {
        listenerId: listener.id,
        platform: listener.platform,
        capability: listener.capability,
        data: item,
        timestamp: Date.now(),
      };

      this.eventQueue.push(event);
      if (this.eventQueue.length > MAX_EVENTS) {
        this.eventQueue.shift();
      }

      this.emit('event', event);
    }
  }

  private scheduleReconnect(listener: ActiveListener): void {
    const maxRetries = listener.strategy.reconnect?.maxRetries ?? 5;
    if (listener.reconnectAttempts >= maxRetries) {
      this.active.delete(listener.id);
      this.emit('disconnected', { listenerId: listener.id, reason: 'max_retries' });
      return;
    }

    const initialDelay = listener.strategy.reconnect?.initialDelay ?? 1000;
    const maxDelay = listener.strategy.reconnect?.maxDelay ?? 30_000;
    const exponential = initialDelay * Math.pow(2, listener.reconnectAttempts);
    const jitter = randomInt(Math.max(1, Math.floor(initialDelay + 1)));
    const delay = Math.min(exponential + jitter, maxDelay);

    listener.reconnectAttempts++;
    listener.reconnectTimer = setTimeout(() => {
      if (!this.active.has(listener.id)) return;
      this.refreshListenerTokens(listener);

      // browser-event reconnect needs a hard teardown of the dead browser
      // session before re-entering startTransport. The dispose call detaches
      // the SSE stream and releases the Playwright hooks; closing the pool
      // session destroys the container (in docker mode) or closes the page (in
      // local mode). Both are best-effort — the session is already probably
      // dead when reconnect fires.
      if (listener.strategy.transport === 'browser-event') {
        void (async () => {
          if (listener.browserStreamDispose) {
            try {
              await listener.browserStreamDispose();
            } catch {
              /* ignore */
            }
            listener.browserStreamDispose = undefined;
          }
          if (listener.browserSessionId && this.pool) {
            try {
              await this.pool.endDrive(listener.browserSessionId);
            } catch {
              /* ignore */
            }
            listener.browserSessionId = undefined;
          }
          if (this.active.has(listener.id)) {
            this.startTransport(listener);
          }
        })();
        return;
      }

      this.startTransport(listener);
    }, delay);
  }

  /** Pull fresh tokens from cache into listener args before reconnect */
  private refreshListenerTokens(listener: ActiveListener): void {
    if (!this.tokenCache) return;

    // Find {{template}} variables used in endpoint and auth.value
    const templates = new Set<string>();
    const re = /\{\{(\w+)\}\}/g;
    let match: RegExpExecArray | null;

    for (const source of [listener.strategy.endpoint, listener.strategy.auth?.value || '']) {
      while ((match = re.exec(source)) !== null) {
        if (match[1]) templates.add(match[1]);
      }
    }

    // Check cache for each template variable
    for (const name of templates) {
      const fresh = this.tokenCache.get(listener.platform, name);
      if (fresh && fresh !== listener.args[name]) {
        listener.args[name] = fresh;
      }
    }
  }

  private resolveAuthValue(strategy: ListenerStrategy, args: Record<string, unknown>): string {
    return interpolateVars(strategy.auth?.value || '', args);
  }

  private buildUrl(strategy: ListenerStrategy, args: Record<string, unknown>): string {
    let url = interpolateVars(strategy.endpoint, args);

    // Add auth query param
    if (strategy.auth?.type === 'query-param' && strategy.auth.param) {
      const authValue = interpolateVars(strategy.auth.value || '', args);
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}${strategy.auth.param}=${encodeURIComponent(authValue)}`;
    }

    return url;
  }

  async stop(listenerId: string): Promise<{ ok: true }> {
    const listener = this.active.get(listenerId);
    if (!listener) {
      throw new Error(`Listener not found: ${listenerId}`);
    }

    // Mark inactive FIRST so any in-flight reconnect-watchdog or stream close
    // handlers see the listener is gone and skip their reconnect path.
    this.active.delete(listenerId);

    if (listener.reconnectTimer) {
      clearTimeout(listener.reconnectTimer);
    }
    if (listener.tokenWatchTimer) {
      clearInterval(listener.tokenWatchTimer);
    }
    if (listener.ws) {
      listener.ws.close();
    }
    if (listener.pollTimer) {
      clearInterval(listener.pollTimer);
    }
    if (listener.sseController) {
      listener.sseController.abort();
    }
    if (listener.browserStreamDispose) {
      try {
        await listener.browserStreamDispose();
      } catch {
        /* best-effort */
      }
    }
    if (listener.browserSessionId && this.pool) {
      try {
        await this.pool.endDrive(listener.browserSessionId);
      } catch {
        /* best-effort */
      }
    }

    return { ok: true };
  }

  getEvents(since?: number): ListenerEvent[] {
    if (since) {
      return this.eventQueue.filter((e) => e.timestamp > since);
    }
    const events = [...this.eventQueue];
    this.eventQueue = [];
    return events;
  }

  listActive(): Array<{ id: string; platform: string; capability: string; startedAt: number }> {
    return [...this.active.values()].map((l) => ({
      id: l.id,
      platform: l.platform,
      capability: l.capability,
      startedAt: l.startedAt,
    }));
  }

  async stopAll(): Promise<void> {
    for (const [id] of this.active) {
      await this.stop(id);
    }
  }
}
