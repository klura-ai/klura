import fs from 'node:fs';
import { assertJsonValue, canonicalJson, type JsonValueV1 } from '../../public/contracts/json';
import {
  parseCapabilityId,
  parseExactRecord,
  parseInteger,
  parseSha256Digest,
  parseStableContractId,
  PublicContractError,
  sha256Digest,
  type CapabilityIdV1,
  type Sha256DigestV1,
  type StableContractIdV1,
} from '../../public/contracts/common';
import { readDataBlob, type BlobRefV1 } from './data-spool';
import {
  createRunNodeId,
  parseRunNodeId,
  recoverJournalFile,
  type JournalFrameBodyV1,
  RunJournalError,
  type RunIdV1,
  type RunNodeIdV1,
} from './journal';
import type { ScrapeRunSummaryV1 } from './run-state';
import { RunStoreV1 } from './run-store';
import { compareItemLogicalOrder, itemLogicalOrderKey } from './item-order';

export interface DurableScrapeNodeV1 {
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

export type RecoveredNodeStateV1 = 'pending' | 'attempting' | 'observed' | 'completed' | 'skipped';

export interface RecoveredRunNodeV1 {
  node: DurableScrapeNodeV1;
  state: RecoveredNodeStateV1;
}

interface RecoveryNodeV1 extends RecoveredRunNodeV1 {
  task_completed_for_attempt: boolean;
}

export interface RecoveredRunStateV1 {
  run_id: RunIdV1;
  last_sequence: number;
  last_frame_digest: Sha256DigestV1 | null;
  last_execution_epoch: number;
  nodes: RecoveredRunNodeV1[];
  terminal: boolean;
  interrupted: boolean;
  cancellation_requested: boolean;
  committed_item_count: number;
  summary: ScrapeRunSummaryV1;
  last_sink_commit: {
    through_item_sequence: number;
    byte_offset: number;
    prefix_digest: Sha256DigestV1;
  } | null;
  output_finalization: {
    prepared: Extract<JournalFrameBodyV1['event'], { kind: 'output_prepared' }>;
    committed: boolean;
  } | null;
  resume:
    | { allowed: true; pending_node_ids: RunNodeIdV1[] }
    | {
        allowed: false;
        reason: 'already_terminal' | 'cancelled' | 'not_interrupted' | 'unknown_attempt';
      };
}

export class RunRecoveryError extends PublicContractError {
  constructor(message: string) {
    super('run.recovery', message);
    this.name = 'RunRecoveryError';
  }
}

/** Reconstructs durable node state without sending traffic or inferring a node outcome. */
export function recoverRunState(store: RunStoreV1, runId: RunIdV1): RecoveredRunStateV1 {
  try {
    const frames = recoverJournalFile(store.journalPath(runId), runId).frames;
    const first = frames[0]?.body;
    if (!first || first.event.kind !== 'run_created' || first.execution_epoch !== 0) {
      throw new RunRecoveryError('journal is missing its epoch-zero run creation event');
    }
    const nodes = new Map<RunNodeIdV1, RecoveryNodeV1>();
    const references: BlobRefV1[] = [];
    const bufferedItems = new Map<
      string,
      {
        node_id: RunNodeIdV1;
        identity_digest: Sha256DigestV1;
        logical_order: import('./journal').ItemLogicalOrderV1;
      }
    >();
    const committedItemDigests = new Set<Sha256DigestV1>();
    const summary: ScrapeRunSummaryV1 = {
      items_emitted: 0,
      items_duplicate: 0,
      tasks_completed: 0,
      tasks_failed: 0,
      target_requests: 0,
    };
    let committedItemSequence = 0;
    let lastCommittedItemOrder: import('./journal').ItemLogicalOrderV1 | null = null;
    const outputOrdinals = new Set<number>();
    let lastSinkCommit: RecoveredRunStateV1['last_sink_commit'] = null;
    let outputFinalization: RecoveredRunStateV1['output_finalization'] = null;
    let terminal = false;
    let cancellationRequested = false;
    let executionEpoch = 0;
    recoverInitialNodes(runId, store, nodes, references, outputOrdinals, first.event);
    for (const [frameIndex, frame] of frames.entries()) {
      const event = frame.body.event;
      executionEpoch = advanceExecutionEpoch(frame.body, executionEpoch);
      outputFinalization = advanceOutputFinalization(outputFinalization, event);
      if (advanceTerminalState(terminal, event)) {
        terminal = true;
        continue;
      }
      if (event.kind === 'cancel_requested') {
        if (cancellationRequested) {
          throw new RunRecoveryError('journal contains more than one cancellation request');
        }
        cancellationRequested = true;
        continue;
      }
      if (event.kind === 'run_created') {
        if (frameIndex !== 0)
          throw new RunRecoveryError('journal contains more than one run creation');
        continue;
      }
      if (event.kind === 'node_enqueued') {
        recoverEnqueuedNode(runId, store, nodes, references, outputOrdinals, event);
        continue;
      }
      if (event.kind === 'item_buffered') {
        recoverBufferedItem(nodes, bufferedItems, references, event);
        continue;
      }
      if (event.kind === 'item_committed') {
        lastCommittedItemOrder = recoverCommittedItem(
          nodes,
          bufferedItems,
          committedItemDigests,
          committedItemSequence,
          lastCommittedItemOrder,
          summary,
          event,
        );
        committedItemSequence = event.item_sequence;
        continue;
      }
      if (event.kind === 'item_duplicate') {
        recoverDuplicateItem(nodes, bufferedItems, committedItemDigests, summary, event);
        continue;
      }
      if (event.kind === 'sink_committed') {
        lastSinkCommit = advanceSinkCommit(lastSinkCommit, committedItemSequence, event);
        continue;
      }
      if (event.kind === 'node_progressed') {
        recoverProgressedNode(runId, store, nodes, references, event);
        continue;
      }
      if (event.kind === 'node_replay_authorized') {
        recoverReplayAuthorization(nodes, frame.body.execution_epoch, event);
        continue;
      }
      if (
        event.kind !== 'attempt_intent' &&
        event.kind !== 'attempt_observed' &&
        event.kind !== 'task_completed' &&
        event.kind !== 'node_completed' &&
        event.kind !== 'task_skipped'
      ) {
        continue;
      }
      const recovered = nodes.get(event.node_id);
      if (!recovered) throw new RunRecoveryError('node lifecycle event precedes its enqueue');
      if (event.kind === 'attempt_intent') {
        if (event.task_kind_id !== recovered.node.task_kind_id) {
          throw new RunRecoveryError('node attempt intent has a mismatched task kind');
        }
        if (recovered.state !== 'pending') {
          throw new RunRecoveryError('node attempt intent has an invalid prior state');
        }
        recovered.state = 'attempting';
        recovered.task_completed_for_attempt = false;
      } else if (event.kind === 'attempt_observed') {
        if (event.task_kind_id !== recovered.node.task_kind_id) {
          throw new RunRecoveryError('node observation has a mismatched task kind');
        }
        if (recovered.state !== 'attempting') {
          throw new RunRecoveryError('node observation has no preceding attempt intent');
        }
        recovered.state = 'observed';
        recovered.task_completed_for_attempt = false;
        summary.target_requests += event.attempts;
      } else if (event.kind === 'task_completed') {
        if (event.task_kind_id !== recovered.node.task_kind_id) {
          throw new RunRecoveryError('node task completion has a mismatched task kind');
        }
        if (recovered.state !== 'observed' || recovered.task_completed_for_attempt) {
          throw new RunRecoveryError('node task completion has an invalid observed attempt');
        }
        recovered.task_completed_for_attempt = true;
        summary.tasks_completed += 1;
      } else if (event.kind === 'node_completed') {
        assertAccountableAttempt(recovered, 'node completion');
        recovered.state = 'completed';
      } else {
        if (event.task_kind_id !== recovered.node.task_kind_id) {
          throw new RunRecoveryError('node skip has a mismatched task kind');
        }
        if (recovered.state === 'completed' || recovered.state === 'skipped') {
          throw new RunRecoveryError('node skip has an invalid prior state');
        }
        recovered.state = 'skipped';
        summary.tasks_failed += 1;
      }
    }
    validateSpoolPrefix(store.dataSpoolPath(runId), references);
    const interrupted = !terminal && journalEndsInterrupted(frames);
    const unknownAttempt = [...nodes.values()].some(
      (recovered) => recovered.state === 'attempting' || recovered.state === 'observed',
    );
    const recoveredNodes = [...nodes.values()].map(({ node, state }) => ({ node, state }));
    const resume = deriveResumeEligibility(
      terminal,
      cancellationRequested,
      interrupted,
      unknownAttempt,
      recoveredNodes,
    );
    return {
      run_id: runId,
      last_sequence: frames.at(-1)?.body.sequence ?? 0,
      last_frame_digest: frames.at(-1)?.digest ?? null,
      last_execution_epoch: executionEpoch,
      nodes: recoveredNodes,
      terminal,
      interrupted,
      cancellation_requested: cancellationRequested,
      committed_item_count: committedItemDigests.size,
      summary,
      last_sink_commit: lastSinkCommit,
      output_finalization: outputFinalization,
      resume,
    };
  } catch (error) {
    if (error instanceof RunRecoveryError) throw error;
    if (error instanceof RunJournalError || error instanceof PublicContractError) {
      throw new RunRecoveryError(error.message);
    }
    throw error;
  }
}

function recoverInitialNodes(
  runId: RunIdV1,
  store: RunStoreV1,
  nodes: Map<RunNodeIdV1, RecoveryNodeV1>,
  references: BlobRefV1[],
  outputOrdinals: Set<number>,
  event: Extract<JournalFrameBodyV1['event'], { kind: 'run_created' }>,
): void {
  if (event.initial_nodes === undefined) return;
  for (const [index, reference] of event.initial_nodes.entries()) {
    references.push(reference);
    const node = parseDurableNode(
      runId,
      readDataBlob(store.dataSpoolPath(runId), reference),
      `run.initial_nodes[${index}]`,
    );
    if (node.depth !== 0 || node.output_ordinal !== index) {
      throw new RunRecoveryError('initial node has an invalid position');
    }
    const logicalKey = parseExactRecord(
      node.logical_key,
      `run.initial_nodes[${index}].logical_key`,
      ['kind', 'root_ordinal', 'seed_ordinal'],
    );
    if (
      logicalKey.kind !== 'root' ||
      logicalKey.root_ordinal !== node.root_ordinal ||
      logicalKey.seed_ordinal !== node.seed_ordinal
    ) {
      throw new RunRecoveryError('initial node does not match its root logical key');
    }
    if (nodes.has(node.node_id) || outputOrdinals.has(node.output_ordinal)) {
      throw new RunRecoveryError('initial node repeats a durable identity');
    }
    outputOrdinals.add(node.output_ordinal);
    nodes.set(node.node_id, { node, state: 'pending', task_completed_for_attempt: false });
  }
}

function deriveResumeEligibility(
  terminal: boolean,
  cancellationRequested: boolean,
  interrupted: boolean,
  unknownAttempt: boolean,
  nodes: readonly RecoveredRunNodeV1[],
): RecoveredRunStateV1['resume'] {
  if (terminal) return { allowed: false, reason: 'already_terminal' };
  if (cancellationRequested) return { allowed: false, reason: 'cancelled' };
  if (!interrupted) return { allowed: false, reason: 'not_interrupted' };
  if (unknownAttempt) return { allowed: false, reason: 'unknown_attempt' };
  return {
    allowed: true,
    pending_node_ids: nodes
      .filter((recovered) => recovered.state === 'pending')
      .map((recovered) => recovered.node.node_id),
  };
}

function advanceTerminalState(terminal: boolean, event: JournalFrameBodyV1['event']): boolean {
  if (terminal) throw new RunRecoveryError('journal contains work after its terminal event');
  return event.kind === 'terminal';
}

function advanceOutputFinalization(
  current: RecoveredRunStateV1['output_finalization'],
  event: JournalFrameBodyV1['event'],
): RecoveredRunStateV1['output_finalization'] {
  if (event.kind === 'output_prepared') {
    if (current !== null)
      throw new RunRecoveryError('journal contains more than one output preparation');
    if (
      event.terminal_descriptor.output.kind !== 'file' ||
      event.path_digest !== sha256Digest(event.terminal_descriptor.output.path)
    ) {
      throw new RunRecoveryError('output preparation does not bind its declared file output');
    }
    return { prepared: event, committed: false };
  }
  if (event.kind === 'output_committed') {
    if (current === null || current.committed) {
      throw new RunRecoveryError('output commit has no unmatched output preparation');
    }
    if (
      event.content_digest !== current.prepared.content_digest ||
      event.byte_length !== current.prepared.byte_length ||
      event.terminal_descriptor_digest !== current.prepared.terminal_descriptor_digest
    ) {
      throw new RunRecoveryError('output commit does not match its preparation');
    }
    return { ...current, committed: true };
  }
  if (event.kind === 'terminal') {
    if (current === null) {
      if (event.descriptor.output.kind === 'file') {
        throw new RunRecoveryError('file terminal result has no output preparation');
      }
      return current;
    }
    if (
      !current.committed ||
      event.descriptor_digest !== current.prepared.terminal_descriptor_digest
    ) {
      throw new RunRecoveryError('terminal result does not complete its prepared output');
    }
  }
  return current;
}

function journalEndsInterrupted(frames: readonly { body: JournalFrameBodyV1 }[]): boolean {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const event = frames[index]?.body.event;
    if (!event) throw new RunRecoveryError('journal frame is missing');
    if (event.kind === 'interrupted') return true;
    if (event.kind === 'state_changed') return false;
  }
  return false;
}

