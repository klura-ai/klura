import type { BrowserDriver } from '../../drivers/interface';
import type { Session } from '../../drivers/types/session';
import { candidateLocatorSelectors } from '../../execution/step-runner';
import { resolveTemplate } from '../probe-helpers';

export interface RecordedPathStep {
  action: string;
  url?: string;
  selector?: string;
  locators?: {
    a11y?: { role: string; name?: string };
    css?: string;
    alternatives?: Array<{ a11y?: { role: string; name?: string }; css?: string }>;
  };
  value?: string;
  condition?: string;
  waitSelector?: string;
  timeout?: number;
}

function narrowStep(raw: unknown): RecordedPathStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.action !== 'string') return null;
  const step: RecordedPathStep = { action: s.action };
  if (typeof s.url === 'string') step.url = s.url;
  if (typeof s.selector === 'string') step.selector = s.selector;
  if (s.locators && typeof s.locators === 'object') {
    step.locators = s.locators as RecordedPathStep['locators'];
  }
  if (typeof s.value === 'string') step.value = s.value;
  if (typeof s.condition === 'string') step.condition = s.condition;
  if (typeof s.waitSelector === 'string') step.waitSelector = s.waitSelector;
  if (typeof s.timeout === 'number') step.timeout = s.timeout;
  return step;
}

export function extractRecordedPathSteps(data: Record<string, unknown>): RecordedPathStep[] {
  if (data.strategy !== 'recorded-path') return [];
  const steps = data.steps;
  if (!Array.isArray(steps)) return [];
  const out: RecordedPathStep[] = [];
  for (const raw of steps) {
    const step = narrowStep(raw);
    if (step) out.push(step);
  }
  return out;
}

// Pull `wsOpen.steps` off a protocol:"websocket" strategy so the probe can walk
// them with the same selector-verification logic recorded-path uses. Returns an
// empty array when the strategy doesn't carry a wsOpen step list (string forms
// 'navigate' / 'none' skip this path).
export function extractWsOpenSteps(data: Record<string, unknown>): RecordedPathStep[] {
  if (data.protocol !== 'websocket') return [];
  const wsOpen = data.wsOpen;
  if (!wsOpen || typeof wsOpen !== 'object' || Array.isArray(wsOpen)) return [];
  const steps = (wsOpen as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return [];
  const out: RecordedPathStep[] = [];
  for (const raw of steps) {
    const step = narrowStep(raw);
    if (step) out.push(step);
  }
  return out;
}

// Probe recorded-path steps in read-only mode. The rule: execute anything that
// doesn't mutate the page (navigate, wait-for-selector, delay), and for the
// first mutating action (click/type/select), verify its selector exists via
// waitForSelector but DO NOT perform the action. Stop probing after the first
// verified mutating step, because subsequent steps depend on state changes we
// deliberately skipped — we'd false-flag a valid strategy otherwise. This
// catches the common "agent invented the first selector" hallucination without
// replaying any side effects.
export async function probeRecordedPathSteps(
  driver: BrowserDriver,
  session: Session,
  steps: RecordedPathStep[],
  examples: Record<string, string>,
): Promise<void> {
  const SELECTOR_PROBE_TIMEOUT = 3000;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const where = `steps[${i}] (action: "${step.action}")`;

    switch (step.action) {
      case 'navigate': {
        if (!step.url) continue;
        const url = resolveTemplate(step.url, examples, `${where}.url`);
        try {
          await driver.navigate(session, url);
        } catch (err) {
          throw new Error(
            `invalid_strategy: ${where} failed save-time probe — ` +
              `could not navigate to ${url}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        break;
      }

      case 'wait': {
        // wait-for-navigation after a click we didn't perform would hang, so
        // skip it. wait-for-selector and delay are read-only and safe.
        if (step.condition === 'navigation') continue;
        if (step.condition === 'selector' && step.waitSelector) {
          try {
            await driver.waitForSelector(session, step.waitSelector, {
              timeout: Math.min(step.timeout ?? 5000, 5000),
            });
          } catch (err) {
            throw new Error(
              `invalid_strategy: ${where} failed save-time probe — ` +
                `wait-for-selector ${JSON.stringify(step.waitSelector)} did not resolve: ${
                  err instanceof Error ? err.message.split('\n')[0] : String(err)
                }. The agent likely guessed a selector that doesn't exist on the live page.`,
              { cause: err },
            );
          }
        } else {
          // Plain delay — safe, but cap at 2s during probe to keep saves fast.
          await driver.delay(session, Math.min(step.timeout ?? 1000, 2000));
        }
        break;
      }

      case 'click':
      case 'type':
      case 'select': {
        let selectors: string[] = [];
        if (typeof step.selector === 'string') {
          selectors = [step.selector];
        } else if (step.locators) {
          selectors = candidateLocatorSelectors(step.locators);
        }
        if (selectors.length === 0) {
          // Strategy has no css-fallback selector — can't probe without any
          // structural selector candidates. Fall through: the executor does
          // locator fallback at run time, not our job here.
          return;
        }
        let lastErr: unknown = null;
        let matched = false;
        for (const selector of selectors) {
          try {
            await driver.waitForSelector(session, selector, {
              timeout: SELECTOR_PROBE_TIMEOUT,
            });
            matched = true;
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (!matched) {
          const selectorPreview = selectors.join(' OR ');
          throw new Error(
            `invalid_strategy: ${where} failed save-time probe — ` +
              `none of the locator candidates resolved on the current page (${JSON.stringify(
                selectorPreview,
              )}): ${lastErr instanceof Error ? lastErr.message.split('\n')[0] : String(lastErr)}. ` +
              `The agent likely guessed this locator instead of verifying it against the live DOM. ` +
              `Re-discover by reading the actual page (a11y tree or screenshot) and use a selector that exists.`,
            { cause: lastErr ?? undefined },
          );
        }
        // Stop after verifying the first mutating selector. Subsequent steps
        // depend on state changes from this click/type/select, which we
        // deliberately did not perform — verifying them would false-flag
        // strategies that are actually correct.
        return;
      }

      default:
        // Unknown action — skills.ts shape validation doesn't enforce an enum
        // on step.action yet, and the executor throws on unknown at run time.
        // Stop probing rather than crash.
        return;
    }
  }
}
