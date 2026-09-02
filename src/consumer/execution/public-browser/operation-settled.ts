import { PublicHttpExecutionError } from '../node-http';

export interface OperationSettledWaiterV1 {
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  abort: () => void;
}

interface SettledBrowserOperationV1 {
  pending_request_ids: Set<string>;
  waiters: Set<OperationSettledWaiterV1>;
}

export function waitForOperationSettled<OperationV1 extends SettledBrowserOperationV1>(
  operation: OperationV1,
  signal: AbortSignal,
  finish: (operation: OperationV1, waiter: OperationSettledWaiterV1) => void,
  reject: (operation: OperationV1, waiter: OperationSettledWaiterV1, error: Error) => void,
): Promise<void> {
  if (operation.pending_request_ids.size === 0) return Promise.resolve();
  return new Promise<void>((resolve, rejectPromise) => {
    const waiter: OperationSettledWaiterV1 = {
      signal,
      resolve,
      reject: rejectPromise,
      abort: () => {
        reject(
          operation,
          waiter,
          new PublicHttpExecutionError('cancelled', 'caller cancelled browser operation wait'),
        );
      },
    };
    operation.waiters.add(waiter);
    signal.addEventListener('abort', waiter.abort, { once: true });
    if (operation.pending_request_ids.size === 0) finish(operation, waiter);
  });
}
