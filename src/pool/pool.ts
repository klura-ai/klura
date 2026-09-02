import crypto from 'crypto';
import { BrowserDriver } from '../drivers/interface';
import type { BrowserLease, BrowserPool, Session, SessionOptions } from '../drivers/types/session';
import { disposeSessionScope } from './session-scope';
import { JsEvalCacheImpl } from '../strategies/js-eval-cache';
import { isDrivenByExternalMcpHost } from '../runtime-state/mcp-host';
import {
  emptyStats,
  RECENT_DIFFS_RING_SIZE,
  type RecentDiffEntry,
  type TryGeneratorStats,
} from '../strategies/try-generator-stats';
import { resolveDriverClass, type DriverCtor, type PoolOptions } from './create-pool';
import { DEFAULT_IDENTITY, deviceFingerprintOf, warmKey, type WarmEntry } from './warm-slots';

// Construction surface (driver registry + config-reading factory) lives in
// ./create-pool — re-exported so callers keep the canonical pool import path.
export { createPool, resolveDriverClass } from './create-pool';
export type { PoolOptions, DriverConstructorOptions, DriverCtor } from './create-pool';

// Gate `[pool]` trace lines behind KLURA_VERBOSE so daemon stderr stays quiet
// in normal use. Matches the convention used by the bench harness (`bench/*`).
// Errors and warnings stay unconditional — only routine lifecycle traces filter.
const trace = (...args: unknown[]): void => {
  if (process.env.KLURA_VERBOSE === '1') console.log(...args);
};

export class Pool implements BrowserPool {
  // Driver construction is deferred to first use (via `_driver`, below) so that
  // constructing the Pool — which happens at module load, before any tool runs
  // — never depends on a loadable driver. A bad `pool.driver` then fails only
  // when a session is actually started, keeping the config-repair tools
  // (get_config / describe_config / configure) reachable to fix it.
  private _driverInstance: BrowserDriver | null = null;
  private readonly _makeDriver: () => BrowserDriver;
  private _sessions = new Map<string, Session>();
  private _lastActivity = Date.now();
  private _idleTimeout: number;
  // Idle-hibernation timer. Armed at lifecycle edges (`_touch` on every
  // public entry point, warm-sweeper eviction when the pool may have just
  // gone quiet) — never a condition-polling interval.
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;

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
  // Whether sessions this pool creates drive a normally-launched Chrome over
  // CDP (connect mode) rather than a Playwright-launched browser. Read by the
  // challenge detector to gate the connect-mode nudge.
  private _connectEnabled: boolean;
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

  // Per-session user-round count. Incremented exactly once per admitted
  // non-universal tool call by the phase middleware (`registerUserRound` from
  // `assertToolAdmissibleBySessionId`) — session lookups are pure and never
  // touch it. Read back via `getSessionRoundCount` for envelope-advisory
  // evidence narration and the end_drive repeat-close snapshot.
  private _sessionRoundCounts = new Map<string, number>();

  // Subscribers for the pool's busy→idle transition at edges that arrive
  // with no accompanying RPC (warm-sweeper eviction of the last slot). The
  // daemon's idle-shutdown timer re-arms from this callback: its one-shot
  // timer does not re-arm when it fires while `busy()` is true, and a warm
  // slot can keep `busy()` true with no future request to touch it.
  private _idleSubscribers = new Set<() => void>();

  constructor(DriverClass?: DriverCtor, opts: PoolOptions = {}) {
    // Capture the resolution recipe; don't run it. The require()/construct only
    // happens on first `_driver` access (see the getter below). Failures surface
    // at session start with an actionable message, not as an uncaught throw at
    // module load that would brick the whole CLI.
    this._makeDriver = () => {
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
      return new ResolvedClass({
        headful: opts.headful ?? false,
        channel: opts.channel ?? 'auto',
        config: opts.driverConfig,
        connect: opts.connect,
      });
    };
    this._idleTimeout = (opts.idleTimeout ?? 300) * 1000;
    this._connectEnabled = opts.connect?.enabled ?? false;
    this._warmEnabled = opts.warm?.enabled ?? false;
    this._warmMax = opts.warm?.maxContexts ?? 3;
    this._warmTtlMs = (opts.warm?.idleTtlSeconds ?? 600) * 1000;
    this._armIdleTimer();
    if (this._warmEnabled) {
      this._startWarmSweeper();
    }
  }

