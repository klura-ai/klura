import { sha256Digest } from '../../public/contracts/common';
import { canonicalJson } from '../../public/contracts/json';
import type { ScrapeRunPolicyV1 } from '../../public/contracts/scrape-policy';
import { appendDataBlob, DataSpoolError } from './data-spool';
import { scrapeNodeValue, type FrontierV1, type ScrapeNodeV1 } from './frontier';
import type { JournalEventV1, RunIdV1 } from './journal';
import type { ExecutionStateV1 } from './run-state';
import type { RunStoreV1 } from './run-store';

type AppendJournalEventV1 = (event: JournalEventV1) => boolean;

export function enqueueDurableNode(input: {
  run_id: RunIdV1;
  node: ScrapeNodeV1;
  state: ExecutionStateV1;
  policy: ScrapeRunPolicyV1;
  frontier: FrontierV1;
  store: RunStoreV1;
  append: AppendJournalEventV1;
}): boolean {
  if (!input.frontier.canEnqueue(input.node)) return false;
  let nodeState;
  try {
    nodeState = appendDataBlob(
      input.store.dataSpoolPath(input.run_id),
      scrapeNodeValue(input.node),
      input.policy.durable.max_data_spool_bytes,
    );
  } catch (error) {
    if (error instanceof DataSpoolError && error.code === 'durable_budget_exhausted') return false;
    throw error;
  }
  if (
    !input.append({
      kind: 'node_enqueued',
      node_id: input.node.node_id,
      logical_key_digest: sha256Digest(canonicalJson(input.node.logical_key)),
      node_state: nodeState,
      task_kind_id: input.node.task_kind_id,
      root_ordinal: input.node.root_ordinal,
      seed_ordinal: input.node.seed_ordinal,
      depth: input.node.depth,
      output_ordinal: input.node.output_ordinal,
    })
  ) {
    return false;
  }
  return input.frontier.enqueue(input.node);
}

export function persistDurableNodeProgress(input: {
  run_id: RunIdV1;
  node: ScrapeNodeV1;
  state: ExecutionStateV1;
  policy: ScrapeRunPolicyV1;
  store: RunStoreV1;
  append: AppendJournalEventV1;
}): boolean {
  let nodeState;
  try {
    nodeState = appendDataBlob(
      input.store.dataSpoolPath(input.run_id),
      scrapeNodeValue(input.node),
      input.policy.durable.max_data_spool_bytes,
    );
  } catch (error) {
    if (error instanceof DataSpoolError && error.code === 'durable_budget_exhausted') return false;
    throw error;
  }
  return input.append({
    kind: 'node_progressed',
    node_id: input.node.node_id,
    node_state: nodeState,
  });
}
