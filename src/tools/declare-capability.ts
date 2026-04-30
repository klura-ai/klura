import { pool } from '../runtime-state';

export interface DeclareCapabilityArgs {
  session_id: string;
  capability: string;
  args?: Record<string, string>;
}

/**
 * Declare a capability the agent is about to discover on this session. Used by
 * the runtime at close_session to partition perform_action history per
 * capability and auto-derive page-script/fetch strategies by joining typed
 * literals to captured traffic. Also the declaration surface for
 * multi-capability sessions (call once per capability). For single-capability
 * sessions, pass `{capability, args}` to start_session directly and skip this
 * tool.
 */
export function declareCapability(args: DeclareCapabilityArgs): { ok: true } {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.capability !== 'string' || args.capability.length === 0) {
    throw new Error('capability is required (slug)');
  }
  const argMap = (args.args && typeof args.args === 'object' ? args.args : {}) as Record<
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
  const session = pool.getSession(args.session_id);
  if (!session.declaredCapabilities) session.declaredCapabilities = [];
  session.declaredCapabilities.push({
    capability: args.capability,
    args: argMap as Record<string, string>,
    declared_at: Date.now(),
  });
  return { ok: true };
}
