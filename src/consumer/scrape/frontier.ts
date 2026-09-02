import {
  PublicContractError,
  sha256Digest,
  type CapabilityIdV1,
  type StableContractIdV1,
} from '../../public/contracts/common';
import { canonicalJson, type JsonValueV1 } from '../../public/contracts/json';
import { createRunNodeId, type RunIdV1, type RunNodeIdV1 } from './journal';

export interface ScrapeNodeV1 {
  node_id: RunNodeIdV1;
  logical_key: JsonValueV1;
  task_kind_id: StableContractIdV1;
  capability: CapabilityIdV1;
  input: JsonValueV1;
  root_ordinal: number;
  seed_ordinal: number | null;
  depth: number;
  output_ordinal: number;
  seen_input_digests: string[];
  pages_started_in_chain: number;
}

export function createScrapeNode(
  runId: RunIdV1,
  logicalKey: JsonValueV1,
  outputOrdinal: number,
  node: Omit<
    ScrapeNodeV1,
    'node_id' | 'logical_key' | 'output_ordinal' | 'seen_input_digests' | 'pages_started_in_chain'
  >,
): ScrapeNodeV1 {
  return {
    ...node,
    node_id: createRunNodeId(runId, logicalKey),
    logical_key: logicalKey,
    output_ordinal: outputOrdinal,
    seen_input_digests: [sha256Digest(canonicalJson(node.input))],
    pages_started_in_chain: 0,
  };
}

export function scrapeNodeValue(node: ScrapeNodeV1): JsonValueV1 {
  return {
    node_id: node.node_id,
    logical_key: node.logical_key,
    task_kind_id: node.task_kind_id,
    capability: node.capability,
    input: node.input,
    root_ordinal: node.root_ordinal,
    seed_ordinal: node.seed_ordinal,
    depth: node.depth,
    output_ordinal: node.output_ordinal,
    seen_input_digests: node.seen_input_digests,
    pages_started_in_chain: node.pages_started_in_chain,
  };
}

export class FrontierV1 {
  private readonly nodes: ScrapeNodeV1[] = [];
  private encodedBytes = 0;

  constructor(private readonly maximumBytes: number) {}

  canEnqueue(node: ScrapeNodeV1): boolean {
    return this.encodedBytes + encodedNodeBytes(node) <= this.maximumBytes;
  }

  enqueue(node: ScrapeNodeV1): boolean {
    const bytes = encodedNodeBytes(node);
    if (this.encodedBytes + bytes > this.maximumBytes) return false;
    this.nodes.push(node);
    this.encodedBytes += bytes;
    return true;
  }

  hasNext(): boolean {
    return this.nodes.length > 0;
  }

  dequeue(): ScrapeNodeV1 {
    const node = this.nodes.shift();
    if (!node) throw new PublicContractError('run.frontier', 'is unexpectedly empty');
    this.encodedBytes -= encodedNodeBytes(node);
    return node;
  }
}

function encodedNodeBytes(node: ScrapeNodeV1): number {
  return Buffer.byteLength(canonicalJson(scrapeNodeValue(node)), 'utf8');
}
