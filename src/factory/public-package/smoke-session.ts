import type { PublicAuthenticationContractV1 } from '../../public/contracts/authentication';
import type { JsonValueV1 } from '../../public/contracts/json';
import type { PublicReadCapabilityV1, PublicToolPackageV1 } from '../../public/contracts/package';
import type { StableContractIdV1 } from '../../public/contracts/common';
import type { PublicCallResultV1 } from '../../consumer/call';
import { OriginSchedulerV1 } from '../../consumer/execution/origin-scheduler';
import { openPublicLoginBrowser } from '../../consumer/execution/public-browser/login-browser';

export type SmokeSessionV1 =
  | { kind: 'session'; state: JsonValueV1 }
  | { kind: 'unavailable'; reason: string };

export interface SmokeRealmV1 {
  contract: PublicAuthenticationContractV1;
  check_capability: PublicReadCapabilityV1;
}

export type SmokeSessionProviderV1 = (realm: SmokeRealmV1) => Promise<SmokeSessionV1>;

/** The realm whose session the exporter can establish by itself for a
 *  capability — one whose contract carries a grant — with the capability that
 *  checks it; null when the capability declares no realm or a user must act. */
export function consentRealm(
  toolPackage: PublicToolPackageV1,
  capability: PublicReadCapabilityV1,
): SmokeRealmV1 | null {
  if (capability.authentication.mode === 'none') return null;
  const contract =
    toolPackage.authentication_contracts[capability.authentication.authentication_contract_id];
  if (contract === undefined || contract.grant === null) return null;
  const checkCapability = toolPackage.capabilities[contract.check.capability];
  if (checkCapability === undefined) return null;
  return { contract, check_capability: checkCapability };
}

/** Establishes a consent realm's session the way a consumer's first call does:
 *  the grant runs in a headless kernel browser and the realm's check must land
 *  on an authenticated outcome. */
export async function smokeSession(realm: SmokeRealmV1): Promise<SmokeSessionV1> {
  try {
    const browser = await openPublicLoginBrowser({
      contract: realm.contract,
      check_capability: realm.check_capability,
      scheduler: new OriginSchedulerV1(),
    });
    try {
      const completed = await browser.completeCheck();
      const result = completed.result;
      if (
        result.kind === 'outcome' &&
        result.outcome_class === 'success' &&
        realm.contract.check.authenticated_outcome_ids.includes(result.outcome_id)
      ) {
        return { kind: 'session', state: completed.state };
      }
      return { kind: 'unavailable', reason: `realm check ended in ${describeCheck(result)}` };
    } finally {
      await browser.close();
    }
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** One session per realm across every fixture of an export. */
export class SmokeRealmsV1 {
  private readonly sessions = new Map<StableContractIdV1, Promise<SmokeSessionV1>>();

  constructor(private readonly provider: SmokeSessionProviderV1) {}

  session(contractId: StableContractIdV1, realm: SmokeRealmV1): Promise<SmokeSessionV1> {
    let pending = this.sessions.get(contractId);
    if (pending === undefined) {
      pending = this.provider(realm);
      this.sessions.set(contractId, pending);
    }
    return pending;
  }
}

function describeCheck(result: PublicCallResultV1): string {
  if (result.kind === 'outcome') return `outcome ${result.outcome_id}`;
  if (result.kind === 'failure') return `failure ${result.code}`;
  return result.kind;
}
