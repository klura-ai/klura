// REFERENCE.md section-budget guard.
//
// Asserts three invariants:
//
//   1. Every addressable level-2 section of REFERENCE.md fits inside the
//      MCP tool-output budget. A section that grows past the budget makes
//      `klura://reference#<slug>` unreadable in one MCP round trip, which
//      breaks the whole agent-reads-reference workflow.
//
//   2. The generated table of contents (served for a fragment-less
//      `klura://reference` fetch) also fits inside the budget. The TOC is
//      just one line per section so this should always pass, but we
//      assert it so a future change that bloats the hint generator
//      surfaces here instead of at runtime.
//
//   3. Every `klura://reference#<slug>` pointer that appears in SKILL.md
//      resolves to a real section in REFERENCE.md. Broken pointers are
//      load-bearing — when an agent follows one that doesn't exist, it
//      wastes rounds retrying and in the worst case falls back to
//      fetching the full (over-budget) reference.
//
// Run standalone or (preferred) via the `npm run check:reference` script
// wired up as a pre-commit hook in .husky/pre-commit.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  listReferenceSections,
  parseReferenceSections,
  generateReferenceToc,
  resolveReferenceResource,
  MAX_TOOL_OUTPUT_CHARS,
} = await import('../dist/response/reference-sections.js');

const REFERENCE_MD_PATH = path.join(__dirname, '..', 'REFERENCE.md');
const SKILL_MD_PATH = path.join(__dirname, '..', 'SKILL.md');

// We slightly pad the headroom — the raw section markdown plus the JSON
// envelope the MCP server wraps it in (URI, mimeType, content wrapper) eats
// a few hundred chars beyond the text itself. 1KB of slack is safe and
// leaves room for per-section length hints going forward.
const JSON_ENVELOPE_BUDGET = 1024;
const PER_SECTION_BUDGET = MAX_TOOL_OUTPUT_CHARS - JSON_ENVELOPE_BUDGET;

test('every REFERENCE.md level-2 section fits inside the MCP output budget', () => {
  const sections = listReferenceSections();
  assert.ok(sections.length > 0, 'REFERENCE.md must have at least one level-2 section');

  const violations = [];
  for (const section of sections) {
    if (section.markdown.length > PER_SECTION_BUDGET) {
      violations.push({
        slug: section.slug,
        heading: section.heading,
        length: section.markdown.length,
        overBy: section.markdown.length - PER_SECTION_BUDGET,
      });
    }
  }

  if (violations.length > 0) {
    const lines = violations.map(
      (v) =>
        `  - #${v.slug} ("${v.heading}"): ${v.length} chars, over by ${v.overBy} ` +
        `(budget ${PER_SECTION_BUDGET})`,
    );
    assert.fail(
      `${violations.length} REFERENCE.md section(s) exceed the MCP output budget:\n` +
        lines.join('\n') +
        `\n\nSplit the oversized section into smaller level-2 sections, or move ` +
        `detail into a dedicated subsection that can be addressed as a child ` +
        `fragment. SKILL.md stays terse by pushing per-section detail into REFERENCE.md.`,
    );
  }
});

test('generated REFERENCE.md table of contents fits inside the MCP output budget', () => {
  const md = fs.readFileSync(REFERENCE_MD_PATH, 'utf-8');
  const sections = parseReferenceSections(md);
  const toc = generateReferenceToc(md, sections);
  assert.ok(
    toc.length <= PER_SECTION_BUDGET,
    `REFERENCE.md TOC is ${toc.length} chars, exceeds ${PER_SECTION_BUDGET}. ` +
      `Trim per-section hints in generateReferenceToc() — they're capped at 140 chars ` +
      `by default; maybe shrink further or skip hints entirely for the largest sections.`,
  );
});

test('every klura://reference#<slug> pointer in SKILL.md resolves to a real section', () => {
  const skillMd = fs.readFileSync(SKILL_MD_PATH, 'utf-8');
  // Match bare `klura://reference` (no fragment) plus any with a fragment.
  // A pointer with no fragment is always legal (it fetches the TOC); we
  // only need to verify pointers that claim a specific section.
  const fragmentPointers = Array.from(
    skillMd.matchAll(/klura:\/\/reference#([a-z0-9-]+)/gi),
  ).map((m) => m[1]);

  if (fragmentPointers.length === 0) {
    // SKILL.md doesn't need to point at any specific section — the test is
    // a no-op in that case. Intentional: we want the test to be useful
    // without being mandatory coverage.
    return;
  }

  const unresolved = [];
  for (const frag of fragmentPointers) {
    try {
      resolveReferenceResource(`klura://reference#${frag}`);
    } catch (err) {
      unresolved.push({ frag, message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (unresolved.length > 0) {
    const lines = unresolved.map(
      (u) => `  - #${u.frag}: ${u.message.slice(0, 200)}`,
    );
    assert.fail(
      `${unresolved.length} SKILL.md pointer(s) to REFERENCE.md don't resolve:\n` +
        lines.join('\n') +
        `\n\nFix by either (a) adding the section to REFERENCE.md, or ` +
        `(b) updating the SKILL.md pointer to a real slug.`,
    );
  }
});

test('resolveReferenceResource returns the TOC for a fragment-less fetch', () => {
  const result = resolveReferenceResource('klura://reference');
  assert.strictEqual(result.slug, null);
  assert.match(result.text, /Table of Contents/);
  assert.match(result.text, /klura:\/\/reference#/);
});

test('resolveReferenceResource returns a specific section for a valid fragment', () => {
  const sections = listReferenceSections();
  assert.ok(sections.length > 0);
  const first = sections[0];
  const result = resolveReferenceResource(`klura://reference#${first.slug}`);
  assert.strictEqual(result.slug, first.slug);
  assert.ok(result.text.includes(first.heading));
});

test('resolveReferenceResource throws a helpful error for an unknown fragment', () => {
  assert.throws(
    () => resolveReferenceResource('klura://reference#totally-not-a-real-section'),
    (err) => {
      assert.match(err.message, /Unknown reference section/);
      // Error must list available slugs so the agent can self-correct
      // without a second MCP round trip.
      assert.match(err.message, /Available:/);
      return true;
    },
  );
});

test('resolveReferenceResource throws for a non-reference URI', () => {
  assert.throws(
    () => resolveReferenceResource('klura://nothing'),
    /Unknown resource/,
  );
});
