// Unit tests for the validators module — the foundation every other
// validation path leans on. Pure functions, no I/O, fast.

import test from 'node:test';
import assert from 'node:assert';
import {
  ValidationError,
  asString,
  asNonEmptyString,
  asBoundedString,
  asNonEmptyBoundedString,
  asObject,
  asArray,
  asNonEmptyArray,
  asEnum,
  asPositiveInt,
  asNonNegativeInt,
  asPlatformSlug,
  asIdentifierSlug,
  asUrl,
  assertNoReservedKeys,
} from '../dist/validators/index.js';
import {
  asBoundedScript,
  asReturnShape,
  assertReturnShape,
  JS_EVAL_SCRIPT_MAX,
} from '../dist/strategies/js-eval-validators.js';

// ---- ValidationError ----

test('ValidationError stores field + message', () => {
  const err = new ValidationError('strategy.platform', 'must be a string');
  assert.strictEqual(err.field, 'strategy.platform');
  assert.strictEqual(err.message, 'strategy.platform: must be a string');
  assert.strictEqual(err.name, 'ValidationError');
  assert.ok(err instanceof Error);
});

// ---- asString ----

test('asString accepts a string', () => {
  assert.strictEqual(asString('hello', 'x'), 'hello');
  assert.strictEqual(asString('', 'x'), ''); // empty is allowed at this level
});

test('asString rejects non-strings with a helpful describe', () => {
  assert.throws(() => asString(42, 'x'), /x: must be a string \(got number\)/);
  assert.throws(() => asString(null, 'x'), /x: must be a string \(got null\)/);
  assert.throws(() => asString(undefined, 'x'), /x: must be a string \(got undefined\)/);
  assert.throws(() => asString({}, 'x'), /x: must be a string \(got object\)/);
  assert.throws(() => asString([], 'x'), /x: must be a string \(got array\)/);
});

// ---- asNonEmptyString ----

test('asNonEmptyString rejects empty', () => {
  assert.throws(() => asNonEmptyString('', 'x'), /x: must be a non-empty string/);
});

test('asNonEmptyString accepts non-empty', () => {
  assert.strictEqual(asNonEmptyString('hi', 'x'), 'hi');
});

// ---- asBoundedString ----

test('asBoundedString enforces max length', () => {
  assert.strictEqual(asBoundedString('short', 'x', 100), 'short');
  assert.throws(
    () => asBoundedString('x'.repeat(101), 'field', 100),
    /field: must be at most 100 characters \(got 101\)/,
  );
});

test('asBoundedString defaults to 10000', () => {
  assert.doesNotThrow(() => asBoundedString('x'.repeat(10_000), 'x'));
  assert.throws(() => asBoundedString('x'.repeat(10_001), 'x'), /at most 10000/);
});

// ---- asObject ----

test('asObject accepts plain objects', () => {
  const o = { a: 1 };
  assert.strictEqual(asObject(o, 'x'), o);
});

test('asObject rejects arrays, null, primitives', () => {
  assert.throws(() => asObject([], 'x'), /x: must be a plain object \(got array\)/);
  assert.throws(() => asObject(null, 'x'), /x: must be a plain object \(got null\)/);
  assert.throws(() => asObject('s', 'x'), /x: must be a plain object \(got string\)/);
  assert.throws(() => asObject(42, 'x'), /x: must be a plain object \(got number\)/);
});

// ---- asArray ----

test('asArray accepts arrays', () => {
  assert.deepStrictEqual(asArray([1, 2], 'x'), [1, 2]);
  assert.deepStrictEqual(asArray([], 'x'), []);
});

test('asArray rejects non-arrays', () => {
  assert.throws(() => asArray({}, 'x'), /x: must be an array \(got object\)/);
  assert.throws(() => asArray(null, 'x'), /x: must be an array \(got null\)/);
});

test('asNonEmptyArray rejects empty', () => {
  assert.throws(() => asNonEmptyArray([], 'x'), /x: must be a non-empty array/);
});

// ---- asEnum ----

