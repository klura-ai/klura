import { appendDataBlob } from './data-spool';
import { itemLogicalOrderKey } from './item-order';
import { SemanticStopTrackerV1 } from './semantic-stops';
import {
  ItemValidationError,
  RunBudgetExceededError,
  type ItemEmissionV1,
} from './task-chain-errors';
import type { JournalEventV1, RunIdV1, RunNodeIdV1 } from './journal';
import type { FileRunOutputSinkV1 } from './output-sink';
import type { BufferedRunItemV1, ExecutionStateV1 } from './run-state';
import type { RunStoreV1 } from './run-store';
import type { PublicReadCapabilityV1 } from '../../public/contracts/package';
import { PublicContractError, sha256Digest } from '../../public/contracts/common';
import { canonicalJson, type JsonValueV1 } from '../../public/contracts/json';
import { validateJsonSchema } from '../../public/contracts/json-schema';
import { evaluateScrapeValue } from '../../public/contracts/scrape-value';
import { resolveJsonPointer } from '../../public/contracts/value-expression';

export interface BufferedItemPageV1 {
  items: BufferedRunItemV1[];
}

/** Reserves parent items held while their declared fan-out is materialized. */
export function reserveRetainedFanoutItems(
  state: ExecutionStateV1,
  policy: NonNullable<PublicReadCapabilityV1['collection']>['run_policy'],
  items: readonly JsonValueV1[],
): number | null {
  const bytes = items.reduce(
    (total: number, item) => total + Buffer.byteLength(canonicalJson(item), 'utf8'),
    0,
  );
  if (
    state.local_state_bytes +
      state.retained_fanout_item_bytes +
      state.reserved_identity_state_bytes +
      bytes >
    policy.durable.max_local_state_bytes
  )
    return null;
  state.retained_fanout_item_bytes += bytes;
  return bytes;
}

type ItemBufferInputV1 = {
  run_id: RunIdV1;
  collection: NonNullable<PublicReadCapabilityV1['collection']>;
  task: NonNullable<PublicReadCapabilityV1['collection']>['task_kinds'][number];
  node_id: RunNodeIdV1;
  node_ordinal: number;
  page_ordinal: number;
  task_data: JsonValueV1 | null;
  state: ExecutionStateV1;
  policy: NonNullable<PublicReadCapabilityV1['collection']>['run_policy'];
  sink: FileRunOutputSinkV1 | null;
  store: RunStoreV1;
  append: (event: JournalEventV1) => boolean;
  has_ordinary_journal_capacity: (frame_count: number) => boolean;
};

