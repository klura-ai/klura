import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  LocalPackageInstallError,
  LocalPackageInstallerV1,
  PackageStoreV1,
  PublicContractError,
  parseInstalledState,
  sha256Digest,
} from '../consumer.js';

const require = createRequire(import.meta.url);
const { compilePublicPackageSource } = require('../factory-compiler.js');

const LOCAL_PACKAGE_ID = 'local-acme-store';
const RUNTIME_VERSION = '0.6.3';

function localPackageSource(packageId) {
  return {
    package_schema_version: 1,
    package_id: packageId,
    version: '1.0.0',
    authentication_contracts: {},
    capabilities: {
      get_product: {
        description: 'Get one product.',
        visibility: 'public',
        effect: 'read',
        authentication: { mode: 'none' },
        request_origins: ['https://api.example.test'],
        navigation_origins: [],
        origin_traffic_policies: [
          {
            origin: 'https://api.example.test',
            max_concurrency: 1,
            requests_per_second: 1,
            burst: 1,
            min_delay_ms: 0,
            max_redirect_hops: 2,
            circuit_breaker: {
              transient_failure_threshold: 2,
              transient_window_ms: 30_000,
              cooldown_ms: 60_000,
            },
          },
        ],
        browser_resources: null,
        max_target_requests_per_call: 1,
        max_encoded_outcome_bytes: 16_384,
        call_timeouts: { per_request_timeout_ms: 5_000, total_timeout_ms: 5_000 },
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 } },
          required: ['id'],
          additionalProperties: false,
        },
        call_retry_policy: {
          max_retries: 0,
          on: [],
          base_delay_ms: 100,
          max_delay_ms: 100,
          jitter_ratio: 0,
          honor_structural_retry_after: false,
        },
        strategies: [
          {
            kind: 'http_request',
            context: 'node',
            request: {
              strategy_id: 'request',
              method: 'GET',
              base_url: 'https://api.example.test',
              endpoint: { op: 'literal', value: '/products' },
              headers: { accept: { op: 'literal', value: 'application/json' } },
              query: { id: { op: 'input', pointer: '/id' } },
              body: null,
              response_body_limit_bytes: 65_536,
            },
            projection: { kind: 'json' },
            prerequisites: [],
            replay: 'safe_read',
          },
        ],
        outcomes: [
          {
            outcome_id: 'success',
            class: 'success',
            output_schema: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
            cases: [
              {
                case_id: 'success_case',
                strategy_ids: ['request'],
                matcher: { op: 'all', items: [{ op: 'status_in', values: [200] }] },
                projection: { kind: 'json_pointer', pointer: '/item' },
                assertions: [],
                retry_after: null,
              },
            ],
          },
        ],
        control: null,
        collection: null,
      },
    },
  };
}

function compileLocalPackage(packageId = LOCAL_PACKAGE_ID) {
  return compilePublicPackageSource({
    package_source_schema_version: 1,
    package: localPackageSource(packageId),
  });
}

function installedRecord(home) {
  const state = JSON.parse(readFileSync(path.join(home, 'installed.json'), 'utf8'));
  return { state, record: state.packages[LOCAL_PACKAGE_ID] };
}

