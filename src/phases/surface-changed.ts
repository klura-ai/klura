// Detects path-distinct navigation to an un-triaged surface and fires the
// `surface_changed` checkpoint. Shared between every tool that can drive a
// navigation: `perform_action` (click/type → SPA route) and `js_eval`
// (`window.location.href = ...`). Anchoring this in one place means the
// surface-tracking signal doesn't depend on which navigation primitive the
// agent picks — multi-surface flows like search → checkout fire the same
// checkpoint whether the agent clicked the link or eval'd the location
// change.
//
// The function returns the checkpoint envelope to attach to the tool's
// response (as `_checkpoint`), or `undefined` when no fire is due. Always
// updates `session.lastSurfaceUrl` so future checks compare against the
// most recent visit.

import type { Session } from '../drivers/types/session';
import { isPathDistinct, lookupSurface } from './surface-binding';
import { currentPhase } from './registry';
import { dispatch } from './state-machine';
import { invokeCheckpointAndGate, type CheckpointEnvelope } from '../checkpoints';
import { composeTriageAuthoringContract } from './triage/triage-authoring-contract';
import { loadConfig } from '../config/handler';

export async function maybeFireSurfaceChanged(
  session: Session,
  currentUrl: string,
): Promise<CheckpointEnvelope | undefined> {
  if (!currentUrl) return undefined;
  if (!('phase' in session)) {
    session.lastSurfaceUrl = currentUrl;
    return undefined;
  }
  const phase = currentPhase(session);
  // From DRIVE, fire only when the agent did real mutating work on the
  // surface they're leaving — multi-surface flows (search → checkout) need
  // each side triaged separately, but landing→link nav journeys shouldn't
  // get spammed with TRIAGE re-entry.
  const fireFromDrive = phase === 'drive' && !!session.priorSurfaceHadMutation;
  if (phase !== 'lift' && phase !== 'triage' && !fireFromDrive) {
    session.lastSurfaceUrl = currentUrl;
    return undefined;
  }
  const priorUrl = session.lastSurfaceUrl;
  const distinct = isPathDistinct(priorUrl, currentUrl);
  session.lastSurfaceUrl = currentUrl;
  if (!distinct) return undefined;
  // The mutation flag tracks the SURFACE we just left; reset on any
  // path-distinct nav whether or not we end up firing the checkpoint.
  session.priorSurfaceHadMutation = false;
  if (lookupSurface(session, currentUrl) !== undefined) return undefined;

  const priorSurface = priorUrl ? lookupSurface(session, priorUrl) : undefined;

  dispatch(session, { kind: 'surface_changed' });
  // Surface the reset triage budget in the checkpoint context — the
  // default handler bakes it into the user-visible prompt so the agent
  // sees the actual budget shape on re-entry, not an inferred prior.
  // Per arxiv 2604.19780 (Curriculum-Aware Budget Scheduling) explicit
  // per-phase budgets outperform inferred ones.
  const triageBudget = session.triage?.budget ?? loadConfig().triage.max_rounds;
  const triageContract = composeTriageAuthoringContract(session);
  const { envelope } = await invokeCheckpointAndGate('surface_changed', {
    session_id: session.id,
    context: {
      kind: 'surface_changed',
      new_url: currentUrl,
      triage_budget: triageBudget,
      triage_authoring_contract: triageContract,
      ...(priorSurface ? { prior_surface: priorSurface } : {}),
    },
  });
  return envelope;
}
