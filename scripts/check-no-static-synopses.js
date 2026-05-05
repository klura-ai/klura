#!/usr/bin/env node
// Static-synopsis drift guard.
//
// Klura's principle: every shape synopsis the agent reads is derived from a
// Zod schema (renderZodSkeletonInline / renderZodSkeleton in
// runtime/src/strategies/schemas/zod-helpers.ts). Hand-written prose like
// `'{ paramName: { type, source, example } }'` is the canonical drift point
// — schemas evolve, hint strings stagnate, agents follow the stale hint and
// burn rounds against opaque rejections.
//
// This script scans files in known synopsis-emitting modules for literal
// shape-prose patterns. A match means a hand-written hint snuck in where a
// `describeShape(zodSchema)` call should be.
//
// Run via `npm test`. Failure exits non-zero.

const fs = require('fs');
const path = require('path');

const RUNTIME_ROOT = path.resolve(__dirname, '..');

// Files that historically owned hand-written shape tables and continue to
// own the synopsis emission path. New files added under these subtrees are
// scanned automatically.
const SCAN_DIRS = [
  path.join(RUNTIME_ROOT, 'src/strategies/validate'),
  path.join(RUNTIME_ROOT, 'src/audit'),
  path.join(RUNTIME_ROOT, 'src/gate'),
];

// File-level allowlist for the schema source directory. Files under
// runtime/src/strategies/schemas/ legitimately use `.describe()` strings
// that look synopsis-shaped — those ARE the source of truth, not drift.
const ALLOW_PATHS = new Set([
  // Add specific files here if a legitimate shape-literal needs to live
  // outside of a `.describe()` call. Empty by design — extending this set
  // should require a sibling commit that explains why the literal can't
  // become a Zod-derived call.
]);

// Patterns that strongly suggest hand-written object-shape prose. Designed
// to fire on synopsis-style literals and NOT on regular code.
//
// Each rule names the offending shape and the reason it's banned. Add new
// patterns here if a new failure mode shows up — the test for false-
// positives is whether `npm test` still passes after the addition.
const RULES = [
  {
    name: 'enum-prose literal in agent-facing string',
    // Matches: `'"a" | "b" | "c"'` style enum lists in prose strings — three
    // or more quoted values pipe-separated. Three is the threshold because
    // `"a" | "b"` can legitimately appear in code that handles a binary
    // discriminator union; three+ is almost always an enum that should
    // render from `z.enum(...)`.
    re: /['"`][^'"`]*"\w+"\s*\|\s*"\w+"\s*\|\s*"\w+"[^'"`]*['"`]/,
    rationale:
      'pipe-separated quoted enum list in a string. Use z.enum(...) (or renderZodSkeletonInline on a ' +
      'schema that wraps a z.enum) so the values render automatically and renames cascade through every consumer.',
  },
];

let foundAny = false;

function walk(dir, fn) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, fn);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      fn(fullPath);
    }
  }
}

function check(file) {
  const relPath = path.relative(RUNTIME_ROOT, file);
  if (ALLOW_PATHS.has(relPath)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments — single-line `//` and lines that are inside `/* */`
    // ranges. Block-comment tracking would be overkill; the heuristic of
    // "skip lines starting with `//` or ` *` (jsdoc continuation)" catches
    // 95% of cases and false negatives here are fine (they fire on the
    // next non-comment edit anyway).
    const stripped = line.trimStart();
    if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*')) continue;
    // Skip lines inside a `.describe(...)` call — those legitimately carry
    // synopsis-shaped prose because the schema OWNS the prose.
    if (/\.describe\s*\(/.test(line)) continue;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        if (!foundAny) {
          console.error('Static-synopsis drift guard failed:\n');
          foundAny = true;
        }
        console.error(`  ${relPath}:${i + 1}`);
        console.error(`    ${line.trim()}`);
        console.error(`    rule: ${rule.name}`);
        console.error(`    fix:  ${rule.rationale}\n`);
      }
    }
  }
}

for (const dir of SCAN_DIRS) walk(dir, check);

if (foundAny) {
  console.error(
    'See runtime/src/strategies/schemas/zod-helpers.ts for the Zod-derived rendering helpers.\n' +
      'See runtime/test/synopsis-drift.test.js for the snapshot tests that paired with this lint.\n',
  );
  process.exit(1);
}

process.exit(0);
