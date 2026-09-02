import fs from 'fs';
import path from 'path';
import { SKILLS_DIR } from '../paths';
import { asEnum, asIdentifierSlug, asPlatformSlug, ValidationError } from '../validators';
import { REF_LINKS, refUrl, STRATEGY_TIERS } from '../vocab';
import { appendStrategyEvent } from '../working-dir/logbook';
import {
  CapabilityMutationLockError,
  withCapabilityMutationLock,
  writeJsonAtomically,
} from './capability-mutation';
import { STRATEGY_SUBDIR_MAP } from './strategy-candidates';

export function patchStep(
  platform: string,
  capability: string,
  strategyType: string,
  stepId: string,
  patch: Record<string, unknown>,
): { ok: true; path: string } | { error: string } {
  try {
    asPlatformSlug(platform, 'platform');
    asIdentifierSlug(capability, 'capability');
    asEnum(strategyType, 'strategyType', STRATEGY_TIERS);
  } catch (error) {
    if (error instanceof ValidationError) {
      return { error: `invalid_patch: ${error.message}` };
    }
    return { error: String(error) };
  }

  if (typeof stepId !== 'string' || stepId.length === 0) {
    return {
      error: `invalid_patch: step_id must be a non-empty string (the slug id declared on the recorded-path step, e.g. "click_send"). See ${refUrl(REF_LINKS.recordedPathSchema)}.`,
    };
  }

  const subdir = STRATEGY_SUBDIR_MAP[strategyType];
  if (!subdir) return { error: `unknown strategy type: ${strategyType}` };
  try {
    return withCapabilityMutationLock(platform, capability, () => {
      const filePath = path.join(SKILLS_DIR, platform, subdir, `${capability}.json`);
      if (!fs.existsSync(filePath)) return { error: 'strategy file not found' };

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { steps?: unknown[] };
      const steps = data.steps;
      if (!Array.isArray(steps)) return { error: 'strategy type has no steps' };

      const knownIds: string[] = [];
      let targetIndex = -1;
      for (let i = 0; i < steps.length; i += 1) {
        const strategyStep = steps[i];
        if (!strategyStep || typeof strategyStep !== 'object') continue;
        const id = (strategyStep as { id?: unknown }).id;
        if (typeof id !== 'string') continue;
        knownIds.push(id);
        if (id === stepId) targetIndex = i;
      }
      if (targetIndex === -1) {
        const idList = knownIds.map((id) => `"${id}"`).join(', ') || '(none)';
        return {
          error: `invalid_strategy: no step with id "${stepId}" in strategy; known ids: [${idList}]`,
        };
      }

      const step = steps[targetIndex] as Record<string, unknown>;
      const mergeLocators = patch.merge_locators === true;
      const isPlainObject = (value: unknown): value is Record<string, unknown> =>
        !!value && typeof value === 'object' && !Array.isArray(value);
      const appliedKeys: string[] = [];
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'merge_locators') continue;
        if (
          mergeLocators &&
          key === 'locators' &&
          isPlainObject(value) &&
          isPlainObject(step.locators)
        ) {
          step.locators = { ...step.locators, ...value };
        } else {
          step[key] = value;
        }
        appliedKeys.push(key);
      }

      writeJsonAtomically(filePath, data);
      appendStrategyEvent(platform, capability, {
        strategy: strategyType,
        kind: 'patched',
        detail: `step "${stepId}": patched ${appliedKeys.join(', ')}`,
      });
      return { ok: true, path: filePath };
    });
  } catch (error) {
    if (error instanceof CapabilityMutationLockError) {
      return { error: error.message };
    }
    throw error;
  }
}
