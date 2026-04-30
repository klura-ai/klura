import type { Session } from '../drivers/types/session';
import { resolveVariables } from './vars';
import type { Locators, RecordedPathStep } from './types';

const OPTIONAL_STEP_PROBE_TIMEOUT_MS = 1000;
// Brief grace window before failing a popup-pinned step. `context.on('page')`
// fires synchronously from the click that triggered window.open, but the
// popup's url/title observation finishes on a follow-up microtask. The
// previous step's `await` already returned by the time replay reaches a
// sub-page step, so this margin only matters in pathological cases — keep
// it small so dead-popup misses surface fast.
const POPUP_OPEN_WAIT_MS = 1500;

function buildA11ySelector(a11y: { role: string; name?: string }): string {
  let selector = `role=${a11y.role}`;
  if (a11y.name) {
    selector += `[name="${a11y.name}"]`;
  }
  return selector;
}

export function candidateLocatorSelectors(locators: Locators | undefined): string[] {
  if (!locators) throw new Error('No locators provided');
  const candidates: string[] = [];
  if (locators.a11y) candidates.push(buildA11ySelector(locators.a11y));
  if (locators.css) candidates.push(locators.css);
  if (locators.alternatives) {
    for (const alt of locators.alternatives) {
      if (alt.a11y) candidates.push(buildA11ySelector(alt.a11y));
      if (alt.css) candidates.push(alt.css);
    }
  }
  if (candidates.length === 0) throw new Error('No compatible locator found');
  return candidates;
}

