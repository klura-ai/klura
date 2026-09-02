import {
  parseExactRecord,
  parsePackageVersion,
  parseRuntimeRange,
  parseString,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  type PackageVersionV1,
  type RuntimeRangeV1,
} from './common';
import { parseStrictJson } from './json';

/**
 * Registry catalog manifest contract (`registry.json`).
 *
 * One manifest file is the catalog side of one tools-repository package
 * directory: the platform exporter writes it, the static registry builder
 * reads it into release entries, and the release compiler consumes each
 * release's catalog projection. Every side shares this parser, the release
 * source path grammar, and the catalog projection so the manifest cannot
 * drift between its writer and its readers.
 */

export const REGISTRY_CATALOG_SCHEMA_VERSION = 1;

export const REGISTRY_CATALOG_LIMITS = {
  maximumBytes: 256 * 1024,
  maximumDepth: 8,
  maximumReleases: PUBLIC_CONTRACT_LIMITS.maxPackageVersions,
  maximumDisplayNameBytes: 160,
  maximumDescriptionBytes: 512,
  maximumListEntryBytes: 128,
} as const;

/** File names the release source path grammar is built from. */
export const PACKAGE_SOURCE_FILE_NAME = 'package.source.json';
export const RELEASES_DIRECTORY_NAME = 'releases';

export const REGISTRY_CATALOG_MANIFEST_KEYS = [
  'registry_catalog_schema_version',
  'display_name',
  'description',
  'domains',
  'tags',
  'stable_version',
  'releases',
] as const;

export const REGISTRY_CATALOG_RELEASE_KEYS = ['source', 'state', 'runtime_range'] as const;

/** Key set of one release's catalog record as the release compiler consumes it. */
export const REGISTRY_RELEASE_CATALOG_KEYS = [
  'display_name',
  'description',
  'domains',
  'tags',
  'state',
  'runtime_range',
] as const;

export type RegistryReleaseStateV1 = 'installable' | 'withdrawn';

export interface RegistryCatalogReleaseV1 {
  source: string;
  state: RegistryReleaseStateV1;
  runtime_range: RuntimeRangeV1;
}

export interface RegistryCatalogManifestV1 {
  registry_catalog_schema_version: typeof REGISTRY_CATALOG_SCHEMA_VERSION;
  display_name: string;
  description: string;
  domains: string[];
  tags: string[];
  stable_version: PackageVersionV1;
  releases: [RegistryCatalogReleaseV1, ...RegistryCatalogReleaseV1[]];
}

/** One release's catalog record projected from a manifest for the release compiler. */
export interface RegistryReleaseCatalogV1 {
  display_name: string;
  description: string;
  domains: string[];
  tags: string[];
  state: RegistryReleaseStateV1;
  runtime_range: RuntimeRangeV1;
}

export type RegistryReleaseSourcePathV1 =
  | { kind: 'stable' }
  | { kind: 'release'; version: PackageVersionV1 };

export function parseRegistryReleaseState(value: unknown, field: string): RegistryReleaseStateV1 {
  if (value !== 'installable' && value !== 'withdrawn') {
    throw new PublicContractError(field, 'must be installable or withdrawn');
  }
  return value;
}

/**
 * Parses one manifest release source path: the stable
 * `package.source.json`, or one immutable
 * `releases/<version>/package.source.json` bound to its exact version.
 */
export function parseRegistryReleaseSourcePath(
  value: unknown,
  field: string,
): RegistryReleaseSourcePathV1 {
  const text = parseString(value, field, PUBLIC_CONTRACT_LIMITS.maxStringBytes);
  if (text === PACKAGE_SOURCE_FILE_NAME) return { kind: 'stable' };
  const segments = text.split('/');
  if (
    segments.length !== 3 ||
    segments[0] !== RELEASES_DIRECTORY_NAME ||
    segments[2] !== PACKAGE_SOURCE_FILE_NAME
  ) {
    throw new PublicContractError(
      field,
      `must be ${PACKAGE_SOURCE_FILE_NAME} or ` +
        `${RELEASES_DIRECTORY_NAME}/<version>/${PACKAGE_SOURCE_FILE_NAME}`,
    );
  }
  return { kind: 'release', version: parsePackageVersion(segments[1], `${field} version`) };
}

