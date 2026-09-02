// Owner-file lock — the single cross-process mutual-exclusion primitive for
// klura's on-disk state, plus the serialized read-modify-write helper built on
// top of it. Every lock file in the runtime (capability mutation, consumer
// session/resume/operation/activation locks, daemon singleton, `<file>.lock`
// RMW guards) goes through this module so there is exactly ONE stale-recovery
// policy:
//
//   - The lock file is created with O_EXCL and carries an owner record
//     `{schema_version, pid, process_nonce, acquire_nonce, process_marker,
//     created_at_ms}`; `acquire_nonce` is fresh per acquisition, so no two
//     holds of the same lock ever carry identical records.
//   - A held lock is DEFINITELY STALE when its owner pid is dead (ESRCH), when
//     the owner pid equals this process but the nonce differs (pid reuse across
//     a restart), or when the owner process verifiably does not hold its
//     process-marker file open (closes the pid-reuse hole on linux/darwin).
//   - `EPERM` on the liveness probe means the pid exists — the lock is LIVE.
//   - A malformed or empty lock file fails closed until its mtime is older
//     than the invalid-lock grace window, then becomes recoverable.
//   - Recovery itself is serialized through a `<lock>.recover` guard lock so
//     two reclaimers admit exactly one critical section, and it deletes only
//     while the on-disk record still equals the record the stale verdict was
//     computed for — owner turnover between verdict and delete aborts the
//     recovery instead of unlinking a live successor's lock.
//   - Release verifies the on-disk owner record still belongs to the releasing
//     holder before unlinking.
//
// Process markers live in `<lock dir>/.process-owners/<pid>-<nonce>.lease` and
// are held open by the owning process; any process examining a lock derives
// the marker path from the lock path alone, so no global registry is needed.
//
// Lock-ordering rule (deadlock avoidance): graduation lock → capability
// mutation lock → per-platform logbook / health / storage-state locks. Code
// holding a lower lock must never acquire a higher one.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

export class OwnerFileLockError extends Error {
  readonly code = 'owner_file_locked';

  constructor(lockPath: string) {
    super(`owner_file_locked: ${lockPath} is held by another process`);
    this.name = 'OwnerFileLockError';
  }
}

export interface OwnerFileLockOptions {
  /** Error to throw when the lock is held by a live owner. */
  onLocked?: () => Error;
  /** Injectable clock (ms since epoch) for grace-window tests. */
  now?: () => number;
  /** Age at which a malformed/empty lock file becomes recoverable. */
  invalidLockGraceMs?: number;
}

interface OwnerRecord {
  schema_version: 3;
  pid: number;
  process_nonce: string;
  /** Fresh per acquisition — makes every hold's record globally unique. */
  acquire_nonce: string;
  process_marker: 'held_file_v1';
  created_at_ms: number;
}

export interface OwnerFileLockHandle {
  lockPath: string;
  owner: OwnerRecord;
  markerPath: string;
}

const PROCESS_NONCE = crypto.randomBytes(16).toString('hex');
const PROCESS_MARKER_PROTOCOL = 'held_file_v1' as const;
const DEFAULT_INVALID_LOCK_GRACE_MS = 30_000;
const ACQUIRE_ATTEMPTS = 3;

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

// ---------- Process markers ----------

function markerPathFor(lockPath: string, pid: number, processNonce: string): string {
  return path.join(path.dirname(lockPath), '.process-owners', `${pid}-${processNonce}.lease`);
}

/**
 * Open marker descriptors held by this process, keyed by marker path and
 * reference-counted per outstanding lock so a long-lived process does not
 * accumulate one descriptor per lock directory it ever touched.
 */
interface HeldMarker {
  fd: number;
  refs: number;
}
const heldMarkers = new Map<string, HeldMarker>();
let markerExitHookInstalled = false;

function installMarkerExitHook(): void {
  if (markerExitHookInstalled) return;
  markerExitHookInstalled = true;
  process.once('exit', () => {
    for (const [markerPath, marker] of heldMarkers) {
      closeMarker(markerPath, marker);
    }
    heldMarkers.clear();
  });
}

