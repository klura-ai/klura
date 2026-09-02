import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseExactRecord,
  parseSha256Digest,
  PublicContractError,
  sha256Digest,
  type Sha256DigestV1,
} from '../../public/contracts/common';
import {
  assertJsonValue,
  canonicalJson,
  parseStrictJson,
  type JsonValueV1,
} from '../../public/contracts/json';
import {
  createRunId,
  parseRunId,
  parseRunOperationId,
  type RunIdV1,
  type RunOperationIdV1,
} from './journal';

const OPERATION_BYTES_V1 = 64 * 1024;

export type RunOperationCommandV1 = 'start' | 'resume' | 'cancel' | 'discard';

export interface RunOperationRecordV1 {
  operation_schema_version: 1;
  operation_id: RunOperationIdV1;
  command: RunOperationCommandV1;
  arguments_digest: Sha256DigestV1;
  run_id: RunIdV1 | null;
  result: JsonValueV1 | null;
}

export interface ReserveRunOperationInputV1 {
  operation_id: string;
  command: RunOperationCommandV1;
  arguments: JsonValueV1;
  run_id?: string;
}

export type ReservedRunOperationV1 =
  | { kind: 'reserved'; record: RunOperationRecordV1 }
  | { kind: 'replayed'; record: RunOperationRecordV1 };

export class RunOperationError extends PublicContractError {
  constructor(
    public readonly code: 'operation_conflict' | 'operation_in_progress' | 'local_state_invalid',
    message: string,
  ) {
    super('run_operation', message);
    this.name = 'RunOperationError';
  }
}

/**
 * Persists small command-result records so a retried local IPC command cannot
 * create a second run or repeat a run mutation after its first reply is lost.
 */
export class RunOperationStoreV1 {
  readonly directory: string;

  constructor(private readonly home: string) {
    this.directory = path.join(home, 'run-operations');
  }

  reserve(input: ReserveRunOperationInputV1): ReservedRunOperationV1 {
    const parsed = parseReservation(input);
    return this.withLock(() => {
      const existing = this.readRecord(parsed.operation_id);
      if (existing !== null) {
        this.assertMatches(existing, parsed);
        return { kind: 'replayed', record: existing };
      }
      const record: RunOperationRecordV1 = {
        operation_schema_version: 1,
        operation_id: parsed.operation_id,
        command: parsed.command,
        arguments_digest: parsed.arguments_digest,
        run_id:
          parsed.command === 'start' && parsed.run_id === null ? createRunId() : parsed.run_id,
        result: null,
      };
      writeExclusive(this.recordPath(record.operation_id), encodeRecord(record));
      fsyncDirectory(this.directory);
      return { kind: 'reserved', record };
    });
  }

  complete(operationId: string, result: JsonValueV1): RunOperationRecordV1 {
    const parsedOperationId = parseRunOperationId(
      operationId,
      'run_operation.complete.operation_id',
    );
    assertJsonValue(result, 'run_operation.complete.result', 12);
    return this.withLock(() => {
      const existing = this.readRecord(parsedOperationId);
      if (existing === null) {
        throw new RunOperationError('local_state_invalid', 'operation record is not found');
      }
      if (existing.result !== null) {
        if (canonicalJson(existing.result) !== canonicalJson(result)) {
          throw new RunOperationError(
            'operation_conflict',
            'operation already has a different durable result',
          );
        }
        return existing;
      }
      const completed: RunOperationRecordV1 = { ...existing, result };
      writeAtomic(this.recordPath(parsedOperationId), encodeRecord(completed));
      return completed;
    });
  }

  /** Removes an uncompleted reservation when preflight rejected before a run exists. */
  abandon(operationId: string): void {
    const parsedOperationId = parseRunOperationId(
      operationId,
      'run_operation.abandon.operation_id',
    );
    this.withLock(() => {
      const existing = this.readRecord(parsedOperationId);
      if (existing === null) return;
      if (existing.result !== null) {
        throw new RunOperationError(
          'local_state_invalid',
          'completed operation cannot be abandoned',
        );
      }
      fs.unlinkSync(this.recordPath(parsedOperationId));
      fsyncDirectory(this.directory);
    });
  }

  read(operationId: string): RunOperationRecordV1 | null {
    const parsedOperationId = parseRunOperationId(operationId, 'run_operation.operation_id');
    return this.readRecord(parsedOperationId);
  }

  private assertMatches(record: RunOperationRecordV1, input: ParsedReservationV1): void {
    if (
      record.command !== input.command ||
      record.arguments_digest !== input.arguments_digest ||
      (input.run_id !== null && record.run_id !== input.run_id)
    ) {
      throw new RunOperationError(
        'operation_conflict',
        'operation id is already bound to different command arguments',
      );
    }
  }

