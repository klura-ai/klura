// Daemon IPC round-trip: spawn a real daemon process, send requests over the
// Unix socket, assert the response shapes. Catches breakage in the CLI ↔
// daemon HTTP wire without spinning up a browser pool.
//
// We never hit session endpoints, so chromium doesn't actually launch — the
// pool is constructed (which requires playwright to load) but no browser is
// created.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-daemon-test-'));

// KLURA_HOME must be set BEFORE importing daemon.js so module-level constants
// (SOCKET_PATH, PID_FILE, etc.) are rooted in the test dir instead of ~/.klura.
process.env.KLURA_HOME = TMP;

fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(
  path.join(TMP, 'config.json'),
  JSON.stringify({
    runtime: { idleTimeout: 30, listen: 'unix' },
    pool: { maxSessions: 1, idleTimeout: 30 },
  }),
);

// Import the helpers we want to directly unit-test. The pure helpers
// (parseListen, loadConfig) are imported from the test process so their
// coverage counts. The CLI-side helpers (isDaemonRunning, sendToDaemon,
// ensureDaemon) are also imported and tested against the forked daemon.
const daemonMod = await import('../dist/daemon.js');
const { parseListen, loadConfig, isDaemonRunning, sendToDaemon, ensureDaemon } = daemonMod;

const SOCKET = path.join(TMP, 'klura.sock');
const DAEMON_SCRIPT = path.resolve(new URL(import.meta.url).pathname, '..', '..', 'bin', 'klura-daemon.js');

let daemon;

async function waitForSocket(deadline) {
  while (Date.now() < deadline) {
    if (fs.existsSync(SOCKET)) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('daemon socket did not appear in time');
}

function ipc(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        socketPath: SOCKET,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', c => data += c.toString());
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  daemon = cp.fork(DAEMON_SCRIPT, [], {
    env: { ...process.env, KLURA_HOME: TMP },
    stdio: 'ignore',
  });
  await waitForSocket(Date.now() + 15000);
});

test.after(async () => {
  if (daemon && !daemon.killed) {
    // SIGTERM triggers the in-daemon `shutdown()` handler (covers server
    // close + pid/socket/addr cleanup branches). SIGKILL would bypass them.
    const exited = new Promise((resolve) => daemon.once('exit', resolve));
    try { daemon.kill('SIGTERM'); } catch {}
    // Wait for the process to actually exit — up to 5s so V8 has time to
    // flush coverage to NODE_V8_COVERAGE.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('GET /status returns uptime + activeSessions + idleSince', async () => {
  const { status, body } = await ipc('GET', '/status');
  assert.strictEqual(status, 200);
  assert.strictEqual(typeof body, 'object');
  assert.strictEqual(typeof body.uptime, 'number');
  assert.ok(body.uptime >= 0);
  assert.strictEqual(body.activeSessions, 0);
  assert.strictEqual(typeof body.idleSince, 'number');
});

test('GET /platform-skills returns an array (empty on fresh KLURA_HOME)', async () => {
  const { status, body } = await ipc('GET', '/platform-skills');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.platforms), `expected platforms array, got ${typeof body}`);
  assert.strictEqual(body.platforms.length, 0);
});

test('GET /history returns an empty array for an unknown platform', async () => {
  const { status, body } = await ipc('GET', '/history?platform=nope');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body));
  assert.strictEqual(body.length, 0);
});

test('unknown endpoint returns 404 with an error body', async () => {
  const { status, body } = await ipc('GET', '/definitely/not/real');
  assert.strictEqual(status, 404);
  assert.strictEqual(typeof body, 'object');
  assert.match(body.error, /Unknown endpoint/);
});

test('POST /session/start with missing pool driver returns 500 with error body', async () => {
  // Without chromium installed via playwright, pool.createSession throws.
  // Even if chromium is installed, the URL is invalid → navigation throws.
  // Either way the daemon wraps the error in a 500.
  const { status, body } = await ipc('POST', '/session/start', { url: 'not-a-real-url' });
  assert.strictEqual(status, 500);
  assert.strictEqual(typeof body, 'object');
  assert.strictEqual(typeof body.error, 'string');
});

