import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  parseInteger,
  PublicContractError,
  type Sha256DigestV1,
} from '../../public/contracts/common';
import { CONSUMER_BOUNDS } from '../../public/contracts/consumer-bounds';
import type { CsvColumnV1 } from '../../public/contracts/collection';
import { canonicalJson, type JsonValueV1 } from '../../public/contracts/json';
import { resolveJsonPointer } from '../../public/contracts/value-expression';
import { readDataBlob, type BlobRefV1 } from './data-spool';
import { recoverJournalFile, type RunIdV1 } from './journal';
import { RunStoreV1 } from './run-store';
import { compareItemLogicalOrder, itemLogicalOrderKey } from './item-order';
import type { RunOutputFormatV1 } from './output';
import type { BufferedRunItemV1 } from './run-state';

export interface RunItemExportV1 {
  run_id: RunIdV1;
  items_written: number;
  bytes_written: number;
  path: string;
}

export interface CommittedRunItemV1 {
  sequence: number;
  item: JsonValueV1;
}

export interface ReadCommittedRunItemsPageOptionsV1 {
  after_sequence?: number;
  limit?: number;
}

export interface CommittedRunItemsPageV1 {
  run_id: RunIdV1;
  items: CommittedRunItemV1[];
  next_after_sequence: number | null;
}

export interface RunItemExportOptionsV1 {
  format: RunOutputFormatV1;
  csv_columns: readonly CsvColumnV1[] | null;
}

export class RunResultError extends PublicContractError {
  constructor(
    public readonly code:
      | 'result_corrupt'
      | 'output_exists'
      | 'output_budget_exhausted'
      | 'output_format_invalid'
      | 'csv_projection_invalid',
    message: string,
  ) {
    super('run_result', message);
    this.name = 'RunResultError';
  }
}

/** Reads the committed durable item sequence in journal order. */
export function readCommittedRunItems(store: RunStoreV1, runId: RunIdV1): JsonValueV1[] {
  const items: JsonValueV1[] = [];
  visitCommittedRunItems(store, runId, (item) => {
    items.push(item);
  });
  return items;
}

/** Reads one bounded, exclusive page from the committed journal item sequence. */
export function readCommittedRunItemsPage(
  store: RunStoreV1,
  runId: RunIdV1,
  options: ReadCommittedRunItemsPageOptionsV1 = {},
): CommittedRunItemsPageV1 {
  const afterSequence = parseInteger(
    options.after_sequence ?? 0,
    'run.items.after_sequence',
    CONSUMER_BOUNDS.after_sequence.minimum,
    CONSUMER_BOUNDS.after_sequence.maximum,
  );
  const limit = parseInteger(
    options.limit ?? 25,
    'run.items.limit',
    CONSUMER_BOUNDS.page_limit.minimum,
    CONSUMER_BOUNDS.page_limit.maximum,
  );
  const items: CommittedRunItemV1[] = [];
  let nextAfterSequence: number | null = null;
  visitCommittedRunItems(store, runId, (item, _nodeId, sequence) => {
    if (sequence <= afterSequence) return undefined;
    if (items.length >= limit) {
      nextAfterSequence = lastPagedItem(items).sequence;
      return false;
    }
    items.push({ sequence, item });
    return undefined;
  });
  return {
    run_id: runId,
    items,
    next_after_sequence: nextAfterSequence,
  };
}

function lastPagedItem(items: readonly CommittedRunItemV1[]): CommittedRunItemV1 {
  const last = items.at(-1);
  if (last === undefined) {
    throw new RunResultError('result_corrupt', 'item page has no terminal cursor');
  }
  return last;
}

/** Reads the committed items emitted by one durable collection node. */
export function readCommittedNodeItems(
  store: RunStoreV1,
  runId: RunIdV1,
  nodeId: import('./journal').RunNodeIdV1,
): JsonValueV1[] {
  const items: JsonValueV1[] = [];
  visitCommittedRunItems(store, runId, (item, sourceNodeId) => {
    if (sourceNodeId === nodeId) items.push(item);
  });
  return items;
}

