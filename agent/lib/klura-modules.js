'use strict';

// Resolve the klura modules the CLI agent shim builds on. The shim ships
// inside the `@klura/runtime` package (`runtime/agent/`), so both the compiled
// runtime barrel and the MCP server factory are siblings on disk — required
// by relative path, with no dependency on `@klura/mcp` (which would be a cycle:
// `@klura/mcp` depends on `@klura/runtime`).

const path = require('path');

function loadKluraRuntime() {
  try {
    return require('@klura/runtime');
  } catch {
    // runtime/agent/lib/ -> runtime/dist/index.js (the compiled runtime)
    return require(path.join(__dirname, '..', '..', 'dist'));
  }
}

// The MCP server factory — `createKluraMcpServer()` — lives in the runtime
// package at runtime/mcp-server.js, the same server `@klura/mcp` wraps.
function loadMcpServer() {
  // runtime/agent/lib/ -> runtime/mcp-server.js
  return require(path.join(__dirname, '..', '..', 'mcp-server'));
}

module.exports = { loadKluraRuntime, loadMcpServer };
