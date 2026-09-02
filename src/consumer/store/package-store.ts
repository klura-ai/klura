import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertMapKey,
  parseBoundedRecord,
  parseExactRecord,
  parsePackageId,
  parsePackageVersion,
  parseRfc3339Instant,
  parseRuntimeRange,
  parseSha256Digest,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  sha256Digest,
  type PackageIdV1,
  type PackageVersionV1,
  type Rfc3339InstantV1,
  type RuntimeRangeV1,
  type Sha256DigestV1,
} from '../../public/contracts/common';
import { canonicalJson, parseStrictJson, type JsonValueV1 } from '../../public/contracts/json';
import { parsePublicToolPackage } from '../../public/contracts/package';

const INSTALLED_SCHEMA_VERSION_V1 = 1;
const INSTALLED_STATE_BYTES_V1 = 1024 * 1024;

export interface InstalledPackageV1 {
  package_id: PackageIdV1;
  version: PackageVersionV1;
  package_digest: Sha256DigestV1;
  manifest_digest: Sha256DigestV1;
  source_index_digest: Sha256DigestV1;
  runtime_range: RuntimeRangeV1;
  installed_at: Rfc3339InstantV1;
}

export interface InstalledStateV1 {
  installed_schema_version: 1;
  packages: Record<PackageIdV1, InstalledPackageV1>;
}

export interface PutVerifiedPackageInputV1 {
  package_id: PackageIdV1;
  version: PackageVersionV1;
  package_digest: Sha256DigestV1;
  manifest_digest: Sha256DigestV1;
  package_bytes: number;
  bytes: Uint8Array;
}

export interface PackageStorePathsV1 {
  home: string;
  packages: string;
  installed: string;
}

export class PackageStoreV1 {
  readonly paths: PackageStorePathsV1;

  constructor(home = defaultConsumerHome()) {
    this.paths = {
      home,
      packages: path.join(home, 'packages'),
      installed: path.join(home, 'installed.json'),
    };
  }

  putVerifiedPackage(input: PutVerifiedPackageInputV1): string {
    if (input.bytes.byteLength !== input.package_bytes) {
      throw new PublicContractError(
        'package_bytes',
        'does not equal downloaded package byte length',
      );
    }
    if (input.package_bytes < 1 || input.package_bytes > PUBLIC_CONTRACT_LIMITS.packageBytes) {
      throw new PublicContractError('package_bytes', 'is outside the public package byte limit');
    }
    if (sha256Digest(input.bytes) !== input.package_digest) {
      throw new PublicContractError('package_digest', 'does not match downloaded package bytes');
    }
    const packageValue = parseStrictJson(
      input.bytes,
      'package_bytes',
      PUBLIC_CONTRACT_LIMITS.packageBytes,
      PUBLIC_CONTRACT_LIMITS.maxPackageDepth,
    );
    const parsedPackage = parsePublicToolPackage(packageValue);
    if (parsedPackage.package_id !== input.package_id || parsedPackage.version !== input.version) {
      throw new PublicContractError(
        'package_bytes',
        'package identity does not match the selected registry version',
      );
    }
    if (parsedPackage.manifest_digest !== input.manifest_digest) {
      throw new PublicContractError(
        'manifest_digest',
        'does not match the downloaded package manifest',
      );
    }
    this.ensureDirectories();
    const artifactPath = this.artifactPath(input.package_digest);
    if (fs.existsSync(artifactPath)) {
      const existing = fs.readFileSync(artifactPath);
      if (
        sha256Digest(existing) !== input.package_digest ||
        !existing.equals(Buffer.from(input.bytes))
      ) {
        throw new PublicContractError(
          'package_store',
          'existing content-addressed artifact differs from verified bytes',
        );
      }
      return artifactPath;
    }
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(artifactPath), 0o700);
    writeExclusiveAtomic(artifactPath, input.bytes);
    return artifactPath;
  }

  activate(installed: InstalledPackageV1): InstalledStateV1 {
    this.ensureDirectories();
    const artifactPath = this.artifactPath(installed.package_digest);
    if (!fs.existsSync(artifactPath)) {
      throw new PublicContractError(
        'package_digest',
        'cannot activate an artifact absent from the immutable store',
      );
    }
    const artifact = fs.readFileSync(artifactPath);
    if (sha256Digest(artifact) !== installed.package_digest) {
      throw new PublicContractError('package_digest', 'stored artifact digest mismatch');
    }
    const parsedPackage = parsePublicToolPackage(
      parseStrictJson(
        artifact,
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
        'installed.json',
        'active package metadata does not match its immutable artifact',
      );
    }
    return this.withActivationLock(() => {
      const current = this.readInstalled();
      const next: InstalledStateV1 = {
        installed_schema_version: INSTALLED_SCHEMA_VERSION_V1,
        packages: { ...current.packages, [installed.package_id]: installed },
      };
      this.writeInstalled(next);
      return next;
    });
  }

  readInstalled(): InstalledStateV1 {
    try {
      const bytes = fs.readFileSync(this.paths.installed);
      return parseInstalledState(
        parseStrictJson(
          bytes,
          'installed.json',
          INSTALLED_STATE_BYTES_V1,
          PUBLIC_CONTRACT_LIMITS.maxDepth,
        ),
      );
    } catch (error) {
      if (isMissingFile(error)) return emptyInstalledState();
      throw error;
    }
  }

  getInstalled(packageId: PackageIdV1): InstalledPackageV1 | null {
    return this.readInstalled().packages[packageId] ?? null;
  }

  remove(packageId: PackageIdV1): {
    state: InstalledStateV1;
    removed: boolean;
    removed_active: InstalledPackageV1 | null;
  } {
    this.ensureDirectories();
    return this.withActivationLock(() => {
      const current = this.readInstalled();
      const removedActive = current.packages[packageId] ?? null;
      if (removedActive === null) {
        return { state: current, removed: false, removed_active: null };
      }
      const packages = Object.fromEntries(
        Object.entries(current.packages).filter(
          ([currentPackageId]) => currentPackageId !== packageId,
        ),
      ) as Record<PackageIdV1, InstalledPackageV1>;
      const state: InstalledStateV1 = {
        installed_schema_version: INSTALLED_SCHEMA_VERSION_V1,
        packages,
      };
      this.writeInstalled(state);
      return { state, removed: true, removed_active: removedActive };
    });
  }

  readArtifact(digest: Sha256DigestV1): Buffer {
    const artifactPath = this.artifactPath(digest);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(artifactPath);
    } catch (error) {
      if (isMissingFile(error))
        throw new PublicContractError('package_digest', 'is absent from the immutable store');
      throw error;
    }
    if (sha256Digest(bytes) !== digest) {
      throw new PublicContractError('package_digest', 'stored artifact digest mismatch');
    }
    return bytes;
  }

  private writeInstalled(state: InstalledStateV1): void {
    this.ensureDirectories();
    const parsed = parseInstalledState(state as unknown);
    writeAtomic(
      this.paths.installed,
      Buffer.from(canonicalJson(parsed as unknown as JsonValueV1), 'utf8'),
    );
  }

  private ensureDirectories(): void {
    fs.mkdirSync(this.paths.home, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.paths.home, 0o700);
    fs.mkdirSync(this.paths.packages, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.paths.packages, 0o700);
  }

  private artifactPath(digest: Sha256DigestV1): string {
    return path.join(this.paths.packages, digest, 'package.json');
  }

  private withActivationLock<Value>(operation: () => Value): Value {
    const lockPath = path.join(this.paths.home, 'activation.lock');
    let lockFd: number | null = null;
    try {
      try {
        lockFd = fs.openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new PublicContractError(
            'activation_lock',
            'is held by another local install or remove',
          );
        }
        throw error;
      }
      return operation();
    } finally {
      if (lockFd !== null) {
        fs.closeSync(lockFd);
        fs.unlinkSync(lockPath);
      }
    }
  }
}

