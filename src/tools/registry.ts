// Tool registry — single source of truth for MCP tool descriptions.
//
// Each tool exports a `TOOL_DEF: ToolDef` constant alongside its
// implementation. This file imports every TOOL_DEF and assembles the
// flat `TOOL_REGISTRY` array that the MCP wrapper (mcp/tools.js) consumes.
//
// **Migration status (in progress).** The tool catalog historically lived in
// mcp/tools.js as hand-maintained `{name, description, inputSchema, handler}`
// entries — sole source. This registry colocates each entry with its
// implementation so a reviewer sees both halves at once and a rename
// cascades through tsc instead of relying on convention.
//
// The migration is incremental: tools land in this registry one (or one
// file) at a time. Until every tool is migrated, the MCP wrapper falls back
// to mcp/tools.js for any tool whose name isn't in TOOL_REGISTRY. The
// registry-parity test in runtime/test/registry-parity.test.js asserts that
// every entry in TOOL_REGISTRY (a) has a unique name in TOOL_NAMES, (b)
// references a real tool, (c) has a callable handler.
//
// **Adding a new tool** — define `TOOL_DEF` next to the implementation:
//
//     // runtime/src/tools/my-tool.ts
//     import { TOOL_NAMES, refUrl, REF_LINKS } from '../vocab';
//     import type { ToolDef } from '../tool-types';
//
//     export const TOOL_DEF: ToolDef = {
//       name: TOOL_NAMES.myTool,
//       description:
//         `... call ${TOOL_NAMES.endDrive} when done. ` +
//         `See ${refUrl(REF_LINKS.checkpoints)}.`,
//       inputSchema: { type: 'object', properties: { ... }, required: [...] },
//       handler: (args) => myToolImpl(args.foo, args.bar),
//     };
//
//     export async function myToolImpl(foo, bar) { /* ... */ }
//
// Then add the import to TOOL_REGISTRY below.

import type { ToolDef } from '../tool-types';

// Migrated TOOL_DEFs go here. Pattern:
//   import { TOOL_DEF as someTool } from './some-tool';
// then include in the array below.

export const TOOL_REGISTRY: ToolDef[] = [
  // (Empty during migration — mcp/tools.js still owns the full catalog.
  //  Add entries as tools migrate.)
];