test('POST /strategy/mark-healed returns {ok:true} and persists health', async () => {
  const { status, body } = await ipc('POST', '/strategy/mark-healed', {
    platform: 'ipc-test',
    capability: 'search',
    strategyType: 'fetch',
  });
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { ok: true });

  // Verify persistence — per-platform health.json was written with the expected key.
  const healthPath = path.join(TMP, 'workdir', 'ipc-test', 'health.json');
  assert.ok(fs.existsSync(healthPath), 'per-platform health.json should exist after mark-healed');
  const data = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
  const entry = data['search/fetch'];
  assert.ok(entry, 'expected health entry for search/fetch');
  assert.strictEqual(entry.status, 'healthy');
  assert.strictEqual(entry.healCount, 1);
});

test('GET /history returns strategy events after a mark-healed writes one', async () => {
  // mark-healed appends a strategy_events entry to the platform logbook.
  // Read it back through /history (which now surfaces strategy events).
  const { status, body } = await ipc('GET', '/history?platform=ipc-test');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 1, 'should have at least one strategy event');
  const healed = body.find(e => e.kind === 'healed');
  assert.ok(healed, 'expected a healed event');
  assert.strictEqual(healed.capability, 'search');
  assert.strictEqual(healed.strategy, 'fetch');
});

test('GET /listener/events returns an empty paginated event list initially', async () => {
  const { status, body } = await ipc('GET', '/listener/events');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.events));
  assert.strictEqual(body.events.length, 0);
  assert.strictEqual(body.total, 0);
});

test('daemon writes its own PID file to KLURA_HOME/daemon.pid', () => {
  const pidPath = path.join(TMP, 'daemon.pid');
  assert.ok(fs.existsSync(pidPath));
  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
  assert.ok(pid > 0);
  // Verify the process is actually running
  assert.doesNotThrow(() => process.kill(pid, 0));
});

// ---- endpoint dispatch coverage ----
// The point of these is to exercise every dispatch branch in handleRequest
// so coverage reflects the wire contract, not to validate the downstream
// business logic (which has its own tests).

test('POST /session/action dispatches (500 when session doesn\'t exist)', async () => {
  const { status, body } = await ipc('POST', '/session/action', {
    sessionId: 'nope',
    action: 'click',
    selector: 'x',
  });
  assert.strictEqual(status, 500);
  assert.match(body.error, /not found|Session/i);
});

test('GET /session/network dispatches', async () => {
  const { status, body } = await ipc('GET', '/session/network?sessionId=nope');
  assert.strictEqual(status, 500);
  assert.match(body.error, /not found|Session/i);
});

test('GET /session/screenshot dispatches', async () => {
  const { status, body } = await ipc('GET', '/session/screenshot?sessionId=nope');
  assert.strictEqual(status, 500);
  assert.match(body.error, /not found|Session/i);
});

test('POST /session/close dispatches (500 for unknown session)', async () => {
  const { status, body } = await ipc('POST', '/session/close', { sessionId: 'nope' });
  assert.strictEqual(status, 500);
  assert.match(body.error, /not found|Session/i);
});

test('POST /remote/start dispatches', async () => {
  const { status, body } = await ipc('POST', '/remote/start', { sessionId: 'nope', prompt: 'x' });
  assert.strictEqual(status, 500);
  assert.match(body.error, /not found|Session/i);
});

test('POST /remote/stop dispatches', async () => {
  // stopRemote on an unknown session is a no-op (idempotent).
  const { status } = await ipc('POST', '/remote/stop', { sessionId: 'nope' });
  assert.strictEqual(status, 200);
});

test('POST /listener/start dispatches (500 when strategy missing)', async () => {
  const { status, body } = await ipc('POST', '/listener/start', {
    platform: 'ghost-platform',
    capability: 'ghost_cap',
  });
  assert.strictEqual(status, 500);
  assert.match(body.error, /No strategy found/);
});

test('POST /listener/stop dispatches (500 for unknown id)', async () => {
  const { status, body } = await ipc('POST', '/listener/stop', { listenerId: 'never-existed' });
  assert.strictEqual(status, 500);
  assert.match(body.error, /not found/i);
});

test('GET /listener/events with ?since parses the query param', async () => {
  const { status, body } = await ipc('GET', '/listener/events?since=123');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.events));
});