function closeMarker(markerPath: string, marker: HeldMarker): void {
  try {
    const held = fs.fstatSync(marker.fd);
    const current = fs.lstatSync(markerPath);
    if (held.dev === current.dev && held.ino === current.ino) fs.unlinkSync(markerPath);
  } catch {
    // A missing marker file needs no unlink; a closed descriptor cannot prove ownership.
  }
  try {
    fs.closeSync(marker.fd);
  } catch {
    // The descriptor may already be closed during process teardown.
  }
}

function openMarkerFd(markerPath: string): number {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(markerPath, 'wx', 0o600);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    fs.unlinkSync(markerPath);
    fd = fs.openSync(markerPath, 'wx', 0o600);
  }
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({ schema_version: 1, pid: process.pid, process_nonce: PROCESS_NONCE }),
    );
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(markerPath);
    } catch {
      // An unusable marker cannot prove ownership of a lease.
    }
    throw error;
  }
  return fd;
}

/**
 * Ensure this process holds its marker file (open descriptor) next to
 * `lockPath` and take a reference on it. Re-verifies a cached descriptor
 * against the on-disk file so a deleted-and-recreated lock directory (e.g. a
 * cleared session directory) cannot leave a live lock looking stale to other
 * processes. Every retain is paired with a `releaseProcessMarker`.
 */
function retainProcessMarker(lockPath: string): string {
  const markerPath = markerPathFor(lockPath, process.pid, PROCESS_NONCE);
  const cached = heldMarkers.get(markerPath);
  if (cached !== undefined) {
    let intact = false;
    try {
      const held = fs.fstatSync(cached.fd);
      const current = fs.lstatSync(markerPath);
      intact = held.dev === current.dev && held.ino === current.ino;
    } catch {
      // Marker file vanished under the cached descriptor — recreate below.
    }
    if (intact) {
      cached.refs += 1;
      return markerPath;
    }
    try {
      fs.closeSync(cached.fd);
    } catch {
      // A stale descriptor cannot prove ownership either way.
    }
    cached.fd = openMarkerFd(markerPath);
    cached.refs += 1;
    return markerPath;
  }
  const fd = openMarkerFd(markerPath);
  heldMarkers.set(markerPath, { fd, refs: 1 });
  installMarkerExitHook();
  return markerPath;
}

function releaseProcessMarker(markerPath: string): void {
  const marker = heldMarkers.get(markerPath);
  if (marker === undefined) return;
  marker.refs -= 1;
  if (marker.refs > 0) return;
  heldMarkers.delete(markerPath);
  closeMarker(markerPath, marker);
}

function linuxProcessHoldsMarker(pid: number, markerPath: string): boolean | null {
  let marker: fs.Stats;
  let descriptors: string[];
  try {
    marker = fs.lstatSync(markerPath);
    if (!marker.isFile() || marker.isSymbolicLink()) return false;
    descriptors = fs.readdirSync(`/proc/${pid}/fd`);
  } catch (error) {
    if (isMissing(error)) return false;
    return null;
  }
  for (const descriptor of descriptors) {
    try {
      const openFile = fs.statSync(`/proc/${pid}/fd/${descriptor}`);
      if (openFile.dev === marker.dev && openFile.ino === marker.ino) return true;
    } catch (error) {
      if (!isMissing(error)) return null;
    }
  }
  return false;
}

function darwinProcessHoldsMarker(pid: number, markerPath: string): boolean | null {
  let canonicalMarkerPath: string;
  try {
    canonicalMarkerPath = fs.realpathSync(markerPath);
  } catch (error) {
    if (isMissing(error)) return false;
    return null;
  }
  const result = spawnSync(
    '/usr/sbin/lsof',
    ['-a', '-p', String(pid), '-Fn', '--', canonicalMarkerPath],
    {
      encoding: 'utf8',
      timeout: 1_000,
      maxBuffer: 16_384,
    },
  );
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) return null;
  if (result.status === 1) return false;
  return result.stdout.split('\n').some((line) => line === `n${canonicalMarkerPath}`);
}

