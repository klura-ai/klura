import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseExactRecord,
  parseInteger,
  parsePackageId,
  parseSessionName,
  parseSha256Digest,
  parseStableContractId,
  PublicContractError,
  sha256Digest,
  type PackageIdV1,
  type SessionNameV1,
  type Sha256DigestV1,
  type StableContractIdV1,
} from '../../public/contracts/common';
import {
  assertJsonValue,
  canonicalJson,
  parseStrictJson,
  type JsonValueV1,
} from '../../public/contracts/json';
import { parseRunId, type RunIdV1 } from '../scrape/journal';
import { isRunTerminalOrUnstarted } from '../scrape/run-store';
import { withOwnerFileLock } from '../../utils/owner-file-lock';

const SESSION_POINTER_BYTES_V1 = 16 * 1024;
const SESSION_GENERATION_BYTES_V1 = 8 * 1024 * 1024;
const SESSION_STATE_BYTES_V1 = 4 * 1024 * 1024;
const SESSION_KEY_BYTES_V1 = 32;

export interface LocalSessionPointerV1 {
  session_schema_version: 1;
  package_id: PackageIdV1;
  authentication_contract_id: StableContractIdV1;
  session_name: SessionNameV1;
  generation: number;
  state_digest: Sha256DigestV1;
  authentication_contract_digest: Sha256DigestV1;
  lease: null | {
    owner_kind: 'run';
    owner_id: RunIdV1;
    base_generation: number;
  };
}

export interface LocalSessionSelectorV1 {
  package_id: PackageIdV1 | string;
  authentication_contract_id: StableContractIdV1 | string;
  session_name: SessionNameV1 | string;
}

export interface CommitLocalSessionInputV1 extends LocalSessionSelectorV1 {
  authentication_contract_digest: Sha256DigestV1 | string;
  state: JsonValueV1;
}

export interface ReadLocalSessionV1 {
  pointer: LocalSessionPointerV1;
  state: JsonValueV1;
}

interface EncryptedSessionGenerationV1 {
  session_generation_schema_version: 1;
  algorithm: 'aes-256-gcm';
  state_digest: Sha256DigestV1;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface SessionStorePathsV1 {
  home: string;
  sessions: string;
  encryption_key: string;
}

export class SessionStoreError extends PublicContractError {
  constructor(
    public readonly code: 'session_not_found' | 'session_in_use' | 'local_state_invalid',
    message: string,
  ) {
    super('session_store', message);
    this.name = 'SessionStoreError';
  }
}

/** Owns private immutable browser-storage generations for managed capabilities. */
export class SessionStoreV1 {
  readonly paths: SessionStorePathsV1;

  constructor(home: string) {
    const sessions = path.join(home, 'sessions');
    this.paths = { home, sessions, encryption_key: path.join(sessions, 'key.v1') };
  }

  commit(input: CommitLocalSessionInputV1): LocalSessionPointerV1 {
    const selector = parseSelector(input, 'session.commit');
    const contractDigest = parseSha256Digest(
      input.authentication_contract_digest,
      'session.commit.authentication_contract_digest',
    );
    assertJsonValue(input.state, 'session.commit.state', 12);
    const stateBytes = Buffer.from(canonicalJson(input.state), 'utf8');
    if (stateBytes.byteLength > SESSION_STATE_BYTES_V1) {
      throw new PublicContractError(
        'session.commit.state',
        `must be at most ${SESSION_STATE_BYTES_V1} UTF-8 bytes`,
      );
    }
    return this.withLock(selector, () => {
      const existing = this.readPointer(selector);
      if (existing?.lease !== null && existing?.lease !== undefined) {
        throw new SessionStoreError('session_in_use', 'session is leased by a scrape run');
      }
      const generation = this.nextAvailableGeneration(selector, (existing?.generation ?? 0) + 1);
      const stateDigest = sha256Digest(stateBytes);
      const pointer: LocalSessionPointerV1 = {
        session_schema_version: 1,
        package_id: selector.package_id,
        authentication_contract_id: selector.authentication_contract_id,
        session_name: selector.session_name,
        generation,
        state_digest: stateDigest,
        authentication_contract_digest: contractDigest,
        lease: null,
      };
      const envelope = encryptSessionState(this.readEncryptionKey(), pointer, stateBytes);
      writeExclusive(
        this.generationPath(selector, generation),
        Buffer.from(canonicalJson(envelope as unknown as JsonValueV1), 'utf8'),
      );
      writeAtomic(
        this.pointerPath(selector),
        Buffer.from(canonicalJson(pointer as unknown as JsonValueV1), 'utf8'),
      );
      return pointer;
    });
  }

