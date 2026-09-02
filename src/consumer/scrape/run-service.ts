import { OriginSchedulerV1 } from '../execution/origin-scheduler';
import { PublicCallerV1 } from '../call';
import { appendDataBlob, DataSpoolError } from './data-spool';
import { readCommittedNodeItems, readCommittedRunItems } from './result-reader';
import {
  appendJournalFrame,
  createRunId,
  createRunOperationId,
  hasOrdinaryJournalCapacity,
  JOURNAL_EMERGENCY_BYTE_RESERVE_V1,
  parseRunId,
  parseRunOperationId,
  type JournalEventV1,
  type JournalFrameBodyV1,
  type RunCancellationSourceV1,
  type RunIdV1,
} from './journal';
import { planScrapeRun, ScrapePlanningError } from './planner';
import { RunStoreV1, type RunArtifactRefV1, type RunSessionReferenceV1 } from './run-store';
import {
  parseRunOutput,
  preflightInlineRunOutput,
  preflightRunOutput,
  type RunOutputV1,
} from './output';
import { FileRunOutputSinkV1, openFileRunOutputSink, RunOutputSinkError } from './output-sink';
import { recoverRunState } from './recovery';
import { rehydrateExecutionState, ScrapeResumeError } from './resume-state';
import { resolveSafeReadReplayNodes } from './safe-read-replay';
import {
  AttemptOrderV1,
  maximumBufferedPageBytes,
  releaseOwnedAttemptTurn,
  resolveBoundedAttemptConcurrency,
} from './attempt-order';
import { enqueueDurableNode, persistDurableNodeProgress } from './durable-frontier';
import { ItemValidationError, RunBudgetExceededError } from './task-chain-errors';
import { failedTaskChain } from './task-chain-result';
import { createRunExecutionControl } from './run-execution-control';
import { appendEmergencyJournalEvent } from './journal-emergency';
import { createRunCancellation } from './run-cancellation';
import {
  finalizeIncompleteOutput,
  finalizeSuccessfulOutput,
  finalizeSuccessfulRun,
} from './output-finalization';
import { nextPaginationInput } from './pagination';
import { SemanticStopItemError, SemanticStopTrackerV1 } from './semantic-stops';
import {
  bufferRunItems,
  commitBufferedRunItems,
  reserveRetainedFanoutItems,
} from './item-emission';
import { createScrapeNode, FrontierV1, scrapeNodeValue, type ScrapeNodeV1 } from './frontier';
import { expandScrapeFanout } from './fanout';
import type {
  FrontierExecutionInputV1,
  TaskChainExecutionInputV1,
  TaskChainExecutionResultV1,
} from './run-execution-types';
import type { ExecutionStateV1 } from './run-state';
import type { LocalScrapeRunResultV1, StartedScrapeRunV1 } from './run-result';
import { isAcceptedPageResult } from './task-result';
import { calculateCollectionContractDigest } from '../../public/contracts/collection';
import {
  PublicContractError,
  parseRfc3339Instant,
  sha256Digest,
  type CapabilityIdV1,
} from '../../public/contracts/common';
import { canonicalJson, type JsonValueV1 } from '../../public/contracts/json';
import { validateJsonSchema } from '../../public/contracts/json-schema';
import type { PublicReadCapabilityV1 } from '../../public/contracts/package';
import type { ScrapeRunPolicyV1 } from '../../public/contracts/scrape-policy';

export interface StartScrapeRunInputV1 {
  run_id?: string;
  operation_id?: string;
  artifact: Omit<RunArtifactRefV1, 'collection_contract_digest'>;
  owner: PublicReadCapabilityV1;
  capabilities: Readonly<Record<CapabilityIdV1, PublicReadCapabilityV1>>;
  input: JsonValueV1;
  caller_bounds: unknown;
  input_mode_id?: string;
  output?: RunOutputV1;
  inline_output_max_bytes?: number;
  session?: RunSessionBindingV1;
  signal?: AbortSignal;
}

export interface ResumeScrapeRunInputV1 {
  run_id: string;
  artifact: RunArtifactRefV1;
  owner: PublicReadCapabilityV1;
  capabilities: Readonly<Record<CapabilityIdV1, PublicReadCapabilityV1>>;
  session?: RunSessionBindingV1;
  signal?: AbortSignal;
  cancellation_source?: () => RunCancellationSourceV1;
}

