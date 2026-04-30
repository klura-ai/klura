// Unit tests for trimA11yTree, truncateString, and paginateA11yTree.
// Covers the three-step trimming strategy: (A) shorten long quoted values,
// (D) landmark-aware collapse, (fallback) line-boundary tail cut.

import test from 'node:test';
import assert from 'node:assert';
import {
  trimA11yTree,
  truncateString,
  paginateA11yTree,
  sliceLargeString,
  MAX_TOOL_OUTPUT_CHARS,
  DEFAULT_A11Y_BUDGET,
  HEALABLE_A11Y_BUDGET,
} from '../dist/response/response-size.js';

// ---- sliceLargeString ----
// Core invariant: every agent-facing tool that returns a potentially-large
// string (get_network_log detail bodies, js_eval results, evaluate_on_frame
// closure previews, read_js_function bodies) routes through this helper.
// Observed failure 2026-04-19 — an unguarded 1,021,635-char response body
// blew the MCP output budget.

test('sliceLargeString: short strings pass through unchanged', () => {
  const out = sliceLargeString('hello', {});
  assert.strictEqual(out.slice, 'hello');
  assert.strictEqual(out.total_chars, 5);
  assert.strictEqual(out.truncated, false);
  assert.strictEqual(out.slice_start, 0);
  assert.strictEqual(out.slice_end, 5);
  assert.strictEqual(out.hint, undefined);
});

test('sliceLargeString: clips at defaultMaxLength with truncated marker', () => {
  const big = 'x'.repeat(100_000);
  const out = sliceLargeString(big, { defaultMaxLength: 1_000 });
  assert.strictEqual(out.slice.length, 1_000);
  assert.strictEqual(out.total_chars, 100_000);
  assert.strictEqual(out.truncated, true);
  assert.strictEqual(out.slice_end, 1_000);
});

test('sliceLargeString: offset+length reads the mid section', () => {
  const out = sliceLargeString('abcdefghij', { offset: 3, length: 4 });
  assert.strictEqual(out.slice, 'defg');
  assert.strictEqual(out.slice_start, 3);
  assert.strictEqual(out.slice_end, 7);
  assert.strictEqual(out.truncated, true);
});

test('sliceLargeString: offset past total clamps safely', () => {
  const out = sliceLargeString('abcdefghij', { offset: 8, length: 50 });
  assert.strictEqual(out.slice, 'ij');
  assert.strictEqual(out.slice_end, 10);
});

test('sliceLargeString: negative offset clamps to 0', () => {
  const out = sliceLargeString('hello', { offset: -5 });
  assert.strictEqual(out.slice_start, 0);
});

test('sliceLargeString: hintFetchNext only called when truncated', () => {
  const short = sliceLargeString('hi', { hintFetchNext: () => 'unused' });
  assert.strictEqual(short.hint, undefined);
  const long = sliceLargeString('x'.repeat(100), {
    defaultMaxLength: 10,
    hintFetchNext: (end, remaining) => `end=${end} remaining=${remaining}`,
  });
  assert.strictEqual(long.hint, 'end=10 remaining=90');
});

test('sliceLargeString: defaultMaxLength capped at MAX_TOOL_OUTPUT_CHARS', () => {
  // Callers can't accidentally configure a helper that exceeds the budget.
  const big = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS * 2);
  const out = sliceLargeString(big, { defaultMaxLength: MAX_TOOL_OUTPUT_CHARS * 10 });
  assert.ok(out.slice.length <= MAX_TOOL_OUTPUT_CHARS);
});

test('sliceLargeString: empty / null / undefined input is safe', () => {
  assert.strictEqual(sliceLargeString(null, {}).slice, '');
  assert.strictEqual(sliceLargeString(undefined, {}).slice, '');
  assert.strictEqual(sliceLargeString('', {}).truncated, false);
});

// ---- truncateString ----

test('truncateString leaves short strings alone', () => {
  assert.strictEqual(truncateString('hello', 20), 'hello');
});

test('truncateString clips long strings with ellipsis', () => {
  const out = truncateString('abcdefghij', 5);
  assert.strictEqual(out, 'abcd…');
  assert.strictEqual(out.length, 5);
});

test('truncateString handles max ≤ suffix length', () => {
  assert.strictEqual(truncateString('abcdef', 1), '…');
});

// ---- trimA11yTree: pass-through ----

