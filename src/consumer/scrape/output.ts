import fs from 'node:fs';
import path from 'node:path';
import { parseExactRecord, PublicContractError } from '../../public/contracts/common';
import type { CollectionRunContractV1 } from '../../public/contracts/collection';
import type { RunIdV1 } from './journal';

const MAX_OUTPUT_PATH_BYTES_V1 = 4096;
export const DEFAULT_INLINE_OUTPUT_MAX_BYTES_V1 = 1024 * 1024;
const MAX_INLINE_ITEM_COUNT_V1 = 100;
const INLINE_RESULT_ENVELOPE_OVERHEAD_BYTES_V1 = 4096;

export type RunOutputFormatV1 = 'json' | 'ndjson' | 'csv';

export type RunOutputV1 =
  | { kind: 'inline' }
  | { kind: 'file'; requested_path: string; format: RunOutputFormatV1 };

export class RunOutputError extends PublicContractError {
  constructor(
    public readonly code: 'output_path_invalid' | 'output_exists' | 'output_sink_required',
    message: string,
  ) {
    super('run.output', message);
    this.name = 'RunOutputError';
  }
}

/** Parses the immutable destination declaration recorded with a scrape run. */
export function parseRunOutput(value: unknown, field: string): RunOutputV1 {
  const kind = readOutputKind(value, field);
  if (kind === 'inline') {
    parseExactRecord(value, field, ['kind']);
    return { kind };
  }
  const record = parseExactRecord(value, field, ['kind', 'requested_path', 'format']);
  if (record.kind !== 'file') throw new PublicContractError(`${field}.kind`, 'is invalid');
  return {
    kind,
    requested_path: parseAbsoluteOutputPath(record.requested_path, `${field}.requested_path`),
    format: parseRunOutputFormat(record.format, `${field}.format`),
  };
}

export function parseRunOutputFormat(value: unknown, field: string): RunOutputFormatV1 {
  if (value === 'json' || value === 'ndjson' || value === 'csv') return value;
  throw new PublicContractError(field, 'must be json, ndjson, or csv');
}

/** Returns the daemon-owned partial-file path for one immutable output declaration. */
export function partialOutputPath(
  output: Extract<RunOutputV1, { kind: 'file' }>,
  runId: RunIdV1,
): string {
  return `${output.requested_path}.partial.${runId}`;
}

/** Returns the run-owned sibling temporary path that is never exposed to callers. */
export function privateOutputPath(
  output: Extract<RunOutputV1, { kind: 'file' }>,
  runId: RunIdV1,
): string {
  const directory = path.dirname(output.requested_path);
  const basename = path.basename(output.requested_path);
  return path.join(directory, `.${basename}.klura-${runId}.tmp`);
}

/**
 * Checks a destination before a run can make target-site traffic. Both paths must be
 * absent and the parent must be an existing non-symlink directory.
 */
export function preflightRunOutput(output: RunOutputV1, runId: RunIdV1): void {
  if (output.kind === 'inline') return;
  assertRegularDirectory(path.dirname(output.requested_path));
  assertAbsent(output.requested_path, 'output path already exists');
  assertAbsent(partialOutputPath(output, runId), 'output partial path already exists');
  assertAbsent(privateOutputPath(output, runId), 'output temporary path already exists');
}

/** Rejects unprovable inline output before durable state or target traffic exists. */
export function preflightInlineRunOutput(
  output: RunOutputV1,
  collection: CollectionRunContractV1,
  maximumItems: number,
  adapterByteBudget: number = DEFAULT_INLINE_OUTPUT_MAX_BYTES_V1,
): void {
  if (output.kind !== 'inline') return;
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 1) {
    throw new RunOutputError('output_sink_required', 'inline item ceiling is invalid');
  }
  if (
    !Number.isSafeInteger(adapterByteBudget) ||
    adapterByteBudget < 1 ||
    adapterByteBudget > DEFAULT_INLINE_OUTPUT_MAX_BYTES_V1
  ) {
    throw new RunOutputError('output_sink_required', 'inline adapter byte budget is invalid');
  }
  const bound = collection.inline_output_bound;
  if (bound === null || maximumItems > MAX_INLINE_ITEM_COUNT_V1) {
    throw new RunOutputError(
      'output_sink_required',
      'inline output requires a finite item bound and at most 100 items',
    );
  }
  const itemsBytes = maximumItems * bound.max_serialized_item_bytes;
  const separators = Math.max(0, maximumItems - 1);
  const total = 2 + itemsBytes + separators + INLINE_RESULT_ENVELOPE_OVERHEAD_BYTES_V1;
  if (!Number.isSafeInteger(total) || total > adapterByteBudget) {
    throw new RunOutputError(
      'output_sink_required',
      'inline output exceeds the active adapter byte budget',
    );
  }
}

function parseAbsoluteOutputPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PublicContractError(field, 'must be a non-empty absolute path');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_OUTPUT_PATH_BYTES_V1 || value.includes('\0')) {
    throw new PublicContractError(field, 'is invalid');
  }
  if (!path.isAbsolute(value)) throw new PublicContractError(field, 'must be an absolute path');
  const normalized = path.resolve(value);
  if (normalized !== value) {
    throw new PublicContractError(field, 'must be a normalized absolute path');
  }
  return normalized;
}

function readOutputKind(value: unknown, field: string): 'inline' | 'file' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'inline' || kind === 'file') return kind;
  throw new PublicContractError(`${field}.kind`, 'must be inline or file');
}

function assertRegularDirectory(directory: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    if (isMissing(error)) {
      throw new RunOutputError('output_path_invalid', 'output parent directory does not exist');
    }
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new RunOutputError(
      'output_path_invalid',
      'output parent must be a non-symbolic-link directory',
    );
  }
}

function assertAbsent(candidate: string, message: string): void {
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new RunOutputError('output_exists', message);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
