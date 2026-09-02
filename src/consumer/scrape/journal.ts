import { parseRunNodeId, parseRunStop, parseStopReasonEvent } from './stop-reason';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseExactRecord,
  parseInteger,
  parseSha256Digest,
  parseStableContractId,
  PublicContractError,
  sha256Digest,
  type Sha256DigestV1,
  type StableContractIdV1,
} from '../../public/contracts/common';
import {
  JOURNAL_EMERGENCY_FRAME_RESERVE_V1,
  JOURNAL_FRAME_HEADER_BYTES_V1,
  JOURNAL_FRAME_TRAILER_BYTES_V1,
} from '../../public/contracts/journal-budget';
import { canonicalJson, parseStrictJson, type JsonValueV1 } from '../../public/contracts/json';
import { parseBlobRef, type BlobRefV1 } from './data-spool';

export type RunIdV1 = `run_v1_${string}`;
export type RunNodeIdV1 = `node_v1_${string}`;
export { parseRunNodeId, parseRunStop } from './stop-reason';
export type RunOperationIdV1 = `op_v1_${string}`;

/** A stable hierarchy position assigned before a collection node is enqueued. */
export interface ItemLogicalOrderV1 {
  node_ordinal: number;
  page_ordinal: number;
  item_ordinal: number;
}

export type RunStopV1 =
  | 'cancelled'
  | 'deadline_exhausted'
  | 'task_failed'
  | 'run_budget_exhausted'
  | 'item_invalid'
  | 'output_sink_failure';

export type RunCompletionStopV1 =
  | { kind: 'source_exhausted' }
  | { kind: 'date_cutoff_reached'; semantic_stop_id: StableContractIdV1 };

export type TerminalRunStopV1 = RunStopV1 | RunCompletionStopV1;

export type RunCancellationSourceV1 =
  | 'foreground_sigint'
  | 'sdk_cancel'
  | 'mcp_cancel'
  | 'cli_cancel';

export interface TerminalResultDescriptorV1 {
  descriptor_schema_version: 1;
  result_kind: 'scrape_outcome' | 'scrape_partial' | 'scrape_failure';
  stop: TerminalRunStopV1;
  summary: {
    items_emitted: number;
    items_duplicate: number;
    tasks_completed: number;
    tasks_failed: number;
    target_requests: number;
  };
  output:
    | { kind: 'inline'; partial: boolean }
    | { kind: 'file'; path: string; format: 'json' | 'ndjson' | 'csv'; partial: boolean }
    | { kind: 'none' };
}

