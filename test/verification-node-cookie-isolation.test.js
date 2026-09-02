// `withFreshVerificationPool` strips persisted storage so cookies left by
// discovery are not implicit inputs to a verification run. That stripping is
// applied to the browser context. A `fetch` strategy fires from Node by default
// and reads the cookie jar straight off disk, so without the same exclusion a
// strategy that only works because discovery warmed the jar verifies clean and
// then 403s for every consumer that does not share that jar.
//
// Observed on reddit: connect-mode Chrome cleared a JS challenge, the challenge
// cookies landed in the platform jar, the Node fetch picked them up, and both
// post-save verification and the agent's review passed on a genuine 200. Every
// later execution in a home without those cookies returned 403.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-cookie-isolation-test-'));
process.env.KLURA_HOME = TMP;

const { execute } = await import('../dist/execution/index.js');
const skills = await import('../dist/strategies/skills.js');

const PLATFORM = 'cookie-iso';

// Echoes back what the request carried, and always sets a cookie of its own so
// the write-back half of the contract is observable too.
const received = [];
const server = http.createServer((req, res) => {
  received.push({ url: req.url, cookie: req.headers.cookie ?? null });
  res.setHeader('Set-Cookie', 'server_issued=yes; Path=/');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, saw_cookie: req.headers.cookie ?? null }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
// Keep the listener from holding the runner's event loop open after the last test.
server.unref();

process.on('exit', () => {
  try {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function strategy() {
  return {
    schema_version: 1,
    strategy: 'fetch',
    method: 'GET',
    baseUrl: BASE,
    endpoint: '/items',
    notes: { params: {} },
  };
}

function jarCookieNames() {
  const dir = path.join(TMP, 'storage-state');
  if (!fs.existsSync(dir)) return [];
  const file = fs.readdirSync(dir).find((n) => n.includes(PLATFORM));
  if (!file) return [];
  const state = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  return (state.cookies ?? []).map((c) => c.name).sort();
}

/** Reset the jar to exactly one discovery-established cookie. The jar is shared
 *  across tests in this file, so each one states the state it needs. */
function seedJar() {
  const dir = path.join(TMP, 'storage-state');
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (name.includes(PLATFORM)) fs.rmSync(path.join(dir, name), { force: true });
    }
  }
  skills.writeStorageStateCookies(PLATFORM, ['challenge_token=abc123; Path=/'], `${BASE}/items`);
}

test('a normal run sends the persisted cookie jar', async () => {
  seedJar();
  received.length = 0;

  const result = await execute(PLATFORM, 'list_items', {}, null, null, {
    _strategyOverride: [strategy()],
    _suppressStrategyState: true,
  });

  assert.equal(result.status, 200);
  assert.match(
    received.at(-1).cookie ?? '',
    /challenge_token=abc123/,
    'the everyday execute path must still carry the jar',
  );
});

test('a verification run fires with an empty jar', async () => {
  seedJar();
  received.length = 0;

  const result = await execute(PLATFORM, 'list_items', {}, null, null, {
    _strategyOverride: [strategy()],
    _suppressStrategyState: true,
    _suppressPersistedCookies: true,
  });

  assert.equal(result.status, 200);
  assert.equal(
    received.at(-1).cookie,
    null,
    'verification sent a cookie header built from discovery state it was supposed to exclude',
  );
});

test('a verification run does not write Set-Cookie back into the jar', async () => {
  seedJar();
  const before = jarCookieNames();
  assert.ok(before.includes('challenge_token'), 'seed cookie should be present');
  assert.ok(!before.includes('server_issued'), 'server cookie should not be there yet');

  await execute(PLATFORM, 'list_items', {}, null, null, {
    _strategyOverride: [strategy()],
    _suppressStrategyState: true,
    _suppressPersistedCookies: true,
  });

  assert.deepEqual(
    jarCookieNames(),
    before,
    'a run that fires without the jar must not warm it — the next verification would inherit exactly the implicit input this one excluded',
  );
});

test('a normal run still persists Set-Cookie', async () => {
  seedJar();

  await execute(PLATFORM, 'list_items', {}, null, null, {
    _strategyOverride: [strategy()],
    _suppressStrategyState: true,
  });

  assert.ok(
    jarCookieNames().includes('server_issued'),
    'the everyday path must keep rotating cookies into the jar',
  );
});
