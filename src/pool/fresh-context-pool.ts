import type { BrowserPool, Session, SessionOptions } from '../drivers/types/session';
import type { BrowserDriver } from '../drivers/interface';

/**
 * Identity slot for a session created without an explicit identity. Mirrors
 * `pool.ts` so the two agree on what "no identity" means.
 */
const DEFAULT_IDENTITY = 'default';

/**
 * Context key for the run scope: `(platform, identity)`, mirroring `warmKey`
 * in `pool.ts`. One context per pair rather than one per run, because a
 * capability prereq may target a different platform and cookie-jar bleed
 * across identities is the exact invariant the warm pool protects.
 */
function contextKey(platform: string | undefined, identity: string | undefined): string {
  return `${platform ?? ''}::${identity || DEFAULT_IDENTITY}`;
}

/**
 * Run a verification body against a run-scoped browser-pool facade, then tear
 * every context the run created down.
 *
 * Verification must observe only state established by the strategy under test,
 * and every step of one verification run must observe the same browser state.
 * The facade therefore:
 *
 * - omits ready-page checkout, so active discovery/listener pages are invisible;
 * - omits the shared js-eval cache, so prerequisites execute against this run;
 * - strips persisted storage state, so cookies/local storage from discovery are
 *   not implicit inputs;
 * - requires `freshContext` on every created session, so the backing pool skips
 *   warm-context reuse and destroys the context on close; and
 * - keeps one context per `(platform, identity)` alive for the whole run, so a
 *   consent click, login, or any other prereq side effect is still there when
 *   the request that depends on it fires.
 *
 * `endDrive` is a no-op for run-owned sessions — the run, not an individual
 * executor, owns their lifetime. Teardown happens exactly once, in `finally`,
 * so a throwing body cannot leak a context.
 *
 * Browser prerequisites declared by the strategy run normally inside the run's
 * context before its request is fired.
 */
export async function withFreshVerificationPool<T>(
  base: BrowserPool,
  fn: (pool: BrowserPool) => Promise<T>,
): Promise<T> {
  const contexts = new Map<string, Promise<Session>>();
  const ownedIds = new Set<string>();
  let disposed = false;

  const pool: BrowserPool = {
    async createSession(opts: SessionOptions = {}): Promise<Session> {
      const freshOpts = { ...opts };
      delete freshOpts.storageState;
      if (disposed) {
        // Past teardown the run owns nothing more; hand the caller a session it
        // closes itself rather than one nobody will.
        return await base.createSession({ ...freshOpts, internal: true, freshContext: true });
      }
      const key = contextKey(opts.platform, opts.identity);
      let pending = contexts.get(key);
      if (!pending) {
        pending = base
          .createSession({ ...freshOpts, internal: true, freshContext: true })
          .then((session) => {
            ownedIds.add(session.id);
            return session;
          })
          .catch((err: unknown) => {
            // A failed spawn must not poison the slot — the next prereq for the
            // same (platform, identity) gets to try again.
            contexts.delete(key);
            throw err;
          });
        contexts.set(key, pending);
      }
      return await pending;
    },

    createNodeOnlySession(opts?: { platform?: string; identity?: string }): Session {
      return base.createNodeOnlySession(opts);
    },

    async endDrive(sessionId: string): Promise<void> {
      if (ownedIds.has(sessionId)) return;
      await base.endDrive(sessionId);
    },

    getSession(sessionId: string): Session {
      return base.getSession(sessionId);
    },

    registerUserRound(sessionId: string): void {
      base.registerUserRound?.(sessionId);
    },

    driverFor(sessionId: string): BrowserDriver {
      return base.driverFor(sessionId);
    },

    async shutdown(): Promise<void> {
      await dispose();
    },

    get activeSessions(): number {
      return base.activeSessions;
    },

    get activeSessionIds(): string[] {
      return base.activeSessionIds;
    },

    get idleSince(): number {
      return base.idleSince;
    },

    get connectEnabled(): boolean {
      return base.connectEnabled;
    },
  };

  // Sequential and exception-isolated: one context that refuses to close must
  // not strand the rest. Ids stay in `ownedIds` so a late `endDrive` from an
  // executor unwinding after disposal cannot double-close.
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    const pending = [...contexts.values()];
    contexts.clear();
    for (const entry of pending) {
      let session: Session;
      try {
        session = await entry;
      } catch {
        continue;
      }
      try {
        await base.endDrive(session.id);
      } catch {
        /* teardown is best-effort; a stuck context must not fail the run */
      }
    }
  }

  try {
    return await fn(pool);
  } finally {
    await dispose();
  }
}
