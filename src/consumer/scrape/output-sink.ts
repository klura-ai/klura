import fs from 'node:fs';
import path from 'node:path';
import {
  PublicContractError,
  sha256Digest,
  type Sha256DigestV1,
} from '../../public/contracts/common';
import type { CsvColumnV1 } from '../../public/contracts/collection';
import { canonicalJson, type JsonValueV1 } from '../../public/contracts/json';
import type { ScrapeRunPolicyV1 } from '../../public/contracts/scrape-policy';
import { resolveJsonPointer } from '../../public/contracts/value-expression';
import type { RunIdV1, RunStopV1, TerminalResultDescriptorV1 } from './journal';
import { partialOutputPath, privateOutputPath, type RunOutputV1 } from './output';
import { readCommittedRunItems } from './result-reader';
import type { RunStoreV1 } from './run-store';

export interface FileOutputSinkOptionsV1 {
  csv_columns: readonly CsvColumnV1[] | null;
  max_output_bytes: number;
  replace_existing_temporary?: boolean;
}

export interface OutputSinkCommitV1 {
  path: string;
  bytes_written: number;
  items_written: number;
}

export interface OutputSinkPreparedV1 {
  path: string;
  byte_length: number;
  content_digest: Sha256DigestV1;
  items_written: number;
}

export interface PreparedOutputRecoveryV1 {
  path: string;
  byte_length: number;
  content_digest: Sha256DigestV1;
}

export interface OutputSinkProgressV1 {
  byte_offset: number;
  prefix_digest: Sha256DigestV1;
  items_written: number;
}

export class RunOutputSinkError extends PublicContractError {
  constructor(
    public readonly code:
      | 'output_budget_exhausted'
      | 'output_format_invalid'
      | 'csv_projection_invalid'
      | 'output_exists'
      | 'output_sink_failure',
    message: string,
  ) {
    super('run.output', message);
    this.name = 'RunOutputSinkError';
  }
}

/**
 * A run-owned sibling sink. Its temporary representation is valid after every item,
 * so replay can recreate it from the journal after an interruption.
 */
export class FileRunOutputSinkV1 {
  private bytesWritten = 0;
  private itemsWritten = 0;
  private closed = false;

  private constructor(
    private readonly output: Extract<RunOutputV1, { kind: 'file' }>,
    private readonly runId: RunIdV1,
    private readonly temporaryPath: string,
    private readonly fd: number,
    private readonly options: Required<
      Pick<FileOutputSinkOptionsV1, 'csv_columns' | 'max_output_bytes'>
    >,
  ) {}

  static create(
    output: Extract<RunOutputV1, { kind: 'file' }>,
    runId: RunIdV1,
    options: FileOutputSinkOptionsV1,
  ): FileRunOutputSinkV1 {
    if (output.format === 'csv' && options.csv_columns === null) {
      throw new RunOutputSinkError(
        'output_format_invalid',
        'CSV output requires declared collection columns',
      );
    }
    if (!Number.isSafeInteger(options.max_output_bytes) || options.max_output_bytes < 1) {
      throw new RunOutputSinkError('output_sink_failure', 'output byte budget is invalid');
    }
    const temporaryPath = privateOutputPath(output, runId);
    resetTemporaryPath(temporaryPath, options.replace_existing_temporary === true);
    let fd: number | null = null;
    try {
      fd = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.chmodSync(temporaryPath, 0o600);
      const sink = new FileRunOutputSinkV1(output, runId, temporaryPath, fd, {
        csv_columns: options.csv_columns,
        max_output_bytes: options.max_output_bytes,
      });
      sink.writeInitialPrefix();
      return sink;
    } catch (error) {
      if (fd !== null) fs.closeSync(fd);
      removeTemporaryPath(temporaryPath);
      throw error;
    }
  }

  get bytes_written(): number {
    return this.bytesWritten;
  }

  get items_written(): number {
    return this.itemsWritten;
  }

