import {
  parseInteger,
  parsePackageId,
  parsePackageVersion,
  parseString,
  PublicContractError,
  type PackageIdV1,
  type PackageVersionV1,
  type Sha256DigestV1,
} from '../public/contracts/common';
import { InstallPackageError, PackageInstallerV1, type PackageInstallSelectorV1 } from './install';
import { PackageDownloadError, RegistryClientError, RegistryClientV1 } from './registry/client';
import {
  RegistryCatalogError,
  RegistryCatalogV1,
  type CatalogPackageSummaryV1,
  type SearchRegistryPackagesInputV1,
  type ShowRegistryPackageResultV1,
} from './registry/catalog';
import { PackageStoreV1, type InstalledPackageV1 } from './store/package-store';

export type ConsumerRegistryOperationV1 = 'search' | 'show' | 'install';

export type ConsumerRegistryFailureCodeV1 =
  | 'invalid_options'
  | 'registry_unavailable'
  | 'registry_invalid'
  | 'cursor_invalid'
  | 'cursor_stale'
  | 'package_not_found'
  | 'version_not_found'
  | 'version_withdrawn'
  | 'runtime_incompatible'
  | 'capability_not_found'
  | 'package_download_failed'
  | 'package_invalid'
  | 'local_state_invalid';

export interface ConsumerRegistryFailureV1 {
  result_schema_version: 1;
  kind: 'consumer_failure';
  operation: ConsumerRegistryOperationV1;
  code: ConsumerRegistryFailureCodeV1;
  retryable: boolean;
  package_id: PackageIdV1 | null;
}

export type SearchPackagesResultV1 =
  | {
      result_schema_version: 1;
      kind: 'package_search';
      index_digest: Sha256DigestV1;
      query: string;
      items: CatalogPackageSummaryV1[];
      next_cursor: string | null;
    }
  | ConsumerRegistryFailureV1;

export type ShowPackageResultV1 =
  | ({ result_schema_version: 1 } & ShowRegistryPackageResultV1)
  | ConsumerRegistryFailureV1;

export interface InstalledArtifactV1 {
  package_id: PackageIdV1;
  version: PackageVersionV1;
  package_digest: Sha256DigestV1;
  manifest_digest: Sha256DigestV1;
  source_index_digest: Sha256DigestV1;
  installed_at: string;
}

export type InstallPackageResultV1 =
  | {
      result_schema_version: 1;
      kind: 'install_result';
      action: 'installed' | 'activated' | 'already_active';
      artifact: InstalledArtifactV1;
      previous_active: InstalledArtifactV1 | null;
    }
  | ConsumerRegistryFailureV1;

/** Provides canonical registry operation results for consumer adapters. */
export class ConsumerRegistryServiceV1 {
  private readonly catalog: RegistryCatalogV1;
  private readonly installer: PackageInstallerV1;

  constructor(
    registry: RegistryClientV1,
    store: PackageStoreV1,
    runtimeVersion: PackageVersionV1 | string,
  ) {
    this.catalog = new RegistryCatalogV1(registry);
    this.installer = new PackageInstallerV1(registry, store, runtimeVersion);
  }

  async search(input: unknown, now = new Date()): Promise<SearchPackagesResultV1> {
    try {
      const result = await this.catalog.search(parseSearchInput(input), now);
      return { result_schema_version: 1, kind: 'package_search', ...result };
    } catch (error) {
      return registryFailure('search', error, null);
    }
  }

  async show(input: unknown, now = new Date()): Promise<ShowPackageResultV1> {
    const packageId = knownPackageId(input);
    try {
      const result = await this.catalog.show(input, now);
      return { result_schema_version: 1, ...result };
    } catch (error) {
      return registryFailure('show', error, packageId);
    }
  }

  async install(input: unknown, now = new Date()): Promise<InstallPackageResultV1> {
    const packageId = knownPackageId(input);
    try {
      const installed = await this.installer.install(parseInstallInput(input), now);
      return {
        result_schema_version: 1,
        kind: 'install_result',
        action: installed.action,
        artifact: projectInstalledArtifact(installed.artifact),
        previous_active:
          installed.previous_active === null
            ? null
            : projectInstalledArtifact(installed.previous_active),
      };
    } catch (error) {
      return registryFailure('install', error, packageId);
    }
  }
}