  read(selector: LocalSessionSelectorV1): ReadLocalSessionV1 {
    const parsed = parseSelector(selector, 'session.read');
    const pointer = this.requirePointer(parsed);
    try {
      const bytes = readPrivateFile(
        this.generationPath(parsed, pointer.generation),
        'session.generation',
      );
      const envelope = parseEncryptedSessionGeneration(
        parseStrictJson(bytes, 'session.generation', SESSION_GENERATION_BYTES_V1, 12),
        'session.generation',
      );
      if (envelope.state_digest !== pointer.state_digest) {
        throw new SessionStoreError(
          'local_state_invalid',
          'session generation digest differs from pointer',
        );
      }
      const stateBytes = decryptSessionState(this.readEncryptionKey(), pointer, envelope);
      if (sha256Digest(stateBytes) !== pointer.state_digest) {
        throw new SessionStoreError('local_state_invalid', 'session state digest does not verify');
      }
      return {
        pointer,
        state: parseStrictJson(stateBytes, 'session.state', SESSION_STATE_BYTES_V1, 12),
      };
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      if (error instanceof PublicContractError || isMissing(error)) {
        throw new SessionStoreError('local_state_invalid', 'session generation is invalid');
      }
      throw error;
    }
  }

  getPointer(selector: LocalSessionSelectorV1): LocalSessionPointerV1 | null {
    return this.readPointer(parseSelector(selector, 'session.pointer'));
  }

  listAuthenticationContractIds(
    packageId: PackageIdV1 | string,
    sessionName: SessionNameV1 | string,
  ): StableContractIdV1[] {
    const parsedPackage = parsePackageId(packageId, 'session.list.package_id');
    const parsedName = parseSessionName(sessionName, 'session.list.session_name');
    const packageDirectory = path.join(this.paths.sessions, parsedPackage);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(packageDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const contractIds: StableContractIdV1[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new SessionStoreError('local_state_invalid', 'session realm directory is invalid');
      }
      const authenticationContractId = parseStableContractId(
        entry.name,
        'session.list.authentication_contract_id',
      );
      const selector: ParsedSessionSelectorV1 = {
        package_id: parsedPackage,
        authentication_contract_id: authenticationContractId,
        session_name: parsedName,
      };
      const pointer = this.readPointer(selector);
      if (pointer !== null) contractIds.push(authenticationContractId);
    }
    return contractIds.sort(compareText);
  }

  claimRunLease(selector: LocalSessionSelectorV1, runId: string): LocalSessionPointerV1 {
    const parsed = parseSelector(selector, 'session.claim_lease');
    const ownerId = parseRunId(runId, 'session.claim_lease.run_id');
    return this.withLock(parsed, () => {
      const pointer = this.releaseStaleRunLeaseIfSafe(parsed, this.requirePointer(parsed));
      if (pointer === null) {
        throw new SessionStoreError('session_not_found', 'session does not exist');
      }
      if (pointer.lease !== null) {
        throw new SessionStoreError('session_in_use', 'session is already leased');
      }
      const next: LocalSessionPointerV1 = {
        ...pointer,
        lease: { owner_kind: 'run', owner_id: ownerId, base_generation: pointer.generation },
      };
      this.writePointer(parsed, next);
      return next;
    });
  }

  releaseRunLease(selector: LocalSessionSelectorV1, runId: string): LocalSessionPointerV1 {
    const parsed = parseSelector(selector, 'session.release_lease');
    const ownerId = parseRunId(runId, 'session.release_lease.run_id');
    return this.withLock(parsed, () => {
      const pointer = this.requirePointer(parsed);
      if (pointer.lease?.owner_id !== ownerId) {
        throw new SessionStoreError('session_in_use', 'session lease belongs to another run');
      }
      const next: LocalSessionPointerV1 = { ...pointer, lease: null };
      this.writePointer(parsed, next);
      return next;
    });
  }