export type JournalEventV1 =
  | {
      kind: 'run_created';
      meta_digest: Sha256DigestV1;
      /** Present on runs whose complete initial root set is recoverable from the first frame. */
      initial_nodes?: BlobRefV1[];
    }
  | {
      kind: 'state_changed';
      state:
        | { kind: 'queued' }
        | { kind: 'running'; execution_epoch: number; current_node_id: null };
    }
  | {
      kind: 'node_enqueued';
      node_id: RunNodeIdV1;
      logical_key_digest: Sha256DigestV1;
      node_state: BlobRefV1;
      task_kind_id: StableContractIdV1;
      root_ordinal: number;
      seed_ordinal: number | null;
      depth: number;
      output_ordinal: number;
    }
  | { kind: 'node_progressed'; node_id: RunNodeIdV1; node_state: BlobRefV1 }
  | {
      kind: 'node_replay_authorized';
      node_id: RunNodeIdV1;
      task_kind_id: StableContractIdV1;
    }
  | { kind: 'attempt_intent'; node_id: RunNodeIdV1; task_kind_id: StableContractIdV1 }
  | {
      kind: 'attempt_observed';
      node_id: RunNodeIdV1;
      task_kind_id: StableContractIdV1;
      result_kind:
        | 'outcome'
        | 'unclassified_response'
        | 'ambiguous_response'
        | 'verification_failed'
        | 'projection_failed'
        | 'failure';
      attempts: number;
    }
  | { kind: 'task_completed'; node_id: RunNodeIdV1; task_kind_id: StableContractIdV1 }
  | {
      kind: 'item_buffered';
      node_id: RunNodeIdV1;
      identity_digest: Sha256DigestV1;
      data: BlobRefV1;
      logical_order: ItemLogicalOrderV1;
    }
  | {
      kind: 'item_committed';
      node_id: RunNodeIdV1;
      identity_digest: Sha256DigestV1;
      logical_order: ItemLogicalOrderV1;
      item_sequence: number;
    }
  | {
      kind: 'item_duplicate';
      node_id: RunNodeIdV1;
      identity_digest: Sha256DigestV1;
      logical_order: ItemLogicalOrderV1;
    }
  | {
      kind: 'sink_committed';
      through_item_sequence: number;
      byte_offset: number;
      prefix_digest: Sha256DigestV1;
    }
  | {
      kind: 'output_prepared';
      path_digest: Sha256DigestV1;
      content_digest: Sha256DigestV1;
      byte_length: number;
      terminal_descriptor: TerminalResultDescriptorV1;
      terminal_descriptor_digest: Sha256DigestV1;
    }
  | {
      kind: 'output_committed';
      content_digest: Sha256DigestV1;
      byte_length: number;
      terminal_descriptor_digest: Sha256DigestV1;
    }
  | { kind: 'node_completed'; node_id: RunNodeIdV1 }
  | {
      kind: 'task_skipped';
      node_id: RunNodeIdV1;
      task_kind_id: StableContractIdV1;
      stop: RunStopV1;
    }
  | {
      /** Why a stop was chosen, in the words of the check that chose it. Written
       *  beside the stop so an operator reads the cause, not only the class. */
      kind: 'stop_reason';
      node_id: RunNodeIdV1 | null;
      task_kind_id: StableContractIdV1 | null;
      stop: RunStopV1;
      message: string;
    }
  | {
      kind: 'interrupted';
      reason: 'daemon_stopped' | 'daemon_crash' | 'process_crash' | 'browser_crash';
    }
  | { kind: 'cancel_requested'; source: RunCancellationSourceV1 }
  | {
      kind: 'terminal';
      descriptor: TerminalResultDescriptorV1;
      descriptor_digest: Sha256DigestV1;
    };

export interface JournalFrameBodyV1 {
  frame_schema_version: 1;
  run_id: RunIdV1;
  sequence: number;
  execution_epoch: number;
  previous_frame_digest: Sha256DigestV1 | null;
  event: JournalEventV1;
}

export interface JournalFrameV1 {
  body: JournalFrameBodyV1;
  digest: Sha256DigestV1;
  offset: number;
  end_offset: number;
}

export interface ReadJournalV1 {
  frames: JournalFrameV1[];
  trailing_incomplete_offset: number | null;
}

export class RunJournalError extends PublicContractError {
  constructor(
    public readonly code: 'journal_corrupt' | 'durable_budget_exhausted',
    message: string,
  ) {
    super('run_journal', message);
    this.name = 'RunJournalError';
  }
}

const MAX_FRAME_BODY_BYTES_V1 = 1024 * 1024;

const MAX_TERMINAL_DESCRIPTOR_BYTES_V1 = 16 * 1024;

/** Keeps the terminal frame allowance available before ordinary journal work. */
export function hasOrdinaryJournalCapacity(
  state: { sequence: number; maximum_journal_frames: number },
  frameCount = 1,
): boolean {
  return (
    Number.isSafeInteger(frameCount) &&
    frameCount >= 1 &&
    state.sequence + frameCount + JOURNAL_EMERGENCY_FRAME_RESERVE_V1 <= state.maximum_journal_frames
  );
}

export function createRunId(): RunIdV1 {
  return `run_v1_${randomBytes(16).toString('hex')}`;
}

export function createRunOperationId(): RunOperationIdV1 {
  return `op_v1_${randomBytes(16).toString('hex')}`;
}

export function createRunNodeId(runId: RunIdV1, logicalKey: JsonValueV1): RunNodeIdV1 {
  const domain = Buffer.from(`klura-node-v1\0${runId}\0`, 'utf8');
  const encodedKey = Buffer.from(canonicalJson(logicalKey), 'utf8');
  return `node_v1_${sha256Digest(Buffer.concat([domain, encodedKey])).slice(0, 32)}`;
}

export function calculateTerminalDescriptorDigest(
  descriptor: TerminalResultDescriptorV1,
): Sha256DigestV1 {
  return sha256Digest(
    canonicalJson(
      parseTerminalResultDescriptor(descriptor, 'terminal_descriptor') as unknown as JsonValueV1,
    ),
  );
}

