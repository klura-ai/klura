import { type EffectiveRunBoundsV1 } from '../../public/contracts/scrape-policy';
import { PublicContractError } from '../../public/contracts/common';
import { canonicalJson } from '../../public/contracts/json';
import { type CollectionRunContractV1 } from '../../public/contracts/collection';
import { recoverJournalFile, type RunIdV1 } from './journal';
import { itemLogicalOrderKey } from './item-order';
import { readCommittedRunItems, readPendingBufferedRunItems } from './result-reader';
import { RunStoreV1 } from './run-store';
import type { ExecutionStateV1 } from './run-state';

export class ScrapeResumeError extends PublicContractError {
  constructor(message: string) {
    super('run.resume', message);
    this.name = 'ScrapeResumeError';
  }
}

export function rehydrateExecutionState(
  store: RunStoreV1,
  runId: RunIdV1,
  effectiveBounds: EffectiveRunBoundsV1,
  collection: CollectionRunContractV1,
): ExecutionStateV1 {
  const frames = recoverJournalFile(store.journalPath(runId), runId).frames;
  const taskKinds = new Map(collection.task_kinds.map((task) => [task.id, task]));
  const identityDigests = new Set<string>();
  const summary = {
    items_emitted: 0,
    items_duplicate: 0,
    tasks_completed: 0,
    tasks_failed: 0,
    target_requests: 0,
  };
  let tasksStarted = 0;
  let pagesStarted = 0;
  let nextNodeOrdinal = 0;
  for (const frame of frames) {
    const event = frame.body.event;
    if (event.kind === 'node_enqueued') {
      nextNodeOrdinal = Math.max(nextNodeOrdinal, event.output_ordinal + 1);
    } else if (event.kind === 'attempt_intent') {
      const task = taskKinds.get(event.task_kind_id);
      if (!task) throw new ScrapeResumeError('journal refers to an unavailable task kind');
      tasksStarted += 1;
      if (task.task_role === 'page') pagesStarted += 1;
    } else if (event.kind === 'attempt_observed') {
      summary.target_requests += event.attempts;
    } else if (event.kind === 'task_completed') {
      summary.tasks_completed += 1;
    } else if (event.kind === 'task_skipped') {
      summary.tasks_failed += 1;
    } else if (event.kind === 'item_committed') {
      if (identityDigests.has(event.identity_digest)) {
        throw new ScrapeResumeError('journal commits one item identity more than once');
      }
      identityDigests.add(event.identity_digest);
      summary.items_emitted += 1;
    } else if (event.kind === 'item_duplicate') {
      summary.items_duplicate += 1;
    }
  }
  const committedItems = readCommittedRunItems(store, runId);
  if (committedItems.length !== summary.items_emitted) {
    throw new ScrapeResumeError('journal item count does not match committed spool items');
  }
  const outputBytes = committedItems.reduce(
    (total: number, item) => total + Buffer.byteLength(canonicalJson(item), 'utf8') + 1,
    0,
  );
  const localStateBytes = [...identityDigests].reduce(
    (total: number, digest) => total + Buffer.byteLength(digest, 'utf8') + 1,
    0,
  );
  const bufferedItems = readPendingBufferedRunItems(store, runId);
  const bufferedItemMap = new Map(
    bufferedItems.map((item) => [itemLogicalOrderKey(item.logical_order), item]),
  );
  const reservedIdentityStateBytes = bufferedItems.reduce(
    (total, item) => total + Buffer.byteLength(item.identity_digest, 'utf8') + 1,
    0,
  );
  const reservedOutputBytes = bufferedItems.reduce(
    (total, item) => total + item.reserved_output_bytes,
    0,
  );
  const last = frames.at(-1) ?? null;
  if (last === null) throw new ScrapeResumeError('journal is missing its run creation event');
  return {
    sequence: last.body.sequence,
    previous_digest: last.digest,
    execution_epoch: last.body.execution_epoch,
    summary,
    identity_digests: identityDigests,
    maximum_journal_bytes: effectiveBounds.policy.durable.max_journal_bytes,
    maximum_journal_frames: effectiveBounds.policy.durable.max_journal_frames,
    local_state_bytes: localStateBytes,
    retained_fanout_item_bytes: 0,
    output_bytes: outputBytes,
    tasks_started: tasksStarted,
    pages_started: pagesStarted,
    next_node_ordinal: nextNodeOrdinal,
    next_item_sequence: summary.items_emitted + 1,
    known_node_ids: new Set(),
    buffered_items: bufferedItemMap,
    reserved_item_count: bufferedItems.length,
    reserved_output_bytes: reservedOutputBytes,
    reserved_identity_state_bytes: reservedIdentityStateBytes,
    reserved_target_requests: 0,
    reserved_reorder_buffer_bytes: 0,
    had_independent_failure: summary.tasks_failed > 0,
    terminal: false,
  };
}
