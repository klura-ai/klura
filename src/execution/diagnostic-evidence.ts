import { AsyncLocalStorage } from 'node:async_hooks';

import type { BrowserDriver } from '../drivers/interface';
import type { Session } from '../drivers/types/session';

export type DiagnosticUrlKind = 'request' | 'script';

export interface DiagnosticUrlEvidence {
  kind: DiagnosticUrlKind;
  url: string;
}

export interface ExecutionDiagnosticEvidence {
  urls: DiagnosticUrlEvidence[];
}

interface EvidenceStore {
  entries: Map<string, DiagnosticUrlEvidence>;
}

const evidenceStorage = new AsyncLocalStorage<EvidenceStore>();

function snapshot(store: EvidenceStore): ExecutionDiagnosticEvidence {
  return { urls: [...store.entries.values()] };
}

export function recordDiagnosticUrl(kind: DiagnosticUrlKind, url: string): void {
  const store = evidenceStorage.getStore();
  if (!store) return;
  try {
    const absolute = new URL(url).toString();
    store.entries.set(`${kind}\u0000${absolute}`, { kind, url: absolute });
  } catch {
    /* only structurally valid absolute URLs are diagnostic evidence */
  }
}

export async function captureBrowserDiagnosticEvidence(
  driver: BrowserDriver,
  session: Session,
): Promise<void> {
  if (!evidenceStorage.getStore()) return;
  try {
    const [requests, scripts] = await Promise.all([
      Promise.resolve()
        .then(() => driver.getInterceptedRequests(session))
        .catch(() => []),
      Promise.resolve()
        .then(() => driver.getLoadedScripts(session))
        .catch(() => []),
    ]);
    for (const request of requests) recordDiagnosticUrl('request', request.url);
    for (const script of scripts) recordDiagnosticUrl('script', script.url);
  } catch {
    /* diagnostic capture is best-effort and cannot change execution semantics */
  }
}

export async function collectExecutionDiagnosticEvidence<T>(
  run: () => Promise<T>,
): Promise<{ result: T; evidence: ExecutionDiagnosticEvidence }> {
  const store: EvidenceStore = { entries: new Map() };
  try {
    const result = await evidenceStorage.run(store, run);
    return { result, evidence: snapshot(store) };
  } catch (error) {
    if (error && typeof error === 'object') {
      try {
        (
          error as {
            diagnosticEvidence?: ExecutionDiagnosticEvidence;
          }
        ).diagnosticEvidence = snapshot(store);
      } catch {
        /* non-extensible errors retain their original identity and message */
      }
    }
    throw error;
  }
}
