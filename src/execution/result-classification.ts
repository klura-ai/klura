// Local factory strategies do not carry the signed outcome contracts used by
// public consumer packages. Their only explicit semantic signal is a boolean
// `body.ok`; an HTTP 2xx without that field proves transport acceptance only.

export type FactoryExecutionClassification =
  | 'explicit_success'
  | 'explicit_failure'
  | 'transport_accepted'
  | 'transport_failure'
  | 'not_run'
  | 'delivery_unknown';

export interface FactoryExecutionResultLike {
  status?: unknown;
  body?: unknown;
  executionState?: unknown;
  /** Runtime-hoisted copy retained when an oversized object body is compacted. */
  body_ok?: unknown;
}

export class FactoryExecutionStateError extends Error {
  constructor(
    readonly executionState: 'not_run' | 'sent_unconfirmed',
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'FactoryExecutionStateError';
  }
}

export function classifyFactoryExecutionResult(
  result: FactoryExecutionResultLike | undefined,
): FactoryExecutionClassification {
  if (!result) return 'transport_failure';
  if (result.executionState === 'not_run') return 'not_run';
  if (result.executionState === 'sent_unconfirmed') return 'delivery_unknown';
  if (typeof result.status !== 'number') return 'transport_failure';
  if (result.status < 200 || result.status >= 300) return 'transport_failure';
  const inline =
    result.body && typeof result.body === 'object' && !Array.isArray(result.body)
      ? (result.body as Record<string, unknown>).ok
      : undefined;
  const explicit = typeof inline === 'boolean' ? inline : result.body_ok;
  if (explicit === true) return 'explicit_success';
  if (explicit === false) return 'explicit_failure';
  return 'transport_accepted';
}

export function factoryExecutionWasAccepted(
  classification: FactoryExecutionClassification,
): boolean {
  return classification === 'explicit_success' || classification === 'transport_accepted';
}

export function describeFactoryExecutionFailure(
  classification: FactoryExecutionClassification,
  status: number,
): string {
  if (classification === 'explicit_failure') {
    return `HTTP ${status} with body.ok === false`;
  }
  if (classification === 'not_run') return 'request was not sent';
  if (classification === 'delivery_unknown') {
    return 'request was sent but delivery could not be confirmed';
  }
  if (status === 0) return 'a runtime error';
  return `HTTP ${status}`;
}
