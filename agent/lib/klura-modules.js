'use strict';

// Resolve the klura packages the CLI agent shim builds on. The shim ships
// inside the `@klura/runtime` package (`runtime/agent/`), so the runtime is a
// sibling on disk; `@klura/mcp` is a separate package. Both resolve by name in
// a published install and by relative path inside the klura workspace.

const path = require('path');

function loadKluraRuntime() {
  try {
    return require('@klura/runtime');
  } catch {
    // runtime/agent/lib/ -> runtime/dist/index.js (the compiled runtime)
    return require(path.join(__dirname, '..', '..', 'dist'));
  }
}

function loadKluraMcp() {
  try {
    return require('@klura/mcp');
  } catch {
    // runtime/agent/lib/ -> <workspace>/mcp
    return require(path.join(__dirname, '..', '..', '..', 'mcp'));
  }
}

module.exports = { loadKluraRuntime, loadKluraMcp };