function parseSearchInput(input: unknown): SearchRegistryPackagesInputV1 {
  try {
    if (input === undefined) return {};
    const record = parseOptionsRecord(input, 'search', ['query', 'limit', 'cursor']);
    return {
      query:
        record.query === undefined ? undefined : parseString(record.query, 'search.query', 512),
      limit:
        record.limit === undefined ? undefined : parseInteger(record.limit, 'search.limit', 1, 50),
      cursor:
        record.cursor === undefined
          ? undefined
          : parseString(record.cursor, 'search.cursor', 1_024),
    };
  } catch (error) {
    throw new RegistryCatalogError('invalid_options', errorMessage(error));
  }
}

function parseInstallInput(input: unknown): PackageInstallSelectorV1 {
  try {
    const record = parseOptionsRecord(input, 'install', ['package_id', 'version']);
    if (!Object.hasOwn(record, 'package_id')) {
      throw new PublicContractError('install', 'is missing required key "package_id"');
    }
    return {
      package_id: parsePackageId(record.package_id, 'install.package_id'),
      version:
        record.version === undefined
          ? undefined
          : parsePackageVersion(record.version, 'install.version'),
    };
  } catch (error) {
    throw new RegistryCatalogError('invalid_options', errorMessage(error));
  }
}

function parseOptionsRecord(
  input: unknown,
  field: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new PublicContractError(`${field}.${key}`, 'is not allowed');
    }
  }
  return record;
}

function knownPackageId(input: unknown): PackageIdV1 | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  try {
    return parsePackageId((input as Record<string, unknown>).package_id, 'package_id');
  } catch {
    return null;
  }
}

function registryFailure(
  operation: ConsumerRegistryOperationV1,
  error: unknown,
  packageId: PackageIdV1 | null,
): ConsumerRegistryFailureV1 {
  const code = errorCode(error, operation);
  if (code === null) throw error;
  return {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation,
    code,
    retryable: code === 'registry_unavailable' || code === 'package_download_failed',
    package_id: code === 'invalid_options' ? null : packageId,
  };
}

function errorCode(
  error: unknown,
  operation: ConsumerRegistryOperationV1,
): ConsumerRegistryFailureCodeV1 | null {
  let candidate: ConsumerRegistryFailureCodeV1 | null = null;
  if (
    error instanceof RegistryCatalogError ||
    error instanceof RegistryClientError ||
    error instanceof InstallPackageError
  ) {
    candidate = error.code;
  } else if (error instanceof PackageDownloadError) {
    candidate = 'package_download_failed';
  } else if (error instanceof PublicContractError && operation === 'install') {
    candidate = 'local_state_invalid';
  }
  if (candidate === null || !allowedFailureCodes(operation).has(candidate)) return null;
  return candidate;
}

function allowedFailureCodes(
  operation: ConsumerRegistryOperationV1,
): ReadonlySet<ConsumerRegistryFailureCodeV1> {
  if (operation === 'search') {
    return new Set([
      'invalid_options',
      'registry_unavailable',
      'registry_invalid',
      'cursor_invalid',
      'cursor_stale',
    ]);
  }
  if (operation === 'show') {
    return new Set([
      'invalid_options',
      'registry_unavailable',
      'registry_invalid',
      'package_not_found',
      'version_not_found',
      'capability_not_found',
      'package_download_failed',
      'package_invalid',
    ]);
  }
  return new Set([
    'invalid_options',
    'registry_unavailable',
    'registry_invalid',
    'package_not_found',
    'version_not_found',
    'version_withdrawn',
    'runtime_incompatible',
    'package_download_failed',
    'package_invalid',
    'local_state_invalid',
  ]);
}

function projectInstalledArtifact(installed: InstalledPackageV1): InstalledArtifactV1 {
  return {
    package_id: installed.package_id,
    version: installed.version,
    package_digest: installed.package_digest,
    manifest_digest: installed.manifest_digest,
    source_index_digest: installed.source_index_digest,
    installed_at: installed.installed_at,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
