// build-capture-events — the single reshape from live session/driver state into
// the working-dir CaptureEvent[] stream, plus the capture-journal checkpoint.
//
// One reshape feeds two consumers: end_drive (folds into the logbook on a clean
// close) and the per-session capture journal (durability snapshot drained at
// tool boundaries, folded on recovery if the session never reaches end_drive).
// Keeping the reshape in one place means the clean-close fold and the recovery
// fold can never drift.

import { pool } from '../../runtime-state';
import { graphConfig } from '../registry';
import { sha256 as sha256Bytes } from '../../working-dir/bundle-archive';
import { writeJournalSnapshot } from '../../working-dir/capture-journal';
import type { AutoSynthResult as SynthLedgerEntry } from '../../strategies/synthesize-on-close';
import type { Session } from '../../drivers/types/session';
import type { InterceptedRequest } from '../../drivers/types/network';
import type { WebSocketFrame } from '../../drivers/types/websocket';
import type {
  CaptureEvent,
  HttpRequestPayload,
  LiftAttemptPayload,
  PerformActionPayload,
  SessionMetaPayload,
  ToolCallPayload,
  WsFramePayload,
} from '../../working-dir/schema';

function outcomeForTier(tier: string): SessionMetaPayload['outcome'] {
  if (tier === 'page-script') return 'page_script_saved';
  if (tier === 'fetch') return 'fetch_saved';
  if (tier === 'recorded-path') return 'recorded_path_saved';
  return 'no_save';
}

function serializePostData(postData: unknown): string | null {
  if (postData === null || postData === undefined) return null;
  if (typeof postData === 'string') return postData;
  try {
    return JSON.stringify(postData);
  } catch {
    return null;
  }
}

function tierRank(o: LiftAttemptPayload['outcome']): number {
  switch (o) {
    case 'fetch_saved':
      return 4;
    case 'page_script_saved':
      return 3;
    case 'recorded_path_saved':
      return 2;
    case 'user_deferred':
      return 1;
    case 'error':
    case 'no_save':
    default:
      return 0;
  }
}

function digestEntry(e: unknown): string {
  const x = e as { args_digest?: string };
  if (typeof x.args_digest === 'string') return x.args_digest;
  try {
    return sha256Bytes(JSON.stringify(e)).slice(0, 16);
  } catch {
    return '0000000000000000';
  }
}

/**
 * Reshape the live session + driver buffers into a CaptureEvent[] stream. Pure
 * with respect to disk (no writes) — callers decide whether to ingest (end_drive)
 * or snapshot (journal checkpoint). The returned stream always opens with a
 * `session_meta` event, so it is foldable by `ingestCaptureEvents` as-is.
 */
