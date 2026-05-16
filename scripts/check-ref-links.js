#!/usr/bin/env node
// REFERENCE.md link integrity check.
//
// Walks agent-facing surfaces for `klura://reference#<slug>` URLs and asserts
// every slug resolves to a real `## ` or `#### ` header in REFERENCE.md.
// Also asserts every entry in REF_LINKS (runtime/src/vocab/index.ts) maps to a
// real header — orphan REF_LINKS entries are stale.
//
// Run via `npm test`. Failure exits non-zero.

const fs = require('fs');
const path = require('path');

const RUNTIME_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(RUNTIME_ROOT, '..');
const REFERENCE_MD = path.join(RUNTIME_ROOT, 'REFERENCE.md');

// Files to scan for klura://reference#X usages.
const SCAN_DIRS = [
  path.join(RUNTIME_ROOT, 'src'),
  path.join(WORKSPACE_ROOT, 'mcp'),
];
const SCAN_FILES = [
  path.join(RUNTIME_ROOT, 'SKILL.md'),
  path.join(RUNTIME_ROOT, 'ARCHITECTURE.md'),
];

function slugifyHeader(text) {
  // Markdown anchor convention: lowercase, drop punctuation, spaces -> dash.
  // Some renderers preserve underscores; klura's REF_LINKS values reflect
  // whatever this slugifier produces, so the anchor's wire form matches the
  // const-map values 1:1.
  return text
    .toLowerCase()
    .replace(/[—–]/g, '') // em-dash, en-dash → dropped
    .replace(/[^\w\s-]/g, '') // strip remaining punctuation, keep word chars + dash
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function readRealSlugs() {
  const md = fs.readFileSync(REFERENCE_MD, 'utf8');
  const slugs = new Set();
  for (const line of md.split('\n')) {
    const m = line.match(/^(##|####)\s+(.+?)\s*$/);
    if (!m) continue;
    slugs.add(slugifyHeader(m[2]));
  }
  return slugs;
}

function readVocabSlugs() {
  // Parse vocab.ts as text; extract REF_LINKS values.
  const vocab = fs.readFileSync(path.join(RUNTIME_ROOT, 'src', 'vocab', 'index.ts'), 'utf8');
  const start = vocab.indexOf('export const REF_LINKS = {');
  if (start === -1) throw new Error('REF_LINKS not found in vocab.ts');
  const end = vocab.indexOf('} as const;', start);
  const block = vocab.slice(start, end);
  const slugs = new Map(); // value -> source line context
  const re = /(\w+):\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    slugs.set(m[2], m[1]);
  }
  return slugs;
}

function* walkFiles(dir, filter) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let stat;
    try {
      stat = fs.statSync(cur);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (cur.includes('node_modules') || cur.includes('dist') || cur.endsWith('.git')) continue;
      for (const entry of fs.readdirSync(cur)) stack.push(path.join(cur, entry));
    } else if (filter(cur)) {
      yield cur;
    }
  }
}

function findUsages() {
  const usages = []; // {slug, file, line}
  const filter = (p) => /\.(ts|js|md)$/.test(p);
  const targets = [...SCAN_FILES];
  for (const dir of SCAN_DIRS) {
    for (const f of walkFiles(dir, filter)) targets.push(f);
  }
  for (const file of targets) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const re = /klura:\/\/reference#([a-z][a-z0-9-]*)/g;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        usages.push({ slug: m[1], file, line: i + 1 });
      }
    }
  }
  return usages;
}

function main() {
  const realSlugs = readRealSlugs();
  const vocabSlugs = readVocabSlugs();
  const usages = findUsages();

  const errors = [];

  // 1) Every used slug must resolve to a real header.
  for (const u of usages) {
    if (!realSlugs.has(u.slug)) {
      errors.push(
        `[broken-link] ${path.relative(WORKSPACE_ROOT, u.file)}:${u.line} — ` +
          `klura://reference#${u.slug} but no matching header in REFERENCE.md`,
      );
    }
  }

  // 2) Every REF_LINKS entry must resolve to a real header.
  for (const [slug, key] of vocabSlugs) {
    if (!realSlugs.has(slug)) {
      errors.push(
        `[orphan-vocab] vocab.ts REF_LINKS.${key} = '${slug}' but no matching header in REFERENCE.md`,
      );
    }
  }

  // Both classes of failure are hard errors:
  //   - orphan-vocab: REF_LINKS entry pointing to a missing REFERENCE.md header
  //   - broken-link: a klura://reference#<slug> usage whose slug isn't a header
  const orphanErrors = errors.filter((e) => e.startsWith('[orphan-vocab]'));
  const brokenLinkErrors = errors.filter((e) => e.startsWith('[broken-link]'));

  if (orphanErrors.length === 0 && brokenLinkErrors.length === 0) {
    console.log(
      `✓ check-ref-links: ${usages.length} usages, ${realSlugs.size} headers, ` +
        `${vocabSlugs.size} vocab entries — vocab integrity OK`,
    );
    process.exit(0);
  }
  if (orphanErrors.length > 0) {
    console.error(`✖ check-ref-links: ${orphanErrors.length} orphan vocab entr(y/ies) — REF_LINKS points to missing header(s):\n`);
    for (const e of orphanErrors) console.error('  ' + e);
  }
  if (brokenLinkErrors.length > 0) {
    console.error(`✖ check-ref-links: ${brokenLinkErrors.length} broken klura://reference#<slug> usage(s):\n`);
    for (const e of brokenLinkErrors) console.error('  ' + e);
  }
  process.exit(1);
}

main();
