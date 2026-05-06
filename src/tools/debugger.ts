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

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tool-types';

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.setBreakpoint,
    description:
      'Set a CDP source-location breakpoint. `file` is a script URL as reported by `inspect_ws_frame.js_callstack.frames[].file` or `list_loaded_scripts`; `line` and optional `column` are the CDP coordinates. Optional `condition` is a JS expression evaluated at the candidate pause — execution only pauses when it is truthy. Returns `breakpoint_id` (pass to remove_breakpoint) and `resolved_location` reporting where CDP actually placed the bp (line numbers can shift to the nearest executable statement). Escalation tool for the RE path — use when the "paused closure" approach is shorter than hand-reading a minified bundle: set the bp at the WebSocket.send site, re-trigger the flow with perform_action, call wait_for_pause, then read the encoder out of the paused scope chain. Max 10 active bps per session; conditions capped at 512 chars. Blocked in execute_only mode. Requires the playwright driver.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        file: {
          type: 'string',
          description: 'Script URL to break in (exact match, as CDP reports).',
        },
        line: { type: 'number', description: '0-indexed line number (CDP convention).' },
        column: { type: 'number', description: '0-indexed column; omit for line-start.' },
        condition: {
          type: 'string',
          description:
            'JS expression evaluated at the pause candidate. Only truthy values pause execution. ≤ 512 chars.',
        },
      },
      required: ['session_id', 'file', 'line'],
    },
    handler: (args: any) =>
      setBreakpointTool({
        session_id: args.session_id,
        file: args.file,
        line: args.line,
        column: args.column,
        condition: args.condition,
      }),
  },

  {
    name: TOOL_NAMES.removeBreakpoint,
    description:
      'Remove an active breakpoint by id. Idempotent — removing an unknown/already-removed id is a no-op. Use when you are done with a bp, or call end_drive and the runtime will clean up automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        breakpoint_id: { type: 'string' },
      },
      required: ['session_id', 'breakpoint_id'],
    },
    handler: (args: any) =>
      removeBreakpointTool({
        session_id: args.session_id,
        breakpoint_id: args.breakpoint_id,
      }),
  },

  {
    name: TOOL_NAMES.listBreakpoints,
    description:
      'List every active breakpoint on this session, with id, resolved location (file/line/column), and condition if any. Use to introspect after a flaky pause or to verify a bp landed where you expected.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
    handler: (args: any) => listBreakpointsTool({ session_id: args.session_id }),
  },

  {
    name: TOOL_NAMES.waitForPause,
    description:
      'Block until the page hits a breakpoint or `timeout_ms` elapses. Does NOT resume — the page stays paused so you can inspect the frame. Response shape on a hit: `{hit: true, reason, breakpoint_ids, call_frames: [{frame_index, location, function_name, function_source_preview, scope_chain}]}`. `scope_chain[]` is a shallow list of scope types (`local`, `closure`, `global`) with preview strings — drill deeper with `get_frame_scope`. On timeout: `{hit: false, reason: "timeout", call_frames: []}`. Queues up to 5 unread pauses; the 6th drops the oldest. Only one outstanding wait per session — calling a second time while the first is in flight throws `already_waiting`. Default timeout 10000, max 60000.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        timeout_ms: { type: 'number', description: 'Max wall-clock ms. Default 10000, max 60000.' },
      },
      required: ['session_id'],
    },
    handler: (args: any) =>
      waitForPauseTool({
        session_id: args.session_id,
        timeout_ms: args.timeout_ms,
      }),
  },

  {
    name: TOOL_NAMES.getFrameScope,
    description:
      'Dump one scope of one paused call frame as a shallow property list. Pick the scope by `scope_type` (first match wins: `local`, `closure`, `global`, `block`, `catch`, `with`, `module`) OR by `scope_index` into the frame\'s scope_chain. Returns `{properties: [{name, type, preview, has_children}]}` capped at 200 entries (sets `truncated: true` over the cap). For the closure scope at the WebSocket.send site, `properties[]` typically contains the encoder function, the original args, and any buffered channel state — exactly what you need to save as a verified expression. Drill into nested objects with `evaluate_on_frame(frame_index, "name.of.thing")`. Session must be paused.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        frame_index: { type: 'number', description: '0-indexed into the paused call_frames.' },
        scope_type: {
          type: 'string',
          description:
            'Pick scope by type (first match). One of: local, closure, global, block, catch, with, module.',
        },
        scope_index: {
          type: 'number',
          description: 'Alternative to scope_type — 0-indexed into scope_chain.',
        },
      },
      required: ['session_id', 'frame_index'],
    },
    handler: (args: any) =>
      getFrameScopeTool({
        session_id: args.session_id,
        frame_index: args.frame_index,
        scope_type: args.scope_type,
        scope_index: args.scope_index,
      }),
  },

  {
    name: TOOL_NAMES.evaluateOnFrame,
    description:
      "Run arbitrary JS in the paused frame's context — DevTools-console-on-a-paused-frame. Backed by CDP `Debugger.evaluateOnCallFrame`, so the expression sees the frame's locals and closure-captured variables directly (unlike js_eval which runs at global scope). Typical uses: `JSON.stringify(arguments)` to snapshot the exact call args, `encodeSend.toString()` to read the encoder source, `this.__channel` to reach instance state. **Call `get_frame_scope(frame_index)` first** — the names and shapes of what's in scope depend on where the breakpoint landed (locals may be minified, `arguments[0]` may not be the payload you expect, `this` may be undefined in arrow bodies). Reading scope first avoids the \"undefined.byteLength\" class of error. Result is string-serialized (`result` on ok, `error` on throw). Execution is sync against the frozen page — no async IIFE wrap. Session must be paused. Expression cap 4096 chars; timeout default 5000, max 30000.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        frame_index: { type: 'number' },
        expression: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['session_id', 'frame_index', 'expression'],
    },
    handler: (args: any) =>
      evaluateOnFrameTool({
        session_id: args.session_id,
        frame_index: args.frame_index,
        expression: args.expression,
        timeout_ms: args.timeout_ms,
        result_offset: args.result_offset,
        result_length: args.result_length,
      }),
  },

  {
    name: TOOL_NAMES.step,
    description:
      'Advance a paused execution by one step. `mode` is `over` (execute current line, pause at next), `into` (descend into a function call), or `out` (run to the end of the current function). Returns `{paused_at: {file, line, column, function_name}}` on the next pause, or `{done: true}` when execution resumes without pausing again within 5s. Session must be paused.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        mode: { type: 'string', enum: ['over', 'into', 'out'] },
      },
      required: ['session_id', 'mode'],
    },
    handler: (args: any) => stepTool({ session_id: args.session_id, mode: args.mode }),
  },

  {
    name: TOOL_NAMES.resume,
    description:
      "Release the current pause and let the page continue. No-op when the session isn't paused. Use after you have extracted everything you need from the paused frame. end_drive also auto-resumes, so in practice this tool is optional if you are about to close.",
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
    handler: (args: any) => resumeTool({ session_id: args.session_id }),
  },
];
