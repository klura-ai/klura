// Stage 0 shape check: a read strategy saved under `audit.packageReadiness:
// "require"` must have a structure the package exporter can compile.
//
// The exporter's own compile step decides, so there is one definition of
// "can be packaged". It runs before anything is committed: the agent gets the
// reason in the rejection it is already reading and re-saves in the session
// that still has the page open, instead of a later session being opened to
// repair a strategy that worked.
import type { ShapeCheck } from '../index';
import { AUDIT_KINDS, REF_LINKS, refUrl } from '../../vocab';
import { loadConfig } from '../../config/handler';
import type { Strategy } from '../../strategies/skills';
import {
  isPackageCandidate,
  packageStructureIssues,
} from '../../factory/public-package/package-readiness';

export const packageStructureCheck: ShapeCheck<Strategy, { capability: string }> = {
  kind: AUDIT_KINDS.packageStructure,
  check: (data, ctx) => {
    if (loadConfig().audit.packageReadiness !== 'require') return;
    if (!isPackageCandidate(data)) return;
    const issues = packageStructureIssues(data, ctx.capability);
    if (issues.length === 0) return;
    const ref =
      `\n\nThis capability is being saved to ship in a package, and a package carries one ` +
      `static request or one page program. See ${refUrl(REF_LINKS.packageExport)}.`;
    if (issues.length === 1) throw new Error(`invalid_strategy: ${issues[0]}${ref}`);
    throw new Error(
      `invalid_strategy: ${issues.length} package-structure issues — fix all before retrying:\n` +
        issues.map((issue) => `  - ${issue}`).join('\n') +
        ref,
    );
  },
};
