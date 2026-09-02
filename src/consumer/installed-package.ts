import {
  parseCapabilityId,
  parsePackageId,
  parsePackageVersion,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  runtimeSupportsVersion,
  type CapabilityIdV1,
  type PackageIdV1,
  type PackageVersionV1,
} from '../public/contracts/common';
import { parseStrictJson } from '../public/contracts/json';
import {
  parsePublicToolPackage,
  type PublicReadCapabilityV1,
  type PublicToolPackageV1,
} from '../public/contracts/package';
import { PackageStoreV1, type InstalledPackageV1 } from './store/package-store';

export interface InstalledCapabilityV1 {
  installed: InstalledPackageV1;
  package: PublicToolPackageV1;
  capability_id: CapabilityIdV1;
  capability: PublicReadCapabilityV1;
}

export class InstalledPackageError extends PublicContractError {
  constructor(
    public readonly code:
      | 'package_not_installed'
      | 'capability_not_found'
      | 'runtime_incompatible'
      | 'local_state_invalid',
    message: string,
  ) {
    super('installed_package', message);
    this.name = 'InstalledPackageError';
  }
}

export function isInstalledPackageErrorCode(
  value: unknown,
): value is InstalledPackageError['code'] {
  return (
    value === 'package_not_installed' ||
    value === 'capability_not_found' ||
    value === 'runtime_incompatible' ||
    value === 'local_state_invalid'
  );
}

/** Resolves only the immutable local package selected by installed.json. */
export class InstalledPackageResolverV1 {
  private readonly runtimeVersion: PackageVersionV1;

  constructor(
    private readonly store: PackageStoreV1,
    runtimeVersion: PackageVersionV1 | string,
  ) {
    this.runtimeVersion = parsePackageVersion(runtimeVersion, 'runtime_version');
  }

  resolvePackage(packageId: PackageIdV1 | string): {
    installed: InstalledPackageV1;
    package: PublicToolPackageV1;
  } {
    const parsedPackageId = parsePackageId(packageId, 'package_id');
    const installed = this.store.getInstalled(parsedPackageId);
    if (!installed) {
      throw new InstalledPackageError('package_not_installed', 'selected package is not installed');
    }
    if (!runtimeSupportsVersion(installed.runtime_range, this.runtimeVersion)) {
      throw new InstalledPackageError(
        'runtime_incompatible',
        'installed package excludes this runtime version',
      );
    }
    try {
      const bytes = this.store.readArtifact(installed.package_digest);
      const parsedPackage = parsePublicToolPackage(
        parseStrictJson(
          bytes,
          'stored_package',
          PUBLIC_CONTRACT_LIMITS.packageBytes,
          PUBLIC_CONTRACT_LIMITS.maxPackageDepth,
        ),
      );
      if (
        parsedPackage.package_id !== installed.package_id ||
        parsedPackage.version !== installed.version ||
        parsedPackage.manifest_digest !== installed.manifest_digest
      ) {
        throw new PublicContractError(
          'stored_package',
          'does not match the installed immutable pointer',
        );
      }
      return { installed, package: parsedPackage };
    } catch (error) {
      if (error instanceof InstalledPackageError) throw error;
      throw new InstalledPackageError('local_state_invalid', errorMessage(error));
    }
  }

  resolveCapability(
    packageId: PackageIdV1 | string,
    capabilityId: CapabilityIdV1 | string,
  ): InstalledCapabilityV1 {
    const resolved = this.resolvePackage(packageId);
    const parsedCapabilityId = parseCapabilityId(capabilityId, 'capability');
    const capability = resolved.package.capabilities[parsedCapabilityId];
    if (!capability || capability.visibility !== 'public') {
      throw new InstalledPackageError(
        'capability_not_found',
        'selected capability is absent from the installed package public interface',
      );
    }
    return { ...resolved, capability_id: parsedCapabilityId, capability };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
