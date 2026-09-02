import type { Page } from 'playwright';
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
  const selectors = new Set<string>();
  for (const outcome of capability.outcomes) {
    for (const outcomeCase of outcome.cases) {
      if (!outcomeCase.strategy_ids.includes(strategy.strategy_id)) continue;
      collectOutcomeSelectors(outcomeCase.matcher, selectors);
    }
  }
  const matches = new Map<string, boolean>();
  for (const selector of selectors)
    matches.set(selector, (await page.locator(selector).count()) > 0);
  return matches;
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