test('trimA11yTree returns tree unchanged when under budget', () => {
  const tiny = '- document:\n  - button "Save"';
  const out = trimA11yTree(tiny, 1000);
  assert.strictEqual(out.tree, tiny);
  assert.strictEqual(out.truncated, false);
  assert.strictEqual(out.total_chars, tiny.length);
});

// ---- trimA11yTree: step A (shorten long quoted values) ----

test('trimA11yTree step A: shortens long quoted values while preserving structure', () => {
  // Simulates a wiki-style page: structural skeleton small, but one node
  // has a massive text value that pushes the tree over budget.
  const longText = 'x'.repeat(5000);
  const tree = [
    '- document:',
    '  - main:',
    '    - heading "Article title"',
    `    - paragraph "${longText}"`,
    '    - button "Next"',
  ].join('\n');

  const out = trimA11yTree(tree, 1000);
  assert.strictEqual(out.truncated, true);
  assert.strictEqual(out.total_chars, tree.length);
  assert.ok(out.tree.length <= 1000, `expected ≤1000 chars, got ${out.tree.length}`);
  // Structural lines must still be present.
  assert.match(out.tree, /- heading "Article title"/);
  assert.match(out.tree, /- button "Next"/);
  // Long paragraph must be clipped with ellipsis, not outright dropped.
  assert.match(out.tree, /- paragraph "x+…"/);
});

test('trimA11yTree step A: leaves short quoted values alone', () => {
  const longText = 'y'.repeat(2000);
  const tree = [
    '- document:',
    '  - main:',
    '    - button "OK"', // short, must survive verbatim
    `    - text "${longText}"`, // long, gets clipped
  ].join('\n');

  const out = trimA11yTree(tree, 600);
  assert.match(out.tree, /- button "OK"/);
  assert.ok(!out.tree.includes(longText), 'long text must have been clipped');
});

// ---- trimA11yTree: step D (landmark-aware collapse) ----

test('trimA11yTree step D: collapses chrome landmarks but preserves main', () => {
  // Github-style: huge banner/nav/contentinfo with a small main. Without
  // the landmark-aware pass, step A alone wouldn't save us because the
  // quoted values are all short (nav links, labels, etc.). Step D should
  // cap the chrome sections and leave main verbatim.
  const navLinks = Array.from({ length: 200 }, (_, i) => `      - link "Nav ${i}"`).join('\n');
  const footerLinks = Array.from({ length: 200 }, (_, i) => `      - link "Foot ${i}"`).join('\n');
  const tree = [
    '- document:',
    '  - banner:',
    '    - heading "Header"',
    '    - navigation:',
    navLinks,
    '  - main:',
    '    - heading "Task"',
    '    - button "Submit"',
    '  - contentinfo:',
    '    - navigation:',
    footerLinks,
  ].join('\n');

  const out = trimA11yTree(tree, 2000);
  assert.strictEqual(out.truncated, true);
  // main must survive in full.
  assert.match(out.tree, /- heading "Task"/);
  assert.match(out.tree, /- button "Submit"/);
  // banner/contentinfo must be collapsed — not all 200 nav links present.
  assert.ok(
    !out.tree.includes('- link "Nav 199"'),
    'banner should have been collapsed (nav item 199 must be gone)',
  );
  assert.ok(
    !out.tree.includes('- link "Foot 199"'),
    'contentinfo should have been collapsed (footer link 199 must be gone)',
  );
  // Collapse marker must be present with a pointer to get_a11y_tree.
  assert.match(out.tree, /collapsed: \d+ of \d+ chars/);
  assert.match(out.tree, /get_a11y_tree/);
});

test('trimA11yTree step D: preserves dialog/form landmarks as high-priority', () => {
  const noise = Array.from({ length: 100 }, (_, i) => `      - link "N ${i}"`).join('\n');
  const tree = [
    '- document:',
    '  - banner:',
    noise,
    '  - dialog:',
    '    - heading "Confirm"',
    '    - button "Yes"',
    '    - button "No"',
  ].join('\n');

  const out = trimA11yTree(tree, 1200);
  // Dialog must survive verbatim.
  assert.match(out.tree, /- heading "Confirm"/);
  assert.match(out.tree, /- button "Yes"/);
  assert.match(out.tree, /- button "No"/);
});

// ---- trimA11yTree: fallback tail cut ----

