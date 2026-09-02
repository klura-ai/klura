import type { OriginSchedulerV1 } from '../execution/origin-scheduler';
import type { CollectionRunContractV1 } from '../../public/contracts/collection';
import type { CapabilityIdV1, StableContractIdV1 } from '../../public/contracts/common';
import type { JsonValueV1 } from '../../public/contracts/json';
import type { PublicReadCapabilityV1 } from '../../public/contracts/package';
import type { ScrapeRunPolicyV1 } from '../../public/contracts/scrape-policy';
import type { StartUrlTemplateV1 } from '../../public/contracts/start-url-template';
import type { ScrapeTaskKindV1 } from '../../public/contracts/collection-topology';
import type { RunIdV1, RunStopV1 } from './journal';
import type { FileRunOutputSinkV1 } from './output-sink';
import type { SemanticStopTrackerV1 } from './semantic-stops';
import type { ScrapeNodeV1, FrontierV1 } from './frontier';
import type { LocalScrapeRunResultV1 } from './run-result';
import type { ExecutionStateV1 } from './run-state';
import type { AttemptOrderV1 } from './attempt-order';

export interface FrontierExecutionInputV1 {
  run_id: RunIdV1;
  args: JsonValueV1;
  capabilities: Readonly<Record<CapabilityIdV1, PublicReadCapabilityV1>>;
  collection: CollectionRunContractV1;
  named_limits: Readonly<Record<StableContractIdV1, number>>;
  policy: ScrapeRunPolicyV1;
  state: ExecutionStateV1;
  frontier: FrontierV1;
  sink: FileRunOutputSinkV1 | null;
  browser_storage_state?: JsonValueV1;
  signal?: AbortSignal;
}

export interface TaskChainExecutionInputV1 {
  run_id: RunIdV1;
  node: ScrapeNodeV1;
  task: ScrapeTaskKindV1;
  capability: PublicReadCapabilityV1;
  collection: CollectionRunContractV1;
  named_limits: Readonly<Record<StableContractIdV1, number>>;
  policy: ScrapeRunPolicyV1;
  scheduler: OriginSchedulerV1;
  templates: ReadonlyMap<string, StartUrlTemplateV1>;
  state: ExecutionStateV1;
  sink: FileRunOutputSinkV1 | null;
  semantic_stops: SemanticStopTrackerV1;
  browser_storage_state?: JsonValueV1;
  signal?: AbortSignal;
  stop: () => RunStopV1 | null;
  attempt_order: AttemptOrderV1;
  report_stop: (stop: RunStopV1) => void;
}

export type TaskChainExecutionResultV1 =
  | { kind: 'ok'; items: JsonValueV1[]; retained_fanout_item_bytes: number }
  | {
      kind: 'completed';
      stop: Extract<LocalScrapeRunResultV1, { kind: 'scrape_outcome' }>['stop'];
    }
  | {
      kind: 'failed';
      stop: Extract<LocalScrapeRunResultV1, { kind: 'scrape_partial' | 'scrape_failure' }>['stop'];
    };
