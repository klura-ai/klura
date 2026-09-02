import {
  parsePackageId,
  parseSessionName,
  parseStableContractId,
  type PackageIdV1,
  type SessionNameV1,
  type StableContractIdV1,
} from '../public/contracts/common';
import { InstalledPackageResolverV1 } from './installed-package';
import { SessionStoreError, SessionStoreV1 } from './sessions/store';
import { PackageStoreV1 } from './store/package-store';

export interface ClearPackageSessionInputV1 {
  package_id: PackageIdV1 | string;
  authentication_contract_id?: StableContractIdV1 | string;
  session_name?: SessionNameV1 | string;
}

interface SessionTargetV1 {
  package_id: PackageIdV1;
  authentication_contract_id: StableContractIdV1;
  session_name: SessionNameV1;
}

export type AuthenticationContractSelectionV1 =
  | { kind: 'selected'; authentication_contract_id: StableContractIdV1 }
  | {
      kind: 'authentication_not_declared';
      package_id: PackageIdV1;
    }
  | {
      kind: 'authentication_contract_selection_required' | 'authentication_contract_not_found';
      package_id: PackageIdV1;
      authentication_contract_ids: readonly StableContractIdV1[];
    };

export type ClearPackageSessionResultV1 =
  | {
      kind: 'session_cleared' | 'session_not_found';
      package_id: PackageIdV1;
      authentication_contract_id: StableContractIdV1;
      session_name: SessionNameV1;
    }
  | {
      kind: 'authentication_not_declared';
      package_id: PackageIdV1;
    }
  | {
      kind: 'authentication_contract_selection_required' | 'authentication_contract_not_found';
      package_id: PackageIdV1;
      authentication_contract_ids: readonly StableContractIdV1[];
    }
  | {
      kind: 'session_in_use' | 'local_state_invalid';
      package_id: PackageIdV1;
      authentication_contract_id: StableContractIdV1;
      session_name: SessionNameV1;
    };

/** Clears one exact locally encrypted session without touching package state. */
export class ConsumerSessionServiceV1 {
  private readonly resolver: InstalledPackageResolverV1;
  private readonly sessions: SessionStoreV1;

  constructor(store: PackageStoreV1, runtimeVersion: string) {
    this.resolver = new InstalledPackageResolverV1(store, runtimeVersion);
    this.sessions = new SessionStoreV1(store.paths.home);
  }

  clear(input: ClearPackageSessionInputV1): ClearPackageSessionResultV1 {
    const packageId = parsePackageId(input.package_id, 'clear_session.package_id');
    const sessionName = parseSessionName(
      input.session_name ?? 'default',
      'clear_session.session_name',
    );
    const resolved = this.resolver.resolvePackage(packageId);
    const authenticationContractIds = Object.keys(resolved.package.authentication_contracts).sort(
      compareText,
    ) as StableContractIdV1[];
    const selected = selectAuthenticationContract(
      packageId,
      authenticationContractIds,
      input.authentication_contract_id,
    );
    if (selected.kind !== 'selected') return selected;
    const target: SessionTargetV1 = {
      package_id: packageId,
      authentication_contract_id: selected.authentication_contract_id,
      session_name: sessionName,
    };
    try {
      return this.sessions.clear(target)
        ? { kind: 'session_cleared', ...target }
        : { kind: 'session_not_found', ...target };
    } catch (error) {
      if (error instanceof SessionStoreError) {
        return {
          kind: error.code === 'session_in_use' ? 'session_in_use' : 'local_state_invalid',
          ...target,
        };
      }
      throw error;
    }
  }
}

export function selectAuthenticationContract(
  packageId: PackageIdV1,
  authenticationContractIds: readonly StableContractIdV1[],
  requested: StableContractIdV1 | string | undefined,
): AuthenticationContractSelectionV1 {
  if (requested !== undefined) {
    const selected = parseStableContractId(requested, 'clear_session.authentication_contract_id');
    if (authenticationContractIds.includes(selected)) {
      return { kind: 'selected', authentication_contract_id: selected };
    }
    return {
      kind: 'authentication_contract_not_found',
      package_id: packageId,
      authentication_contract_ids: authenticationContractIds,
    };
  }
  if (authenticationContractIds.length === 0) {
    return { kind: 'authentication_not_declared', package_id: packageId };
  }
  if (authenticationContractIds.length !== 1) {
    return {
      kind: 'authentication_contract_selection_required',
      package_id: packageId,
      authentication_contract_ids: authenticationContractIds,
    };
  }
  return {
    kind: 'selected',
    authentication_contract_id: authenticationContractIds[0] as StableContractIdV1,
  };
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
