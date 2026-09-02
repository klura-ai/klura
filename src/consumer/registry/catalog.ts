import {
  parseExactRecord,
  parseCapabilityId,
  parseInteger,
  parsePackageId,
  parsePackageVersion,
  parseSha256Digest,
  parseString,
  PublicContractError,
  type CapabilityIdV1,
  type PackageIdV1,
  type PackageVersionV1,
  type RuntimeRangeV1,
  type Sha256DigestV1,
  type StableContractIdV1,
} from '../../public/contracts/common';
import { calculateCollectionContractDigest } from '../../public/contracts/collection';
import { canonicalJson, parseStrictJson, type JsonValueV1 } from '../../public/contracts/json';
import type { JsonSchemaV1 } from '../../public/contracts/json-schema';
import type { OutcomeClassV1 } from '../../public/contracts/outcome';
import {
  getPublicCapabilityTransports,
  type PublicReadCapabilityV1,
  type PublicToolPackageV1,
} from '../../public/contracts/package';
import type {
  RegistryCapabilityV1,
  RegistryPackageV1,
  RegistryPackageVersionV1,
  RegistryTransportV1,
} from '../../public/contracts/registry-index';
import type { ScrapeRunPolicyV1 } from '../../public/contracts/scrape-policy';
import {
  PackageDownloadError,
  RegistryClientError,
  RegistryClientV1,
  type VerifiedRegistryIndexV1,
} from './client';
import { parseVerifiedRegistryPackage } from './package-verification';

const SEARCH_QUERY_BYTES_V1 = 512;
const SEARCH_CURSOR_BYTES_V1 = 1_024;
const SEARCH_PAGE_DEFAULT_V1 = 20;
const SEARCH_PAGE_MAXIMUM_V1 = 50;

export interface SearchRegistryPackagesInputV1 {
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface CatalogCapabilitySummaryV1 {
  capability: CapabilityIdV1;
  description: string;
  run_supported: boolean;
  transports: RegistryTransportV1[];
}

export interface CatalogPackageSummaryV1 {
  package_id: PackageIdV1;
  display_name: string;
  description: string;
  domains: string[];
  tags: string[];
  stable_version: PackageVersionV1;
  capabilities: CatalogCapabilitySummaryV1[];
}

export interface SearchRegistryPackagesResultV1 {
  index_digest: Sha256DigestV1;
  query: string;
  items: CatalogPackageSummaryV1[];
  next_cursor: string | null;
}

export interface ShowRegistryPackageInputV1 {
  package_id: PackageIdV1;
  version?: PackageVersionV1;
  capability?: CapabilityIdV1;
}

export interface CatalogPackageIdentityV1 {
  package_id: PackageIdV1;
  display_name: string;
  description: string;
  domains: string[];
  tags: string[];
  stable_version: PackageVersionV1;
}

export interface CatalogPackageArtifactV1 {
  package_digest: Sha256DigestV1;
  manifest_digest: Sha256DigestV1;
  runtime_range: RuntimeRangeV1;
}

export interface CatalogCapabilityDetailV1 {
  summary: CatalogCapabilitySummaryV1;
  visibility: 'public';
  authentication: PublicReadCapabilityV1['authentication'];
  request_origins: string[];
  navigation_origins: string[];
  input_schema: JsonSchemaV1;
  max_target_requests_per_call: number;
  max_encoded_outcome_bytes: number;
  call_timeouts: PublicReadCapabilityV1['call_timeouts'];
  outcomes: Array<{
    outcome_id: StableContractIdV1;
    class: OutcomeClassV1;
    output_schema: JsonSchemaV1 | null;
  }>;
  collection: null | {
    collection_contract_digest: Sha256DigestV1;
    input_mode_ids: StableContractIdV1[];
    item_schema: JsonSchemaV1;
    output_formats: Array<'json' | 'ndjson' | 'csv'>;
    semantic_stop_ids: StableContractIdV1[];
    run_policy: ScrapeRunPolicyV1;
  };
}

export type ShowRegistryPackageResultV1 =
  | {
      kind: 'package_detail';
      index_digest: Sha256DigestV1;
      package: CatalogPackageSummaryV1;
      selected_version: PackageVersionV1;
      version_state: 'installable' | 'withdrawn';
      artifact: CatalogPackageArtifactV1;
    }
  | {
      kind: 'capability_detail';
      index_digest: Sha256DigestV1;
      package: CatalogPackageIdentityV1;
      selected_version: PackageVersionV1;
      version_state: 'installable' | 'withdrawn';
      artifact: CatalogPackageArtifactV1;
      capability: CatalogCapabilityDetailV1;
    };

export class RegistryCatalogError extends PublicContractError {
  constructor(
    public readonly code:
      | 'invalid_options'
      | 'registry_unavailable'
      | 'registry_invalid'
      | 'cursor_invalid'
      | 'cursor_stale'
      | 'package_not_found'
      | 'version_not_found'
      | 'capability_not_found'
      | 'package_download_failed'
      | 'package_invalid',
    message: string,
  ) {
    super('registry_catalog', message);
    this.name = 'RegistryCatalogError';
  }
}

interface SearchCursorV1 {
  schema_version: 1;
  operation: 'search';
  query: string;
  source_digest: Sha256DigestV1;
  last_package_id: PackageIdV1;
}

/** Projects the verified signed registry into a deterministic local catalog. */
export class RegistryCatalogV1 {
  constructor(private readonly registry: RegistryClientV1) {}

