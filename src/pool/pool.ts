import { BrowserDriver } from '../drivers/interface';
import type { BrowserPool, Session, SessionOptions } from '../drivers/types/session';
import { JsEvalCacheImpl } from '../strategies/js-eval-cache';
import { loadConfig } from '../config/handler';
import {
  emptyStats,
  RECENT_DIFFS_RING_SIZE,
  type RecentDiffEntry,
  type TryGeneratorStats,
} from '../strategies/try-generator-stats';

// Gate `[pool]` trace lines behind KLURA_VERBOSE so daemon stderr stays quiet
// in normal use. Matches the convention used by the benchmark harnesses
// (`benchmarks-internal/agent.js`, `field-reports/*`). Errors and warnings stay
// unconditional — only routine lifecycle traces filter.
const trace = (...args: unknown[]): void => {
  if (process.env.KLURA_VERBOSE === '1') console.log(...args);
};

interface PoolOptions {
  idleTimeout?: number; // seconds, default 300
  /** Driver name or path. Overrides `config.pool.driver`. */
  driver?: string;
  /** Launch a visible browser window. Overrides `config.pool.headful`. */
  headful?: boolean;
  /** Chromium channel preference. Overrides `config.pool.channel`. */
  channel?: 'auto' | 'chrome' | 'chromium';
  /** Opaque per-driver config — passed verbatim as `opts.config` to the
   *  driver constructor. Shape is the driver's contract. */
  driverConfig?: Record<string, unknown>;
  /**
   * Warm-pool settings. When `enabled`, `endDrive` returns the underlying
   * BrowserContext to a per-platform idle slot instead of tearing it down, and
   * the next `createSession` for the same platform reuses it via
   * `driver.resetSession` — cutting warm execute from ~10-20s to ~1-2s.
   */
  warm?: {
    enabled?: boolean;
    maxContexts?: number;
    idleTtlSeconds?: number;
  };
}

interface DriverConstructorOptions {
  headful?: boolean;
  channel?: 'auto' | 'chrome' | 'chromium';
  config?: Record<string, unknown>;
}

type DriverCtor = new (opts?: DriverConstructorOptions) => BrowserDriver;

// Built-in driver names. `pool.driver` picks one of these short names, or
// alternatively passes an absolute path / bare npm package name to require()
// for BYO (e.g. `@klura/driver-playwright-stealth`). Each entry is lazy so only
// the driver we actually use gets loaded.
const BUILTIN_DRIVERS: Record<string, () => DriverCtor> = {
  playwright: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../drivers/playwright') as { PlaywrightDriver: DriverCtor };
    return mod.PlaywrightDriver;
  },
};

/**
 * Resolve a driver name or path to a constructor:
 * - The `'playwright'` short name loads the bundled class via lazy require.
 * - Anything else goes through `require()` as a BYO driver — absolute path,
 *   relative path from cwd, or a bare npm module name. Accepts either a default
 *   or named export.
 *
 * Returns null for undefined input so callers can chain `??` fallbacks.
 */
export function resolveDriverClass(nameOrPath: string | undefined): DriverCtor | null {
  if (!nameOrPath) return null;
  const builtin = BUILTIN_DRIVERS[nameOrPath];
  if (builtin) return builtin();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(nameOrPath) as { default?: DriverCtor } | DriverCtor;
  const resolved = (mod as { default?: DriverCtor }).default ?? (mod as DriverCtor);
  if (typeof resolved !== 'function') {
    throw new Error(
      `pool.driver "${nameOrPath}" did not export a BrowserDriver constructor ` +
        `(expected default export or named class extending BrowserDriver)`,
    );
  }
  return resolved;
}

/**
 * Create a Pool by reading `~/.klura/config.json` directly. Returns a
 * `BrowserPool` implementation; callers should depend on the interface, not
 * the concrete class.
 *
 * `opts` override the corresponding config fields for programmatic callers
 * (tests, benchmarks, embedded use) that want to bypass config.json without
 * having to write it first.
 */