export function parseRunId(value: unknown, field: string): RunIdV1 {
  if (typeof value !== 'string' || !/^run_v1_[0-9a-f]{32}$/.test(value)) {
    throw new PublicContractError(field, 'must be a canonical run id');
  }
  return value as RunIdV1;
}

export function parseRunOperationId(value: unknown, field: string): RunOperationIdV1 {
  if (typeof value !== 'string' || !/^op_v1_[0-9a-f]{32}$/.test(value)) {
    throw new PublicContractError(field, 'must be a canonical run operation id');
  }
  return value as RunOperationIdV1;
}

export function encodeJournalFrame(body: JournalFrameBodyV1): Buffer {
  const parsed = parseJournalFrameBody(body, 'journal.frame');
  const bodyBytes = Buffer.from(canonicalJson(parsed as unknown as JsonValueV1), 'utf8');
  if (bodyBytes.byteLength > MAX_FRAME_BODY_BYTES_V1) {
    throw new RunJournalError('durable_budget_exhausted', 'journal frame body exceeds 1 MiB');
  }
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bodyBytes.byteLength);
  const digest = Buffer.from(sha256Digest(bodyBytes), 'hex');
  return Buffer.concat([length, bodyBytes, digest]);
}

export function readJournal(bytes: Uint8Array, expectedRunId?: RunIdV1): ReadJournalV1 {
  const source = Buffer.from(bytes);
  const frames: JournalFrameV1[] = [];
  let offset = 0;
  let expectedSequence = 1;
  let previousDigest: Sha256DigestV1 | null = null;
  while (offset < source.byteLength) {
    if (source.byteLength - offset < 4) return { frames, trailing_incomplete_offset: offset };
    const bodyLength = source.readUInt32BE(offset);
    if (bodyLength > MAX_FRAME_BODY_BYTES_V1) {
      throw new RunJournalError('journal_corrupt', 'journal frame declares an oversized body');
    }
    const endOffset =
      offset + JOURNAL_FRAME_HEADER_BYTES_V1 + bodyLength + JOURNAL_FRAME_TRAILER_BYTES_V1;
    if (endOffset > source.byteLength) return { frames, trailing_incomplete_offset: offset };
    const bodyBytes = source.subarray(
      offset + JOURNAL_FRAME_HEADER_BYTES_V1,
      offset + JOURNAL_FRAME_HEADER_BYTES_V1 + bodyLength,
    );
    const digest = sha256Digest(bodyBytes);
    const storedDigest = source
      .subarray(offset + JOURNAL_FRAME_HEADER_BYTES_V1 + bodyLength, endOffset)
      .toString('hex');
    if (storedDigest !== digest) {
      throw new RunJournalError(
        'journal_corrupt',
        'journal frame checksum does not match its body',
      );
    }
    const body = parseCanonicalFrameBody(bodyBytes, `journal.frame[${frames.length}]`);
    if (expectedRunId !== undefined && body.run_id !== expectedRunId) {
      throw new RunJournalError('journal_corrupt', 'journal frame belongs to a different run');
    }
    if (body.sequence !== expectedSequence) {
      throw new RunJournalError('journal_corrupt', 'journal sequence is not contiguous');
    }
    if (body.previous_frame_digest !== previousDigest) {
      throw new RunJournalError('journal_corrupt', 'journal hash chain is broken');
    }
    frames.push({ body, digest, offset, end_offset: endOffset });
    offset = endOffset;
    expectedSequence += 1;
    previousDigest = digest;
  }
  return { frames, trailing_incomplete_offset: null };
}

