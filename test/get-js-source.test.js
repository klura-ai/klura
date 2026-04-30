// Unit tests for the source-shaping side of get_js_source: pretty-print
// + windowed view + MCP budget compliance. The driver-side fetch lives
// in playwright.ts and isn't exercised here (would need a real browser);
// the runtime-level shaping is pure and exhaustively testable.

import test from 'node:test';
import assert from 'node:assert';

const { windowJsSource, prettyPrintMinified } = await import(
  '../dist/response/js-source-shape.js'
);
const { MAX_TOOL_OUTPUT_CHARS } = await import('../dist/response/response-size.js');

// ---- prettyPrintMinified ----

test('prettyPrintMinified: leaves multi-line source unchanged', () => {
  const src = 'function a() {\n  return 1;\n}\n';
  assert.strictEqual(prettyPrintMinified(src), src);
});

test('prettyPrintMinified: splits a minified single-line script on { } ;', () => {
  const minified = 'function a(){var x=1;return x;}function b(){return 2;}';
  // Pad to exceed the length threshold so the gate fires.
  const padded = minified.repeat(40);
  const out = prettyPrintMinified(padded);
  const lines = out.split('\n');
  assert.ok(lines.length > 5, 'expected multiple lines after pretty-print');
  // Indentation should be consistent — at least one line indented by 2 spaces.
  assert.ok(lines.some((l) => l.startsWith('  ')), 'expected indented lines');
});

test('prettyPrintMinified: preserves string literals (does not split inside)', () => {
  const minified = 'var x="a;b{c}d";var y=1;'.repeat(60);
  const out = prettyPrintMinified(minified);
  // The string contents should still appear intact somewhere.
  assert.ok(out.includes('"a;b{c}d"'), 'string literal should not be split by ; or { } inside it');
});

test('prettyPrintMinified: leaves empty input unchanged', () => {
  assert.strictEqual(prettyPrintMinified(''), '');
});

// ---- windowJsSource ----

function makeMultilineSource(numLines) {
  const lines = [];
  for (let i = 1; i <= numLines; i += 1) lines.push(`// line ${i}`);
  return lines.join('\n');
}

test('windowJsSource: returns full source when smaller than window', () => {
  const src = makeMultilineSource(20);
  const r = windowJsSource('https://x/y.js', src, { line: 10, context_lines: 30 });
  assert.strictEqual(r.url, 'https://x/y.js');
  assert.strictEqual(r.total_lines, 20);
  assert.strictEqual(r.start_line, 1);
  assert.strictEqual(r.end_line, 20);
  assert.strictEqual(r.format, 'pretty');
});

test('windowJsSource: centers window on target line with context', () => {
  const src = makeMultilineSource(200);
  const r = windowJsSource('https://x/y.js', src, { line: 100, context_lines: 10 });
  assert.strictEqual(r.start_line, 90);
  assert.strictEqual(r.end_line, 110);
  // Source should contain the target line.
  assert.ok(r.source.includes('// line 100'));
  // And not contain lines outside the window.
  assert.ok(!r.source.includes('// line 50'));
});

test('windowJsSource: clamps context_lines at 200', () => {
  const src = makeMultilineSource(1000);
  const r = windowJsSource('https://x/y.js', src, { line: 500, context_lines: 99999 });
  // Asked for 99999, max is 200 → window spans 300..700.
  assert.strictEqual(r.start_line, 300);
  assert.strictEqual(r.end_line, 700);
});

test('windowJsSource: defaults line=1 + context=60 when omitted', () => {
  const src = makeMultilineSource(100);
  const r = windowJsSource('https://x/y.js', src);
  assert.strictEqual(r.start_line, 1);
  // line=1, context=60 → end = min(100, 1+60) = 61
  assert.strictEqual(r.end_line, 61);
});

test('windowJsSource: line beyond total_lines clamps to last line', () => {
  const src = makeMultilineSource(10);
  const r = windowJsSource('https://x/y.js', src, { line: 100, context_lines: 5 });
  // line=100 clamped to 10 (last line); context=5 → window 5..10.
  assert.strictEqual(r.start_line, 5);
  assert.strictEqual(r.end_line, 10);
});

test('windowJsSource: respects MCP output budget — sets truncated:true on overflow', () => {
  // 5MB source — 50_000 lines of 100 chars each. Asking for 200 lines of
  // context gives 401 lines × 100 = 40_100 chars, which exceeds the 20_000
  // budget. The shaper halves the window until it fits.
  const wideLines = [];
  for (let i = 1; i <= 50_000; i += 1) {
    wideLines.push('x'.repeat(100));
  }
  const src = wideLines.join('\n');
  const r = windowJsSource('https://x/big.js', src, { line: 25_000, context_lines: 200 });
  assert.strictEqual(r.truncated, true);
  assert.ok(r.source.length <= MAX_TOOL_OUTPUT_CHARS, `source ${r.source.length} > budget ${MAX_TOOL_OUTPUT_CHARS}`);
});

test('windowJsSource: format="raw" preserves single-line minified source as-is', () => {
  const minified = 'var x=1;var y=2;var z=3;'.repeat(100);
  const r = windowJsSource('https://x/y.js', minified, { line: 1, context_lines: 60, format: 'raw' });
  assert.strictEqual(r.format, 'raw');
  assert.strictEqual(r.total_lines, 1);
  assert.strictEqual(r.source, minified);
});

test('windowJsSource: format="pretty" splits minified single-line into multiple lines', () => {
  const minified = 'var x=1;var y=2;var z=3;'.repeat(60);
  // No explicit line → pretty-print-then-window branch, so total_lines
  // reflects the pretty-printed output. With an explicit line the window
  // stays in raw-source coordinates (total_lines = rawTotal) and only the
  // returned slice is pretty-printed; that branch is covered below.
  const r = windowJsSource('https://x/y.js', minified, { context_lines: 60, format: 'pretty' });
  assert.strictEqual(r.format, 'pretty');
  assert.ok(r.total_lines > 1, `expected multiple lines after pretty-print, got ${r.total_lines}`);

  // Explicit line: total_lines is raw (1), but the returned slice is
  // pretty-printed into multiple lines.
  const r2 = windowJsSource('https://x/y.js', minified, { line: 1, context_lines: 60, format: 'pretty' });
  assert.strictEqual(r2.format, 'pretty');
  assert.ok(
    r2.source.split('\n').length > 1,
    `expected pretty-printed slice to contain multiple lines, got ${r2.source.split('\n').length}`,
  );
});

test('windowJsSource: integer-coerces line + context_lines (defensive)', () => {
  const src = makeMultilineSource(50);
  const r = windowJsSource('https://x/y.js', src, { line: 25.7, context_lines: 5.3 });
  // Math.floor applied: line=25, context=5 → 20..30
  assert.strictEqual(r.start_line, 20);
  assert.strictEqual(r.end_line, 30);
});

test('windowJsSource: line=0 or negative clamps to 1', () => {
  const src = makeMultilineSource(10);
  const r = windowJsSource('https://x/y.js', src, { line: -5, context_lines: 3 });
  assert.strictEqual(r.start_line, 1);
});