export function buildCaptureEvents(
  session: Session,
  requests: InterceptedRequest[],
  wsFrames: WebSocketFrame[],
  autoSynthesized: SynthLedgerEntry[],
): CaptureEvent[] {
  const sessionId = session.id;
  const platform = session.platform ?? '';
  const endedAt = Date.now();
  const startedAt = (session as unknown as { startedAt?: number }).startedAt ?? endedAt;
  const declared = session.declaredCapabilities ?? [];
  const primaryCapability = declared[0]?.capability;
  const primaryArgs = declared[0]?.args;

  // Determine session outcome from the mix of explicit saves + auto-synth.
  // Precedence: page-script > fetch > recorded-path > no_save. Takes the best
  // tier that landed, matching how execute() cascades.
  const savedTiers = new Set<string>();
  for (const s of session.savedCapabilities ?? []) savedTiers.add(s.tier);
  for (const a of autoSynthesized) savedTiers.add(a.tier);
  let outcome: SessionMetaPayload['outcome'] = 'no_save';
  if (savedTiers.has('page-script')) {
    outcome = 'page_script_saved';
  } else if (savedTiers.has('fetch')) {
    outcome = 'fetch_saved';
  } else if (savedTiers.has('recorded-path')) {
    outcome = 'recorded_path_saved';
  }

  const events: CaptureEvent[] = [];
  const baseTs = endedAt;
  const push = (
    at: number,
    kind: CaptureEvent['kind'],
    payload: unknown,
    capability?: string,
  ): void => {
    events.push({ at, session_id: sessionId, platform, capability, kind, payload });
  };

  push(baseTs, 'session_meta', {
    started_at: startedAt,
    ended_at: endedAt,
    capability: primaryCapability,
    args: primaryArgs,
    outcome,
  } satisfies SessionMetaPayload);

  for (const r of requests) {
    const postData = serializePostData(r.postData);
    const payload: HttpRequestPayload = {
      method: r.method,
      url: r.url,
      headers: r.headers,
      postData,
      status: r.status ?? undefined,
    };
    const ct = Object.entries(r.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    if (typeof ct === 'string') payload.contentType = ct.split(';')[0]?.trim();
    if (r.responseBody !== undefined && r.responseBody !== null) {
      payload.responseBody = r.responseBody;
      if (typeof r.responseBody === 'string') payload.responseSize = r.responseBody.length;
    }
    push(typeof r.timestamp === 'number' ? r.timestamp : baseTs, 'http_request', payload);
  }

  for (const f of wsFrames) {
    const payload: WsFramePayload = {
      direction: f.direction,
      url: f.url,
      payload: typeof f.payload === 'string' ? f.payload : '',
      encoding:
        typeof f.payload === 'string' && /^[A-Za-z0-9+/=]+$/.test(f.payload) ? 'binary' : 'text',
    };
    push(typeof f.timestamp === 'number' ? f.timestamp : baseTs, 'ws_frame', payload);
  }

  for (const nav of session.domNavigations ?? []) {
    push(nav.at, 'dom_navigation', {
      url: nav.url,
      ...(nav.title !== undefined ? { title: nav.title } : {}),
      ...(nav.via !== undefined ? { via: nav.via } : {}),
    });
  }

  for (const f of session.domFormsObserved ?? []) {
    push(f.at, 'dom_form_observed', {
      url: f.url,
      action: f.action,
      method: f.method,
      fields: f.fields,
    });
  }

  for (const a of session.performActionHistory ?? []) {
    const payload: PerformActionPayload = { action: a.action };
    if (a.selector !== undefined) payload.selector = a.selector;
    if (a.value !== undefined) payload.value = a.value;
    if ('key' in a && typeof (a as { key?: unknown }).key === 'string') {
      payload.key = (a as { key: string }).key;
    }
    if ('url' in a && typeof (a as { url?: unknown }).url === 'string') {
      payload.url = (a as { url: string }).url;
    }
    push(a.at, 'perform_action', payload);
  }

  const acc = session.artifactAccumulator;
  if (acc) {
    const emit = (
      list: Array<{ at: string }> | undefined,
      tool: string,
      detailFor?: (entry: { at: string }) => Record<string, unknown> | undefined,
    ): void => {
      if (!list) return;
      for (const e of list) {
        const ts = Date.parse(e.at);
        const payload: ToolCallPayload = {
          tool,
          args_digest: digestEntry(e),
          outcome: 'ok',
          detail: detailFor?.(e),
        };
        push(Number.isFinite(ts) ? ts : baseTs, 'tool_call', payload);
      }
    };
    emit(acc.inspectWsFrameCalls, 'inspect_ws_frame', (e) => {
      const x = e as { ws_i?: number; starter_present?: boolean };
      return { ws_i: x.ws_i, starter_present: x.starter_present };
    });
    emit(acc.tryGeneratorCalls, 'try_generator', (e) => {
      const x = e as { ok?: boolean };
      return { ok: x.ok };
    });
    emit(acc.getJsSourceCalls, 'get_js_source', (e) => {
      const x = e as { url?: string; line?: number };
      return { url: x.url, line: x.line };
    });
    emit(acc.findInPageCalls, 'find_in_page', (e) => {
      const x = e as { matches_count?: number };
      return { matches_count: x.matches_count };
    });
    emit(acc.jsEvalCalls, 'js_eval');
    emit(acc.searchJsSourceCalls, 'search_js_source', (e) => {
      const x = e as { url?: string };
      return { url: x.url };
    });
    emit(acc.readJsFunctionCalls, 'read_js_function', (e) => {
      const x = e as { url?: string; line?: number };
      return { url: x.url, line: x.line };
    });
    emit(acc.listLoadedScriptsCalls, 'list_loaded_scripts');
    emit(acc.setBreakpointCalls, 'set_breakpoint', (e) => {
      const x = e as { line?: number };
      return { line: x.line };
    });
    emit(acc.evaluateOnFrameCalls, 'evaluate_on_frame', (e) => {
      const x = e as { ok?: boolean };
      return { ok: x.ok };
    });
    emit(acc.getSendEncoderCalls, 'get_send_encoder');
    emit(acc.getAttributeCalls, 'get_attribute');
    emit(acc.getNetworkLogCalls, 'get_network_log');
  }

  // Lift-attempt events: one per tier that landed (either agent-saved or
  // auto-synth). Logbook appends one attempt per (capability, session).
  const attemptsByCapability = new Map<string, LiftAttemptPayload>();
  for (const a of autoSynthesized) {
    const key = a.capability;
    const tierOutcome: LiftAttemptPayload['outcome'] = outcomeForTier(a.tier);
    const prior = attemptsByCapability.get(key);
    // Keep the best (highest-tier) outcome per capability.
    if (!prior || tierRank(tierOutcome) > tierRank(prior.outcome)) {
      attemptsByCapability.set(key, {
        outcome: tierOutcome,
        rounds_spent: 0, // auto-synth doesn't consume LLM rounds
        notes: a.reason,
      });
    }
  }
  for (const s of session.savedCapabilities ?? []) {
    const tierOutcome: LiftAttemptPayload['outcome'] = outcomeForTier(s.tier);
    const prior = attemptsByCapability.get(s.capability);
    if (!prior || tierRank(tierOutcome) > tierRank(prior.outcome)) {
      attemptsByCapability.set(s.capability, {
        outcome: tierOutcome,
        rounds_spent: 0,
      });
    }
  }
  for (const [capability, payload] of attemptsByCapability) {
    push(endedAt, 'lift_attempt', payload, capability);
  }

  return events;
}

/** Cheap count of in-memory capture sources — used only to skip writing an
 *  empty snapshot before any capture has happened. Not a change-detector
 *  (HTTP entries are enriched in place by `Network.responseReceived` without
 *  changing length), so any non-empty session writes on every checkpoint. */
function hasAnyCapture(session: Session): boolean {
  return (
    session.intercepted.length > 0 ||
    (session.wsFrames?.length ?? 0) > 0 ||
    (session.performActionHistory?.length ?? 0) > 0 ||
    (session.domNavigations?.length ?? 0) > 0 ||
    (session.domFormsObserved?.length ?? 0) > 0
  );
}

/**
 * Drain the (now-enriched) capture buffers into the session's journal snapshot.
 * Called at capture boundaries (perform_action / start_session / js_eval). Gated
 * to graphs that fold a capture archive at close — warm/execute, which runs a
 * saved strategy and has nothing to recover, writes no journal. Best-effort: a
 * checkpoint failure must never break the tool call that triggered it.
 */
export async function checkpointCaptureJournal(session: Session): Promise<void> {
  try {
    if (!graphConfig(session).journalCaptures) return;
    const platform = session.platform;
    if (!platform) return;
    if (!hasAnyCapture(session)) return;
    const driver = pool.driverFor(session.id);
    const [requests, wsFrames] = await Promise.all([
      driver.getInterceptedRequests(session).catch(() => [] as InterceptedRequest[]),
      driver.getInterceptedWebSocketFrames(session).catch(() => [] as WebSocketFrame[]),
    ]);
    const events = buildCaptureEvents(session, requests, wsFrames, []);
    const startedAt = (session as unknown as { startedAt?: number }).startedAt ?? Date.now();
    writeJournalSnapshot(session.id, {
      v: 1,
      sessionId: session.id,
      platform,
      startedAt,
      events,
    });
  } catch {
    /* best-effort durability — swallow */
  }
}