export function appendJournalFrame(
  journalPath: string,
  body: JournalFrameBodyV1,
  maximumBytes: number,
  maximumFrames?: number,
  reservedBytes = 0,
): JournalFrameV1 {
  const existing = recoverJournalFile(journalPath, body.run_id);
  if (
    maximumFrames !== undefined &&
    (!Number.isSafeInteger(maximumFrames) ||
      maximumFrames < 1 ||
      existing.frames.length >= maximumFrames)
  ) {
    throw new RunJournalError('durable_budget_exhausted', 'journal frame budget is exhausted');
  }
  const prior = existing.frames.at(-1) ?? null;
  const parsed = parseJournalFrameBody(body, 'journal.frame');
  if (parsed.sequence !== (prior?.body.sequence ?? 0) + 1) {
    throw new RunJournalError('journal_corrupt', 'appended sequence is not contiguous');
  }
  if (parsed.previous_frame_digest !== (prior?.digest ?? null)) {
    throw new RunJournalError('journal_corrupt', 'appended frame does not extend the hash chain');
  }
  const encoded = encodeJournalFrame(parsed);
  const priorBytes = fs.existsSync(journalPath) ? fs.statSync(journalPath).size : 0;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    !Number.isSafeInteger(reservedBytes) ||
    reservedBytes < 0 ||
    maximumBytes < priorBytes + encoded.byteLength + reservedBytes
  ) {
    throw new RunJournalError('durable_budget_exhausted', 'journal byte budget is exhausted');
  }
  fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(journalPath, 'a', 0o600);
  try {
    fs.writeFileSync(fd, encoded);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const offset = priorBytes;
  return {
    body: parsed,
    digest: sha256Digest(
      encoded.subarray(
        JOURNAL_FRAME_HEADER_BYTES_V1,
        JOURNAL_FRAME_HEADER_BYTES_V1 + encoded.readUInt32BE(0),
      ),
    ),
    offset,
    end_offset: offset + encoded.byteLength,
  };
}

export function recoverJournalFile(journalPath: string, expectedRunId?: RunIdV1): ReadJournalV1 {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(journalPath);
  } catch (error) {
    if (isMissing(error)) return { frames: [], trailing_incomplete_offset: null };
    throw error;
  }
  const parsed = readJournal(bytes, expectedRunId);
  if (parsed.trailing_incomplete_offset === null) return parsed;
  fs.truncateSync(journalPath, parsed.trailing_incomplete_offset);
  const fd = fs.openSync(journalPath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { frames: parsed.frames, trailing_incomplete_offset: null };
}

function parseCanonicalFrameBody(bytes: Buffer, field: string): JournalFrameBodyV1 {
  const value = parseStrictJson(bytes, field, MAX_FRAME_BODY_BYTES_V1, 12);
  const canonical = Buffer.from(canonicalJson(value), 'utf8');
  if (!canonical.equals(bytes)) {
    throw new RunJournalError('journal_corrupt', 'journal frame body is not canonical JSON');
  }
  try {
    return parseJournalFrameBody(value, field);
  } catch (error) {
    if (error instanceof PublicContractError) {
      throw new RunJournalError('journal_corrupt', error.message);
    }
    throw error;
  }
}

