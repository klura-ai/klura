import { createHash } from 'node:crypto';

declare const brand: unique symbol;

export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type PackageIdV1 = Brand<string, 'PackageIdV1'>;
export type PackageVersionV1 = Brand<string, 'PackageVersionV1'>;
export type CapabilityIdV1 = Brand<string, 'CapabilityIdV1'>;
export type StableContractIdV1 = Brand<string, 'StableContractIdV1'>;
export type SessionNameV1 = Brand<string, 'SessionNameV1'>;
export type OutputPathV1 = Brand<string, 'OutputPathV1'>;
export type Sha256DigestV1 = Brand<string, 'Sha256DigestV1'>;
export type Rfc3339InstantV1 = Brand<string, 'Rfc3339InstantV1'>;
export type JsonPointerV1 = Brand<string, 'JsonPointerV1'>;

export const PUBLIC_CONTRACT_LIMITS = {
  identifierBytes: 64,
  outputPathBytes: 4_096,
  indexBytes: 16 * 1024 * 1024,
  packageBytes: 8 * 1024 * 1024,
  maxIndexPackages: 10_000,
  maxPackageVersions: 20,
  maxPackageCapabilities: 32,
  maxPackageDomains: 16,
  maxPackageTags: 32,
  maxDepth: 12,
  maxPackageDepth: 32,
  maxStringBytes: 2_048,
} as const;

export class PublicContractError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = 'PublicContractError';
  }
}

export interface RuntimeRangeV1 {
  minimum_inclusive: PackageVersionV1;
  maximum_exclusive: PackageVersionV1;
}

export function parsePackageId(value: unknown, field: string): PackageIdV1 {
  const text = parseAsciiString(value, field, PUBLIC_CONTRACT_LIMITS.identifierBytes);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(text)) {
    throw new PublicContractError(field, 'must be a canonical lowercase package id');
  }
  return text as PackageIdV1;
}

/** Package-id prefix reserved for locally authored, unsigned packages. A
 *  signed registry index can never carry an id under it, so provenance is
 *  visible in every surface the id reaches. */
export const LOCAL_PACKAGE_ID_PREFIX_V1 = 'local-';

/** True when a package id sits in the reserved local namespace. */
export function isLocalPackageId(value: string): boolean {
  return value.startsWith(LOCAL_PACKAGE_ID_PREFIX_V1);
}

/** Parses a package id that must sit in the reserved local namespace. */
export function parseLocalPackageId(value: unknown, field: string): PackageIdV1 {
  const packageId = parsePackageId(value, field);
  if (!isLocalPackageId(packageId)) {
    throw new PublicContractError(
      field,
      `must start with ${JSON.stringify(LOCAL_PACKAGE_ID_PREFIX_V1)}, the reserved prefix for locally authored packages`,
    );
  }
  return packageId;
}

/** Parses a package id a signed registry is allowed to name. The reserved
 *  local namespace is rejected here, so a local package is structurally
 *  unrepresentable in an index, a search page, or an install selector. */
export function parseRegistryPackageId(value: unknown, field: string): PackageIdV1 {
  const packageId = parsePackageId(value, field);
  if (isLocalPackageId(packageId)) {
    throw new PublicContractError(
      field,
      `must not start with ${JSON.stringify(LOCAL_PACKAGE_ID_PREFIX_V1)}, which is reserved for locally authored packages the registry never carries`,
    );
  }
  return packageId;
}

/** Derives the reserved package id of a locally authored platform skill. The
 *  derivation is mechanical so no caller can author an id of its own. */
export function localPackageIdForPlatform(platform: unknown, field: string): PackageIdV1 {
  const slug = parseAsciiString(platform, field, PUBLIC_CONTRACT_LIMITS.identifierBytes);
  const maximumSlugBytes =
    PUBLIC_CONTRACT_LIMITS.identifierBytes - LOCAL_PACKAGE_ID_PREFIX_V1.length;
  if (slug.length > maximumSlugBytes) {
    throw new PublicContractError(
      field,
      `must be at most ${maximumSlugBytes} characters so ${JSON.stringify(LOCAL_PACKAGE_ID_PREFIX_V1)} plus the platform fits a ${PUBLIC_CONTRACT_LIMITS.identifierBytes}-character package id`,
    );
  }
  return parseLocalPackageId(`${LOCAL_PACKAGE_ID_PREFIX_V1}${slug}`, field);
}

export function parseCapabilityId(value: unknown, field: string): CapabilityIdV1 {
  return parseStableIdentifier(value, field) as CapabilityIdV1;
}

export function parseStableContractId(value: unknown, field: string): StableContractIdV1 {
  return parseStableIdentifier(value, field) as StableContractIdV1;
}

export function parseSessionName(value: unknown, field: string): SessionNameV1 {
  const text = parseAsciiString(value, field, PUBLIC_CONTRACT_LIMITS.identifierBytes);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(text)) {
    throw new PublicContractError(field, 'must be a canonical path-safe session name');
  }
  return text as SessionNameV1;
}

export function parseOutputPath(value: unknown, field: string): OutputPathV1 {
  const text = parseString(value, field, PUBLIC_CONTRACT_LIMITS.outputPathBytes);
  if (text.includes('\0')) {
    throw new PublicContractError(field, 'must not contain a NUL byte');
  }
  return text as OutputPathV1;
}

export function parseJsonPointer(value: unknown, field: string): JsonPointerV1 {
  const text = parseString(value, field, 512);
  if (text.startsWith('#') || (text.length > 0 && !text.startsWith('/'))) {
    throw new PublicContractError(field, 'must be a canonical RFC 6901 JSON Pointer');
  }
  for (const token of text.split('/').slice(1)) {
    for (let index = 0; index < token.length; index += 1) {
      if (token[index] === '~' && token[index + 1] !== '0' && token[index + 1] !== '1') {
        throw new PublicContractError(field, 'must use only ~0 and ~1 pointer escapes');
      }
    }
  }
  return text as JsonPointerV1;
}