function advanceExecutionEpoch(body: JournalFrameBodyV1, current: number): number {
  const event = body.event;
  if (event.kind === 'state_changed' && event.state.kind === 'running') {
    if (
      event.state.execution_epoch !== body.execution_epoch ||
      body.execution_epoch !== current + 1
    ) {
      throw new RunRecoveryError('running state does not begin the next execution epoch');
    }
    return body.execution_epoch;
  }
  if (body.execution_epoch !== current) {
    throw new RunRecoveryError('journal frame has an invalid execution epoch');
  }
  return current;
}

function assertAccountableAttempt(
  recovered: RecoveryNodeV1 | undefined,
  event: string,
): asserts recovered is RecoveryNodeV1 {
  if (!recovered || recovered.state !== 'observed' || !recovered.task_completed_for_attempt) {
    throw new RunRecoveryError(`${event} has no completed observed attempt`);
  }
}

function recoverEnqueuedNode(
  runId: RunIdV1,
  store: RunStoreV1,
  nodes: Map<RunNodeIdV1, RecoveryNodeV1>,
  references: BlobRefV1[],
  outputOrdinals: Set<number>,
  event: Extract<JournalFrameBodyV1['event'], { kind: 'node_enqueued' }>,
): void {
  if (nodes.has(event.node_id)) throw new RunRecoveryError('node is enqueued more than once');
  if (outputOrdinals.has(event.output_ordinal)) {
    throw new RunRecoveryError('node output ordinal is enqueued more than once');
  }
  references.push(event.node_state);
  const node = parseDurableNode(
    runId,
    readDataBlob(store.dataSpoolPath(runId), event.node_state),
    'run.node_state',
  );
  if (
    node.node_id !== event.node_id ||
    sha256Digest(canonicalJson(node.logical_key)) !== event.logical_key_digest ||
    node.task_kind_id !== event.task_kind_id ||
    node.root_ordinal !== event.root_ordinal ||
    node.seed_ordinal !== event.seed_ordinal ||
    node.depth !== event.depth ||
    node.output_ordinal !== event.output_ordinal
  ) {
    throw new RunRecoveryError('node event does not match its durable node state');
  }
  outputOrdinals.add(event.output_ordinal);
  nodes.set(node.node_id, { node, state: 'pending', task_completed_for_attempt: false });
}

