export interface DebuggerLocation {
  file: string;
  line: number;
  column?: number;
}

export interface DebuggerScopeSummary {
  type: string;
  object_preview: string;
}

export interface DebuggerCallFrame {
  frame_index: number;
  location: DebuggerLocation;
  function_name: string;
  function_source_preview: string;
  scope_chain: DebuggerScopeSummary[];
}

export interface DebuggerPause {
  hit: boolean;
  reason: 'breakpoint' | 'debugger_statement' | 'exception' | 'other' | 'timeout';
  breakpoint_ids?: string[];
  call_frames: DebuggerCallFrame[];
}