/** Persists schema-validated items without making them visible to callers or a sink. */
export function bufferRunItems(input: ItemBufferInputV1): BufferedItemPageV1 {
  if (input.task.emit === null || input.task_data === null) return { items: [] };
  let raw: JsonValueV1;
  try {
    raw = resolveJsonPointer(
      input.task_data,
      input.task.emit.items_pointer,
      'run.emit.items_pointer',
    );
  } catch (error) {
    if (error instanceof PublicContractError) throw new ItemValidationError(error.message);
    throw error;
  }
  const rawItems = toRawItems(input.task.emit.cardinality, raw);
  const items: BufferedRunItemV1[] = [];
  for (const [itemOrdinal, rawItem] of rawItems.entries()) {
    const item = evaluateScrapeValue(input.task.emit.projection, {
      task_data: input.task_data,
      raw_item: rawItem,
    });
    try {
      validateJsonSchema(item, input.collection.item_schema, 'run.item');
    } catch (error) {
      if (error instanceof PublicContractError) throw new ItemValidationError(error.message);
      throw error;
    }
    const encoded = canonicalJson(item);
    const itemBytes = Buffer.byteLength(encoded, 'utf8');
    if (itemBytes > input.policy.max_encoded_item_bytes) {
      throw new ItemValidationError('item exceeds the signed encoded item byte limit');
    }
    const identityDigest = itemIdentityDigest(input.collection, item);
    const logicalOrder = {
      node_ordinal: input.node_ordinal,
      page_ordinal: input.page_ordinal,
      item_ordinal: itemOrdinal,
    };
    const logicalKey = itemLogicalOrderKey(logicalOrder);
    const existing = input.state.buffered_items.get(logicalKey);
    if (existing !== undefined) {
      if (
        existing.node_id !== input.node_id ||
        existing.identity_digest !== identityDigest ||
        canonicalJson(existing.item) !== encoded
      ) {
        throw new ItemValidationError('safe read replay changed a buffered item position');
      }
      items.push(existing);
      continue;
    }
    if (
      input.state.summary.items_emitted + input.state.reserved_item_count >=
      input.policy.max_items
    ) {
      throw new RunBudgetExceededError('item budget is exhausted');
    }
    const reservedOutputBytes = conservativeOutputBytes(input.sink, item, itemBytes);
    if (
      input.state.output_bytes + input.state.reserved_output_bytes + reservedOutputBytes >
      input.policy.max_output_bytes
    ) {
      throw new RunBudgetExceededError('output byte budget is exhausted');
    }
    const identityStateBytes = Buffer.byteLength(identityDigest, 'utf8') + 1;
    if (
      input.state.local_state_bytes +
        input.state.retained_fanout_item_bytes +
        input.state.reserved_identity_state_bytes +
        identityStateBytes >
      input.policy.durable.max_local_state_bytes
    ) {
      throw new RunBudgetExceededError('local identity state budget is exhausted');
    }
    if (!input.has_ordinary_journal_capacity(1)) {
      throw new RunBudgetExceededError('journal frame budget is exhausted');
    }
    const blob = appendDataBlob(
      input.store.dataSpoolPath(input.run_id),
      item,
      input.policy.durable.max_data_spool_bytes,
    );
    const buffered: BufferedRunItemV1 = {
      node_id: input.node_id,
      identity_digest: identityDigest,
      logical_order: logicalOrder,
      item,
      item_bytes: itemBytes,
      reserved_output_bytes: reservedOutputBytes,
    };
    if (
      !input.append({
        kind: 'item_buffered',
        node_id: buffered.node_id,
        identity_digest: buffered.identity_digest,
        data: { offset: blob.offset, length: blob.length, sha256: blob.sha256 },
        logical_order: buffered.logical_order,
      })
    ) {
      throw new RunBudgetExceededError('journal frame budget is exhausted');
    }
    input.state.buffered_items.set(logicalKey, buffered);
    input.state.reserved_item_count += 1;
    input.state.reserved_output_bytes += reservedOutputBytes;
    input.state.reserved_identity_state_bytes += identityStateBytes;
    items.push(buffered);
  }
  return { items };
}