test('POST /strategy/save rejects unknown tier with invalid_strategy error', async () => {
  // saveStrategy validates the tier enum at save time (see validateStrategyShape
  // in skills.ts). An unknown tier must be rejected with a clear error so the
  // LLM can self-correct in the same turn, instead of being silently written
  // into the fallback 'api' subdir.
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-bogus',
    capability: 'search',
    data: { strategy: 'totally-bogus-tier', steps: [] },
  });
  assert.strictEqual(status, 500);
  // Unrecognized tier returns the three-tier re-priming tutorial naming
  // all three current tiers with their roles.
  assert.match(body.error, /invalid_strategy.*not one of klura's tiers/);
  assert.match(body.error, /fetch.*page-script.*recorded-path/s);
});

test('POST /strategy/save rejects fetch without baseUrl', async () => {
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-shape',
    capability: 'search',
    data: { strategy: 'fetch', endpoint: '/api/search' },
  });
  assert.strictEqual(status, 500);
  assert.match(body.error, /invalid_strategy.*baseUrl is required/s);
});

test('POST /strategy/save accepts fetch without prerequisites (prereqs are optional)', async () => {
  const { status } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-shape',
    capability: 'search',
    data: {
      strategy: 'fetch',
      baseUrl: 'http://example.com',
      endpoint: '/api/search',
    },
  });
  assert.strictEqual(status, 200);
});

test('POST /strategy/save rejects recorded-path with non-object step', async () => {
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-shape',
    capability: 'search',
    data: { strategy: 'recorded-path', steps: ['click'] },
  });
  assert.strictEqual(status, 500);
  assert.match(body.error, /invalid_strategy.*steps.*0.*must be an object/s);
});

test('POST /strategy/save rejects recorded-path step missing action', async () => {
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-shape',
    capability: 'search',
    data: { strategy: 'recorded-path', steps: [{ selector: '#foo' }] },
  });
  assert.strictEqual(status, 500);
  assert.match(body.error, /invalid_strategy.*steps.*0.*action.*required/s);
});

test('POST /strategy/save succeeds for a valid recorded-path skeleton', async () => {
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test',
    capability: 'search',
    data: {
      strategy: 'recorded-path',
      steps: [{ id: 'navigate_home', action: 'navigate', url: 'https://example.com' }],
    },
    changelog: 'initial save',
  });
  assert.strictEqual(status, 200);
  assert.ok(typeof body === 'string' || (body && typeof body === 'object'));
});

// --- Optional-field shape validation ---
//
// The required-field check catches missing baseUrl/endpoint/prerequisites/
// steps. These tests cover the NEW optional shape check: if a caller passes
// an optional field with the wrong container type (body as string, headers
// with non-string values, notes as null, etc.), reject at save time with a
// clear error instead of crashing inside an executor three calls later.

test('POST /strategy/save rejects fetch with body as string', async () => {
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-shape',
    capability: 'search',
    data: {
      strategy: 'fetch',
      baseUrl: 'http://example.com',
      endpoint: '/api/search',
      body: 'literal string',
    },
  });
  assert.strictEqual(status, 500);
  assert.match(body.error, /invalid_strategy.*body must be an object/s);
});

test('POST /strategy/save rejects fetch with headers containing non-string values', async () => {
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-shape',
    capability: 'search',
    data: {
      strategy: 'fetch',
      baseUrl: 'http://example.com',
      endpoint: '/api/search',
      headers: { 'X-Count': 42 },
    },
  });
  assert.strictEqual(status, 500);
  assert.match(body.error, /invalid_strategy.*headers.*X-Count.*must be a string/s);
});

test('POST /strategy/save rejects fetch with notes as a string', async () => {
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-shape',
    capability: 'search',
    data: {
      strategy: 'fetch',
      baseUrl: 'http://example.com',
      endpoint: '/api/search',
      notes: 'free-form prose',
    },
  });
  assert.strictEqual(status, 500);
  assert.match(body.error, /invalid_strategy.*notes must be an object/s);
});

