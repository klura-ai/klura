import fs from 'node:fs';
import path from 'node:path';
import {
  parseBoundedRecord,
  parseCapabilityId,
  parseExactRecord,
  parseInteger,
  parsePackageId,
  parsePackageVersion,
  parseRfc3339Instant,
  parseRuntimeRange,
  parseSessionName,
  parseSha256Digest,
  parseStableContractId,
  PublicContractError,
  sha256Digest,
  type CapabilityIdV1,
  type PackageIdV1,
  type PackageVersionV1,
  type Rfc3339InstantV1,
  type RuntimeRangeV1,
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
import {
  parseScrapeRunPolicy,
  type EffectiveRunBoundsV1,
} from '../../public/contracts/scrape-policy';
import {
  parseRunId,
  parseRunOperationId,
  readJournal,
  type RunIdV1,
  type RunOperationIdV1,
} from './journal';
import { parseRunOutput, type RunOutputV1 } from './output';
import { withOwnerFileLockAsync } from '../../utils/owner-file-lock';

const META_MAX_BYTES_V1 = 1024 * 1024;

export interface RunArtifactRefV1 {
  package_id: PackageIdV1;
  version: PackageVersionV1;
  package_digest: Sha256DigestV1;
  capability: CapabilityIdV1;
  runtime_range: RuntimeRangeV1;
  collection_contract_digest: Sha256DigestV1;
}

/**
 * Identifies the exact locally encrypted browser-state generation used by a run.
 * The state itself stays exclusively in the session store.
 */
export interface RunSessionReferenceV1 {
  authentication_contract_id: StableContractIdV1;
  session_name: SessionNameV1;
  generation: number;
  state_digest: Sha256DigestV1;
  authentication_contract_digest: Sha256DigestV1;
}

export interface RunMetaV1 {
  meta_schema_version: 1;
  run_id: RunIdV1;
  start_operation_id: RunOperationIdV1;
  artifact: RunArtifactRefV1;
  canonical_input: JsonValueV1;
  selected_input_mode_id: StableContractIdV1;
  effective_bounds: EffectiveRunBoundsV1;
  output: RunOutputV1;
  created_at: Rfc3339InstantV1;
  /** Absent on runs created before session-pinned execution was available. */
  session?: RunSessionReferenceV1;
}

export interface RunMetaEnvelopeV1 {
  meta_envelope_schema_version: 1;
  payload: RunMetaV1;
  meta_digest: Sha256DigestV1;
}

export interface RunStorePathsV1 {
  home: string;
  runs: string;
}

// The `runs/<run_id>/{meta.json,journal.log,data.spool}` layout is owned here
// and nowhere else. Collaborators that need a run's on-disk location (the
// session store's stale-lease recovery, startup recovery) go through these
// accessors so a layout change cascades from one place.

export function runDirectoryPath(home: string, runId: RunIdV1): string {
  return path.join(home, 'runs', runId);
}

export function runMetaPath(home: string, runId: RunIdV1): string {
  return path.join(runDirectoryPath(home, runId), 'meta.json');
}

export function runJournalPath(home: string, runId: RunIdV1): string {
  return path.join(runDirectoryPath(home, runId), 'journal.log');
}

export function runDataSpoolPath(home: string, runId: RunIdV1): string {
  return path.join(runDirectoryPath(home, runId), 'data.spool');
}

/**
 * True when durable run state proves the run can no longer dispatch traffic:
 * its meta or journal never came into existence (run never started), or the
 * journal's last frame is terminal. Corrupt or nonterminal journals return
 * false. The session store's stale-lease recovery consumes this — the run
 * layout and terminal-frame read stay owned by the run store.
 */
export function isRunTerminalOrUnstarted(home: string, runId: RunIdV1): boolean {
  const metaPath = runMetaPath(home, runId);
  const journalPath = runJournalPath(home, runId);
  try {
    const meta = fs.lstatSync(metaPath);
    if (!meta.isFile() || meta.isSymbolicLink()) return false;
  } catch (error) {
    return isMissing(error);
  }
  let journal: fs.Stats;
  try {
    journal = fs.lstatSync(journalPath);
  } catch (error) {
    return isMissing(error);
  }
  if (!journal.isFile() || journal.isSymbolicLink()) return false;
  try {
    const frames = readJournal(fs.readFileSync(journalPath), runId).frames;
    if (frames.length === 0) return true;
    return frames.at(-1)?.body.event.kind === 'terminal';
  } catch {
    return false;
  }
}

export class RunStoreV1 {
  readonly paths: RunStorePathsV1;

  constructor(home: string) {
    this.paths = { home, runs: path.join(home, 'runs') };
  }

  create(meta: RunMetaV1): RunMetaEnvelopeV1 {
    const parsed = parseRunMeta(meta, 'run.meta');
    const directory = this.runDirectory(parsed.run_id);
    this.ensureRunsDirectory();
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (isExists(error)) throw new PublicContractError('run_id', 'already exists');
      throw error;
    }
    fs.chmodSync(directory, 0o700);
    const envelope = createRunMetaEnvelope(parsed);
    writeExclusive(
      path.join(directory, 'meta.json'),
      Buffer.from(canonicalJson(envelope as unknown as JsonValueV1)),
    );
    writeExclusive(path.join(directory, 'journal.log'), Buffer.alloc(0));
    writeExclusive(path.join(directory, 'data.spool'), Buffer.alloc(0));
    return envelope;
  }

  read(runId: string): RunMetaEnvelopeV1 {
    const parsedRunId = parseRunId(runId, 'run_id');
    const metaPath = path.join(this.runDirectory(parsedRunId), 'meta.json');
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(metaPath);
    } catch (error) {
      if (isMissing(error)) throw new PublicContractError('run_id', 'is not found');
      throw error;
    }
    return parseRunMetaEnvelope(
      parseStrictJson(bytes, 'run.meta.json', META_MAX_BYTES_V1, 12),
      'run.meta.json',
    );
  }

  journalPath(runId: string): string {
    return runJournalPath(this.paths.home, parseRunId(runId, 'run_id'));
  }

  dataSpoolPath(runId: string): string {
    return runDataSpoolPath(this.paths.home, parseRunId(runId, 'run_id'));
  }

  discard(runId: string): void {
    const parsedRunId = parseRunId(runId, 'run_id');
    const directory = this.runDirectory(parsedRunId);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(directory);
    } catch (error) {
      if (isMissing(error)) throw new PublicContractError('run_id', 'is not found');
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new PublicContractError('run_directory', 'must be a regular run directory');
    }
    fs.rmSync(directory, { recursive: true, force: false });
  }

  listRunIds(): RunIdV1[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.paths.runs, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const runIds: RunIdV1[] = [];
    for (const entry of entries) {
      if (!entry.name.startsWith('run_v1_')) continue;
      const runId = parseRunId(entry.name, 'run_directory');
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new PublicContractError('run_directory', 'must be a regular run directory');
      }
      runIds.push(runId);
    }
    return runIds;
  }

  async withResumeLease<T>(runId: RunIdV1, operation: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.runDirectory(runId), 'resume.lock');
    return withOwnerFileLockAsync(lockPath, operation, {
      onLocked: () => new RunLeaseError('another local process is resuming this run'),
    });
  }

  private ensureRunsDirectory(): void {
    fs.mkdirSync(this.paths.home, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.paths.home, 0o700);
    fs.mkdirSync(this.paths.runs, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.paths.runs, 0o700);
  }

  private runDirectory(runId: RunIdV1): string {
    return runDirectoryPath(this.paths.home, runId);
  }
}