function processHoldsOwnerMarker(lockPath: string, owner: OwnerRecord): boolean | null {
  const markerPath = markerPathFor(lockPath, owner.pid, owner.process_nonce);
  if (process.platform === 'linux') return linuxProcessHoldsMarker(owner.pid, markerPath);
  if (process.platform === 'darwin') return darwinProcessHoldsMarker(owner.pid, markerPath);
  return null;
}

// ---------- Owner records ----------

function readLockOwner(lockPath: string): OwnerRecord | null {
  let stats: fs.Stats;
  let raw: string;
  try {
    stats = fs.lstatSync(lockPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1_024) return null;
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort((a, b) => a.localeCompare(b));
    if (
      keys.join(',') !==
        'acquire_nonce,created_at_ms,pid,process_marker,process_nonce,schema_version' ||
      parsed.schema_version !== 3 ||
      typeof parsed.pid !== 'number' ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid < 1 ||
      typeof parsed.process_nonce !== 'string' ||
      !/^[a-f0-9]{32}$/.test(parsed.process_nonce) ||
      typeof parsed.acquire_nonce !== 'string' ||
      !/^[a-f0-9]{16}$/.test(parsed.acquire_nonce) ||
      parsed.process_marker !== PROCESS_MARKER_PROTOCOL ||
      typeof parsed.created_at_ms !== 'number' ||
      !Number.isSafeInteger(parsed.created_at_ms) ||
      parsed.created_at_ms < 0
    ) {
      return null;
    }
    return parsed as unknown as OwnerRecord;
  } catch {
    return null;
  }
}

function writeLockOwner(lockPath: string, owner: OwnerRecord): void {
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(owner));
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // A failed setup leaves no usable lock owned by this process.
    }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function lockOwnerIsCurrentProcess(owner: OwnerRecord): boolean {
  return owner.pid === process.pid && owner.process_nonce === PROCESS_NONCE;
}

function lockIsDefinitelyStale(
  lockPath: string,
  owner: OwnerRecord | null,
  options: OwnerFileLockOptions,
): boolean {
  if (owner) {
    if (owner.pid === process.pid) {
      if (lockOwnerIsCurrentProcess(owner)) return false;
      // Same pid, different nonce: either another lock-module instance
      // alive inside this very process (a worker thread's module registry,
      // or a second copy of the runtime loaded in-process) or pid reuse
      // across a restart. The marker probe distinguishes them — a live
      // sibling instance holds its marker file open in this pid, while a
      // dead restart's marker sits on disk held by nobody.
      return processHoldsOwnerMarker(lockPath, owner) === false;
    }
    if (!processIsLive(owner.pid)) return true;
    return processHoldsOwnerMarker(lockPath, owner) === false;
  }
  const now = options.now ?? Date.now;
  const grace = options.invalidLockGraceMs ?? DEFAULT_INVALID_LOCK_GRACE_MS;
  try {
    return now() - fs.lstatSync(lockPath).mtimeMs >= grace;
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
}

function currentOwnerRecord(options: OwnerFileLockOptions): OwnerRecord {
  return {
    schema_version: 3,
    pid: process.pid,
    process_nonce: PROCESS_NONCE,
    acquire_nonce: crypto.randomBytes(8).toString('hex'),
    process_marker: PROCESS_MARKER_PROTOCOL,
    created_at_ms: (options.now ?? Date.now)(),
  };
}

function ownerRecordsEqual(left: OwnerRecord | null, right: OwnerRecord | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.pid === right.pid &&
    left.process_nonce === right.process_nonce &&
    left.acquire_nonce === right.acquire_nonce &&
    left.created_at_ms === right.created_at_ms
  );
}

