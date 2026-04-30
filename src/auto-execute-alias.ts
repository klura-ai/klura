// Outer→inner session-id alias for auto-execute paths.
//
// `start_session` opens an outer session the agent drives via
// `perform_action` and returns its id. When auto-execute fires for a
// recorded-path saved strategy, the executor cold-spawns a SECOND
// (inner) session — `runtime/src/execution/recorded-path.ts:78` — because
// recorded-path replay assumes a fresh DOM. The two sessions are real
// peers in the pool with distinct ids and distinct Playwright contexts.
//
// When the inner session pauses on a `recorded_step_failed` checkpoint:
//   - `pausedExecutions.set(innerId, ...)` registers the resumeable
//     state (`runtime/src/execution/recorded-path.ts`).
//   - `mintCheckpointToken` registers the pending-checkpoint entry under
//     `innerId` (`runtime/src/checkpoints/gate-glue.ts`).
//
// The agent only knows the outer id (returned from `start_session`), so
// `resume_execution(outerId)` and `ack_checkpoint(outerId)` both miss the
// inner-keyed entries. This module bridges that gap by tracking which
// outer id "owns" which inner id during the pause window. Both lookup
// sites consult the alias on miss before falling through.
//
// Lifetime mirrors `pausedExecutions` exactly: registered when the inner
// session pauses, cleared when the paused entry is consumed (resume
// success/failure).

const aliases = new Map<string, string>();

export function registerAutoExecuteAlias(outerId: string, innerId: string): void {
  aliases.set(outerId, innerId);
}

export function clearAutoExecuteAlias(outerId: string): void {
  aliases.delete(outerId);
}

export function resolveAutoExecuteAlias(outerId: string): string | undefined {
  return aliases.get(outerId);
}
