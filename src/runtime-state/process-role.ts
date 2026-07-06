// Process-level flag: is this klura process the standalone background daemon
// (the one `startDaemon()` boots — an HTTP server + PID file that a separate,
// short-lived CLI client dials over `sendToDaemon`)?
//
// It is set true in exactly one place — `startDaemon()` in `daemon.ts`, as the
// server starts listening. Every embedded path leaves it false: the in-process
// MCP server that `klura chat` / `execute --agent` / the CI harnesses build
// over an in-memory transport, and an external MCP host driving klura over
// stdio (`mcp/index.js`).
//
// It is load-bearing for `restart_runtime`: exiting the process is only safe
// when a separate client will re-dial and auto-respawn the daemon. In every
// embedded case the runtime shares the process with the caller's session, so
// exiting would kill that session with nothing to respawn it. The module is
// side-effect-free and dependency-free so both the daemon entry point and the
// tool handlers can import it without dragging in the pool backbone.

let standaloneDaemon = false;

/** Latch this process as the standalone background daemon. Idempotent, one-way.
 *  Called only by `startDaemon()`. */
export function markStandaloneDaemon(): void {
  standaloneDaemon = true;
}

/** True once `markStandaloneDaemon()` has been called in this process. */
export function isStandaloneDaemon(): boolean {
  return standaloneDaemon;
}
