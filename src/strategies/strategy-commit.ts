import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_DIR } from '../paths';
import { appendStrategyEvent } from '../working-dir/logbook';
import { withCapabilityMutationLock, writeJsonAtomically } from './capability-mutation';
import {
  createPostSaveVerificationProof,
  type PostSaveVerificationProofV1,
} from './post-save-verification-proof';
import { STRATEGY_SUBDIR_MAP } from './strategy-candidates';
import type { Strategy } from './skills';

export function commitPreparedStrategy(
  platform: string,
  capability: string,
  data: Strategy,
  changelog?: string,
  captureProof = false,
): { path: string; proof?: PostSaveVerificationProofV1 } {
  return withCapabilityMutationLock(platform, capability, () => {
    const subdir = STRATEGY_SUBDIR_MAP[data.strategy] || 'api';
    const directory = path.join(SKILLS_DIR, platform, subdir);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `${capability}.json`);
    const existed = fs.existsSync(filePath);
    writeJsonAtomically(filePath, data);
    appendStrategyEvent(platform, capability, {
      strategy: data.strategy,
      kind: existed ? 'rediscovered' : 'discovered',
      detail: changelog || (existed ? 'overwriting existing' : `saved ${data.strategy} strategy`),
    });
    return {
      path: filePath,
      ...(captureProof
        ? { proof: createPostSaveVerificationProof(platform, capability, data) }
        : {}),
    };
  });
}
