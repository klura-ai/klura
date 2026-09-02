import type { TaskChainExecutionInputV1, TaskChainExecutionResultV1 } from './run-execution-types';

export function failedTaskChain(
  input: Pick<TaskChainExecutionInputV1, 'task' | 'report_stop'>,
  stop: Extract<TaskChainExecutionResultV1, { kind: 'failed' }>['stop'],
): Extract<TaskChainExecutionResultV1, { kind: 'failed' }> {
  if (
    input.task.on_failure === 'stop_run' ||
    stop === 'cancelled' ||
    stop === 'deadline_exhausted'
  ) {
    input.report_stop(stop);
  }
  return { kind: 'failed', stop };
}
