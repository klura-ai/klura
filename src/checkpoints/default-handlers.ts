// Built-in default checkpoint handlers. Registered at module-load time
// via `registerCheckpointDefaults()`. Three broad defaults span every
// shipped CheckpointKind; scenario / enterprise plugins register after
// to claim a subset and pre-empt these.
//
//  1. DefaultAskUserCheckpoint — `triage_plan`, `surface_changed`.
//     Hands over to the user as a text-turn ask.
//  2. DefaultHandoverViewerCheckpoint — `recorded_step_failed`,
//     `session_expired`. Opens the remote viewer for a human at the page.
//  3. DefaultPreActionConsentCheckpoint — `post_save_validation_consent`.
//     Formats a pre-action-advice envelope for tier classification.

import type { CheckpointEvent, CheckpointHandler, CheckpointResolution } from './types';
import type { Session } from '../drivers/types/session';
import { registerCheckpointHandler } from './registry';

// Pure formatter for the pre-action-consent advice envelope. Lives here
// because this module is the sole consumer.
function buildPreActionAdvice(ctx: {
  pendingAction: string;
  contextSummary?: string;
  declineHandler: string;
}): { advice: string; if_user_declines: string } {
  return {
    advice:
      `BEFORE ${ctx.pendingAction}, classify per Tier 1 (low-stakes — sandbox, idempotent, drafts) or Tier 2 (destructive / irreversible / monetary / any third-party recipient — human OR bot; sending to an LLM assistant or support bot still creates a real record on the user's account). ` +
      (ctx.contextSummary ? `${ctx.contextSummary}. ` : '') +
      `Full taxonomy, reply-shape handling, and examples: klura://reference#checkpoints.`,
    if_user_declines: `If the user declines the Tier 2 action: ${ctx.declineHandler} See klura://reference#checkpoints for the three-reply-shapes handling (yes / alternative / decline).`,
  };
}

// DI seam for the viewer opener. `runtime-state.ts` injects the real
// implementation (`startRemoteSession` via the pool's driver) after the
// pool is created. Kept as a setter because `default-handlers` lives
// under `checkpoints/` and `runtime-state` imports from `checkpoints/` —
// a direct import would reintroduce a circular dep.
export type ViewerOpener = (
  sessionId: string,
  session: Session,
  opts: { prompt?: string },
) => Promise<{ viewerUrl: string }>;
let viewerOpener: ViewerOpener | null = null;
export function setViewerOpener(fn: ViewerOpener): void {
  viewerOpener = fn;
}

const DefaultHandoverViewerCheckpoint: CheckpointHandler = {
  name: 'default-handover-viewer-checkpoint',
  kinds: ['recorded_step_failed', 'session_expired'],
  async handle(event: CheckpointEvent, session: Session): Promise<CheckpointResolution> {
    const prompt = promptForKind(event);
    if (!viewerOpener) {
      // DI wire-up skipped (test harness without runtime-state). Surface
      // intent without a URL; the caller — if any — falls back to manual
      // viewer spin-up via `start_remote_session`.
      return { status: 'handover', target: 'viewer', prompt };
    }
    const { viewerUrl } = await viewerOpener(event.session_id, session, { prompt });
    return { status: 'handover', target: 'viewer', prompt, viewer_url: viewerUrl };
  },
};

const DefaultAskUserCheckpoint: CheckpointHandler = {
  name: 'default-ask-user-checkpoint',
  kinds: ['triage_plan', 'surface_changed'],
  handle(event: CheckpointEvent): Promise<CheckpointResolution> {
    return Promise.resolve({
      status: 'handover',
      target: 'user',
      prompt: promptForKind(event),
    });
  },
};

const DefaultPreActionConsentCheckpoint: CheckpointHandler = {
  name: 'default-pre-action-consent-checkpoint',
  kinds: ['post_save_validation_consent'],
  handle(event: CheckpointEvent): Promise<CheckpointResolution> {
    const ctx = event.context as {
      pendingAction?: string;
      contextSummary?: string;
      declineHandler?: string;
    };
    const advice = buildPreActionAdvice({
      pendingAction: ctx.pendingAction ?? 'an agent-initiated side-effect',
      contextSummary: ctx.contextSummary ?? '',
      declineHandler:
        ctx.declineHandler ?? 'document why the action was declined + continue without it',
    });
    return Promise.resolve({
      status: 'handover',
      target: 'user',
      prompt: advice.advice,
    });
  },
};

function promptForKind(event: CheckpointEvent): string {
  const kind = (event.context.kind ?? event.context.reason) as string | undefined;
  switch (kind) {
    case 'recorded_step_failed':
      return (
        'A recorded-path step failed mid-execute. The remote viewer is open; ' +
        'solve the interaction manually, then call patch_step + resume_execution to ' +
        'continue from the failed step without re-running upstream steps.'
      );
    case 'session_expired':
      return 'The site rejected the request with a session-expired response. Re-authenticate in the viewer.';
    case 'triage_plan': {
      const ctx = event.context as { capability?: string; summary_for_user?: string };
      const cap = ctx.capability ?? 'this capability';
      const summary = ctx.summary_for_user ?? 'no summary provided';
      return (
        `Triage plan submitted for \`${cap}\`. Relay this summary to the user ` +
        `before proceeding to LIFT:\n\n${summary}`
      );
    }
    case 'surface_changed': {
      const ctx = event.context as {
        new_url?: string;
        prior_surface?: string;
        triage_budget?: number;
      };
      const newUrl = ctx.new_url ?? '<unknown>';
      const prior = ctx.prior_surface ? ` (prior surface: \`${ctx.prior_surface}\`)` : '';
      const budget = ctx.triage_budget;
      let budgetLine = '';
      if (budget === 0) {
        budgetLine = ' Triage budget reset (no round limit).';
      } else if (budget !== undefined) {
        budgetLine = ` Triage budget reset to ${budget} rounds.`;
      }
      return (
        `Navigated to \`${newUrl}\`${prior} — no triage plan exists for this surface yet. ` +
        `Read the defense surface (third-party origins, scripts, cookies, request patterns), ` +
        `pick a \`surface_label\`, and submit_triage_plan before continuing.${budgetLine}`
      );
    }
    case 'post_save_validation_consent':
      return 'An agent-initiated side-effect needs consent classification. Classify Tier 1 / Tier 2; Tier 2 waits for explicit user OK.';
    default:
      return 'A runtime checkpoint needs human input.';
  }
}

/** Register the built-in default handlers. Idempotent — safe to call
 *  multiple times (registerCheckpointHandler replaces same-name entries). */
export function registerCheckpointDefaults(): void {
  registerCheckpointHandler(DefaultHandoverViewerCheckpoint);
  registerCheckpointHandler(DefaultAskUserCheckpoint);
  registerCheckpointHandler(DefaultPreActionConsentCheckpoint);
}
