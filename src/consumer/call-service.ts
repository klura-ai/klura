import type {
  CapabilityIdV1,
  PackageIdV1,
  PackageVersionV1,
  SessionNameV1,
  Sha256DigestV1,
} from '../public/contracts/common';
import type { JsonValueV1 } from '../public/contracts/json';
import {
  calculateAuthenticationContractDigest,
  type PublicAuthenticationContractV1,
} from '../public/contracts/authentication';
import { PublicCallerV1, type PublicCallOptionsV1, type PublicCallResultV1 } from './call';
import { getConsumerOriginScheduler } from './execution/shared-scheduler';
import { InstalledPackageResolverV1 } from './installed-package';
import type { ConsumerLoginServiceV1 } from './login-service';
import { SessionStoreError, SessionStoreV1 } from './sessions/store';
import { PackageStoreV1 } from './store/package-store';

export interface CallInstalledCapabilityOptionsV1 extends Omit<
  PublicCallOptionsV1,
  'browser_storage_state'
> {
  session_name?: SessionNameV1 | string;
}

export interface CallInstalledCapabilityInputV1 {
  package_id: PackageIdV1 | string;
  capability: CapabilityIdV1 | string;
  input: JsonValueV1;
  options?: CallInstalledCapabilityOptionsV1;
}

export interface CallInstalledCapabilityResultV1 {
  package_id: PackageIdV1;
  version: PackageVersionV1;
  package_digest: Sha256DigestV1;
  capability: CapabilityIdV1;
  result: PublicCallResultV1;
}

/** Executes one capability from the immutable artifact selected by installed.json. */
export class ConsumerCallServiceV1 {
  private readonly resolver: InstalledPackageResolverV1;
  private readonly scheduler: ReturnType<typeof getConsumerOriginScheduler>;
  private readonly sessions: SessionStoreV1;

  constructor(
    store: PackageStoreV1,
    runtimeVersion: PackageVersionV1 | string,
    private readonly caller = new PublicCallerV1(),
    /** Establishes a consent realm's session on demand; without it a call to
     *  such a capability runs cookie-less unless a session is named. */
    private readonly logins: ConsumerLoginServiceV1 | null = null,
  ) {
    this.resolver = new InstalledPackageResolverV1(store, runtimeVersion);
    this.scheduler = getConsumerOriginScheduler(store.paths.home);
    this.sessions = new SessionStoreV1(store.paths.home);
  }

  async call(input: CallInstalledCapabilityInputV1): Promise<CallInstalledCapabilityResultV1> {
    const resolved = this.resolver.resolveCapability(input.package_id, input.capability);
    const result = await this.callResolvedCapability(resolved, input.input, input.options ?? {});
    return {
      package_id: resolved.installed.package_id,
      version: resolved.installed.version,
      package_digest: resolved.installed.package_digest,
      capability: resolved.capability_id,
      result,
    };
  }

  private async callResolvedCapability(
    resolved: ReturnType<InstalledPackageResolverV1['resolveCapability']>,
    input: JsonValueV1,
    options: CallInstalledCapabilityOptionsV1,
  ): Promise<PublicCallResultV1> {
    const { session_name: namedSession, ...callOptions } = options;
    const authentication = resolved.capability.authentication;
    if (authentication.mode === 'none') {
      if (namedSession !== undefined) {
        return { kind: 'failure', code: 'session_invalid', attempts: 0 };
      }
      return await this.caller.call(resolved.capability, input, {
        ...callOptions,
        scheduler: this.scheduler,
      });
    }
    const contractId = authentication.authentication_contract_id;
    const authenticationContract = resolved.package.authentication_contracts[contractId];
    // A consent realm needs nothing from the user, so a call that names no
    // session runs under the realm's own session, established on first use.
    const implicit =
      namedSession === undefined &&
      authenticationContract !== undefined &&
      authenticationContract.grant !== null &&
      this.logins !== null;
    const sessionName = implicit ? contractId : namedSession;
    if (sessionName === undefined) {
      if (authentication.mode === 'required') {
        return { kind: 'failure', code: 'session_required', attempts: 0 };
      }
      return await this.caller.call(resolved.capability, input, {
        ...callOptions,
        scheduler: this.scheduler,
      });
    }
    if (authenticationContract === undefined) {
      return { kind: 'failure', code: 'session_invalid', attempts: 0 };
    }
    const realm = {
      package_id: resolved.installed.package_id,
      authentication_contract_id: contractId,
      session_name: sessionName,
    };
    let session = this.readSession(realm, authenticationContract);
    if (implicit && session.kind === 'failure') {
      const established = await this.establish(realm);
      if (established !== null) return established;
      session = this.readSession(realm, authenticationContract);
    }
    if (session.kind === 'failure') return session;
    const checkCapability = resolved.package.capabilities[authenticationContract.check.capability];
    if (checkCapability === undefined) {
      return { kind: 'failure', code: 'session_invalid', attempts: 0 };
    }
    const check = await this.caller.call(checkCapability, authenticationContract.check.input, {
      ...callOptions,
      scheduler: this.scheduler,
      browser_storage_state: session.state,
    });
    if (check.kind === 'failure') return check;
    if (
      check.kind !== 'outcome' ||
      check.outcome_class !== 'success' ||
      !authenticationContract.check.authenticated_outcome_ids.includes(check.outcome_id)
    ) {
      return { kind: 'failure', code: 'session_invalid', attempts: check.attempts };
    }
    return await this.caller.call(resolved.capability, input, {
      ...callOptions,
      scheduler: this.scheduler,
      browser_storage_state: session.state,
    });
  }

  private readSession(
    realm: { package_id: PackageIdV1; authentication_contract_id: string; session_name: string },
    contract: PublicAuthenticationContractV1,
  ): { kind: 'session'; state: JsonValueV1 } | Extract<PublicCallResultV1, { kind: 'failure' }> {
    let localSession;
    try {
      localSession = this.sessions.read(realm);
    } catch (error) {
      if (error instanceof SessionStoreError) {
        return {
          kind: 'failure',
          code: error.code === 'session_not_found' ? 'session_required' : 'session_invalid',
          attempts: 0,
        };
      }
      throw error;
    }
    if (
      localSession.pointer.authentication_contract_digest !==
      calculateAuthenticationContractDigest(contract)
    ) {
      return { kind: 'failure', code: 'session_invalid', attempts: 0 };
    }
    return { kind: 'session', state: localSession.state };
  }

  /** Runs the realm's consent grant and stores its session; null on success,
   *  otherwise the failure the call reports in its place. */
  private async establish(realm: {
    package_id: PackageIdV1;
    authentication_contract_id: string;
    session_name: string;
  }): Promise<Extract<PublicCallResultV1, { kind: 'failure' }> | null> {
    if (this.logins === null) return { kind: 'failure', code: 'session_required', attempts: 0 };
    const opened = await this.logins.open(realm);
    if (opened.kind === 'login_completed') return null;
    const detail = opened.kind === 'login_unavailable' ? `: ${opened.reason}` : '';
    return {
      kind: 'failure',
      code: opened.kind === 'login_check_failed' ? 'session_invalid' : 'session_required',
      attempts: 0,
      reason: `consent session could not be established (${opened.kind})${detail}`,
    };
  }
}
