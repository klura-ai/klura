import {
  parsePackageVersion,
  parseRuntimeRange,
  parseSha256Digest,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  parseLocalPackageId,
  runtimeSupportsVersion,
  sha256Digest,
  type PackageIdV1,
  type PackageVersionV1,
  type RuntimeRangeV1,
  type Sha256DigestV1,
} from '../public/contracts/common';
import { parseStrictJson } from '../public/contracts/json';
import { parsePublicToolPackage } from '../public/contracts/package';
import { nowAsRfc3339Seconds } from './install';
import { PackageStoreV1, type InstalledPackageV1 } from './store/package-store';

export interface LocalPackageInstallInputV1 {
  package_id: PackageIdV1 | string;
  /** Compiled package bytes, byte-identical to what the export path compiles. */
  bytes: Uint8Array;
  /** Digest of the canonical authored source the bytes were compiled from. */
  source_digest: Sha256DigestV1 | string;
}

export interface InstallLocalPackageResultV1 {
  action: 'installed' | 'activated' | 'already_active';
  artifact: InstalledPackageV1;
  previous_active: InstalledPackageV1 | null;
}

export class LocalPackageInstallError extends PublicContractError {
  constructor(
    public readonly code:
      | 'package_id_not_local'
      | 'runtime_incompatible'
      | 'package_invalid'
      | 'local_state_invalid',
    message: string,
  ) {
    super('install_local', message);
    this.name = 'LocalPackageInstallError';
  }
}

/** Installs a locally authored package into the same immutable store the
 *  registry path writes. Execution safety is the package parser's job and is
 *  byte-identical here; only distribution trust — signature, index validity,
 *  download digest, release state — is absent, because there is no publisher.
 */
export class LocalPackageInstallerV1 {
  private readonly runtimeVersion: PackageVersionV1;

  constructor(
    private readonly store: PackageStoreV1,
    runtimeVersion: PackageVersionV1 | string,
  ) {
    this.runtimeVersion = parsePackageVersion(runtimeVersion, 'runtime_version');
  }

  install(input: LocalPackageInstallInputV1, now = new Date()): InstallLocalPackageResultV1 {
    const packageId = this.parseLocalSelector(input.package_id);
    const sourceDigest = this.parseSourceDigest(input.source_digest);
    const parsedPackage = this.parseBytes(input.bytes, packageId);
    const packageDigest = sha256Digest(input.bytes);
    const runtimeRange = this.deriveRuntimeRange();
    const current = this.store.getInstalled(packageId);
    if (
      current?.package_digest === packageDigest &&
      current.version === parsedPackage.version &&
      current.manifest_digest === parsedPackage.manifest_digest &&
      current.provenance.kind === 'local' &&
      current.provenance.source_digest === sourceDigest
    ) {
      return { action: 'already_active', artifact: current, previous_active: current };
    }
    try {
      this.store.putVerifiedPackage({
        package_id: packageId,
        version: parsedPackage.version,
        package_digest: packageDigest,
        manifest_digest: parsedPackage.manifest_digest,
        package_bytes: input.bytes.byteLength,
        bytes: input.bytes,
      });
    } catch (error) {
      throw new LocalPackageInstallError('package_invalid', errorMessage(error));
    }
    const artifact: InstalledPackageV1 = {
      package_id: packageId,
      version: parsedPackage.version,
      package_digest: packageDigest,
      manifest_digest: parsedPackage.manifest_digest,
      provenance: { kind: 'local', source_digest: sourceDigest },
      runtime_range: runtimeRange,
      installed_at: nowAsRfc3339Seconds(now),
    };
    try {
      this.store.activate(artifact);
    } catch (error) {
      throw new LocalPackageInstallError('local_state_invalid', errorMessage(error));
    }
    return {
      action: current === null ? 'installed' : 'activated',
      artifact,
      previous_active: current,
    };
  }

  private parseLocalSelector(value: LocalPackageInstallInputV1['package_id']): PackageIdV1 {
    try {
      return parseLocalPackageId(value, 'install_local.package_id');
    } catch (error) {
      throw new LocalPackageInstallError('package_id_not_local', errorMessage(error));
    }
  }

  private parseSourceDigest(value: LocalPackageInstallInputV1['source_digest']): Sha256DigestV1 {
    try {
      return parseSha256Digest(value, 'install_local.source_digest');
    } catch (error) {
      throw new LocalPackageInstallError('package_invalid', errorMessage(error));
    }
  }

  private parseBytes(
    bytes: Uint8Array,
    packageId: PackageIdV1,
  ): ReturnType<typeof parsePublicToolPackage> {
    let parsedPackage;
    try {
      parsedPackage = parsePublicToolPackage(
        parseStrictJson(
          bytes,
          'install_local.bytes',
          PUBLIC_CONTRACT_LIMITS.packageBytes,
          PUBLIC_CONTRACT_LIMITS.maxPackageDepth,
        ),
      );
    } catch (error) {
      throw new LocalPackageInstallError('package_invalid', errorMessage(error));
    }
    if (parsedPackage.package_id !== packageId) {
      throw new LocalPackageInstallError(
        'package_invalid',
        'compiled package names a different package id than the selected local id',
      );
    }
    return parsedPackage;
  }

  /** The compatibility window is derived from the runtime that compiled the
   *  package, never authored: a window excluding the running runtime would
   *  make the artifact unresolvable and strand an interrupted run. */
  private deriveRuntimeRange(): RuntimeRangeV1 {
    const range = parseRuntimeRange(
      {
        minimum_inclusive: this.runtimeVersion,
        maximum_exclusive: nextBreakingVersion(this.runtimeVersion),
      },
      'install_local.runtime_range',
    );
    if (!runtimeSupportsVersion(range, this.runtimeVersion)) {
      throw new LocalPackageInstallError(
        'runtime_incompatible',
        `derived runtime range [${range.minimum_inclusive}, ${range.maximum_exclusive}) excludes the running runtime ${this.runtimeVersion}`,
      );
    }
    return range;
  }
}

/** SemVer's breaking axis: the major, or the minor while the major is zero. */
function nextBreakingVersion(version: PackageVersionV1): string {
  const core = version.split('-')[0] ?? '';
  const parts = core.split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new LocalPackageInstallError(
      'runtime_incompatible',
      `running runtime ${version} is not a canonical SemVer version`,
    );
  }
  return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