function parseJournalFrameBody(value: unknown, field: string): JournalFrameBodyV1 {
  const record = parseExactRecord(value, field, [
    'frame_schema_version',
    'run_id',
    'sequence',
    'execution_epoch',
    'previous_frame_digest',
    'event',
  ]);
  if (record.frame_schema_version !== 1) {
    throw new PublicContractError(`${field}.frame_schema_version`, 'must be 1');
  }
  return {
    frame_schema_version: 1,
    run_id: parseRunId(record.run_id, `${field}.run_id`),
    sequence: parseInteger(record.sequence, `${field}.sequence`, 1, Number.MAX_SAFE_INTEGER),
    execution_epoch: parseInteger(
      record.execution_epoch,
      `${field}.execution_epoch`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    previous_frame_digest:
      record.previous_frame_digest === null
        ? null
        : parseSha256Digest(record.previous_frame_digest, `${field}.previous_frame_digest`),
    event: parseJournalEvent(record.event, `${field}.event`),
  };
}

export function parseJournalEvent(value: unknown, field: string): JournalEventV1 {
  const kind = readEventKind(value, field);
  if (kind === 'run_created') {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.hasOwn(value, 'initial_nodes')
    ) {
      const record = parseExactRecord(value, field, ['kind', 'meta_digest', 'initial_nodes']);
      if (!Array.isArray(record.initial_nodes) || record.initial_nodes.length > 1_000) {
        throw new PublicContractError(`${field}.initial_nodes`, 'must contain at most 1,000 nodes');
      }
      return {
        kind,
        meta_digest: parseSha256Digest(record.meta_digest, `${field}.meta_digest`),
        initial_nodes: record.initial_nodes.map((node, index) =>
          parseBlobRef(node, `${field}.initial_nodes[${index}]`),
        ),
      };
    }
    const record = parseExactRecord(value, field, ['kind', 'meta_digest']);
    return { kind, meta_digest: parseSha256Digest(record.meta_digest, `${field}.meta_digest`) };
  }
  if (kind === 'state_changed') {
    const record = parseExactRecord(value, field, ['kind', 'state']);
    return { kind, state: parseJournalState(record.state, `${field}.state`) };
  }
  if (kind === 'node_enqueued') {
    const record = parseExactRecord(value, field, [
      'kind',
      'node_id',
      'logical_key_digest',
      'node_state',
      'task_kind_id',
      'root_ordinal',
      'seed_ordinal',
      'depth',
      'output_ordinal',
    ]);
    return {
      kind,
      node_id: parseRunNodeId(record.node_id, `${field}.node_id`),
      logical_key_digest: parseSha256Digest(
        record.logical_key_digest,
        `${field}.logical_key_digest`,
      ),
      node_state: parseBlobRef(record.node_state, `${field}.node_state`),
      task_kind_id: parseStableContractId(record.task_kind_id, `${field}.task_kind_id`),
      root_ordinal: parseInteger(
        record.root_ordinal,
        `${field}.root_ordinal`,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      seed_ordinal:
        record.seed_ordinal === null
          ? null
          : parseInteger(record.seed_ordinal, `${field}.seed_ordinal`, 0, Number.MAX_SAFE_INTEGER),
      depth: parseInteger(record.depth, `${field}.depth`, 0, 3),
      output_ordinal: parseInteger(
        record.output_ordinal,
        `${field}.output_ordinal`,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    };
  }
  if (kind === 'attempt_intent') {
    const record = parseExactRecord(value, field, ['kind', 'node_id', 'task_kind_id']);
    return {
      kind,
      node_id: parseRunNodeId(record.node_id, `${field}.node_id`),
      task_kind_id: parseStableContractId(record.task_kind_id, `${field}.task_kind_id`),
    };
  }
  if (kind === 'node_replay_authorized') {
    const record = parseExactRecord(value, field, ['kind', 'node_id', 'task_kind_id']);
    return {
      kind,
      node_id: parseRunNodeId(record.node_id, `${field}.node_id`),
      task_kind_id: parseStableContractId(record.task_kind_id, `${field}.task_kind_id`),
    };
  }
  if (kind === 'node_progressed') {
    const record = parseExactRecord(value, field, ['kind', 'node_id', 'node_state']);
    return {
      kind,
      node_id: parseRunNodeId(record.node_id, `${field}.node_id`),
      node_state: parseBlobRef(record.node_state, `${field}.node_state`),
    };
  }
  if (kind === 'attempt_observed') {
    const record = parseExactRecord(value, field, [
      'kind',
      'node_id',
      'task_kind_id',
      'result_kind',
      'attempts',
    ]);
    if (
      record.result_kind !== 'outcome' &&
      record.result_kind !== 'unclassified_response' &&
      record.result_kind !== 'ambiguous_response' &&
      record.result_kind !== 'verification_failed' &&
      record.result_kind !== 'projection_failed' &&
      record.result_kind !== 'failure'
    ) {
      throw new PublicContractError(`${field}.result_kind`, 'is invalid');
    }
    return {
      kind,
      node_id: parseRunNodeId(record.node_id, `${field}.node_id`),
      task_kind_id: parseStableContractId(record.task_kind_id, `${field}.task_kind_id`),
      result_kind: record.result_kind,
      attempts: parseInteger(record.attempts, `${field}.attempts`, 0, Number.MAX_SAFE_INTEGER),
    };
  }
  if (kind === 'task_completed') {
    const record = parseExactRecord(value, field, ['kind', 'node_id', 'task_kind_id']);
    return {
      kind,
      node_id: parseRunNodeId(record.node_id, `${field}.node_id`),
      task_kind_id: parseStableContractId(record.task_kind_id, `${field}.task_kind_id`),
    };
  }
  if (kind === 'item_buffered') {
    const record = parseExactRecord(value, field, [
      'kind',
      'node_id',
      'identity_digest',
      'data',
      'logical_order',
    ]);
    return {
      kind,
      node_id: parseRunNodeId(record.node_id, `${field}.node_id`),
      identity_digest: parseSha256Digest(record.identity_digest, `${field}.identity_digest`),
      data: parseBlobRef(record.data, `${field}.data`),
      logical_order: parseItemLogicalOrder(record.logical_order, `${field}.logical_order`),
    };
  }
  if (kind === 'item_committed') {
    const record = parseExactRecord(value, field, [
      'kind',
      'node_id',
      'identity_digest',
      'logical_order',
      'item_sequence',
    ]);
    return {
      kind,
      node_id: parseRunNodeId(record.node_id, `${field}.node_id`),
      identity_digest: parseSha256Digest(record.identity_digest, `${field}.identity_digest`),
      logical_order: parseItemLogicalOrder(record.logical_order, `${field}.logical_order`),
      item_sequence: parseInteger(
        record.item_sequence,
        `${field}.item_sequence`,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    };
  }
  if (kind === 'item_duplicate') {
    const record = parseExactRecord(value, field, [
      'kind',
      'node_id',
      'identity_digest',
      'logical_order',
    ]);
    return {
      kind,
      node_id: parseRunNodeId(record.node_id, `${field}.node_id`),
      identity_digest: parseSha256Digest(record.identity_digest, `${field}.identity_digest`),
      logical_order: parseItemLogicalOrder(record.logical_order, `${field}.logical_order`),
    };
  }
  if (kind === 'sink_committed') {
    const record = parseExactRecord(value, field, [
      'kind',
      'through_item_sequence',
      'byte_offset',
      'prefix_digest',
    ]);
    return {
      kind,
      through_item_sequence: parseInteger(
        record.through_item_sequence,
        `${field}.through_item_sequence`,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      byte_offset: parseInteger(
        record.byte_offset,
        `${field}.byte_offset`,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      prefix_digest: parseSha256Digest(record.prefix_digest, `${field}.prefix_digest`),
    };
  }
  if (kind === 'output_prepared') {
    const record = parseExactRecord(value, field, [
      'kind',
      'path_digest',
      'content_digest',
      'byte_length',
      'terminal_descriptor',
      'terminal_descriptor_digest',
    ]);
    const terminalDescriptor = parseTerminalResultDescriptor(
      record.terminal_descriptor,
      `${field}.terminal_descriptor`,
    );
    const terminalDescriptorDigest = parseSha256Digest(
      record.terminal_descriptor_digest,
      `${field}.terminal_descriptor_digest`,
    );
    if (terminalDescriptorDigest !== calculateTerminalDescriptorDigest(terminalDescriptor)) {
      throw new PublicContractError(
        `${field}.terminal_descriptor_digest`,
        'does not match the terminal descriptor',
      );
    }
    return {
      kind,
      path_digest: parseSha256Digest(record.path_digest, `${field}.path_digest`),
      content_digest: parseSha256Digest(record.content_digest, `${field}.content_digest`),
      byte_length: parseInteger(
        record.byte_length,
        `${field}.byte_length`,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      terminal_descriptor: terminalDescriptor,
      terminal_descriptor_digest: terminalDescriptorDigest,
    };
  }
  if (kind === 'output_committed') {
    const record = parseExactRecord(value, field, [
      'kind',
      'content_digest',
      'byte_length',
      'terminal_descriptor_digest',
    ]);
    return {
      kind,
      content_digest: parseSha256Digest(record.content_digest, `${field}.content_digest`),
      byte_length: parseInteger(
        record.byte_length,
        `${field}.byte_length`,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      terminal_descriptor_digest: parseSha256Digest(
        record.terminal_descriptor_digest,
        `${field}.terminal_descriptor_digest`,
      ),
    };
  }
  if (kind === 'task_skipped') {
    const record = parseExactRecord(value, field, ['kind', 'node_id', 'task_kind_id', 'stop']);
    return {
      kind,
      node_id: parseRunNodeId(record.node_id, `${field}.node_id`),
      task_kind_id: parseStableContractId(record.task_kind_id, `${field}.task_kind_id`),
      stop: parseRunStop(record.stop, `${field}.stop`),
    };
  }
  if (kind === 'stop_reason') return parseStopReasonEvent(value, field);
  if (kind === 'node_completed') {
    const record = parseExactRecord(value, field, ['kind', 'node_id']);
    return { kind, node_id: parseRunNodeId(record.node_id, `${field}.node_id`) };
  }
  if (kind === 'interrupted') {
    const record = parseExactRecord(value, field, ['kind', 'reason']);
    if (
      record.reason !== 'daemon_stopped' &&
      record.reason !== 'daemon_crash' &&
      record.reason !== 'process_crash' &&
      record.reason !== 'browser_crash'
    ) {
      throw new PublicContractError(`${field}.reason`, 'is invalid');
    }
    return { kind, reason: record.reason };
  }
  if (kind === 'cancel_requested') {
    const record = parseExactRecord(value, field, ['kind', 'source']);
    if (
      record.source !== 'foreground_sigint' &&
      record.source !== 'sdk_cancel' &&
      record.source !== 'mcp_cancel' &&
      record.source !== 'cli_cancel'
    ) {
      throw new PublicContractError(`${field}.source`, 'is invalid');
    }
    return { kind, source: record.source };
  }
  const record = parseExactRecord(value, field, ['kind', 'descriptor', 'descriptor_digest']);
  if (record.kind !== 'terminal')
    throw new PublicContractError(`${field}.kind`, 'must be terminal');
  const descriptor = parseTerminalResultDescriptor(record.descriptor, `${field}.descriptor`);
  const descriptorDigest = parseSha256Digest(
    record.descriptor_digest,
    `${field}.descriptor_digest`,
  );
  if (descriptorDigest !== calculateTerminalDescriptorDigest(descriptor)) {
    throw new PublicContractError(
      `${field}.descriptor_digest`,
      'does not match the terminal descriptor',
    );
  }
  return { kind: 'terminal', descriptor, descriptor_digest: descriptorDigest };
}

export function parseTerminalResultDescriptor(
  value: unknown,
  field: string,
): TerminalResultDescriptorV1 {
  const record = parseExactRecord(value, field, [
    'descriptor_schema_version',
    'result_kind',
    'stop',
    'summary',
    'output',
  ]);
  if (record.descriptor_schema_version !== 1) {
    throw new PublicContractError(`${field}.descriptor_schema_version`, 'must be 1');
  }
  if (
    record.result_kind !== 'scrape_outcome' &&
    record.result_kind !== 'scrape_partial' &&
    record.result_kind !== 'scrape_failure'
  ) {
    throw new PublicContractError(`${field}.result_kind`, 'is invalid');
  }
  const stop = parseTerminalRunStop(record.stop, `${field}.stop`, record.result_kind);
  const descriptor: TerminalResultDescriptorV1 = {
    descriptor_schema_version: 1,
    result_kind: record.result_kind,
    stop,
    summary: parseTerminalSummary(record.summary, `${field}.summary`),
    output: parseTerminalOutput(record.output, `${field}.output`),
  };
  if (
    Buffer.byteLength(canonicalJson(descriptor as unknown as JsonValueV1), 'utf8') >
    MAX_TERMINAL_DESCRIPTOR_BYTES_V1
  ) {
    throw new PublicContractError(field, 'exceeds the 16 KiB terminal descriptor bound');
  }
  return descriptor;
}

function parseTerminalSummary(
  value: unknown,
  field: string,
): TerminalResultDescriptorV1['summary'] {
  const record = parseExactRecord(value, field, [
    'items_emitted',
    'items_duplicate',
    'tasks_completed',
    'tasks_failed',
    'target_requests',
  ]);
  return {
    items_emitted: parseInteger(
      record.items_emitted,
      `${field}.items_emitted`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    items_duplicate: parseInteger(
      record.items_duplicate,
      `${field}.items_duplicate`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    tasks_completed: parseInteger(
      record.tasks_completed,
      `${field}.tasks_completed`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    tasks_failed: parseInteger(
      record.tasks_failed,
      `${field}.tasks_failed`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    target_requests: parseInteger(
      record.target_requests,
      `${field}.target_requests`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function parseTerminalOutput(value: unknown, field: string): TerminalResultDescriptorV1['output'] {
  const kind = readRecordKind(value, field);
  if (kind === 'none') {
    parseExactRecord(value, field, ['kind']);
    return { kind };
  }
  if (kind === 'inline') {
    const record = parseExactRecord(value, field, ['kind', 'partial']);
    if (typeof record.partial !== 'boolean') {
      throw new PublicContractError(`${field}.partial`, 'must be a boolean');
    }
    return { kind, partial: record.partial };
  }
  const record = parseExactRecord(value, field, ['kind', 'path', 'format', 'partial']);
  if (record.kind !== 'file') throw new PublicContractError(`${field}.kind`, 'is invalid');
  if (typeof record.path !== 'string' || record.path.length === 0) {
    throw new PublicContractError(`${field}.path`, 'must be a non-empty string');
  }
  if (record.format !== 'json' && record.format !== 'ndjson' && record.format !== 'csv') {
    throw new PublicContractError(`${field}.format`, 'is invalid');
  }
  if (typeof record.partial !== 'boolean') {
    throw new PublicContractError(`${field}.partial`, 'must be a boolean');
  }
  return { kind: 'file', path: record.path, format: record.format, partial: record.partial };
}

function parseJournalState(
  value: unknown,
  field: string,
): Extract<JournalEventV1, { kind: 'state_changed' }>['state'] {
  const kind = readRecordKind(value, field);
  if (kind === 'queued') {
    parseExactRecord(value, field, ['kind']);
    return { kind };
  }
  const record = parseExactRecord(value, field, ['kind', 'execution_epoch', 'current_node_id']);
  if (record.kind !== 'running' || record.current_node_id !== null) {
    throw new PublicContractError(field, 'is invalid');
  }
  return {
    kind: 'running',
    execution_epoch: parseInteger(
      record.execution_epoch,
      `${field}.execution_epoch`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    current_node_id: null,
  };
}

// Completion and incomplete terminals intentionally use distinct closed unions.
function parseItemLogicalOrder(value: unknown, field: string): ItemLogicalOrderV1 {
  const record = parseExactRecord(value, field, ['node_ordinal', 'page_ordinal', 'item_ordinal']);
  return {
    node_ordinal: parseInteger(
      record.node_ordinal,
      `${field}.node_ordinal`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    page_ordinal: parseInteger(record.page_ordinal, `${field}.page_ordinal`, 0, 1_000),
    item_ordinal: parseInteger(record.item_ordinal, `${field}.item_ordinal`, 0, 1_000_000),
  };
}

// eslint-disable-next-line sonarjs/function-return-type
function parseTerminalRunStop(
  value: unknown,
  field: string,
  resultKind: TerminalResultDescriptorV1['result_kind'],
): TerminalRunStopV1 {
  if (resultKind !== 'scrape_outcome') return parseRunStop(value, field);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be a completion stop object');
  }
  if ((value as Record<string, unknown>).kind === 'source_exhausted') {
    parseExactRecord(value, field, ['kind']);
    return { kind: 'source_exhausted' };
  }
  const record = parseExactRecord(value, field, ['kind', 'semantic_stop_id']);
  if (record.kind === 'date_cutoff_reached') {
    return {
      kind: 'date_cutoff_reached',
      semantic_stop_id: parseStableContractId(record.semantic_stop_id, `${field}.semantic_stop_id`),
    };
  }
  throw new PublicContractError(`${field}.kind`, 'does not match scrape_outcome');
}

function readEventKind(value: unknown, field: string): string {
  const kind = readRecordKind(value, field);
  if (
    kind !== 'run_created' &&
    kind !== 'state_changed' &&
    kind !== 'node_enqueued' &&
    kind !== 'node_progressed' &&
    kind !== 'node_replay_authorized' &&
    kind !== 'attempt_intent' &&
    kind !== 'attempt_observed' &&
    kind !== 'task_completed' &&
    kind !== 'item_buffered' &&
    kind !== 'item_committed' &&
    kind !== 'item_duplicate' &&
    kind !== 'sink_committed' &&
    kind !== 'output_prepared' &&
    kind !== 'output_committed' &&
    kind !== 'node_completed' &&
    kind !== 'task_skipped' &&
    kind !== 'stop_reason' &&
    kind !== 'interrupted' &&
    kind !== 'cancel_requested' &&
    kind !== 'terminal'
  ) {
    throw new PublicContractError(`${field}.kind`, 'is not a supported journal event');
  }
  return kind;
}

function readRecordKind(value: unknown, field: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const kind = (value as Record<string, unknown>).kind;
  if (typeof kind !== 'string') throw new PublicContractError(`${field}.kind`, 'must be a string');
  return kind;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