test('POST /strategy/save rejects fetch with invalid contentType', async () => {
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-shape',
    capability: 'search',
    data: {
      strategy: 'fetch',
      baseUrl: 'http://example.com',
      endpoint: '/api/search',
      contentType: 'xml',
    },
  });
  assert.strictEqual(status, 500);
  assert.match(body.error, /invalid_strategy.*contentType.*json.*form/s);
});

test('POST /strategy/save rejects fetch with params as array', async () => {
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-shape',
    capability: 'search',
    data: {
      strategy: 'fetch',
      baseUrl: 'http://example.com',
      endpoint: '/api/search',
      params: ['to', 'text'],
    },
  });
  assert.strictEqual(status, 500);
  assert.match(body.error, /invalid_strategy.*params must be an object/s);
});

test('POST /strategy/save rejects fetch with empty method', async () => {
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-shape',
    capability: 'search',
    data: {
      strategy: 'fetch',
      baseUrl: 'http://example.com',
      endpoint: '/api/search',
      method: '',
    },
  });
  assert.strictEqual(status, 500);
  assert.match(body.error, /invalid_strategy.*method must be a non-empty string/s);
});

test('POST /strategy/save accepts fetch with absent optionals', async () => {
  // Optional fields are exactly that — absent is fine. Must not regress.
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-optionals',
    capability: 'ping',
    data: {
      strategy: 'fetch',
      baseUrl: 'http://example.com',
      endpoint: '/api/ping',
    },
  });
  assert.strictEqual(status, 200);
  assert.ok(body);
});

test('POST /strategy/save accepts fetch with null optional (treated as absent)', async () => {
  // JSON null is interchangeable with absent — the wire format can legitimately
  // produce either from upstream serializers. Validator must not reject null.
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-optionals',
    capability: 'ping_null',
    data: {
      strategy: 'fetch',
      baseUrl: 'http://example.com',
      endpoint: '/api/ping',
      body: null,
      headers: null,
    },
  });
  assert.strictEqual(status, 200);
  assert.ok(body);
});

test('POST /strategy/save accepts fetch with full valid optional bundle', async () => {
  // Happy path: all optionals present with the right shapes. Proves the
  // validator isn't accidentally rejecting legitimate strategies.
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-optionals',
    capability: 'full',
    data: {
      strategy: 'fetch',
      baseUrl: 'http://example.com',
      endpoint: '/api/conversations/{{to}}/messages',
      method: 'POST',
      contentType: 'json',
      headers: { 'Content-Type': 'application/json' },
      body: { text: '{{text}}' },
      params: { to: '{{to}}' },
      notes: {
        params: {
          to: { description: 'recipient id', kind: 'id', example: 'bob' },
          text: 'message body',
        },
      },
    },
  });
  assert.strictEqual(status, 200);
  assert.ok(body);
});

test('POST /strategy/save accepts recorded-path with notes as object', async () => {
  // recorded-path only checks notes + generated as optionals (no headers/body/
  // params — those aren't meaningful for a click-and-type path).
  const { status, body } = await ipc('POST', '/strategy/save', {
    platform: 'save-test-optionals',
    capability: 'login',
    data: {
      strategy: 'recorded-path',
      steps: [{ id: 'navigate_login', action: 'navigate', url: 'http://example.com/login' }],
      notes: { params: {} },
    },
  });
  assert.strictEqual(status, 200);
  assert.ok(body);
});

test('POST /execute dispatches (500 when no strategy exists)', async () => {
  const { status, body } = await ipc('POST', '/execute', {
    platform: 'execute-test',
    capability: 'nope',
  });
  assert.strictEqual(status, 500);
  assert.match(body.error, /No strategy found/);
});

test('POST /strategy/patch-step dispatches', async () => {
  // patchStep returns {error} as a 200 payload when the file is missing,
  // not a thrown error, so this asserts the dispatch wires up correctly.
  const { status, body } = await ipc('POST', '/strategy/patch-step', {
    platform: 'patch-test',
    capability: 'nope',
    strategyType: 'recorded-path',
    stepId: 'click_send',
    patch: {},
  });
  assert.strictEqual(status, 200);
  assert.match(body.error, /not found/);
});

test('POST /execute/resume dispatches (500 for unknown session)', async () => {
  const { status, body } = await ipc('POST', '/execute/resume', { sessionId: 'nope' });
  assert.strictEqual(status, 500);
  assert.ok(body.error);
});

