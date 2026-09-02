import { randomUUID, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  sha256Digest,
  type Sha256DigestV1,
} from '../../public/contracts/common';
import { parseStrictJson } from '../../public/contracts/json';
import {
  parseSignedRegistryIndex,
  type RegistryPackageVersionV1,
  type SignedRegistryIndexV1,
} from '../../public/contracts/registry-index';
import { verifySignedRegistryIndex } from './signature';

export const REGISTRY_REFRESH_TIMEOUT_MS_V1 = 10_000;

export interface RegistryAuthorityV1 {
  index_url: string;
  public_key: KeyObject;
}

export interface RegistryFetchResponseV1 {
  status: number;
  body: ReadableStream<Uint8Array> | null;
}

export type RegistryFetchV1 = (
  url: string,
  options: { redirect: 'error'; signal: AbortSignal },
) => Promise<RegistryFetchResponseV1>;

export interface VerifiedRegistryIndexV1 {
  signed_index: SignedRegistryIndexV1;
  source_digest: Sha256DigestV1;
  source_bytes: Buffer;
}

export type RegistryCacheStatusV1 =
  | { kind: 'missing' }
  | { kind: 'invalid_schema' | 'invalid_signature' | 'not_yet_valid' | 'expired'; error: Error }
  | { kind: 'ok'; verified: VerifiedRegistryIndexV1 };

export class RegistryClientError extends PublicContractError {
  constructor(
    public readonly code: 'registry_unavailable' | 'registry_invalid',
    message: string,
  ) {
    super('registry', message);
    this.name = 'RegistryClientError';
  }
}

export class PackageDownloadError extends PublicContractError {
  constructor(message: string) {
    super('package_download', message);
    this.name = 'PackageDownloadError';
  }
}

export class RegistryClientV1 {
  readonly cachePath: string;

  constructor(
    home: string,
    private readonly authority: RegistryAuthorityV1,
    private readonly fetchImpl: RegistryFetchV1 = defaultRegistryFetch,
  ) {
    assertRegistryAuthority(authority);
    this.cachePath = path.join(home, 'registry', 'index.signed.json');
  }

