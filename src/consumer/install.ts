import {
  parsePackageVersion,
  parseRfc3339Instant,
  PublicContractError,
  runtimeSupportsVersion,
  type PackageIdV1,
  type PackageVersionV1,
  type Rfc3339InstantV1,
} from '../public/contracts/common';
import { RegistryClientV1 } from './registry/client';
import { parseVerifiedRegistryPackage } from './registry/package-verification';
import { PackageStoreV1, type InstalledPackageV1 } from './store/package-store';

export interface PackageInstallSelectorV1 {
  package_id: PackageIdV1;
  version?: PackageVersionV1;
}

export interface InstallPackageResultV1 {
  action: 'installed' | 'activated' | 'already_active';
  artifact: InstalledPackageV1;
  previous_active: InstalledPackageV1 | null;
}

export class InstallPackageError extends PublicContractError {
  constructor(
    public readonly code:
      | 'package_not_found'
      | 'version_not_found'
      | 'version_withdrawn'
      | 'runtime_incompatible'
      | 'package_invalid',
    message: string,
  ) {
    super('install', message);
    this.name = 'InstallPackageError';
  }
}

export class PackageInstallerV1 {
  constructor(
    private readonly registry: RegistryClientV1,
    private readonly store: PackageStoreV1,
    runtimeVersion: PackageVersionV1 | string,
  ) {
    this.runtimeVersion = parsePackageVersion(runtimeVersion, 'runtime_version');
  }

  private readonly runtimeVersion: PackageVersionV1;

  async install(
    selector: PackageInstallSelectorV1,
    now = new Date(),
  ): Promise<InstallPackageResultV1> {
    const verifiedIndex = await this.registry.refresh(now);
    const indexedPackage = verifiedIndex.signed_index.payload.packages[selector.package_id];
    if (!indexedPackage) {
      throw new InstallPackageError(
        'package_not_found',
        'selected package is absent from the registry',
      );
    }
    const selectedVersion = selector.version ?? indexedPackage.stable_version;
    const indexedVersion = indexedPackage.versions[selectedVersion];
    if (!indexedVersion) {
      throw new InstallPackageError(
        'version_not_found',
        'selected version is absent from the registry',
      );
    }
    if (indexedVersion.state !== 'installable') {
      throw new InstallPackageError('version_withdrawn', 'selected version is withdrawn');
    }
    if (!runtimeSupportsVersion(indexedVersion.runtime_range, this.runtimeVersion)) {
      throw new InstallPackageError(
        'runtime_incompatible',
        'selected version excludes this runtime',
      );
    }
    const current = this.store.getInstalled(selector.package_id);
    if (
      current?.version === indexedVersion.version &&
      current.package_digest === indexedVersion.package_digest &&
      current.manifest_digest === indexedVersion.manifest_digest
    ) {
      return { action: 'already_active', artifact: current, previous_active: current };
    }
    const bytes = await this.registry.downloadPackage(indexedVersion);
    try {
      parseVerifiedRegistryPackage(bytes, selector.package_id, indexedVersion);
    } catch (error) {
      throw new InstallPackageError('package_invalid', asError(error).message);
    }
    this.store.putVerifiedPackage({
      package_id: selector.package_id,
      version: indexedVersion.version,
      package_digest: indexedVersion.package_digest,
      manifest_digest: indexedVersion.manifest_digest,
      package_bytes: indexedVersion.package_bytes,
      bytes,
    });
    const artifact: InstalledPackageV1 = {
      package_id: selector.package_id,
      version: indexedVersion.version,
      package_digest: indexedVersion.package_digest,
      manifest_digest: indexedVersion.manifest_digest,
      source_index_digest: verifiedIndex.source_digest,
      runtime_range: indexedVersion.runtime_range,
      installed_at: nowAsRfc3339Seconds(now),
    };
    this.store.activate(artifact);
    return {
      action: current === null ? 'installed' : 'activated',
      artifact,
      previous_active: current,
    };
  }
}

function nowAsRfc3339Seconds(value: Date): Rfc3339InstantV1 {
  if (!Number.isFinite(value.getTime())) {
    throw new PublicContractError('install.now', 'must be a valid instant');
  }
  const rounded = new Date(Math.floor(value.getTime() / 1_000) * 1_000)
    .toISOString()
    .replace('.000Z', 'Z');
  return parseRfc3339Instant(rounded, 'install.now');
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
