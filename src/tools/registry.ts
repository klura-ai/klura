// Tool registry — single source of truth for MCP tool descriptions.
//
// Each tool exports a `TOOL_DEF: ToolDef` constant alongside its
// implementation. This file imports every TOOL_DEF and assembles the
// flat `TOOL_REGISTRY` array that the MCP wrapper (mcp/tools.js) consumes.
//
// `runtime/test/registry-parity.test.js` asserts internal consistency:
// every entry has a unique name in TOOL_NAMES, every name references a
// callable handler, every TOOL_NAMES value appears in the registry, and
// gate-owning tools (ack_checkpoint, resolve_interruption,
// list_interruption_resolvers) set their bypass flags.
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

import { TOOL_DEF as startSession } from './start-session';
import { TOOL_DEFS as performActionTools } from './perform-action';
import { TOOL_DEFS as pageHelperTools } from './page-helpers';
import { TOOL_DEFS as wsFrameTools } from './ws-frames';
import { TOOL_DEF as triggerReferenceSend } from './trigger-reference-send';
import { TOOL_DEFS as generatorTools } from './generators';
import { TOOL_DEFS as sessionEnvelopeTools } from './session-envelopes';
import { TOOL_DEFS as saveStrategyTools } from './save-strategy';
import { TOOL_DEF as submitTriagePlan } from './submit-triage-plan';
import { TOOL_DEFS as skillsQueryTools } from './skills-query';
import { TOOL_DEF as getStrategyHealth } from './health';
import { TOOL_DEF as declareCapability } from './declare-capability';
import { TOOL_DEFS as discoveryArtifactTools } from './discovery-artifact-tools';
import { TOOL_DEFS as jsTools } from './js-tools';
import { TOOL_DEFS as debuggerTools } from './debugger';
import { TOOL_DEFS as remoteTools } from './remote';
import { TOOL_DEFS as listenerTools } from './listeners';
import { TOOL_DEF as resumeExecution } from './execute';
import { TOOL_DEFS as configTools } from './config-tools';
import { TOOL_DEFS as interruptionTools } from './interruption-tools';

export const TOOL_REGISTRY: ToolDef[] = [
  startSession,
  ...performActionTools,
  ...pageHelperTools,
  ...wsFrameTools,
  triggerReferenceSend,
  ...generatorTools,
  ...sessionEnvelopeTools,
  ...saveStrategyTools,
  submitTriagePlan,
  ...skillsQueryTools,
  getStrategyHealth,
  declareCapability,
  ...discoveryArtifactTools,
  ...jsTools,
  ...debuggerTools,
  ...remoteTools,
  ...listenerTools,
  resumeExecution,
  ...configTools,
  ...interruptionTools,
];