/** Reconstructs durable but uncommitted item buffers for safe-read resume. */
export function readPendingBufferedRunItems(
  store: RunStoreV1,
  runId: RunIdV1,
): BufferedRunItemV1[] {
  const buffered = new Map<
    string,
    {
      data: BlobRefV1;
      node_id: import('./journal').RunNodeIdV1;
      identity_digest: Sha256DigestV1;
      logical_order: import('./journal').ItemLogicalOrderV1;
    }
  >();
  for (const frame of recoverJournalFile(store.journalPath(runId), runId).frames) {
    const event = frame.body.event;
    if (event.kind === 'item_buffered') {
      const key = itemLogicalOrderKey(event.logical_order);
      if (buffered.has(key)) {
        throw new RunResultError(
          'result_corrupt',
          'item logical position is buffered more than once',
        );
      }
      buffered.set(key, {
        data: event.data,
        node_id: event.node_id,
        identity_digest: event.identity_digest,
        logical_order: event.logical_order,
      });
      continue;
    }
    if (event.kind !== 'item_committed' && event.kind !== 'item_duplicate') continue;
    const key = itemLogicalOrderKey(event.logical_order);
    const previous = buffered.get(key);
    if (
      !previous ||
      previous.node_id !== event.node_id ||
      previous.identity_digest !== event.identity_digest
    ) {
      throw new RunResultError('result_corrupt', 'item resolution has no matching buffer');
    }
    buffered.delete(key);
  }
  return [...buffered.values()]
    .sort((left, right) => compareItemLogicalOrder(left.logical_order, right.logical_order))
    .map((entry) => {
      const item = readDataBlob(store.dataSpoolPath(runId), entry.data);
      const itemBytes = Buffer.byteLength(canonicalJson(item), 'utf8');
      return {
        node_id: entry.node_id,
        identity_digest: entry.identity_digest,
        logical_order: entry.logical_order,
        item,
        item_bytes: itemBytes,
        reserved_output_bytes: itemBytes + 1,
      };
    });
}

/** Writes committed items to one atomic, non-overwriting local output file. */
export function exportCommittedRunItems(
  store: RunStoreV1,
  runId: RunIdV1,
  destination: string,
  options: RunItemExportOptionsV1,
): RunItemExportV1 {
  if (options.format === 'csv' && options.csv_columns === null) {
    throw new RunResultError(
      'output_format_invalid',
      'CSV output requires declared collection columns',
    );
  }
  const target = path.resolve(destination);
  const directory = path.dirname(target);
  const meta = store.read(runId).payload;
  if (fs.existsSync(target)) {
    throw new RunResultError('output_exists', 'output path already exists');
  }
  const temporary = path.join(
    directory,
    `.klura-${runId}-${randomBytes(8).toString('hex')}.${options.format}`,
  );
  let fd: number | null = null;
  let itemsWritten = 0;
  let bytesWritten = 0;
  const write = (value: string): void => {
    const bytes = Buffer.from(value, 'utf8');
    if (bytesWritten + bytes.byteLength > meta.effective_bounds.policy.max_output_bytes) {
      throw new RunResultError(
        'output_budget_exhausted',
        'declared output byte budget is exhausted',
      );
    }
    fs.writeFileSync(fd as number, bytes);
    bytesWritten += bytes.byteLength;
  };
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    if (options.format === 'json') {
      let first = true;
      write('[');
      visitCommittedRunItems(store, runId, (item) => {
        write(`${first ? '' : ','}${canonicalJson(item)}`);
        first = false;
        itemsWritten += 1;
      });
      write(']');
    } else if (options.format === 'ndjson') {
      visitCommittedRunItems(store, runId, (item) => {
        write(`${canonicalJson(item)}\n`);
        itemsWritten += 1;
      });
    } else {
      const columns = options.csv_columns;
      if (columns === null) {
        throw new RunResultError(
          'output_format_invalid',
          'CSV output requires declared collection columns',
        );
      }
      write(`${columns.map((column) => escapeCsv(column.name)).join(',')}\n`);
      visitCommittedRunItems(store, runId, (item) => {
        write(`${columns.map((column) => projectCsvCell(item, column)).join(',')}\n`);
        itemsWritten += 1;
      });
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if (isExists(error)) {
        throw new RunResultError('output_exists', 'output path already exists');
      }
      throw error;
    }
    fs.unlinkSync(temporary);
    return {
      run_id: runId,
      items_written: itemsWritten,
      bytes_written: bytesWritten,
      path: target,
    };
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) throw cleanupError;
    }
    throw error;
  }
}