function withRecoveryGuard(
  lockPath: string,
  options: OwnerFileLockOptions,
  recover: () => void,
): boolean {
  const recoveryPath = `${lockPath}.recover`;
  const owner = currentOwnerRecord(options);
  let acquired = false;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      writeLockOwner(recoveryPath, owner);
      acquired = true;
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const current = readLockOwner(recoveryPath);
      if (!lockIsDefinitelyStale(recoveryPath, current, options)) return false;
      // The verdict binds to the record it was computed for: delete only
      // while the on-disk record is still that record, so a guard released
      // and re-taken between verdict and unlink survives.
      if (!ownerRecordsEqual(readLockOwner(recoveryPath), current)) continue;
      try {
        fs.unlinkSync(recoveryPath);
      } catch (unlinkError) {
        if (!isMissing(unlinkError)) throw unlinkError;
      }
    }
  }
  if (!acquired) return false;
  try {
    recover();
    return true;
  } finally {
    releaseOwnedRecord(recoveryPath, owner);
  }
}

function recoverStaleLock(lockPath: string, options: OwnerFileLockOptions): boolean {
  return withRecoveryGuard(lockPath, options, () => {
    const owner = readLockOwner(lockPath);
    if (!fs.existsSync(lockPath)) return;
    if (!lockIsDefinitelyStale(lockPath, owner, options)) return;
    // The stale verdict binds to `owner`: the judged holder may have released
    // and a NEW holder acquired between the read above and this delete (the
    // marker probe reads ENOENT for a released marker, which satisfies
    // "verifiably not held"). Delete only while the on-disk record is still
    // the judged one — `acquire_nonce` makes every hold's record unique, so
    // equality proves no turnover happened.
    if (!ownerRecordsEqual(readLockOwner(lockPath), owner)) return;
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  });
}

function releaseOwnedRecord(lockPath: string, owner: OwnerRecord): void {
  const current = readLockOwner(lockPath);
  if (
    !current ||
    current.pid !== owner.pid ||
    current.process_nonce !== owner.process_nonce ||
    current.created_at_ms !== owner.created_at_ms
  ) {
    return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // A retained lock is recovered from its owner record after this process exits.
  }
}

// ---------- Public lock API ----------

/**
 * Acquire the lock or return null when a live owner holds it. Stale locks
 * (per the module policy above) are recovered inline. The returned handle
 * MUST be passed to `releaseOwnerFileLock` — prefer `withOwnerFileLock` /
 * `withOwnerFileLockAsync` unless the hold spans a non-lexical lifetime
 * (e.g. a daemon holding its singleton lock until shutdown).
 */
export function tryAcquireOwnerFileLock(
  lockPath: string,
  options: OwnerFileLockOptions = {},
): OwnerFileLockHandle | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const markerPath = retainProcessMarker(lockPath);
  const owner = currentOwnerRecord(options);
  try {
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        writeLockOwner(lockPath, owner);
        return { lockPath, owner, markerPath };
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const current = readLockOwner(lockPath);
        if (!lockIsDefinitelyStale(lockPath, current, options)) break;
        if (!recoverStaleLock(lockPath, options)) break;
      }
    }
  } catch (error) {
    releaseProcessMarker(markerPath);
    throw error;
  }
  releaseProcessMarker(markerPath);
  return null;
}

export function releaseOwnerFileLock(handle: OwnerFileLockHandle): void {
  releaseOwnedRecord(handle.lockPath, handle.owner);
  releaseProcessMarker(handle.markerPath);
}

export function withOwnerFileLock<Value>(
  lockPath: string,
  operation: () => Value,
  options: OwnerFileLockOptions = {},
): Value {
  const handle = tryAcquireOwnerFileLock(lockPath, options);
  if (handle === null) {
    throw options.onLocked?.() ?? new OwnerFileLockError(lockPath);
  }
  try {
    return operation();
  } finally {
    releaseOwnerFileLock(handle);
  }
}

