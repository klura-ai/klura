// SessionScope — the single owner of per-session teardown.
//
// Any subsystem that stores session-keyed state (pending checkpoints, pending
// interruptions, paused recorded-path executions, auto-execute aliases,
// starter caches, session observations, logbook dedupe sets, capture
// journals, remote viewers) registers a named cleanup hook here AT THE WRITE
// SITE. `Pool.endDrive` invokes `disposeSessionScope` on every path where a
// session id dies — clean close, abort, pool eviction/TTL/shutdown, and error
// teardown all converge on it — so no close path needs to know which modules
// hold state for the session.
//
// The scope also owns parent/child session topology: a recorded-path pause
// that outlives its executor registers the inner session as a child of the
// outer (agent-known) session via `adoptChildSession`. Disposing the parent
// disposes children first, so aborting the outer session can never leak the
// inner browser context.
//
// Dependency-free by design: `pool.ts` imports this module, and every
// higher-level module (checkpoints, tools, execution, response, remote) may
// import it too, without cycles.

/** Cleanup hook registered against one session id. Must be safe to call more
 *  than once — dispose is idempotent but callers may also clear eagerly. */
export type SessionDisposeHook = () => void | Promise<void>;

export interface SessionDisposeFailure {
  /** Name the hook was registered under. */
  hook: string;
  error: unknown;
}

/** Hook name prefix reserved for child-session closers registered via
 *  `adoptChildSession`. Dispose runs these before every other hook. */
const CHILD_HOOK_PREFIX = 'close-child:';

// Per-session named hooks. The inner Map preserves registration order;
// dispose runs the non-child hooks in reverse (LIFO).
const scopes = new Map<string, Map<string, SessionDisposeHook>>();

// Parent/child topology index. `childrenOf` mirrors the `close-child:*`
// hooks so callers can query the tree without string-parsing hook names;
// `parentOf` is the reverse edge, used to unlink a child that dies on its
// own before its parent does.
const childrenOf = new Map<string, Set<string>>();
const parentOf = new Map<string, string>();

// Reentrancy guard: a child's close hook routes through `pool.endDrive`,
// which re-enters `disposeSessionScope` for the child's own id. The guard
// makes any same-id re-entry (including pathological cycles) a no-op.
const disposing = new Set<string>();

/**
 * Register (or replace) the cleanup hook `name` for `sessionId`. Idempotent
 * per `(sessionId, name)`: re-registering keeps a single hook in the slot's
 * original position, so write sites may call this on every write without
 * accumulating duplicates.
 */
export function onSessionDispose(sessionId: string, name: string, hook: SessionDisposeHook): void {
  if (!sessionId || !name) return;
  let hooks = scopes.get(sessionId);
  if (!hooks) {
    hooks = new Map();
    scopes.set(sessionId, hooks);
  }
  hooks.set(name, hook);
}

/** Remove the hook `name` for `sessionId` (e.g. when the state it guards was
 *  cleared eagerly by a committed ack or a consumed pause). No-op when the
 *  session has no scope or no such hook. */
export function removeSessionDisposeHook(sessionId: string, name: string): void {
  const hooks = scopes.get(sessionId);
  if (!hooks) return;
  hooks.delete(name);
  if (hooks.size === 0 && !childrenOf.has(sessionId)) scopes.delete(sessionId);
}

/**
 * Register `childId` as a child session of `parentId`. `closeChild` is the
 * closer the parent's disposal invokes FIRST — canonically
 * `() => pool.endDrive(childId)`, which re-enters the scope for the child's
 * own hooks. The topology is queryable via `childSessionsOf` /
 * `parentSessionOf`, and self-heals: a child that dies on its own unlinks
 * itself from the parent during its dispose.
 */
export function adoptChildSession(
  parentId: string,
  childId: string,
  closeChild: SessionDisposeHook,
): void {
  if (!parentId || !childId || parentId === childId) return;
  onSessionDispose(parentId, CHILD_HOOK_PREFIX + childId, closeChild);
  let kids = childrenOf.get(parentId);
  if (!kids) {
    kids = new Set();
    childrenOf.set(parentId, kids);
  }
  kids.add(childId);
  parentOf.set(childId, parentId);
}

