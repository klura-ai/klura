// Unit tests for hasTopLevelReturn — the depth-aware scanner that decides
// whether evaluateExpression wraps the agent's expression as a block body
// (top-level `return`) or as an expression body (no top-level `return`).

import test from 'node:test';
import assert from 'node:assert';

const {
  hasTopLevelReturn,
  hasTopLevelStatement,
  hasTopLevelStatementSeparator,
  needsBlockBodyWrap,
  wrapAgentExpression,
} = await import('../dist/response/js-eval-wrapper.js');

test('pure expression has no top-level return', () => {
  assert.strictEqual(hasTopLevelReturn('1 + 2'), false);
  assert.strictEqual(hasTopLevelReturn('await window.foo()'), false);
  assert.strictEqual(hasTopLevelReturn('typeof x === "string" ? x : null'), false);
});

test('top-level return statement detected', () => {
  assert.strictEqual(hasTopLevelReturn('const x = 1; return x;'), true);
  assert.strictEqual(hasTopLevelReturn('return 42'), true);
});

test('nested return inside IIFE does not count as top-level', () => {
  assert.strictEqual(hasTopLevelReturn('(() => { return 42; })()'), false);
  assert.strictEqual(hasTopLevelReturn('(function() { return x; })()'), false);
  assert.strictEqual(
    hasTopLevelReturn('(async () => { const r = await fetch("/x"); return r.text(); })()'),
    false,
  );
});

test('return inside string literal ignored', () => {
  assert.strictEqual(hasTopLevelReturn('"return this"'), false);
  assert.strictEqual(hasTopLevelReturn("'return'"), false);
  assert.strictEqual(hasTopLevelReturn('`return ${x}`'), false);
});

test('return inside comment ignored', () => {
  assert.strictEqual(hasTopLevelReturn('// return x\nx'), false);
  assert.strictEqual(hasTopLevelReturn('/* return */ x'), false);
});

test('word boundary: `returning` does not trigger', () => {
  assert.strictEqual(hasTopLevelReturn('returning'), false);
  assert.strictEqual(hasTopLevelReturn('myreturn'), false);
});

test('template literal ${} content scanned but only at its own depth', () => {
  // Inside ${} the depth is ≥1 so a return there is nested.
  assert.strictEqual(hasTopLevelReturn('`${(() => { return 1; })()}`'), false);
});

test('hasTopLevelStatement: declarations at depth 0', () => {
  assert.strictEqual(hasTopLevelStatement('const x = 1; x'), true);
  assert.strictEqual(hasTopLevelStatement('let x = 1; x'), true);
  assert.strictEqual(hasTopLevelStatement('var x = 1; x'), true);
  assert.strictEqual(hasTopLevelStatement('function f() { return 1; } f()'), true);
  assert.strictEqual(hasTopLevelStatement('class Foo {} new Foo()'), true);
});

test('hasTopLevelStatement: control-flow statements at depth 0', () => {
  assert.strictEqual(
    hasTopLevelStatement('try { require("X") } catch(e) { e.message }'),
    true,
  );
  assert.strictEqual(hasTopLevelStatement('if (x) { x } else { null }'), true);
  assert.strictEqual(hasTopLevelStatement('for (var i=0;i<3;i++) { x }'), true);
  assert.strictEqual(hasTopLevelStatement('while (cond) { break }'), true);
  assert.strictEqual(hasTopLevelStatement('do { x } while (cond)'), true);
  assert.strictEqual(hasTopLevelStatement('switch (x) { case 1: break }'), true);
  assert.strictEqual(hasTopLevelStatement('throw new Error("x")'), true);
});

test('hasTopLevelStatement: nested statements do not count', () => {
  assert.strictEqual(hasTopLevelStatement('(() => { const x = 1; return x; })()'), false);
  assert.strictEqual(hasTopLevelStatement('(function() { var y = 2; return y; })()'), false);
  assert.strictEqual(
    hasTopLevelStatement('(() => { try { return foo() } catch(e) { return null } })()'),
    false,
  );
});

