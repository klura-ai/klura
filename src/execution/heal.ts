import type { Session } from '../drivers/types/session';
import type { Locators } from './types';
import { parseSnapshotSelector } from './snapshot-selector';

/**
 * Warm-execute self-heal: when every captured locator candidate for a
 * recorded-path step has failed, try one in-process structural rescan before
 * the runtime emits the `recorded_step_failed` checkpoint to the session-
 * driving LLM.
 *
 * The rescan is conservative — it requires a UNIQUE role match against the
 * live page. Two layers, in order:
 *
 *  1. Same role + tolerant name match (Playwright `getByRole` with
 *     `exact: false`). Catches whitespace / case / extension drift the
 *     captured selector's matcher missed.
 *  2. Same role only (no name constraint). Catches semantic renames
 *     ("Submit" → "Send") on pages where the role identifies the element by
 *     itself. Uniqueness is the safety belt — if the page has multiple
 *     elements of the role, the layer skips and falls through.
 *
 * If both layers miss, returns `{ ok: false }` and the step loop emits the
 * existing checkpoint envelope unchanged. The agent (which IS an LLM) heals
 * via `patch_step` + `resume_execution` from there. No internal LLM call.
 */
export interface HealDriver {
  click(session: Session, selector: string, opts?: { page?: string }): Promise<unknown>;
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
  findByRoleTolerant(
    session: Session,
    role: string,
    name: string | undefined,
    nameMatch: 'substring' | 'any',
    opts?: { page?: string },
  ): Promise<{ accessibleName: string | null } | null>;
}

export type HealAction = 'click' | 'type' | 'fill_editor' | 'select';

export interface HealResult {
  ok: true;
  /** Locators object that should replace the step's existing locators (and be
   *  persisted via patchStep). Original primary a11y is preserved as the head
   *  of `alternatives` so subsequent calls still benefit from the cascade if
   *  the page drifts back. */
  patchedLocators: Locators;
  /** Which heal layer matched, for the response advisory. */
  layer: 'substring' | 'role-only';
}

export interface HealMiss {
  ok: false;
  reason: 'disabled' | 'unhealable_action' | 'no_role' | 'no_unique_match' | 'retry_failed';
}

const HEALABLE_ACTIONS: ReadonlySet<string> = new Set(['click', 'type', 'fill_editor', 'select']);

export function isHealableAction(action: string): action is HealAction {
  return HEALABLE_ACTIONS.has(action);
}

/**
 * Build a Playwright role= selector targeting the matched element by its live
 * accessible name. The driver's `resolveLocator` falls through to
 * `page.locator(selector).first()` for this format, and Playwright's role=
 * engine does substring + case-insensitive name matching by default — which is
 * exactly what we want, since the matched element survived `findByRoleTolerant`
 * with this name.
 */