  async search(
    input: SearchRegistryPackagesInputV1 = {},
    now = new Date(),
  ): Promise<SearchRegistryPackagesResultV1> {
    const query = parseSearchQuery(input.query);
    const limit = parseSearchLimit(input.limit);
    const cursor = parseSearchCursor(input.cursor, query);
    const verified =
      cursor === null
        ? await this.resolveFirstPageIndex(now)
        : this.resolveCursorIndex(cursor.source_digest, now);
    const packages = Object.values(verified.signed_index.payload.packages)
      .filter((candidate) => matchesSearch(candidate, query))
      .sort((left, right) => compareAscii(left.package_id, right.package_id));
    if (
      cursor !== null &&
      !packages.some((candidate) => candidate.package_id === cursor.last_package_id)
    ) {
      throw new RegistryCatalogError(
        'cursor_invalid',
        'the cursor sort key does not bind this result set',
      );
    }
    const firstIndex = cursor === null ? 0 : firstIndexAfter(packages, cursor.last_package_id);
    const items = packages
      .slice(firstIndex, firstIndex + limit)
      .map((candidate) => projectPackageSummary(candidate));
    const last = items.at(-1);
    const hasMore = firstIndex + items.length < packages.length;
    return {
      index_digest: verified.source_digest,
      query,
      items,
      next_cursor:
        hasMore && last !== undefined
          ? encodeSearchCursor({
              schema_version: 1,
              operation: 'search',
              query,
              source_digest: verified.source_digest,
              last_package_id: last.package_id,
            })
          : null,
    };
  }

  async show(input: unknown, now = new Date()): Promise<ShowRegistryPackageResultV1> {
    const selector = parseShowInput(input);
    const verified = await this.resolveFirstPageIndex(now);
    const indexedPackage = verified.signed_index.payload.packages[selector.package_id];
    if (indexedPackage === undefined) {
      throw new RegistryCatalogError(
        'package_not_found',
        'selected package is absent from the registry',
      );
    }
    const selectedVersion = selector.version ?? indexedPackage.stable_version;
    const indexedVersion = indexedPackage.versions[selectedVersion];
    if (indexedVersion === undefined) {
      throw new RegistryCatalogError(
        'version_not_found',
        'selected version is absent from the registry',
      );
    }
    const publicPackage = await this.downloadVerifiedPackage(selector.package_id, indexedVersion);
    const artifact = projectArtifact(indexedVersion);
    if (selector.capability === undefined) {
      return {
        kind: 'package_detail',
        index_digest: verified.source_digest,
        package: projectPackageSummary(indexedPackage),
        selected_version: selectedVersion,
        version_state: indexedVersion.state,
        artifact,
      };
    }
    const capability = publicPackage.capabilities[selector.capability];
    if (capability === undefined || capability.visibility !== 'public') {
      throw new RegistryCatalogError(
        'capability_not_found',
        'selected capability is absent from the selected package version',
      );
    }
    return {
      kind: 'capability_detail',
      index_digest: verified.source_digest,
      package: projectPackageIdentity(indexedPackage),
      selected_version: selectedVersion,
      version_state: indexedVersion.state,
      artifact,
      capability: projectCapabilityDetail(selector.capability, capability),
    };
  }

  private async resolveFirstPageIndex(now: Date): Promise<VerifiedRegistryIndexV1> {
    try {
      return await this.registry.refresh(now);
    } catch (error) {
      if (!(error instanceof RegistryClientError)) throw error;
      const cached = this.registry.inspectCache(now);
      if (cached.kind === 'ok') return cached.verified;
      if (cached.kind === 'invalid_schema' || cached.kind === 'invalid_signature') {
        throw new RegistryCatalogError('registry_invalid', cached.error.message);
      }
      if (cached.kind === 'not_yet_valid') {
        throw new RegistryCatalogError('registry_invalid', cached.error.message);
      }
      if (cached.kind === 'expired') {
        throw new RegistryCatalogError('registry_unavailable', cached.error.message);
      }
      throw new RegistryCatalogError(error.code, error.message);
    }
  }

