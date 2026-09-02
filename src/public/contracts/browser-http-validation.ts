import { PublicContractError } from './common';
import type { PublicHttpStrategyV1 } from './package';
import {
  matchBrowserEgressRule,
  type BrowserResourcePolicyV1,
} from '../../consumer/execution/public-browser/resource-policy';

export function validateBrowserHttpStrategy(
  strategy: PublicHttpStrategyV1,
  navigationOrigins: readonly string[],
  policy: BrowserResourcePolicyV1,
  field: string,
): void {
  const baseOrigin = strategy.request.base_url;
  if (!navigationOrigins.includes(baseOrigin)) {
    throw new PublicContractError(
      `${field}.navigation_origins`,
      `must contain ${JSON.stringify(baseOrigin)} for browser-context HTTP`,
    );
  }
  if (
    matchBrowserEgressRule(policy, {
      phase: 'navigation',
      url: `${baseOrigin}/`,
      method: 'GET',
      resource_type: 'document',
    }) === null
  ) {
    throw new PublicContractError(
      `${field}.browser_resources.egress_rules`,
      'must admit the browser-context HTTP bootstrap navigation',
    );
  }
  const runtimeRule = policy.egress_rules.some(
    (rule) =>
      rule.phase === 'runtime_request' &&
      rule.origin === baseOrigin &&
      rule.methods.includes(strategy.request.method) &&
      rule.resource_types.includes('fetch'),
  );
  if (!runtimeRule) {
    throw new PublicContractError(
      `${field}.browser_resources.egress_rules`,
      'must admit the browser-context HTTP request method and origin',
    );
  }
}
