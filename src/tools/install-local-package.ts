// `install_local_package` — turn the reviewed subset of a platform's active
// saved capabilities into an unsigned, locally provenanced package in the
// local package store, so the ordinary consumer surface (call, login, session,
// scrape run, resume) can execute it.
//
// The envelope shape is validated here so a malformed call is rejected with a
// Zod-derived synopsis. The two reviewed leaves — `contract` and `page_script`
// — are validated only for their exact key set: their values belong to the
// public contract parsers, and a Zod mirror of those contracts would be a
// second source of truth that drifts the moment a public field changes. A
// rejection from that depth names the exact failing field path, which is a
// more precise synopsis than any shape sketch.
import { z } from 'zod';
import {
  CAPABILITY_CONTRACT_KEYS,
  PAGE_SCRIPT_REVIEW_KEYS,
} from '../factory/public-package/capability-review';
import {
  installLocalPlatformPackage,
  LOCAL_INSTALL_FIELD_V1,
} from '../factory/public-package/local-install';
import { COLLECTION_CONTRACT_KEYS } from '../public/contracts/collection';
import { parseOrThrow } from '../strategies/schemas/zod-helpers';
import type { ToolDef } from './types';
import { REF_LINKS, TOOL_NAMES, refUrl } from '../vocab';

// Every synopsis below is composed at module load from the exported key
// constants, so a new reviewed field reaches the agent-facing rejection with
// no edit here.
const CONTRACT_SYNOPSIS = `exactly these keys: ${CAPABILITY_CONTRACT_KEYS.join(', ')} (collection is null, or exactly these keys: ${COLLECTION_CONTRACT_KEYS.join(', ')})`;
const PAGE_SCRIPT_SYNOPSIS = `exactly these keys: ${PAGE_SCRIPT_REVIEW_KEYS.join(', ')}`;

function reviewedLeaf(keys: readonly string[], synopsis: string): z.ZodType {
  return z
    .custom<Record<string, unknown>>((value) => hasExactKeys(value, keys), {
      error: () => `must be an object with ${synopsis}`,
    })
    .describe(synopsis);
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const present = Object.keys(value as Record<string, unknown>);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

const installLocalPackageSchema = z
  .object({
    platform: z
      .string()
      .min(1)
      .describe('saved platform slug; the package id is derived as local-<platform>'),
    version: z.string().min(1).describe('SemVer version of this local package'),
    authentication_contracts: z
      .record(z.string(), z.unknown())
      .describe('declared authentication realms, keyed by contract id; {} for a public site'),
    capabilities: z
      .record(
        z.string(),
        z
          .object({
            contract: reviewedLeaf(CAPABILITY_CONTRACT_KEYS, CONTRACT_SYNOPSIS),
            page_script: reviewedLeaf(PAGE_SCRIPT_REVIEW_KEYS, PAGE_SCRIPT_SYNOPSIS),
          })
          .strict(),
      )
      .describe(
        `one entry per reviewed capability: { contract: { ${CONTRACT_SYNOPSIS} }, page_script: { ${PAGE_SCRIPT_SYNOPSIS} } }`,
      ),
  })
  .strict();

export function installLocalPackage(args: unknown): ReturnType<typeof installLocalPlatformPackage> {
  const input = parseOrThrow(installLocalPackageSchema, args, {
    where: LOCAL_INSTALL_FIELD_V1,
    referenceSlug: REF_LINKS.localPackage,
  });
  return installLocalPlatformPackage(input);
}

export const TOOL_DEF: ToolDef = {
  name: TOOL_NAMES.installLocalPackage,
  phasePolicy: { category: 'none' },
  description:
    `Install the reviewed subset of a platform's active saved capabilities as an unsigned local package under the reserved local- id namespace, so ${TOOL_NAMES.callPackageCapability} and ${TOOL_NAMES.startScrapeRun} can run it. Never signed, never published, never in the registry. ` +
    `See ${refUrl(REF_LINKS.localPackage)}.`,
  inputSchema: {
    type: 'object',
    properties: {
      platform: { type: 'string' },
      version: { type: 'string' },
      authentication_contracts: { type: 'object' },
      capabilities: { type: 'object' },
    },
    required: ['platform', 'version', 'authentication_contracts', 'capabilities'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: (args) => installLocalPackage(args),
};
