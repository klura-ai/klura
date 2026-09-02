import {
  assertMapKey,
  parseBase64Url,
  parseBoundedRecord,
  parseCapabilityId,
  parseExactRecord,
  parseInteger,
  parsePackageId,
  parsePackageVersion,
  parseRfc3339Instant,
  parseRuntimeRange,
  parseSha256Digest,
  parseString,
  PUBLIC_CONTRACT_LIMITS,
  PublicContractError,
  type CapabilityIdV1,
  type PackageIdV1,
  type PackageVersionV1,
  type Rfc3339InstantV1,
  type RuntimeRangeV1,
  type Sha256DigestV1,
} from './common';
import { assertJsonValue } from './json';

export const REGISTRY_SCHEMA_VERSION_V1 = 1;
export const REGISTRY_KEY_ID_V1 = 'registry-v1';

export type RegistryTransportV1 =
  | 'http_node'
  | 'http_browser'
  | 'browser_navigation'
  | 'browser_page_script';

export interface RegistryCapabilityV1 {
  description: string;
  run_supported: boolean;
  transports: RegistryTransportV1[];
}

export interface RegistryPackageVersionV1 {
  version: PackageVersionV1;
  state: 'installable' | 'withdrawn';
  package_url: string;
  package_bytes: number;
  package_digest: Sha256DigestV1;
  manifest_digest: Sha256DigestV1;
  runtime_range: RuntimeRangeV1;
  capabilities: Record<CapabilityIdV1, RegistryCapabilityV1>;
}

export interface RegistryPackageV1 {
  package_id: PackageIdV1;
  display_name: string;
  description: string;
  domains: string[];
  tags: string[];
  stable_version: PackageVersionV1;
  versions: Record<PackageVersionV1, RegistryPackageVersionV1>;
}

export interface RegistryIndexV1 {
  registry_schema_version: 1;
  generated_at: Rfc3339InstantV1;
  expires_at: Rfc3339InstantV1;
  packages: Record<PackageIdV1, RegistryPackageV1>;
}

export interface SignedRegistryIndexV1 {
  envelope_schema_version: 1;
  payload: RegistryIndexV1;
  signature: {
    algorithm: 'ed25519';
    key_id: 'registry-v1';
    value: string;
  };
}

const TRANSPORTS = new Set<RegistryTransportV1>([
  'http_node',
  'http_browser',
  'browser_navigation',
  'browser_page_script',
]);

export function parseSignedRegistryIndex(value: unknown): SignedRegistryIndexV1 {
  assertJsonValue(value, 'signed_index', PUBLIC_CONTRACT_LIMITS.maxDepth);
  const envelope = parseExactRecord(value, 'signed_index', [
    'envelope_schema_version',
    'payload',
    'signature',
  ]);
  if (
    parseInteger(envelope.envelope_schema_version, 'signed_index.envelope_schema_version', 1, 1) !==
    1
  ) {
    throw new PublicContractError('signed_index.envelope_schema_version', 'must be 1');
  }
  const signature = parseExactRecord(envelope.signature, 'signed_index.signature', [
    'algorithm',
    'key_id',
    'value',
  ]);
  if (signature.algorithm !== 'ed25519') {
    throw new PublicContractError('signed_index.signature.algorithm', 'must be "ed25519"');
  }
  if (signature.key_id !== REGISTRY_KEY_ID_V1) {
    throw new PublicContractError(
      'signed_index.signature.key_id',
      `must be ${JSON.stringify(REGISTRY_KEY_ID_V1)}`,
    );
  }
  const parsed = {
    envelope_schema_version: 1 as const,
    payload: parseRegistryIndex(envelope.payload),
    signature: {
      algorithm: 'ed25519' as const,
      key_id: REGISTRY_KEY_ID_V1 as 'registry-v1',
      value: parseBase64Url(signature.value, 'signed_index.signature.value'),
    },
  };
  return parsed;
}