test('GET /history with ?capability and ?limit parses the query params', async () => {
  // First populate some history via mark-healed on a known platform.
  await ipc('POST', '/strategy/mark-healed', {
    platform: 'qs-test',
    capability: 'search',
    strategyType: 'fetch',
  });
  await ipc('POST', '/strategy/mark-healed', {
    platform: 'qs-test',
    capability: 'other',
    strategyType: 'fetch',
  });

  // Filter by capability
  const scoped = await ipc('GET', '/history?platform=qs-test&capability=search&limit=1');
  assert.strictEqual(scoped.status, 200);
  assert.ok(Array.isArray(scoped.body));
  assert.strictEqual(scoped.body.length, 1);
  assert.strictEqual(scoped.body[0].capability, 'search');

  // Without capability filter, both should be visible.
  const all = await ipc('GET', '/history?platform=qs-test');
  assert.strictEqual(all.status, 200);
  assert.ok(all.body.length >= 2);
});

test('malformed JSON body returns 500', async () => {
  // Post raw non-JSON bytes so JSON.parse inside the handler throws.
  const raw = 'this is not json {{}';
  const { status, body } = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        path: '/strategy/mark-healed',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c.toString()));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      },
    );
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
  assert.strictEqual(status, 500);
  assert.ok(body.error);
});

// ---- pure helpers (unit, in-process coverage) ----

test('parseListen: bare port (":9400") → 0.0.0.0:9400', () => {
  assert.deepStrictEqual(parseListen(':9400'), { host: '0.0.0.0', port: 9400 });
});

test('parseListen: "localhost:9400" → localhost:9400', () => {
  assert.deepStrictEqual(parseListen('localhost:9400'), { host: 'localhost', port: 9400 });
});

test('parseListen: "0.0.0.0:9400" → 0.0.0.0:9400', () => {
  assert.deepStrictEqual(parseListen('0.0.0.0:9400'), { host: '0.0.0.0', port: 9400 });
});

test('parseListen: bare number (no colon) → 0.0.0.0:N', () => {
  assert.deepStrictEqual(parseListen('1234'), { host: '0.0.0.0', port: 1234 });
});

test('loadConfig: reads config.json from KLURA_HOME', () => {
  // daemon-ipc test already wrote a config.json to TMP at setup. loadConfig
  // should pick it up and merge with defaults.
  const config = loadConfig();
  assert.strictEqual(config.runtime.listen, 'unix');
  assert.strictEqual(config.runtime.idleTimeout, 30);
  assert.strictEqual(config.pool.maxSessions, 1);
});

test('loadConfig: returns defaults when config.json is corrupt', () => {
  // Back up, write garbage, read, restore.
  const cfgPath = path.join(TMP, 'config.json');
  const backup = fs.readFileSync(cfgPath);
  fs.writeFileSync(cfgPath, 'not-json{');
  try {
    const config = loadConfig();
    assert.strictEqual(config.runtime.listen, 'unix');
    assert.strictEqual(config.pool.maxSessions, 8);
  } finally {
    fs.writeFileSync(cfgPath, backup);
  }
});

// ---- CLI-side helpers ----

test('isDaemonRunning: true while the forked daemon is alive', () => {
  assert.strictEqual(isDaemonRunning(), true);
});

test('sendToDaemon: round-trip /status via the helper', async () => {
  const result = await sendToDaemon('GET', '/status');
  assert.strictEqual(typeof result, 'object');
  assert.strictEqual(typeof result.uptime, 'number');
  assert.ok(Number.isInteger(result.activeSessions));
});

test('sendToDaemon: POST with body', async () => {
  const result = await sendToDaemon('POST', '/strategy/mark-healed', {
    platform: 'send-to-daemon-test',
    capability: 'cap',
    strategyType: 'fetch',
  });
  assert.deepStrictEqual(result, { ok: true });
});

test('sendToDaemon: unknown endpoint returns {error} from the 404 body', async () => {
  const result = await sendToDaemon('GET', '/definitely/not/a/route');
  assert.strictEqual(typeof result, 'object');
  assert.match(result.error, /Unknown endpoint/);
});