  terminalOutput(
    partial: boolean,
  ): Extract<TerminalResultDescriptorV1['output'], { kind: 'file' }> {
    return {
      kind: 'file',
      path: partial ? partialOutputPath(this.output, this.runId) : this.output.requested_path,
      format: this.output.format,
      partial,
    };
  }

  /** Returns the exact additional bytes for the next valid item without mutating the sink. */
  previewItem(item: JsonValueV1): number {
    this.assertOpen();
    return this.formatItem(item).delta;
  }

  /** Writes one schema-validated, committed item and fsyncs its valid prefix. */
  write(item: JsonValueV1): OutputSinkProgressV1 {
    this.assertOpen();
    const formatted = this.formatItem(item);
    if (this.output.format === 'json') {
      this.reserve(formatted.delta);
      fs.ftruncateSync(this.fd, this.bytesWritten - 1);
      try {
        this.writeBytes(`${formatted.value}]`, this.bytesWritten - 1);
      } catch (error) {
        this.bytesWritten -= 1;
        throw error;
      }
      this.bytesWritten += formatted.delta;
    } else {
      this.reserve(formatted.delta);
      this.writeBytes(formatted.value, this.bytesWritten);
      this.bytesWritten += formatted.delta;
    }
    fs.fsyncSync(this.fd);
    this.itemsWritten += 1;
    return this.progress();
  }

  /** Atomically publishes a fully completed output without replacing a destination. */
  commitComplete(): OutputSinkCommitV1 {
    return this.commitPrepared(this.prepareComplete());
  }

  /** Atomically publishes the current syntactically valid prefix as an incomplete result. */
  commitPartial(): OutputSinkCommitV1 {
    return this.commitPrepared(this.preparePartial());
  }

  /** Fsyncs and binds the complete output before it is made visible at its destination. */
  prepareComplete(): OutputSinkPreparedV1 {
    return this.prepare(this.output.requested_path);
  }

  /** Fsyncs and binds an incomplete output before it is made visible at its partial path. */
  preparePartial(): OutputSinkPreparedV1 {
    return this.prepare(partialOutputPath(this.output, this.runId));
  }

  /** Publishes exactly one previously prepared output without replacing a destination. */
  commitPrepared(prepared: OutputSinkPreparedV1): OutputSinkCommitV1 {
    this.assertOpen();
    const current = this.prepare(prepared.path);
    if (
      current.byte_length !== prepared.byte_length ||
      current.content_digest !== prepared.content_digest ||
      current.items_written !== prepared.items_written
    ) {
      throw new RunOutputSinkError('output_sink_failure', 'prepared output no longer matches');
    }
    return this.commit(prepared.path);
  }

  /** Completes a prepared publication through the same verified recovery path used at startup. */
  completePrepared(prepared: OutputSinkPreparedV1): OutputSinkCommitV1 {
    this.assertOpen();
    recoverPreparedFileOutput(this.output, this.runId, prepared);
    fs.closeSync(this.fd);
    this.closed = true;
    return {
      path: prepared.path,
      bytes_written: prepared.byte_length,
      items_written: prepared.items_written,
    };
  }

  /** Closes and removes only the private run-owned temporary path. */
  discard(): void {
    if (!this.closed) {
      fs.closeSync(this.fd);
      this.closed = true;
    }
    removeTemporaryPath(this.temporaryPath);
  }

  /** Returns the digest of the complete, fsynced private prefix. */
  progress(): OutputSinkProgressV1 {
    this.assertOpen();
    return {
      byte_offset: this.bytesWritten,
      prefix_digest: sha256Digest(fs.readFileSync(this.temporaryPath)),
      items_written: this.itemsWritten,
    };
  }