  private async downloadVerifiedPackage(
    packageId: PackageIdV1,
    indexedVersion: RegistryPackageVersionV1,
  ): Promise<PublicToolPackageV1> {
    let bytes: Buffer;
    try {
      bytes = await this.registry.downloadPackage(indexedVersion);
    } catch (error) {
      if (error instanceof PackageDownloadError) {
        throw new RegistryCatalogError('package_download_failed', error.message);
      }
      throw error;
    }
    try {
      return parseVerifiedRegistryPackage(bytes, packageId, indexedVersion);
    } catch (error) {
      throw new RegistryCatalogError('package_invalid', asError(error).message);
    }
  }

  private resolveCursorIndex(sourceDigest: Sha256DigestV1, now: Date): VerifiedRegistryIndexV1 {
    const cached = this.registry.inspectCache(now);
    switch (cached.kind) {
      case 'missing':
        throw new RegistryCatalogError('cursor_stale', 'the cursor index is no longer cached');
      case 'invalid_schema':
      case 'invalid_signature':
      case 'not_yet_valid':
        throw new RegistryCatalogError('registry_invalid', cached.error.message);
      case 'expired':
        throw new RegistryCatalogError('registry_unavailable', cached.error.message);
      case 'ok':
        if (cached.verified.source_digest !== sourceDigest) {
          throw new RegistryCatalogError('cursor_stale', 'the cursor index is no longer cached');
        }
        return cached.verified;
    }
  }
}

function parseSearchQuery(value: unknown): string {
  if (value === undefined) return '';
  try {
    return normalizeSearchText(parseString(value, 'search.query', SEARCH_QUERY_BYTES_V1))
      .split(/\p{White_Space}+/u)
      .filter((token) => token.length > 0)
      .join(' ');
  } catch (error) {
    throw new RegistryCatalogError('invalid_options', asError(error).message);
  }
}

function parseSearchLimit(value: unknown): number {
  if (value === undefined) return SEARCH_PAGE_DEFAULT_V1;
  try {
    return parseInteger(value, 'search.limit', 1, SEARCH_PAGE_MAXIMUM_V1);
  } catch (error) {
    throw new RegistryCatalogError('invalid_options', asError(error).message);
  }
}

function parseSearchCursor(value: unknown, query: string): SearchCursorV1 | null {
  if (value === undefined) return null;
  try {
    const encoded = parseString(value, 'search.cursor', SEARCH_CURSOR_BYTES_V1);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
      throw new PublicContractError('search.cursor', 'must be unpadded base64url');
    }
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) {
      throw new PublicContractError('search.cursor', 'must be canonical base64url');
    }
    const parsed = parseStrictJson(decoded, 'search.cursor', SEARCH_CURSOR_BYTES_V1, 4);
    const cursor = parseExactRecord(parsed, 'search.cursor', [
      'schema_version',
      'operation',
      'query',
      'source_digest',
      'last_package_id',
    ]);
    if (parseInteger(cursor.schema_version, 'search.cursor.schema_version', 1, 1) !== 1) {
      throw new PublicContractError('search.cursor.schema_version', 'must be 1');
    }
    if (cursor.operation !== 'search') {
      throw new PublicContractError('search.cursor.operation', 'must be "search"');
    }
    const cursorQuery = normalizeSearchText(
      parseString(cursor.query, 'search.cursor.query', SEARCH_QUERY_BYTES_V1),
    )
      .split(/\p{White_Space}+/u)
      .filter((token) => token.length > 0)
      .join(' ');
    if (cursor.query !== cursorQuery) {
      throw new PublicContractError('search.cursor.query', 'must be the canonical query');
    }
    if (cursorQuery !== query) {
      throw new PublicContractError('search.cursor.query', 'does not bind this query');
    }
    return {
      schema_version: 1,
      operation: 'search',
      query: cursorQuery,
      source_digest: parseSha256Digest(cursor.source_digest, 'search.cursor.source_digest'),
      last_package_id: parsePackageId(cursor.last_package_id, 'search.cursor.last_package_id'),
    };
  } catch (error) {
    if (error instanceof RegistryCatalogError) throw error;
    throw new RegistryCatalogError('cursor_invalid', asError(error).message);
  }
}

function encodeSearchCursor(cursor: SearchCursorV1): string {
  return Buffer.from(canonicalJson(cursor as unknown as JsonValueV1), 'utf8').toString('base64url');
}

