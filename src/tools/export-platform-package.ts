import { exportPlatformPackageToTools } from '../factory/public-package/platform-export';
import type { ToolDef } from './types';
import { REF_LINKS, TOOL_NAMES, refUrl } from '../vocab';

export const TOOL_DEF: ToolDef = {
  name: TOOL_NAMES.exportPlatformPackage,
  phasePolicy: { category: 'none' },
  description:
    `Export the reviewed subset of active verified read capabilities for one platform into a PR-ready tools repository directory; unreviewed capabilities stay local. Stops before git or publishing. ` +
    `See ${refUrl(REF_LINKS.packageExport)}.`,
  inputSchema: {
    type: 'object',
    properties: {
      platform: { type: 'string' },
      tools_repository_path: { type: 'string' },
      review: { type: 'object' },
    },
    required: ['platform', 'tools_repository_path', 'review'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: (args) => exportPlatformPackageToTools(args),
};