export function parseRegistryIndex(value: unknown): RegistryIndexV1 {
  const index = parseExactRecord(value, 'signed_index.payload', [
    'registry_schema_version',
    'generated_at',
    'expires_at',
    'packages',
  ]);
  if (
    parseInteger(
      index.registry_schema_version,
      'signed_index.payload.registry_schema_version',
      1,
      1,
    ) !== 1
  ) {
    throw new PublicContractError('signed_index.payload.registry_schema_version', 'must be 1');
  }
  const generatedAt = parseRfc3339Instant(index.generated_at, 'signed_index.payload.generated_at');
  const expiresAt = parseRfc3339Instant(index.expires_at, 'signed_index.payload.expires_at');
  const generatedTimestamp = Date.parse(generatedAt);
  const expiresTimestamp = Date.parse(expiresAt);
  if (generatedTimestamp >= expiresTimestamp) {
    throw new PublicContractError(
      'signed_index.payload',
      'generated_at must be earlier than expires_at',
    );
  }
  if (expiresTimestamp - generatedTimestamp > 7 * 24 * 60 * 60 * 1000) {
    throw new PublicContractError(
      'signed_index.payload',
      'validity window must not exceed seven days',
    );
  }
  const packages = parseBoundedRecord(
    index.packages,
    'signed_index.payload.packages',
    PUBLIC_CONTRACT_LIMITS.maxIndexPackages,
  );
  const parsedPackages: Record<PackageIdV1, RegistryPackageV1> = {} as Record<
    PackageIdV1,
    RegistryPackageV1
  >;
  for (const [key, packageValue] of Object.entries(packages)) {
    const packageId = parsePackageId(key, `signed_index.payload.packages.${key}`);
    const parsedPackage = parseRegistryPackage(
      packageValue,
      `signed_index.payload.packages.${key}`,
    );
    assertMapKey(key, parsedPackage.package_id, `signed_index.payload.packages.${key}`);
    parsedPackages[packageId] = parsedPackage;
  }
  return {
    registry_schema_version: REGISTRY_SCHEMA_VERSION_V1,
    generated_at: generatedAt,
    expires_at: expiresAt,
    packages: parsedPackages,
  };
}

function parseRegistryPackage(value: unknown, field: string): RegistryPackageV1 {
  const record = parseExactRecord(value, field, [
    'package_id',
    'display_name',
    'description',
    'domains',
    'tags',
    'stable_version',
    'versions',
  ]);
  const packageId = parsePackageId(record.package_id, `${field}.package_id`);
  const versionsRecord = parseBoundedRecord(
    record.versions,
    `${field}.versions`,
    PUBLIC_CONTRACT_LIMITS.maxPackageVersions,
  );
  const versions: Record<PackageVersionV1, RegistryPackageVersionV1> = {} as Record<
    PackageVersionV1,
    RegistryPackageVersionV1
  >;
  for (const [key, versionValue] of Object.entries(versionsRecord)) {
    const version = parsePackageVersion(key, `${field}.versions.${key}`);
    const parsedVersion = parseRegistryPackageVersion(versionValue, `${field}.versions.${key}`);
    assertMapKey(key, parsedVersion.version, `${field}.versions.${key}`);
    versions[version] = parsedVersion;
  }
  const stableVersion = parsePackageVersion(record.stable_version, `${field}.stable_version`);
  const stable = versions[stableVersion];
  if (!stable || stable.state !== 'installable') {
    throw new PublicContractError(
      `${field}.stable_version`,
      'must identify an installable published version',
    );
  }
  return {
    package_id: packageId,
    display_name: parseNonEmptyString(record.display_name, `${field}.display_name`, 160),
    description: parseString(record.description, `${field}.description`, 512),
    domains: parseUniqueStringList(
      record.domains,
      `${field}.domains`,
      PUBLIC_CONTRACT_LIMITS.maxPackageDomains,
      128,
    ),
    tags: parseUniqueStringList(
      record.tags,
      `${field}.tags`,
      PUBLIC_CONTRACT_LIMITS.maxPackageTags,
      128,
    ),
    stable_version: stableVersion,
    versions,
  };
}

