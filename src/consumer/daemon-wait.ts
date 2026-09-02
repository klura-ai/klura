import { PublicContractError } from '../public/contracts/common';

export function awaitWithSignal<Value>(
  value: Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  if (signal?.aborted) {
    return Promise.reject(new PublicContractError('consumer.runs.wait', 'observer cancelled'));
  }
  if (signal === undefined) return value;
  return new Promise<Value>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(new PublicContractError('consumer.runs.wait', 'observer cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void value.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
