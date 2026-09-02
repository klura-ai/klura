import { pool } from '../runtime-state';
import { checkCapabilityArgs } from '../tools/well-known-capabilities';

export interface DeclareCapabilityArgs {
  session_id: string;
  capability: string;
  args?: Record<string, unknown>;
}

/**
 * Declare a capability the agent is about to discover on this session. Used by
 * the runtime at end_drive to partition perform_action history per
 * capability and auto-derive page-script/fetch strategies by joining typed
 * literals to captured traffic. Also the declaration surface for
 * multi-capability sessions (call once per capability). For single-capability
 * sessions, pass `{capability, args}` to start_session directly and skip this
 * tool.
 */
export function declareCapability(args: DeclareCapabilityArgs): { ok: true; _hint?: string } {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.capability !== 'string' || args.capability.length === 0) {
    throw new Error('capability is required (slug)');
  }
  const argMap = args.args && typeof args.args === 'object' ? args.args : {};
  const session = pool.getSession(args.session_id);

  // If start_session already declared this capability with more args, the
  // agent is dropping params on the redeclare — name the lost keys so the
  // next call restores them.
  const priorHints: string[] = [];
  const prior = session.declaredCapabilities?.find((d) => d.capability === args.capability);
  if (prior?.args) {
    const droppedKeys = Object.keys(prior.args).filter((k) => !(k in argMap));
    if (droppedKeys.length > 0) {
      priorHints.push(
        `start_session declared '${args.capability}' with args {${Object.keys(prior.args).join(', ')}} but this declare_capability call only supplies {${Object.keys(argMap).join(', ') || '<none>'}}. ` +
          `Dropped: ${droppedKeys.join(', ')}. ` +
          `Auto-save needs every user-supplied literal to template the strategy — restore the missing keys with their original values.`,
      );
    }
  }

  if (!session.declaredCapabilities) session.declaredCapabilities = [];
  session.declaredCapabilities.push({
    capability: args.capability,
    args: argMap,
    declared_at: Date.now(),
  });

  const wellKnownHint = checkCapabilityArgs(args.capability, argMap);
  if (wellKnownHint) priorHints.push(wellKnownHint);
  if (priorHints.length === 0) return { ok: true };
  return { ok: true, _hint: priorHints.join('\n\n') };
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tools/types';

export const TOOL_DEF: ToolDef = {
  name: TOOL_NAMES.declareCapability,
  phasePolicy: { category: 'capability_declaration' },
  description:
    'Declare a capability the agent is about to discover on this session. Call once per capability the user asked for (e.g. "send_message", "search_contact"). `args` is a map `{paramName: value}` of user-supplied inputs; values may be strings, numbers, booleans, arrays, objects, or null. Scalar strings can template captured request bodies, and structured values remain available through nested placeholders. For single-capability sessions, pass `{capability, args}` to start_session and skip this tool.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
      capability: {
        type: 'string',
        description: 'Capability slug the agent is about to discover.',
      },
      args: { type: 'object', description: 'Map of user-supplied input values.' },
    },
    required: ['session_id', 'capability'],
  },
  handler: (args: any) =>
    declareCapability({
      session_id: args.session_id,
      capability: args.capability,
      args: args.args,
    }),
};
