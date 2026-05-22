'use strict';

// Resolve `config.agent.provider` to a Provider factory.
//
// The value is a built-in id (`"openai"`, `"claude-code"`), an npm package
// name, or a filesystem path — exactly like `config.pool.driver` resolves a
// BYO browser driver. Built-in ids map to first-party packages installed
// on-demand; a missing one yields a clear `npm install` instruction.
//
// A provider package exports `createProvider(config) => Provider`, where a
// Provider has `{ id, label, defaultModel, runAgent(opts) }`. See
// provider.js for the contract.

const path = require('path');

const BUILTIN = {
  openai: '@klura/agent-openai',
  'claude-code': '@klura/agent-claude-code',
};

/**
 * @param {string} spec value of config.agent.provider
 * @returns {(config: object) => object} the provider factory
 */
function resolveProviderFactory(spec) {
  if (!spec || typeof spec !== 'string') {
    throw new Error(
      'agent: no provider configured. Set config.agent.provider ("openai" or "claude-code").',
    );
  }
  const builtinPkg = BUILTIN[spec];
  // Built-in ids: try the published package, then the workspace sibling dir
  // (runtime/agent/lib/ -> <workspace>/agent-openai etc.).
  // Custom ids: try as a package name, then as a filesystem path.
  const candidates = builtinPkg
    ? [builtinPkg, path.join(__dirname, '..', '..', '..', builtinPkg.replace('@klura/', ''))]
    : [spec, path.resolve(spec)];

  let mod = null;
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      mod = require(candidate);
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!mod) {
    if (builtinPkg) {
      throw new Error(
        `agent: provider "${spec}" is not installed.\n` +
          `  Install it with:  npm install -g ${builtinPkg}`,
      );
    }
    throw new Error(
      `agent: cannot load provider "${spec}": ${lastErr && lastErr.message ? lastErr.message : lastErr}`,
    );
  }

  const factory = mod.createProvider || mod.default || mod;
  if (typeof factory !== 'function') {
    throw new Error(`agent: provider "${spec}" does not export a createProvider() factory.`);
  }
  return factory;
}

module.exports = { resolveProviderFactory, BUILTIN };
