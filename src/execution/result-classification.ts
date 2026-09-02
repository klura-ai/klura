// Local factory strategies do not carry the signed outcome contracts used by
// public consumer packages. Their only explicit semantic signal is a boolean
// `body.ok`; an HTTP 2xx without that field proves transport acceptance only.

export type FactoryExecutionClassification =
  | 'explicit_success'
  | 'explicit_failure'
  | 'transport_accepted'
  | 'transport_failure'
  | 'not_run';

export interface FactoryExecutionResultLike {
  status?: unknown;
  body?: unknown;
  /** Runtime-hoisted copy retained when an oversized object body is compacted. */
  body_ok?: unknown;
}

export function classifyFactoryExecutionResult(
  result: FactoryExecutionResultLike | undefined,
): FactoryExecutionClassification {
  if (!result || typeof result.status !== 'number') return 'transport_failure';
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
  if (status === 0) return 'a runtime error';
  return `HTTP ${status}`;
}
