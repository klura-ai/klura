// Saved-strategy invocation entry points used by the runtime.
//
// The full execution pipeline lives in `runtime/src/execution.ts` (and is
// re-exported from `runtime/src/index.ts` as `execute`). Callers — the
// daemon CLI bridge, the warm-execute path on `start_session`, the
// `graph: 'execute'` entry phase — invoke that directly. This file keeps
// only `resumeExecution`, which is the MCP-facing wrapper for the
// `resume_execution` tool used after a paused recorded-path strategy.

import { pool } from '../runtime-state';
import { resumeRecordedPath } from '../execution';
import type { ExecuteResult } from '../execution/types';

export async function resumeExecution(sessionId: string): Promise<ExecuteResult> {
  return await resumeRecordedPath(sessionId, pool);
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tool-types';

export const TOOL_DEF: ToolDef = {
  name: TOOL_NAMES.resumeExecution,
  description:
    'Resume a paused recorded-path execution from the step after the last failure. Use after patching the failed step.',
  inputSchema: {
    type: 'object',
    properties: { session_id: { type: 'string' } },
    required: ['session_id'],
  },
  handler: (args: any) => resumeExecution(args.session_id),
};
