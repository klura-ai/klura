import type { JournalEventV1, RunCancellationSourceV1, RunIdV1 } from './journal';
import type { ExecutionStateV1 } from './run-state';

export interface RunCancellationV1 {
  signal: AbortSignal;
  cancel(source?: RunCancellationSourceV1): boolean;
  dispose(): void;
}

export interface CreateRunCancellationInputV1 {
  run_id: RunIdV1;
  maximum_journal_bytes: number;
  state: ExecutionStateV1;
  external_signal?: AbortSignal;
  external_source?: () => RunCancellationSourceV1;
  append_emergency(event: JournalEventV1): void;
}

/** Persists an explicit cancellation request before aborting owned execution work. */
export function createRunCancellation(input: CreateRunCancellationInputV1): RunCancellationV1 {
  const controller = new AbortController();
  let requested = false;
  const cancel = (source: RunCancellationSourceV1 = 'sdk_cancel'): boolean => {
    if (requested || input.state.terminal) return false;
    input.append_emergency({ kind: 'cancel_requested', source });
    requested = true;
    controller.abort();
    return true;
  };
  const onExternalAbort = (): void => {
    cancel(input.external_source?.() ?? 'sdk_cancel');
  };
  if (input.external_signal?.aborted) onExternalAbort();
  else input.external_signal?.addEventListener('abort', onExternalAbort, { once: true });
  return {
    signal: controller.signal,
    cancel,
    dispose: () => {
      input.external_signal?.removeEventListener('abort', onExternalAbort);
    },
  };
}