test('asEnum accepts allowed values', () => {
  const ALLOWED = ['a', 'b', 'c'];
  assert.strictEqual(asEnum('a', 'x', ALLOWED), 'a');
});

test('asEnum rejects with the full allowed list in the error message', () => {
  const ALLOWED = ['browser', 'cached', 'page-extract'];
  assert.throws(
    () => asEnum('GET', 'method', ALLOWED),
    /method: = "GET" is not allowed; must be one of: "browser", "cached", "page-extract"/,
  );
});

// ---- asPositiveInt ----

test('asPositiveInt accepts positive integers', () => {
  assert.strictEqual(asPositiveInt(1, 'x'), 1);
  assert.strictEqual(asPositiveInt(100, 'x'), 100);
});

test('asPositiveInt rejects zero, negative, float, NaN, non-number', () => {
  assert.throws(() => asPositiveInt(0, 'x'), /must be a positive integer/);
  assert.throws(() => asPositiveInt(-1, 'x'), /must be a positive integer/);
  assert.throws(() => asPositiveInt(1.5, 'x'), /must be a positive integer/);
  assert.throws(() => asPositiveInt(NaN, 'x'), /must be a positive integer/);
  assert.throws(() => asPositiveInt('5', 'x'), /must be a positive integer/);
});

test('asNonNegativeInt accepts zero', () => {
  assert.strictEqual(asNonNegativeInt(0, 'x'), 0);
  assert.strictEqual(asNonNegativeInt(5, 'x'), 5);
  assert.throws(() => asNonNegativeInt(-1, 'x'), /must be a non-negative integer/);
});

// ---- asPlatformSlug ----

test('asPlatformSlug accepts kebab-case platform names', () => {
  assert.strictEqual(asPlatformSlug('github', 'platform'), 'github');
  assert.strictEqual(asPlatformSlug('chat-app', 'platform'), 'chat-app');
  assert.strictEqual(asPlatformSlug('facebook-messenger', 'platform'), 'facebook-messenger');
  assert.strictEqual(asPlatformSlug('hackernews', 'platform'), 'hackernews');
});

test('asPlatformSlug rejects underscores, uppercase, path traversal', () => {
  assert.throws(() => asPlatformSlug('food_delivery', 'platform'), /kebab-case/);
  assert.throws(() => asPlatformSlug('Github', 'platform'), /kebab-case/);
  assert.throws(() => asPlatformSlug('../etc/passwd', 'platform'), /kebab-case/);
  assert.throws(() => asPlatformSlug('foo/bar', 'platform'), /kebab-case/);
  assert.throws(() => asPlatformSlug('foo.bar', 'platform'), /kebab-case/);
  assert.throws(() => asPlatformSlug('foo bar', 'platform'), /kebab-case/);
  assert.throws(() => asPlatformSlug('', 'platform'), /must be a non-empty string/);
});

test('asPlatformSlug rejects very long input', () => {
  assert.throws(() => asPlatformSlug('a'.repeat(65), 'platform'), /must be at most 64 characters/);
});

// ---- asIdentifierSlug ----

test('asIdentifierSlug accepts snake_case identifiers', () => {
  assert.strictEqual(asIdentifierSlug('send_message', 'capability'), 'send_message');
  assert.strictEqual(asIdentifierSlug('get_user_posts', 'capability'), 'get_user_posts');
  assert.strictEqual(asIdentifierSlug('abc', 'capability'), 'abc');
});

test('asIdentifierSlug rejects dashes, uppercase, leading digits', () => {
  assert.throws(() => asIdentifierSlug('send-message', 'capability'), /snake_case/);
  assert.throws(() => asIdentifierSlug('SendMessage', 'capability'), /snake_case/);
  assert.throws(() => asIdentifierSlug('1_capability', 'capability'), /snake_case/);
  assert.throws(() => asIdentifierSlug('ab', 'capability'), /snake_case/);
});

test('asIdentifierSlug rejects > 40 chars', () => {
  assert.throws(() => asIdentifierSlug('a'.repeat(41), 'capability'), /must be at most 40 characters/);
});

// ---- asUrl ----

