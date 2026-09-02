import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConsumerRegistryServiceV1,
  LOCAL_PACKAGE_ID_PREFIX_V1,
  PackageStoreV1,
  PublicContractError,
  calculatePublicToolPackageManifestDigest,
  isLocalPackageId,
  localPackageIdForPlatform,
  parseLocalPackageId,
  parsePackageId,
  parsePublicToolPackage,
  parseRegistryIndex,
  parseRegistryPackageId,
} from '../consumer.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RegistryClientV1 } = require('../dist/consumer/registry/client.js');

const LOCAL_PACKAGE_ID = 'local-acme-store';

function registryPackageValue(packageId) {
  const value = {
    package_schema_version: 1,
    package_id: packageId,
    version: '1.0.0',
    manifest_digest: '0'.repeat(64),
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
  value.manifest_digest = calculatePublicToolPackageManifestDigest(value);
  return value;
}

function indexPayloadWith(packageId) {
  return {
    registry_schema_version: 1,
    generated_at: '2026-07-27T10:00:00Z',
    expires_at: '2026-07-28T10:00:00Z',
    packages: {
      [packageId]: {
        package_id: packageId,
        display_name: 'Acme Store',
        description: 'Read public product data.',
        domains: ['acme.example.test'],
        tags: ['shopping'],
        stable_version: '1.0.0',
        versions: {
          '1.0.0': {
            version: '1.0.0',
            state: 'installable',
            package_url: 'https://registry.example.test/v1/packages/acme.json',
            package_bytes: 1_024,
            package_digest: 'a'.repeat(64),
            manifest_digest: 'b'.repeat(64),
            runtime_range: { minimum_inclusive: '0.6.0', maximum_exclusive: '1.0.0' },
            capabilities: {
              get_product: {
                description: 'Get one product.',
                run_supported: false,
                transports: ['http_node'],
              },
            },
          },
        },
      },
    },
  };
}

function unreachableRegistry(home) {
  const { publicKey } = generateKeyPairSync('ed25519');
  return new RegistryClientV1(
    home,
    { index_url: 'https://registry.example.test/v1/index.signed.json', public_key: publicKey },
    async () => {
      throw new Error('registry selector reached the network');
    },
  );
}

test('the reserved local namespace is carved out of the unchanged package id grammar', () => {
  assert.equal(LOCAL_PACKAGE_ID_PREFIX_V1, 'local-');
  assert.equal(parsePackageId(LOCAL_PACKAGE_ID, 'package_id'), LOCAL_PACKAGE_ID);
  assert.equal(isLocalPackageId(LOCAL_PACKAGE_ID), true);
  assert.equal(isLocalPackageId('acme-store'), false);

  assert.equal(parseLocalPackageId(LOCAL_PACKAGE_ID, 'package_id'), LOCAL_PACKAGE_ID);
  assert.throws(
    () => parseLocalPackageId('acme-store', 'package_id'),
    (error) =>
      error instanceof PublicContractError && /must start with "local-"/.test(error.message),
  );

  assert.equal(parseRegistryPackageId('acme-store', 'package_id'), 'acme-store');
  assert.throws(
    () => parseRegistryPackageId(LOCAL_PACKAGE_ID, 'package_id'),
    (error) =>
      error instanceof PublicContractError && /must not start with "local-"/.test(error.message),
  );
});

test('local package ids are derived mechanically from the platform slug', () => {
  assert.equal(localPackageIdForPlatform('acme-store', 'platform'), LOCAL_PACKAGE_ID);
  assert.equal(localPackageIdForPlatform('x', 'platform'), 'local-x');
  assert.equal(localPackageIdForPlatform('a'.repeat(58), 'platform').length, 64);
  assert.throws(
    () => localPackageIdForPlatform('a'.repeat(59), 'platform'),
    (error) => error instanceof PublicContractError && /at most 58 characters/.test(error.message),
  );
  assert.throws(
    () => localPackageIdForPlatform('Acme', 'platform'),
    (error) =>
      error instanceof PublicContractError && /canonical lowercase package id/.test(error.message),
  );
  assert.throws(
    () => localPackageIdForPlatform('acme-', 'platform'),
    (error) =>
      error instanceof PublicContractError && /canonical lowercase package id/.test(error.message),
  );
});

test('a signed registry index cannot represent a local package id', () => {
  assert.equal(
    parseRegistryIndex(indexPayloadWith('acme-store')).packages['acme-store'].tags[0],
    'shopping',
  );
  assert.throws(
    () => parseRegistryIndex(indexPayloadWith(LOCAL_PACKAGE_ID)),
    (error) =>
      error instanceof PublicContractError && /must not start with "local-"/.test(error.message),
  );
});

test('the package parser accepts a local id: the reservation lives at the registry layer', () => {
  const parsed = parsePublicToolPackage(registryPackageValue(LOCAL_PACKAGE_ID));
  assert.equal(parsed.package_id, LOCAL_PACKAGE_ID);
  assert.equal(parsed.capabilities.get_product.visibility, 'public');
});

test('registry selectors answer a local id as a typed miss before any network work', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-local-namespace-'));
  try {
    const service = new ConsumerRegistryServiceV1(
      unreachableRegistry(home),
      new PackageStoreV1(home),
      '0.6.3',
    );
    assert.deepEqual(await service.show({ package_id: LOCAL_PACKAGE_ID }), {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'show',
      code: 'package_not_found',
      retryable: false,
      package_id: LOCAL_PACKAGE_ID,
    });
    assert.deepEqual(await service.install({ package_id: LOCAL_PACKAGE_ID }), {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation: 'install',
      code: 'package_not_found',
      retryable: false,
      package_id: LOCAL_PACKAGE_ID,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the registry selector rejection names the local namespace and the local listing tool', () => {
  const { parseRegistrySelectedPackageId } = require('../dist/consumer/registry/catalog.js');
  assert.throws(
    () => parseRegistrySelectedPackageId(LOCAL_PACKAGE_ID, 'show.package_id'),
    (error) =>
      error.code === 'package_not_found' &&
      error.message.includes('"local-"') &&
      error.message.includes('list_installed_packages'),
  );
});
