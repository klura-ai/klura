import { sign, type KeyObject } from 'node:crypto';
import {
  parseExactRecord,
  parseHttpsOrigin,
  sha256Digest,
  PublicContractError,
  type CapabilityIdV1,
  type Sha256DigestV1,
} from '../../public/contracts/common';
import type { CollectionRunContractV1 } from '../../public/contracts/collection';
import { canonicalJson, type JsonValueV1 } from '../../public/contracts/json';
import { parseJsonSchema } from '../../public/contracts/json-schema';
import { deriveInlineOutputBound } from '../../public/contracts/inline-output-bound';
import {
  calculatePublicToolPackageManifestDigest,
  getPublicCapabilityTransports,
  parsePublicToolPackage,
  type PublicExecutionStrategyV1,
  type PublicReadCapabilityV1,
  type PublicToolPackageV1,
} from '../../public/contracts/package';
import type {
  RegistryCapabilityV1,
  RegistryIndexV1,
  RegistryPackageV1,
  RegistryPackageVersionV1,
  SignedRegistryIndexV1,
} from '../../public/contracts/registry-index';
import type { PublicBrowserPageScriptStrategyV1 } from '../../public/contracts/browser-page-script';
import {
  parseRegistryIndex,
  parseSignedRegistryIndex,
  REGISTRY_KEY_ID_V1,
} from '../../public/contracts/registry-index';
import type { PublicBrowserPageScriptStrategySourceV1 } from './page-script-export';

export {
  exportReviewedLocalPageScriptStrategySource,
  type PublicBrowserPageScriptStrategySourceV1,
} from './page-script-export';

const PACKAGE_SOURCE_KEYS = [
  'package_schema_version',
  'package_id',
  'version',
  'authentication_contracts',
  'capabilities',
] as const;

export interface PublicPackageSourceV1 {
  package_source_schema_version: 1;
  package: PublicToolPackageSourceV1;
}

export type PublicExecutionStrategySourceV1 =
  | Exclude<PublicExecutionStrategyV1, PublicBrowserPageScriptStrategyV1>
  | PublicBrowserPageScriptStrategySourceV1;

export type PublicCollectionRunContractSourceV1 = Omit<
  CollectionRunContractV1,
  'inline_output_bound'
> & {
  inline_output_bound: null;
};

export type PublicReadCapabilitySourceV1 = Omit<
  PublicReadCapabilityV1,
  'strategies' | 'collection'
> & {
  strategies: [PublicExecutionStrategySourceV1, ...PublicExecutionStrategySourceV1[]];
  collection: PublicCollectionRunContractSourceV1 | null;
};

export type PublicToolPackageSourceV1 = Omit<
  PublicToolPackageV1,
  'manifest_digest' | 'capabilities'
> & {
  capabilities: Record<CapabilityIdV1, PublicReadCapabilitySourceV1>;
};

export interface CompiledPublicPackageV1 {
  package: PublicToolPackageV1;
  manifest_digest: Sha256DigestV1;
  bytes: Buffer;
}

export interface RegistryReleaseCatalogV1 {
  display_name: string;
  description: string;
  domains: string[];
  tags: string[];
  state: 'installable' | 'withdrawn';
  runtime_range: RegistryPackageVersionV1['runtime_range'];
}

export interface CompiledRegistryReleaseEntryV1 {
  package: CompiledPublicPackageV1;
  catalog: RegistryReleaseCatalogV1;
  registry_version: RegistryPackageVersionV1;
}

export interface StaticRegistryIndexPackageInputV1 {
  stable_version: RegistryPackageV1['stable_version'];
  entries: [CompiledRegistryReleaseEntryV1, ...CompiledRegistryReleaseEntryV1[]];
}

export interface StaticRegistryIndexInputV1 {
  generated_at: string;
  expires_at: string;
  packages: [StaticRegistryIndexPackageInputV1, ...StaticRegistryIndexPackageInputV1[]];
}

/** Compiles explicit public package data without interpreting local strategies. */
export function compilePublicPackageSource(value: unknown): CompiledPublicPackageV1 {
  const source = parseExactRecord(value, 'package_source', [
    'package_source_schema_version',
    'package',
  ]);
  if (source.package_source_schema_version !== 1) {
    throw new PublicContractError('package_source.package_source_schema_version', 'must be 1');
  }
  const packageSource = parseExactRecord(
    source.package,
    'package_source.package',
    PACKAGE_SOURCE_KEYS,
  );
  const compiledSource = deriveCompilerOwnedPackageFields(packageSource);
  const candidate = {
    ...compiledSource,
    manifest_digest: '0'.repeat(64),
  };
  const manifestDigest = calculatePublicToolPackageManifestDigest(candidate);
  const packageValue = { ...compiledSource, manifest_digest: manifestDigest };
  const toolPackage = parsePublicToolPackage(packageValue);
  return {
    package: toolPackage,
    manifest_digest: manifestDigest,
    bytes: Buffer.from(canonicalJson(packageValue as JsonValueV1), 'utf8'),
  };
}

