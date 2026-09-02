// Registry for the checkpoint framework. Handlers register at
// module-load time (built-in defaults) or at runtime (scenario setup,
// enterprise plugins). Dispatch is DIRECT — the runtime knows the kind
// and picks the last-registered plugin claiming it. Contrast with
// `runtime/src/interruptions/registry.ts`, which is menu-driven.
//
// In-memory only — restart clears all registrations. Array storage
// because order matters (last-wins).

import type {
  CheckpointEvent,
  CheckpointHandler,
  CheckpointKind,
  CheckpointResolution,
} from './types';
import type { Session } from '../drivers/types/session';

const handlers: CheckpointHandler[] = [];

/** Register a handler. Push to the end — dispatch picks the last match,
 *  so defaults register first and scenario stubs register after to
 *  pre-empt them. Same-name re-register replaces the prior entry in
 *  place (preserves its position). Generic over the claimed kinds so a
 *  handler declaring `kinds: ['triage_plan']` gets `event` narrowed to
 *  that kind's typed context; the runtime string checks stay because the
 *  public JS API admits untyped registrations. */
export function registerCheckpointHandler<K extends CheckpointKind>(
  handler: CheckpointHandler<K>,
): void {
  if (typeof handler.name !== 'string' || handler.name.length === 0) {
    throw new Error('registerCheckpointHandler: handler.name required (non-empty string)');
  }
  if (!Array.isArray(handler.kinds) || handler.kinds.length === 0) {
    throw new Error(
      `registerCheckpointHandler(${handler.name}): kinds (non-empty CheckpointKind[]) required — direct dispatch needs at least one claimed kind`,
    );
  }
  for (const k of handler.kinds) {
    if (typeof k !== 'string' || k.length === 0) {
      throw new Error(
        `registerCheckpointHandler(${handler.name}): kinds must be non-empty strings`,
      );
    }
  }
  if (typeof handler.handle !== 'function') {
    throw new Error(`registerCheckpointHandler(${handler.name}): handle (async function) required`);
  }
  // Storage is the widest handler type; the `kinds` claim is what scopes
  // dispatch, so widening here is safe — `invokeCheckpoint` only hands a
  // handler events whose `kind` is in its claimed set.
  const stored = handler as unknown as CheckpointHandler;
  const existing = handlers.findIndex((h) => h.name === handler.name);
  if (existing >= 0) {
    handlers[existing] = stored;
    return;
  }
  handlers.push(stored);
}

/** Remove a previously-registered handler by name. No-op if unknown. */
export function unregisterCheckpointHandler(name: string): void {
  const idx = handlers.findIndex((h) => h.name === name);
  if (idx >= 0) handlers.splice(idx, 1);
}

/** Test-only: clear everything including defaults. Defaults can be
 *  re-registered by calling `registerCheckpointDefaults()` from
 *  default-handlers.ts. */
export function __clearAllCheckpointHandlers(): void {
  handlers.length = 0;
}

/** Snapshot of registered handlers — for tests and introspection. */
export function listCheckpointHandlers(): Array<{ name: string; kinds: CheckpointKind[] }> {
  return handlers.map((h) => ({ name: h.name, kinds: [...h.kinds] }));
}

/**
 * Direct-dispatch invoke. Picks the LAST-registered handler whose
 * `kinds` includes `event.kind`. Throws if no handler claims the
 * kind — that is a runtime misconfiguration (every shipped kind has a
 * default handler).
 */
export async function invokeCheckpoint(
  event: CheckpointEvent,
  session: Session,
): Promise<CheckpointResolution> {
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    const h = handlers[i];
    if (h && h.kinds.includes(event.kind)) {
      return h.handle(event, session);
    }
  }
  throw new Error(
    `no checkpoint handler claims kind="${event.kind}" — registered: [${handlers
      .map((h) => `${h.name}:${h.kinds.join('|')}`)
      .join(', ')}]`,
  );
}