export function createPool(opts: PoolOptions = {}): BrowserPool {
  const config = loadConfig();
  return new Pool(undefined, {
    idleTimeout: opts.idleTimeout ?? config.pool.idleTimeout,
    driver: opts.driver ?? config.pool.driver,
    headful: opts.headful ?? config.pool.headful,
    channel: opts.channel ?? config.pool.channel,
    driverConfig: opts.driverConfig ?? config.pool.driver_config,
    warm: {
      enabled: config.pool.warm.enabled,
      maxContexts: config.pool.warm.max_contexts,
      idleTtlSeconds: config.pool.warm.idle_ttl_seconds,
    },
  });
}

import crypto from 'crypto';

/**
 * A warm Session that has been released by endDrive and is idle in the
 * per-platform slot. The underlying BrowserContext + Page are still live inside
 * the shared driver — the Session object itself is reused (identity-keyed
 * driver weakmaps still resolve it) with a fresh id minted when the next
 * `createSession` checks it out.
 */
interface WarmEntry {
  platform: string;
  /** Account name on the platform — see `Session.identity`. Default-when-omitted
   *  is `"default"`. The warm-slot key composes `platform + identity` so two
   *  accounts on the same platform never share a slot. */
  identity: string;
  session: Session;
  lastUsedAt: number;
  inUse: boolean;
}

/** Compose the warm-slot map key from a `(platform, identity)` tuple. The
 *  `::` separator is unambiguous: platform slug and identity slug are both
 *  defined to exclude colons, so the joined key parses cleanly even if the
 *  platform contains dashes. Default identity = `"default"` so the slot for a
 *  no-identity-supplied session is `"<platform>::default"` — distinct from
 *  any named identity. See klura://reference#identities. */
const DEFAULT_IDENTITY = 'default';
function warmKey(platform: string, identity?: string): string {
  return `${platform}::${identity || DEFAULT_IDENTITY}`;
}

export class Pool implements BrowserPool {
  private _driver: BrowserDriver;
  private _sessions = new Map<string, Session>();
  private _lastActivity = Date.now();
  private _idleTimeout: number;
  private _idleTimer: ReturnType<typeof setInterval>;

  // Warm-pool state. Keyed by platform — each platform gets at most one warm
  // BrowserContext at a time.
  //
  // FUTURE (see docs/pool.md#future-pool-work for the full list, items
  // 1–6). Intent-preserved design markers so the next contributor doesn't
  // redesign the checkout protocol:
  //   1. Replace `Map<platform, WarmEntry>` with `Map<platform, WarmEntry[]>`
  //      so N warm sessions per platform can coexist, each pinned to a
  //      different URL / capability. The `tryCheckoutReadySession` protocol
  //      already supports this — it iterates candidates.
  //   2. Capability-pinned pre-warm via
  //      `pool.warm.prewarm: [{platform, capability}]`.
  //   3. Richer eviction — LRU on `_warmMax` breach, heat-map-weighted
  //      budgets, cross-platform fairness.
  //   4. `pool.getWarmState()` introspection surface for diagnostics +
  //      benchmark assertions ("was this call actually warm?").
  //   5. Periodic liveness sweep — `probePageReady` in the sweeper to evict
  //      slots whose WS dropped or whose page navigated away unexpectedly.
  //   6. `max_total_warm` memory-pressure cap across all platforms.
  private _warmEnabled: boolean;
  // FUTURE item 1: rename to `_warmMaxPerPlatform` and add `_warmMaxTotal` when
  // per-platform arrays land.
  private _warmMax: number;
  // FUTURE item 3: this is the whole eviction policy today. Richer policy needs
  // a tick counter, a heat map, and a decision function.
  private _warmTtlMs: number;
  private _warm = new Map<string, WarmEntry>();
  private _warmSweeper: ReturnType<typeof setInterval> | null = null;

  // Ready-page checkout protocol: shared sessions that something OTHER than the
  // pool owns (canonical case: a browser-event listener that parks a page+WS
  // open for the listener's lifetime). Registered via `registerSharedSession`,
  // unregistered on `endDrive` or via the returned dispose fn. Kept as a
  // plain Set — the owner's explicit teardown removes it, so we don't need
  // WeakRef tricks. Iterated by `tryCheckoutReadySession` in insertion order.
  private _sharedSessions = new Map<string, Set<Session>>();