export class RunLeaseError extends PublicContractError {
  constructor(message: string) {
    super('run.resume', message);
    this.name = 'RunLeaseError';
  }
}

export function createRunMetaEnvelope(meta: RunMetaV1): RunMetaEnvelopeV1 {
  const payload = parseRunMeta(meta, 'run.meta');
  return {
    meta_envelope_schema_version: 1,
    payload,
    meta_digest: sha256Digest(canonicalJson(payload as unknown as JsonValueV1)),
  };
}

export function parseRunMetaEnvelope(value: unknown, field: string): RunMetaEnvelopeV1 {
  const record = parseExactRecord(value, field, [
    'meta_envelope_schema_version',
    'payload',
    'meta_digest',
  ]);
  if (record.meta_envelope_schema_version !== 1) {
    throw new PublicContractError(`${field}.meta_envelope_schema_version`, 'must be 1');
  }
  const payload = parseRunMeta(record.payload, `${field}.payload`);
  const digest = parseSha256Digest(record.meta_digest, `${field}.meta_digest`);
  if (digest !== sha256Digest(canonicalJson(payload as unknown as JsonValueV1))) {
    throw new PublicContractError(`${field}.meta_digest`, 'does not match canonical metadata');
  }
  return { meta_envelope_schema_version: 1, payload, meta_digest: digest };
}