  private writeInitialPrefix(): void {
    let prefix = '';
    if (this.output.format === 'json') {
      prefix = '[]';
    } else if (this.output.format === 'csv') {
      const columns = this.options.csv_columns;
      if (columns === null) {
        throw new RunOutputSinkError(
          'output_format_invalid',
          'CSV output requires declared collection columns',
        );
      }
      prefix = `${columns.map((column) => escapeCsv(column.name)).join(',')}\n`;
    }
    this.reserve(Buffer.byteLength(prefix, 'utf8'));
    this.writeBytes(prefix, 0);
    this.bytesWritten += Buffer.byteLength(prefix, 'utf8');
    fs.fsyncSync(this.fd);
  }

  private encodeItem(item: JsonValueV1): string {
    if (this.output.format !== 'csv') return canonicalJson(item);
    const columns = this.options.csv_columns;
    if (columns === null) {
      throw new RunOutputSinkError(
        'output_format_invalid',
        'CSV output requires declared collection columns',
      );
    }
    return columns.map((column) => projectCsvCell(item, column)).join(',');
  }

  private formatItem(item: JsonValueV1): { value: string; delta: number } {
    const encoded = this.encodeItem(item);
    if (this.output.format === 'json') {
      const value = `${this.itemsWritten === 0 ? '' : ','}${encoded}`;
      return { value, delta: Buffer.byteLength(value, 'utf8') };
    }
    const value = `${encoded}\n`;
    return { value, delta: Buffer.byteLength(value, 'utf8') };
  }

  private reserve(bytes: number): void {
    if (this.bytesWritten + bytes > this.options.max_output_bytes) {
      throw new RunOutputSinkError(
        'output_budget_exhausted',
        'declared output byte budget is exhausted',
      );
    }
  }

  private writeBytes(value: string, position: number): void {
    const bytes = Buffer.from(value, 'utf8');
    fs.writeSync(this.fd, bytes, 0, bytes.byteLength, position);
  }

  private prepare(destination: string): OutputSinkPreparedV1 {
    this.assertOpen();
    fs.fsyncSync(this.fd);
    const bytes = fs.readFileSync(this.temporaryPath);
    return {
      path: destination,
      byte_length: bytes.byteLength,
      content_digest: sha256Digest(bytes),
      items_written: this.itemsWritten,
    };
  }

