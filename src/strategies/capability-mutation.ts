// Per-capability mutation lock. Every write path that mutates a capability's
// active strategy files (commit, promote, patch, migrate, demote, archive,
// unarchive, runtime-meta stamps, post-save verification) serializes through
// this lock, keyed by (platform, capability). The mutual-exclusion mechanics
// and stale-recovery policy live in `utils/owner-file-lock` — this module only
// owns the lock path scheme and the agent-facing error.

import crypto from 'crypto';
import path from 'path';
import { STRATEGY_CANDIDATES_DIR } from '../paths';
import { withOwnerFileLock } from '../utils/owner-file-lock';

export { writeTextAtomically, writeJsonAtomically } from '../utils/owner-file-lock';

export class CapabilityMutationLockError extends Error {
  readonly code = 'capability_mutation_locked';

  constructor(platform: string, capability: string) {
    super(
      `capability_mutation_locked: ${platform}/${capability} is being updated by another process`,
    );
    this.name = 'CapabilityMutationLockError';
  }
}

interface CapabilityMutationLockOptions {
  lockedError?: () => Error;
}

function capabilityMutationLockPath(platform: string, capability: string): string {
  const key = crypto
    .createHash('sha256')
    .update('klura-capability-mutation-v1\0')
    .update(JSON.stringify([platform, capability]))
    .digest('hex');
  return path.join(STRATEGY_CANDIDATES_DIR, '.mutation-locks', `${key}.lock`);
}

export function withCapabilityMutationLock<Value>(
  platform: string,
  capability: string,
  operation: () => Value,
  options: CapabilityMutationLockOptions = {},
): Value {
  return withOwnerFileLock(capabilityMutationLockPath(platform, capability), operation, {
    onLocked: () =>
      options.lockedError?.() ?? new CapabilityMutationLockError(platform, capability),
  });
}