test('asUrl accepts http/https', () => {
  assert.strictEqual(asUrl('https://example.com/foo', 'url'), 'https://example.com/foo');
  assert.strictEqual(asUrl('http://localhost:3000', 'url'), 'http://localhost:3000');
});

test('asUrl rejects javascript:, data:, file: schemes by default', () => {
  assert.throws(() => asUrl('javascript:alert(1)', 'url'), /URL scheme "javascript:" not allowed/);
  assert.throws(() => asUrl('data:text/html,<script>', 'url'), /URL scheme "data:" not allowed/);
  assert.throws(() => asUrl('file:///etc/passwd', 'url'), /URL scheme "file:" not allowed/);
});

test('asUrl rejects malformed URLs', () => {
  assert.throws(() => asUrl('not a url', 'url'), /is not a valid URL/);
  assert.throws(() => asUrl('://nope', 'url'), /is not a valid URL/);
});

test('asUrl honors a custom scheme allowlist', () => {
  assert.strictEqual(
    asUrl('ws://localhost:3004', 'url', { schemes: new Set(['ws:', 'wss:']) }),
    'ws://localhost:3004',
  );
  assert.throws(
    () => asUrl('https://foo', 'url', { schemes: new Set(['ws:', 'wss:']) }),
    /URL scheme "https:" not allowed/,
  );
});

// ---- assertNoReservedKeys ----

test('assertNoReservedKeys passes on safe keys', () => {
  assert.doesNotThrow(() =>
    assertNoReservedKeys({ email: 'a@b', username: 'u' }, 'identity'),
  );
});

// ---- asBoundedScript ----

test('asBoundedScript accepts a balanced async expression', () => {
  assert.strictEqual(
    asBoundedScript('await window.foo.mint()', 'expr'),
    'await window.foo.mint()',
  );
  assert.strictEqual(
    asBoundedScript("document.querySelector('meta[name=x]').content", 'expr'),
    "document.querySelector('meta[name=x]').content",
  );
  assert.strictEqual(
    asBoundedScript('`prefix-${id}`', 'expr'),
    '`prefix-${id}`',
  );
});

test('asBoundedScript rejects unbalanced brackets', () => {
  assert.throws(() => asBoundedScript('window.foo.mint(', 'expr'), /unbalanced/);
  assert.throws(() => asBoundedScript('await window[x', 'expr'), /unbalanced/);
  assert.throws(() => asBoundedScript('({a: 1', 'expr'), /unbalanced/);
});

test('asBoundedScript rejects unbalanced quotes', () => {
  assert.throws(() => asBoundedScript("'foo", 'expr'), /unbalanced/);
  assert.throws(() => asBoundedScript('"foo', 'expr'), /unbalanced/);
  assert.throws(() => asBoundedScript('`foo', 'expr'), /unbalanced/);
});

test('asBoundedScript allows escaped quotes', () => {
  assert.strictEqual(asBoundedScript("'a\\'b'", 'expr'), "'a\\'b'");
  assert.strictEqual(asBoundedScript('"\\""', 'expr'), '"\\""');
});

test('asBoundedScript enforces default length cap', () => {
  const big = 'a' + '.a'.repeat(JS_EVAL_SCRIPT_MAX);
  assert.throws(() => asBoundedScript(big, 'expr'), new RegExp(`at most ${JS_EVAL_SCRIPT_MAX}`));
});

test('asBoundedScript rejects empty', () => {
  assert.throws(() => asBoundedScript('', 'expr'), /must be a non-empty string/);
});

// ---- asReturnShape ----

test('asReturnShape accepts string with bounds', () => {
  const shape = asReturnShape({ kind: 'string', min_length: 10, max_length: 200 }, 'rs');
  assert.deepStrictEqual(shape, { kind: 'string', min_length: 10, max_length: 200 });
});

test('asReturnShape accepts object with required_keys', () => {
  const shape = asReturnShape(
    { kind: 'object', required_keys: ['token', 'expires_at'] },
    'rs',
  );
  assert.deepStrictEqual(shape, {
    kind: 'object',
    required_keys: ['token', 'expires_at'],
  });
});

