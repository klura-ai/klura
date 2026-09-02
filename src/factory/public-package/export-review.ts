// Parsing for the platform-export input: the platform slug, the
// tools-repository path, and the reviewed package contract, whose
// per-capability page-script and fixture reviews come from the shared
// capability-review contract under this input's field prefix. Every failure is
// a PublicContractError naming the exact reviewed path, raised before any
// smoke traffic or file writes.
import fs from 'node:fs';
import path from 'node:path';
import {
  parseBoundedRecord,
  parseExactRecord,
  parsePackageVersion,
  parseRegistryPackageId,
  parseRuntimeRange,
  PublicContractError,
  runtimeSupportsVersion,
  type PackageIdV1,
  type PackageVersionV1,
} from '../../public/contracts/common';
import { readConsumerRuntimeVersion } from '../../consumer/runtime-version';
import {
  parseRegistryCatalogManifest,
  parseRegistryReleaseState,
  REGISTRY_CATALOG_SCHEMA_VERSION,
  REGISTRY_RELEASE_CATALOG_KEYS,
  type RegistryCatalogManifestV1,
} from '../../public/contracts/registry-catalog';
import { TOOLS_PACKAGE_LAYOUT_V1 } from './tools-layout';
import { asPlatformSlug, ValidationError } from '../../validators';
import { parseCapabilityReview, type ParsedCapabilityReviewV1 } from './capability-review';

const EXPORT_CAPABILITIES_FIELD = 'platform_export.review.capabilities';

export interface ParsedExportReviewV1 {
  package_id: PackageIdV1;
  version: PackageVersionV1;
  authentication_contracts: Record<string, unknown>;
  registry_manifest: RegistryCatalogManifestV1;
  capabilities: Record<string, ParsedCapabilityReviewV1>;
}

export function parsePlatform(value: unknown): string {
  try {
    return asPlatformSlug(value, 'platform');
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new PublicContractError('platform_export.platform', error.message);
    }
    throw error;
  }
}

export function parseToolsRepositoryPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new PublicContractError(
      'platform_export.tools_repository_path',
      'must be a non-empty absolute path without NUL',
    );
  }
  if (!path.isAbsolute(value)) {
    throw new PublicContractError(
      'platform_export.tools_repository_path',
      'must be an absolute path',
    );
  }
  const resolved = path.resolve(value);
  const toolsDirectory = path.join(resolved, TOOLS_PACKAGE_LAYOUT_V1.packagesDirectoryName);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    throw new PublicContractError(
      'platform_export.tools_repository_path',
      'must name an existing directory',
    );
  }
  if (!fs.statSync(toolsDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new PublicContractError(
      'platform_export.tools_repository_path',
      'must contain the tools/ package directory',
    );
  }
  return resolved;
}

export function parseExportReview(value: unknown): ParsedExportReviewV1 {
  const review = parseExactRecord(value, 'platform_export.review', [
    'package_id',
    'version',
    'authentication_contracts',
    'catalog',
    'capabilities',
  ]);
  const version = parsePackageVersion(review.version, 'platform_export.review.version');
  const catalog = parseExactRecord(
    review.catalog,
    'platform_export.review.catalog',
    REGISTRY_RELEASE_CATALOG_KEYS,
  );
  const state = parseRegistryReleaseState(catalog.state, 'platform_export.review.catalog.state');
  const runtimeRange = parseRuntimeRange(
    catalog.runtime_range,
    'platform_export.review.catalog.runtime_range',
  );
  // Fixtures are smoke-verified under the exporting runtime, so an installable
  // release may only promise a compatibility window that covers it.
  const exportingRuntime = parsePackageVersion(readConsumerRuntimeVersion(), 'runtime.version');
  if (state === 'installable' && !runtimeSupportsVersion(runtimeRange, exportingRuntime)) {
    throw new PublicContractError(
      'platform_export.review.catalog.runtime_range',
      `must include the exporting runtime ${exportingRuntime}: this export verifies fixtures ` +
        `under that runtime, and [${runtimeRange.minimum_inclusive}, ${runtimeRange.maximum_exclusive}) excludes it`,
    );
  }
  // The written registry.json is validated here, before any smoke traffic,
  // through the same manifest contract every registry-side reader parses.
  const registryManifest = parseRegistryCatalogManifest(
    {
      registry_catalog_schema_version: REGISTRY_CATALOG_SCHEMA_VERSION,
      display_name: catalog.display_name,
      description: catalog.description,
      domains: catalog.domains,
      tags: catalog.tags,
      stable_version: version,
      releases: [
        {
          source: TOOLS_PACKAGE_LAYOUT_V1.packageSourceFileName,
          state,
          runtime_range: runtimeRange,
        },
      ],
    },
    'platform_export.review.catalog',
  );
  const rawCapabilities = parseBoundedRecord(review.capabilities, EXPORT_CAPABILITIES_FIELD, 32);
  if (Object.keys(rawCapabilities).length === 0) {
    throw new PublicContractError(
      EXPORT_CAPABILITIES_FIELD,
      'must contain at least one reviewed capability',
    );
  }
  const capabilities: Record<string, ParsedCapabilityReviewV1> = {};
  // One shared fixture-ID set across the whole review rejects a collision here
  // — before any smoke traffic — instead of at file-write time.
  const fixtureIds = new Set<string>();
  for (const [capabilityId, value] of Object.entries(rawCapabilities)) {
    capabilities[capabilityId] = parseCapabilityReview(value, {
      field_prefix: EXPORT_CAPABILITIES_FIELD,
      capability_id: capabilityId,
      seen_fixture_ids: fixtureIds,
    });
  }
  return {
    package_id: parseRegistryPackageId(review.package_id, 'platform_export.review.package_id'),
    version,
    authentication_contracts: parseBoundedRecord(
      review.authentication_contracts,
      'platform_export.review.authentication_contracts',
      32,
    ),
    registry_manifest: registryManifest,
    capabilities,
  };
}
