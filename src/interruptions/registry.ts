// Registry for the interruption framework. Handlers register at
// module-load time (built-in defaults) or at runtime (scenario setup,
// enterprise plugins). Dispatch is menu-driven: list + invoke-by-name.
// There is no auto-picker — the agent reads descriptions and invokes one
// explicitly.
//
// In-memory only — restart clears all registrations. Test scenarios that
// register per-scenario plugins are expected to `unregisterInterruptionHandler`
// on teardown to avoid cross-test leaks.

import type { InterruptionEvent, InterruptionHandler, InterruptionResolution } from './types';
import type { Session } from '../drivers/types/session';

const handlers = new Map<string, InterruptionHandler>();

/** Register a handler. If `name` already exists, the previous registration
 *  is replaced (enabling `registerDefaults()` to be called from multiple
 *  bootstrap points without double-stacking). */
export function registerInterruptionHandler(handler: InterruptionHandler): void {
  if (typeof handler.name !== 'string' || handler.name.length === 0) {
    throw new Error('registerInterruptionHandler: handler.name required (non-empty string)');
  }
  if (typeof handler.description !== 'string' || handler.description.trim().length === 0) {
    throw new Error(
      `registerInterruptionHandler(${handler.name}): description (non-empty string) required — agents read this to pick a handler, leaving it empty breaks dispatch`,
    );
  }
  if (typeof handler.handle !== 'function') {
    throw new Error(
      `registerInterruptionHandler(${handler.name}): handle (async function) required`,
    );
  }
  handlers.set(handler.name, handler);
}

/** Remove a previously-registered handler by name. No-op if unknown. */
export function unregisterInterruptionHandler(name: string): void {
  handlers.delete(name);
}

/** Test-only: clear everything including defaults. Defaults can be
 *  re-registered by calling `registerDefaults()` from default-handlers.ts. */
export function __clearAllHandlers(): void {
  handlers.clear();
}

/**
 * Snapshot of registered handlers for agent-facing menu rendering. Returns
 * `{name, description}` tuples — the full handler shape (with `handle`)
 * is intentionally not exposed to avoid leaking plugin internals.
 * Sorted by name for stable presentation.
 */
export function listInterruptionHandlers(): Array<{ name: string; description: string }> {
  return Array.from(handlers.values())
    .map((h) => ({ name: h.name, description: h.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Invoke a handler by name. Throws `invalid_strategy: unknown resolver …`
 * if the name is not registered — the agent's tool call carries a typo or
 * points at a plugin that unregistered. The error message lists the
 * currently-registered names so the agent can correct its next call.
 */
export async function invokeInterruptionHandler(
  name: string,
  event: InterruptionEvent,
  session: Session,
): Promise<InterruptionResolution> {
  const handler = handlers.get(name);
  if (!handler) {
    const known = Array.from(handlers.keys())
      .sort((a, b) => a.localeCompare(b))
      .join(', ');
    throw new Error(`invalid_strategy: unknown resolver "${name}" — registered: [${known}]`);
  }
  return handler.handle(event, session);
}
