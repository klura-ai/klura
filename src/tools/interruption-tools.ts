import { pool } from '../runtime-state';
import { listInterruptionHandlers } from '../interruptions';
import { invokeAndGateHandover } from '../tools/helpers';

/**
 * List every registered interruption handler as `{name, description}`. The
 * agent reads each description + the current event's context, then invokes
 * one by name via `resolveInterruption`. `session_id` is accepted (reserved
 * for future session-scoped filtering) but ignored today.
 */
export function listInterruptionResolvers(_args?: { session_id?: string }): {
  resolvers: Array<{ name: string; description: string }>;
} {
  return { resolvers: listInterruptionHandlers() };
}

export interface ResolveInterruptionArgs {
  session_id: string;
  context: Record<string, unknown>;
  resolver: string;
  capability?: string;
}

/**
 * Invoke a registered interruption handler by name against an event. Used
 * by agents in two paths:
 *
 *  - Runtime-initiated: the prior tool response carried
 *    `_interruption: {context, candidates}`; the agent picks a resolver
 *    from the menu and calls this with that same context.
 *  - Agent-initiated: the agent spotted a challenge on the page
 *    (captcha / 2FA / auth wall in the a11y tree) and wants a plugin to
 *    resolve it. Build a descriptive context and call directly.
 *
 * On `handover` resolutions the runtime mints an `interruption_token` and
 * attaches it to the response; the next tool call on this session must
 * echo the token + an ack (user_response / viewer_result) OR explicitly
 * cancel with `{cancelled: true, reason}`.
 */
export async function resolveInterruption(args: ResolveInterruptionArgs): Promise<{
  resolution: import('../interruptions').InterruptionResolution;
  interruption_token?: string;
}> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.resolver !== 'string' || args.resolver.length === 0) {
    throw new Error('resolver is required (registered handler name)');
  }
  if (typeof args.context !== 'object') {
    throw new Error('context is required (object describing the event)');
  }
  const session = pool.getSession(args.session_id);
  return invokeAndGateHandover(
    args.resolver,
    {
      session_id: args.session_id,
      capability: args.capability,
      context: args.context,
    },
    session,
  );
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tools/types';

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.listInterruptionResolvers,
    description:
      'List registered interruption-handlers as `{name, description}` — the menu for agent-detected ambient page state (CAPTCHA, auth wall, 2FA prompt). Scope: AGENT-DETECTED only. Runtime-emitted events arrive as `_checkpoint` (ack via `ack_checkpoint`), NOT through this menu. Do not route dismissable UI noise (cookie banners, popups) through this surface — click those away yourself. See klura://reference#interruptions.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Optional. Reserved for future session-scoped filtering; ignored today.',
        },
      },
    },
    skipInterruptionGate: true,
    handler: (args: any) => listInterruptionResolvers({ session_id: args.session_id }),
  },

  {
    name: TOOL_NAMES.resolveInterruption,
    description:
      'Invoke a registered interruption handler by name. Scope: AGENT-DETECTED ambient page state (CAPTCHA / 2FA / auth-wall / login-form). Build context including a `reason` string matching handler-description phrasing (e.g. `{reason: "captcha_challenge", sitekey: "..."}`). Runtime-emitted checkpoints route via `_checkpoint` + `ack_checkpoint`, NOT this tool. Response: `{resolution: {status: "resolved"|"handover"|"continue", ...}, interruption_token?}`. On `handover` the next tool call must echo `interruption_token` + an ack (`user_response` / `viewer_result`) or `{cancelled: true, reason}`; otherwise subsequent calls reject with `invalid_strategy: pending_interruption`. Unknown resolver names throw `invalid_strategy: unknown resolver "<name>"`. See klura://reference#interruptions.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        resolver: {
          type: 'string',
          description:
            'Name of a registered handler — one of the `candidates[].name` from `_interruption` OR `list_interruption_resolvers()`.',
        },
        context: {
          type: 'object',
          description:
            'Event context. For runtime-initiated interruptions: echo back the `_interruption.context` verbatim. For agent-initiated: build a fresh object including a `reason` string that matches handler descriptions (e.g. `{reason: "captcha_challenge", sitekey: "...", iframe_src: "..."}`).',
        },
        capability: {
          type: 'string',
          description: 'Optional capability slug relevant to this event.',
        },
      },
      required: ['session_id', 'resolver', 'context'],
    },
    skipInterruptionGate: true,
    handler: (args: any) =>
      resolveInterruption({
        session_id: args.session_id,
        resolver: args.resolver,
        context: args.context,
        capability: args.capability,
      }),
  },
];
