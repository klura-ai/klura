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