function parseRunMeta(value: unknown, field: string): RunMetaV1 {
  const record = parseBoundedRecord(value, field, 10);
  const requiredKeys = [
    'meta_schema_version',
    'run_id',
    'start_operation_id',
    'artifact',
    'canonical_input',
    'selected_input_mode_id',
    'effective_bounds',
    'output',
    'created_at',
  ] as const;
  const allowedKeys = new Set([...requiredKeys, 'session']);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new PublicContractError(`${field}.${key}`, 'is not allowed');
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) {
      throw new PublicContractError(`${field}.${key}`, 'is required');
    }
  }
  if (record.meta_schema_version !== 1) {
    throw new PublicContractError(`${field}.meta_schema_version`, 'must be 1');
  }
  assertJsonValue(record.canonical_input, `${field}.canonical_input`, 12);
  const parsed: RunMetaV1 = {
    meta_schema_version: 1,
    run_id: parseRunId(record.run_id, `${field}.run_id`),
    start_operation_id: parseRunOperationId(
      record.start_operation_id,
      `${field}.start_operation_id`,
    ),
    artifact: parseArtifact(record.artifact, `${field}.artifact`),
    canonical_input: record.canonical_input,
    selected_input_mode_id: parseStableContractId(
      record.selected_input_mode_id,
      `${field}.selected_input_mode_id`,
    ),
    effective_bounds: parseEffectiveBounds(record.effective_bounds, `${field}.effective_bounds`),
    output: parseRunOutput(record.output, `${field}.output`),
    created_at: parseRfc3339Instant(record.created_at, `${field}.created_at`),
  };
  if (Object.hasOwn(record, 'session')) {
    parsed.session = parseRunSessionReference(record.session, `${field}.session`);
  }
  return parsed;
}

function parseRunSessionReference(value: unknown, field: string): RunSessionReferenceV1 {
  const record = parseExactRecord(value, field, [
    'authentication_contract_id',
    'session_name',
    'generation',
    'state_digest',
    'authentication_contract_digest',
  ]);
  return {
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
  };
}

function parseArtifact(value: unknown, field: string): RunArtifactRefV1 {
  const record = parseExactRecord(value, field, [
    'package_id',
    'version',
    'package_digest',
    'capability',
    'runtime_range',
    'collection_contract_digest',
  ]);
  return {
    package_id: parsePackageId(record.package_id, `${field}.package_id`),
    version: parsePackageVersion(record.version, `${field}.version`),
    package_digest: parseSha256Digest(record.package_digest, `${field}.package_digest`),
    capability: parseCapabilityId(record.capability, `${field}.capability`),
    runtime_range: parseRuntimeRange(record.runtime_range, `${field}.runtime_range`),
    collection_contract_digest: parseSha256Digest(
      record.collection_contract_digest,
      `${field}.collection_contract_digest`,
    ),
  };
}

function parseEffectiveBounds(value: unknown, field: string): EffectiveRunBoundsV1 {
  const record = parseExactRecord(value, field, ['policy', 'named_limits']);
  const namedLimits = parseBoundedRecord(record.named_limits, `${field}.named_limits`, 64);
  const parsedLimits = {} as Record<StableContractIdV1, number>;
  for (const [id, candidate] of Object.entries(namedLimits)) {
    const limitId = parseStableContractId(id, `${field}.named_limits.${id}`);
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) {
      throw new PublicContractError(
        `${field}.named_limits.${id}`,
        'must be a positive safe integer',
      );
    }
    parsedLimits[limitId] = candidate;
  }
  return {
    policy: parseScrapeRunPolicy(record.policy, `${field}.policy`),
    named_limits: parsedLimits,
  };
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