  // Shared js-eval cache + refresh scheduler. Public so the execution layer can
  // read/write through the structural `JsEvalCache` interface.
  readonly jsEvalCache = new JsEvalCacheImpl();

  // Per-session try_generator call counter. Lazy: an entry is created on first
  // recordTryGeneratorCall for a session, and cleared on endDrive so the
  // next session reusing the warm slot starts at 0.
  private _tryGeneratorStats = new Map<string, TryGeneratorStats>();

  // Per-session ring buffer of recent try_generator(verify_against) diffs. Used
  // to compute the convergence signal (`progress: converging | stuck |
  // oscillating | diverging`) emitted on every try_generator response. Same
  // lifecycle as _tryGeneratorStats.
  private _recentDiffs = new Map<string, RecentDiffEntry[]>();

  // Per-session tool-call count. Used by the envelope-advisory escalation
  // ("URGENT: 12+ rounds without verified iteration"). Incremented on every
  // getSession() lookup — that's the choke point for any tool that touches a
  // session. Slight overcount when a tool calls getSession twice is fine; the
  // ≥12 threshold is a soft signal, not a guarantee.
  private _sessionRoundCounts = new Map<string, number>();

  constructor(DriverClass?: DriverCtor, opts: PoolOptions = {}) {
    let ResolvedClass = DriverClass ?? null;
    if (!ResolvedClass) {
      try {
        ResolvedClass = resolveDriverClass(opts.driver) ?? resolveDriverClass('playwright');
      } catch (err) {
        throw new Error(
          `Failed to load pool.driver "${opts.driver ?? 'playwright'}": ${String(err)}. ` +
            `Install playwright or set pool.driver to a valid built-in name ("playwright"), ` +
            `a BYO package name (e.g. "@klura/driver-playwright-stealth"), or an absolute ` +
            `path in ~/.klura/config.json`,
          { cause: err },
        );
      }
    }
    if (!ResolvedClass) {
      throw new Error('No driver resolved. This should be unreachable.');
    }

    this._driver = new ResolvedClass({
      headful: opts.headful ?? false,
      channel: opts.channel ?? 'auto',
      config: opts.driverConfig,
    });
    this._idleTimeout = (opts.idleTimeout ?? 300) * 1000;
    this._warmEnabled = opts.warm?.enabled ?? false;
    this._warmMax = opts.warm?.maxContexts ?? 3;
    this._warmTtlMs = (opts.warm?.idleTtlSeconds ?? 600) * 1000;
    this._idleTimer = this._startIdleTimer();
    if (this._warmEnabled) {
      this._startWarmSweeper();
    }
  }

  get driver(): BrowserDriver {
    return this._driver;
  }

  /** Return the driver for a given session. Always the single shared driver. */
  driverFor(_sessionId: string): BrowserDriver {
    return this._driver;
  }

  private _touch(): void {
    this._lastActivity = Date.now();
  }

  private _startIdleTimer(): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      if (this._sessions.size > 0) return;
      // Warm entries count as "in use" from the browser's perspective —
      // hibernating the shared browser would kill them. Skip the hibernation
      // check entirely when any warm slot is live.
      if (this._warm.size > 0) return;