function matchesSearch(candidate: RegistryPackageV1, query: string): boolean {
  const tokens = query === '' ? [] : query.split(' ');
  const fields = [
    candidate.package_id,
    candidate.display_name,
    candidate.description,
    ...candidate.domains,
    ...candidate.tags,
    ...Object.entries(candidate.versions[candidate.stable_version]?.capabilities ?? {}).flatMap(
      ([capabilityId, capability]) => [capabilityId, capability.description],
    ),
  ].map(normalizeSearchText);
  return tokens.every((token) => fields.some((field) => field.includes(token)));
}

function projectPackageSummary(candidate: RegistryPackageV1): CatalogPackageSummaryV1 {
  const stable = candidate.versions[candidate.stable_version];
  if (stable === undefined) {
    throw new RegistryCatalogError(
      'registry_invalid',
      'stable version is absent from a verified package',
    );
  }
  return {
    package_id: candidate.package_id,
    display_name: candidate.display_name,
    description: candidate.description,
    domains: [...candidate.domains],
    tags: [...candidate.tags],
    stable_version: candidate.stable_version,
    capabilities: Object.entries(stable.capabilities)
      .sort(([left], [right]) => compareAscii(left, right))
      .map(([capability, value]) => projectCapabilitySummary(capability as CapabilityIdV1, value)),
  };
}

function projectPackageIdentity(candidate: RegistryPackageV1): CatalogPackageIdentityV1 {
  return {
    package_id: candidate.package_id,
    display_name: candidate.display_name,
    description: candidate.description,
    domains: [...candidate.domains],
    tags: [...candidate.tags],
    stable_version: candidate.stable_version,
  };
}

function projectCapabilitySummary(
  capability: CapabilityIdV1,
  value: RegistryCapabilityV1,
): CatalogCapabilitySummaryV1 {
  return {
    capability,
    description: value.description,
    run_supported: value.run_supported,
    transports: [...value.transports],
  };
}

function projectArtifact(version: RegistryPackageVersionV1): CatalogPackageArtifactV1 {
  return {
    package_digest: version.package_digest,
    manifest_digest: version.manifest_digest,
    runtime_range: version.runtime_range,
  };
}

function projectCapabilityDetail(
  capabilityId: CapabilityIdV1,
  capability: PublicReadCapabilityV1,
): CatalogCapabilityDetailV1 {
  const collection = capability.collection;
  return {
    summary: projectCapabilitySummary(capabilityId, {
      description: capability.description,
      run_supported: collection !== null,
      transports: getPublicCapabilityTransports(capability),
    }),
    visibility: 'public',
    authentication: capability.authentication,
    request_origins: [...capability.request_origins],
    navigation_origins: [...capability.navigation_origins],
    input_schema: capability.input_schema,
    max_target_requests_per_call: capability.max_target_requests_per_call,
    max_encoded_outcome_bytes: capability.max_encoded_outcome_bytes,
    call_timeouts: capability.call_timeouts,
    outcomes: capability.outcomes.map((outcome) => ({
      outcome_id: outcome.outcome_id,
      class: outcome.class,
      output_schema: outcome.output_schema,
    })),
    collection:
      collection === null
        ? null
        : {
            collection_contract_digest: calculateCollectionContractDigest(collection),
            input_mode_ids: collection.input_modes.modes.map((mode) => mode.id),
            item_schema: collection.item_schema,
            output_formats:
              collection.csv_columns === null ? ['json', 'ndjson'] : ['json', 'ndjson', 'csv'],
            semantic_stop_ids: collection.semantic_stops.map((stop) => stop.id),
            run_policy: collection.run_policy,
          },
  };
}

function parseShowInput(input: unknown): ShowRegistryPackageInputV1 {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new PublicContractError('show', 'must be an object');
    }
    const record = input as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'package_id' && key !== 'version' && key !== 'capability') {
        throw new PublicContractError(`show.${key}`, 'is not allowed');
      }
    }
    if (!Object.hasOwn(record, 'package_id')) {
      throw new PublicContractError('show', 'is missing required key "package_id"');
    }
    return {
      package_id: parsePackageId(record.package_id, 'show.package_id'),
      version:
        record.version === undefined
          ? undefined
          : parsePackageVersion(record.version, 'show.version'),
      capability:
        record.capability === undefined
          ? undefined
          : parseCapabilityId(record.capability, 'show.capability'),
    };
  } catch (error) {
    throw new RegistryCatalogError('invalid_options', asError(error).message);
  }
}

function firstIndexAfter(packages: RegistryPackageV1[], lastPackageId: PackageIdV1): number {
  for (let index = 0; index < packages.length; index += 1) {
    const candidate = packages[index];
    if (candidate !== undefined && compareAscii(candidate.package_id, lastPackageId) > 0)
      return index;
  }
  return packages.length;
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

function compareAscii(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
