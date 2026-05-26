// Verbatim per-session ground truth for the agent's retrospective. Attached
// to the end_drive success envelope. Read only from session state — nothing
// from on-disk skills, recent_aborts, or platform logbook prose. The retro
// template instructs the agent to quote this block into "## What this
// session actually observed"; prior-session / platform state goes in a
// separate subsection. Without this surface, retros are reconstructed by
// scanning list_platform_skills + recent_aborts and end up quoting prior-
// session evidence as if it were this-session work.

import type { pool } from '../../runtime-state';
import { getObservedNamesForSession } from '../../working-dir/logbook';

type SessionLike = ReturnType<typeof pool.getSession>;

export interface SessionSummary {
  saved_this_session: Array<{ capability: string; tier: string; at: number }>;
  auto_synthesized_this_session: Array<{ capability: string; tier: string }>;
  observed_unlifted_this_session: string[];
  declared_capabilities_this_session: string[];
  paths_visited_this_session: string[];
  http_failures_this_session: number;
  abandoned_save_attempts_this_session: Array<{
    capability: string;
    kind: 'archived' | 'declined';
  }>;
  captured_actions_count: number;
}

/** Count of perform_action calls this session — surfaced in session_summary
 *  as captured_actions_count so the agent's retro can cite a real number
 *  instead of fabricating one. */
export function countPerformActionCalls(session: SessionLike): number {
  return (session.performActionHistory ?? []).length;
}

export function buildSessionSummary(
  session: SessionLike,
  autoSynthesized: ReadonlyArray<{ capability: string; tier: string }>,
  capturedActionsCount: number,
): SessionSummary {
  const savedSlugs = new Set<string>();
  for (const r of session.savedCapabilities ?? []) savedSlugs.add(r.capability);
  const declared = (session.declaredCapabilities ?? []).map((d) => d.capability);
  const declaredSet = new Set(declared);
  const observedNamesAll = getObservedNamesForSession(session.id);
  const observedUnlifted = observedNamesAll.filter(
    (n) => !savedSlugs.has(n) && !declaredSet.has(n),
  );
  const visitedPaths = new Set<string>();
  for (const u of session.visitedUrls ?? []) {
    try {
      const parsed = new URL(u);
      visitedPaths.add(parsed.pathname + (parsed.search.length > 0 ? '?…' : ''));
    } catch {
      /* skip malformed */
    }
  }
  let httpFailures = 0;
  // Defensive: test fixtures sometimes omit the field even though the
  // type says it's required.
  const intercepted =
    (session as { intercepted?: Array<{ status?: number | null }> }).intercepted ?? [];
  for (const r of intercepted) {
    if (typeof r.status === 'number' && r.status >= 400) httpFailures += 1;
  }
  return {
    saved_this_session: (session.savedCapabilities ?? []).map((r) => ({
      capability: r.capability,
      tier: r.tier,
      at: r.at,
    })),
    auto_synthesized_this_session: autoSynthesized.map((s) => ({
      capability: s.capability,
      tier: s.tier,
    })),
    observed_unlifted_this_session: observedUnlifted,
    declared_capabilities_this_session: declared,
    paths_visited_this_session: [...visitedPaths],
    http_failures_this_session: httpFailures,
    abandoned_save_attempts_this_session: (session.abandonedSaveAttempts ?? []).map((a) => ({
      capability: a.capability,
      kind: a.kind,
    })),
    captured_actions_count: capturedActionsCount,
  };
}
