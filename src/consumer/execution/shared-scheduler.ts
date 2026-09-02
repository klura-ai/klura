import { getSharedOriginScheduler } from '../../execution/shared-origin-scheduler';
import type { OriginSchedulerV1 } from '../../execution/origin-scheduler';

/** Returns the process-local origin scheduler for one private consumer home. */
export function getConsumerOriginScheduler(home: string): OriginSchedulerV1 {
  return getSharedOriginScheduler(home);
}
