import { randomUUID } from 'node:crypto';
import {
  calculateAuthenticationContractDigest,
  type PublicAuthenticationContractV1,
} from '../public/contracts/authentication';
import {
  parsePackageId,
  parseSessionName,
  parseStableContractId,
  parseString,
  PublicContractError,
  type PackageIdV1,
  type SessionNameV1,
  type StableContractIdV1,
} from '../public/contracts/common';
import type { PublicReadCapabilityV1 } from '../public/contracts/package';
import type { JsonValueV1 } from '../public/contracts/json';
import type { PublicCallResultV1 } from './call';
import { getConsumerOriginScheduler } from './execution/shared-scheduler';
import {
  openPublicLoginBrowser,
  type PublicLoginBrowserV1,
} from './execution/public-browser/login-browser';
import { InstalledPackageResolverV1 } from './installed-package';
import {
  selectAuthenticationContract,
  type AuthenticationContractSelectionV1,
} from './session-service';
import { SessionStoreError, SessionStoreV1, type LocalSessionPointerV1 } from './sessions/store';
import { PackageStoreV1 } from './store/package-store';

const MAX_REMEMBERED_LOGIN_CLOSURES_V1 = 100;

export interface OpenPackageLoginInputV1 {
  package_id: PackageIdV1 | string;
  authentication_contract_id?: StableContractIdV1 | string;
  session_name?: SessionNameV1 | string;
}

export interface CompletePackageLoginInputV1 {
  interaction_id: string;
}

export interface ConsumerLoginServiceDependenciesV1 {
  open_browser?: (input: {
    contract: PublicAuthenticationContractV1;
    check_capability: PublicReadCapabilityV1;
    scheduler: ReturnType<typeof getConsumerOriginScheduler>;
  }) => Promise<PublicLoginBrowserV1>;
}

interface LoginSelectionV1 {
  package_id: PackageIdV1;
  authentication_contract_id: StableContractIdV1;
  session_name: SessionNameV1;
  contract: PublicAuthenticationContractV1;
  check_capability: PublicReadCapabilityV1;
}

interface ActiveLoginInteractionV1 extends LoginSelectionV1 {
  interaction_id: string;
  browser: PublicLoginBrowserV1;
  expiry: NodeJS.Timeout;
}

type LoginSelectionFailureV1 = Exclude<AuthenticationContractSelectionV1, { kind: 'selected' }>;

export type OpenPackageLoginResultV1 =
  | {
      kind: 'login_opened';
      package_id: PackageIdV1;
      authentication_contract_id: StableContractIdV1;
      session_name: SessionNameV1;
      interaction_id: string;
    }
  | LoginSelectionFailureV1
  | {
      kind: 'login_unavailable';
      package_id: PackageIdV1;
      authentication_contract_id: StableContractIdV1;
      session_name: SessionNameV1;
    };

export type CompletePackageLoginResultV1 =
  | {
      kind: 'login_completed';
      package_id: PackageIdV1;
      authentication_contract_id: StableContractIdV1;
      session_name: SessionNameV1;
      generation: number;
      state_digest: string;
    }
  | {
      kind: 'login_not_found' | 'login_expired' | 'login_closed';
      interaction_id: string;
    }
  | {
      kind: 'login_check_failed';
      package_id: PackageIdV1;
      authentication_contract_id: StableContractIdV1;
      session_name: SessionNameV1;
      check: LoginCheckResultV1;
    }
  | {
      kind: 'session_in_use' | 'local_state_invalid';
      package_id: PackageIdV1;
      authentication_contract_id: StableContractIdV1;
      session_name: SessionNameV1;
    };

export type LoginCheckResultV1 =
  | { kind: 'outcome'; outcome_id: StableContractIdV1; outcome_class: 'success' }
  | { kind: 'failure'; code: Extract<PublicCallResultV1, { kind: 'failure' }>['code'] };