  /** The shared driver, constructed on first access. Throws here (not at boot)
   *  if `pool.driver` can't be loaded. */
  private get _driver(): BrowserDriver {
    if (!this._driverInstance) this._driverInstance = this._makeDriver();
    return this._driverInstance;
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
    this._armIdleTimer();
  }

  /**
   * The single busy-predicate for the idle/teardown decision. Live sessions
   * are obviously busy; warm entries count as "in use" from the browser's
   * perspective too — hibernating the shared browser would kill them, and
   * killing them silently defeats the warm-pool feature. Any layer deciding
   * whether klura is idle enough to tear browser state down (the pool's own
   * hibernation, the daemon's idle shutdown) must consult this predicate
   * rather than re-deriving its own.
   */
  busy(): boolean {
    return this._sessions.size > 0 || this._warm.size > 0;
  }

  /**
   * Subscribe to the pool's busy→idle transition on lifecycle edges that no
   * RPC accompanies (currently: the warm sweeper evicting the last slot).
   * Layers whose own idle timers gate on `busy()` (the daemon's idle
   * shutdown) re-arm from this callback instead of polling. Returns an
   * unsubscribe function. Subscriber failures are isolated — one throwing
   * callback never blocks the others or the sweeper.
   */
  onBecameIdle(cb: () => void): () => void {
    this._idleSubscribers.add(cb);
    return () => {
      this._idleSubscribers.delete(cb);
    };
  }

