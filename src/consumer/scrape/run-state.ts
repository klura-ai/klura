import type { Sha256DigestV1 } from '../../public/contracts/common';
import type { JsonValueV1 } from '../../public/contracts/json';
import type { ItemLogicalOrderV1, RunNodeIdV1 } from './journal';

export interface BufferedRunItemV1 {
  node_id: RunNodeIdV1;
  identity_digest: Sha256DigestV1;
  logical_order: ItemLogicalOrderV1;
  item: JsonValueV1;
  item_bytes: number;
  reserved_output_bytes: number;
}

export interface ScrapeRunSummaryV1 {
  items_emitted: number;
  items_duplicate: number;
  tasks_completed: number;
  tasks_failed: number;
  target_requests: number;
}

export interface ExecutionStateV1 {
  sequence: number;
  previous_digest: Sha256DigestV1 | null;
  execution_epoch: number;
  summary: ScrapeRunSummaryV1;
  identity_digests: Set<string>;
  maximum_journal_bytes: number;
  maximum_journal_frames: number;
  local_state_bytes: number;
  retained_fanout_item_bytes: number;
  output_bytes: number;
  tasks_started: number;
  pages_started: number;
  next_node_ordinal: number;
  next_item_sequence: number;
  known_node_ids: Set<RunNodeIdV1>;
  buffered_items: Map<string, BufferedRunItemV1>;
  reserved_item_count: number;
  reserved_output_bytes: number;
  reserved_identity_state_bytes: number;
  reserved_target_requests: number;
  reserved_reorder_buffer_bytes: number;
  had_independent_failure: boolean;
  terminal: boolean;
}
