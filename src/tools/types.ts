// ToolDef — the contract between a tool implementation and the MCP wrapper.
//
// Each tool exports a `TOOL_DEF: ToolDef` constant alongside its
// implementation function. The tool registry (runtime/src/tools/registry.ts)
// collects every TOOL_DEF; mcp/tools.js consumes the registry as its sole
// source of names, descriptions, JSON schemas, and handler bindings.
//
// Why colocated: when a contributor changes the implementation signature or
// renames a tool, the metadata next to the implementation reminds them to
// update both. Drift is impossible by construction.

import type { ToolName } from '../vocab';

/** JSON Schema fragment describing one tool's `inputSchema`. Open-shape
 *  Record because the JSON Schema spec allows arbitrary nested keywords;
 *  the runtime trusts the registry author to write valid schemas. */
export type JsonSchema = Record<string, unknown>;

/** A tool's complete metadata + handler. The MCP wrapper exposes one entry
 *  per TOOL_DEF as `{name, description, inputSchema, handler}`. */
export interface ToolDef<Args = unknown, Result = unknown> {
  /** Wire name as exposed to agents (snake_case). Must be a value of
   *  `TOOL_NAMES` in vocab.ts — tsc rejects literals not in the const map. */
  name: ToolName;
  /** Agent-facing description rendered in the MCP tool list. Reference
   *  other tools via `${TOOL_NAMES.foo}` template literals and reference
   *  REFERENCE.md sections via `${refUrl(REF_LINKS.x)}` so the
   *  check-vocab-leakage and check-ref-links lints can verify integrity. */
  description: string;
  /** JSON Schema for the tool's args. */
  inputSchema: JsonSchema;
  /** Direct invocation. Handler internally calls the sibling implementation
   *  function (e.g. `startSession()`); the MCP wrapper just passes args
   *  through. Sync-or-async — registry callers always await the result. */
  handler: (args: Args) => Promise<Result> | Result;
  /** Bypass the pending-interruption pre-call gate. Set on tools that
   *  resolve the matching pending state (e.g. `resolve_interruption`); every
   *  other tool inherits the default of being blocked until the interruption
   *  is acknowledged. */
  skipInterruptionGate?: boolean;
  /** Bypass the pending-checkpoint pre-call gate. Set on tools that resolve
   *  the matching pending state (e.g. `ack_checkpoint`); every other tool
   *  inherits the default of being blocked until the checkpoint is
   *  acknowledged. */
  skipCheckpointGate?: boolean;
}
