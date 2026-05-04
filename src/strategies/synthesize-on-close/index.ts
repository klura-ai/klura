// Auto-synthesis of fallback strategies on end_drive.
//
// Run at the tail of `endDrive`, before cookies are written and the session
// torn down. Two passes:
//
// 1. Fetch / page-script synthesis — joins typed literals to captured traffic
// and stamps a templated request strategy when the literal lands verbatim in
// an HTTP body or URL.
//
// 2. Recorded-path synthesis — replays the session's `perform_action` history
// as a recorded-path strategy, giving every capability the agent explicitly
// saved a durable UI-flow fallback.
//
// Both passes are idempotent + best-effort: an existing save on disk wins, a
// synthesis error is swallowed (we never want end_drive to fail because a
// fallback failed to write).

import type { BrowserDriver } from '../../drivers/interface';
import type { Session } from '../../drivers/types/session';
import { synthesizeFetchFromCaptures } from './fetch';
import { synthesizeRecordedPaths } from './recorded-path';
import type { AutoSynthResult, SaveMarker, SynthDiagnosticEntry } from './types';
import { evaluateVerifiedExpressions, type EvaluatedVE } from './verified-expressions';

export type { AutoSynthResult } from './types';
export { findLiteralInSessionCaptures } from './literals';
export {
  collectDataLoadCandidates,
  collectListingCandidates,
  type DataLoadCandidate,
  type ListingCandidate,
} from './data-loads';
export type { EvaluatedVE } from './verified-expressions';