/** Writes committed items as canonical NDJSON without exposing an incomplete destination. */
export function exportCommittedRunItemsNdjson(
  store: RunStoreV1,
  runId: RunIdV1,
  destination: string,
): RunItemExportV1 {
  return exportCommittedRunItems(store, runId, destination, {
    format: 'ndjson',
    csv_columns: null,
  });
}

function visitCommittedRunItems(
  store: RunStoreV1,
  runId: RunIdV1,
  visit: (
    item: JsonValueV1,
    nodeId: import('./journal').RunNodeIdV1,
    sequence: number,
  ) => false | undefined,
): void {
  const frames = recoverJournalFile(store.journalPath(runId), runId).frames;
  const buffered = new Map<
    string,
    {
      data: BlobRefV1;
      node_id: import('./journal').RunNodeIdV1;
      identity_digest: Sha256DigestV1;
      logical_order: import('./journal').ItemLogicalOrderV1;
    }
  >();
  const committed = new Set<Sha256DigestV1>();
  let lastItemSequence = 0;
  let lastLogicalOrder: import('./journal').ItemLogicalOrderV1 | null = null;
  for (const frame of frames) {
    const event = frame.body.event;
    if (event.kind === 'item_buffered') {
      const logicalKey = itemLogicalOrderKey(event.logical_order);
      if (buffered.has(logicalKey)) {
        throw new RunResultError(
          'result_corrupt',
          'item logical position is buffered more than once',
        );
      }
      buffered.set(logicalKey, {
        data: event.data,
        node_id: event.node_id,
        identity_digest: event.identity_digest,
        logical_order: event.logical_order,
      });
      continue;
    }
    if (event.kind === 'item_duplicate') {
      const logicalKey = itemLogicalOrderKey(event.logical_order);
      const reference = buffered.get(logicalKey);
      if (
        !reference ||
        reference.node_id !== event.node_id ||
        reference.identity_digest !== event.identity_digest ||
        !committed.has(event.identity_digest)
      ) {
        throw new RunResultError(
          'result_corrupt',
          'item duplicate has no resolved preceding buffer',
        );
      }
      buffered.delete(logicalKey);
      continue;
    }
    if (event.kind !== 'item_committed') continue;
    const identity = event.identity_digest;
    const logicalKey = itemLogicalOrderKey(event.logical_order);
    const reference = buffered.get(logicalKey);
    if (
      !reference ||
      reference.node_id !== event.node_id ||
      reference.identity_digest !== identity ||
      committed.has(identity)
    ) {
      throw new RunResultError('result_corrupt', 'item commit has no unique preceding buffer');
    }
    if (reference.node_id !== event.node_id || event.item_sequence !== lastItemSequence + 1) {
      throw new RunResultError(
        'result_corrupt',
        'item commit does not extend the durable item sequence',
      );
    }
    if (
      lastLogicalOrder !== null &&
      compareItemLogicalOrder(lastLogicalOrder, event.logical_order) >= 0
    ) {
      throw new RunResultError('result_corrupt', 'item commit is not in logical order');
    }
    const item = readDataBlob(store.dataSpoolPath(runId), reference.data);
    buffered.delete(logicalKey);
    committed.add(identity);
    lastItemSequence = event.item_sequence;
    lastLogicalOrder = event.logical_order;
    if (visit(item, event.node_id, event.item_sequence) === false) return;
  }
}

function projectCsvCell(item: JsonValueV1, column: CsvColumnV1): string {
  let value: JsonValueV1;
  try {
    value = resolveJsonPointer(item, column.pointer, 'run.csv_column');
  } catch (error) {
    if (error instanceof PublicContractError) {
      throw new RunResultError('csv_projection_invalid', error.message);
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
