import type { ToolName } from '../vocab';
import type { ToolPhasePolicy } from './tool-phase-policy';

/** JSON Schema fragment describing one tool's `inputSchema`. */
export type JsonSchema = Record<string, unknown>;

/** Per-call context the MCP wrapper passes to tool handlers. */
export interface ToolCallContext {
  progress?: (params: { stage?: string; current?: number; total?: number }) => void;
}

/** A tool's metadata and invocation contract for an MCP adapter. */
export interface ToolDef<Args = unknown, Result = unknown> {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  responseSurface?: 'consumer';
  /** Phase / session admissibility declaration. The per-phase allowed-tool
   *  sets in `runtime/src/phases/tool-catalog.ts` are derived from these —
   *  a tool's phase membership lives here, next to its implementation, not
   *  in a hand-maintained catalog. */
  phasePolicy: ToolPhasePolicy;
  handler: (args: Args, ctx?: ToolCallContext) => Promise<Result> | Result;
  skipInterruptionGate?: boolean;
  skipCheckpointGate?: boolean;
}

export type { ToolPhasePolicy };
