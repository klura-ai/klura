// Shared error utilities for save-time prereq probing. Live here because both
// the orchestrator and the per-kind probes throw `invalid_strategy: ...` and
// the orchestrator de-prefixes them to render a single batched rejection.

/**
 * Match the transient navigation/context-destroyed errors that Playwright /
 * CDP surface when the page navigates / redirects mid-evaluation and tears
 * down the execution context. Used by the js-eval probe's retry-once path —
 * genuine expression errors (SyntaxError, missing global, TypeError) do NOT
 * match and surface immediately on the first attempt.
 */
export function isTransientNavigationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /execution context (was )?destroyed/i.test(msg) ||
    /frame (was )?detached/i.test(msg) ||
    /target closed/i.test(msg) ||
    (/navigation/i.test(msg) && /context|page|frame/i.test(msg))
  );
}

/** Strip the leading `invalid_strategy: ` sentinel from a probe-throw so
 *  the batched aggregator can render a single canonical header with
 *  per-prereq bullets (rather than stuttering "invalid_strategy:" on
 *  every line). Non-invalid_strategy errors pass through as-is. */
export function extractInvalidStrategyMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^invalid_strategy:\s*/, '');
}