export function parseSha256Digest(value: unknown, field: string): Sha256DigestV1 {
  const text = parseAsciiString(value, field, 64);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new PublicContractError(field, 'must be exactly 64 lowercase hexadecimal characters');
  }
  return text as Sha256DigestV1;
}

/* eslint-disable sonarjs/regex-complexity -- SemVer is one closed validation rule. */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
/* eslint-enable sonarjs/regex-complexity */

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parsePackageVersion(value: unknown, field: string): PackageVersionV1 {
  const text = parseAsciiString(value, field, PUBLIC_CONTRACT_LIMITS.identifierBytes);
  if (!SEMVER_RE.test(text)) {
    throw new PublicContractError(field, 'must be canonical SemVer 2.0.0 without build metadata');
  }
  return text as PackageVersionV1;
}

export function comparePackageVersions(left: PackageVersionV1, right: PackageVersionV1): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined || bPart === undefined) {
      throw new PublicContractError('version', 'must be canonical SemVer 2.0.0');
    }
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric) return Number(aPart) < Number(bPart) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart < bPart ? -1 : 1;
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

export function parseRuntimeRange(value: unknown, field: string): RuntimeRangeV1 {
  const object = parseExactRecord(value, field, ['minimum_inclusive', 'maximum_exclusive']);
  const minimum = parsePackageVersion(object.minimum_inclusive, `${field}.minimum_inclusive`);
  const maximum = parsePackageVersion(object.maximum_exclusive, `${field}.maximum_exclusive`);
  if (comparePackageVersions(minimum, maximum) >= 0) {
    throw new PublicContractError(field, 'minimum_inclusive must be lower than maximum_exclusive');
  }
  return { minimum_inclusive: minimum, maximum_exclusive: maximum };
}

export function runtimeSupportsVersion(range: RuntimeRangeV1, version: PackageVersionV1): boolean {
  return (
    comparePackageVersions(range.minimum_inclusive, version) <= 0 &&
    comparePackageVersions(version, range.maximum_exclusive) < 0
  );
}

export function parseRfc3339Instant(value: unknown, field: string): Rfc3339InstantV1 {
  const text = parseAsciiString(value, field, 20);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text)) {
    throw new PublicContractError(field, 'must be a UTC RFC 3339 instant with second precision');
  }
  const timestamp = Date.parse(text);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== `${text.slice(0, -1)}.000Z`
  ) {
    throw new PublicContractError(field, 'must be a real UTC RFC 3339 instant');
  }
  return text as Rfc3339InstantV1;
}

export function parseBase64Url(value: unknown, field: string): string {
  const text = parseAsciiString(value, field, 16_384);
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) {
    throw new PublicContractError(field, 'must be unpadded base64url');
  }
  return text;
}

export function parseString(
  value: unknown,
  field: string,
  maxBytes: number = PUBLIC_CONTRACT_LIMITS.maxStringBytes,
): string {
  if (typeof value !== 'string') {
    throw new PublicContractError(field, 'must be a string');
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maxBytes) {
    throw new PublicContractError(field, `must be at most ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

export function parseHttpsOrigin(value: unknown, field: string): string {
  const text = parseString(value, field, PUBLIC_CONTRACT_LIMITS.maxStringBytes);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PublicContractError(field, 'must be an HTTPS origin');
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    text !== url.origin
  ) {
    throw new PublicContractError(
      field,
      'must be a canonical HTTPS origin without credentials or path',
    );
  }
  return url.origin;
}

export function parseAsciiString(value: unknown, field: string, maxBytes: number): string {
  const text = parseString(value, field, maxBytes);
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      throw new PublicContractError(field, 'must contain ASCII characters only');
    }
  }
  return text;
}

export function parseExactRecord(
  value: unknown,
  field: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!allowedKeys.includes(key)) {
      throw new PublicContractError(`${field}.${key}`, 'is not allowed');
    }
  }
  for (const key of allowedKeys) {
    if (!(key in object)) {
      throw new PublicContractError(field, `is missing required key ${JSON.stringify(key)}`);
    }
  }
  return object;
}

export function parseBoundedRecord(
  value: unknown,
  field: string,
  maximumEntries: number,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length > maximumEntries) {
    throw new PublicContractError(field, `must contain at most ${maximumEntries} entries`);
  }
  return object;
}

export function parseInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new PublicContractError(field, `must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function parseFiniteNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new PublicContractError(field, `must be a finite number from ${minimum} to ${maximum}`);
  }
  return value;
}

export function assertMapKey(key: string, embedded: string, field: string): void {
  if (key !== embedded) {
    throw new PublicContractError(field, 'map key must byte-equal its embedded identifier');
  }
}

export function sha256Digest(bytes: string | Uint8Array): Sha256DigestV1 {
  return createHash('sha256').update(bytes).digest('hex') as Sha256DigestV1;
}

function parseStableIdentifier(value: unknown, field: string): string {
  const text = parseAsciiString(value, field, PUBLIC_CONTRACT_LIMITS.identifierBytes);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(text)) {
    throw new PublicContractError(field, 'must be a canonical lowercase snake_case identifier');
  }
  return text;
}

function parseVersion(value: PackageVersionV1): ParsedVersion {
  const match = SEMVER_RE.exec(value);
  if (!match) {
    throw new PublicContractError('version', 'must be canonical SemVer 2.0.0');
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}