/** Keeps browser storage in memory while durable metadata carries only its identity. */
export interface RunSessionBindingV1 {
  reference: RunSessionReferenceV1;
  browser_storage_state: JsonValueV1;
}

export type { ScrapeRunSummaryV1 } from './run-state';
export type { LocalScrapeRunResultV1, StartedScrapeRunV1 } from './run-result';

export class ScrapeRunServiceV1 {
  constructor(
    private readonly store: RunStoreV1,
    private readonly caller = new PublicCallerV1(),
    private readonly now: () => Date = () => new Date(),
    private readonly scheduler = new OriginSchedulerV1(),
  ) {}
  async start(input: StartScrapeRunInputV1): Promise<LocalScrapeRunResultV1> {
    return this.startDetached(input).completion;
  }
  startDetached(input: StartScrapeRunInputV1): StartedScrapeRunV1 {
    const collection = input.owner.collection;
    if (collection === null)
      throw new ScrapePlanningError('capability does not declare a collection');
    const plan = planScrapeRun(
      input.owner,
      input.capabilities,
      input.input,
      input.caller_bounds,
      input.input_mode_id,
    );
    const runId =
      input.run_id === undefined ? createRunId() : parseRunId(input.run_id, 'run.run_id');
    const operationId =
      input.operation_id === undefined
        ? createRunOperationId()
        : parseRunOperationId(input.operation_id, 'run.operation_id');
    const output = parseRunOutput(input.output ?? { kind: 'inline' }, 'run.output');
    preflightRunOutput(output, runId);
    preflightInlineRunOutput(
      output,
      collection,
      plan.effective_bounds.policy.max_items,
      input.inline_output_max_bytes,
    );
    const artifact: RunArtifactRefV1 = {
      ...input.artifact,
      collection_contract_digest: calculateCollectionContractDigest(collection),
    };
    const initialNodes = plan.roots.map((root, outputOrdinal) =>
      createScrapeNode(
        runId,
        { kind: 'root', root_ordinal: root.root_ordinal, seed_ordinal: root.seed_ordinal },
        outputOrdinal,
        { ...root, depth: 0 },
      ),
    );
    const createdAt = parseRfc3339Instant(
      this.now()
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
      'run.created_at',
    );
    const meta = this.store.create({
      meta_schema_version: 1,
      run_id: runId,
      start_operation_id: operationId,
      artifact,
      canonical_input: input.input,
      selected_input_mode_id: plan.selected_input_mode_id,
      effective_bounds: plan.effective_bounds,
      output,
      created_at: createdAt,
      ...(input.session === undefined ? {} : { session: input.session.reference }),
    });
    const state: ExecutionStateV1 = {
      sequence: 0,
      previous_digest: null,
      execution_epoch: 0,
      summary: {
        items_emitted: 0,
        items_duplicate: 0,
        tasks_completed: 0,
        tasks_failed: 0,
        target_requests: 0,
      },
      identity_digests: new Set(),
      maximum_journal_bytes: plan.effective_bounds.policy.durable.max_journal_bytes,
      maximum_journal_frames: plan.effective_bounds.policy.durable.max_journal_frames,
      local_state_bytes: 0,
      retained_fanout_item_bytes: 0,
      output_bytes: 0,
      tasks_started: 0,
      pages_started: 0,
      next_node_ordinal: initialNodes.length,
      next_item_sequence: 1,
      known_node_ids: new Set(),
      buffered_items: new Map(),
      reserved_item_count: 0,
      reserved_output_bytes: 0,
      reserved_identity_state_bytes: 0,
      reserved_target_requests: 0,
      reserved_reorder_buffer_bytes: 0,
      had_independent_failure: false,
      terminal: false,
    };
    let initialNodeReferences;
    try {
      initialNodeReferences = initialNodes.map((node) =>
        appendDataBlob(
          this.store.dataSpoolPath(runId),
          scrapeNodeValue(node),
          plan.effective_bounds.policy.durable.max_data_spool_bytes,
        ),
      );
    } catch (error) {
      this.store.discard(runId);
      if (error instanceof DataSpoolError && error.code === 'durable_budget_exhausted') {
        throw new RunBudgetExceededError('data spool budget cannot record initial run nodes');
      }
      throw error;
    }
    let recordedRunCreation: boolean;
    try {
      recordedRunCreation = this.append(
        runId,
        plan.effective_bounds.policy.durable.max_journal_bytes,
        state,
        {
          kind: 'run_created',
          meta_digest: meta.meta_digest,
          initial_nodes: initialNodeReferences,
        },
      );
    } catch (error) {
      this.store.discard(runId);
      throw error;
    }
    if (!recordedRunCreation) {
      this.store.discard(runId);
      throw new RunBudgetExceededError('journal budget cannot record run creation');
    }
    let sink: FileRunOutputSinkV1 | null = null;
    let finished: LocalScrapeRunResultV1 | null = null;
    try {
      sink = openFileRunOutputSink(
        this.store,
        output,
        runId,
        collection.csv_columns,
        plan.effective_bounds.policy,
        false,
      );
      state.output_bytes = sink?.bytes_written ?? 0;
    } catch (error) {
      if (!(error instanceof RunOutputSinkError)) throw error;
      finished = this.finish(runId, state, 'output_sink_failure');
    }
    const cancellation = createRunCancellation({
      run_id: runId,
      maximum_journal_bytes: plan.effective_bounds.policy.durable.max_journal_bytes,
      state,
      external_signal: input.signal,
      append_emergency: (event) => {
        this.appendEmergency(
          runId,
          plan.effective_bounds.policy.durable.max_journal_bytes,
          state,
          event,
        );
      },
    });
    const frontier = new FrontierV1(plan.effective_bounds.policy.durable.max_frontier_bytes);
    if (cancellation.signal.aborted) {
      finished ??= this.finish(runId, state, 'cancelled', sink);
    }
    for (const node of initialNodes) {
      if (finished !== null) break;
      state.known_node_ids.add(node.node_id);
      if (!frontier.enqueue(node)) {
        finished = this.finish(runId, state, 'run_budget_exhausted', sink);
        break;
      }
    }
    const completion =
      finished === null
        ? this.executeFrontier({
            run_id: runId,
            args: input.input,
            capabilities: input.capabilities,
            collection,
            named_limits: plan.effective_bounds.named_limits,
            policy: plan.effective_bounds.policy,
            state,
            frontier,
            sink,
            browser_storage_state: input.session?.browser_storage_state,
            signal: cancellation.signal,
          })
        : Promise.resolve(finished);
    return {
      run_id: runId,
      completion: completion.finally(() => {
        cancellation.dispose();
      }),
      cancel: (source) => cancellation.cancel(source),
    };
  }
  async resume(input: ResumeScrapeRunInputV1): Promise<LocalScrapeRunResultV1> {
    const runId = parseRunId(input.run_id, 'run_id');
    return this.store.withResumeLease(runId, async () => {
      const meta = this.store.read(runId).payload;
      const collection = input.owner.collection;
      if (collection === null)
        throw new ScrapeResumeError('capability does not declare a collection');
      const declaredOwner = input.capabilities[meta.artifact.capability];
      if (
        !declaredOwner ||
        canonicalJson(declaredOwner as unknown as JsonValueV1) !==
          canonicalJson(input.owner as unknown as JsonValueV1)
      ) {
        throw new ScrapeResumeError(
          'run capability is not present in the supplied immutable package',
        );
      }
      if (
        canonicalJson(meta.artifact as unknown as JsonValueV1) !==
        canonicalJson(input.artifact as unknown as JsonValueV1)
      ) {
        throw new ScrapeResumeError('installed artifact does not match the immutable run artifact');
      }
      if (
        meta.artifact.collection_contract_digest !== calculateCollectionContractDigest(collection)
      ) {
        throw new ScrapeResumeError(
          'collection contract does not match the immutable run artifact',
        );
      }
      const recovered = recoverRunState(this.store, runId);
      const replayNodes = resolveSafeReadReplayNodes(recovered, collection, input.capabilities);
      if (
        !recovered.resume.allowed &&
        !(recovered.resume.reason === 'unknown_attempt' && replayNodes.length > 0)
      ) {
        throw new ScrapeResumeError(`run cannot resume: ${recovered.resume.reason}`);
      }
      const state = rehydrateExecutionState(this.store, runId, meta.effective_bounds, collection);
      for (const recoveredNode of recovered.nodes) {
        state.known_node_ids.add(recoveredNode.node.node_id);
        state.next_node_ordinal = Math.max(
          state.next_node_ordinal,
          recoveredNode.node.output_ordinal + 1,
        );
      }
      let sink: FileRunOutputSinkV1 | null;
      try {
        sink = openFileRunOutputSink(
          this.store,
          meta.output,
          runId,
          collection.csv_columns,
          meta.effective_bounds.policy,
          true,
        );
        state.output_bytes = sink?.bytes_written ?? state.output_bytes;
      } catch (error) {
        if (!(error instanceof RunOutputSinkError)) throw error;
        return this.finish(runId, state, 'output_sink_failure');
      }
      state.execution_epoch = recovered.last_execution_epoch + 1;
      const cancellation = createRunCancellation({
        run_id: runId,
        maximum_journal_bytes: meta.effective_bounds.policy.durable.max_journal_bytes,
        state,
        external_signal: input.signal,
        external_source: input.cancellation_source,
        append_emergency: (event) => {
          this.appendEmergency(
            runId,
            meta.effective_bounds.policy.durable.max_journal_bytes,
            state,
            event,
          );
        },
      });
      try {
        if (cancellation.signal.aborted) {
          return this.finish(runId, state, 'cancelled', sink);
        }
        if (
          !this.append(runId, meta.effective_bounds.policy.durable.max_journal_bytes, state, {
            kind: 'state_changed',
            state: {
              kind: 'running',
              execution_epoch: state.execution_epoch,
              current_node_id: null,
            },
          })
        ) {
          return this.finish(runId, state, 'run_budget_exhausted', sink);
        }
        const replayNodeIds = new Set(
          replayNodes.map((recoveredNode) => recoveredNode.node.node_id),
        );
        for (const replayNode of replayNodes) {
          if (
            !this.append(runId, meta.effective_bounds.policy.durable.max_journal_bytes, state, {
              kind: 'node_replay_authorized',
              node_id: replayNode.node.node_id,
              task_kind_id: replayNode.node.task_kind_id,
            })
          ) {
            return this.finish(runId, state, 'run_budget_exhausted', sink);
          }
        }
        const frontier = new FrontierV1(meta.effective_bounds.policy.durable.max_frontier_bytes);
        for (const recoveredNode of recovered.nodes) {
          if (recoveredNode.state !== 'pending' && !replayNodeIds.has(recoveredNode.node.node_id)) {
            continue;
          }
          if (!frontier.enqueue(recoveredNode.node)) {
            return this.finish(runId, state, 'run_budget_exhausted', sink);
          }
        }
        return await this.executeFrontier({
          run_id: runId,
          args: meta.canonical_input,
          capabilities: input.capabilities,
          collection,
          named_limits: meta.effective_bounds.named_limits,
          policy: meta.effective_bounds.policy,
          state,
          frontier,
          sink,
          browser_storage_state: input.session?.browser_storage_state,
          signal: cancellation.signal,
        });
      } finally {
        cancellation.dispose();
      }
    });
  }
  private async executeFrontier(input: FrontierExecutionInputV1): Promise<LocalScrapeRunResultV1> {
    const control = createRunExecutionControl(input.signal, input.policy.total_timeout_ms);
    try {
      const templates = new Map(
        input.collection.start_url_templates.map((template) => [template.id, template]),
      );
      const taskKinds = new Map(input.collection.task_kinds.map((task) => [task.id, task]));
      const semanticStops = new SemanticStopTrackerV1(
        input.collection,
        input.args,
        readCommittedRunItems(this.store, input.run_id),
      );
      const maximumWorkers = resolveBoundedAttemptConcurrency(input.policy, input.capabilities);
      while (input.frontier.hasNext()) {
        const stop = control.stop();
        if (stop !== null) return this.finish(input.run_id, input.state, stop, input.sink);
        const batch: Array<{
          node: ScrapeNodeV1;
          task: NonNullable<PublicReadCapabilityV1['collection']>['task_kinds'][number];
          capability: PublicReadCapabilityV1;
        }> = [];
        while (batch.length < maximumWorkers && input.frontier.hasNext()) {
          const node = input.frontier.dequeue();
          const task = taskKinds.get(node.task_kind_id);
          const capability = input.capabilities[node.capability];
          if (!task || !capability) {
            return this.finish(input.run_id, input.state, 'task_failed', input.sink);
          }
          batch.push({ node, task, capability });
        }
        const attemptOrder = new AttemptOrderV1();
        let batchStop: ReturnType<typeof control.stop> = null;
        const executed = await Promise.all(
          batch.map(({ node, task, capability }) =>
            this.executeTaskChain({
              run_id: input.run_id,
              node,
              task,
              capability,
              collection: input.collection,
              named_limits: input.named_limits,
              policy: input.policy,
              scheduler: this.scheduler,
              templates,
              state: input.state,
              sink: input.sink,
              semantic_stops: semanticStops,
              browser_storage_state: input.browser_storage_state,
              signal: control.signal,
              stop: () => batchStop ?? control.stop(),
              attempt_order: attemptOrder,
              report_stop: (next) => {
                batchStop ??= next;
              },
            }),
          ),
        );
        for (const [index, result] of executed.entries()) {
          const current = batch[index];
          if (!current) throw new PublicContractError('run.frontier', 'batch entry is missing');
          const { node, task } = current;
          if (result.kind === 'completed') {
            const finalized = finalizeSuccessfulRun({
              state: input.state,
              stop: result.stop,
              sink: input.sink,
              append_emergency: (event) => {
                this.appendEmergency(
                  input.run_id,
                  input.state.maximum_journal_bytes,
                  input.state,
                  event,
                );
              },
            });
            if (finalized.kind === 'scrape_outcome') {
              return {
                kind: finalized.kind,
                run_id: input.run_id,
                summary: input.state.summary,
                stop: finalized.stop,
              };
            }
            return {
              kind: finalized.kind,
              run_id: input.run_id,
              summary: input.state.summary,
              stop: finalized.stop,
            };
          }
          if (result.kind !== 'ok') {
            if (result.stop === 'cancelled' || result.stop === 'deadline_exhausted') {
              return this.finish(input.run_id, input.state, result.stop, input.sink);
            }
            if (task.on_failure === 'stop_run') {
              return this.finish(input.run_id, input.state, result.stop, input.sink);
            }
            input.state.had_independent_failure = true;
            input.state.summary.tasks_failed += 1;
            if (
              !this.append(input.run_id, input.policy.durable.max_journal_bytes, input.state, {
                kind: 'task_skipped',
                node_id: node.node_id,
                task_kind_id: task.id,
                stop: result.stop,
              })
            ) {
              return this.finish(input.run_id, input.state, 'run_budget_exhausted', input.sink);
            }
            continue;
          }
          try {
            let children: ScrapeNodeV1[];
            try {
              children = expandScrapeFanout(
                input.run_id,
                task,
                result.items,
                node,
                input.args,
                input.collection,
                taskKinds,
                input.capabilities,
                () => {
                  const ordinal = input.state.next_node_ordinal;
                  input.state.next_node_ordinal += 1;
                  return ordinal;
                },
              );
            } catch (error) {
              if (!(error instanceof PublicContractError)) throw error;
              if (task.on_failure === 'stop_run') {
                return this.finish(input.run_id, input.state, 'task_failed', input.sink);
              }
              input.state.had_independent_failure = true;
              input.state.summary.tasks_failed += 1;
              if (
                !this.append(input.run_id, input.policy.durable.max_journal_bytes, input.state, {
                  kind: 'task_skipped',
                  node_id: node.node_id,
                  task_kind_id: task.id,
                  stop: 'task_failed',
                })
              ) {
                return this.finish(input.run_id, input.state, 'run_budget_exhausted', input.sink);
              }
              continue;
            }
            for (const child of children) {
              const nextStop = control.stop();
              if (nextStop !== null)
                return this.finish(input.run_id, input.state, nextStop, input.sink);
              if (
                !this.enqueueNode(input.run_id, child, input.state, input.policy, input.frontier)
              ) {
                return this.finish(input.run_id, input.state, 'run_budget_exhausted', input.sink);
              }
            }
            if (
              !this.append(input.run_id, input.policy.durable.max_journal_bytes, input.state, {
                kind: 'node_completed',
                node_id: node.node_id,
              })
            ) {
              return this.finish(input.run_id, input.state, 'run_budget_exhausted', input.sink);
            }
          } finally {
            input.state.retained_fanout_item_bytes -= result.retained_fanout_item_bytes;
          }
        }
      }
      if (input.state.had_independent_failure)
        return this.finish(input.run_id, input.state, 'task_failed', input.sink);
      try {
        finalizeSuccessfulOutput({
          state: input.state,
          stop: { kind: 'source_exhausted' },
          sink: input.sink,
          append_emergency: (event) => {
            this.appendEmergency(
              input.run_id,
              input.policy.durable.max_journal_bytes,
              input.state,
              event,
            );
          },
        });
      } catch (error) {
        if (!(error instanceof RunOutputSinkError)) throw error;
        return this.finish(input.run_id, input.state, 'output_sink_failure', input.sink);
      }
      return {
        kind: 'scrape_outcome',
        run_id: input.run_id,
        summary: input.state.summary,
        stop: { kind: 'source_exhausted' },
      };
    } finally {
      control.dispose();
    }
  }
  private async executeTaskChain(
    input: TaskChainExecutionInputV1,
  ): Promise<TaskChainExecutionResultV1> {
    const maximumPagesInChain =
      input.task.pagination === null
        ? null
        : input.named_limits[input.task.pagination.max_pages_per_chain.id];
    const fail = (
      stop: Extract<TaskChainExecutionResultV1, { kind: 'failed' }>['stop'],
    ): Extract<TaskChainExecutionResultV1, { kind: 'failed' }> => failedTaskChain(input, stop);
    if (maximumPagesInChain === undefined) return fail('task_failed');
    let taskInput = input.node.input;
    const seenInputs = new Set<string>(input.node.seen_input_digests);
    const emittedItems =
      input.task.fanout.length === 0
        ? []
        : readCommittedNodeItems(this.store, input.run_id, input.node.node_id);
    let retainedFanoutItemBytes = 0;
    let transferredFanoutRetention = false;
    let pagesStartedInChain = input.node.pages_started_in_chain;
    let chainActive = true;
    let chainOrdinal: number | null = null;
    let ownsCommitTurn = false;
    try {
      if (input.task.fanout.length > 0) {
        const retained = reserveRetainedFanoutItems(input.state, input.policy, emittedItems);
        if (retained === null) return fail('run_budget_exhausted');
        retainedFanoutItemBytes = retained;
      }
      while (chainActive) {
        const stop = input.stop();
        if (stop !== null) return fail(stop);
        if (input.state.tasks_started >= input.policy.max_tasks) {
          return fail('run_budget_exhausted');
        }
        if (
          input.task.task_role === 'page' &&
          input.state.pages_started >= input.policy.max_pages
        ) {
          return fail('run_budget_exhausted');
        }
        if (maximumPagesInChain !== null && pagesStartedInChain >= maximumPagesInChain) {
          return fail('run_budget_exhausted');
        }
        if (
          input.state.summary.target_requests +
            input.state.reserved_target_requests +
            input.capability.max_target_requests_per_call >
          input.policy.max_requests
        ) {
          return fail('run_budget_exhausted');
        }
        if (
          !this.append(input.run_id, input.policy.durable.max_journal_bytes, input.state, {
            kind: 'attempt_intent',
            node_id: input.node.node_id,
            task_kind_id: input.task.id,
          })
        ) {
          return fail('run_budget_exhausted');
        }
        const reorderReservationBytes =
          chainOrdinal === null && input.attempt_order.nextOrdinal() > 0
            ? maximumBufferedPageBytes(input.policy, input.capability)
            : 0;
        if (
          input.state.reserved_reorder_buffer_bytes + reorderReservationBytes >
          input.policy.durable.max_reorder_buffer_bytes
        ) {
          return fail('run_budget_exhausted');
        }
        input.state.reserved_reorder_buffer_bytes += reorderReservationBytes;
        if (chainOrdinal === null) chainOrdinal = input.attempt_order.allocate();
        input.state.tasks_started += 1;
        if (input.task.task_role === 'page') {
          input.state.pages_started += 1;
          pagesStartedInChain += 1;
          input.node.pages_started_in_chain = pagesStartedInChain;
        }
        input.state.reserved_target_requests += input.capability.max_target_requests_per_call;
        let reservationHeld = true;
        let reorderReservationHeld = reorderReservationBytes > 0;
        const claimCommitTurn = async (): Promise<void> => {
          if (!ownsCommitTurn) {
            if (chainOrdinal === null) {
              throw new PublicContractError('run.attempt_order', 'chain ordinal is unavailable');
            }
            await input.attempt_order.waitForTurn(chainOrdinal);
            ownsCommitTurn = true;
          }
          if (reorderReservationHeld) {
            input.state.reserved_reorder_buffer_bytes -= reorderReservationBytes;
            reorderReservationHeld = false;
          }
        };
        try {
          const result = await this.caller.call(input.capability, taskInput, {
            scheduler: input.scheduler,
            signal: input.signal,
            workload_id: input.run_id,
            ...(input.browser_storage_state === undefined
              ? {}
              : { browser_storage_state: input.browser_storage_state }),
          });
          input.state.reserved_target_requests -= input.capability.max_target_requests_per_call;
          reservationHeld = false;
          input.state.summary.target_requests += result.attempts;
          if (
            !this.append(input.run_id, input.policy.durable.max_journal_bytes, input.state, {
              kind: 'attempt_observed',
              node_id: input.node.node_id,
              task_kind_id: input.task.id,
              result_kind: result.kind,
              attempts: result.attempts,
            })
          ) {
            return fail('run_budget_exhausted');
          }
          const stopAfterAttempt = input.stop();
          if (stopAfterAttempt !== null) return fail(stopAfterAttempt);
          if (
            !isAcceptedPageResult(
              result,
              input.task.page_outcome_ids,
              input.task.terminal_outcome_ids,
            )
          ) {
            await claimCommitTurn();
            if (result.kind === 'failure' && result.code === 'cancelled') {
              return fail('cancelled');
            }
            return fail('task_failed');
          }
          const bufferedPage = input.task.terminal_outcome_ids.includes(result.outcome_id)
            ? { items: [] }
            : bufferRunItems({
                run_id: input.run_id,
                collection: input.collection,
                task: input.task,
                node_id: input.node.node_id,
                node_ordinal: input.node.output_ordinal,
                page_ordinal: pagesStartedInChain - 1,
                task_data: result.data,
                state: input.state,
                policy: input.policy,
                sink: input.sink,
                store: this.store,
                append: (event) =>
                  this.append(
                    input.run_id,
                    input.policy.durable.max_journal_bytes,
                    input.state,
                    event,
                  ),
                has_ordinary_journal_capacity: (frameCount) =>
                  hasOrdinaryJournalCapacity(input.state, frameCount),
              });
          await claimCommitTurn();
          const stopAfterOrdering = input.stop();
          if (stopAfterOrdering !== null) return fail(stopAfterOrdering);
          if (
            !this.append(input.run_id, input.policy.durable.max_journal_bytes, input.state, {
              kind: 'task_completed',
              node_id: input.node.node_id,
              task_kind_id: input.task.id,
            })
          ) {
            return fail('run_budget_exhausted');
          }
          input.state.summary.tasks_completed += 1;
          if (input.task.terminal_outcome_ids.includes(result.outcome_id)) {
            chainActive = false;
            continue;
          }
          const pageEmission = commitBufferedRunItems({
            items: bufferedPage.items,
            state: input.state,
            policy: input.policy,
            sink: input.sink,
            semantic_stops: input.semantic_stops,
            has_fanout: input.task.fanout.length > 0,
            append: (event) =>
              this.append(input.run_id, input.policy.durable.max_journal_bytes, input.state, event),
            has_ordinary_journal_capacity: (frameCount) =>
              hasOrdinaryJournalCapacity(input.state, frameCount),
          });
          emittedItems.push(...pageEmission.items);
          retainedFanoutItemBytes += pageEmission.retained_item_bytes;
          if (pageEmission.semantic_stop_id !== null) {
            return {
              kind: 'completed',
              stop: {
                kind: 'date_cutoff_reached',
                semantic_stop_id: pageEmission.semantic_stop_id,
              },
            };
          }
          const continuation = nextPaginationInput(input.task, taskInput, result, input.templates);
          if (continuation === null) {
            chainActive = false;
            continue;
          }
          const digest = sha256Digest(canonicalJson(continuation));
          if (seenInputs.has(digest)) return fail('task_failed');
          seenInputs.add(digest);
          validateJsonSchema(continuation, input.capability.input_schema, 'run.pagination.input');
          taskInput = continuation;
          input.node.input = continuation;
          input.node.seen_input_digests = [...seenInputs];
          if (
            !persistDurableNodeProgress({
              run_id: input.run_id,
              node: input.node,
              state: input.state,
              policy: input.policy,
              store: this.store,
              append: (event) =>
                this.append(
                  input.run_id,
                  input.policy.durable.max_journal_bytes,
                  input.state,
                  event,
                ),
            })
          ) {
            return fail('run_budget_exhausted');
          }
        } catch (error) {
          if (error instanceof RunBudgetExceededError) {
            await claimCommitTurn();
            return fail('run_budget_exhausted');
          }
          if (error instanceof DataSpoolError && error.code === 'durable_budget_exhausted') {
            await claimCommitTurn();
            return fail('run_budget_exhausted');
          }
          if (error instanceof RunOutputSinkError) {
            await claimCommitTurn();
            return fail('output_sink_failure');
          }
          if (
            error instanceof ItemValidationError ||
            error instanceof SemanticStopItemError ||
            error instanceof PublicContractError
          ) {
            await claimCommitTurn();
            return fail('item_invalid');
          }
          input.attempt_order.abort(error);
          throw error;
        } finally {
          if (reservationHeld) {
            input.state.reserved_target_requests -= input.capability.max_target_requests_per_call;
          }
          if (reorderReservationHeld) {
            input.state.reserved_reorder_buffer_bytes -= reorderReservationBytes;
          }
        }
      }
      transferredFanoutRetention = true;
      return {
        kind: 'ok',
        items: emittedItems,
        retained_fanout_item_bytes: retainedFanoutItemBytes,
      };
    } finally {
      if (!transferredFanoutRetention && retainedFanoutItemBytes > 0) {
        input.state.retained_fanout_item_bytes -= retainedFanoutItemBytes;
      }
      releaseOwnedAttemptTurn(input.attempt_order, chainOrdinal, ownsCommitTurn);
    }
  }
  private enqueueNode(
    runId: RunIdV1,
    node: ScrapeNodeV1,
    state: ExecutionStateV1,
    policy: ScrapeRunPolicyV1,
    frontier: FrontierV1,
  ): boolean {
    if (state.known_node_ids.has(node.node_id)) return true;
    const enqueued = enqueueDurableNode({
      run_id: runId,
      node,
      state,
      policy,
      frontier,
      store: this.store,
      append: (event) => this.append(runId, policy.durable.max_journal_bytes, state, event),
    });
    if (enqueued) state.known_node_ids.add(node.node_id);
    return enqueued;
  }
  private append(
    runId: RunIdV1,
    maximumJournalBytes: number,
    state: ExecutionStateV1,
    event: JournalEventV1,
  ): boolean {
    if (!hasOrdinaryJournalCapacity(state)) return false;
    const frame: JournalFrameBodyV1 = {
      frame_schema_version: 1,
      run_id: runId,
      sequence: state.sequence + 1,
      execution_epoch: state.execution_epoch,
      previous_frame_digest: state.previous_digest,
      event,
    };
    const appended = appendJournalFrame(
      this.store.journalPath(runId),
      frame,
      maximumJournalBytes,
      state.maximum_journal_frames,
      JOURNAL_EMERGENCY_BYTE_RESERVE_V1,
    );
    state.sequence = appended.body.sequence;
    state.previous_digest = appended.digest;
    return true;
  }

  private appendEmergency(
    runId: RunIdV1,
    maximumJournalBytes: number,
    state: ExecutionStateV1,
    event: JournalEventV1,
  ): void {
    appendEmergencyJournalEvent(
      runId,
      this.store.journalPath(runId),
      maximumJournalBytes,
      state,
      event,
    );
  }

  private finish(
    runId: RunIdV1,
    state: ExecutionStateV1,
    stop: Extract<LocalScrapeRunResultV1, { kind: 'scrape_partial' | 'scrape_failure' }>['stop'],
    sink: FileRunOutputSinkV1 | null = null,
  ): LocalScrapeRunResultV1 {
    const finalized = finalizeIncompleteOutput({
      state,
      stop,
      sink,
      append_emergency: (event) => {
        this.appendEmergency(runId, state.maximum_journal_bytes, state, event);
      },
    });
    return { kind: finalized.kind, run_id: runId, summary: state.summary, stop: finalized.stop };
  }
}