  clear(selector: LocalSessionSelectorV1): boolean {
    const parsed = parseSelector(selector, 'session.clear');
    return this.withLock(parsed, () => {
      const pointer = this.readPointer(parsed);
      if (pointer === null) return false;
      if (pointer.lease !== null) {
        throw new SessionStoreError('session_in_use', 'session is leased by a scrape run');
      }
      this.read(parsed);
      fs.rmSync(this.sessionDirectory(parsed), { recursive: true, force: false });
      return true;
    });
  }

  private readPointer(selector: ParsedSessionSelectorV1): LocalSessionPointerV1 | null {
    try {
      const bytes = readPrivateFile(this.pointerPath(selector), 'session.pointer');
      const pointer = parseLocalSessionPointer(
        parseStrictJson(bytes, 'session.pointer', SESSION_POINTER_BYTES_V1, 8),
        'session.pointer',
      );
      assertPointerSelector(pointer, selector);
      return pointer;
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof SessionStoreError || error instanceof PublicContractError) {
        throw new SessionStoreError('local_state_invalid', error.message);
      }
      throw error;
    }
  }

  private requirePointer(selector: ParsedSessionSelectorV1): LocalSessionPointerV1 {
    const pointer = this.readPointer(selector);
    if (pointer === null)
      throw new SessionStoreError('session_not_found', 'session does not exist');
    return pointer;
  }

  /**
   * A lease is recoverable only when durable run state proves that its owner
   * cannot still dispatch traffic. Corrupt or nonterminal journals remain locked.
   */
  private releaseStaleRunLeaseIfSafe(
    selector: ParsedSessionSelectorV1,
    pointer: LocalSessionPointerV1 | null,
  ): LocalSessionPointerV1 | null {
    if (pointer?.lease === null || pointer?.lease === undefined) return pointer;
    if (!this.isRunLeaseTerminalOrUnstarted(pointer.lease.owner_id)) return pointer;
    const next: LocalSessionPointerV1 = { ...pointer, lease: null };
    this.writePointer(selector, next);
    return next;
  }

  private isRunLeaseTerminalOrUnstarted(runId: RunIdV1): boolean {
    return isRunTerminalOrUnstarted(this.paths.home, runId);
  }

  private writePointer(selector: ParsedSessionSelectorV1, pointer: LocalSessionPointerV1): void {
    assertPointerSelector(pointer, selector);
    writeAtomic(
      this.pointerPath(selector),
      Buffer.from(canonicalJson(pointer as unknown as JsonValueV1), 'utf8'),
    );
  }

  private withLock<T>(selector: ParsedSessionSelectorV1, operation: () => T): T {
    this.ensureDirectories(selector);
    const lockPath = path.join(this.sessionDirectory(selector), 'session.lock');
    return withOwnerFileLock(lockPath, operation, {
      onLocked: () =>
        new SessionStoreError('session_in_use', 'session is locked by another local process'),
    });
  }

  private readEncryptionKey(): Buffer {
    this.ensureSessionRoot();
    try {
      const key = readPrivateFile(this.paths.encryption_key, 'session.key');
      if (key.byteLength !== SESSION_KEY_BYTES_V1) {
        throw new SessionStoreError(
          'local_state_invalid',
          'session encryption key has an invalid length',
        );
      }
      return key;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const key = randomBytes(SESSION_KEY_BYTES_V1);
      try {
        writeExclusive(this.paths.encryption_key, key);
        return key;
      } catch (writeError) {
        if (!isExists(writeError)) throw writeError;
        const existing = readPrivateFile(this.paths.encryption_key, 'session.key');
        if (existing.byteLength !== SESSION_KEY_BYTES_V1) {
          throw new SessionStoreError(
            'local_state_invalid',
            'session encryption key has an invalid length',
          );
        }
        return existing;
      }
    }
  }

  private ensureSessionRoot(): void {
    fs.mkdirSync(this.paths.home, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.paths.home, 0o700);
    fs.mkdirSync(this.paths.sessions, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.paths.sessions, 0o700);
  }

