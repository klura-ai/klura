// Remote handoff backend — the pluggable primitive for "open a human-solve
// surface, wait for done, tear down." klura ships one implementation (the local
// HTTP+WS viewer reachable via optional cloudflared tunnel); deployments can
// register alternative backends at startup without touching strategy schema or
// executor code.
//
// Strategy authors never name a backend; it's a deployment-layer concern. The
// interrupt system's `user-assist` handler routes through
// `getActiveRemoteBackend()` so swapping the backend swaps every human-handoff
// touchpoint uniformly.
//
// See runtime/docs/principles.md §"Pluggability is welcome" — the interface
// shape is the formal extension point.

import type { BrowserDriver } from '../drivers/interface';
import type { Session } from '../drivers/types/session';
import type { RemoteConfig } from './index';

/** Opaque backend-chosen identifier for an in-flight handoff. The local
 *  backend uses the sessionId; others may wrap additional state. */
interface RemoteHandle {
  readonly sessionId: string;
  /** Optional URL for the operator to visit; present when the backend
   *  surfaces a viewer UI (local, docker), absent for backends that
   *  dispatch elsewhere. */
  readonly viewerUrl?: string;
  /** Where the URL is reachable from. `'local'` = same host as klura
   *  (typical local mode); `'public'` = reachable across the network
   *  (cloudflare tunnel / direct mode / docker with port-forward). Used
   *  by `start_remote_session` to shape its verbatim-relay preface —
   *  local URLs need a "klura runs on the user's machine" framing,
   *  public URLs need a "do not paste in a public channel" caution.
   *  Backends without a viewer URL omit this field. */
  readonly exposure?: 'local' | 'public';
  /** Short single-use redirect URL the agent should relay to the user
   *  in place of `viewerUrl`. ~16 chars instead of 250-400, so LLM
   *  copy-corruption can't happen. The backend redirects this to the
   *  full JWT URL the first time it's loaded. Absent when the backend
   *  doesn't mint a short URL (config opt-out, or non-viewer backend). */
  readonly shortUrl?: string;
  /** True when the backend already attempted to open the URL in the
   *  user's default browser at session start. The verbatim-relay preface
   *  uses this to tell the user a tab should already have popped, vs
   *  asking them to copy-paste. */
  readonly autoOpened?: boolean;
  /** Backend-specific bag; typed as unknown to keep this interface
   *  narrow. Each backend reads its own keys. */
  readonly backendState?: unknown;
}

interface RemoteHandoffBackend {
  readonly name: string;
  start(
    sessionId: string,
    driver: BrowserDriver,
    session: Session,
    opts: Partial<RemoteConfig>,
  ): Promise<RemoteHandle>;
  waitForDone(handle: RemoteHandle, timeoutMs: number): Promise<{ done: boolean; reason?: string }>;
  stop(handle: RemoteHandle): Promise<void>;
}

const registry = new Map<string, RemoteHandoffBackend>();
const ACTIVE_NAME = 'local';

export function registerRemoteBackend(backend: RemoteHandoffBackend): void {
  if (registry.has(backend.name)) {
    throw new Error(`remote backend "${backend.name}" is already registered`);
  }
  registry.set(backend.name, backend);
}

export function getActiveRemoteBackend(): RemoteHandoffBackend {
  const backend = registry.get(ACTIVE_NAME);
  if (!backend) {
    throw new Error(
      `no remote backend registered under "${ACTIVE_NAME}" — the default "local" backend should always be registered at module load`,
    );
  }
  return backend;
}