/** Parses one registry catalog manifest into its exact typed shape. */
export function parseRegistryCatalogManifest(
  value: unknown,
  field: string,
): RegistryCatalogManifestV1 {
  const record = parseExactRecord(value, field, REGISTRY_CATALOG_MANIFEST_KEYS);
  if (record.registry_catalog_schema_version !== REGISTRY_CATALOG_SCHEMA_VERSION) {
    throw new PublicContractError(
      `${field}.registry_catalog_schema_version`,
      `must be ${REGISTRY_CATALOG_SCHEMA_VERSION}`,
    );
  }
  if (
    !Array.isArray(record.releases) ||
    record.releases.length === 0 ||
    record.releases.length > REGISTRY_CATALOG_LIMITS.maximumReleases
  ) {
    throw new PublicContractError(
      `${field}.releases`,
      `must contain one to ${REGISTRY_CATALOG_LIMITS.maximumReleases} releases`,
    );
  }
  const seenSources = new Set<string>();
  const releases = record.releases.map((candidate, index) => {
    const release = parseCatalogRelease(candidate, `${field}.releases[${index}]`);
    if (seenSources.has(release.source)) {
      throw new PublicContractError(
        `${field}.releases[${index}].source`,
        'must not be duplicated across releases',
      );
    }
    seenSources.add(release.source);
    return release;
  }) as [RegistryCatalogReleaseV1, ...RegistryCatalogReleaseV1[]];
  return {
    registry_catalog_schema_version: REGISTRY_CATALOG_SCHEMA_VERSION,
    display_name: parseNonEmptyString(
      record.display_name,
      `${field}.display_name`,
      REGISTRY_CATALOG_LIMITS.maximumDisplayNameBytes,
    ),
    description: parseString(
      record.description,
      `${field}.description`,
      REGISTRY_CATALOG_LIMITS.maximumDescriptionBytes,
    ),
    domains: parseUniqueStringList(
      record.domains,
      `${field}.domains`,
      PUBLIC_CONTRACT_LIMITS.maxPackageDomains,
    ),
    tags: parseUniqueStringList(
      record.tags,
      `${field}.tags`,
      PUBLIC_CONTRACT_LIMITS.maxPackageTags,
    ),
    stable_version: parsePackageVersion(record.stable_version, `${field}.stable_version`),
    releases,
  };
}

/** Parses exact manifest file bytes under the byte and depth bounds every reader applies. */
export function parseRegistryCatalogManifestBytes(
  bytes: string | Uint8Array,
  field: string,
): RegistryCatalogManifestV1 {
  return parseRegistryCatalogManifest(
    parseStrictJson(
      bytes,
      field,
      REGISTRY_CATALOG_LIMITS.maximumBytes,
      REGISTRY_CATALOG_LIMITS.maximumDepth,
    ),
    field,
  );
}

/** Projects one release's catalog record for the release compiler. */
export function projectRegistryReleaseCatalog(
  manifest: RegistryCatalogManifestV1,
  release: RegistryCatalogReleaseV1,
): RegistryReleaseCatalogV1 {
  return {
    display_name: manifest.display_name,
    description: manifest.description,
    domains: manifest.domains,
    tags: manifest.tags,
    state: release.state,
    runtime_range: release.runtime_range,
  };
}

function parseCatalogRelease(value: unknown, field: string): RegistryCatalogReleaseV1 {
  const record = parseExactRecord(value, field, REGISTRY_CATALOG_RELEASE_KEYS);
  parseRegistryReleaseSourcePath(record.source, `${field}.source`);
  return {
    source: record.source as string,
    state: parseRegistryReleaseState(record.state, `${field}.state`),
    runtime_range: parseRuntimeRange(record.runtime_range, `${field}.runtime_range`),
  };
}

function parseNonEmptyString(value: unknown, field: string, maximumBytes: number): string {
  const parsed = parseString(value, field, maximumBytes);
  if (parsed.length === 0) throw new PublicContractError(field, 'must not be empty');
  return parsed;
}

function parseUniqueStringList(value: unknown, field: string, maximumItems: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new PublicContractError(field, `must be an array with at most ${maximumItems} items`);
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = parseNonEmptyString(
      entry,
      `${field}[${index}]`,
      REGISTRY_CATALOG_LIMITS.maximumListEntryBytes,
    );
    if (result.includes(parsed)) {
      throw new PublicContractError(`${field}[${index}]`, 'must not contain duplicates');
    }
    result.push(parsed);
  }
  return result;
}