function parseRegistryPackageVersion(value: unknown, field: string): RegistryPackageVersionV1 {
  const record = parseExactRecord(value, field, [
    'version',
    'state',
    'package_url',
    'package_bytes',
    'package_digest',
    'manifest_digest',
    'runtime_range',
    'capabilities',
  ]);
  if (record.state !== 'installable' && record.state !== 'withdrawn') {
    throw new PublicContractError(`${field}.state`, 'must be "installable" or "withdrawn"');
  }
  const capabilitiesRecord = parseBoundedRecord(
    record.capabilities,
    `${field}.capabilities`,
    PUBLIC_CONTRACT_LIMITS.maxPackageCapabilities,
  );
  const capabilities: Record<CapabilityIdV1, RegistryCapabilityV1> = {} as Record<
    CapabilityIdV1,
    RegistryCapabilityV1
  >;
  for (const [key, capabilityValue] of Object.entries(capabilitiesRecord)) {
    const capabilityId = parseCapabilityId(key, `${field}.capabilities.${key}`);
    capabilities[capabilityId] = parseRegistryCapability(
      capabilityValue,
      `${field}.capabilities.${key}`,
    );
  }
  return {
    version: parsePackageVersion(record.version, `${field}.version`),
    state: record.state,
    package_url: parseHttpUrl(record.package_url, `${field}.package_url`),
    package_bytes: parseInteger(
      record.package_bytes,
      `${field}.package_bytes`,
      1,
      PUBLIC_CONTRACT_LIMITS.packageBytes,
    ),
    package_digest: parseSha256Digest(record.package_digest, `${field}.package_digest`),
    manifest_digest: parseSha256Digest(record.manifest_digest, `${field}.manifest_digest`),
    runtime_range: parseRuntimeRange(record.runtime_range, `${field}.runtime_range`),
    capabilities,
  };
}

function parseRegistryCapability(value: unknown, field: string): RegistryCapabilityV1 {
  const record = parseExactRecord(value, field, ['description', 'run_supported', 'transports']);
  if (typeof record.run_supported !== 'boolean') {
    throw new PublicContractError(`${field}.run_supported`, 'must be a boolean');
  }
  if (
    !Array.isArray(record.transports) ||
    record.transports.length === 0 ||
    record.transports.length > 4
  ) {
    throw new PublicContractError(`${field}.transports`, 'must contain one to four transports');
  }
  const transports: RegistryTransportV1[] = [];
  for (const [index, transport] of record.transports.entries()) {
    if (typeof transport !== 'string' || !TRANSPORTS.has(transport as RegistryTransportV1)) {
      throw new PublicContractError(
        `${field}.transports[${index}]`,
        'must be a supported transport',
      );
    }
    if (transports.includes(transport as RegistryTransportV1)) {
      throw new PublicContractError(`${field}.transports[${index}]`, 'must not contain duplicates');
    }
    transports.push(transport as RegistryTransportV1);
  }
  return {
    description: parseString(record.description, `${field}.description`, 256),
    run_supported: record.run_supported,
    transports,
  };
}

function parseUniqueStringList(
  value: unknown,
  field: string,
  maximumItems: number,
  maximumBytes: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new PublicContractError(field, `must be an array with at most ${maximumItems} items`);
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = parseNonEmptyString(entry, `${field}[${index}]`, maximumBytes);
    if (result.includes(parsed))
      throw new PublicContractError(`${field}[${index}]`, 'must not contain duplicates');
    result.push(parsed);
  }
  return result;
}

function parseNonEmptyString(value: unknown, field: string, maximumBytes: number): string {
  const parsed = parseString(value, field, maximumBytes);
  if (parsed.length === 0) throw new PublicContractError(field, 'must not be empty');
  return parsed;
}

function parseHttpUrl(value: unknown, field: string): string {
  const text = parseString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new PublicContractError(field, 'must be an absolute HTTP(S) URL');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new PublicContractError(
      field,
      'must be an absolute HTTP(S) URL without credentials or fragment',
    );
  }
  return text;
}
