#!/usr/bin/env node
// SKILL.md tool-name integrity check.
//
// SKILL.md is the agent's tool catalog: it is loaded into context every
// conversation, and every call shape it spells out is an instruction the agent
// will follow literally. A backticked `name(` in SKILL.md must therefore name a
// tool the MCP surface actually exposes — otherwise the agent burns a round
// calling something that does not exist.
//
// The check is structural, not prose-matching: scan SKILL.md for backticked
// identifiers immediately followed by `(`, and assert each resolves to a value
// in TOOL_NAMES (runtime/src/vocab/index.ts). Nothing else about the sentence
// matters.
//
// REFERENCE.md is deliberately NOT scanned. It is on-demand prose that
// legitimately names runtime internals (`execute()`, `fetch()`, `require()`)
// and illustrative capability slugs (`send_message(...)`, `search_contact(...)`)
// which are user-defined, not tools.
//
// NON_TOOL_CALL_SHAPES is the escape hatch: a name listed there may appear as a
// call shape in SKILL.md without being a tool. Adding an entry is a deliberate
// act — prefer rewording the sentence so it names a real tool.
//
// Run via `npm test`. Failure exits non-zero.

const fs = require('fs');
const path = require('path');

const RUNTIME_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(RUNTIME_ROOT, '..');
const SKILL_MD = path.join(RUNTIME_ROOT, 'SKILL.md');
const VOCAB_TS = path.join(RUNTIME_ROOT, 'src', 'vocab', 'index.ts');

// Names SKILL.md may spell as a call shape without them being MCP tools.
const NON_TOOL_CALL_SHAPES = new Set([]);

function readToolNames() {
  const vocab = fs.readFileSync(VOCAB_TS, 'utf8');
  const start = vocab.indexOf('export const TOOL_NAMES = {');
  if (start === -1) throw new Error('TOOL_NAMES not found in vocab/index.ts');
  const end = vocab.indexOf('} as const;', start);
  if (end === -1) throw new Error('TOOL_NAMES block is unterminated in vocab/index.ts');
  const block = vocab.slice(start, end);
  const names = new Set();
  const re = /(\w+):\s*'([a-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(block)) !== null) names.add(m[2]);
  return names;
}

function findCallShapes(file) {
  const shapes = []; // {name, file, line}
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const re = /`([a-z_][a-z0-9_]*)\(/g;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      shapes.push({ name: m[1], file, line: i + 1 });
    }
  }
  return shapes;
}

function main() {
  const tools = readToolNames();
  const shapes = findCallShapes(SKILL_MD);

  const errors = [];
  for (const s of shapes) {
    if (tools.has(s.name) || NON_TOOL_CALL_SHAPES.has(s.name)) continue;
    errors.push(
      `[phantom-tool] ${path.relative(WORKSPACE_ROOT, s.file)}:${s.line} — ` +
        `\`${s.name}(\` is not a tool in TOOL_NAMES`,
    );
  }

  if (errors.length === 0) {
    console.log(
      `✓ check-tool-names: ${shapes.length} call shapes in SKILL.md, ` +
        `${tools.size} tools — every call shape names a real tool`,
    );
    process.exit(0);
  }

  console.error(
    `✖ check-tool-names: ${errors.length} call shape(s) in SKILL.md name a tool that does not exist.\n` +
      `  The agent follows these literally. Reword to name a real tool, or add to\n` +
      `  NON_TOOL_CALL_SHAPES in scripts/check-tool-names.js if it is genuinely not a tool.\n`,
  );
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}

main();
