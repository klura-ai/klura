'use strict';

// The CLI agent guardrail — the load-bearing reason the agent shim is safe to
// ship inside the klura runtime package.
//
// The optional CLI LLM agent must NEVER run when klura is being driven by an
// external MCP host (Claude Desktop, Cursor, Claude Code, ...). That host
// already supplies an LLM; a second one underneath it would race the session
// the host believes it controls. The runtime latches a process-level flag
// (`markExternalMcpHost()`, set only by `mcp/index.js`); this module reads it
// and is consulted by every agent entry point before any LLM call.
//
// Two layers, checked together:
//   1. Process flag — `isDrivenByExternalMcpHost()` from the runtime.
//   2. Session origin — a session whose `origin` is `'mcp'` is off-limits.
//
// Fail closed: a runtime too old to expose the flag cannot prove it is not
// under an MCP host, so the agent refuses rather than guesses.

const { loadKluraRuntime } = require('./klura-modules');

class AgentBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentBlockedError';
  }
}

/**
 * @param {{ origin?: string } | undefined} [session] optional session to check.
 * @returns {boolean} true only when it is safe to run the CLI LLM agent.
 */
function isAgentAllowed(session) {
  const klura = loadKluraRuntime();
  if (typeof klura.isDrivenByExternalMcpHost !== 'function') return false;
  if (klura.isDrivenByExternalMcpHost()) return false;
  if (session && session.origin === 'mcp') return false;
  return true;
}

/**
 * Throw `AgentBlockedError` unless the CLI LLM agent is allowed to run.
 * @param {string} where short label naming the entry point, for the message.
 * @param {{ origin?: string }} [session]
 */
function assertAgentAllowed(where, session) {
  if (isAgentAllowed(session)) return;
  throw new AgentBlockedError(
    `klura CLI agent refused to run (${where}): klura is being driven by an ` +
      `external MCP host, which already provides the LLM. The CLI agent only ` +
      `runs from a direct \`klura\` CLI invocation.`,
  );
}

module.exports = { isAgentAllowed, assertAgentAllowed, AgentBlockedError };