function recoverBufferedItem(
  nodes: ReadonlyMap<RunNodeIdV1, RecoveryNodeV1>,
  bufferedItems: Map<
    string,
    {
      node_id: RunNodeIdV1;
      identity_digest: Sha256DigestV1;
      logical_order: import('./journal').ItemLogicalOrderV1;
    }
  >,
  references: BlobRefV1[],
  event: Extract<JournalFrameBodyV1['event'], { kind: 'item_buffered' }>,
): void {
  const recovered = nodes.get(event.node_id);
  assertObservedAttempt(recovered, 'item buffer');
  const logicalKey = itemLogicalOrderKey(event.logical_order);
  if (bufferedItems.has(logicalKey)) {
    throw new RunRecoveryError('item buffer repeats a logical item position');
  }
  if (event.logical_order.node_ordinal !== recovered.node.output_ordinal) {
    throw new RunRecoveryError('item buffer does not match its node output ordinal');
  }
  bufferedItems.set(logicalKey, {
    node_id: event.node_id,
    identity_digest: event.identity_digest,
    logical_order: event.logical_order,
  });
  references.push(event.data);
}

function assertObservedAttempt(
  recovered: RecoveryNodeV1 | undefined,
  event: string,
): asserts recovered is RecoveryNodeV1 {
  if (!recovered || recovered.state !== 'observed') {
    throw new RunRecoveryError(`${event} has no observed attempt`);
  }
}

