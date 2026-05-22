'use strict';

// In-process bridge to the klura MCP server.
//
// `@klura/agent` always drives klura through `createKluraMcpServer()` — the
// same server `@klura/mcp` connects to stdio for an external host — over an
// in-memory transport. That keeps the phase-gating and checkpoint-gating
// middleware identical to the MCP path; the agent does not get a privileged
// back door into the tool registry.
//
// The Claude Agent SDK consumes the server instance directly (`{type:'sdk',
// instance}`). OpenAI-compatible providers have no MCP transport of their own,
// so `bridgeServer()` wires an in-memory MCP client and exposes the tool list
// pre-translated to OpenAI function schema plus a `dispatch()` callback.

const { loadKluraMcp } = require('./klura-modules');

/** Create a fresh, unconnected klura MCP server instance. */
async function createKluraServer() {
  const { createKluraMcpServer } = loadKluraMcp();
  return createKluraMcpServer();
}

/**
 * Connect an in-memory MCP client to `server` and return the tool surface a
 * chat-completions provider needs: `{ tools, toolNames, dispatch, close }`.
 * `tools` is already in OpenAI `{type:'function', function:{...}}` shape.
 */
async function bridgeServer(server) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'klura-agent', version: '0.1.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const list = await client.listTools();
  const tools = list.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
  const toolNames = list.tools.map((t) => t.name);

  // Dispatch one tool call. klura's MCP server emits multiple text blocks: an
  // optional leading `[klura obligation]:` block and a `[Tool result for X]:`
  // payload block. Return both, plus the parsed payload.
  async function dispatch(name, args) {
    const r = await client.callTool({ name, arguments: args || {} });
    const blocks = r.content || [];
    const obligationBlock = blocks.find(
      (c) => c.type === 'text' && typeof c.text === 'string' && c.text.startsWith('[klura obligation]:'),
    );
    const payloadBlock =
      blocks.find(
        (c) => c.type === 'text' && typeof c.text === 'string' && c.text.startsWith('[Tool result for '),
      ) ||
      blocks.find((c) => c.type === 'text' && c !== obligationBlock) ||
      blocks.find((c) => c.type === 'text');
    const text = payloadBlock?.text ?? '';
    const stripped = text.replace(/^\[.*?\]:\n/, '');
    let parsed = stripped;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      /* keep string */
    }
    return {
      raw: r,
      text,
      parsed,
      obligationText: obligationBlock?.text ?? null,
      isError: !!r.isError,
    };
  }

  async function close() {
    try {
      await client.close();
    } catch {
      /* best-effort */
    }
    try {
      await server.close();
    } catch {
      /* best-effort */
    }
  }

  return { tools, toolNames, dispatch, close };
}

module.exports = { createKluraServer, bridgeServer };