/** Replaces source placeholders with compiler-owned, byte-derived fields. */
function deriveCompilerOwnedPackageFields(
  packageSource: Record<string, unknown>,
): Record<string, unknown> {
  const capabilities = packageSource.capabilities;
  if (!isRecord(capabilities)) return packageSource;
  const compiledCapabilities: Record<string, unknown> = {};
  for (const [capabilityId, value] of Object.entries(capabilities)) {
    compiledCapabilities[capabilityId] = deriveCapabilityCompilerFields(value, capabilityId);
  }
  return { ...packageSource, capabilities: compiledCapabilities };
}

function deriveCapabilityCompilerFields(value: unknown, capabilityId: string): unknown {
  if (!isRecord(value)) return value;
  const strategies = Array.isArray(value.strategies)
    ? value.strategies.map((strategy, index) =>
        deriveBrowserPageScriptDigest(strategy, capabilityId, index),
      )
    : value.strategies;
  const withStrategies = { ...value, strategies };
  if (value.collection === null || !isRecord(value.collection)) return withStrategies;
  const field = `package_source.package.capabilities.${capabilityId}.collection`;
  if (value.collection.inline_output_bound !== null) {
    throw new PublicContractError(
      `${field}.inline_output_bound`,
      'must be null in source because the compiler derives this field',
    );
  }
  const itemSchema = parseJsonSchema(value.collection.item_schema, `${field}.item_schema`);
  return {
    ...withStrategies,
    collection: {
      ...value.collection,
      inline_output_bound: deriveInlineOutputBound(itemSchema),
    },
  };
}

