// Multi-account / named-identity unit tests. Real-browser integration
// coverage isn't needed here — the load-bearing logic is path resolution
// and warm-pool keying, both pure functions. End-to-end "two cookie jars
// land on disk" is verified by the manual dev-loop check in
// runtime/docs/popups.md§Verification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate KLURA_HOME so the user's local config (pool.driver references,
// identities.json, etc.) doesn't leak into these tests.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-multi-account-'));
process.env.KLURA_HOME = TMP;
test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const { storageStatePath, loadStorageStatePath, writeStorageStateCookies, readStorageStateCookies } =
  await import('../dist/strategies/storage-state.js');
const { getIdentity } = await import('../dist/identity/identities.js');

// ---------- Path resolution ----------

test('storageStatePath: default identity → unsuffixed platform path', () => {
  const a = storageStatePath('facebook');
  const b = storageStatePath('facebook', undefined);
  const c = storageStatePath('facebook', 'default');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.match(a, /\/storage-state\/facebook\.json$/);
});

test('storageStatePath: named identity → <platform>--<identity>.json', () => {
  assert.match(storageStatePath('facebook', 'work'), /\/storage-state\/facebook--work\.json$/);
  assert.match(storageStatePath('facebook', 'personal'), /\/storage-state\/facebook--personal\.json$/);
});

test('storageStatePath: dash-in-platform parses unambiguously alongside identity', () => {
  // `facebook-business--work.json` is the named-identity path; the runtime
  // never reverse-parses the filename, just constructs it from the tuple.
  assert.match(
    storageStatePath('facebook-business', 'work'),
    /\/storage-state\/facebook-business--work\.json$/,
  );
});

// ---------- Cookie write isolation ----------

test('writeStorageStateCookies: default and named jars don\'t collide', () => {
  // Write a cookie under the default identity and a different one under a named
  // identity. Each jar should hold only its own entry.
  writeStorageStateCookies(
    'demo',
    ['session=default-token; Domain=example.com; Path=/'],
    'https://example.com/',
  );
  writeStorageStateCookies(
    'demo',
    ['session=work-token; Domain=example.com; Path=/'],
    'https://example.com/',
    'work',
  );
  const def = readStorageStateCookies('demo', 'https://example.com/');
  const work = readStorageStateCookies('demo', 'https://example.com/', 'work');
  assert.equal(def.cookies.length, 1);
  assert.equal(def.cookies[0].value, 'default-token');
  assert.equal(work.cookies.length, 1);
  assert.equal(work.cookies[0].value, 'work-token');
  // The default jar must not see the work entry, and vice versa.
  assert.notEqual(def.cookies[0].value, work.cookies[0].value);
});

test('loadStorageStatePath: returns null when the named jar doesn\'t exist', () => {
  assert.equal(loadStorageStatePath('does-not-exist-platform', 'work'), null);
});

// ---------- Identity profile lookup with fallback ----------

test('getIdentity: default identity reads platform-only key', () => {
  // Seed the identities.json file directly. Schema: top-level slot keyed by
  // platform (default) or by `<platform>--<identity>` (named).
  const identitiesPath = path.join(TMP, 'identities.json');
  fs.writeFileSync(
    identitiesPath,
    JSON.stringify({
      acme: { name: 'Default User', email: 'default@acme.test' },
      'acme--work': { name: 'Work User', email: 'work@acme.test' },
    }),
  );
  const def = getIdentity('acme');
  assert.equal(def.name, 'Default User');
  const explicit = getIdentity('acme', 'default');
  assert.equal(explicit.name, 'Default User');
});

test('getIdentity: named identity reads scoped slot', () => {
  const work = getIdentity('acme', 'work');
  assert.equal(work.name, 'Work User');
  assert.equal(work.email, 'work@acme.test');
});

test('getIdentity: missing scoped profile falls back to platform-default with stderr warning', () => {
  // Capture stderr.
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // First call: warns + falls back to default.
    const fallback1 = getIdentity('acme', 'no_scoped_profile');
    assert.equal(fallback1.name, 'Default User');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no scoped profile/);
    // Second call for the same (platform, identity): does NOT re-warn (one-shot).
    const fallback2 = getIdentity('acme', 'no_scoped_profile');
    assert.equal(fallback2.name, 'Default User');
    assert.equal(warnings.length, 1, 'expected the warning to fire once per (platform, identity)');
    // Different identity name → fresh warning.
    const fallback3 = getIdentity('acme', 'another_unscoped');
    assert.equal(fallback3.name, 'Default User');
    assert.equal(warnings.length, 2, 'expected a fresh warning for a different unscoped identity');
  } finally {
    console.warn = origWarn;
  }
});

test('getIdentity: invalid identity slug rejects', () => {
  // Empty string + the literal 'default' both coerce to default-identity (no
  // throw — they fall through to the platform-default slot). Non-default
  // values must satisfy `asIdentifierSlug` (snake_case, ≤40 chars).
  assert.equal(getIdentity('acme', '').name, 'Default User');
  assert.throws(() => getIdentity('acme', 'has space'), /identity/);
  assert.throws(() => getIdentity('acme', 'has-dash'), /identity/);
  assert.throws(() => getIdentity('acme', '../escape'), /identity/);
});

// ---------- Pool warm-key composition ----------

test('pool: same-platform-different-identity calls don\'t share warm slots', async () => {
  // Use a stub driver to exercise pool warm-key keying without launching
  // playwright. Two createSession calls for distinct identities should land
  // in distinct warm slots so the second doesn't reuse the first's cookies.
  const { Pool } = await import('../dist/pool/pool.js');
  let nextId = 0;
  class StubDriver {
    constructor() {
      this.created = [];
      this.reset = [];
      this.destroyed = [];
    }
    get capabilities() {
      return [];
    }
    async createSession(opts) {
      const session = {
        id: `stub_${++nextId}`,
        intercepted: [],
        intercepting: false,
        platform: opts?.platform,
        identity: opts?.identity,
      };
      this.created.push({ id: session.id, ...opts });
      return session;
    }
    async resetSession(session, opts) {
      this.reset.push({ id: session.id, ...opts });
    }
    async destroySession(session) {
      this.destroyed.push(session.id);
    }
    async closeBrowser() {}
  }
  const driver = new StubDriver();
  // Construct via the constructor's optional driver arg path. Pool's
  // constructor accepts a DriverCtor; pass a class that returns our stub.
  const pool = new Pool(/** @type {any} */ (function () { return driver; }), {
    warm: { enabled: true, maxContexts: 4, idleTtlSeconds: 300 },
  });
  try {
    const a = await pool.createSession({ platform: 'demo', identity: 'work' });
    const b = await pool.createSession({ platform: 'demo', identity: 'personal' });
    // Distinct IDs and distinct warm slots — neither reuses the other.
    assert.notEqual(a.id, b.id);
    assert.equal(driver.created.length, 2, 'expected two cold spawns (one per identity)');
    assert.equal(driver.reset.length, 0, 'expected no resetSession calls');
    // Releasing a should leave it idle in its slot. Creating another for
    // identity=work then reuses it.
    await pool.closeSession(a.id);
    const c = await pool.createSession({ platform: 'demo', identity: 'work' });
    assert.equal(driver.reset.length, 1, 'expected the work slot to reset on reuse');
    assert.equal(driver.created.length, 2, 'no new cold spawn for the reused identity');
    // c is the same Session object as a was (id rotated by warm reuse).
    assert.equal(c.identity, 'work');
  } finally {
    await pool.shutdown();
  }
});
