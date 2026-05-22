// Process-level flag: is this klura process being driven by an EXTERNAL MCP
// host (Claude Desktop, Cursor, Claude Code, ...)?
//
// It is set true in exactly one place — `mcp/index.js`'s `main()`, right
// before the stdio transport connects. The in-process MCP server that the
// optional CLI agent and the CI harnesses build via `createKluraMcpServer()`
// runs over an in-memory transport and does NOT set it.
//
// This is the load-bearing layer of the agent guardrail. The optional CLI LLM
// agent (`@klura/agent`) refuses to load or run whenever this is true, so a
// second LLM can never appear underneath the host that is already driving
// klura. The module is intentionally side-effect-free and dependency-free so
// the MCP entry point and the agent can import it without dragging in the
// daemon's pool backbone.

let externalMcpHost = false;

/** Latch the process as driven by an external MCP host. Idempotent, one-way —
 *  there is deliberately no way to clear it. Called only by `mcp/index.js`. */
export function markExternalMcpHost(): void {
  externalMcpHost = true;
}

/** True once `markExternalMcpHost()` has been called in this process. */
export function isDrivenByExternalMcpHost(): boolean {
  return externalMcpHost;
}