function deriveBrowserPageScriptDigest(
  value: unknown,
  capabilityId: string,
  index: number,
): unknown {
  if (!isRecord(value) || value.kind !== 'browser_page_script' || !isRecord(value.program)) {
    return value;
  }
  const field = `package_source.package.capabilities.${capabilityId}.strategies[${index}].program`;
  if (value.program.source_digest !== null) {
    throw new PublicContractError(
      `${field}.source_digest`,
      'must be null in source because the compiler derives this field',
    );
  }
  if (typeof value.program.source !== 'string') return value;
  return {
    ...value,
    program: {
      ...value.program,
      source_digest: sha256Digest(value.program.source),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Compiles one static-registry entry from explicit catalog data and package source. */
export function compileRegistryReleaseEntry(value: unknown): CompiledRegistryReleaseEntryV1 {
  const input = parseExactRecord(value, 'registry_release', [
    'package_source',
    'catalog',
    'registry_origin',
  ]);
  const compiled = compilePublicPackageSource(input.package_source);
  const origin = parseHttpsOrigin(input.registry_origin, 'registry_release.registry_origin');
  const catalogRecord = parseExactRecord(input.catalog, 'registry_release.catalog', [
    'display_name',
    'description',
    'domains',
    'tags',
    'state',
    'runtime_range',
  ]);
  if (catalogRecord.state !== 'installable' && catalogRecord.state !== 'withdrawn') {
    throw new PublicContractError(
      'registry_release.catalog.state',
      'must be installable or withdrawn',
    );
  }
  const packageDigest = sha256Digest(compiled.bytes);
  const registryVersion: RegistryPackageVersionV1 = {
    version: compiled.package.version,
    state: catalogRecord.state,
    package_url: `${origin}/v1/packages/${packageDigest}.json`,
    package_bytes: compiled.bytes.byteLength,
    package_digest: packageDigest,
    manifest_digest: compiled.manifest_digest,
    runtime_range: catalogRecord.runtime_range as RegistryPackageVersionV1['runtime_range'],
    capabilities: Object.fromEntries(
      Object.entries(compiled.package.capabilities)
        .filter(([, capability]) => capability.visibility === 'public')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([capabilityId, capability]) => [
          capabilityId,
          {
            description: capability.description,
            run_supported: capability.collection !== null,
            transports: getPublicCapabilityTransports(capability),
          } satisfies RegistryCapabilityV1,
        ]),
    ) as RegistryPackageVersionV1['capabilities'],
  };
  const validated = parseRegistryIndex({
    registry_schema_version: 1,
    generated_at: '2026-07-27T00:00:00Z',
    expires_at: '2026-07-28T00:00:00Z',
    packages: {
      [compiled.package.package_id]: {
        package_id: compiled.package.package_id,
        display_name: catalogRecord.display_name,
        description: catalogRecord.description,
        domains: catalogRecord.domains,
        tags: catalogRecord.tags,
        stable_version: compiled.package.version,
        versions: {
          [compiled.package.version]: { ...registryVersion, state: 'installable' },
        },
      },
    },
  });
  const validatedPackage = validated.packages[compiled.package.package_id];
  if (validatedPackage === undefined) {
    throw new PublicContractError('registry_release', 'did not produce its package entry');
  }
  const validatedVersion = validatedPackage.versions[compiled.package.version];
  if (validatedVersion === undefined) {
    throw new PublicContractError('registry_release', 'did not produce its version entry');
  }
  return {
    package: compiled,
    catalog: projectCatalog(validatedPackage, catalogRecord.state),
    registry_version: { ...validatedVersion, state: catalogRecord.state },
  };
}

/** Assembles release entries into the exact unsigned payload covered by the registry signature. */
export function compileStaticRegistryIndex(input: StaticRegistryIndexInputV1): RegistryIndexV1 {
  const packages: Record<string, unknown> = {};
  for (const packageInput of input.packages) {
    const first = packageInput.entries[0];
    const packageId = first.package.package.package_id;
    if (Object.hasOwn(packages, packageId)) {
      throw new PublicContractError(
        'registry_index.packages',
        'must not contain duplicate package IDs',
      );
    }
    const catalogIdentity = canonicalJson({
      display_name: first.catalog.display_name,
      description: first.catalog.description,
      domains: first.catalog.domains,
      tags: first.catalog.tags,
    });
    const versions: Record<string, RegistryPackageVersionV1> = {};
    for (const entry of packageInput.entries) {
      if (entry.package.package.package_id !== packageId) {
        throw new PublicContractError('registry_index.packages', 'must not mix package IDs');
      }
      const entryCatalogIdentity = canonicalJson({
        display_name: entry.catalog.display_name,
        description: entry.catalog.description,
        domains: entry.catalog.domains,
        tags: entry.catalog.tags,
      });
      if (entryCatalogIdentity !== catalogIdentity) {
        throw new PublicContractError(
          'registry_index.packages',
          'must retain one catalog identity across package versions',
        );
      }
      const version = entry.registry_version.version;
      if (Object.hasOwn(versions, version)) {
        throw new PublicContractError(
          'registry_index.versions',
          'must not contain duplicate versions',
        );
      }
      versions[version] = entry.registry_version;
    }
    packages[packageId] = {
      package_id: packageId,
      display_name: first.catalog.display_name,
      description: first.catalog.description,
      domains: first.catalog.domains,
      tags: first.catalog.tags,
      stable_version: packageInput.stable_version,
      versions,
    };
  }
  return parseRegistryIndex({
    registry_schema_version: 1,
    generated_at: input.generated_at,
    expires_at: input.expires_at,
    packages,
  });
}

/** Signs only validated canonical index payload bytes for the static deployment. */
export function signStaticRegistryIndex(
  index: RegistryIndexV1,
  signingKey: string | Uint8Array | KeyObject,
): SignedRegistryIndexV1 {
  const payload = parseRegistryIndex(index);
  const key =
    signingKey instanceof Uint8Array && !Buffer.isBuffer(signingKey)
      ? Buffer.from(signingKey)
      : signingKey;
  return parseSignedRegistryIndex({
    envelope_schema_version: 1,
    payload,
    signature: {
      algorithm: 'ed25519',
      key_id: REGISTRY_KEY_ID_V1,
      value: sign(
        null,
        Buffer.from(canonicalJson(payload as unknown as JsonValueV1), 'utf8'),
        key,
      ).toString('base64url'),
    },
  });
}

function projectCatalog(
  entry: RegistryPackageV1,
  state: RegistryReleaseCatalogV1['state'],
): RegistryReleaseCatalogV1 {
  const stable = entry.versions[entry.stable_version];
  if (stable === undefined) {
    throw new PublicContractError(
      'registry_release',
      'validated package is missing its stable version',
    );
  }
  return {
    display_name: entry.display_name,
    description: entry.description,
    domains: entry.domains,
    tags: entry.tags,
    state,
    runtime_range: stable.runtime_range,
  };
}
