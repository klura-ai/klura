import type { CapabilityIdV1 } from '../../public/contracts/common';
import type { PublicReadCapabilityV1 } from '../../public/contracts/package';
import type { RecoveredRunNodeV1, RecoveredRunStateV1 } from './recovery';
import { ScrapeResumeError } from './resume-state';

export function resolveSafeReadReplayNodes(
  recovered: RecoveredRunStateV1,
  collection: NonNullable<PublicReadCapabilityV1['collection']>,
  capabilities: Readonly<Record<CapabilityIdV1, PublicReadCapabilityV1>>,
): RecoveredRunNodeV1[] {
  const taskKinds = new Map(collection.task_kinds.map((task) => [task.id, task]));
  const replayNodes = recovered.nodes.filter(
    (recoveredNode) => recoveredNode.state === 'attempting' || recoveredNode.state === 'observed',
  );
  for (const replayNode of replayNodes) {
    const task = taskKinds.get(replayNode.node.task_kind_id);
    const capability = capabilities[replayNode.node.capability];
    if (!task || task.capability !== replayNode.node.capability || !capability) {
      throw new ScrapeResumeError('unresolved attempt no longer matches the immutable collection');
    }
    if (capability.strategies.some((strategy) => strategy.replay !== 'safe_read')) {
      throw new ScrapeResumeError('unresolved attempt does not declare safe_read replay');
    }
  }
  return replayNodes;
}
