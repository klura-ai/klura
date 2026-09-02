import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const bin = path.join(here, '..', 'bin', 'klura.js');
const { createForegroundAbort } = require('../dist/consumer/foreground-abort.js');
const { runConsumerCli } = require('../dist/consumer/cli.js');

function invoke(home, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KLURA_HOME: home },
  });
}

function stopConsumerDaemon(home) {
  const pidPath = path.join(home, 'daemon.pid');
  if (!existsSync(pidPath)) return;
  try {
    process.kill(Number(readFileSync(pidPath, 'utf8').trim()), 'SIGTERM');
  } catch {
    // The process may have exited before test cleanup.
  }
}

async function invokeWithRegistryService(args, registryService) {
  const writes = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    return {
      exit: await runConsumerCli(args, { registry_service: registryService }),
      output: JSON.parse(writes.join('')),
    };
  } finally {
    process.stdout.write = write;
  }
}

test('consumer CLI handles local installed/remove/doctor commands without factory routing', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-consumer-cli-'));
  try {
    const installed = invoke(home, ['installed', '--json']);
    assert.equal(installed.status, 0);
    assert.deepEqual(JSON.parse(installed.stdout), {
      result_schema_version: 1,
      kind: 'installed_packages',
      items: [],
      next_cursor: null,
    });

    const remove = invoke(home, ['remove', 'ikea', '--json']);
    assert.equal(remove.status, 0);
    assert.deepEqual(JSON.parse(remove.stdout), {
      result_schema_version: 1,
      kind: 'remove_result',
      action: 'not_installed',
      package_id: 'ikea',
      removed_active: null,
    });

    const doctor = invoke(home, ['doctor', '--json']);
    assert.equal(doctor.status, 0);
    assert.deepEqual(JSON.parse(doctor.stdout), {
      result_schema_version: 1,
      kind: 'doctor',
      installed_packages: 0,
      local_state: 'ok',
      scheduler: { scheduler_snapshot_schema_version: 1, origins: [] },
    });
  } finally {
    stopConsumerDaemon(home);
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(home, { recursive: true, force: true });
  }
});