  private readRecord(operationId: RunOperationIdV1): RunOperationRecordV1 | null {
    const target = this.recordPath(operationId);
    let bytes: Buffer;
    try {
      const stats = fs.lstatSync(target);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new RunOperationError(
          'local_state_invalid',
          'operation record is not a regular file',
        );
      }
      bytes = fs.readFileSync(target);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      return parseRecord(
        parseStrictJson(bytes, 'run_operation.record', OPERATION_BYTES_V1, 12),
        'run_operation.record',
      );
    } catch (error) {
      if (error instanceof RunOperationError) throw error;
      if (error instanceof PublicContractError) {
        throw new RunOperationError('local_state_invalid', 'operation record is invalid');
      }
      throw error;
    }
  }

  private withLock<Value>(operation: () => Value): Value {
    this.ensureDirectory();
    const lockPath = path.join(this.home, 'run-operations.lock');
    let lockFd: number | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const candidate = fs.openSync(lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(candidate, Buffer.from(canonicalJson({ pid: process.pid }), 'utf8'));
          fs.fsyncSync(candidate);
        } catch (error) {
          fs.closeSync(candidate);
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // A failed setup leaves no usable operation lock.
          }
          throw error;
        }
        lockFd = candidate;
        break;
      } catch (error) {
        if (!isExists(error)) throw error;
        if (isProcessLive(readLockPid(lockPath))) {
          throw new RunOperationError(
            'operation_in_progress',
            'another local run operation is active',
          );
        }
        fs.unlinkSync(lockPath);
      }
    }
    if (lockFd === null) {
      throw new RunOperationError(
        'operation_in_progress',
        'could not acquire the run operation lock',
      );
    }
    try {
      return operation();
    } finally {
      fs.closeSync(lockFd);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // A stale lock is checked structurally by the next operation attempt.
      }
    }
  }

  private ensureDirectory(): void {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.home, 0o700);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
  }

  private recordPath(operationId: RunOperationIdV1): string {
    return path.join(this.directory, `${operationId}.json`);
  }
}

interface ParsedReservationV1 {
  operation_id: RunOperationIdV1;
  command: RunOperationCommandV1;
  arguments_digest: Sha256DigestV1;
  run_id: RunIdV1 | null;
}

function parseReservation(input: ReserveRunOperationInputV1): ParsedReservationV1 {
  assertJsonValue(input.arguments, 'run_operation.arguments', 12);
  return {
    operation_id: parseRunOperationId(input.operation_id, 'run_operation.operation_id'),
    command: parseCommand(input.command, 'run_operation.command'),
    arguments_digest: sha256Digest(canonicalJson(input.arguments)),
    run_id: input.run_id === undefined ? null : parseRunId(input.run_id, 'run_operation.run_id'),
  };
}

function parseRecord(value: unknown, field: string): RunOperationRecordV1 {
  const record = parseExactRecord(value, field, [
    'operation_schema_version',
    'operation_id',
    'command',
    'arguments_digest',
    'run_id',
    'result',
  ]);
  if (record.operation_schema_version !== 1) {
    throw new PublicContractError(`${field}.operation_schema_version`, 'must be 1');
  }
  if (record.result !== null) assertJsonValue(record.result, `${field}.result`, 12);
  return {
    operation_schema_version: 1,
    operation_id: parseRunOperationId(record.operation_id, `${field}.operation_id`),
    command: parseCommand(record.command, `${field}.command`),
    arguments_digest: parseSha256Digest(record.arguments_digest, `${field}.arguments_digest`),
    run_id: record.run_id === null ? null : parseRunId(record.run_id, `${field}.run_id`),
    result: record.result,
  };
}

function parseCommand(value: unknown, field: string): RunOperationCommandV1 {
  if (value === 'start' || value === 'resume' || value === 'cancel' || value === 'discard') {
    return value;
  }
  throw new PublicContractError(field, 'must be a supported run operation command');
}

function encodeRecord(record: RunOperationRecordV1): Buffer {
  return Buffer.from(canonicalJson(record as unknown as JsonValueV1), 'utf8');
}

function writeExclusive(target: string, bytes: Buffer): void {
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeAtomic(target: string, bytes: Buffer): void {
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
      // Temporary cleanup is best-effort after a failed atomic update.
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

function readLockPid(lockPath: string): number {
  try {
    const record = parseExactRecord(
      parseStrictJson(fs.readFileSync(lockPath), 'run_operation.lock', 1_024, 3),
      'run_operation.lock',
      ['pid'],
    );
    if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid < 1) {
      throw new RunOperationError('local_state_invalid', 'run operation lock has an invalid owner');
    }
    return record.pid;
  } catch (error) {
    if (error instanceof RunOperationError) throw error;
    if (error instanceof PublicContractError) {
      throw new RunOperationError('local_state_invalid', 'run operation lock is malformed');
    }
    throw error;
  }
}

function isProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

function isExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
