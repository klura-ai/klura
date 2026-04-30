// Unit tests for parseStack — engine-format-agnostic JS stack parser.
// V8 (Chromium) is the load-bearing case for klura since the playwright
// driver runs Chromium; SpiderMonkey + JSC are exercised so a future
// driver targeting Firefox / WebKit gets first-class support.

import test from 'node:test';
import assert from 'node:assert';

const { parseStack } = await import('../dist/response/stack-parse.js');

// ---- V8 (Chromium) ----

test('parseStack: V8 — named function with full file:line:col', () => {
  const raw = [
    'Error',
    '    at sendMessage (https://example.com/static/bundle.js:44821:5)',
    '    at HTMLButtonElement.handleClick (https://example.com/static/bundle.js:9000:1)',
  ].join('\n');
  const frames = parseStack(raw);
  assert.deepStrictEqual(frames, [
    { function: 'sendMessage', file: 'https://example.com/static/bundle.js', line: 44821, column: 5 },
    {
      function: 'HTMLButtonElement.handleClick',
      file: 'https://example.com/static/bundle.js',
      line: 9000,
      column: 1,
    },
  ]);
});

test('parseStack: V8 — anonymous frame at the top', () => {
  const raw = ['Error', '    at <anonymous>'].join('\n');
  const frames = parseStack(raw);
  assert.deepStrictEqual(frames, [{ function: '<anonymous>' }]);
});

test('parseStack: V8 — Object.<anonymous> with location', () => {
  const raw = ['Error', '    at Object.<anonymous> (https://x/y.js:1:1)'].join('\n');
  const frames = parseStack(raw);
  assert.deepStrictEqual(frames, [
    { function: 'Object.<anonymous>', file: 'https://x/y.js', line: 1, column: 1 },
  ]);
});

test('parseStack: V8 — native frame', () => {
  const raw = ['Error', '    at Array.forEach (native)'].join('\n');
  const frames = parseStack(raw);
  assert.deepStrictEqual(frames, [{ function: 'Array.forEach', native: true }]);
});

test('parseStack: V8 — no function name (just URL:line:col)', () => {
  const raw = ['Error', '    at https://x/y.js:42:10'].join('\n');
  const frames = parseStack(raw);
  assert.deepStrictEqual(frames, [{ file: 'https://x/y.js', line: 42, column: 10 }]);
});

test('parseStack: V8 — file with port preserved across colons', () => {
  // The parser must split on the LAST two colons so the port survives.
  const raw = ['Error', '    at fn (https://x:8080/y.js:10:5)'].join('\n');
  const frames = parseStack(raw);
  assert.deepStrictEqual(frames, [
    { function: 'fn', file: 'https://x:8080/y.js', line: 10, column: 5 },
  ]);
});

test('parseStack: V8 — async function frame', () => {
  const raw = [
    'Error',
    '    at async fetchUser (https://x/y.js:10:5)',
  ].join('\n');
  const frames = parseStack(raw);
  assert.deepStrictEqual(frames, [
    { function: 'async fetchUser', file: 'https://x/y.js', line: 10, column: 5 },
  ]);
});

test('parseStack: V8 — preserves frame ordering (innermost first)', () => {
  const raw = [
    'Error',
    '    at innermost (https://x/y.js:1:1)',
    '    at middle (https://x/y.js:2:1)',
    '    at outermost (https://x/y.js:3:1)',
  ].join('\n');
  const frames = parseStack(raw);
  assert.strictEqual(frames[0].function, 'innermost');
  assert.strictEqual(frames[2].function, 'outermost');
});

// ---- SpiderMonkey / JSC (Firefox / Safari) ----

test('parseStack: SpiderMonkey — named function with location', () => {
  const raw = ['sendMessage@https://x/y.js:10:5', 'handleClick@https://x/y.js:20:1'].join('\n');
  const frames = parseStack(raw);
  assert.deepStrictEqual(frames, [
    { function: 'sendMessage', file: 'https://x/y.js', line: 10, column: 5 },
    { function: 'handleClick', file: 'https://x/y.js', line: 20, column: 1 },
  ]);
});

test('parseStack: SpiderMonkey — anonymous frame (empty fn name)', () => {
  const raw = ['@https://x/y.js:10:5'].join('\n');
  const frames = parseStack(raw);
  assert.deepStrictEqual(frames, [
    { function: '<anonymous>', file: 'https://x/y.js', line: 10, column: 5 },
  ]);
});

test('parseStack: JSC — global code marker', () => {
  const raw = ['fn@https://x/y.js:10:5', 'global code@<anonymous>:1:1'].join('\n');
  const frames = parseStack(raw);
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[0].function, 'fn');
  assert.strictEqual(frames[1].function, 'global code');
});

// ---- Robustness ----

test('parseStack: empty input returns empty array', () => {
  assert.deepStrictEqual(parseStack(''), []);
});

test('parseStack: non-string input returns empty array', () => {
  assert.deepStrictEqual(parseStack(undefined), []);
  assert.deepStrictEqual(parseStack(null), []);
  assert.deepStrictEqual(parseStack(123), []);
});

test('parseStack: unrecognized format returns empty array (does not throw)', () => {
  const raw = 'plain text with no recognizable frame markers\nstill no frames';
  assert.deepStrictEqual(parseStack(raw), []);
});

test('parseStack: V8 — junk lines between frames are tolerated', () => {
  const raw = [
    'Error: oops',
    'random non-frame line',
    '    at fn (https://x/y.js:1:1)',
    '',
    '    at fn2 (https://x/y.js:2:1)',
  ].join('\n');
  const frames = parseStack(raw);
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[0].function, 'fn');
  assert.strictEqual(frames[1].function, 'fn2');
});