/** Commits one previously buffered page in fixed logical order. */
export function commitBufferedRunItems(input: {
  items: readonly BufferedRunItemV1[];
  state: ExecutionStateV1;
  policy: NonNullable<PublicReadCapabilityV1['collection']>['run_policy'];
  sink: FileRunOutputSinkV1 | null;
  semantic_stops: SemanticStopTrackerV1;
  has_fanout: boolean;
  append: (event: JournalEventV1) => boolean;
  has_ordinary_journal_capacity: (frame_count: number) => boolean;
}): ItemEmissionV1 {
  const emittedItems: JsonValueV1[] = [];
  let newlyRetainedBytes = 0;
  for (const buffered of input.items) {
    const semanticStopId = input.semantic_stops.observe(buffered.item);
    if (semanticStopId !== null) {
      return {
        items: emittedItems,
        retained_item_bytes: newlyRetainedBytes,
        semantic_stop_id: semanticStopId,
      };
    }
    if (input.state.identity_digests.has(buffered.identity_digest)) {
      if (
        !input.append({
          kind: 'item_duplicate',
          node_id: buffered.node_id,
          identity_digest: buffered.identity_digest,
          logical_order: buffered.logical_order,
        })
      ) {
        throw new RunBudgetExceededError('journal frame budget is exhausted');
      }
      input.state.summary.items_duplicate += 1;
      releaseBufferedItem(input.state, buffered);
      continue;
    }
    const identityStateBytes = Buffer.byteLength(buffered.identity_digest, 'utf8') + 1;
    if (
      input.has_fanout &&
      input.state.local_state_bytes +
        input.state.retained_fanout_item_bytes +
        input.state.reserved_identity_state_bytes +
        buffered.item_bytes >
        input.policy.durable.max_local_state_bytes
    ) {
      throw new RunBudgetExceededError('fan-out item state budget is exhausted');
    }
    if (!input.has_ordinary_journal_capacity(input.sink === null ? 1 : 2)) {
      throw new RunBudgetExceededError('journal frame budget is exhausted');
    }
    const itemSequence = input.state.next_item_sequence;
    if (
      !input.append({
        kind: 'item_committed',
        node_id: buffered.node_id,
        identity_digest: buffered.identity_digest,
        logical_order: buffered.logical_order,
        item_sequence: itemSequence,
      })
    ) {
      throw new RunBudgetExceededError('journal frame budget is exhausted');
    }
    input.state.identity_digests.add(buffered.identity_digest);
    input.state.reserved_identity_state_bytes -= identityStateBytes;
    input.state.local_state_bytes += identityStateBytes;
    input.state.next_item_sequence += 1;
    input.state.summary.items_emitted += 1;
    if (input.has_fanout) {
      emittedItems.push(buffered.item);
      newlyRetainedBytes += buffered.item_bytes;
      input.state.retained_fanout_item_bytes += buffered.item_bytes;
    }
    if (input.sink !== null) {
      const progress = input.sink.write(buffered.item);
      if (
        !input.append({
          kind: 'sink_committed',
          through_item_sequence: itemSequence,
          byte_offset: progress.byte_offset,
          prefix_digest: progress.prefix_digest,
        })
      ) {
        throw new RunBudgetExceededError('journal frame budget is exhausted');
      }
      input.state.output_bytes = input.sink.bytes_written;
    } else {
      input.state.output_bytes += buffered.reserved_output_bytes;
    }
    releaseBufferedItem(input.state, buffered, false);
  }
  return { items: emittedItems, retained_item_bytes: newlyRetainedBytes, semantic_stop_id: null };
}

function toRawItems(cardinality: 'one' | 'array', raw: JsonValueV1): JsonValueV1[] {
  if (cardinality === 'one') return [raw];
  if (!Array.isArray(raw)) {
    throw new ItemValidationError('array emit pointer did not resolve to an array');
  }
  return raw;
}

function itemIdentityDigest(
  collection: NonNullable<PublicReadCapabilityV1['collection']>,
  item: JsonValueV1,
): ReturnType<typeof sha256Digest> {
  const identity = collection.item_identity.pointers.map((pointer) => {
    try {
      return resolveJsonPointer(item, pointer, 'run.item_identity');
    } catch (error) {
      if (error instanceof PublicContractError) throw new ItemValidationError(error.message);
      throw error;
    }
  });
  return sha256Digest(canonicalJson(identity));
}

function conservativeOutputBytes(
  sink: FileRunOutputSinkV1 | null,
  item: JsonValueV1,
  itemBytes: number,
): number {
  return (sink?.previewItem(item) ?? itemBytes + 1) + 1;
}

function releaseBufferedItem(
  state: ExecutionStateV1,
  buffered: BufferedRunItemV1,
  releaseIdentityReservation = true,
): void {
  const key = itemLogicalOrderKey(buffered.logical_order);
  if (!state.buffered_items.delete(key)) {
    throw new ItemValidationError('buffered item is unavailable for commit');
  }
  state.reserved_item_count -= 1;
  state.reserved_output_bytes -= buffered.reserved_output_bytes;
  if (releaseIdentityReservation) {
    state.reserved_identity_state_bytes -= Buffer.byteLength(buffered.identity_digest, 'utf8') + 1;
  }
}
