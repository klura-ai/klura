import {
  PublicContractError,
  sha256Digest,
  type CapabilityIdV1,
} from '../../public/contracts/common';
import type { CollectionRunContractV1 } from '../../public/contracts/collection';
import { evaluateCollectionPredicate } from '../../public/contracts/collection-predicate';
import { canonicalJson, type JsonValueV1 } from '../../public/contracts/json';
import { validateJsonSchema } from '../../public/contracts/json-schema';
import type { PublicReadCapabilityV1 } from '../../public/contracts/package';
import type { ScrapeTaskKindV1 } from '../../public/contracts/collection-topology';
import { evaluateScrapeValue } from '../../public/contracts/scrape-value';
import { createScrapeNode, type ScrapeNodeV1 } from './frontier';
import type { RunIdV1 } from './journal';

/** Expands only declared same-package fan-out edges from committed parent items. */
export function expandScrapeFanout(
  runId: RunIdV1,
  task: ScrapeTaskKindV1,
  parentItems: readonly JsonValueV1[],
  node: ScrapeNodeV1,
  args: JsonValueV1,
  collection: CollectionRunContractV1,
  taskKinds: ReadonlyMap<string, ScrapeTaskKindV1>,
  capabilities: Readonly<Record<CapabilityIdV1, PublicReadCapabilityV1>>,
  allocateOutputOrdinal: () => number,
): ScrapeNodeV1[] {
  const children: ScrapeNodeV1[] = [];
  for (const parentItem of parentItems) {
    for (const edge of task.fanout) {
      if (
        edge.when !== null &&
        !evaluateCollectionPredicate(edge.when, { parent_item: parentItem, args })
      ) {
        continue;
      }
      const childTask = taskKinds.get(edge.child_task_kind);
      if (!childTask) {
        throw new PublicContractError('run.fanout.child_task_kind', 'is unavailable');
      }
      const childCapability = capabilities[childTask.capability];
      if (!childCapability) {
        throw new PublicContractError('run.fanout.capability', 'is unavailable');
      }
      const depth = node.depth + 1;
      if (depth > collection.max_fanout_depth) {
        throw new PublicContractError('run.fanout.depth', 'exceeds the signed graph depth');
      }
      const childInput: Record<string, JsonValueV1> = {};
      for (const [key, expression] of Object.entries(edge.input)) {
        childInput[key] = evaluateScrapeValue(expression, { parent_item: parentItem });
      }
      validateJsonSchema(childInput, childCapability.input_schema, 'run.fanout.input');
      children.push(
        createScrapeNode(
          runId,
          {
            kind: 'fanout',
            parent_node_id: node.node_id,
            edge_id: edge.id,
            parent_item_digest: sha256Digest(canonicalJson(parentItem)),
          },
          allocateOutputOrdinal(),
          {
            task_kind_id: childTask.id,
            capability: childTask.capability,
            input: childInput,
            root_ordinal: node.root_ordinal,
            seed_ordinal: node.seed_ordinal,
            depth,
          },
        ),
      );
    }
  }
  return children;
}
