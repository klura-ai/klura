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

/**
 * Error codes the runtime itself substitutes for a body that blew the tool
 * output budget. Recognising them is structural rather than heuristic: these
 * are the runtime's own strings, not site prose, so a match cannot drift with
 * a vendor's wording or a translation. Produced in `execution/fetch-browser`.
 */
export const OVERSIZE_BODY_CODES = [
  'response_too_large',
  'response_too_large_html_trimmed',
] as const;

/**
 * True when a body IS the runtime's oversize envelope rather than a site
 * payload. Requires both the known code and the `total_chars` the runtime
 * always attaches, so a site field that happens to be called `error` cannot
 * be mistaken for one.
 */
export function isOversizeBodyEnvelope(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return (
    typeof record.error === 'string' &&
    (OVERSIZE_BODY_CODES as readonly string[]).includes(record.error) &&
    typeof record.total_chars === 'number'
  );
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
  // An oversize envelope is the runtime reporting that it produced no usable
  // body at all. That is a definite failure, not transport acceptance with
  // unknown semantics — treating it as the latter lets a strategy that can
  // never return a row reach semantic review and be approved into active.
  if (isOversizeBodyEnvelope(result.body)) return 'explicit_failure';
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
  body?: unknown,
): string {
  if (classification === 'explicit_failure') {
    if (isOversizeBodyEnvelope(body)) {
      return `HTTP ${status} with a body that exceeded the output budget and declared no extraction`;
    }
    return `HTTP ${status} with body.ok === false`;
  }
  if (classification === 'not_run') return 'request was not sent';
  if (classification === 'delivery_unknown') {
    return 'request was sent but delivery could not be confirmed';
  }
  if (status === 0) return 'a runtime error';
  return `HTTP ${status}`;
}
