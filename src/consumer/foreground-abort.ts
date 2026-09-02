interface SigintSourceV1 {
  once(event: 'SIGINT', listener: () => void): unknown;
  removeListener(event: 'SIGINT', listener: () => void): unknown;
}

export interface ForegroundAbortV1 {
  signal: AbortSignal;
  dispose(): void;
}

/** Turns one foreground SIGINT into a cooperative run cancellation. */
export function createForegroundAbort(source: SigintSourceV1 = process): ForegroundAbortV1 {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  source.once('SIGINT', abort);
  return {
    signal: controller.signal,
    dispose: () => {
      source.removeListener('SIGINT', abort);
    },
  };
}