      const idle = Date.now() - this._lastActivity;
      if (idle > this._idleTimeout) {
        trace('[pool] Idle timeout, hibernating browser');
        void this._driver.closeBrowser();
      }
    }, 60000);

    timer.unref();
    return timer;
  }

  async createSession(opts: SessionOptions = {}): Promise<Session> {
    this._touch();

    // Warm-pool fast path: if there's an idle warm BrowserContext for this
    // (platform, identity) tuple, reuse it via driver.resetSession instead of
    // spawning a new context. Same-platform-different-identity calls correctly
    // miss and cold-spawn — cookie-jar bleed across accounts is not allowed.
    // Falls through to cold spawn on any failure (stale context, reset error,
    // busy slot, no platform).
    const key = opts.platform ? warmKey(opts.platform, opts.identity) : null;
    if (this._warmEnabled && key) {
      const warm = this._warm.get(key);
      if (warm && !warm.inUse) {
        const reused = await this._reuseWarm(warm, opts);
        if (reused) return reused;
      }
    }

    const session = await this._driver.createSession(opts);
    if (opts.platform) session.platform = opts.platform;
    if (opts.identity) session.identity = opts.identity;
    this._sessions.set(session.id, session);

    if (this._warmEnabled && opts.platform && key && !this._warm.has(key)) {
      this._evictIfNeeded();
      this._warm.set(key, {
        platform: opts.platform,
        identity: opts.identity || DEFAULT_IDENTITY,
        session,
        lastUsedAt: Date.now(),
        inUse: true,
      });
    }

    return session;
  }

  /**
   * Build a `Session` shell registered in the lookup table without spawning a
   * browser context. Used by the `start_session(graph:"execute")` fast-path
   * when the saved strategy can run from Node alone (fetch tier with no
   * browser-bound prereqs) — opening a Playwright page just to immediately
   * close it costs 5-15 s of nav + a11y snapshot on a session that never
   * exercises either. Driver methods are unsafe on the returned session; the
   * caller's contract is that the session enters terminal{closed} via the
   * execute-graph FSM right after auto-execute, after which the admissibility
   * check blocks every driver-using tool. See start-session.ts `executeOnlyFastPath`.
   *
   * Sync by intent — no I/O. Skips the warm-pool registration (no context to
   * reuse) and the driver-side init that `_driver.createSession` would do.
   */
  createNodeOnlySession(opts: { platform?: string; identity?: string } = {}): Session {
    this._touch();
    const session: Session = {
      id: 'sess_' + crypto.randomBytes(6).toString('hex'),
      intercepted: [],
      intercepting: false,
      hasTouch: false,
      wsFrames: [],
      subPages: [],
    };
    if (opts.platform) session.platform = opts.platform;
    if (opts.identity) session.identity = opts.identity;
    this._sessions.set(session.id, session);
    return session;
  }

  /**
   * Check out a warm slot for a new klura session. Rotates the underlying
   * Session object's id (driver-private weakmaps stay keyed by object identity,
   * so the Page/Context bindings survive), asks the driver to reset ephemeral
   * state, and registers the session under the new id. Returns `null` on any
   * failure — the caller falls through to a cold spawn and the stale warm entry
   * is evicted.
   */
  private async _reuseWarm(warm: WarmEntry, opts: SessionOptions): Promise<Session | null> {
    const session = warm.session;
    const newId = 'sess_' + crypto.randomBytes(6).toString('hex');
    const oldId = session.id;
    session.id = newId;
    if (opts.platform) session.platform = opts.platform;
    if (opts.identity) session.identity = opts.identity;

    try {
      await this._driver.resetSession(session, opts);
    } catch (err) {
      console.warn(
        `[pool] warm reuse for platform=${warm.platform} identity=${warm.identity} failed, falling back to cold spawn:`,
        err instanceof Error ? err.message : String(err),
      );
      // Stale context — force-destroy so nothing is left hanging, then drop the
      // warm entry.
      try {
        await this._driver.destroySession(session);
      } catch {
        /* already dead */
      }
      this._warm.delete(warmKey(warm.platform, warm.identity));
      // Restore the old id so callers of getSession with the prior id don't see
      // a mutated phantom — though in practice the old id was already removed
      // from _sessions when endDrive stashed this entry.
      session.id = oldId;
      return null;
    }

    warm.inUse = true;
    warm.lastUsedAt = Date.now();

    this._sessions.set(newId, session);
    trace(`[pool] warm-reused context for platform=${warm.platform} (session ${newId})`);
    return session;
  }

  /**
   * Ready-page checkout protocol. Run `probe` against every candidate session
   * the pool knows about for this platform — warm slot first, then shared
   * sessions (listener-owned, in registration order). Return the first session
   * whose probe returns true, marked `borrowed: true` so `endDrive`
   * releases it rather than tearing down.
   *
   * Returns null when warm pool is disabled, there are no candidates, no
   * candidate passes, or every probe throws. Protocol treats throws as false by
   * design — the caller cold-spawns and moves on.
   *
   * FUTURE item 1: when warm slots become `Map<platform, WarmEntry[]>`, this
   * iterates all entries in the per-platform array.
   */
  async tryCheckoutReadySession(
    platform: string,
    probe: (session: Session, driver: BrowserDriver) => Promise<boolean>,
    identity?: string,
  ): Promise<Session | null> {
    this._touch();

    // Warm slot first — if reuse succeeds without resetSession, the page is
    // still on whatever URL the previous borrow left it at. The
    // (platform, identity) tuple keys the slot — same-platform-different-
    // identity calls correctly miss so cookie jars don't leak across
    // accounts.
    const warm = this._warm.get(warmKey(platform, identity));
    if (this._warmEnabled && warm && !warm.inUse) {
      let ok: boolean;
      try {
        ok = await probe(warm.session, this._driver);
      } catch {
        ok = false;
      }
      if (ok) {
        const newId = 'sess_' + crypto.randomBytes(6).toString('hex');
        warm.session.id = newId;
        warm.session.borrowed = true;
        warm.inUse = true;
        warm.lastUsedAt = Date.now();
        this._sessions.set(newId, warm.session);
        trace(`[pool] ready-checkout warm session for platform=${platform} (session ${newId})`);
        return warm.session;
      }
    }

    // Shared sessions — listener-owned pages that registered via
    // `registerSharedSession`. First passing probe wins.
    const shared = this._sharedSessions.get(platform);
    if (shared) {
      for (const session of shared) {
        let ok: boolean;
        try {
          ok = await probe(session, this._driver);
        } catch {
          ok = false;
        }
        if (ok) {
          session.borrowed = true;
          trace(
            `[pool] ready-checkout shared session for platform=${platform} (session ${session.id})`,
          );
          return session;
        }
      }
    }

    return null;
  }

  /**
   * Register a long-lived session (owned by a listener or other long- running
   * subsystem) as a candidate for `tryCheckoutReadySession`. The caller retains
   * ownership — the pool only holds a reference for iteration. Returns a
   * dispose function the caller can call to unregister early; in practice the
   * listener also calls `endDrive` at teardown, which removes the
   * registration.
   */
  registerSharedSession(session: Session, platform: string): () => void {
    let bucket = this._sharedSessions.get(platform);
    if (!bucket) {
      bucket = new Set();
      this._sharedSessions.set(platform, bucket);
    }
    bucket.add(session);
    return () => {
      const b = this._sharedSessions.get(platform);
      if (b) {
        b.delete(session);
        if (b.size === 0) this._sharedSessions.delete(platform);
      }
    };
  }

  getSession(id: string): Session {
    const session = this._sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    this._touch();
    this._sessionRoundCounts.set(id, (this._sessionRoundCounts.get(id) ?? 0) + 1);
    // LIFT round counter: once end_drive has handed off, every tool-call
    // lookup increments. Drives the LIFT phase budget enforcement in
    // `runtime/src/phases/middleware.ts` and the freshly-handed-off
    // guard in `runtime/src/phases/drive/drive-to-triage-handoff.ts`.
    if (session.lift) {
      session.lift.roundsSinceHandoff += 1;
    }
    return session;
  }

  getTryGeneratorStats(sessionId: string): TryGeneratorStats | null {
    return this._tryGeneratorStats.get(sessionId) ?? null;
  }

  recordTryGeneratorCall(
    sessionId: string,
    flags: { hadVerifyAgainst: boolean; ok: boolean },
  ): void {
    let stats = this._tryGeneratorStats.get(sessionId);
    if (!stats) {
      stats = emptyStats();
      this._tryGeneratorStats.set(sessionId, stats);
    }
    stats.total += 1;
    if (flags.hadVerifyAgainst) stats.with_verify_against += 1;
    if (flags.ok) stats.ok_true += 1;
    if (flags.hadVerifyAgainst && flags.ok) stats.verified_ok += 1;
  }

  /** Append the diff produced by a try_generator(verify_against) call
   *  that returned ok:false to the per-session ring buffer (size 5,
   *  oldest evicted). Called only when verify_against was supplied AND
   *  the call did not return ok:true — the convergence signal needs the
   *  trailing iteration history, not the success terminator. */
  recordTryGeneratorDiff(sessionId: string, entry: RecentDiffEntry): void {
    let buf = this._recentDiffs.get(sessionId);
    if (!buf) {
      buf = [];
      this._recentDiffs.set(sessionId, buf);
    }
    buf.push(entry);
    if (buf.length > RECENT_DIFFS_RING_SIZE) {
      buf.splice(0, buf.length - RECENT_DIFFS_RING_SIZE);
    }
  }

  /** Recent try_generator(verify_against) diffs (oldest first). Empty
   *  array when the session has not iterated. */
  getRecentDiffs(sessionId: string): RecentDiffEntry[] {
    const buf = this._recentDiffs.get(sessionId);
    if (!buf) return [];
    return buf.slice();
  }

  /** Approximate count of tool calls against this session — incremented
   *  on every getSession() lookup. Used by envelope-advisory escalation
   *  at high round counts. Slight overcount when a tool calls getSession
   *  twice is acceptable; this is a soft heuristic. */
  getSessionRoundCount(sessionId: string): number {
    return this._sessionRoundCounts.get(sessionId) ?? 0;
  }

  async endDrive(id: string): Promise<void> {
    this._touch();
    // Drop any per-session feedback state for this id. Even if the underlying
    // browser context is returned to the warm pool below, the klura session id
    // rotates on next checkout (see _reuseWarm) so counters are
    // session-id-keyed, not context-keyed.
    this._tryGeneratorStats.delete(id);
    this._recentDiffs.delete(id);
    this._sessionRoundCounts.delete(id);
    const session = this._sessions.get(id);
    if (!session) {
      // Still might be a shared session tracked only in _sharedSessions
      // (listener-owned, never put into _sessions). Let the listener's own
      // endDrive call catch it when it tears down.
      return;
    }

    // Borrowed session via `tryCheckoutReadySession`: either the pool owns the
    // warm slot (release to warm without resetSession — the page is still
    // useful for the next borrower) or a listener owns it (no-op; the listener
    // manages teardown). Either way, do NOT destroy.
    if (session.borrowed) {
      session.borrowed = false;
      if (this._warmEnabled && session.platform) {
        const warm = this._warm.get(warmKey(session.platform, session.identity));
        if (warm && warm.session === session) {
          warm.inUse = false;
          warm.lastUsedAt = Date.now();
          this._sessions.delete(id);
          trace(
            `[pool] borrowed session ${id} released back to warm slot for platform=${session.platform} identity=${warm.identity}`,
          );
          return;
        }
      }
      // Shared session release. If the session is still registered as a
      // shared session for its platform, the original owner (listener,
      // start_session-attached agent session) still holds the id and will
      // make tool calls against it — keep the id valid. The owner's own
      // teardown path drops `_sharedSessions` and routes back through
      // endDrive, where the warm/cold branches below run for real
      // teardown. Dropping the id here would invalidate the agent's
      // sessionId mid-run (observed on auto-exec failure: agent calls
      // start_session, auto-exec runs a borrowed-shared browser-prereq,
      // its finally calls endDrive on the borrowed handle, the agent's
      // own sessionId then errors with "Session not found" on any
      // follow-up tool).
      if (session.platform) {
        const sharedForPlatform = this._sharedSessions.get(session.platform);
        if (sharedForPlatform?.has(session)) {
          trace(
            `[pool] borrowed shared session ${id} released (still owned by listener; keeping id valid)`,
          );
          return;
        }
      }
      // Shared session no longer registered — owner already disposed.
      // Drop the id; the underlying BrowserContext lifecycle is the
      // owner's responsibility.
      this._sessions.delete(id);
      trace(`[pool] borrowed shared session ${id} released (owner gone, dropping id)`);
      return;
    }

    // Warm path: if the session is bound to a platform and that platform owns
    // this session's warm slot, mark the slot idle and leave the BrowserContext
    // alive. The next createSession for the same platform reuses it via
    // _reuseWarm.
    if (this._warmEnabled && session.platform) {
      const warm = this._warm.get(warmKey(session.platform, session.identity));
      if (warm && warm.session === session) {
        warm.inUse = false;
        warm.lastUsedAt = Date.now();
        this._sessions.delete(id);
        trace(
          `[pool] session ${id} released warm context for platform=${session.platform} identity=${warm.identity} (idle)`,
        );
        return;
      }
    }

    // Cold path: remove from _sharedSessions too (listener may have registered
    // it and is now tearing it down via endDrive).
    if (session.platform) {
      const shared = this._sharedSessions.get(session.platform);
      if (shared?.has(session)) {
        shared.delete(session);
        if (shared.size === 0) this._sharedSessions.delete(session.platform);
      }
    }

    try {
      await this._driver.destroySession(session);
    } catch {
      /* already destroyed */
    }
    this._sessions.delete(id);
  }

  get activeSessions(): number {
    return this._sessions.size;
  }

  get idleSince(): number {
    return Math.floor((Date.now() - this._lastActivity) / 1000);
  }

  async shutdown(): Promise<void> {
    clearInterval(this._idleTimer);
    if (this._warmSweeper) {
      clearInterval(this._warmSweeper);
      this._warmSweeper = null;
    }
    for (const id of [...this._sessions.keys()]) {
      await this.endDrive(id);
    }
    // Evict every remaining warm context. endDrive above would have
    // released in-use warm slots to the idle pool; this final sweep destroys
    // them before closing the browser.
    for (const [key, warm] of this._warm) {
      try {
        await this._driver.destroySession(warm.session);
      } catch {
        /* already destroyed */
      }
      // jsEvalCache is platform-scoped — different identities on the same
      // platform share the cache, which is the correct policy (the JS body
      // doesn't depend on which account's cookies are loaded).
      this.jsEvalCache.cancel(warm.platform);
      trace(`[pool] shutdown: evicted warm context (key=${key})`);
    }
    this._warm.clear();
    this.jsEvalCache.shutdown();
    await this._driver.closeBrowser();
  }

  /**
   * LRU eviction: if the warm pool is at `maxContexts`, destroy the oldest
   * non-busy entry to make room. If every entry is in use, short-circuits and
   * lets the caller fall through to a non-warm session. `maxContexts: 0` means
   * unlimited.
   */
  private _evictIfNeeded(): void {
    if (this._warmMax <= 0) return;
    while (this._warm.size >= this._warmMax) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [key, entry] of this._warm) {
        if (entry.inUse) continue;
        if (entry.lastUsedAt < oldestTs) {
          oldestKey = key;
          oldestTs = entry.lastUsedAt;
        }
      }
      if (!oldestKey) return; // every entry busy; can't evict
      const victim = this._warm.get(oldestKey);
      if (!victim) return;
      this._driver.destroySession(victim.session).catch(() => undefined);
      this._warm.delete(oldestKey);
      this.jsEvalCache.cancel(victim.platform);
      trace(`[pool] LRU evicted warm context (key=${oldestKey})`);
    }
  }

  /**
   * Idle TTL sweeper: runs once a minute and evicts any warm context whose idle
   * time exceeds `idleTtlSeconds`. Prevents long-lived warm entries from
   * holding onto BrowserContext memory indefinitely. Uses `unref()` so the
   * timer doesn't keep the Node event loop alive.
   */
  private _startWarmSweeper(): void {
    this._warmSweeper = setInterval(() => {
      if (!this._warmEnabled) return;
      const now = Date.now();
      for (const [key, entry] of [...this._warm]) {
        if (entry.inUse) continue;
        if (now - entry.lastUsedAt > this._warmTtlMs) {
          this._driver.destroySession(entry.session).catch(() => undefined);
          this._warm.delete(key);
          this.jsEvalCache.cancel(entry.platform);
          trace(
            `[pool] TTL evicted warm context (key=${key}, idle=${Math.floor((now - entry.lastUsedAt) / 1000)}s)`,
          );
        }
      }
    }, 60_000);
    this._warmSweeper.unref();
  }
}