export async function synthesizeFallbacksOnClose(
  session: Session,
  platform: string | undefined,
  driver: BrowserDriver | null,
  diagnostics?: SynthDiagnosticEntry[],
): Promise<AutoSynthResult[]> {
  const out: AutoSynthResult[] = [];
  const diag = diagnostics ?? [];
  if (!platform) {
    diag.push({ pass: 'synth_fetch', phase: 'skip', outcome: 'no_platform' });
    return out;
  }

  const saveMarkers = buildSaveMarkers(session);
  diag.push({
    pass: 'synth_fetch',
    phase: 'start',
    outcome: 'entry',
    detail: {
      save_markers: saveMarkers.length,
      has_action_history: (session.performActionHistory ?? []).length,
    },
  });
  if (saveMarkers.length === 0) {
    diag.push({ pass: 'synth_fetch', phase: 'skip', outcome: 'no_save_markers' });
    return out;
  }

  // Re-evaluate every saved verified_expression against the live page
  // before the per-capability synth passes run. Build a per-capability
  // map keyed off save-marker capability so synthesizeFetchFromCaptures
  // can template captured headers / body using the evaluated values.
  // Driver is null only in test paths or programmatic synth without a
  // live browser — VE templating is silently skipped in that case.
  const evaluatedByCapability = new Map<string, EvaluatedVE[]>();
  if (driver) {
    for (const m of saveMarkers) {
      try {
        const evaluated = await evaluateVerifiedExpressions(
          driver,
          session,
          m.capability,
          (msg) => {
            diag.push({
              pass: 'synth_fetch',
              capability: m.capability,
              phase: 'skip',
              outcome: 'verified_expression_eval_failed',
              detail: { message: msg },
            });
          },
        );
        if (evaluated.length > 0) evaluatedByCapability.set(m.capability, evaluated);
      } catch (err) {
        diag.push({
          pass: 'synth_fetch',
          capability: m.capability,
          phase: 'skip',
          outcome: 'verified_expression_pass_threw',
          detail: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  // Auto-promote pass: scan the session's `js_eval` history for calls whose
  // string-shaped result is recorded in memory, and synthesize implicit VE
  // entries for them. Closes the loop when an agent investigated the page
  // (ran `js_eval` to find a token-deriving expression) but never formally
  // called `save_verified_expression`. The implicit VEs join the
  // capability buckets above, so the templating pass treats them
  // identically to agent-saved VEs — match-against-captured-headers, mint
  // js-eval prereqs, promote to page-script tier when matches land.
  // No-op when the accumulator has no result_string entries (test paths,
  // sessions where every js_eval returned non-string, etc.).
  const implicitVEs = collectImplicitVEsFromJsEvalHistory(session);
  if (implicitVEs.length > 0) {
    diag.push({
      pass: 'synth_fetch',
      phase: 'start',
      outcome: 'js_eval_auto_promote',
      detail: { count: implicitVEs.length },
    });
    for (const m of saveMarkers) {
      const existing = evaluatedByCapability.get(m.capability) ?? [];
      evaluatedByCapability.set(m.capability, [...existing, ...implicitVEs]);
    }
  }

  try {
    const autoFetch = synthesizeFetchFromCaptures(
      session,
      platform,
      saveMarkers,
      diag,
      evaluatedByCapability,
    );
    for (const r of autoFetch) out.push(r);
  } catch (err) {
    diag.push({
      pass: 'synth_fetch',
      phase: 'skip',
      outcome: 'pass_threw',
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  try {
    const recorded = synthesizeRecordedPaths(session, platform, saveMarkers, diag);
    for (const r of recorded) out.push(r);
  } catch (err) {
    diag.push({
      pass: 'synth_recorded',
      phase: 'skip',
      outcome: 'pass_threw',
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  return out;
}

/**
 * Walk the session's js_eval call history, collect every entry whose
 * string-shaped result is still in memory, and shape them as implicit
 * `EvaluatedVE` records. The matching pass downstream treats these
 * identically to agent-saved verified_expressions: match-against-captured-
 * headers, template the literal, mint a js-eval prereq.
 *
 * `result_string` lives only in-memory on the session accumulator and is
 * never persisted to disk — this collection happens during end-drive
 * synth, before the artifact / logbook flush. After synth runs, the
 * accumulator entry's `result_string` field rides out with the session
 * teardown without ever reaching disk.
 */
function collectImplicitVEsFromJsEvalHistory(session: Session): EvaluatedVE[] {
  const acc = session.artifactAccumulator;
  if (!acc) return [];
  const out: EvaluatedVE[] = [];
  const seenExpressions = new Set<string>();
  for (const entry of acc.jsEvalCalls) {
    if (typeof entry.expression !== 'string' || entry.expression.length === 0) continue;
    if (typeof entry.result_string !== 'string' || entry.result_string.length === 0) continue;
    // Dedup on expression text — a session that ran the same probe N times
    // shouldn't mint N identical js-eval prereqs in the saved strategy.
    if (seenExpressions.has(entry.expression)) continue;
    seenExpressions.add(entry.expression);
    out.push({
      ve: {
        expression: entry.expression,
        binds_args: [],
        returns: 'string',
        tested_at: entry.at,
        notes: 'auto-promoted from js_eval call history',
      },
      result: entry.result_string,
      resultString: entry.result_string,
      objectFields: new Map(),
    });
  }
  return out;
}

/**
 * Union savedCapabilities + declaredCapabilities into a single save-marker list
 * the synth passes iterate over. savedCapabilities is populated by explicit
 * save_strategy calls and carries the save timestamp; declaredCapabilities is
 * populated by declare_capability / start_session's shortcut and carries the
 * declaration timestamp. A declared-but-not-saved capability still gets
 * synthesized so sessions where the agent drove the browser correctly but
 * forgot to call save_strategy still land a recorded-path strategy.
 */
function buildSaveMarkers(session: Session): SaveMarker[] {
  const fromSaves = (session.savedCapabilities ?? []).map((s) => ({
    capability: s.capability,
    at: s.at,
    tier: s.tier,
  }));
  // For declared-only capabilities (no explicit save), use close-time as the
  // end-of-window so the synth passes see the full session's perform_action
  // history. The declaration timestamp (session start) would produce an empty
  // window.
  const nowTs = Date.now();
  const fromDeclares = (session.declaredCapabilities ?? []).map((d) => ({
    capability: d.capability,
    at: nowTs,
    tier: 'declared',
    args: d.args,
  }));
  // Union: if both lists have the same capability name, the explicit save wins
  // (it has a real tier); its `at` is the later of the two, which is what the
  // recorded-path window partition wants.
  const seen = new Set<string>();
  const out: SaveMarker[] = [];
  for (const m of fromSaves) {
    seen.add(m.capability);
    out.push(m);
  }
  for (const m of fromDeclares) {
    if (seen.has(m.capability)) {
      // Merge the args onto the existing save marker so auto-synth can still
      // see what the agent declared.
      const existing = out.find((e) => e.capability === m.capability);
      if (existing) existing.args = m.args;
      continue;
    }
    out.push(m);
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}