function recoverCommittedItem(
  nodes: ReadonlyMap<RunNodeIdV1, RecoveryNodeV1>,
  bufferedItems: Map<
    string,
    {
      node_id: RunNodeIdV1;
      identity_digest: Sha256DigestV1;
      logical_order: import('./journal').ItemLogicalOrderV1;
    }
  >,
  committedItemDigests: Set<Sha256DigestV1>,
  committedItemSequence: number,
  lastCommittedItemOrder: import('./journal').ItemLogicalOrderV1 | null,
  summary: ScrapeRunSummaryV1,
  event: Extract<JournalFrameBodyV1['event'], { kind: 'item_committed' }>,
): import('./journal').ItemLogicalOrderV1 {
  const recovered = nodes.get(event.node_id);
  assertAccountableAttempt(recovered, 'item commit');
  const buffered = bufferedItems.get(itemLogicalOrderKey(event.logical_order));
  if (
    !buffered ||
    buffered.node_id !== event.node_id ||
    buffered.identity_digest !== event.identity_digest
  ) {
    throw new RunRecoveryError('item commit has no matching node buffer');
  }
  if (committedItemDigests.has(event.identity_digest)) {
    throw new RunRecoveryError('item identity is committed more than once');
  }
  if (event.item_sequence !== committedItemSequence + 1) {
    throw new RunRecoveryError('item sequence is not contiguous');
  }
  if (
    lastCommittedItemOrder !== null &&
    compareItemLogicalOrder(lastCommittedItemOrder, event.logical_order) >= 0
  ) {
    throw new RunRecoveryError('item commits are not in logical order');
  }
  committedItemDigests.add(event.identity_digest);
  bufferedItems.delete(itemLogicalOrderKey(event.logical_order));
  summary.items_emitted += 1;
  return event.logical_order;
}