export function parseInstalledState(value: unknown): InstalledStateV1 {
  const record = parseExactRecord(value, 'installed.json', [
    'installed_schema_version',
    'packages',
  ]);
  if (record.installed_schema_version !== INSTALLED_SCHEMA_VERSION_V1) {
    throw new PublicContractError('installed.json.installed_schema_version', 'must be 1');
  }
  const packagesRecord = parseBoundedRecord(
    record.packages,
    'installed.json.packages',
    PUBLIC_CONTRACT_LIMITS.maxIndexPackages,
  );
  const packages: Record<PackageIdV1, InstalledPackageV1> = {} as Record<
    PackageIdV1,
    InstalledPackageV1
  >;
  for (const [key, candidate] of Object.entries(packagesRecord)) {
    const packageId = parsePackageId(key, `installed.json.packages.${key}`);
    const parsed = parseInstalledPackage(candidate, `installed.json.packages.${key}`);
    assertMapKey(key, parsed.package_id, `installed.json.packages.${key}`);
    packages[packageId] = parsed;
  }
  return { installed_schema_version: INSTALLED_SCHEMA_VERSION_V1, packages };
}

export function defaultConsumerHome(): string {
  return process.env.KLURA_HOME || path.join(os.homedir(), '.klura');
}

function parseInstalledPackage(value: unknown, field: string): InstalledPackageV1 {
  const record = parseExactRecord(value, field, [
    'package_id',
    'version',
    'package_digest',
    'manifest_digest',
    'source_index_digest',
    'runtime_range',
    'installed_at',
  ]);
  return {
    package_id: parsePackageId(record.package_id, `${field}.package_id`),
    version: parsePackageVersion(record.version, `${field}.version`),
    package_digest: parseSha256Digest(record.package_digest, `${field}.package_digest`),
    manifest_digest: parseSha256Digest(record.manifest_digest, `${field}.manifest_digest`),
    source_index_digest: parseSha256Digest(
      record.source_index_digest,
      `${field}.source_index_digest`,
    ),
    runtime_range: parseRuntimeRange(record.runtime_range, `${field}.runtime_range`),
    installed_at: parseRfc3339Instant(record.installed_at, `${field}.installed_at`),
  };
}

function emptyInstalledState(): InstalledStateV1 {
  return {
    installed_schema_version: INSTALLED_SCHEMA_VERSION_V1,
    packages: {} as Record<PackageIdV1, InstalledPackageV1>,
  };
}

function writeExclusiveAtomic(target: string, bytes: Uint8Array): void {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if (isAlreadyExists(error)) {
        const existing = fs.readFileSync(target);
        if (!existing.equals(Buffer.from(bytes))) {
          throw new PublicContractError(
            'package_store',
            'concurrent artifact write has different bytes',
          );
        }
        return;
      }
      throw error;
    }
    fs.unlinkSync(temporary);
    fsyncDirectory(directory);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Temporary cleanup is best-effort after a failed write.
    }
  }
}

function writeAtomic(target: string, bytes: Uint8Array): void {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, target);
    fsyncDirectory(directory);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Temporary cleanup is best-effort after a failed write.
    }
  }
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
