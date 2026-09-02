export interface ConsumerRunOutputFailureV1 {
  kind: 'consumer_run_output_failure';
  code: 'output_sink_required';
}

export function isConsumerRunOutputFailure(value: unknown): value is ConsumerRunOutputFailureV1 {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'consumer_run_output_failure' &&
    (value as { code?: unknown }).code === 'output_sink_required'
  );
}