  inspectCache(now = new Date()): RegistryCacheStatusV1 {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(this.cachePath);
    } catch (error) {
      if (isMissingFile(error)) return { kind: 'missing' };
      return { kind: 'invalid_schema', error: asError(error) };
    }
    try {
      const verified = this.verifyBytes(bytes, now);
      return { kind: 'ok', verified };
    } catch (error) {
      if (error instanceof RegistryTemporalError) return { kind: error.kind, error };
      if (error instanceof RegistrySignatureError) return { kind: 'invalid_signature', error };
      return { kind: 'invalid_schema', error: asError(error) };
    }
  }

  async refresh(now = new Date()): Promise<VerifiedRegistryIndexV1> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, REGISTRY_REFRESH_TIMEOUT_MS_V1);
    try {
      const response = await this.fetchImpl(this.authority.index_url, {
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status !== 200) {
        throw new RegistryClientError(
          'registry_unavailable',
          `refresh returned HTTP ${response.status}`,
        );
      }
      const bytes = await readBoundedBody(response.body, PUBLIC_CONTRACT_LIMITS.indexBytes);
      let verified: VerifiedRegistryIndexV1;
      try {
        verified = this.verifyBytes(bytes, now);
      } catch (error) {
        throw new RegistryClientError('registry_invalid', asError(error).message);
      }
      this.writeCache(bytes);
      return verified;
    } catch (error) {
      if (error instanceof RegistryClientError) throw error;
      throw new RegistryClientError(
        'registry_unavailable',
        `refresh failed: ${asError(error).message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async downloadPackage(version: RegistryPackageVersionV1): Promise<Buffer> {
    const packageUrl = this.assertSameOriginPackageUrl(version.package_url);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, REGISTRY_REFRESH_TIMEOUT_MS_V1);
    try {
      const response = await this.fetchImpl(packageUrl.toString(), {
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status !== 200) {
        throw new PackageDownloadError(`returned HTTP ${response.status}`);
      }
      const bytes = await readBoundedBody(response.body, version.package_bytes);
      if (bytes.byteLength !== version.package_bytes) {
        throw new PackageDownloadError('byte length does not match the signed package metadata');
      }
      if (sha256Digest(bytes) !== version.package_digest) {
        throw new PackageDownloadError('digest does not match the signed package metadata');
      }
      return bytes;
    } catch (error) {
      if (error instanceof PackageDownloadError) throw error;
      throw new PackageDownloadError(asError(error).message);
    } finally {
      clearTimeout(timeout);
    }
  }

  private verifyBytes(bytes: Uint8Array, now: Date): VerifiedRegistryIndexV1 {
    const parsed = parseStrictJson(
      bytes,
      'registry.index',
      PUBLIC_CONTRACT_LIMITS.indexBytes,
      PUBLIC_CONTRACT_LIMITS.maxDepth,
    );
    const candidate = parseSignedRegistryIndex(parsed);
    let signedIndex: SignedRegistryIndexV1;
    try {
      signedIndex = verifySignedRegistryIndex(candidate, this.authority.public_key);
    } catch (error) {
      throw new RegistrySignatureError(asError(error).message);
    }
    assertRegistryTimeWindow(signedIndex, now);
    return {
      signed_index: signedIndex,
      source_digest: sha256Digest(bytes),
      source_bytes: Buffer.from(bytes),
    };
  }

  private writeCache(bytes: Uint8Array): void {
    const directory = path.dirname(this.cachePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = path.join(directory, `.index.signed.json.${randomUUID()}.tmp`);
    let fd: number | null = null;
    try {
      fd = fs.openSync(temporary, 'w', 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temporary, this.cachePath);
      fsyncDirectory(directory);
    } finally {
      if (fd !== null) fs.closeSync(fd);
      try {
        fs.unlinkSync(temporary);
      } catch {
        // The cache file has either been promoted or was never created.
      }
    }
  }

  private assertSameOriginPackageUrl(value: string): URL {
    let indexUrl: URL;
    let packageUrl: URL;
    try {
      indexUrl = new URL(this.authority.index_url);
      packageUrl = new URL(value);
    } catch {
      throw new PackageDownloadError('URL is invalid');
    }
    if (
      packageUrl.protocol !== 'https:' ||
      packageUrl.username.length > 0 ||
      packageUrl.password.length > 0 ||
      packageUrl.hash.length > 0 ||
      packageUrl.origin !== indexUrl.origin
    ) {
      throw new PackageDownloadError('URL must be an HTTPS resource on the registry origin');
    }
    return packageUrl;
  }
}

class RegistryTemporalError extends Error {
  constructor(
    public readonly kind: 'not_yet_valid' | 'expired',
    message: string,
  ) {
    super(message);
  }
}

class RegistrySignatureError extends Error {}

async function defaultRegistryFetch(
  url: string,
  options: { redirect: 'error'; signal: AbortSignal },
): Promise<RegistryFetchResponseV1> {
  const response = await fetch(url, options);
  return { status: response.status, body: response.body };
}

function assertRegistryAuthority(authority: RegistryAuthorityV1): void {
  let url: URL;
  try {
    url = new URL(authority.index_url);
  } catch {
    throw new PublicContractError('registry.index_url', 'must be a canonical HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    authority.index_url !== url.toString()
  ) {
    throw new PublicContractError('registry.index_url', 'must be a canonical HTTPS URL');
  }
}

function assertRegistryTimeWindow(signedIndex: SignedRegistryIndexV1, now: Date): void {
  const generatedAt = Date.parse(signedIndex.payload.generated_at);
  const expiresAt = Date.parse(signedIndex.payload.expires_at);
  if (now.getTime() < generatedAt) {
    throw new RegistryTemporalError('not_yet_valid', 'registry is not yet valid');
  }
  if (now.getTime() >= expiresAt) {
    throw new RegistryTemporalError('expired', 'registry is expired');
  }
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<Buffer> {
  if (body === null) throw new PublicContractError('registry.body', 'is missing');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        continue;
      }
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new PublicContractError('registry.body', `exceeds ${maximumBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
