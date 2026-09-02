import {
  parseExactRecord,
  parseInteger,
  parsePackageId,
  parseString,
  PublicContractError,
  type PackageIdV1,
} from '../public/contracts/common';
import { canonicalJson, parseStrictJson, type JsonValueV1 } from '../public/contracts/json';
import { PackageStoreV1, type InstalledPackageV1 } from './store/package-store';

const CURSOR_MAXIMUM_BYTES_V1 = 1_024;
const PAGE_DEFAULT_LIMIT_V1 = 25;
const PAGE_MAXIMUM_LIMIT_V1 = 100;
const ADAPTER_RESULT_MAXIMUM_BYTES_V1 = 20_480;

export interface ConsumerPageOptionsV1 {
  cursor?: string;
  limit?: number;
}

export interface InstalledPackageArtifactV1 {
  package_id: PackageIdV1;
  version: InstalledPackageV1['version'];
  package_digest: InstalledPackageV1['package_digest'];
  manifest_digest: InstalledPackageV1['manifest_digest'];
  provenance: InstalledPackageV1['provenance'];
  installed_at: InstalledPackageV1['installed_at'];
}

export interface ListInstalledPackagesSuccessV1 {
  result_schema_version: 1;
  kind: 'installed_packages';
  items: InstalledPackageArtifactV1[];
  next_cursor: string | null;
}

export interface ListInstalledPackagesFailureV1 {
  result_schema_version: 1;
  kind: 'consumer_failure';
  operation: 'list_installed';
  code:
    | 'invalid_options'
    | 'cursor_invalid'
    | 'local_state_invalid'
    | 'output_too_large_for_adapter';
  retryable: false;
  package_id: null;
}

export type ListInstalledPackagesResultV1 =
  | ListInstalledPackagesSuccessV1
  | ListInstalledPackagesFailureV1;

export interface RemovePackageSuccessV1 {
  result_schema_version: 1;
  kind: 'remove_result';
  action: 'removed' | 'not_installed';
  package_id: PackageIdV1;
  removed_active: InstalledPackageArtifactV1 | null;
}

export interface RemovePackageFailureV1 {
  result_schema_version: 1;
  kind: 'consumer_failure';
  operation: 'remove';
  code: 'invalid_options' | 'local_state_invalid';
  retryable: false;
  package_id: PackageIdV1 | null;
}

export type RemovePackageResultV1 = RemovePackageSuccessV1 | RemovePackageFailureV1;

interface InstalledPackagesCursorV1 {
  schema_version: 1;
  operation: 'installed_packages';
  last_package_id: PackageIdV1;
}

class LocalListingError extends PublicContractError {
  constructor(
    public readonly code: ListInstalledPackagesFailureV1['code'],
    message: string,
  ) {
    super('local_listing', message);
    this.name = 'LocalListingError';
  }
}

/** Projects local immutable installation state into bounded cursor pages. */
export class ConsumerLocalListingServiceV1 {
  constructor(private readonly store = new PackageStoreV1()) {}

  installed(input: unknown): ListInstalledPackagesResultV1 {
    try {
      const options = parsePageOptions(input);
      const cursor = parseInstalledCursor(options.cursor);
      const installed = Object.values(this.store.readInstalled().packages)
        .sort((left, right) => left.package_id.localeCompare(right.package_id))
        .filter((entry) => cursor === null || entry.package_id > cursor.last_package_id)
        .map(projectInstalledArtifact);
      return buildInstalledPage(installed, options.limit);
    } catch (error) {
      return listingFailure(error);
    }
  }

  remove(input: unknown): RemovePackageResultV1 {
    const packageId = knownPackageId(input);
    let selectedPackageId: PackageIdV1;
    try {
      const record = parseExactRecord(input, 'remove', ['package_id']);
      selectedPackageId = parsePackageId(record.package_id, 'remove.package_id');
    } catch {
      return {
        result_schema_version: 1,
        kind: 'consumer_failure',
        operation: 'remove',
        code: 'invalid_options',
        retryable: false,
        package_id: packageId,
      };
    }
    try {
      const removed = this.store.remove(selectedPackageId);
      return {
        result_schema_version: 1,
        kind: 'remove_result',
        action: removed.removed ? 'removed' : 'not_installed',
        package_id: selectedPackageId,
        removed_active:
          removed.removed_active === null ? null : projectInstalledArtifact(removed.removed_active),
      };
    } catch {
      return {
        result_schema_version: 1,
        kind: 'consumer_failure',
        operation: 'remove',
        code: 'local_state_invalid',
        retryable: false,
        package_id: selectedPackageId,
      };
    }
  }
}