test('hasTopLevelStatement: keywords in strings/comments ignored', () => {
  assert.strictEqual(hasTopLevelStatement('"const x"'), false);
  assert.strictEqual(hasTopLevelStatement('// const x\n1'), false);
  assert.strictEqual(hasTopLevelStatement('"try { x }"'), false);
  assert.strictEqual(hasTopLevelStatement('// if (x) y\nz'), false);
});

test('hasTopLevelStatement: word boundary', () => {
  assert.strictEqual(hasTopLevelStatement('constant'), false);
  assert.strictEqual(hasTopLevelStatement('myvar'), false);
  assert.strictEqual(hasTopLevelStatement('trying'), false);
  assert.strictEqual(hasTopLevelStatement('iffy'), false);
  assert.strictEqual(hasTopLevelStatement('forever'), false);
});

test('needsBlockBodyWrap: unifies return + statement detection', () => {
  assert.strictEqual(needsBlockBodyWrap('1 + 2'), false);
  assert.strictEqual(needsBlockBodyWrap('return 42'), true);
  assert.strictEqual(needsBlockBodyWrap('const x = 1; x'), true);
  assert.strictEqual(needsBlockBodyWrap('try { x } catch(e) {}'), true);
  // Precedent case: agent pastes a REPL-style probe of a module system.
  assert.strictEqual(
    needsBlockBodyWrap(
      'try { var m = require("X"); typeof m; } catch(e) { e.message }',
    ),
    true,
  );
});

test('wrapAgentExpression: expression-body for plain expression', () => {
  const w = wrapAgentExpression('1 + 2');
  assert.ok(w.includes('Promise.resolve(1 + 2)'));
  assert.ok(!w.includes('async () => { 1 + 2 }'));
});

test('wrapAgentExpression: block-body when top-level const', () => {
  const w = wrapAgentExpression('const a = 1; const b = 2; return a + b;');
  assert.ok(w.includes('(async () => { const a = 1; const b = 2; return a + b; })()'));
});

// ---- hasTopLevelStatementSeparator ----

test('hasTopLevelStatementSeparator: expr1; expr2 → true', () => {
  // The wiki-run trigger: two top-level expressions separated by a
  // semicolon. Expression-body wrap cannot handle this; block-body can.
  assert.strictEqual(
    hasTopLevelStatementSeparator(
      'document.getElementById(\'wpSummary\').value = \'klura test run\'; \'done\'',
    ),
    true,
  );
});

test('hasTopLevelStatementSeparator: trailing semicolon only → false', () => {
  // `expr;` with nothing after is benign — expression-body wraps it
  // fine. No need to force block-body.
  assert.strictEqual(hasTopLevelStatementSeparator('1 + 2;'), false);
  assert.strictEqual(hasTopLevelStatementSeparator('window.foo();'), false);
  assert.strictEqual(hasTopLevelStatementSeparator('x;   \n  \t  '), false);
});

test('hasTopLevelStatementSeparator: for-loop ; inside parens ignored', () => {
  assert.strictEqual(
    hasTopLevelStatementSeparator('(() => { for (let i=0; i<n; i++) y(i); })()'),
    false,
    'inner ; are depth > 0',
  );
});

test('hasTopLevelStatementSeparator: ; inside strings ignored', () => {
  assert.strictEqual(hasTopLevelStatementSeparator('"a; b"'), false);
  assert.strictEqual(hasTopLevelStatementSeparator("'x; y'"), false);
});

test('hasTopLevelStatementSeparator: ; inside template ${} ignored', () => {
  assert.strictEqual(hasTopLevelStatementSeparator('`${a; b}`'), false);
});

test('needsBlockBodyWrap: picks up top-level ; separator', () => {
  assert.strictEqual(
    needsBlockBodyWrap("document.getElementById('x').value = 'y'; 'done'"),
    true,
    'previously missed case — this was the wiki SyntaxError trigger',
  );
  assert.strictEqual(needsBlockBodyWrap('1 + 2;'), false, 'trailing ; alone stays expression');
});

test('wrapAgentExpression: expr1; expr2 routes through block-body', () => {
  const w = wrapAgentExpression("a = 1; 'done'");
  assert.ok(
    w.includes("(async () => { a = 1; 'done' })()"),
    `expected block-body wrap, got: ${w}`,
  );
  assert.ok(!w.match(/Promise\.resolve\(a = 1; /), 'must not fall through to expression-body');
});