function recoverDuplicateItem(
  nodes: ReadonlyMap<RunNodeIdV1, RecoveryNodeV1>,
  bufferedItems: Map<
    string,
    {
      node_id: RunNodeIdV1;
      identity_digest: Sha256DigestV1;
      logical_order: import('./journal').ItemLogicalOrderV1;
    }
  >,
  committedItemDigests: ReadonlySet<Sha256DigestV1>,
  summary: ScrapeRunSummaryV1,
  event: Extract<JournalFrameBodyV1['event'], { kind: 'item_duplicate' }>,
): void {
  const recovered = nodes.get(event.node_id);
  assertAccountableAttempt(recovered, 'item duplicate');
  const buffered = bufferedItems.get(itemLogicalOrderKey(event.logical_order));
  if (
    !buffered ||
    buffered.node_id !== event.node_id ||
    buffered.identity_digest !== event.identity_digest
  ) {
    throw new RunRecoveryError('item duplicate has no matching node buffer');
  }
  if (!committedItemDigests.has(event.identity_digest)) {
    throw new RunRecoveryError('item duplicate has no prior committed identity');
  }
  bufferedItems.delete(itemLogicalOrderKey(event.logical_order));
  summary.items_duplicate += 1;
}

function recoverProgressedNode(
  runId: RunIdV1,
  store: RunStoreV1,
  nodes: Map<RunNodeIdV1, RecoveryNodeV1>,
  references: BlobRefV1[],
  event: Extract<JournalFrameBodyV1['event'], { kind: 'node_progressed' }>,
): void {
  references.push(event.node_state);
  const recovered = nodes.get(event.node_id);
  assertAccountableAttempt(recovered, 'node progress');
  const node = parseDurableNode(
    runId,
    readDataBlob(store.dataSpoolPath(runId), event.node_state),
    'run.node_progress',
  );
  if (
    node.node_id !== event.node_id ||
    canonicalJson(node.logical_key) !== canonicalJson(recovered.node.logical_key) ||
    node.output_ordinal !== recovered.node.output_ordinal
  ) {
    throw new RunRecoveryError('node progress does not match its durable node');
  }
  recovered.node = node;
  recovered.state = 'pending';
  recovered.task_completed_for_attempt = false;
}