function parsePageOptions(input: unknown): { cursor?: string; limit: number } {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new PublicContractError('page', 'must be an object');
    }
    const record = input as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'cursor' && key !== 'limit') {
        throw new PublicContractError(`page.${key}`, 'is not allowed');
      }
    }
    return {
      cursor:
        record.cursor === undefined
          ? undefined
          : parseString(record.cursor, 'page.cursor', CURSOR_MAXIMUM_BYTES_V1),
      limit:
        record.limit === undefined
          ? PAGE_DEFAULT_LIMIT_V1
          : parseInteger(record.limit, 'page.limit', 1, PAGE_MAXIMUM_LIMIT_V1),
    };
  } catch (error) {
    throw new LocalListingError('invalid_options', errorMessage(error));
  }
}

function parseInstalledCursor(value: string | undefined): InstalledPackagesCursorV1 | null {
  if (value === undefined) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
      throw new PublicContractError('page.cursor', 'must be unpadded base64url');
    }
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) {
      throw new PublicContractError('page.cursor', 'must be canonical base64url');
    }
    const parsed = parseStrictJson(bytes, 'page.cursor', CURSOR_MAXIMUM_BYTES_V1, 4);
    const record = parseExactRecord(parsed, 'page.cursor', [
      'schema_version',
      'operation',
      'last_package_id',
    ]);
    if (parseInteger(record.schema_version, 'page.cursor.schema_version', 1, 1) !== 1) {
      throw new PublicContractError('page.cursor.schema_version', 'must be 1');
    }
    if (record.operation !== 'installed_packages') {
      throw new PublicContractError('page.cursor.operation', 'must be "installed_packages"');
    }
    return {
      schema_version: 1,
      operation: 'installed_packages',
      last_package_id: parsePackageId(record.last_package_id, 'page.cursor.last_package_id'),
    };
  } catch (error) {
    throw new LocalListingError('cursor_invalid', errorMessage(error));
  }
}

function buildInstalledPage(
  available: InstalledPackageArtifactV1[],
  requestedLimit: number,
): ListInstalledPackagesSuccessV1 {
  const items: InstalledPackageArtifactV1[] = [];
  for (const candidate of available) {
    if (items.length === requestedLimit) break;
    const candidateItems = [...items, candidate];
    const hasMore = candidateItems.length < available.length;
    const candidateCursor = hasMore ? encodeInstalledCursor(candidate.package_id) : null;
    const candidatePage: ListInstalledPackagesSuccessV1 = {
      result_schema_version: 1,
      kind: 'installed_packages',
      items: candidateItems,
      next_cursor: candidateCursor,
    };
    if (
      Buffer.byteLength(canonicalJson(candidatePage as unknown as JsonValueV1), 'utf8') >
      ADAPTER_RESULT_MAXIMUM_BYTES_V1
    ) {
      break;
    }
    items.push(candidate);
  }
  if (items.length === 0 && available.length > 0) {
    throw new LocalListingError(
      'output_too_large_for_adapter',
      'one installed package cannot fit the adapter result limit',
    );
  }
  const hasMore = items.length < available.length;
  const last = items.at(-1);
  let nextCursor: string | null = null;
  if (hasMore) {
    if (last === undefined) {
      throw new LocalListingError(
        'local_state_invalid',
        'page cursor is absent after a non-empty page',
      );
    }
    nextCursor = encodeInstalledCursor(last.package_id);
  }
  return {
    result_schema_version: 1,
    kind: 'installed_packages',
    items,
    next_cursor: nextCursor,
  };
}

function encodeInstalledCursor(packageId: PackageIdV1): string {
  const cursor: InstalledPackagesCursorV1 = {
    schema_version: 1,
    operation: 'installed_packages',
    last_package_id: packageId,
  };
  return Buffer.from(canonicalJson(cursor as unknown as JsonValueV1), 'utf8').toString('base64url');
}

function projectInstalledArtifact(entry: InstalledPackageV1): InstalledPackageArtifactV1 {
  return {
    package_id: entry.package_id,
    version: entry.version,
    package_digest: entry.package_digest,
    manifest_digest: entry.manifest_digest,
    provenance: entry.provenance,
    installed_at: entry.installed_at,
  };
}

function knownPackageId(input: unknown): PackageIdV1 | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  try {
    return parsePackageId((input as Record<string, unknown>).package_id, 'remove.package_id');
  } catch {
    return null;
  }
}

function listingFailure(error: unknown): ListInstalledPackagesFailureV1 {
  const code = error instanceof LocalListingError ? error.code : 'local_state_invalid';
  return {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation: 'list_installed',
    code,
    retryable: false,
    package_id: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
