// Deterministic step-id generator for non-LLM save paths (auto-synth on close).
// Hand-crafted saves require the agent to author ids consciously — the
// validator rejects missing ids on those paths.
//
// Heuristic priorities:
//   navigate → navigate_{slug(pathname) || "url"}
//   click    → click_{slug(locator.a11y.name)} || click_{slug(locator.css)} || click_target
//   type     → type_{slug(locator.a11y.name)} || type_{slug(locator.css)} || type_field
//   fill_editor → type_... (alias; the user-facing slot is the editor's name)
//   select   → select_{slug(locator.a11y.name)} || select_{slug(locator.css)} || select_field
//   wait     → wait_{condition || "timeout"}_{index}
//   key_press → key_{slug(key)} || key_press_{index}
//
// On collision with an id already emitted in the same strategy we append
// `_2`, `_3`, ... until unique. On empty slug (nothing to sluggify) we fall
// back to `{action}_{index}`.

import { isValidStepId } from './validate/recorded-path';

function slug(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+/, '')
      // eslint-disable-next-line sonarjs/slow-regex
      .replace(/_+$/, '')
      .slice(0, 30)
  );
}

function pickNameFromLocators(locators: unknown): string | undefined {
  if (!locators || typeof locators !== 'object') return undefined;
  const locs = locators as Record<string, unknown>;
  const a11y = locs.a11y;
  if (a11y && typeof a11y === 'object') {
    const name = (a11y as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  const css = locs.css;
  if (typeof css === 'string' && css.length > 0) return css;
  return undefined;
}

function pathnameSlug(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? slug(last) : '';
  } catch {
    return '';
  }
}

function baseIdForStep(step: Record<string, unknown>, index: number): string {
  const action = typeof step.action === 'string' ? step.action : `step`;
  switch (action) {
    case 'navigate': {
      const url = typeof step.url === 'string' ? step.url : '';
      const s = url ? pathnameSlug(url) : '';
      return s ? `navigate_${s}` : `navigate_${index}`;
    }
    case 'click': {
      const name = pickNameFromLocators(step.locators);
      const s = name ? slug(name) : '';
      return s ? `click_${s}` : `click_${index}`;
    }
    case 'type':
    case 'fill_editor': {
      const name = pickNameFromLocators(step.locators);
      const s = name ? slug(name) : '';
      return s ? `type_${s}` : `type_${index}`;
    }
    case 'select': {
      const name = pickNameFromLocators(step.locators);
      const s = name ? slug(name) : '';
      return s ? `select_${s}` : `select_${index}`;
    }
    case 'wait': {
      const cond = typeof step.condition === 'string' ? slug(step.condition) : 'timeout';
      return `wait_${cond || 'timeout'}_${index}`;
    }
    case 'key_press': {
      const key = typeof step.key === 'string' ? slug(step.key) : '';
      return key ? `key_${key}` : `key_press_${index}`;
    }
    default:
      return `${action}_${index}`;
  }
}

/**
 * Assign stable slug ids to every step that doesn't already have one. Mutates
 * the step objects in-place and returns the same array for convenience. Uses
 * the shape-validator's own regex as the acceptance gate — if a heuristic
 * produces something that wouldn't pass validation (too-short slug, numeric,
 * reserved word) we fall back to `{action}_{index}`.
 */
export function assignAutoStepIds(
  steps: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const used = new Set<string>();
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    if (!s || typeof s !== 'object') continue;
    const existing = (s as { id?: unknown }).id;
    if (typeof existing === 'string' && existing.length > 0) {
      used.add(existing);
    }
  }
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    if (!s || typeof s !== 'object') continue;
    if (typeof (s as { id?: unknown }).id === 'string' && (s as { id: string }).id.length > 0) {
      continue;
    }
    let base = baseIdForStep(s, i);
    if (!isValidStepId(base)) {
      const action = typeof s.action === 'string' ? s.action : 'step';
      base = `${action}_${i}`;
      if (!isValidStepId(base)) base = `step_${i}`;
    }
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    (s as { id: string }).id = candidate;
  }
  return steps;
}
