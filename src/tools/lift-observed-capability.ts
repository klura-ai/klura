// Map-graph: open a triage+lift cycle for one already-observed capability
// without ending the session. The slug must exist on
// platform_logbook.observed_capabilities[]; the agent records observations
// during drive via `record_observed_capability` and graduates them to
// strategies via this tool. The FSM transitions to triage (from drive or
// lift); the agent then runs the normal triage → lift → save_strategy
// flow. After save the session stays open in lift — call this again for
// the next slug or call end_drive to close.

import { pool } from '../runtime-state';
import { currentGraph, currentPhase } from '../phases/registry';
import { dispatch } from '../phases/state-machine';
import { readObservedCapabilities } from '../working-dir/logbook';
import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tools/types';

export interface LiftObservedCapabilityArgs {
  session_id: string;
  name: string;
  args?: Record<string, string>;
}

export interface LiftObservedCapabilityResult {
  ok: true;
  phase: 'triage';
  _hint: string;
}

export function liftObservedCapability(
  input: LiftObservedCapabilityArgs,
): LiftObservedCapabilityResult {
  if (!input.session_id) throw new Error('session_id is required');
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw new Error('name is required (capability slug)');
  }

  const session = pool.getSession(input.session_id);

  // Graph gate: this tool is the lift-on-demand mechanism for the map
  // graph. Discover sessions declare their capability up front via
  // start_session / declare_capability and run drive → triage → lift
  // monolithically. Pointing them at this tool would create a parallel
  // declaration path that the audit instances aren't wired for.
  const graph = currentGraph(session);
  if (graph.name !== 'map') {
    throw new Error(
      `tool '${TOOL_NAMES.liftObservedCapability}' is only available on map-graph sessions. ` +
        `This session uses graph='${graph.name}'. For goal-directed sessions, pass ` +
        `\`{capability, args}\` to start_session or call declare_capability.`,
    );
  }

  // Phase gate: drive and lift are the legitimate entry points. Triage
  // means a plan is in flight — the agent should resolve or re-submit it
  // before pivoting to a new capability.
  const fromPhase = currentPhase(session);
  if (fromPhase !== 'drive' && fromPhase !== 'lift') {
    throw new Error(
      `${TOOL_NAMES.liftObservedCapability} can only be called from drive or lift ` +
        `(currently '${fromPhase}'). Submit or re-submit the active triage_plan first.`,
    );
  }

  // Validate the slug against the platform logbook. observed_capabilities[]
  // is the ground truth: the agent recorded the slug + evidence + hypothesis
  // during drive. Lifting a slug that was never observed would let an agent
  // declare a capability from thin air, defeating the explore-first contract.
  const platform = session.platform;
  if (!platform) {
    throw new Error(
      `${TOOL_NAMES.liftObservedCapability} requires the session to have a platform — the ` +
        `platform_logbook is keyed by platform slug. Pass \`{platform: "..."}\` to start_session.`,
    );
  }
  const observed = readObservedCapabilities(platform);
  const entry = observed.find((e) => e.name === input.name);
  if (!entry) {
    const knownSlugs = observed.map((e) => e.name);
    throw new Error(
      `invalid_lift_capability: '${input.name}' is not in platform_logbook.observed_capabilities[] ` +
        `for '${platform}'. Call ${TOOL_NAMES.recordObservedCapability} first with the slug + ` +
        `evidence + why_not_lifted, then lift. ` +
        `Currently observed: [${knownSlugs.join(', ') || '<none>'}].`,
    );
  }

  const argMap = (input.args && typeof input.args === 'object' ? input.args : {}) as Record<
    string,
    unknown
  >;
  for (const [k, v] of Object.entries(argMap)) {
    if (typeof v !== 'string') {
      throw new Error(
        `args.${k} must be a string (got ${typeof v}) — pass the literal values the agent will type`,
      );
    }
  }

  if (!session.declaredCapabilities) session.declaredCapabilities = [];
  session.declaredCapabilities.push({
    capability: input.name,
    args: argMap as Record<string, string>,
    declared_at: Date.now(),
  });

  dispatch(session, { kind: 'lift_observed_capability_invoked' });

  return {
    ok: true,
    phase: 'triage',
    _hint:
      `Entered triage for '${input.name}'. Read the defense surface ` +
      `(get_network_log, list_loaded_scripts, get_js_source, search_js_source), then call ` +
      `${TOOL_NAMES.submitTriagePlan} with surface_label, defense_surface, expected_tier, ` +
      `tier_justification, and summary_for_user. The triage_plan checkpoint hands off to lift; ` +
      `${TOOL_NAMES.saveStrategy} lands the strategy. After save you remain in the session — call ` +
      `${TOOL_NAMES.liftObservedCapability} again for the next slug or ${TOOL_NAMES.endDrive} when done.`,
  };
}

export const TOOL_DEF: ToolDef = {
  name: TOOL_NAMES.liftObservedCapability,
  description:
    `Map-graph only: open a triage+lift cycle for one observed capability without ending the session. ` +
    `The slug must already exist on \`platform_logbook.observed_capabilities[]\` — call ` +
    `${TOOL_NAMES.recordObservedCapability} first to register it with evidence. The FSM transitions to ` +
    `triage; the agent runs the normal triage → lift → ${TOOL_NAMES.saveStrategy} flow. After save the ` +
    `session stays in lift — call this tool again for the next slug or ${TOOL_NAMES.endDrive} to close. ` +
    `\`args\` is the same \`{paramName: literalValue}\` map of user-supplied literals the agent will type; ` +
    `the runtime templates captured request bodies with \`{{paramName}}\` placeholders.`,
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
      name: {
        type: 'string',
        description:
          'Capability slug to lift. Must match an entry on platform_logbook.observed_capabilities[].name.',
      },
      args: {
        type: 'object',
        description:
          'Map of user-supplied literals the agent will type (e.g. `{q: "thai"}`). Optional but recommended — without args, auto-save can\'t template captured traffic into a reusable strategy.',
      },
    },
    required: ['session_id', 'name'],
  },
  handler: (args: any) =>
    liftObservedCapability({
      session_id: args.session_id,
      name: args.name,
      args: args.args,
    }),
};
