// Section-level addressing for REFERENCE.md. The klura MCP server exposes
// REFERENCE.md via `klura://reference`, but the full document (~50–60 KB and
// growing) exceeds the MCP output budget — the agent SDK persists oversize
// responses to a file and the agent can't actually read the content inline.
// Fetching specific sections via URL fragment keeps every response inside the
// budget:
//
//   klura://reference                  → a compact table of contents
//   klura://reference#fetch-schema     → only the "## fetch schema" section
//   klura://reference#recorded-path-schema    → only the "## recorded-path schema" section
//
// The TOC gives the agent a list of addressable section slugs plus a one-line
// hint per section, so it can pick which one to fetch without needing the full
// document first.
//
// Tested in runtime/test/reference-size-budget.test.js, which also asserts that
// every `klura://reference#...` pointer referenced from SKILL.md resolves to a
// real section — that's the pre-commit guard against adding a pointer to a slug
// that doesn't exist.

import fs from 'fs';
import path from 'path';
import { MAX_TOOL_OUTPUT_CHARS } from './response-size';

export interface ReferenceSection {
  /** Slug used in fragment addressing, derived from the level-2 heading. */
  slug: string;
  /** Original heading text, e.g. "Strategy schemas" or "Transport". */
  heading: string;
  /** Heading level (2 for ##, 3 for ### — only level 2 is addressable). */
  level: number;
  /** Zero-based line number of the heading in the source markdown. */
  startLine: number;
  /** Exclusive line number of the next same-or-higher-level heading (or
   *  EOF). */
  endLine: number;
  /** Full markdown of this section, including its heading. */
  markdown: string;
}

/**
 * GitHub-ish slugify: lowercase, keep alphanumerics, turn everything else into
 * hyphens, collapse consecutive hyphens, trim. Parentheticals are stripped from
 * the input before slugification so headings like "fetch (fastest — pure HTTP,
 * no browser)" become "fetch", not a wall of hyphens.
 */
export function slugifyHeading(heading: string): string {
  let out = '';
  let inParens = 0;
  let pendingHyphen = false;
  for (const char of heading.trim().toLowerCase()) {
    if (char === '(') {
      inParens += 1;
      continue;
    }
    if (char === ')' && inParens > 0) {
      inParens -= 1;
      continue;
    }
    if (inParens > 0) continue;
    if ((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')) {
      if (pendingHyphen && out.length > 0) out += '-';
      out += char;
      pendingHyphen = false;
      continue;
    }
    pendingHyphen = out.length > 0;
  }
  return out;
}

/**
 * Parse a markdown document into an ordered list of level-2 (and optionally
 * level-3) sections. Only `## ` (two hashes) headings are considered
 * addressable top-level sections; a section "ends" at the next `## ` line or at
 * EOF. Level-3 subsections are included inside their parent's markdown blob —
 * they aren't separately addressable.
 */
export function parseReferenceSections(markdown: string): ReferenceSection[] {
  const lines = markdown.split('\n');
  // First pass: collect every heading at level 2 or higher with its line index,
  // so we can determine where each section ends.
  const headings: Array<{ level: number; text: string; startLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let level = 0;
    while (level < line.length && line[level] === '#') level += 1;
    if (level < 1 || level > 6 || line[level] !== ' ') continue;
    const text = line.slice(level + 1).trim();
    if (text.length > 0) headings.push({ level, text, startLine: i });
  }

  // Second pass: build sections for every level-2 heading. The endLine is the
  // startLine of the next heading whose level is <= 2 (so level-3 subsections
  // stay inside the parent).
  const sections: ReferenceSection[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!h || h.level !== 2) continue;
    let endLine = lines.length;
    for (let j = i + 1; j < headings.length; j++) {
      const next = headings[j];
      if (next && next.level <= 2) {
        endLine = next.startLine;
        break;
      }
    }
    const markdownSlice = lines.slice(h.startLine, endLine).join('\n').trimEnd();
    sections.push({
      slug: slugifyHeading(h.text),
      heading: h.text,
      level: h.level,
      startLine: h.startLine,
      endLine,
      markdown: markdownSlice,
    });
  }
  return sections;
}

/**
 * Resolve a `klura://reference#<slug>` fragment to the corresponding section
 * markdown. Returns null if no section matches (caller should surface a helpful
 * error with the list of available slugs).
 *
 * Matching is case-insensitive on the slug and tries exact match first, then
 * prefix match, then substring match. Deterministic: returns the first section
 * in document order for each match class.
 */
export function findReferenceSection(
  sections: ReferenceSection[],
  fragment: string,
): ReferenceSection | null {
  const needle = fragment.toLowerCase().trim();
  if (!needle) return null;
  const exact = sections.find((s) => s.slug === needle);
  if (exact) return exact;
  const prefix = sections.find((s) => s.slug.startsWith(needle));
  if (prefix) return prefix;
  const substr = sections.find((s) => s.slug.includes(needle));
  if (substr) return substr;
  return null;
}

/**
 * Build a compact table of contents listing every addressable section. The
 * heuristic for the "one-line hint" per section is the first non-blank,
 * non-code-fence line of prose after the heading, trimmed to 120 chars. If the
 * first non-blank content is a code fence or a heading-less list, we fall back
 * to the heading text itself.
 *
 * The TOC is also the response for a fragment-less `klura://reference` fetch —
 * so it must itself fit inside MAX_TOOL_OUTPUT_CHARS. The budget test asserts
 * this.
 */
