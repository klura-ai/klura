import type { Page } from 'playwright';
import type { StableContractIdV1 } from '../../../public/contracts/common';
import type { StructuralMatcherV1 } from '../../../public/contracts/outcome';
import type {
  PublicBrowserPageScriptStrategyV1,
  PublicBrowserNavigationStrategyV1,
  PublicReadCapabilityV1,
} from '../../../public/contracts/package';

export async function evaluateOutcomeSelectors(
  page: Page,
  capability: PublicReadCapabilityV1,
  strategy: PublicBrowserNavigationStrategyV1 | PublicBrowserPageScriptStrategyV1,
): Promise<ReadonlyMap<string, boolean>> {
  const matches = new Map<string, boolean>();
  for (const selector of collectStrategyOutcomeSelectors(capability, strategy.strategy_id))
    matches.set(selector, (await page.locator(selector).count()) > 0);
  return matches;
}

/**
 * Collects every selector referenced by `html_selector_exists` matchers in the
 * capability's outcome cases bound to one strategy. Live executors evaluate
 * exactly this set against the page; the platform exporter records the same
 * evaluations into fixture evidence so replay resolves selector matchers
 * without a browser.
 */
export function collectStrategyOutcomeSelectors(
  capability: PublicReadCapabilityV1,
  strategyId: StableContractIdV1,
): ReadonlySet<string> {
  const selectors = new Set<string>();
  for (const outcome of capability.outcomes) {
    for (const outcomeCase of outcome.cases) {
      if (!outcomeCase.strategy_ids.includes(strategyId)) continue;
      collectOutcomeSelectors(outcomeCase.matcher, selectors);
    }
  }
  return selectors;
}

function collectOutcomeSelectors(matcher: StructuralMatcherV1, selectors: Set<string>): void {
  if (matcher.op === 'html_selector_exists') {
    selectors.add(matcher.selector);
    return;
  }
  if (matcher.op === 'all' || matcher.op === 'any') {
    for (const nested of matcher.items) collectOutcomeSelectors(nested, selectors);
    return;
  }
  if (matcher.op === 'not') collectOutcomeSelectors(matcher.item, selectors);
}