test('trimA11yTree fallback: tail-cuts when no landmarks are detectable', () => {
  // A structurally flat tree with no recognizable landmarks — should fall
  // through steps A and D to the line-cut path with a marker.
  const lines = [];
  for (let i = 0; i < 500; i++) {
    lines.push(`  - button "Button ${i}"`);
  }
  const tree = lines.join('\n');

  const out = trimA11yTree(tree, 800);
  assert.strictEqual(out.truncated, true);
  assert.ok(out.tree.length <= 800);
  assert.match(out.tree, /a11y tree truncated: \d+ of \d+ chars/);
  assert.match(out.tree, /get_a11y_tree/);
});

// ---- trimA11yTree: combined A + D on a realistic page ----

test('trimA11yTree combined: real-world pattern with both content and structure bloat', () => {
  // A reddit-ish feed: nav chrome + main feed of 25 posts each with a
  // long preview. Both step A (preview clipping) and step D (chrome
  // collapse) should fire and together bring it under budget.
  const navLinks = Array.from({ length: 50 }, (_, i) => `      - link "Subreddit ${i}"`).join('\n');
  const posts = Array.from({ length: 25 }, (_, i) => {
    const preview = 'z'.repeat(2000);
    return [
      `    - article "Post ${i}":`,
      `      - heading "Post ${i} title"`,
      `      - text "${preview}"`,
      `      - button "Upvote"`,
    ].join('\n');
  }).join('\n');
  const tree = [
    '- document:',
    '  - banner:',
    '    - navigation:',
    navLinks,
    '  - main:',
    posts,
  ].join('\n');

  assert.ok(tree.length > 50_000, 'test fixture should be large enough to trigger both passes');

  const out = trimA11yTree(tree, DEFAULT_A11Y_BUDGET);
  assert.strictEqual(out.truncated, true);
  assert.ok(out.tree.length <= DEFAULT_A11Y_BUDGET);
  // Main post structure should still be recognizable.
  assert.match(out.tree, /- heading "Post 0 title"/);
  assert.match(out.tree, /- button "Upvote"/);
  // Long previews must be clipped.
  assert.ok(!out.tree.includes('z'.repeat(2000)), 'long preview text must have been clipped');
});

// ---- paginateA11yTree ----

test('paginateA11yTree returns a single page for small trees', () => {
  const tree = '- document:\n  - button "Save"';
  const out = paginateA11yTree(tree);
  assert.strictEqual(out.tree, tree);
  assert.strictEqual(out.total_chars, tree.length);
  assert.strictEqual(out.page, 1);
  assert.strictEqual(out.total_pages, 1);
  assert.strictEqual(out.has_more, false);
});

test('paginateA11yTree splits large trees into pages', () => {
  const tree = 'x'.repeat(50_000);
  const page1 = paginateA11yTree(tree, { page: 1, page_size: 15_000 });
  assert.strictEqual(page1.total_chars, 50_000);
  assert.strictEqual(page1.page, 1);
  assert.strictEqual(page1.page_size, 15_000);
  assert.strictEqual(page1.tree.length, 15_000);
  assert.strictEqual(page1.total_pages, 4);
  assert.strictEqual(page1.has_more, true);

  const page4 = paginateA11yTree(tree, { page: 4, page_size: 15_000 });
  assert.strictEqual(page4.tree.length, 50_000 - 3 * 15_000);
  assert.strictEqual(page4.has_more, false);
});

test('paginateA11yTree clamps page_size to the tool-output budget', () => {
  const tree = 'x'.repeat(100);
  const out = paginateA11yTree(tree, { page_size: 999_999 });
  assert.strictEqual(out.page_size, MAX_TOOL_OUTPUT_CHARS);
});

test('paginateA11yTree clamps out-of-range page to the last page', () => {
  const tree = 'x'.repeat(30_000);
  const out = paginateA11yTree(tree, { page: 99, page_size: 10_000 });
  assert.strictEqual(out.page, 3);
  assert.strictEqual(out.has_more, false);
});

// ---- sanity check on the budget constants ----

test('budget constants are consistent', () => {
  assert.ok(HEALABLE_A11Y_BUDGET < DEFAULT_A11Y_BUDGET, 'healable budget is tighter');
  assert.ok(DEFAULT_A11Y_BUDGET < MAX_TOOL_OUTPUT_CHARS, 'default budget fits in tool output cap');
});