async function withLocatorFallback<T>(
  locators: Locators | undefined,
  fn: (selector: string) => Promise<T>,
): Promise<T> {
  const candidates = candidateLocatorSelectors(locators);
  let lastErr: unknown;
  for (const sel of candidates) {
    try {
      return await fn(sel);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function probeOptionalLocator(
  driver: RecordedStepDriverLike,
  session: Session,
  locators: Locators | undefined,
  pageOpts?: { page?: string },
): Promise<string | null> {
  const candidates = candidateLocatorSelectors(locators);
  for (const sel of candidates) {
    try {
      await driver.waitForSelector(session, sel, {
        timeout: OPTIONAL_STEP_PROBE_TIMEOUT_MS,
        ...(pageOpts ?? {}),
      });
      return sel;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Resolve a step's `page` field to driver opts. Returns `undefined` when the
 * step targets `"main"` (default), letting downstream calls keep their
 * historical single-page shape. For popup-pinned steps, waits briefly for
 * the popup to appear in `session.subPages` — handles the race where a
 * prior step triggered window.open but `context.on('page')` hasn't fired
 * yet. Throws when the popup never shows up or already closed; the step
 * loop in executeRecordedPath catches and routes a `recorded_step_failed`
 * checkpoint.
 */
async function resolveStepPageOpts(
  session: Session,
  pageHandle: string | undefined,
): Promise<{ page?: string } | undefined> {
  if (!pageHandle || pageHandle === 'main') return undefined;
  const deadline = Date.now() + POPUP_OPEN_WAIT_MS;
  while (Date.now() < deadline) {
    const entry = (session.subPages ?? []).find((p) => p.id === pageHandle);
    if (entry && entry.closedAt === undefined) return { page: pageHandle };
    if (entry && entry.closedAt !== undefined) {
      throw new Error(
        `recorded_step_failed: step pinned to ${JSON.stringify(pageHandle)} but that popup ` +
          `closed at ${entry.closedAt} before the step ran. Discovery captured a flow that ` +
          `closes the popup earlier than this step expects — re-discover, or split the flow ` +
          `so the popup interaction completes before it closes.`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const open = (session.subPages ?? []).filter((p) => p.closedAt === undefined).map((p) => p.id);
  throw new Error(
    `recorded_step_failed: step pinned to ${JSON.stringify(pageHandle)} but no such popup ` +
      `is open after waiting ${POPUP_OPEN_WAIT_MS}ms. The previous step was supposed to ` +
      `trigger window.open() / target=_blank for this handle. Open popups: [${open.join(', ') || '<none>'}]. ` +
      `Likely cause: discovery captured a popup that the warm-replay click no longer triggers ` +
      `(redirect inlined, popup-blocker engaged, target removed). Re-discover or patch the step.`,
  );
}

export async function runResolvedRecordedStep(
  driver: RecordedStepDriverLike,
  session: Session,
  resolved: RecordedPathStep,
): Promise<void> {
  const isOptional = resolved.optional === true;
  // Resolve the step's page opt up front so a popup-pinned step that targets
  // a popup that never opened fails before any selector resolution work
  // happens. `pageOpts` is undefined for `"main"` (default) so we don't
  // disturb the historical single-page argv shape on driver calls.
  const pageOpts = await resolveStepPageOpts(session, resolved.page);
  switch (resolved.action) {
    case 'navigate':
      if (resolved.url) {
        // Top-level navigation always targets main — popups change URL by
        // clicking links inside themselves, not by being driven through a
        // top-level navigate tool. `pageOpts` is intentionally not threaded.
        await driver.navigate(session, resolved.url);
      }
      return;

    case 'click': {
      const locs =
        resolved.locators ?? (resolved.selector ? { css: resolved.selector } : undefined);
      if (isOptional) {
        const found = await probeOptionalLocator(driver, session, locs, pageOpts);
        if (!found) return;
        await driver.click(session, found, pageOpts);
        return;
      }
      await withLocatorFallback(locs, (sel) => driver.click(session, sel, pageOpts));
      return;
    }

    case 'type': {
      const locs =
        resolved.locators ?? (resolved.selector ? { css: resolved.selector } : undefined);
      const value = resolved.value;
      if (!value) return;
      if (isOptional) {
        const found = await probeOptionalLocator(driver, session, locs, pageOpts);
        if (!found) return;
        await driver.type(session, found, value, pageOpts);
        return;
      }
      await withLocatorFallback(locs, (sel) => driver.type(session, sel, value, pageOpts));
      return;
    }

    case 'fill_editor': {
      const locs =
        resolved.locators ?? (resolved.selector ? { css: resolved.selector } : undefined);
      const value = resolved.value;
      if (!value) return;
      if (isOptional) {
        const found = await probeOptionalLocator(driver, session, locs, pageOpts);
        if (!found) return;
        await driver.fillEditor(session, found, value, pageOpts);
        return;
      }
      await withLocatorFallback(locs, (sel) => driver.fillEditor(session, sel, value, pageOpts));
      return;
    }

    case 'select': {
      const locs =
        resolved.locators ?? (resolved.selector ? { css: resolved.selector } : undefined);
      const value = resolved.value;
      if (!value) return;
      if (isOptional) {
        const found = await probeOptionalLocator(driver, session, locs, pageOpts);
        if (!found) return;
        await driver.select(session, found, value, pageOpts);
        return;
      }
      await withLocatorFallback(locs, (sel) => driver.select(session, sel, value, pageOpts));
      return;
    }

    case 'wait':
      if (resolved.condition === 'navigation') {
        await driver.waitForNavigation(session, { timeout: resolved.timeout ?? 5000 });
      } else if (resolved.condition === 'selector' && resolved.waitSelector) {
        await driver.waitForSelector(session, resolved.waitSelector, {
          timeout: resolved.timeout ?? 5000,
          ...(pageOpts ?? {}),
        });
      } else {
        await driver.delay(session, resolved.timeout ?? 1000);
      }
      return;

    case 'key_press': {
      const key = resolved.key ?? resolved.value;
      if (key) {
        await driver.keyPress(session, key, pageOpts);
      }
      return;
    }

    default:
      throw new Error(`Unknown action: ${String(resolved.action)}`);
  }
}

export async function runInlineRecordedSteps(
  driver: RecordedStepDriverLike,
  session: Session,
  steps: RecordedPathStep[],
  args: Record<string, unknown>,
  interStepDelayMs: number,
): Promise<void> {
  for (const step of steps) {
    const resolved = resolveVariables(step, args);
    try {
      await runResolvedRecordedStep(driver, session, resolved);
    } catch (err) {
      if (resolved.optional === true) {
        await driver.delay(session, 100);
        continue;
      }
      throw err;
    }
    await driver.delay(session, interStepDelayMs);
  }
}

interface RecordedStepDriverLike {
  navigate(session: Session, url: string, opts?: { waitUntil?: 'domcontentloaded' }): Promise<void>;
  click(
    session: Session,
    selector: string,
    opts?: { page?: string },
  ): Promise<{ name?: string } | undefined>;
  type(
    session: Session,
    selector: string,
    value: string,
    opts?: { page?: string; replace?: boolean },
  ): Promise<void>;
  fillEditor(
    session: Session,
    selector: string,
    value: string,
    opts?: { page?: string },
  ): Promise<void>;
  select(
    session: Session,
    selector: string,
    value: string,
    opts?: { page?: string },
  ): Promise<void>;
  waitForNavigation(session: Session, opts: { timeout: number }): Promise<void>;
  waitForSelector(
    session: Session,
    selector: string,
    opts: { timeout: number; page?: string },
  ): Promise<void>;
  delay(session: Session, ms: number): Promise<void>;
  keyPress(session: Session, key: string, opts?: { page?: string }): Promise<void>;
  findByRoleTolerant(
    session: Session,
    role: string,
    name: string | undefined,
    nameMatch: 'substring' | 'any',
    opts?: { page?: string },
  ): Promise<{ accessibleName: string | null } | null>;
}