/** Undo an adoption without closing anything — used when the child's
 *  lifecycle ends by other means. Safe to call for a pair that was never
 *  adopted. */
export function releaseChildSession(parentId: string, childId: string): void {
  const kids = childrenOf.get(parentId);
  if (kids) {
    kids.delete(childId);
    if (kids.size === 0) childrenOf.delete(parentId);
  }
  if (parentOf.get(childId) === parentId) parentOf.delete(childId);
  removeSessionDisposeHook(parentId, CHILD_HOOK_PREFIX + childId);
}

/** Parent session id of `childId`, when it was adopted and neither side has
 *  disposed. */
export function parentSessionOf(childId: string): string | undefined {
  return parentOf.get(childId);
}

/** Live child session ids of `parentId` (snapshot). */
export function childSessionsOf(parentId: string): string[] {
  return [...(childrenOf.get(parentId) ?? [])];
}

/** Whether any hooks or children are currently registered for `sessionId`. */
export function hasSessionScope(sessionId: string): boolean {
  return scopes.has(sessionId) || childrenOf.has(sessionId);
}

/**
 * Run and discard every cleanup hook for `sessionId`. THE single disposal
 * path — `Pool.endDrive` calls it on every id-death branch, which clean
 * close, abort, eviction, TTL, shutdown, and error teardown all route
 * through.
 *
 * Semantics:
 * - **Children first.** `close-child:*` hooks run before the session's own
 *   hooks, newest adoption first; each closer re-enters the scope for the
 *   child's own hooks via `pool.endDrive`.
 * - **Own hooks LIFO.** Later registrations are torn down first.
 * - **Exception-isolated.** A throwing hook never skips the rest; failures
 *   are aggregated into the return value and summarized on stderr.
 * - **Idempotent + reentrancy-guarded.** A second call (concurrent or
 *   nested) for the same id is a no-op.
 *
 * Never throws.
 */
export async function disposeSessionScope(sessionId: string): Promise<SessionDisposeFailure[]> {
  if (!sessionId || disposing.has(sessionId)) return [];
  disposing.add(sessionId);
  try {
    // Detach the scope up-front so eager clears invoked BY hooks (which call
    // removeSessionDisposeHook) and concurrent dispose calls both see an
    // empty scope.
    const hooks = scopes.get(sessionId);
    scopes.delete(sessionId);

    // Unlink from a still-live parent so the parent never runs a stale
    // close-child hook for an id that already died.
    const parent = parentOf.get(sessionId);
    if (parent !== undefined) releaseChildSession(parent, sessionId);

    const failures: SessionDisposeFailure[] = [];
    if (hooks) {
      const entries = [...hooks.entries()].reverse();
      const ordered = [
        ...entries.filter(([name]) => name.startsWith(CHILD_HOOK_PREFIX)),
        ...entries.filter(([name]) => !name.startsWith(CHILD_HOOK_PREFIX)),
      ];
      for (const [name, hook] of ordered) {
        try {
          await hook();
        } catch (error) {
          failures.push({ hook: name, error });
        }
      }
    }

    // Drop any residual child index entries (children normally unlink
    // themselves when their closer re-enters dispose; this covers closers
    // that failed or were registered without going through adoption).
    const kids = childrenOf.get(sessionId);
    if (kids) {
      for (const kid of kids) {
        if (parentOf.get(kid) === sessionId) parentOf.delete(kid);
      }
      childrenOf.delete(sessionId);
    }

    if (failures.length > 0) {
      console.warn(
        `[session-scope] ${failures.length} dispose hook(s) failed for ${sessionId}: ` +
          failures.map((f) => f.hook).join(', '),
      );
    }
    return failures;
  } finally {
    disposing.delete(sessionId);
  }
}

/** Test-only reset. Drops every scope and topology edge without running
 *  hooks. */
export function _resetSessionScopesForTests(): void {
  scopes.clear();
  childrenOf.clear();
  parentOf.clear();
  disposing.clear();
}