  private _notifyBecameIdle(): void {
    for (const cb of [...this._idleSubscribers]) {
      try {
        cb();
      } catch (err) {
        console.warn(
          '[pool] became-idle subscriber failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /**
   * (Re-)arm the idle-hibernation timer to fire `idleTimeout` after the last
   * activity stamp. Called from `_touch` (every public entry point) and from
   * the warm sweeper when an eviction may have just made the pool non-busy.
   * When the timer fires while the pool is still busy it simply does not
   * re-arm — the next lifecycle edge (a tool call's `_touch`, an `endDrive`,
   * a warm eviction) arms it again, so the check never runs on a polling
   * tick.
   */
  private _armIdleTimer(): void {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = null;
    if (this._idleTimeout <= 0) return;
    const delay = Math.max(0, this._idleTimeout - (Date.now() - this._lastActivity));
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this.busy()) return;
      trace('[pool] Idle timeout, hibernating browser');
      // Only close a driver that was actually constructed — hibernating a
      // never-used pool must not force-load the driver just to close nothing.
      if (this._driverInstance) void this._driverInstance.closeBrowser();
    }, delay);
    this._idleTimer.unref();
  }

  async createSession(opts: SessionOptions = {}): Promise<Session> {
    this._touch();

    const freshContext = opts.freshContext === true;

    // Warm-pool fast path: if there's an idle warm lease for this
    // (platform, identity) tuple, mint a fresh Session, bind the lease onto
    // it, and reset via driver.resetSession instead of spawning a new
    // context. Same-platform-different-identity calls correctly miss and
    // cold-spawn — cookie-jar bleed across accounts is not allowed.
    // A fresh-context session bypasses both checkout and registration so its
    // BrowserContext cannot inherit or later export page-local state.
    // Otherwise, falls through to cold spawn on any failure (stale context,
    // reset error, busy slot, device-profile mismatch, no platform).
    const key = opts.platform ? warmKey(opts.platform, opts.identity) : null;
    if (!freshContext && this._warmEnabled && key) {
      const warm = this._warm.get(key);
      if (warm && !warm.inUse && warm.lease) {
        const reused = await this._reuseWarm(warm, opts);
        if (reused) return reused;
      }
    }

    const session = await this._driver.createSession(opts);
    if (opts.platform) session.platform = opts.platform;
    if (opts.identity) session.identity = opts.identity;
    session.origin = isDrivenByExternalMcpHost() ? 'mcp' : 'cli';
    session.startedAt = Date.now();
    this._sessions.set(session.id, session);

    if (!freshContext && this._warmEnabled && opts.platform && key && !this._warm.has(key)) {
      this._evictIfNeeded();
      this._warm.set(key, {
        platform: opts.platform,
        identity: opts.identity || DEFAULT_IDENTITY,
        lease: null,
        sessionId: session.id,
        deviceFingerprint: deviceFingerprintOf(opts),
        lastUsedAt: Date.now(),
        inUse: true,
      });
    }

    return session;
  }

  /**
   * The single constructor for pool-minted logical sessions — the warm
   * checkout path and `createNodeOnlySession` both build their Session here
   * so field treatment can't drift between them. Every field starts fresh:
   * a session minted against a warm lease begins with the same blank
   * logical state a cold spawn gets.
   */
  private _mintSession(opts: {
    platform?: string;
    identity?: string;
    hasTouch?: boolean;
    isMobile?: boolean;
  }): Session {
    const session: Session = {
      id: 'sess_' + crypto.randomBytes(6).toString('hex'),
      intercepted: [],
      intercepting: false,
      hasTouch: opts.hasTouch === true,
      isMobile: opts.isMobile === true,
      wsFrames: [],
      subPages: [],
      origin: isDrivenByExternalMcpHost() ? 'mcp' : 'cli',
      startedAt: Date.now(),
    };
    if (opts.platform) session.platform = opts.platform;
    if (opts.identity) session.identity = opts.identity;
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
    const session = this._mintSession(opts);
    this._sessions.set(session.id, session);
    return session;
  }

  /**
   * Check out a warm slot for a new klura session. Mints a FRESH Session
   * (blank logical state), binds the slot's lease onto it via
   * `driver.attachLease`, asks the driver to reset ephemeral browser state,
   * and registers the new session. Returns `null` on any failure — the
   * caller falls through to a cold spawn and the stale warm entry is
   * evicted. A device-profile mismatch also evicts: the lease's
   * BrowserContext was created with context-creation-time settings
   * (UA, viewport, touch, mobile emulation) that a reset cannot change.
   */
  private async _reuseWarm(warm: WarmEntry, opts: SessionOptions): Promise<Session | null> {
    const key = warmKey(warm.platform, warm.identity);
    const lease = warm.lease;
    if (!lease) return null;

    if (deviceFingerprintOf(opts) !== warm.deviceFingerprint) {
      trace(
        `[pool] warm slot for platform=${warm.platform} identity=${warm.identity} has a different device profile — evicting for cold spawn`,
      );
      this._warm.delete(key);
      try {
        await this._driver.destroyLease(lease);
      } catch {
        /* already dead */
      }
      return null;
    }

    // Claim the slot synchronously — before any await — so a concurrent
    // createSession for the same (platform, identity) sees `inUse` and
    // cold-spawns instead of racing attachLease for the same lease record
    // (the loser's attach throw would evict the slot mid-checkout and then
    // register a duplicate entry, breaking the one-slot-per-key invariant).
    warm.lease = null;
    warm.sessionId = null;
    warm.inUse = true;
    warm.lastUsedAt = Date.now();

    const session = this._mintSession(opts);
    let attached = false;
    try {
      this._driver.attachLease(session, lease);
      attached = true;
      await this._driver.resetSession(session, opts);
    } catch (err) {
      console.warn(
        `[pool] warm reuse for platform=${warm.platform} identity=${warm.identity} failed, falling back to cold spawn:`,
        err instanceof Error ? err.message : String(err),
      );
      // Drop the claimed slot before the async teardown so a concurrent
      // checkout can register a fresh entry immediately.
      this._warm.delete(key);
      // Stale context — force-destroy so nothing is left hanging. The minted
      // Session was never registered, so it just falls out of scope.
      try {
        if (attached) await this._driver.destroySession(session);
        else await this._driver.destroyLease(lease);
      } catch {
        /* already dead */
      }
      return null;
    }

    warm.sessionId = session.id;
    warm.lastUsedAt = Date.now();

    this._sessions.set(session.id, session);
    trace(`[pool] warm-reused context for platform=${warm.platform} (session ${session.id})`);
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

    // Warm slot first — the borrow deliberately skips resetSession, so the
    // page is still on whatever URL the previous borrow left it at. A fresh
    // Session is minted and the slot's lease bound onto it before the probe
    // runs (the probe needs a live page binding); a failed probe detaches the
    // lease straight back into the slot. The (platform, identity) tuple keys
    // the slot — same-platform-different-identity calls correctly miss so
    // cookie jars don't leak across accounts.
    const warm = this._warm.get(warmKey(platform, identity));
    if (this._warmEnabled && warm && !warm.inUse && warm.lease) {
      // The minted session self-describes as the device the lease's context
      // was actually created with — the borrow has no SessionOptions to
      // consult, but the slot remembers.
      const fp = JSON.parse(warm.deviceFingerprint) as {
        hasTouch?: boolean;
        isMobile?: boolean;
      };
      const session = this._mintSession({
        platform,
        identity,
        hasTouch: fp.hasTouch,
        isMobile: fp.isMobile,
      });
      let attached: boolean;
      try {
        this._driver.attachLease(session, warm.lease);
        attached = true;
      } catch {
        attached = false;
      }
      if (attached) {
        // Claim the slot synchronously before the probe awaits (mirrors
        // _reuseWarm): concurrent checkouts and the TTL sweeper must see
        // the slot as busy while the probe is in flight.
        warm.lease = null;
        warm.sessionId = session.id;
        warm.inUse = true;
        warm.lastUsedAt = Date.now();
        let ok: boolean;
        try {
          ok = await probe(session, this._driver);
        } catch {
          ok = false;
        }
        if (ok) {
          session.borrowed = true;
          this._sessions.set(session.id, session);
          trace(
            `[pool] ready-checkout warm session for platform=${platform} (session ${session.id})`,
          );
          return session;
        }
        // Probe said not-ready — return the resources to the slot and let
        // the caller cold-spawn. The minted Session was never registered.
        warm.sessionId = null;
        warm.inUse = false;
        warm.lastUsedAt = Date.now();
        warm.lease = this._detachLeaseSafe(session);
        if (!warm.lease) {
          // Undetachable after a successful attach — the context is still
          // bound to the minted session. Destroy it so nothing leaks, then
          // drop the slot (mirrors the endDrive undetachable branch).
          this._warm.delete(warmKey(platform, identity));
          try {
            await this._driver.destroySession(session);
          } catch {
            /* already destroyed */
          }
        }
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

  /** Pure lookup — mutates nothing beyond the pool's idle-liveness stamp.
   *  Round accounting happens exclusively via `registerUserRound`, called
   *  by the phase middleware once per admitted non-universal tool call. */
  getSession(id: string): Session {
    const session = this._sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    this._touch();
    return session;
  }

  /** Read a live session without stamping pool idle-liveness. Returns null
   *  instead of throwing on an unknown id. For out-of-band observers —
   *  harness evidence collectors and tests asserting whether an id is
   *  still valid — that must not perturb idle tracking or blow up on an
   *  already-closed session. Tool handlers on the request path use
   *  `getSession`; observers are the only intended callers here. */
  peekSession(id: string): Session | null {
    return this._sessions.get(id) ?? null;
  }

  /** Register one admitted user-facing tool round against a session. The
   *  phase middleware (`assertToolAdmissibleBySessionId`) is the single
   *  caller — handlers looking sessions up via `getSession` add nothing. */
  registerUserRound(id: string): void {
    if (!this._sessions.has(id)) return;
    this._sessionRoundCounts.set(id, (this._sessionRoundCounts.get(id) ?? 0) + 1);
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

  /** Count of admitted non-universal tool calls against this session —
   *  see `registerUserRound`. Session lookups never affect it. */
  getSessionRoundCount(sessionId: string): number {
    return this._sessionRoundCounts.get(sessionId) ?? 0;
  }

  /**
   * Run every registered session-scope cleanup hook for a dying id — see
   * `runtime/src/pool/session-scope.ts`. Called on exactly the `endDrive`
   * branches where the session id stops being valid; the borrowed-shared
   * keep-alive branch (id survives, owner still registered) and the
   * unknown-id early return deliberately skip it. `disposeSessionScope`
   * isolates per-hook failures and never throws; the extra guard here keeps
   * teardown alive even against a scope-internal defect, since endDrive runs
   * inside many `finally` blocks.
   */
  private async _disposeScope(id: string): Promise<void> {
    try {
      await disposeSessionScope(id);
    } catch (err) {
      console.warn(
        `[pool] session-scope disposal failed for ${id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Drop per-session feedback state (try_generator stats/diffs, user-round
   *  counter) for a dying id. Called on exactly the `endDrive` branches where
   *  the session id stops being valid — the borrowed-shared keep-alive branch
   *  keeps the id (and therefore its counters) live for the registrar. Even
   *  when the underlying browser context returns to the warm pool, the klura
   *  session id rotates on next checkout (see `_reuseWarm`), so counters are
   *  session-id-keyed, not context-keyed. */
  private _dropSessionFeedback(id: string): void {
    this._tryGeneratorStats.delete(id);
    this._recentDiffs.delete(id);
    this._sessionRoundCounts.delete(id);
  }

  /** `driver.detachLease` with stub-driver tolerance: plain-object test
   *  drivers may not implement the lease surface, and a detach that throws
   *  means the resources are unstashable — both map to null so the caller
   *  destroys instead. */
  private _detachLeaseSafe(session: Session): BrowserLease | null {
    if (typeof this._driver.detachLease !== 'function') return null;
    try {
      return this._driver.detachLease(session);
    } catch {
      return null;
    }
  }

  async endDrive(id: string): Promise<void> {
    this._touch();
    const session = this._sessions.get(id);
    if (!session) {
      // Still might be a shared session tracked only in _sharedSessions
      // (listener-owned, never put into _sessions). Let the listener's own
      // endDrive call catch it when it tears down. The id is not valid in
      // this pool, so any feedback state recorded under it is dead — drop it.
      this._dropSessionFeedback(id);
      return;
    }

    // Borrowed session via `tryCheckoutReadySession`: either someone else
    // owns it (shared registration — no-op, the owner manages teardown) or
    // the pool minted it against a warm slot (detach the lease back into the
    // slot without resetSession — the page is still useful for the next
    // borrower). Either way, do NOT destroy.
    if (session.borrowed) {
      session.borrowed = false;
      // Shared keep-alive comes FIRST. A session still registered in
      // `_sharedSessions` is owned by someone else (a listener, or the
      // agent session that start_session registers around auto-execute) —
      // the owner still holds the id and will make tool calls against it,
      // so keep the id valid and touch nothing. The order matters when the
      // same session also owns its platform's warm slot (a cold spawn
      // registers the slot with `sessionId = id` while `inUse` is true):
      // consulting the warm slot first would detach-strip a LIVE session's
      // driver bindings and stash them, bricking the owner's id. Warm-slot
      // borrows are freshly minted by `tryCheckoutReadySession` and never
      // shared-registered, so they fall through to the warm branch below.
      // The owner's own teardown routes back through endDrive with
      // `borrowed` unset, where the warm/cold branches run for real.
      if (session.platform) {
        const sharedForPlatform = this._sharedSessions.get(session.platform);
        if (sharedForPlatform?.has(session)) {
          trace(
            `[pool] borrowed shared session ${id} released (still owned by its registrar; keeping id valid)`,
          );
          return;
        }
      }
      if (this._warmEnabled && session.platform) {
        const warm = this._warm.get(warmKey(session.platform, session.identity));
        if (warm && warm.sessionId === id) {
          const lease = this._detachLeaseSafe(session);
          this._sessions.delete(id);
          this._dropSessionFeedback(id);
          // The borrowed Session dies here whether the lease restashes or
          // not — run its scope disposal before the browser resources move.
          await this._disposeScope(id);
          if (lease) {
            warm.lease = lease;
            warm.sessionId = null;
            warm.inUse = false;
            warm.lastUsedAt = Date.now();
            trace(
              `[pool] borrowed session ${id} released back to warm slot for platform=${session.platform} identity=${warm.identity}`,
            );
            return;
          }
          // Undetachable — drop the slot and destroy for real.
          this._warm.delete(warmKey(session.platform, session.identity));
          try {
            await this._driver.destroySession(session);
          } catch {
            /* already destroyed */
          }
          return;
        }
      }
      // Shared session no longer registered — owner already disposed.
      // Drop the id; the underlying BrowserContext lifecycle is the
      // owner's responsibility.
      this._sessions.delete(id);
      this._dropSessionFeedback(id);
      await this._disposeScope(id);
      trace(`[pool] borrowed shared session ${id} released (owner gone, dropping id)`);
      return;
    }

    // Every non-borrowed path below kills the id — warm stash, undetachable
    // fall-through, or cold destroy — so its feedback state dies with it.
    this._dropSessionFeedback(id);

    // Every non-borrowed release kills the id (a warm stash mints a fresh
    // Session on the next checkout), so a shared registration — a listener
    // tearing its session down via endDrive — must be cleared on every path
    // below. A stashed session left in `_sharedSessions` would be iterated
    // forever by `tryCheckoutReadySession` as a dead candidate: detachLease
    // strips its driver bindings, so its probe can only throw.
    if (session.platform) {
      const shared = this._sharedSessions.get(session.platform);
      if (shared?.has(session)) {
        shared.delete(session);
        if (shared.size === 0) this._sharedSessions.delete(session.platform);
      }
    }

    // Warm path: if the session is bound to a platform and owns that
    // platform's warm slot, detach the browser resources as a lease and
    // stash them in the slot. The Session object dies HERE — the next
    // createSession for the same platform mints a fresh one and binds the
    // lease onto it (_reuseWarm), which is what makes logical-state leakage
    // across klura sessions structurally impossible. Drivers without a
    // lease surface return null and the session falls through to destroy.
    if (this._warmEnabled && session.platform) {
      const warm = this._warm.get(warmKey(session.platform, session.identity));
      if (warm && warm.sessionId === id) {
        const lease = this._detachLeaseSafe(session);
        if (lease) {
          warm.lease = lease;
          warm.sessionId = null;
          warm.inUse = false;
          warm.lastUsedAt = Date.now();
          this._sessions.delete(id);
          await this._disposeScope(id);
          trace(
            `[pool] session ${id} released warm context for platform=${session.platform} identity=${warm.identity} (idle)`,
          );
          return;
        }
        // No detachable resources — drop the slot and fall through to the
        // cold teardown below.
        this._warm.delete(warmKey(session.platform, session.identity));
      }
    }

    // Cold path.
    // Drop the id before the scope runs so a hook that (indirectly) re-enters
    // endDrive for the same id hits the unknown-id early return instead of a
    // second driver teardown.
    this._sessions.delete(id);
    await this._disposeScope(id);
    try {
      await this._driver.destroySession(session);
    } catch {
      /* already destroyed */
    }
  }

  get activeSessions(): number {
    return this._sessions.size;
  }

  /** Ids of every live session. Used by capture-journal recovery to skip
   *  folding a journal whose session is still writing. */
  get activeSessionIds(): string[] {
    return [...this._sessions.keys()];
  }

  get idleSince(): number {
    return Math.floor((Date.now() - this._lastActivity) / 1000);
  }

  /** Whether sessions this pool creates run in connect mode. */
  get connectEnabled(): boolean {
    return this._connectEnabled;
  }

  async shutdown(): Promise<void> {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._warmSweeper) {
      clearInterval(this._warmSweeper);
      this._warmSweeper = null;
    }
    for (const id of [...this._sessions.keys()]) {
      await this.endDrive(id);
    }
    // Evict every remaining warm lease. endDrive above would have
    // released in-use warm slots to the idle pool; this final sweep destroys
    // them before closing the browser.
    for (const [key, warm] of this._warm) {
      if (warm.lease) {
        try {
          await this._driver.destroyLease(warm.lease);
        } catch {
          /* already destroyed */
        }
      }
      // jsEvalCache is platform-scoped — different identities on the same
      // platform share the cache, which is the correct policy (the JS body
      // doesn't depend on which account's cookies are loaded).
      this.jsEvalCache.cancel(warm.platform);
      trace(`[pool] shutdown: evicted warm context (key=${key})`);
    }
    this._warm.clear();
    this.jsEvalCache.shutdown();
    // Only close a driver we actually built. If no session ever ran, the driver
    // was never constructed — don't force-construct it (which could itself throw
    // on a bad pool.driver) just to close nothing.
    if (this._driverInstance) await this._driverInstance.closeBrowser();
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
      if (victim.lease) this._driver.destroyLease(victim.lease).catch(() => undefined);
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
      let evicted = false;
      for (const [key, entry] of [...this._warm]) {
        if (entry.inUse) continue;
        if (now - entry.lastUsedAt > this._warmTtlMs) {
          if (entry.lease) this._driver.destroyLease(entry.lease).catch(() => undefined);
          this._warm.delete(key);
          this.jsEvalCache.cancel(entry.platform);
          evicted = true;
          trace(
            `[pool] TTL evicted warm context (key=${key}, idle=${Math.floor((now - entry.lastUsedAt) / 1000)}s)`,
          );
        }
      }
      // An eviction is a lifecycle edge for the idle-hibernation decision:
      // dropping the last warm slot may have just made the pool non-busy, and
      // no `_touch` fires here to re-arm the timer. Deliberately not a stamp
      // of `_lastActivity` — eviction is not user activity, so the timer
      // fires against the true last-activity time (possibly immediately).
      // The same edge notifies became-idle subscribers (the daemon's idle
      // shutdown), since no RPC arrives to re-arm their timers either.
      if (evicted && !this.busy()) {
        this._armIdleTimer();
        this._notifyBecameIdle();
      }
    }, 60_000);
    this._warmSweeper.unref();
  }
}
