import type { ToolName } from '../vocab';

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
  handler: (args: Args, ctx?: ToolCallContext) => Promise<Result> | Result;
  skipInterruptionGate?: boolean;
  skipCheckpointGate?: boolean;
}
