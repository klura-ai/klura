import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-identity-permissions-'));
process.env.KLURA_HOME = tmpHome;

const identitiesPath = path.join(tmpHome, 'identities.json');
const { getIdentity, setIdentity, setIdentityFields } = await import(
  '../dist/identity/identities.js'
);

test('identity writes are atomic and owner-only on create and update', () => {
  setIdentity('example', 'email', 'user@example.com');
  assert.ok(!fs.existsSync(`${identitiesPath}.tmp`), 'tmp file should be renamed');
  assert.strictEqual(fs.statSync(identitiesPath).mode & 0o777, 0o600);

  fs.chmodSync(identitiesPath, 0o644);
  setIdentityFields('example', { username: 'example_user' });
  assert.ok(!fs.existsSync(`${identitiesPath}.tmp`), 'tmp file should be renamed on update');
  assert.strictEqual(fs.statSync(identitiesPath).mode & 0o777, 0o600);
  assert.deepStrictEqual(getIdentity('example'), {
    email: 'user@example.com',
    username: 'example_user',
  });
});