function recoverReplayAuthorization(
  nodes: Map<RunNodeIdV1, RecoveryNodeV1>,
  executionEpoch: number,
  event: Extract<JournalFrameBodyV1['event'], { kind: 'node_replay_authorized' }>,
): void {
  if (executionEpoch < 1) {
    throw new RunRecoveryError('node replay authorization must occur in a resumed epoch');
  }
  const recovered = nodes.get(event.node_id);
  if (!recovered) {
    throw new RunRecoveryError('node replay authorization precedes its enqueue');
  }
  if (event.task_kind_id !== recovered.node.task_kind_id) {
    throw new RunRecoveryError('node replay authorization has a mismatched task kind');
  }
  if (recovered.state !== 'attempting' && recovered.state !== 'observed') {
    throw new RunRecoveryError('node replay authorization has no unresolved attempt');
  }
  recovered.state = 'pending';
  recovered.task_completed_for_attempt = false;
}

function advanceSinkCommit(
  last: RecoveredRunStateV1['last_sink_commit'],
  committedItemSequence: number,
  event: Extract<JournalFrameBodyV1['event'], { kind: 'sink_committed' }>,
): NonNullable<RecoveredRunStateV1['last_sink_commit']> {
  if (event.through_item_sequence > committedItemSequence) {
    throw new RunRecoveryError('sink commit does not reference a committed item');
  }
  if (
    last !== null &&
    (event.through_item_sequence <= last.through_item_sequence ||
      event.byte_offset <= last.byte_offset)
  ) {
    throw new RunRecoveryError('sink commits are not strictly advancing');
  }
  return {
    through_item_sequence: event.through_item_sequence,
    byte_offset: event.byte_offset,
    prefix_digest: event.prefix_digest,
  };
}

function parseDurableNode(runId: RunIdV1, value: unknown, field: string): DurableScrapeNodeV1 {
  const record = parseExactRecord(value, field, [
    'node_id',
    'logical_key',
    'task_kind_id',
    'capability',
    'input',
    'root_ordinal',
    'seed_ordinal',
    'depth',
    'output_ordinal',
    'seen_input_digests',
    'pages_started_in_chain',
  ]);
  const nodeId = parseRunNodeId(record.node_id, `${field}.node_id`);
  assertJsonValue(record.logical_key, `${field}.logical_key`, 12);
  if (createRunNodeId(runId, record.logical_key) !== nodeId) {
    throw new RunRecoveryError('node id does not match its logical key');
  }
  assertJsonValue(record.input, `${field}.input`, 12);
  return {
    node_id: nodeId,
    logical_key: record.logical_key,
    task_kind_id: parseStableContractId(record.task_kind_id, `${field}.task_kind_id`),
    capability: parseCapabilityId(record.capability, `${field}.capability`),
    input: record.input,
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
    seen_input_digests: parseInputDigests(record.seen_input_digests, `${field}.seen_input_digests`),
    pages_started_in_chain: parseInteger(
      record.pages_started_in_chain,
      `${field}.pages_started_in_chain`,
      0,
      1_000,
    ),
  };
}

function parseInputDigests(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new PublicContractError(field, 'must contain one to 1,000 input digests');
  }
  const digests = value.map((digest, index) => parseSha256Digest(digest, `${field}[${index}]`));
  if (new Set(digests).size !== digests.length) {
    throw new PublicContractError(field, 'must not contain duplicate input digests');
  }
  return digests;
}

function validateSpoolPrefix(spoolPath: string, references: readonly BlobRefV1[]): void {
  let expectedOffset = 0;
  for (const reference of references) {
    if (reference.offset !== expectedOffset) {
      throw new RunRecoveryError('journal blob references do not form a contiguous spool prefix');
    }
    readDataBlob(spoolPath, reference);
    expectedOffset += reference.length;
  }
  const size = fs.statSync(spoolPath).size;
  if (size < expectedOffset) {
    throw new RunRecoveryError('data spool is shorter than its accepted journal prefix');
  }
  if (size > expectedOffset) {
    fs.truncateSync(spoolPath, expectedOffset);
    const fd = fs.openSync(spoolPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}