test('root help is consumer-first and factory help is explicit', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-consumer-cli-'));
  try {
    const rootHelp = invoke(home, ['--help']);
    assert.equal(rootHelp.status, 0);
    assert.match(rootHelp.stdout, /local web data tools/);
    assert.match(rootHelp.stdout, /search \[query\]/);
    assert.match(rootHelp.stdout, /login <package>/);
    assert.match(rootHelp.stdout, /--max-requests N/);
    assert.match(rootHelp.stdout, /runs discard <run-id> --yes/);
    assert.match(rootHelp.stdout, /klura factory --help/);
    assert.doesNotMatch(rootHelp.stdout, /start-session/);

    const factoryHelp = invoke(home, ['factory', '--help']);
    assert.equal(factoryHelp.status, 0);
    assert.match(factoryHelp.stdout, /web automation skill runtime/);
    assert.match(factoryHelp.stdout, /start-session/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('consumer CLI pages installed packages with a structural cursor', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-consumer-cli-'));
  try {
    writeFileSync(
      path.join(home, 'installed.json'),
      JSON.stringify({
        installed_schema_version: 1,
        packages: {
          acme: installedPackage('acme', '2026-07-27T10:00:00Z'),
          ikea: installedPackage('ikea', '2026-07-27T10:01:00Z'),
          zara: installedPackage('zara', '2026-07-27T10:02:00Z'),
        },
      }),
    );
    const first = invoke(home, ['installed', '--limit', '2', '--json']);
    assert.equal(first.status, 0);
    const firstPage = JSON.parse(first.stdout);
    assert.deepEqual(
      firstPage.items.map((item) => item.package_id),
      ['acme', 'ikea'],
    );
    assert.equal(typeof firstPage.next_cursor, 'string');

    const second = invoke(home, ['installed', '--cursor', firstPage.next_cursor, '--json']);
    assert.equal(second.status, 0);
    assert.deepEqual(
      JSON.parse(second.stdout).items.map((item) => item.package_id),
      ['zara'],
    );
    assert.equal(JSON.parse(second.stdout).next_cursor, null);

    const removed = invoke(home, ['remove', 'ikea', '--json']);
    assert.equal(removed.status, 0);
    const removedResult = JSON.parse(removed.stdout);
    assert.equal(removedResult.action, 'removed');
    assert.equal(removedResult.package_id, 'ikea');
    assert.equal(removedResult.removed_active.package_id, 'ikea');

    const invalid = invoke(home, ['installed', '--cursor', 'not-a-cursor!', '--json']);
    assert.equal(invalid.status, 3);
    assert.deepEqual(JSON.parse(invalid.stdout), {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'list_installed',
      code: 'cursor_invalid',
      retryable: false,
      package_id: null,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('consumer CLI rejects malformed call grammar before local state access', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-consumer-cli-'));
  try {
    const invalid = invoke(home, ['call', 'ikea.get_product', '--json']);
    assert.equal(invalid.status, 2);
    assert.deepEqual(JSON.parse(invalid.stdout), { kind: 'failure', code: 'invalid_input' });

    const invalidRun = invoke(home, ['run', 'ikea.get_product', '--json']);
    assert.equal(invalidRun.status, 2);
    assert.deepEqual(JSON.parse(invalidRun.stdout), { kind: 'failure', code: 'invalid_input' });

    const invalidOutput = invoke(home, [
      'run',
      'ikea.get_product',
      '--input',
      '{}',
      '--format',
      'ndjson',
      '--json',
    ]);
    assert.equal(invalidOutput.status, 2);
    assert.deepEqual(JSON.parse(invalidOutput.stdout), { kind: 'failure', code: 'invalid_input' });

    const invalidFollow = invoke(home, [
      'runs',
      'items',
      'run_v1_0123456789abcdef0123456789abcdef',
      '--follow',
      '--format',
      'json',
      '--json',
    ]);
    assert.equal(invalidFollow.status, 2);
    assert.deepEqual(JSON.parse(invalidFollow.stdout), { kind: 'failure', code: 'invalid_input' });

    const unknownFlag = invoke(home, ['installed', '--json', '--all']);
    assert.equal(unknownFlag.status, 2);
    assert.deepEqual(JSON.parse(unknownFlag.stdout), { kind: 'failure', code: 'invalid_input' });

    const missingDiscardConfirmation = invoke(home, [
      'runs',
      'discard',
      'run_v1_0123456789abcdef',
      '--json',
    ]);
    assert.equal(missingDiscardConfirmation.status, 2);
    assert.deepEqual(JSON.parse(missingDiscardConfirmation.stdout), {
      kind: 'failure',
      code: 'invalid_input',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('consumer CLI routes registry selectors through the runtime-owned registry service', async () => {
  const calls = [];
  const registryService = {
    async search(input) {
      calls.push({ operation: 'search', input });
      return { kind: 'search_result' };
    },
    async show(input) {
      calls.push({ operation: 'show', input });
      return { kind: 'show_result' };
    },
    async install(input) {
      calls.push({ operation: 'install', input });
      return { kind: 'install_result' };
    },
  };
  assert.deepEqual(
    await invokeWithRegistryService(
      ['search', 'office chair', '--cursor', 'cursor', '--limit', '5', '--json'],
      registryService,
    ),
    { exit: 0, output: { kind: 'search_result' } },
  );
  assert.deepEqual(
    await invokeWithRegistryService(
      ['show', 'ikea.get_product', '--version', '1.2.3', '--json'],
      registryService,
    ),
    { exit: 0, output: { kind: 'show_result' } },
  );
  assert.deepEqual(
    await invokeWithRegistryService(['install', 'ikea@1.2.3', '--json'], registryService),
    { exit: 0, output: { kind: 'install_result' } },
  );
  assert.deepEqual(calls, [
    {
      operation: 'search',
      input: { query: 'office chair', cursor: 'cursor', limit: 5 },
    },
    {
      operation: 'show',
      input: { package_id: 'ikea', capability: 'get_product', version: '1.2.3' },
    },
    { operation: 'install', input: { package_id: 'ikea', version: '1.2.3' } },
  ]);
});

test('consumer CLI renders typed registry unavailability without adapter rewriting', async () => {
  const registryService = {
    async search() {
      return {
        result_schema_version: 1,
        kind: 'consumer_failure',
        operation: 'search',
        code: 'registry_unavailable',
        retryable: true,
        package_id: null,
      };
    },
    async show() {
      return {
        result_schema_version: 1,
        kind: 'consumer_failure',
        operation: 'show',
        code: 'registry_unavailable',
        retryable: true,
        package_id: 'ikea',
      };
    },
    async install() {
      throw new Error('not reached');
    },
  };
  const search = await invokeWithRegistryService(['search', 'ikea', '--json'], registryService);
  assert.equal(search.exit, 3);
  assert.deepEqual(search.output, {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'search',
      code: 'registry_unavailable',
      retryable: true,
      package_id: null,
    });
  const show = await invokeWithRegistryService(['show', 'ikea.get_product', '--json'], registryService);
  assert.equal(show.exit, 3);
  assert.deepEqual(show.output, {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation: 'show',
    code: 'registry_unavailable',
    retryable: true,
    package_id: 'ikea',
  });
  const malformed = await invokeWithRegistryService(
    ['install', 'ikea@1.2.3@1.2.4', '--json'],
    registryService,
  );
  assert.equal(malformed.exit, 2);
  assert.deepEqual(malformed.output, { kind: 'failure', code: 'invalid_input' });
});

test('consumer CLI autostarts the shared daemon for an installed-package call', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-consumer-cli-'));
  try {
    const result = invoke(home, ['call', 'ikea.get_product', '--input', '{"id":"42"}', '--json']);
    assert.equal(result.status, 3);
    assert.deepEqual(JSON.parse(result.stdout), { kind: 'failure', code: 'package_not_installed' });
    const scrape = invoke(home, ['run', 'ikea.get_product', '--input', '{"id":"42"}', '--json']);
    assert.equal(scrape.status, 3);
    assert.deepEqual(JSON.parse(scrape.stdout), { kind: 'failure', code: 'package_not_installed' });
    const login = invoke(home, ['login', 'ikea', '--json']);
    assert.equal(login.status, 3);
    assert.deepEqual(JSON.parse(login.stdout), { kind: 'failure', code: 'package_not_installed' });
    const pidPath = path.join(home, 'daemon.pid');
    assert.equal(existsSync(pidPath), true);
    stopConsumerDaemon(home);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('consumer CLI routes every run inspection through the shared daemon', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-consumer-cli-'));
  const runId = 'run_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  try {
    for (const args of [
      ['runs', 'show', runId, '--json'],
      ['runs', 'items', runId, '--json'],
      ['runs', 'wait', runId, '--json'],
      ['runs', 'discard', runId, '--yes', '--json'],
    ]) {
      const result = invoke(home, args);
      assert.equal(result.status, 3);
      assert.deepEqual(JSON.parse(result.stdout), {
        result_schema_version: 1,
        kind: 'consumer_failure',
        operation:
          args[1] === 'show'
            ? 'get_run'
            : args[1] === 'items'
              ? 'list_run_items'
              : args[1] === 'wait'
                ? 'wait_run'
                : 'discard_run',
        code: 'run_not_found',
        retryable: false,
        package_id: null,
      });
      assert.equal(existsSync(path.join(home, 'daemon.pid')), true);
    }
  } finally {
    stopConsumerDaemon(home);
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(home, { recursive: true, force: true });
  }
});

test('foreground SIGINT becomes a cooperative cancellation and removes its listener', () => {
  const source = new EventEmitter();
  const foreground = createForegroundAbort(source);
  assert.equal(foreground.signal.aborted, false);
  source.emit('SIGINT');
  assert.equal(foreground.signal.aborted, true);
  foreground.dispose();
  assert.equal(source.listenerCount('SIGINT'), 0);
});

test('legacy CLI entry remains reachable through the lazy factory route', () => {
  const result = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${require('../package.json').version}\n`);
});

function installedPackage(packageId, installedAt) {
  return {
    package_id: packageId,
    version: '1.0.0',
    package_digest: 'a'.repeat(64),
    manifest_digest: 'b'.repeat(64),
    source_index_digest: 'c'.repeat(64),
    runtime_range: { minimum_inclusive: '1.0.0', maximum_exclusive: '2.0.0' },
    installed_at: installedAt,
  };
}