test('a locally authored package installs into the immutable store with local provenance', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-local-install-'));
  try {
    const store = new PackageStoreV1(home);
    const installer = new LocalPackageInstallerV1(store, RUNTIME_VERSION);
    const compiled = compileLocalPackage();
    const sourceDigest = sha256Digest('acme-store-review');
    const installed = installer.install(
      { package_id: LOCAL_PACKAGE_ID, bytes: compiled.bytes, source_digest: sourceDigest },
      new Date('2026-07-27T12:00:00Z'),
    );

    assert.equal(installed.action, 'installed');
    assert.equal(installed.previous_active, null);
    assert.equal(installed.artifact.package_id, LOCAL_PACKAGE_ID);
    assert.equal(installed.artifact.version, '1.0.0');
    assert.equal(installed.artifact.package_digest, sha256Digest(compiled.bytes));
    assert.equal(installed.artifact.manifest_digest, compiled.manifest_digest);
    assert.equal(installed.artifact.installed_at, '2026-07-27T12:00:00Z');
    assert.deepEqual(installed.artifact.provenance, {
      kind: 'local',
      source_digest: sourceDigest,
    });
    assert.deepEqual(installed.artifact.runtime_range, {
      minimum_inclusive: RUNTIME_VERSION,
      maximum_exclusive: '0.7.0',
    });
    assert.equal(
      store.readArtifact(installed.artifact.package_digest).toString('utf8'),
      compiled.bytes.toString('utf8'),
    );

    const { state, record } = installedRecord(home);
    assert.equal(state.installed_schema_version, 2);
    assert.equal(Object.hasOwn(record, 'source_index_digest'), false);
    assert.deepEqual(record.provenance, { kind: 'local', source_digest: sourceDigest });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('reinstalling the same authored source is a no-op and a new source reactivates', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-local-install-'));
  try {
    const store = new PackageStoreV1(home);
    const installer = new LocalPackageInstallerV1(store, RUNTIME_VERSION);
    const compiled = compileLocalPackage();
    const first = installer.install({
      package_id: LOCAL_PACKAGE_ID,
      bytes: compiled.bytes,
      source_digest: sha256Digest('review-one'),
    });
    const repeated = installer.install({
      package_id: LOCAL_PACKAGE_ID,
      bytes: compiled.bytes,
      source_digest: sha256Digest('review-one'),
    });
    assert.equal(repeated.action, 'already_active');
    assert.deepEqual(repeated.artifact, first.artifact);

    const reauthored = installer.install({
      package_id: LOCAL_PACKAGE_ID,
      bytes: compiled.bytes,
      source_digest: sha256Digest('review-two'),
    });
    assert.equal(reauthored.action, 'activated');
    assert.deepEqual(reauthored.previous_active.provenance, {
      kind: 'local',
      source_digest: sha256Digest('review-one'),
    });
    assert.deepEqual(store.getInstalled(LOCAL_PACKAGE_ID).provenance, {
      kind: 'local',
      source_digest: sha256Digest('review-two'),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('local installation rejects a registry id, foreign bytes and an unparsable package', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-local-install-'));
  try {
    const store = new PackageStoreV1(home);
    const installer = new LocalPackageInstallerV1(store, RUNTIME_VERSION);
    const compiled = compileLocalPackage();
    const sourceDigest = sha256Digest('acme-store-review');

    assert.throws(
      () =>
        installer.install({
          package_id: 'acme-store',
          bytes: compiled.bytes,
          source_digest: sourceDigest,
        }),
      (error) => error instanceof LocalPackageInstallError && error.code === 'package_id_not_local',
    );
    assert.throws(
      () =>
        installer.install({
          package_id: LOCAL_PACKAGE_ID,
          bytes: compileLocalPackage('local-other-store').bytes,
          source_digest: sourceDigest,
        }),
      (error) =>
        error instanceof LocalPackageInstallError &&
        error.code === 'package_invalid' &&
        /different package id/.test(error.message),
    );
    assert.throws(
      () =>
        installer.install({
          package_id: LOCAL_PACKAGE_ID,
          bytes: Buffer.from('{"package_schema_version":1}', 'utf8'),
          source_digest: sourceDigest,
        }),
      (error) => error instanceof LocalPackageInstallError && error.code === 'package_invalid',
    );
    assert.throws(
      () =>
        installer.install({
          package_id: LOCAL_PACKAGE_ID,
          bytes: compiled.bytes,
          source_digest: 'not-a-digest',
        }),
      (error) => error instanceof LocalPackageInstallError && error.code === 'package_invalid',
    );
    assert.equal(store.getInstalled(LOCAL_PACKAGE_ID), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installed state lifts schema 1 into registry provenance and keeps both branches closed', () => {
  const registryRecord = {
    package_id: 'acme-store',
    version: '1.0.0',
    package_digest: 'a'.repeat(64),
    manifest_digest: 'b'.repeat(64),
    runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
    installed_at: '2026-07-27T12:00:00Z',
  };
  const lifted = parseInstalledState({
    installed_schema_version: 1,
    packages: {
      'acme-store': { ...registryRecord, source_index_digest: 'c'.repeat(64) },
    },
  });
  assert.equal(lifted.installed_schema_version, 2);
  assert.deepEqual(lifted.packages['acme-store'].provenance, {
    kind: 'registry',
    source_index_digest: 'c'.repeat(64),
  });

  const local = parseInstalledState({
    installed_schema_version: 2,
    packages: {
      [LOCAL_PACKAGE_ID]: {
        ...registryRecord,
        package_id: LOCAL_PACKAGE_ID,
        provenance: { kind: 'local', source_digest: 'd'.repeat(64) },
      },
    },
  });
  assert.deepEqual(local.packages[LOCAL_PACKAGE_ID].provenance, {
    kind: 'local',
    source_digest: 'd'.repeat(64),
  });

  assert.throws(
    () =>
      parseInstalledState({
        installed_schema_version: 2,
        packages: {
          'acme-store': { ...registryRecord, source_index_digest: 'c'.repeat(64) },
        },
      }),
    (error) => error instanceof PublicContractError && /source_index_digest/.test(error.message),
  );
  assert.throws(
    () =>
      parseInstalledState({
        installed_schema_version: 2,
        packages: {
          [LOCAL_PACKAGE_ID]: {
            ...registryRecord,
            package_id: LOCAL_PACKAGE_ID,
            provenance: {
              kind: 'local',
              source_digest: 'd'.repeat(64),
              source_index_digest: 'c'.repeat(64),
            },
          },
        },
      }),
    (error) => error instanceof PublicContractError && /source_index_digest/.test(error.message),
  );
  assert.throws(
    () =>
      parseInstalledState({
        installed_schema_version: 3,
        packages: {},
      }),
    (error) => error instanceof PublicContractError && /must be 1 or 2/.test(error.message),
  );
});

test('the derived compatibility window always admits the runtime that compiled the package', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-local-install-'));
  try {
    const compiled = compileLocalPackage();
    const source_digest = sha256Digest('acme-store-review');
    const majorRuntime = new LocalPackageInstallerV1(new PackageStoreV1(home), '2.4.5').install({
      package_id: LOCAL_PACKAGE_ID,
      bytes: compiled.bytes,
      source_digest,
    });
    assert.deepEqual(majorRuntime.artifact.runtime_range, {
      minimum_inclusive: '2.4.5',
      maximum_exclusive: '3.0.0',
    });

    const prereleaseHome = mkdtempSync(path.join(os.tmpdir(), 'klura-local-install-'));
    try {
      const prerelease = new LocalPackageInstallerV1(
        new PackageStoreV1(prereleaseHome),
        '0.6.3-rc.1',
      ).install({ package_id: LOCAL_PACKAGE_ID, bytes: compiled.bytes, source_digest });
      assert.deepEqual(prerelease.artifact.runtime_range, {
        minimum_inclusive: '0.6.3-rc.1',
        maximum_exclusive: '0.7.0',
      });
    } finally {
      rmSync(prereleaseHome, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
