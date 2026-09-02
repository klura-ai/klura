import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-diagnostic-evidence-'));
process.env.KLURA_HOME = temp;

const klura = await import('../dist/index.js');
const skills = await import('../dist/strategies/skills.js');
const { collectExecutionDiagnosticEvidence } =
  await import('../dist/execution/diagnostic-evidence.js');

test.after(async () => {
  try {
    await klura._pool.shutdown();
  } catch {
    /* best-effort */
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('public execute returns exact request and passive script evidence from its main browser session', async () => {
  skills.saveStrategy('diagnostic-example', 'read_items', {
    strategy: 'page-script',
    baseUrl: 'https://diagnostic.example.test/',
    endpoint: '/api/items',
    method: 'GET',
    headers: {},
  });

  const pool = klura._pool;
  const original = {
    tryCheckoutReadySession: pool.tryCheckoutReadySession,
    createSession: pool.createSession,
    driverFor: pool.driverFor,
    endDrive: pool.endDrive,
  };
  const session = { id: 'diagnostic-session' };
  const driver = {
    async getUrl() {
      return 'https://diagnostic.example.test/ready';
    },
    async fetchInBrowser(_session, url) {
      return {
        ok: true,
        status: 200,
        body: { ok: true, items: [] },
        finalUrl: url,
      };
    },
    async getInterceptedRequests() {
      return [
        {
          method: 'GET',
          url: 'https://diagnostic.example.test/api/items',
          headers: {},
        },
      ];
    },
    async getLoadedScripts() {
      return [{ url: 'https://passive-resource.example.test/tags.js' }];
    },
    async saveStorageState() {},
  };
  pool.tryCheckoutReadySession = async () => null;
  pool.createSession = async () => session;
  pool.driverFor = (id) => {
    assert.equal(id, session.id);
    return driver;
  };
  pool.endDrive = async (id) => {
    assert.equal(id, session.id);
  };

  try {
    const result = await klura.execute(
      'diagnostic-example',
      'read_items',
      {},
      {
        _suppressStrategyState: true,
        _collectDiagnosticEvidence: true,
      },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.diagnosticEvidence.urls,
      [
        { kind: 'request', url: 'https://diagnostic.example.test/api/items' },
        { kind: 'script', url: 'https://passive-resource.example.test/tags.js' },
      ],
    );
  } finally {
    pool.tryCheckoutReadySession = original.tryCheckoutReadySession;
    pool.createSession = original.createSession;
    pool.driverFor = original.driverFor;
    pool.endDrive = original.endDrive;
  }
});

test('best-effort browser evidence collection cannot replace a successful execute result', async () => {
  skills.saveStrategy('diagnostic-example', 'read_without_ledger', {
    strategy: 'page-script',
    baseUrl: 'https://diagnostic.example.test/',
    endpoint: '/api/no-ledger',
    method: 'GET',
    headers: {},
  });

  const pool = klura._pool;
  const original = {
    tryCheckoutReadySession: pool.tryCheckoutReadySession,
    createSession: pool.createSession,
    driverFor: pool.driverFor,
    endDrive: pool.endDrive,
  };
  const session = { id: 'diagnostic-session-no-ledger' };
  const driver = {
    async getUrl() {
      return 'https://diagnostic.example.test/ready';
    },
    async fetchInBrowser(_session, url) {
      return { ok: true, status: 200, body: { ok: true }, finalUrl: url };
    },
    getInterceptedRequests() {
      throw new Error('ledger unavailable');
    },
    getLoadedScripts() {
      throw new Error('scripts unavailable');
    },
    async saveStorageState() {},
  };
  pool.tryCheckoutReadySession = async () => null;
  pool.createSession = async () => session;
  pool.driverFor = () => driver;
  pool.endDrive = async () => {};

  try {
    const result = await klura.execute(
      'diagnostic-example',
      'read_without_ledger',
      {},
      {
        _suppressStrategyState: true,
        _collectDiagnosticEvidence: true,
      },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.diagnosticEvidence.urls, [
      { kind: 'request', url: 'https://diagnostic.example.test/api/no-ledger' },
    ]);
  } finally {
    pool.tryCheckoutReadySession = original.tryCheckoutReadySession;
    pool.createSession = original.createSession;
    pool.driverFor = original.driverFor;
    pool.endDrive = original.endDrive;
  }
});

test('diagnostic attachment preserves a non-extensible execution error', async () => {
  const original = Object.preventExtensions(new Error('original execution failure'));
  await assert.rejects(
    collectExecutionDiagnosticEvidence(async () => {
      throw original;
    }),
    (error) => error === original,
  );
});
