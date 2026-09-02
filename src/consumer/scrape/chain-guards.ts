import { PublicContractError } from '../../public/contracts/common';
import type { JsonValueV1 } from '../../public/contracts/json';
import { validateJsonSchema } from '../../public/contracts/json-schema';
import type { PublicReadCapabilityV1 } from '../../public/contracts/package';
import type { PublicCallResultV1 } from '../call';
import { DataSpoolError } from './data-spool';
import { ItemValidationError, RunBudgetExceededError } from './task-chain-errors';
import { RunJournalError, type JournalEventV1, type RunNodeIdV1, type RunStopV1 } from './journal';
import { boundStopReasonMessage } from './stop-reason';
import type { StableContractIdV1 } from '../../public/contracts/common';
import { RunOutputSinkError } from './output-sink';
import { SemanticStopItemError } from './semantic-stops';

/** A stop's cause as one line of text, whatever raised it. */
export function causeText(cause: unknown): string {
  if (typeof cause === 'string') return cause;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** The budget stop a committed page has just made unavoidable, if any. */
export function ceilingReachedAfterPage(
  input: {
    state: { summary: { items_emitted: number }; pages_started: number };
    policy: { max_items: number; max_pages: number };
    task: { task_role: string };
  },
  pagesStartedInChain: number,
  maximumPagesInChain: number | null,
): Extract<RunStopV1, 'run_budget_exhausted'> | null {
  if (input.state.summary.items_emitted >= input.policy.max_items) return 'run_budget_exhausted';
  if (input.task.task_role === 'page' && input.state.pages_started >= input.policy.max_pages) {
    return 'run_budget_exhausted';
  }
  if (maximumPagesInChain !== null && pagesStartedInChain >= maximumPagesInChain) {
    return 'run_budget_exhausted';
  }
  return null;
}

/** Why the page capability's own input schema refuses the next page's input. */
export function paginationInputIssue(
  continuation: JsonValueV1,
  capability: PublicReadCapabilityV1,
): PublicContractError | null {
  try {
    validateJsonSchema(continuation, capability.input_schema, 'run.pagination.input');
    return null;
  } catch (error) {
    if (error instanceof PublicContractError) return error;
    throw error;
  }
}

/** The stop a task-chain error classifies as, or null when it is not a
 *  classified stop and must propagate. A journal that ran out of budget is a
 *  budget stop; a corrupt one is never classified. */
export function chainStopForError(
  error: unknown,
): Extract<RunStopV1, 'run_budget_exhausted' | 'output_sink_failure' | 'item_invalid'> | null {
  if (error instanceof RunBudgetExceededError) return 'run_budget_exhausted';
  if (error instanceof DataSpoolError) {
    return error.code === 'durable_budget_exhausted' ? 'run_budget_exhausted' : null;
  }
  if (error instanceof RunOutputSinkError) return 'output_sink_failure';
  if (error instanceof RunJournalError) {
    return error.code === 'durable_budget_exhausted' ? 'run_budget_exhausted' : null;
  }
  if (
    error instanceof ItemValidationError ||
    error instanceof SemanticStopItemError ||
    error instanceof PublicContractError
  ) {
    return 'item_invalid';
  }
  return null;
}

export function describeResult(result: PublicCallResultV1): string {
  if (result.kind === 'outcome') return `outcome ${result.outcome_id} (${result.outcome_class})`;
  if (result.kind === 'failure') return `failure ${result.code}`;
  return result.kind;
}

export interface StopReasonInputV1 {
  node_id: RunNodeIdV1 | null;
  task_kind_id: StableContractIdV1 | null;
  stop: RunStopV1;
  cause: unknown;
}

/** The journal frame that records why a stop was chosen. */
export function stopReasonEvent(reason: StopReasonInputV1): JournalEventV1 {
  return {
    kind: 'stop_reason',
    node_id: reason.node_id,
    task_kind_id: reason.task_kind_id,
    stop: reason.stop,
    message: boundStopReasonMessage(causeText(reason.cause)),
  };
}

/** Why a dequeued node cannot run: its task kind or its capability is gone. */
export function missingTaskCause(
  node: { task_kind_id: string; capability: string },
  task: unknown,
): string {
  return task === undefined
    ? `task kind ${node.task_kind_id} is not declared by the collection`
    : `capability ${node.capability} is absent from the package`;
}