  private ensureDirectories(selector: ParsedSessionSelectorV1): void {
    this.ensureSessionRoot();
    for (const directory of [
      path.join(this.paths.sessions, selector.package_id),
      path.join(this.paths.sessions, selector.package_id, selector.authentication_contract_id),
      this.sessionDirectory(selector),
    ]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
    }
  }

  private sessionDirectory(selector: ParsedSessionSelectorV1): string {
    return path.join(
      this.paths.sessions,
      selector.package_id,
      selector.authentication_contract_id,
      selector.session_name,
    );
  }

  private pointerPath(selector: ParsedSessionSelectorV1): string {
    return path.join(this.sessionDirectory(selector), 'pointer.json');
  }

  private generationPath(selector: ParsedSessionSelectorV1, generation: number): string {
    return path.join(this.sessionDirectory(selector), `generation-${generation}.json`);
  }

  private nextAvailableGeneration(selector: ParsedSessionSelectorV1, initial: number): number {
    let generation = initial;
    while (fs.existsSync(this.generationPath(selector, generation))) {
      if (generation === Number.MAX_SAFE_INTEGER) {
        throw new SessionStoreError(
          'local_state_invalid',
          'session generation counter is exhausted',
        );
      }
      generation += 1;
    }
    return generation;
  }
}

interface ParsedSessionSelectorV1 {
  package_id: PackageIdV1;
  authentication_contract_id: StableContractIdV1;
  session_name: SessionNameV1;
}

function parseSelector(value: LocalSessionSelectorV1, field: string): ParsedSessionSelectorV1 {
  return {
    package_id: parsePackageId(value.package_id, `${field}.package_id`),
    authentication_contract_id: parseStableContractId(
      value.authentication_contract_id,
      `${field}.authentication_contract_id`,
    ),
    session_name: parseSessionName(value.session_name, `${field}.session_name`),
  };
}

function parseLocalSessionPointer(value: unknown, field: string): LocalSessionPointerV1 {
  const record = parseExactRecord(value, field, [
    'session_schema_version',
    'package_id',
    'authentication_contract_id',
    'session_name',
    'generation',
    'state_digest',
    'authentication_contract_digest',
    'lease',
  ]);
  if (record.session_schema_version !== 1) {
    throw new PublicContractError(`${field}.session_schema_version`, 'must be 1');
  }
  return {
    session_schema_version: 1,
    package_id: parsePackageId(record.package_id, `${field}.package_id`),
    authentication_contract_id: parseStableContractId(
      record.authentication_contract_id,
      `${field}.authentication_contract_id`,
    ),
    session_name: parseSessionName(record.session_name, `${field}.session_name`),
    generation: parseInteger(record.generation, `${field}.generation`, 1, Number.MAX_SAFE_INTEGER),
    state_digest: parseSha256Digest(record.state_digest, `${field}.state_digest`),
    authentication_contract_digest: parseSha256Digest(
      record.authentication_contract_digest,
      `${field}.authentication_contract_digest`,
    ),
    lease: parseLease(record.lease, `${field}.lease`),
  };
}

