// Unit tests for the public `getSecret` wrapper. Verifies the agent-facing
// path for fetching a password from a configured shell-command resolver
// during discovery. The private `resolveSecret` is also exported now so
// this test can exercise it through the `getSecret` wrapper.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate KLURA_HOME to a tmpdir so we can install/remove resolvers without
// touching the real ~/.klura/config.json. Must be set BEFORE importing klura
// so the secrets module picks it up at load time.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-secrets-'));
process.env.KLURA_HOME = tmpHome;

// Pre-populate a config.json with a trivial echo-based resolver.
fs.writeFileSync(
  path.join(tmpHome, 'config.json'),
  JSON.stringify(
    {
      secrets: {
        // `echo` gets the {{ref}} value substituted in. `resolveSecret`
        // strips the trailing newline, so the agent sees exactly `resolved-X`.
        testecho: 'echo resolved-{{ref}}',
      },
    },
    null,
    2,
  ),
);

const { getSecret, listSecretResolvers } = await import('../dist/index.js');

test('getSecret returns the resolver output wrapped in {value}', () => {
  const result = getSecret('testecho', 'foo');
  assert.deepStrictEqual(result, { value: 'resolved-foo' });
});

test('getSecret substitutes {{ref}} into the resolver command', () => {
  const result = getSecret('testecho', 'bar-baz-123');
  assert.deepStrictEqual(result, { value: 'resolved-bar-baz-123' });
});

test('getSecret throws a helpful error for an unknown scheme', () => {
  assert.throws(
    () => getSecret('nope', 'whatever'),
    (err) =>
      err instanceof Error &&
      err.message.includes('unknown scheme "nope"') &&
      err.message.includes('klura secret add'),
  );
});

test('getSecret throws a redacted error when the resolver command fails', () => {
  // Add a resolver that exits non-zero, then try to use it.
  const config = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf-8'));
  config.secrets.bad = 'false';
  fs.writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify(config));

  assert.throws(
    () => getSecret('bad', 'foo'),
    (err) =>
      err instanceof Error &&
      err.message.includes('secret resolution failed for scheme "bad"') &&
      err.message.includes('REDACTED') &&
      // The ref must not leak into the error message.
      !err.message.includes('foo'),
  );
});

test('listSecretResolvers surfaces all configured schemes', () => {
  const resolvers = listSecretResolvers();
  assert.ok(Object.keys(resolvers).length >= 1, 'at least the testecho resolver is present');
  assert.strictEqual(resolvers.testecho, 'echo resolved-{{ref}}');
});
