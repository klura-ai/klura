import {
  type PackageIdV1,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
} from '../../public/contracts/common';
import { canonicalJson, parseStrictJson, type JsonValueV1 } from '../../public/contracts/json';
import {
  getPublicCapabilityTransports,
  parsePublicToolPackage,
  type PublicToolPackageV1,
} from '../../public/contracts/package';
import type { RegistryPackageVersionV1 } from '../../public/contracts/registry-index';

/** Parses package bytes and binds every public projection to its signed registry version. */
export function parseVerifiedRegistryPackage(
  bytes: Uint8Array,
  packageId: PackageIdV1,
  indexedVersion: RegistryPackageVersionV1,
): PublicToolPackageV1 {
  const publicPackage = parsePublicToolPackage(
    parseStrictJson(
      bytes,
      'downloaded_package',
      PUBLIC_CONTRACT_LIMITS.packageBytes,
      PUBLIC_CONTRACT_LIMITS.maxPackageDepth,
    ),
  );
  if (publicPackage.package_id !== packageId) {
    throw new PublicContractError(
      'package.package_id',
      'does not match the signed registry package',
    );
  }
  if (
    publicPackage.version !== indexedVersion.version ||
    publicPackage.manifest_digest !== indexedVersion.manifest_digest
  ) {
    throw new PublicContractError('package', 'identity does not match its signed registry version');
  }
  const projection: Record<string, JsonValueV1> = {};
  for (const [capabilityId, capability] of Object.entries(publicPackage.capabilities)) {
    if (capability.visibility !== 'public') continue;
    projection[capabilityId] = {
      description: capability.description,
      run_supported: capability.collection !== null,
      transports: getPublicCapabilityTransports(capability),
    };
  }
  const indexedProjection: Record<string, JsonValueV1> = {};
  for (const [capabilityId, capability] of Object.entries(indexedVersion.capabilities)) {
    indexedProjection[capabilityId] = {
      description: capability.description,
      run_supported: capability.run_supported,
      transports: capability.transports,
    };
  }
  if (canonicalJson(projection) !== canonicalJson(indexedProjection)) {
    throw new PublicContractError(
      'package.capabilities',
      'does not match the signed registry projection',
    );
  }
  return publicPackage;
}