function buildHealedSelector(role: string, accessibleName: string | null): string {
  if (accessibleName && accessibleName.length > 0) {
    const escaped = accessibleName.replace(/"/g, '\\"');
    return `role=${role}[name="${escaped}"]`;
  }
  return `role=${role}`;
}

function collectA11yCandidates(
  locators: Locators | undefined,
): Array<{ role: string; name?: string }> {
  if (!locators) return [];
  const out: Array<{ role: string; name?: string }> = [];
  if (locators.a11y) out.push(locators.a11y);
  if (locators.alternatives) {
    for (const alt of locators.alternatives) {
      if (alt.a11y) out.push(alt.a11y);
    }
  }
  // Fallback for css-only locators saved before the auto-synth started
  // emitting structured a11y entries: the agent's `<role> "<name>"`
  // snapshot string was dumped into `css`. Crack it back into structured
  // form so heal can do role-based rescan on existing saved strategies.
  if (out.length === 0) {
    const fromCss = parseSnapshotSelector(locators.css);
    if (fromCss) out.push(fromCss);
    if (locators.alternatives) {
      for (const alt of locators.alternatives) {
        const altParsed = parseSnapshotSelector(alt.css);
        if (altParsed) out.push(altParsed);
      }
    }
  }
  return out;
}

function uniqueRoles(candidates: Array<{ role: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (!seen.has(c.role)) {
      seen.add(c.role);
      out.push(c.role);
    }
  }
  return out;
}

async function retryAction(
  driver: HealDriver,
  session: Session,
  action: HealAction,
  selector: string,
  value: string | undefined,
  pageOpts: { page?: string } | undefined,
): Promise<boolean> {
  try {
    switch (action) {
      case 'click':
        await driver.click(session, selector, pageOpts);
        return true;
      case 'type':
        if (value === undefined) return false;
        await driver.type(session, selector, value, pageOpts);
        return true;
      case 'fill_editor':
        if (value === undefined) return false;
        await driver.fillEditor(session, selector, value, pageOpts);
        return true;
      case 'select':
        if (value === undefined) return false;
        await driver.select(session, selector, value, pageOpts);
        return true;
    }
  } catch {
    return false;
  }
}

function buildPatchedLocators(
  staticLocators: Locators | undefined,
  role: string,
  liveName: string | null,
): Locators {
  const old = staticLocators ?? {};
  const oldPrimary = old.a11y;
  const oldAlternatives = old.alternatives ?? [];
  const demoted: Array<{ a11y?: { role: string; name?: string }; css?: string }> = oldPrimary
    ? [{ a11y: oldPrimary }, ...oldAlternatives]
    : [...oldAlternatives];
  const patched: Locators = {
    a11y: liveName ? { role, name: liveName } : { role },
    ...(old.css ? { css: old.css } : {}),
    ...(demoted.length > 0 ? { alternatives: demoted } : {}),
  };
  return patched;
}

export interface HealInput {
  /** The step's STATIC locators — read from the on-disk strategy before
   *  variable interpolation. Used to drive the rescan AND to build the
   *  persisted patch (so {{placeholders}} that survive in locator names are
   *  preserved on disk). */
  staticLocators: Locators | undefined;
  /** Resolved action — same enum as `step.action`. */
  action: string;
  /** Resolved value (post-interpolation). Required for type / fill_editor /
   *  select retries; ignored by click. */
  value?: string;
}

export async function tryStructuralHeal(
  driver: HealDriver,
  session: Session,
  input: HealInput,
  pageOpts: { page?: string } | undefined,
  config: { structural: boolean },
): Promise<HealResult | HealMiss> {
  if (!config.structural) return { ok: false, reason: 'disabled' };
  if (!isHealableAction(input.action)) return { ok: false, reason: 'unhealable_action' };

  const candidates = collectA11yCandidates(input.staticLocators);
  if (candidates.length === 0) return { ok: false, reason: 'no_role' };

  const value = input.value;
  const action = input.action;

  // Layer 1: tolerant name match per (role, name) candidate.
  for (const cand of candidates) {
    if (!cand.name) continue;
    const probe = await driver
      .findByRoleTolerant(session, cand.role, cand.name, 'substring', pageOpts)
      .catch(() => null);
    if (!probe) continue;
    const liveName = probe.accessibleName;
    const selector = buildHealedSelector(cand.role, liveName);
    const ok = await retryAction(driver, session, action, selector, value, pageOpts);
    if (ok) {
      return {
        ok: true,
        patchedLocators: buildPatchedLocators(input.staticLocators, cand.role, liveName),
        layer: 'substring',
      };
    }
  }

  // Layer 2: role-only uniqueness, per unique role across all candidates.
  for (const role of uniqueRoles(candidates)) {
    const probe = await driver
      .findByRoleTolerant(session, role, undefined, 'any', pageOpts)
      .catch(() => null);
    if (!probe) continue;
    const liveName = probe.accessibleName;
    const selector = buildHealedSelector(role, liveName);
    const ok = await retryAction(driver, session, action, selector, value, pageOpts);
    if (ok) {
      return {
        ok: true,
        patchedLocators: buildPatchedLocators(input.staticLocators, role, liveName),
        layer: 'role-only',
      };
    }
  }

  return { ok: false, reason: 'no_unique_match' };
}
