import fs from 'node:fs';
import {
  parseExactRecord,
  parseInteger,
  parseSha256Digest,
  PublicContractError,
  sha256Digest,
  type Sha256DigestV1,
} from '../../public/contracts/common';
import { canonicalJson, parseStrictJson, type JsonValueV1 } from '../../public/contracts/json';

export interface BlobRefV1 {
  offset: number;
  length: number;
  sha256: Sha256DigestV1;
}

export class DataSpoolError extends PublicContractError {
  constructor(
    public readonly code: 'durable_budget_exhausted' | 'spool_corrupt',
    message: string,
  ) {
    super('data_spool', message);
    this.name = 'DataSpoolError';
  }
}

export function appendDataBlob(
  spoolPath: string,
  value: JsonValueV1,
  maximumBytes: number,
): BlobRefV1 {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new DataSpoolError('durable_budget_exhausted', 'data spool budget is invalid');
  }
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  const currentLength = fs.statSync(spoolPath).size;
  if (!Number.isSafeInteger(currentLength) || currentLength + bytes.byteLength > maximumBytes) {
    throw new DataSpoolError('durable_budget_exhausted', 'data spool byte budget is exhausted');
  }
  const fd = fs.openSync(spoolPath, 'a', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { offset: currentLength, length: bytes.byteLength, sha256: sha256Digest(bytes) };
}

export function readDataBlob(spoolPath: string, reference: BlobRefV1): JsonValueV1 {
  const parsed = parseBlobRef(reference, 'blob_ref');
  const bytes = fs.readFileSync(spoolPath);
  if (parsed.offset + parsed.length > bytes.byteLength) {
    throw new DataSpoolError('spool_corrupt', 'blob reference is outside the data spool');
  }
  const slice = bytes.subarray(parsed.offset, parsed.offset + parsed.length);
  if (sha256Digest(slice) !== parsed.sha256) {
    throw new DataSpoolError('spool_corrupt', 'blob digest does not match spool bytes');
  }
  const value = parseStrictJson(slice, 'data_spool_blob', parsed.length, 12);
  if (Buffer.from(canonicalJson(value), 'utf8').compare(slice) !== 0) {
    throw new DataSpoolError('spool_corrupt', 'blob is not canonical JSON');
  }
  return value;
}

export function parseBlobRef(value: unknown, field: string): BlobRefV1 {
  const record = parseExactRecord(value, field, ['offset', 'length', 'sha256']);
  return {
    offset: parseInteger(record.offset, `${field}.offset`, 0, Number.MAX_SAFE_INTEGER),
    length: parseInteger(record.length, `${field}.length`, 0, Number.MAX_SAFE_INTEGER),
    sha256: parseSha256Digest(record.sha256, `${field}.sha256`),
  };
}