  private commit(destination: string): OutputSinkCommitV1 {
    this.assertOpen();
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.closed = true;
    try {
      fs.linkSync(this.temporaryPath, destination);
    } catch (error) {
      if (isExists(error)) {
        throw new RunOutputSinkError('output_exists', 'output path already exists');
      }
      throw error;
    }
    fs.unlinkSync(this.temporaryPath);
    fsyncDirectory(path.dirname(destination));
    return {
      path: destination,
      bytes_written: this.bytesWritten,
      items_written: this.itemsWritten,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new RunOutputSinkError('output_sink_failure', 'output sink is closed');
  }
}

/** Opens an empty sink or recreates its private prefix from the committed item journal. */
export function openFileRunOutputSink(
  store: RunStoreV1,
  output: RunOutputV1,
  runId: RunIdV1,
  csvColumns: readonly CsvColumnV1[] | null,
  policy: ScrapeRunPolicyV1,
  replaceExistingTemporary: boolean,
): FileRunOutputSinkV1 | null {
  if (output.kind === 'inline') return null;
  let sink: FileRunOutputSinkV1 | null = null;
  try {
    sink = FileRunOutputSinkV1.create(output, runId, {
      csv_columns: csvColumns,
      max_output_bytes: policy.max_output_bytes,
      replace_existing_temporary: replaceExistingTemporary,
    });
    if (replaceExistingTemporary) {
      for (const item of readCommittedRunItems(store, runId)) sink.write(item);
    }
    return sink;
  } catch (error) {
    sink?.discard();
    throw error;
  }
}

/** Finalizes exposed output without publishing a prefix after a sink failure. */
export function finishFileRunOutputSink(
  sink: FileRunOutputSinkV1 | null,
  committedItemCount: number,
  stop: RunStopV1,
): RunStopV1 {
  if (sink === null) return stop;
  try {
    if (stop === 'output_sink_failure' || committedItemCount === 0) {
      sink.discard();
    } else {
      sink.commitPartial();
    }
    return stop;
  } catch (error) {
    if (!(error instanceof RunOutputSinkError)) throw error;
    sink.discard();
    return 'output_sink_failure';
  }
}

/** Completes a journaled no-replace publication without reopening the run sink. */
export function recoverPreparedFileOutput(
  output: Extract<RunOutputV1, { kind: 'file' }>,
  runId: RunIdV1,
  prepared: PreparedOutputRecoveryV1,
): void {
  const partialPath = partialOutputPath(output, runId);
  if (prepared.path !== output.requested_path && prepared.path !== partialPath) {
    throw new RunOutputSinkError(
      'output_sink_failure',
      'prepared output path is not owned by the run',
    );
  }
  const temporaryPath = privateOutputPath(output, runId);
  if (isExistingPreparedOutput(prepared.path, prepared)) {
    removeMatchingTemporaryPath(temporaryPath, prepared);
    return;
  }
  verifyPreparedFile(temporaryPath, prepared, 'output temporary path');
  try {
    fs.linkSync(temporaryPath, prepared.path);
  } catch (error) {
    if (isExists(error) && isExistingPreparedOutput(prepared.path, prepared)) {
      removeMatchingTemporaryPath(temporaryPath, prepared);
      return;
    }
    throw error;
  }
  fs.unlinkSync(temporaryPath);
  fsyncDirectory(path.dirname(prepared.path));
}

function resetTemporaryPath(temporaryPath: string, replaceExisting: boolean): void {
  try {
    const stats = fs.lstatSync(temporaryPath);
    if (!replaceExisting) {
      throw new RunOutputSinkError('output_exists', 'output temporary path already exists');
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new RunOutputSinkError(
        'output_sink_failure',
        'output temporary path is not a regular file',
      );
    }
    fs.unlinkSync(temporaryPath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function removeTemporaryPath(temporaryPath: string): void {
  try {
    const stats = fs.lstatSync(temporaryPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    fs.unlinkSync(temporaryPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isExistingPreparedOutput(pathname: string, prepared: PreparedOutputRecoveryV1): boolean {
  try {
    verifyPreparedFile(pathname, prepared, 'output destination');
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function removeMatchingTemporaryPath(
  temporaryPath: string,
  prepared: PreparedOutputRecoveryV1,
): void {
  try {
    verifyPreparedFile(temporaryPath, prepared, 'output temporary path');
    fs.unlinkSync(temporaryPath);
    fsyncDirectory(path.dirname(temporaryPath));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function verifyPreparedFile(
  pathname: string,
  prepared: PreparedOutputRecoveryV1,
  label: string,
): void {
  const stats = fs.lstatSync(pathname);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new RunOutputSinkError('output_sink_failure', `${label} is not a regular file`);
  }
  const bytes = fs.readFileSync(pathname);
  if (
    bytes.byteLength !== prepared.byte_length ||
    sha256Digest(bytes) !== prepared.content_digest
  ) {
    throw new RunOutputSinkError('output_sink_failure', `${label} does not match its preparation`);
  }
}

function projectCsvCell(item: JsonValueV1, column: CsvColumnV1): string {
  let value: JsonValueV1;
  try {
    value = resolveJsonPointer(item, column.pointer, 'run.csv_column');
  } catch (error) {
    if (error instanceof PublicContractError) {
      throw new RunOutputSinkError('csv_projection_invalid', error.message);
    }
    throw error;
  }
  if (value === null) return escapeCsv('');
  if (typeof value === 'string') return escapeCsv(value);
  if (typeof value === 'number' || typeof value === 'boolean') return escapeCsv(String(value));
  return escapeCsv(canonicalJson(value));
}

function escapeCsv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function isExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
