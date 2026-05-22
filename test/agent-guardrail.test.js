// Lock-down test for the CLI agent guardrail.
//
// The optional CLI LLM agent must NEVER run when klura is driven by an
// external MCP host. The agent shim ships inside @klura/runtime
// (runtime/agent/); the LLM SDKs live in the separate, on-demand provider
// packages (@klura/agent-openai, @klura/agent-claude-code).
//
// Layers pinned here:
//   1. process flag — markExternalMcpHost() / isDrivenByExternalMcpHost();
//      every agent entry point hard-throws while it is set. This is the
//      load-bearing guarantee.
//   2. session origin — a session whose origin is 'mcp' is off-limits.
//   3. structural — mcp/index.js latches the flag, and pulls in neither
//      provider package, so the LLM SDKs are never present in the MCP
//      server process.
//
// Ordering matters: the flag is one-way (no un-set, by design), so every
// "allowed" assertion runs before the "blocked" ones.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const agent = require('../agent');
const klura = require('..');

test('agent is allowed in a fresh process (no external MCP host)', () => {
  assert.strictEqual(klura.isDrivenByExternalMcpHost(), false);
  assert.strictEqual(agent.isAgentAllowed(), true);
});

test('a session with origin "mcp" is off-limits even before the flag is set', () => {
  assert.strictEqual(agent.isAgentAllowed({ origin: 'mcp' }), false);
  assert.strictEqual(agent.isAgentAllowed({ origin: 'cli' }), true);
});

test('merely loading @klura/mcp does not trip the flag', () => {
  // Requiring the MCP package exposes createKluraMcpServer but must not latch
  // the guardrail — only mcp/index.js main() does that.
  require('../../mcp');
  assert.strictEqual(klura.isDrivenByExternalMcpHost(), false);
  assert.strictEqual(agent.isAgentAllowed(), true);
});

test('mcp/index.js latches the flag; the server factory does not', () => {
  const mcpSrc = fs.readFileSync(path.join(here, '..', '..', 'mcp', 'index.js'), 'utf8');
  // Layer 1: mcp/index.js main() latches the flag.
  assert.match(mcpSrc, /markExternalMcpHost\(\)/, 'mcp/index.js must call markExternalMcpHost()');
  // Layer 3: the MCP server process must never load a provider package — that
  // is where the LLM SDKs live. (The lightweight shim ships inside
  // @klura/runtime, which mcp legitimately requires; it is inert there because
  // every entry point checks the flag.)
  const importsProvider =
    /['"]@klura\/agent-[a-z-]+['"]/.test(mcpSrc) ||
    /\brequire\(\s*['"][^'"]*agent-(openai|claude)[^'"]*['"]\s*\)/.test(mcpSrc);
  assert.ok(!importsProvider, 'mcp/index.js must not require/import a provider package');
  // The server factory itself (runtime/mcp-server.js) must NOT latch the flag —
  // the CLI agent and the harnesses call createKluraMcpServer() legitimately
  // over an in-memory transport. Only mcp/index.js's stdio path latches it.
  const factorySrc = fs.readFileSync(path.join(here, '..', 'mcp-server.js'), 'utf8');
  assert.match(factorySrc, /async function createKluraMcpServer/, 'mcp-server.js shape changed');
  assert.ok(
    !factorySrc.includes('markExternalMcpHost'),
    'createKluraMcpServer (runtime/mcp-server.js) must not latch the guardrail flag',
  );
});

test('after markExternalMcpHost(): every agent entry point is blocked', async () => {
  klura.markExternalMcpHost();
  assert.strictEqual(agent.isAgentAllowed(), false);

  assert.throws(() => agent.assertAgentAllowed('test'), { name: 'AgentBlockedError' });

  await assert.rejects(agent.runChatAgent({ agent: { provider: 'openai' } }), {
    name: 'AgentBlockedError',
  });
  await assert.rejects(
    agent.runRecoveryAgent({ agent: { provider: 'openai' }, platform: 'x', capability: 'y' }),
    { name: 'AgentBlockedError' },
  );
  await assert.rejects(
    agent.runAgentTask({ agent: { provider: 'openai' }, goal: 'g', onTurnEnd: async () => null }),
    { name: 'AgentBlockedError' },
  );
});