export async function withOwnerFileLockAsync<Value>(
  lockPath: string,
  operation: () => Promise<Value>,
  options: OwnerFileLockOptions = {},
): Promise<Value> {
  const handle = tryAcquireOwnerFileLock(lockPath, options);
  if (handle === null) {
    throw options.onLocked?.() ?? new OwnerFileLockError(lockPath);
  }
  try {
    return await operation();
  } finally {
    releaseOwnerFileLock(handle);
  }
}

// ---------- Atomic writers ----------

export interface AtomicWriteOptions {
  /** File mode for the written file (default: process umask). */
  mode?: number;
  /** fsync the file and its directory before/after the rename (durability). */
  fsync?: boolean;
}

export function writeTextAtomically(
  filePath: string,
  value: string,
  options: AtomicWriteOptions = {},
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    if (options.mode !== undefined || options.fsync) {
      const fd = fs.openSync(temporaryPath, 'wx', options.mode ?? 0o666);
      try {
        fs.writeFileSync(fd, value);
        if (options.mode !== undefined) fs.fchmodSync(fd, options.mode);
        if (options.fsync) fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      fs.writeFileSync(temporaryPath, value);
    }
    fs.renameSync(temporaryPath, filePath);
    if (options.fsync) {
      const dirFd = fs.openSync(path.dirname(filePath), 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    }
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary path is absent after a successful atomic rename.
    }
  }
}

export function writeJsonAtomically(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): void {
  writeTextAtomically(filePath, JSON.stringify(value, null, 2), options);
}

// ---------- Serialized read-modify-write ----------

export interface JsonFileCodec<T> {
  /** Parse raw file contents (null when the file is missing). */
  read: (raw: string | null) => T;
  /** Serialize the value for the atomic write. */
  write: (value: T) => string;
}

/**
 * Codec for best-effort JSON state files: a missing, corrupt, or non-object
 * file reads as `empty()` and the next write repairs it.
 */
export function looseJsonCodec<T extends object>(empty: () => T): JsonFileCodec<T> {
  return {
    read: (raw) => {
      if (raw === null) return empty();
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          return parsed as T;
        }
      } catch {
        // Corrupt file — start from the empty shape.
      }
      return empty();
    },
    write: (value) => JSON.stringify(value, null, 2),
  };
}

export interface UpdateJsonFileOptions extends OwnerFileLockOptions, AtomicWriteOptions {}

/**
 * Serialized read-modify-write over a shared JSON file. Acquires
 * `<file>.lock` (owner-file policy above), reads through the codec, applies
 * `mutate`, and atomically writes the result. Returning `null` from `mutate`
 * skips the write. Returns true when a write happened.
 */
export function updateJsonFile<T>(
  filePath: string,
  codec: JsonFileCodec<T>,
  mutate: (value: T) => T | null,
  options: UpdateJsonFileOptions = {},
): boolean {
  return withOwnerFileLock(
    `${filePath}.lock`,
    () => {
      let raw: string | null;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch (error) {
        if (!isMissing(error)) throw error;
        raw = null;
      }
      const next = mutate(codec.read(raw));
      if (next === null) return false;
      writeTextAtomically(filePath, codec.write(next), {
        mode: options.mode,
        fsync: options.fsync,
      });
      return true;
    },
    options,
  );
}

/**
 * Whole-file replace serialized against `updateJsonFile` writers of the same
 * path: acquires `<file>.lock`, then writes atomically. Authoritative
 * snapshot writers (e.g. a browser context's storage state persisted at
 * session close) go through this so a concurrent read-modify-write of the
 * same file can neither read a torn write nor rename a stale merge over the
 * snapshot. Throws the lock's `onLocked` error (`OwnerFileLockError` by
 * default) when a live owner holds the lock.
 */
export function writeTextUnderFileLock(
  filePath: string,
  value: string,
  options: UpdateJsonFileOptions = {},
): void {
  withOwnerFileLock(
    `${filePath}.lock`,
    () => {
      writeTextAtomically(filePath, value, { mode: options.mode, fsync: options.fsync });
    },
    options,
  );
}