function parseLease(value: unknown, field: string): LocalSessionPointerV1['lease'] {
  if (value === null) return null;
  const record = parseExactRecord(value, field, ['owner_kind', 'owner_id', 'base_generation']);
  if (record.owner_kind !== 'run') {
    throw new PublicContractError(`${field}.owner_kind`, 'must be run');
  }
  return {
    owner_kind: 'run',
    owner_id: parseRunId(record.owner_id, `${field}.owner_id`),
    base_generation: parseInteger(
      record.base_generation,
      `${field}.base_generation`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function parseEncryptedSessionGeneration(
  value: unknown,
  field: string,
): EncryptedSessionGenerationV1 {
  const record = parseExactRecord(value, field, [
    'session_generation_schema_version',
    'algorithm',
    'state_digest',
    'nonce',
    'ciphertext',
    'tag',
  ]);
  if (record.session_generation_schema_version !== 1) {
    throw new PublicContractError(`${field}.session_generation_schema_version`, 'must be 1');
  }
  if (record.algorithm !== 'aes-256-gcm') {
    throw new PublicContractError(`${field}.algorithm`, 'must be aes-256-gcm');
  }
  const nonce = parseBase64UrlBytes(record.nonce, `${field}.nonce`, 12);
  const tag = parseBase64UrlBytes(record.tag, `${field}.tag`, 16);
  const ciphertext = parseBase64UrlBytes(
    record.ciphertext,
    `${field}.ciphertext`,
    SESSION_STATE_BYTES_V1 + 16,
  );
  if (ciphertext.byteLength === 0) {
    throw new PublicContractError(`${field}.ciphertext`, 'must not be empty');
  }
  return {
    session_generation_schema_version: 1,
    algorithm: 'aes-256-gcm',
    state_digest: parseSha256Digest(record.state_digest, `${field}.state_digest`),
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: tag.toString('base64url'),
  };
}

function encryptSessionState(
  key: Buffer,
  pointer: LocalSessionPointerV1,
  state: Buffer,
): EncryptedSessionGenerationV1 {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(sessionAad(pointer));
  const ciphertext = Buffer.concat([cipher.update(state), cipher.final()]);
  return {
    session_generation_schema_version: 1,
    algorithm: 'aes-256-gcm',
    state_digest: pointer.state_digest,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

function decryptSessionState(
  key: Buffer,
  pointer: LocalSessionPointerV1,
  envelope: EncryptedSessionGenerationV1,
): Buffer {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      parseBase64UrlBytes(envelope.nonce, 'session.generation.nonce', 12),
    );
    decipher.setAAD(sessionAad(pointer));
    decipher.setAuthTag(parseBase64UrlBytes(envelope.tag, 'session.generation.tag', 16));
    return Buffer.concat([
      decipher.update(
        parseBase64UrlBytes(
          envelope.ciphertext,
          'session.generation.ciphertext',
          SESSION_STATE_BYTES_V1 + 16,
        ),
      ),
      decipher.final(),
    ]);
  } catch (error) {
    if (error instanceof PublicContractError) throw error;
    throw new SessionStoreError('local_state_invalid', 'session generation cannot be decrypted');
  }
}

function sessionAad(pointer: LocalSessionPointerV1): Buffer {
  return Buffer.from(
    canonicalJson({
      package_id: pointer.package_id,
      authentication_contract_id: pointer.authentication_contract_id,
      session_name: pointer.session_name,
      generation: pointer.generation,
      authentication_contract_digest: pointer.authentication_contract_digest,
      state_digest: pointer.state_digest,
    }),
    'utf8',
  );
}

function parseBase64UrlBytes(value: unknown, field: string, expectedMaximum: number): Buffer {
  const maximumEncodedLength = Math.ceil((expectedMaximum * 4) / 3) + 4;
  if (
    typeof value !== 'string' ||
    value.length > maximumEncodedLength ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1
  ) {
    throw new PublicContractError(field, 'must be unpadded base64url');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > expectedMaximum ||
    bytes.toString('base64url') !== value
  ) {
    throw new PublicContractError(field, 'must be canonical bounded base64url');
  }
  return bytes;
}

function assertPointerSelector(
  pointer: LocalSessionPointerV1,
  selector: ParsedSessionSelectorV1,
): void {
  if (
    pointer.package_id !== selector.package_id ||
    pointer.authentication_contract_id !== selector.authentication_contract_id ||
    pointer.session_name !== selector.session_name
  ) {
    throw new SessionStoreError(
      'local_state_invalid',
      'session pointer does not match its directory',
    );
  }
}

function writeExclusive(target: string, bytes: Buffer): void {
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(target));
}

function writeAtomic(target: string, bytes: Buffer): void {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, target);
    fsyncDirectory(path.dirname(target));
  } finally {
    if (fd !== null) fs.closeSync(fd);
    removeTemporary(temporary);
  }
}

function removeTemporary(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    return;
  }
}

function readPrivateFile(filePath: string, field: string): Buffer {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new SessionStoreError('local_state_invalid', `${field} must be a regular private file`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new SessionStoreError(
      'local_state_invalid',
      `${field} must not be group or world readable`,
    );
  }
  return fs.readFileSync(filePath);
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
