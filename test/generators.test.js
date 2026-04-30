import test from 'node:test';
import assert from 'node:assert';
import { runGeneratorCode, resolveGenerated } from '../dist/strategies/generators.js';

test('runGeneratorCode produces a UUID', () => {
  const result = runGeneratorCode('return crypto.randomUUID()', {});
  assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('runGeneratorCode produces foodora-style client_id', () => {
  const code = 'return Date.now() + "." + crypto.randomBytes(5).toString("hex").slice(0,9) + "." + crypto.randomBytes(4).toString("base64url").slice(0,6)';
  const result = runGeneratorCode(code, {});
  assert.match(result, /^\d{13}\.[0-9a-f]{9}\.[\w-]{6}$/);
});

test('runGeneratorCode reads args.query for HMAC', () => {
  const code = 'return crypto.createHmac("sha256", "key").update(args.query).digest("hex")';
  const a = runGeneratorCode(code, { query: 'sushi' });
  const b = runGeneratorCode(code, { query: 'sushi' });
  const c = runGeneratorCode(code, { query: 'pizza' });
  assert.strictEqual(a, b, 'same input gives same hash');
  assert.notStrictEqual(a, c, 'different input gives different hash');
});

test('runGeneratorCode infinite loop is killed by timeout', () => {
  const t0 = Date.now();
  assert.throws(
    () => runGeneratorCode('while(true){}', {}),
    /timed out/i,
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `should timeout fast, took ${elapsed}ms`);
});

test('runGeneratorCode cannot access require/process/fs', () => {
  assert.throws(() => runGeneratorCode('return require("fs").readFileSync("/etc/passwd")', {}), /require/);
  assert.throws(() => runGeneratorCode('return process.env.HOME', {}), /process/);
});

test('runGeneratorCode cannot mutate caller args', () => {
  const args = { query: 'sushi', count: 1 };
  // Sloppy mode: silently fails. Strict mode: throws.
  runGeneratorCode('args.query = "hacked"; return args.query;', args);
  assert.strictEqual(args.query, 'sushi', 'original args untouched');
});

test('runGeneratorCode rejects non-string return', () => {
  assert.throws(() => runGeneratorCode('return 42', {}), /must return a string/);
  assert.throws(() => runGeneratorCode('return {a:1}', {}), /must return a string/);
});

test('resolveGenerated handles code form', () => {
  const result = resolveGenerated(
    { id: { code: 'return crypto.randomUUID()' } },
    undefined,
    {},
  );
  assert.match(result.resolved.id, /^[0-9a-f-]{36}$/);
  assert.deepStrictEqual(result.needsLlm, {});
});

test('resolveGenerated returns instruction-form entries in needsLlm', () => {
  const result = resolveGenerated(
    {
      id: { code: 'return "abc"' },
      weird: { instruction: 'compute weird thing', examples: ['x', 'y'] },
    },
    undefined,
    {},
  );
  assert.strictEqual(result.resolved.id, 'abc');
  assert.deepStrictEqual(result.needsLlm.weird, {
    instruction: 'compute weird thing',
    examples: ['x', 'y'],
  });
});

test('resolveGenerated overrides take precedence', () => {
  const result = resolveGenerated(
    { weird: { instruction: 'compute weird thing' } },
    { weird: 'A1B2C3' },
    {},
  );
  assert.strictEqual(result.resolved.weird, 'A1B2C3');
  assert.deepStrictEqual(result.needsLlm, {});
});

test('resolveGenerated wraps generator errors with the field name', () => {
  assert.throws(
    () => resolveGenerated({ x: { code: 'throw new Error("boom")' } }, undefined, {}),
    /Generator 'x' failed.*boom/,
  );
});

test('resolveGenerated returns empty for undefined input', () => {
  const result = resolveGenerated(undefined, undefined, {});
  assert.deepStrictEqual(result, { resolved: {}, needsLlm: {} });
});
