import type { RunStopV1 } from './journal';

export interface RunExecutionControlV1 {
  signal: AbortSignal;
  stop(): RunStopV1 | null;
  dispose(): void;
}

export function createRunExecutionControl(
  externalSignal: AbortSignal | undefined,
  totalTimeoutMs: number,
): RunExecutionControlV1 {
  const controller = new AbortController();
  let stop: RunStopV1 | null = null;
  const deadlineAt = Date.now() + totalTimeoutMs;
  const abort = (next: RunStopV1): void => {
    if (stop !== null) return;
    stop = next;
    controller.abort();
  };
  const onExternalAbort = (): void => {
    abort('cancelled');
  };
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const deadline = setTimeout(() => {
    abort('deadline_exhausted');
  }, totalTimeoutMs);
  const currentStop = (): RunStopV1 | null => {
    if (stop === null && Date.now() >= deadlineAt) abort('deadline_exhausted');
    return stop;
  };
  return {
    signal: controller.signal,
    stop: currentStop,
    dispose: () => {
      clearTimeout(deadline);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}