export function generateReferenceToc(markdown: string, sections: ReferenceSection[]): string {
  const lines = markdown.split('\n');
  const hints = new Map<string, string>();
  for (const section of sections) {
    // Scan the lines between the heading and the next heading / code block for
    // the first prose paragraph.
    let hint = '';
    for (let i = section.startLine + 1; i < section.endLine; i++) {
      const raw = (lines[i] ?? '').trim();
      if (!raw) continue;
      // Skip code fences, HTML comments, tables, list markers, blockquotes.
      if (raw.startsWith('```')) {
        // Skip to the closing fence.
        i++;
        while (i < section.endLine && !(lines[i] ?? '').trim().startsWith('```')) i++;
        continue;
      }
      if (raw.startsWith('<!--') || raw.startsWith('|') || raw.startsWith('>')) continue;
      if (raw.startsWith('- ') || raw.startsWith('* ') || /^\d+\. /.test(raw)) continue;
      if (raw.startsWith('#')) continue;
      hint = raw;
      break;
    }
    if (hint.length > 140) hint = hint.slice(0, 137) + '…';
    if (!hint) hint = section.heading;
    hints.set(section.slug, hint);
  }

  const tocLines: string[] = [
    '# Klura Reference — Table of Contents',
    '',
    'The full reference exceeds the MCP output budget. Fetch individual sections via `klura://reference#<slug>`. Each section fits inside the budget and returns only that portion of the markdown.',
    '',
    '## Sections',
    '',
  ];
  for (const section of sections) {
    const hint = hints.get(section.slug) ?? section.heading;
    tocLines.push(`- \`${section.slug}\` — ${hint}`);
  }
  return tocLines.join('\n');
}

/**
 * High-level façade used by the MCP server's ReadResource handler. Accepts a
 * raw URI like `klura://reference` or `klura://reference#fetch-schema` and returns
 * the markdown text to serve.
 *
 * Throws with a friendly error if the fragment doesn't resolve — the error
 * message includes the list of available slugs so the agent can fix its fetch
 * in the next round.
 */
export function resolveReferenceResource(uri: string): { text: string; slug: string | null } {
  const hashIdx = uri.indexOf('#');
  const baseUri = hashIdx === -1 ? uri : uri.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? '' : uri.slice(hashIdx + 1);
  if (baseUri !== 'klura://reference') {
    throw new Error(`Unknown resource: ${uri}`);
  }

  // Virtual section — `#save-strategy-schema` resolves to the dynamic
  // catalog rendered from the live Zod validators, not a static section
  // in REFERENCE.md. Single canonical schema source with on-demand reads.
  if (fragment === SAVE_STRATEGY_SCHEMA_SLUG) {
    // Lazy-require: catalog → schemas/prereqs → validate constants;
    // top-of-file import would create a cycle with the audit chain.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const cat =
      require('../strategies/schema-catalog') as typeof import('../strategies/schema-catalog');
    /* eslint-enable @typescript-eslint/no-require-imports */
    return { text: cat.renderSaveStrategySchemaMarkdown(), slug: SAVE_STRATEGY_SCHEMA_SLUG };
  }

  const markdown = readReferenceMd();
  const sections = parseReferenceSections(markdown);

  if (!fragment) {
    return { text: generateReferenceToc(markdown, sections), slug: null };
  }

  const section = findReferenceSection(sections, fragment);
  if (!section) {
    const available = [...sections.map((s) => `#${s.slug}`), `#${SAVE_STRATEGY_SCHEMA_SLUG}`].join(
      ', ',
    );
    throw new Error(
      `Unknown reference section: #${fragment}. Available: ${available}. ` +
        `Fetch klura://reference (no fragment) for a full table of contents with one-line hints.`,
    );
  }
  return { text: section.markdown, slug: section.slug };
}

const SAVE_STRATEGY_SCHEMA_SLUG = 'save-strategy-schema';

/** Path to the installed REFERENCE.md. Computed lazily so tests can mock.
 * This module is built to dist/response/reference-sections.js, so the package
 * root (where REFERENCE.md lives alongside SKILL.md) is two
 *  levels up from __dirname. */
function referenceMdPath(): string {
  return path.join(__dirname, '..', '..', 'REFERENCE.md');
}

function readReferenceMd(): string {
  return fs.readFileSync(referenceMdPath(), 'utf-8');
}

/**
 * Test helper: enumerate the sections of the installed REFERENCE.md so the
 * budget test can iterate without re-implementing the parser. Includes the
 * virtual `#save-strategy-schema` slug so toc + budget tests see it.
 */
export function listReferenceSections(): ReferenceSection[] {
  const sections = parseReferenceSections(readReferenceMd());
  return [
    ...sections,
    {
      slug: SAVE_STRATEGY_SCHEMA_SLUG,
      heading: 'save-strategy schema (dynamic)',
      level: 2,
      startLine: -1,
      endLine: -1,
      markdown:
        '## save-strategy schema (dynamic)\n\nResolved at request time from the Zod validators in `runtime/src/strategies/schemas/`.',
    },
  ];
}

/** Exposed for budget tests so they don't hard-code the constant. */
export { MAX_TOOL_OUTPUT_CHARS };