/** Owns bounded, user-visible local login interactions and immutable session commits. */
export class ConsumerLoginServiceV1 {
  private readonly resolver: InstalledPackageResolverV1;
  private readonly sessions: SessionStoreV1;
  private readonly scheduler: ReturnType<typeof getConsumerOriginScheduler>;
  private readonly active = new Map<string, ActiveLoginInteractionV1>();
  private readonly closed = new Map<string, 'expired' | 'closed'>();

  constructor(
    store: PackageStoreV1,
    runtimeVersion: string,
    dependencies: ConsumerLoginServiceDependenciesV1 = {},
  ) {
    this.resolver = new InstalledPackageResolverV1(store, runtimeVersion);
    this.sessions = new SessionStoreV1(store.paths.home);
    this.scheduler = getConsumerOriginScheduler(store.paths.home);
    this.openBrowser = dependencies.open_browser ?? openPublicLoginBrowser;
  }

  async open(input: OpenPackageLoginInputV1): Promise<OpenPackageLoginResultV1> {
    const selection = this.select(input);
    if ('kind' in selection) return selection;
    try {
      const browser = await this.openBrowser({
        contract: selection.contract,
        check_capability: selection.check_capability,
        scheduler: this.scheduler,
      });
      const interactionId = `login_v1_${randomUUID().replaceAll('-', '')}`;
      const expiry = setTimeout(() => {
        void this.closeExpired(interactionId);
      }, selection.contract.browser_resources.total_timeout_ms);
      const active: ActiveLoginInteractionV1 = {
        ...selection,
        interaction_id: interactionId,
        browser,
        expiry,
      };
      this.active.set(interactionId, active);
      return {
        kind: 'login_opened',
        package_id: selection.package_id,
        authentication_contract_id: selection.authentication_contract_id,
        session_name: selection.session_name,
        interaction_id: interactionId,
      };
    } catch {
      return {
        kind: 'login_unavailable',
        package_id: selection.package_id,
        authentication_contract_id: selection.authentication_contract_id,
        session_name: selection.session_name,
      };
    }
  }

  async complete(input: CompletePackageLoginInputV1): Promise<CompletePackageLoginResultV1> {
    const interactionId = parseInteractionId(input.interaction_id);
    const active = this.active.get(interactionId);
    if (!active) return this.closedResult(interactionId);
    this.active.delete(interactionId);
    clearTimeout(active.expiry);
    try {
      active.browser.assertHealthy();
      const completed = await active.browser.completeCheck();
      const check = this.interpretCheck(active, completed.result);
      if (check.kind !== 'outcome') {
        return {
          kind: 'login_check_failed',
          package_id: active.package_id,
          authentication_contract_id: active.authentication_contract_id,
          session_name: active.session_name,
          check,
        };
      }
      const pointer = this.commit(active, completed.state);
      return completedResult(active, pointer);
    } catch (error) {
      if (error instanceof SessionStoreError) {
        return {
          kind: error.code === 'session_in_use' ? 'session_in_use' : 'local_state_invalid',
          package_id: active.package_id,
          authentication_contract_id: active.authentication_contract_id,
          session_name: active.session_name,
        };
      }
      this.rememberClosure(interactionId, 'closed');
      return { kind: 'login_closed', interaction_id: interactionId };
    } finally {
      await active.browser.close();
    }
  }

  async closeAll(): Promise<void> {
    const active = [...this.active.values()];
    this.active.clear();
    for (const interaction of active) {
      clearTimeout(interaction.expiry);
      this.rememberClosure(interaction.interaction_id, 'closed');
      await interaction.browser.close();
    }
  }

