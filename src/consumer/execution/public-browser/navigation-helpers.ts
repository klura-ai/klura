import type { Page } from 'playwright';
import type { JsonValueV1 } from '../../../public/contracts/json';
import type {
  BrowserWaitV1,
  PublicBrowserNavigationStrategyV1,
} from '../../../public/contracts/package';
import {
  evaluateValueExpression,
  type ValueExpressionContextV1,
} from '../../../public/contracts/value-expression';
import { PublicHttpExecutionError } from '../node-http';

interface BrowserQuietBoundaryV1 {
  waitForQuiet(
    wait: Extract<BrowserWaitV1, { kind: 'network_quiet' }>,
    signal: AbortSignal,
  ): Promise<void>;
}

export function resolveNavigationUrl(
  strategy: Pick<PublicBrowserNavigationStrategyV1, 'url'>,
  input: JsonValueV1,
  bindings: Readonly<Record<string, JsonValueV1>>,
  navigationOrigins: readonly string[],
): string {
  const context: ValueExpressionContextV1 = { input, bindings };
  const value = evaluateValueExpression(strategy.url, context);
  if (typeof value !== 'string') {
    throw new PublicHttpExecutionError('invalid_request', 'browser URL must evaluate to a string');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicHttpExecutionError('invalid_request', 'browser URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !navigationOrigins.includes(url.origin)
  ) {
    throw new PublicHttpExecutionError(
      'request_blocked',
      'browser URL is outside its signed navigation origins',
    );
  }
  return url.toString();
}

export async function waitForBrowserStrategy(
  page: Page,
  boundary: BrowserQuietBoundaryV1,
  wait: BrowserWaitV1,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (wait.kind === 'dom_content_loaded') return;
  if (wait.kind === 'network_quiet') {
    await boundary.waitForQuiet(wait, signal);
    return;
  }
  await page
    .locator(wait.selector)
    .nth(wait.minimum_count - 1)
    .waitFor({
      state: wait.state,
      timeout: timeoutMs,
    });
}