test('sendToDaemon: honors KLURA_DAEMON_ADDR for TCP mode (fails gracefully on dead port)', async () => {
  // Force the TCP branch in sendToDaemon by setting the env override.
  // Port 1 is reserved → connect fails, req.on('error') → reject.
  const prev = process.env.KLURA_DAEMON_ADDR;
  process.env.KLURA_DAEMON_ADDR = '127.0.0.1:1';
  try {
    await assert.rejects(sendToDaemon('GET', '/status'));
  } finally {
    if (prev === undefined) delete process.env.KLURA_DAEMON_ADDR;
    else process.env.KLURA_DAEMON_ADDR = prev;
  }
});

test('sendToDaemon: TCP mode round-trips against a mock server; handles non-JSON response', async () => {
  // Spin up a trivial HTTP server that returns plain text. sendToDaemon
  // falls back to resolving the raw body when JSON.parse throws.
  const mock = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not-json-at-all');
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;

  const prev = process.env.KLURA_DAEMON_ADDR;
  process.env.KLURA_DAEMON_ADDR = `127.0.0.1:${mockPort}`;
  try {
    const result = await sendToDaemon('GET', '/anything');
    assert.strictEqual(result, 'not-json-at-all');
  } finally {
    if (prev === undefined) delete process.env.KLURA_DAEMON_ADDR;
    else process.env.KLURA_DAEMON_ADDR = prev;
    await new Promise((resolve) => mock.close(resolve));
  }
});

test('ensureDaemon: no-op when a daemon is already running', () => {
  // The forked daemon from test.before is alive; ensureDaemon should return
  // immediately without spawning a second one.
  const before = fs.readFileSync(path.join(TMP, 'daemon.pid'), 'utf-8').trim();
  ensureDaemon();
  const after = fs.readFileSync(path.join(TMP, 'daemon.pid'), 'utf-8').trim();
  assert.strictEqual(before, after, 'PID should be unchanged');
});

test('isDaemonRunning: stale PID file → removes it and returns false', () => {
  // Create a separate KLURA_HOME to not clobber the live daemon's pid file.
  // isDaemonRunning reads PID_FILE from the module constant (frozen at
  // import time), so we need to temporarily swap the contents of the file
  // our TMP KLURA_HOME daemon owns.
  //
  // Instead: directly test via the live daemon's PID path. We back up the
  // real pid, write a bogus pid (some very large number unlikely to exist),
  // verify isDaemonRunning returns false AND cleans up, then restore.
  const pidPath = path.join(TMP, 'daemon.pid');
  const realPid = fs.readFileSync(pidPath, 'utf-8').trim();
  try {
    fs.writeFileSync(pidPath, '9999999'); // almost certainly dead
    assert.strictEqual(isDaemonRunning(), false, 'stale pid → false');
    assert.strictEqual(fs.existsSync(pidPath), false, 'stale pid file should be removed');
  } finally {
    // Restore the real pid file so other tests and test.after can find it.
    fs.writeFileSync(pidPath, realPid);
  }
});

test('POST /shutdown returns {ok:true} and exits the daemon', async () => {
  // Spawn a second, short-lived daemon just for this test so the primary
  // daemon (needed by subsequent tests) stays alive.
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-shutdown-test-'));
  fs.writeFileSync(
    path.join(TMP2, 'config.json'),
    JSON.stringify({
      runtime: { idleTimeout: 30, listen: 'unix' },
      pool: { maxSessions: 1, idleTimeout: 30 },
    }),
  );
  const SOCKET2 = path.join(TMP2, 'klura.sock');
  const d2 = cp.fork(DAEMON_SCRIPT, [], {
    env: { ...process.env, KLURA_HOME: TMP2 },
    stdio: 'ignore',
  });
  // Wait for socket
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !fs.existsSync(SOCKET2)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // Hit /shutdown via raw http
  const { status, body } = await new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET2, path: '/shutdown', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { ok: true });
  // Clean up
  try { d2.kill('SIGKILL'); } catch {}
  try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch {}
});

test('primary daemon still alive after /shutdown on a second daemon', () => {
  assert.strictEqual(isDaemonRunning(), true);
});