test('asReturnShape rejects invalid kind', () => {
  assert.throws(() => asReturnShape({ kind: 'float' }, 'rs'), /not allowed/);
});

test('asReturnShape rejects min_length > max_length', () => {
  assert.throws(
    () => asReturnShape({ kind: 'string', min_length: 200, max_length: 10 }, 'rs'),
    /must be <= max_length/,
  );
});

test('asReturnShape rejects min_length on non-string kind', () => {
  assert.throws(
    () => asReturnShape({ kind: 'number', min_length: 10 }, 'rs'),
    /only valid when kind === "string"/,
  );
});

test('asReturnShape rejects required_keys on non-object kind', () => {
  assert.throws(
    () => asReturnShape({ kind: 'string', required_keys: ['x'] }, 'rs'),
    /only valid when kind === "object"/,
  );
});

// ---- assertReturnShape ----

test('assertReturnShape validates string bounds', () => {
  const shape = { kind: 'string', min_length: 5, max_length: 20 };
  assert.strictEqual(assertReturnShape('hello world', shape, 'v'), 'hello world');
  assert.throws(() => assertReturnShape('x', shape, 'v'), /shorter than declared min_length/);
  assert.throws(() => assertReturnShape('x'.repeat(21), shape, 'v'), /longer than declared max_length/);
  assert.throws(() => assertReturnShape(42, shape, 'v'), /must be a string/);
});

test('assertReturnShape validates number', () => {
  const shape = { kind: 'number' };
  assert.strictEqual(assertReturnShape(42, shape, 'v'), '42');
  assert.throws(() => assertReturnShape('42', shape, 'v'), /must be a finite number/);
  assert.throws(() => assertReturnShape(Infinity, shape, 'v'), /must be a finite number/);
  assert.throws(() => assertReturnShape(NaN, shape, 'v'), /must be a finite number/);
});

test('assertReturnShape validates boolean', () => {
  const shape = { kind: 'boolean' };
  assert.strictEqual(assertReturnShape(true, shape, 'v'), 'true');
  assert.strictEqual(assertReturnShape(false, shape, 'v'), 'false');
  assert.throws(() => assertReturnShape(1, shape, 'v'), /must be a boolean/);
});

test('assertReturnShape validates object required_keys', () => {
  const shape = { kind: 'object', required_keys: ['token', 'expires_at'] };
  const obj = { token: 'abc', expires_at: 12345 };
  const json = assertReturnShape(obj, shape, 'v');
  assert.deepStrictEqual(JSON.parse(json), obj);
  assert.throws(
    () => assertReturnShape({ token: 'abc' }, shape, 'v'),
    /missing required key "expires_at"/,
  );
});

test('assertReturnShape rejects null in required_keys', () => {
  const shape = { kind: 'object', required_keys: ['token'] };
  assert.throws(
    () => assertReturnShape({ token: null }, shape, 'v'),
    /missing required key "token"/,
  );
});

test('assertNoReservedKeys rejects __proto__ / constructor / prototype', () => {
  // Object literal { __proto__: ... } is special-cased by the parser to set
  // the prototype, not create a key. Use defineProperty to actually have
  // a key named "__proto__" — which is what attackers do via JSON.parse.
  const protoKey = {};
  Object.defineProperty(protoKey, '__proto__', {
    value: 'x',
    enumerable: true,
    configurable: true,
    writable: true,
  });
  assert.throws(
    () => assertNoReservedKeys(protoKey, 'identity'),
    /identity: key "__proto__" is reserved/,
  );

  // JSON.parse goes through the same path adversaries actually use.
  const parsed = JSON.parse('{"__proto__": "polluted"}');
  assert.throws(
    () => assertNoReservedKeys(parsed, 'identity'),
    /identity: key "__proto__" is reserved/,
  );

  assert.throws(
    () => assertNoReservedKeys({ constructor: 'x' }, 'identity'),
    /identity: key "constructor" is reserved/,
  );
  assert.throws(
    () => assertNoReservedKeys({ prototype: 'x' }, 'identity'),
    /identity: key "prototype" is reserved/,
  );
});
