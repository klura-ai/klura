import path from 'node:path';
import { OriginSchedulerV1 } from './origin-scheduler';

const schedulers = new Map<string, OriginSchedulerV1>();

/** Returns the process-local origin scheduler for one private runtime home. */
export function getSharedOriginScheduler(home: string): OriginSchedulerV1 {
  const existing = schedulers.get(home);
  if (existing) return existing;
  const scheduler = new OriginSchedulerV1({ state_path: path.join(home, 'scheduler-state.json') });
  schedulers.set(home, scheduler);
  return scheduler;
}
