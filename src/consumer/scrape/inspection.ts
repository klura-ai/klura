import { PublicContractError } from '../../public/contracts/common';
import {
  recoverJournalFile,
  RunJournalError,
  type RunCancellationSourceV1,
  type TerminalRunStopV1,
  type RunIdV1,
} from './journal';
import { RunStoreV1, type RunMetaEnvelopeV1 } from './run-store';

export type StoredRunLifecycleV1 =
  | { kind: 'nonterminal'; last_sequence: number }
  | {
      kind: 'interrupted';
      reason: 'daemon_stopped' | 'daemon_crash' | 'process_crash' | 'browser_crash';
      sequence: number;
    }
  | { kind: 'cancelling'; source: RunCancellationSourceV1; sequence: number }
  | {
      kind: 'terminal';
      result_kind: 'scrape_outcome' | 'scrape_partial' | 'scrape_failure';
      stop: TerminalRunStopV1;
      sequence: number;
    };

export interface StoredRunInspectionV1 {
  run_id: RunIdV1;
  meta: RunMetaEnvelopeV1;
  /** Highest durable journal frame applied to this inspection. */
  state_version: number;
  lifecycle: StoredRunLifecycleV1;
  committed_item_count: number;
}

export class RunInspectionError extends PublicContractError {
  constructor(message: string) {
    super('run.journal', message);
    this.name = 'RunInspectionError';
  }
}

/** Reads the durable lifecycle without assigning semantics to a missing terminal frame. */
export function inspectStoredRun(store: RunStoreV1, runId: RunIdV1): StoredRunInspectionV1 {
  const meta = store.read(runId);
  try {
    const frames = recoverJournalFile(store.journalPath(runId), runId).frames;
    if (frames.length === 0) {
      throw new PublicContractError('run.journal', 'is missing its run creation frame');
    }
    const firstFrame = frames[0];
    if (!firstFrame) {
      throw new PublicContractError('run.journal', 'is missing its run creation frame');
    }
    const first = firstFrame.body.event;
    if (first.kind !== 'run_created' || first.meta_digest !== meta.meta_digest) {
      throw new PublicContractError('run.journal', 'run creation frame does not bind metadata');
    }
    let terminal: Extract<StoredRunLifecycleV1, { kind: 'terminal' }> | null = null;
    let interrupted: Extract<StoredRunLifecycleV1, { kind: 'interrupted' }> | null = null;
    let cancelling: Extract<StoredRunLifecycleV1, { kind: 'cancelling' }> | null = null;
    let committedItems = 0;
    for (const frame of frames) {
      const event = frame.body.event;
      if (event.kind === 'item_committed') committedItems += 1;
      if (event.kind !== 'terminal') {
        if (terminal !== null) {
          throw new PublicContractError('run.journal', 'contains work after its terminal frame');
        }
        if (event.kind === 'interrupted') {
          interrupted = {
            kind: 'interrupted',
            reason: event.reason,
            sequence: frame.body.sequence,
          };
        } else if (event.kind === 'state_changed') {
          interrupted = null;
        } else if (event.kind === 'cancel_requested') {
          cancelling = {
            kind: 'cancelling',
            source: event.source,
            sequence: frame.body.sequence,
          };
        }
        continue;
      }
      if (terminal !== null) {
        throw new PublicContractError('run.journal', 'contains more than one terminal frame');
      }
      terminal = {
        kind: 'terminal',
        result_kind: event.descriptor.result_kind,
        stop: event.descriptor.stop,
        sequence: frame.body.sequence,
      };
    }
    return {
      run_id: runId,
      meta,
      state_version: frames.at(-1)?.body.sequence ?? 0,
      lifecycle: terminal ??
        cancelling ??
        interrupted ?? {
          kind: 'nonterminal',
          last_sequence: frames.at(-1)?.body.sequence ?? 0,
        },
      committed_item_count: committedItems,
    };
  } catch (error) {
    if (error instanceof RunJournalError || error instanceof PublicContractError) {
      throw new RunInspectionError(error.message);
    }
    throw error;
  }
}
