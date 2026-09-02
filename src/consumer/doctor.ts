import { getConsumerOriginScheduler } from './execution/shared-scheduler';
import type { OriginSchedulerSnapshotV1 } from './execution/origin-scheduler';
import { PackageStoreV1 } from './store/package-store';

export interface ConsumerDoctorResultV1 {
  result_schema_version: 1;
  kind: 'doctor';
  installed_packages: number;
  local_state: 'ok' | 'invalid';
  scheduler: OriginSchedulerSnapshotV1 | null;
}

/** Reads only local consumer state, including live daemon scheduler contention. */
export class ConsumerDoctorServiceV1 {
  constructor(private readonly store = new PackageStoreV1()) {}

  inspect(): ConsumerDoctorResultV1 {
    try {
      const installedPackages = Object.keys(this.store.readInstalled().packages).length;
      return {
        result_schema_version: 1,
        kind: 'doctor',
        installed_packages: installedPackages,
        local_state: 'ok',
        scheduler: getConsumerOriginScheduler(this.store.paths.home).snapshot(),
      };
    } catch {
      return {
        result_schema_version: 1,
        kind: 'doctor',
        installed_packages: 0,
        local_state: 'invalid',
        scheduler: null,
      };
    }
  }
}
