'use strict';

// Loud, unmissable banner printed to stderr the moment the LLM agent enters
// the loop. `klura execute --agent` runs an execution with no LLM cost when it
// succeeds; on failure the agent picks up — and the user must know an LLM is
// now driving. This is that signal.

function printAgentBanner(stream, opts) {
  const out = stream || process.stderr;
  const width = 64;
  const bar = '─'.repeat(width);
  const row = (s) => {
    const text = String(s);
    out.write(`  │ ${text.length > width - 2 ? text.slice(0, width - 3) + '…' : text.padEnd(width - 2)} │\n`);
  };
  out.write(`\n  ┌${bar}┐\n`);
  row(opts.title || 'klura agent');
  if (opts.provider || opts.model) {
    row(`provider: ${opts.provider || '?'}    model: ${opts.model || '?'}`);
  }
  for (const line of opts.lines || []) row(line);
  out.write(`  └${bar}┘\n\n`);
}

module.exports = { printAgentBanner };
