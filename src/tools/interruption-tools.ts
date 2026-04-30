import { pool } from '../runtime-state';
import { listInterruptionHandlers } from '../interruptions';
import { invokeAndGateHandover } from '../tool-helpers';

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