  private select(input: OpenPackageLoginInputV1): LoginSelectionV1 | LoginSelectionFailureV1 {
    const packageId = parsePackageId(input.package_id, 'open_login.package_id');
    const sessionName = parseSessionName(
      input.session_name ?? 'default',
      'open_login.session_name',
    );
    const resolved = this.resolver.resolvePackage(packageId);
    const ids = Object.keys(resolved.package.authentication_contracts).sort(
      compareText,
    ) as StableContractIdV1[];
    const requested =
      input.authentication_contract_id === undefined
        ? undefined
        : parseStableContractId(
            input.authentication_contract_id,
            'open_login.authentication_contract_id',
          );
    const selected = selectAuthenticationContract(packageId, ids, requested);
    if (selected.kind !== 'selected') return selected;
    const contract = resolved.package.authentication_contracts[selected.authentication_contract_id];
    if (contract === undefined) throw new Error('validated authentication contract is unavailable');
    const checkCapability = resolved.package.capabilities[contract.check.capability];
    if (checkCapability === undefined)
      throw new Error('validated login check capability is unavailable');
    return {
      package_id: packageId,
      authentication_contract_id: selected.authentication_contract_id,
      session_name: sessionName,
      contract,
      check_capability: checkCapability,
    };
  }

  private interpretCheck(
    active: ActiveLoginInteractionV1,
    result: PublicCallResultV1,
  ): LoginCheckResultV1 {
    if (
      result.kind === 'outcome' &&
      result.outcome_class === 'success' &&
      active.contract.check.authenticated_outcome_ids.includes(result.outcome_id)
    ) {
      return {
        kind: 'outcome',
        outcome_id: result.outcome_id,
        outcome_class: 'success',
      };
    }
    if (result.kind === 'failure') return { kind: 'failure', code: result.code };
    return { kind: 'failure', code: 'session_invalid' };
  }

  private commit(active: ActiveLoginInteractionV1, state: JsonValueV1): LocalSessionPointerV1 {
    return this.sessions.commit({
      package_id: active.package_id,
      authentication_contract_id: active.authentication_contract_id,
      session_name: active.session_name,
      authentication_contract_digest: calculateAuthenticationContractDigest(active.contract),
      state,
    });
  }

  private async closeExpired(interactionId: string): Promise<void> {
    const active = this.active.get(interactionId);
    if (!active) return;
    this.active.delete(interactionId);
    this.rememberClosure(interactionId, 'expired');
    await active.browser.close();
  }

  private closedResult(
    interactionId: string,
  ): Extract<
    CompletePackageLoginResultV1,
    { kind: 'login_not_found' | 'login_expired' | 'login_closed' }
  > {
    const closure = this.closed.get(interactionId);
    if (closure === 'expired') return { kind: 'login_expired', interaction_id: interactionId };
    if (closure === 'closed') return { kind: 'login_closed', interaction_id: interactionId };
    return { kind: 'login_not_found', interaction_id: interactionId };
  }

  private rememberClosure(interactionId: string, closure: 'expired' | 'closed'): void {
    this.closed.delete(interactionId);
    this.closed.set(interactionId, closure);
    if (this.closed.size <= MAX_REMEMBERED_LOGIN_CLOSURES_V1) return;
    const first = this.closed.keys().next().value;
    if (typeof first === 'string') this.closed.delete(first);
  }

  private readonly openBrowser: NonNullable<ConsumerLoginServiceDependenciesV1['open_browser']>;
}

function parseInteractionId(value: unknown): string {
  const interactionId = parseString(value, 'complete_login.interaction_id', 48);
  if (!/^login_v1_[0-9a-f]{32}$/.test(interactionId)) {
    throw new PublicContractError(
      'complete_login.interaction_id',
      'must be a canonical login interaction id',
    );
  }
  return interactionId;
}

function completedResult(
  active: ActiveLoginInteractionV1,
  pointer: LocalSessionPointerV1,
): Extract<CompletePackageLoginResultV1, { kind: 'login_completed' }> {
  return {
    kind: 'login_completed',
    package_id: active.package_id,
    authentication_contract_id: active.authentication_contract_id,
    session_name: active.session_name,
    generation: pointer.generation,
    state_digest: pointer.state_digest,
  };
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
