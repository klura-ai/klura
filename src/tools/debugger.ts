import { pool } from '../runtime-state';
import { ensureAccumulator, ringPush, digestSelector } from '../strategies/discovery-artifact';
import { truncateString, guardLargeResult } from '../response/response-size';
import { asEnum, ValidationError } from '../validators';

// Debugger surface. Set breakpoints, wait for the page to hit them, inspect
// paused frames. Backs the RE-path "paused send site" workflow — the agent
// finds the WebSocket.send call via inspect_ws_frame.js_callstack, drops a
// breakpoint on it, re-triggers the flow, and reads the encoder out of the
// paused closure. See runtime/REFERENCE.md#debugger-surface for the full flow.
// Every handler routes through the driver; Playwright backs the CDP Debugger
// domain, other drivers throw not_implemented.

const DEBUGGER_CONDITION_MAX = 512;
const DEBUGGER_WAIT_TIMEOUT_MS_MAX = 60_000;
const DEBUGGER_EVAL_TIMEOUT_MS_MAX = 30_000;

export async function setBreakpointTool(args: {
  session_id: string;
  file: string;
  line: number;
  column?: number;
  condition?: string;
}): Promise<{
  breakpoint_id: string;
  resolved_location?: { file: string; line: number; column?: number };
}> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.file !== 'string' || args.file.length === 0) {
    throw new Error('file is required (non-empty string)');
  }
  if (!Number.isInteger(args.line) || args.line < 0) {
    throw new Error('line must be a non-negative integer');
  }
  if (args.column !== undefined && (!Number.isInteger(args.column) || args.column < 0)) {
    throw new Error('column must be a non-negative integer');
  }
  if (args.condition !== undefined) {
    if (typeof args.condition !== 'string') throw new Error('condition must be a string');
    if (args.condition.length > DEBUGGER_CONDITION_MAX) {
      throw new Error(`condition must be ≤ ${DEBUGGER_CONDITION_MAX} chars`);
    }
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  const result = await driver.setBreakpoint(session, {
    file: args.file,
    line: args.line,
    column: args.column,
    condition: args.condition,
  });
  ringPush(ensureAccumulator(session).setBreakpointCalls, {
    file_digest: digestSelector(args.file),
    line: args.line,
    at: new Date().toISOString(),
  });
  return result;
}

export async function removeBreakpointTool(args: {
  session_id: string;
  breakpoint_id: string;
}): Promise<{ ok: true }> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.breakpoint_id !== 'string' || args.breakpoint_id.length === 0) {
    throw new Error('breakpoint_id is required');
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  await driver.removeBreakpoint(session, args.breakpoint_id);
  return { ok: true };
}

export async function listBreakpointsTool(args: { session_id: string }): Promise<{
  breakpoints: Array<{
    breakpoint_id: string;
    location: { file: string; line: number; column?: number };
    condition?: string;
  }>;
}> {
  if (!args.session_id) throw new Error('session_id is required');
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  const breakpoints = await driver.listBreakpoints(session);
  return { breakpoints };
}

export async function waitForPauseTool(args: {
  session_id: string;
  timeout_ms?: number;
}): Promise<import('../drivers/types/debugger').DebuggerPause> {
  if (!args.session_id) throw new Error('session_id is required');
  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 10_000, 1), DEBUGGER_WAIT_TIMEOUT_MS_MAX);
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  return driver.waitForPause(session, { timeoutMs });
}

// Closure scopes at minified bundle breakpoints can hold hundreds of properties
// with multi-KB previews each. Cap both dimensions; agent drills into specific
// props via evaluate_on_frame.
const FRAME_SCOPE_PROPERTY_CAP = 100;
const FRAME_SCOPE_PREVIEW_CAP = 1_000;

export async function getFrameScopeTool(args: {
  session_id: string;
  frame_index: number;
  scope_type?: string;
  scope_index?: number;
}): Promise<{
  properties: Array<{
    name: string;
    type: string;
    preview: string;
    has_children: boolean;
    preview_truncated?: true;
  }>;
  truncated?: boolean;
  properties_total?: number;
  properties_truncated?: true;
}> {
  if (!args.session_id) throw new Error('session_id is required');
  if (!Number.isInteger(args.frame_index) || args.frame_index < 0) {
    throw new Error('frame_index must be a non-negative integer');
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  const raw = await driver.getFrameScope(session, {
    frameIndex: args.frame_index,
    scopeType: args.scope_type,
    scopeIndex: args.scope_index,
  });
  const totalProps = raw.properties.length;
  const capped = raw.properties.slice(0, FRAME_SCOPE_PROPERTY_CAP).map((p) => {
    if (typeof p.preview === 'string' && p.preview.length > FRAME_SCOPE_PREVIEW_CAP) {
      return {
        ...p,
        preview: truncateString(p.preview, FRAME_SCOPE_PREVIEW_CAP),
        preview_truncated: true as const,
      };
    }
    return p;
  });
  return {
    ...raw,
    properties: capped,
    ...(totalProps > FRAME_SCOPE_PROPERTY_CAP
      ? { properties_total: totalProps, properties_truncated: true as const }
      : {}),
  };
}

export async function evaluateOnFrameTool(args: {
  session_id: string;
  frame_index: number;
  expression: string;
  timeout_ms?: number;
  result_offset?: number;
  result_length?: number;
}): Promise<
  | ({
      ok: true;
    } & Record<string, unknown>)
  | {
      ok: false;
      error?: string;
    }
> {
  if (!args.session_id) throw new Error('session_id is required');
  if (!Number.isInteger(args.frame_index) || args.frame_index < 0) {
    throw new Error('frame_index must be a non-negative integer');
  }
  if (typeof args.expression !== 'string' || args.expression.length === 0) {
    throw new Error('expression is required (non-empty string)');
  }
  if (args.expression.length > 4096) {
    throw new Error('expression must be ≤ 4096 chars');
  }
  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 5000, 50), DEBUGGER_EVAL_TIMEOUT_MS_MAX);
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  const result = await driver.evaluateOnFrame(session, {
    frameIndex: args.frame_index,
    expression: args.expression,
    timeoutMs,
  });
  ringPush(ensureAccumulator(session).evaluateOnFrameCalls, {
    expression_digest: digestSelector(args.expression),
    ok: result.ok,
    at: new Date().toISOString(),
  });
  if (result.ok) {
    // Guard the result field — closure scope previews can be multi-MB. Same
    // canonical slicer as js_eval.
    const guarded = guardLargeResult(
      result.result,
      args.result_offset,
      args.result_length,
      'evaluate_on_frame',
    );
    return { ok: true, ...guarded };
  }
  return result;
}

export async function stepTool(args: {
  session_id: string;
  mode: 'over' | 'into' | 'out';
}): Promise<{
  paused_at?: { file: string; line: number; column?: number; function_name?: string };
  done?: true;
}> {
  if (!args.session_id) throw new Error('session_id is required');
  try {
    asEnum(args.mode, 'mode', ['over', 'into', 'out'] as const);
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_step: ${e.message}`, { cause: e });
    }
    throw e;
  }
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  return await driver.stepDebugger(session, args.mode);
}

export async function resumeTool(args: { session_id: string }): Promise<{ ok: true }> {
  if (!args.session_id) throw new Error('session_id is required');
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  await driver.resumeDebugger(session);
  return { ok: true };
}
