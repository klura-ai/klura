import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  RuntimeBuildIntegrityError,
  assertLoadedRuntimeBuildCurrent,
  assertRuntimeBuildFresh,
  writeRuntimeBuildInfo,
} = require('../scripts/write-build-info.js');

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function writeFixtureFile(root, relative, content) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
  return destination;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-build-freshness-'));
  writeFixtureFile(root, 'package.json', '{"name":"fixture-runtime","version":"1.0.0"}\n');
  writeFixtureFile(root, 'tsconfig.json', '{}\n');
  writeFixtureFile(root, 'src/index.ts', 'export const value = 1;\n');
  writeFixtureFile(root, 'dist/index.js', '"use strict"; exports.value = 1;\n');
  writeFixtureFile(root, 'dist/index.d.ts', 'export declare const value = 1;\n');
  writeFixtureFile(root, 'mcp-server.js', "'use strict';\n");
  writeFixtureFile(root, 'scripts/write-build-info.js', "'use strict';\n");
  writeFixtureFile(root, 'SKILL.md', '# Fixture skill\n');
  writeFixtureFile(root, 'REFERENCE.md', '# Fixture reference\n');
  return root;
}

function checkoutFixture() {
  const root = fs.mkdtempSync(path.join(runtimeRoot, '.mcp-build-guard-'));
  const copyEntries = [
    'src',
    'dist',
    'scripts',
    'bin',
    'agent',
    'package.json',
    'tsconfig.json',
    'mcp-server.js',
    'consumer.js',
    'consumer.d.ts',
    'factory-compiler.js',
    'factory-compiler.d.ts',
    'SKILL.md',
    'REFERENCE.md',
  ];
  for (const relative of copyEntries) {
    const source = path.join(runtimeRoot, relative);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(root, relative), { recursive: true });
  }
  writeRuntimeBuildInfo(root);
  return root;
}

function assertBuildError(error, code) {
  return error instanceof RuntimeBuildIntegrityError && error.code === code;
}

test('build info is deterministic and a matching source/artifact pair passes', () => {
  const root = fixture();
  try {
    const first = writeRuntimeBuildInfo(root);
    const firstBytes = fs.readFileSync(path.join(root, 'dist', 'build-info.json'), 'utf8');
    const changedTimestamp = new Date('2040-01-01T00:00:00.000Z');
    fs.utimesSync(path.join(root, 'src', 'index.ts'), changedTimestamp, changedTimestamp);
    fs.utimesSync(path.join(root, 'dist', 'index.js'), changedTimestamp, changedTimestamp);
    const second = writeRuntimeBuildInfo(root);
    const secondBytes = fs.readFileSync(path.join(root, 'dist', 'build-info.json'), 'utf8');

    assert.deepEqual(second, first);
    assert.equal(secondBytes, firstBytes);
    assert.equal(Object.hasOwn(first, 'built_at_ms'), false);
    assert.match(first.source_digest, /^[a-f0-9]{64}$/);
    assert.match(first.artifact_digest, /^[a-f0-9]{64}$/);
    assert.equal(first.build_id, first.artifact_digest);
    assert.deepEqual(assertRuntimeBuildFresh(root), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source bytes changed without a rebuild are rejected', () => {
  const root = fixture();
  try {
    writeRuntimeBuildInfo(root);
    fs.appendFileSync(path.join(root, 'src', 'index.ts'), 'export const second = 2;\n');
    assert.throws(
      () => assertRuntimeBuildFresh(root),
      (error) => assertBuildError(error, 'runtime_build_stale'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compiled artifact bytes changed without a manifest rebuild are rejected', () => {
  const root = fixture();
  try {
    writeRuntimeBuildInfo(root);
    fs.appendFileSync(path.join(root, 'dist', 'index.js'), 'exports.second = 2;\n');
    assert.throws(
      () => assertRuntimeBuildFresh(root),
      (error) => assertBuildError(error, 'runtime_build_invalid'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a process refuses calls after a different build replaces its artifact', () => {
  const root = fixture();
  try {
    const loaded = writeRuntimeBuildInfo(root);
    fs.appendFileSync(path.join(root, 'src', 'index.ts'), 'export const second = 2;\n');
    fs.appendFileSync(path.join(root, 'dist', 'index.js'), 'exports.second = 2;\n');
    fs.appendFileSync(path.join(root, 'dist', 'index.d.ts'), 'export declare const second = 2;\n');
    const current = writeRuntimeBuildInfo(root);

    assert.notEqual(current.build_id, loaded.build_id);
    assert.throws(
      () => assertLoadedRuntimeBuildCurrent(loaded, root),
      (error) => assertBuildError(error, 'runtime_process_stale'),
    );
    assert.deepEqual(assertLoadedRuntimeBuildCurrent(current, root), current);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a process refuses calls after compiled artifact bytes drift in place', () => {
  const root = fixture();
  try {
    const loaded = writeRuntimeBuildInfo(root);
    fs.appendFileSync(path.join(root, 'dist', 'index.js'), '\n// artifact drift\n');
    assert.throws(
      () => assertLoadedRuntimeBuildCurrent(loaded, root),
      (error) => assertBuildError(error, 'runtime_build_invalid'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the current checkout build metadata matches source and compiled artifacts', () => {
  const info = assertRuntimeBuildFresh(runtimeRoot);
  assert.equal(info.runtime_version, require('../package.json').version);
});

async function assertProtocolDrift({ mutate, expectedCode }) {
  const root = checkoutFixture();
  const { createKluraMcpServer } = require(path.join(root, 'mcp-server.js'));
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const createServer = () =>
    createKluraMcpServer({
      consumerClient: {
        search: async () => ({ kind: 'packages', items: [], next_cursor: null }),
      },
    });

  const server = await createServer();
  const client = new Client({ name: 'klura-build-guard-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const initializeServer = await createServer();
  const initializeClient = new Client({
    name: 'klura-build-initialize-guard-test',
    version: '1.0.0',
  });
  const [initializeClientTransport, initializeServerTransport] =
    InMemoryTransport.createLinkedPair();
  await initializeServer.connect(initializeServerTransport);

  mutate(root);
  const expectedFailure = new RegExp(expectedCode);
  try {
    await assert.rejects(() => client.ping(), expectedFailure);
    await assert.rejects(() => client.listTools(), expectedFailure);
    await assert.rejects(() => client.listResources(), expectedFailure);
    await assert.rejects(() => client.readResource({ uri: 'klura://reference' }), expectedFailure);

    const call = await client.callTool({ name: 'search_packages', arguments: {} });
    assert.equal(call.isError, true);
    assert.equal(call.structuredContent.code, expectedCode);

    await assert.rejects(
      () => initializeClient.connect(initializeClientTransport),
      expectedFailure,
    );
  } finally {
    await initializeClient.close();
    await initializeServer.close();
    await client.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('every MCP protocol surface fails closed after source bytes drift', async () => {
  await assertProtocolDrift({
    expectedCode: 'runtime_build_stale',
    mutate: (root) => {
      fs.appendFileSync(path.join(root, 'src', 'index.ts'), '\nexport const drift = true;\n');
    },
  });
});

test('every MCP protocol surface fails closed after compiled artifact bytes drift', async () => {
  await assertProtocolDrift({
    expectedCode: 'runtime_build_invalid',
    mutate: (root) => {
      fs.appendFileSync(path.join(root, 'dist', 'index.js'), '\n// artifact drift\n');
    },
  });
});
