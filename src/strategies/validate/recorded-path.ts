import { z } from 'zod';
import { didYouMeanSuffix } from '../../validators';
import { RECORDED_PATH_ACTIONS } from './constants';
import { isPlainObject } from './helpers';
import { recordedPathStepSchema } from '../schemas/recorded-path';
import { zodErrorToIssues } from '../schemas/zod-helpers';

// Step-id shape: snake_case, 3-40 chars, starts with letter. Reserved words
// block common training-prior names that would collide with other slots.
export const STEP_ID_REGEX = /^[a-z][a-z0-9_]{2,39}$/;
export const STEP_ID_RESERVED: ReadonlySet<string> = new Set([
  'id',
  'init',
  'end',
  'start',
  'finish',
  'step',
]);

// Zod schema for step id validation (semantic rules live here)
export const stepIdSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(
    STEP_ID_REGEX,
    'must match snake_case pattern (lowercase letters, digits, underscores; starts with a letter)',
  );

// Heuristic: 16+ character all-hex ids look like hashes / random digests.
// They structurally satisfy the slug regex but tell the reader nothing about
// what the step does — reject with a descriptive error so agents name the
// step by its intent.
export const STEP_ID_HEXISH_REGEX = /^[0-9a-f]{16,}$/;

// Zod schema for bare element locator detection (teaching-focused)
export const bareElementLocatorSchema = z
  .object({
    css: z.string(),
    a11y: z.unknown().optional(),
  })
  .loose();

export function isValidStepId(id: string): boolean {
  if (!STEP_ID_REGEX.test(id)) return false;
  if (STEP_ID_RESERVED.has(id)) return false;
  if (/^\d+$/.test(id)) return false;
  if (STEP_ID_HEXISH_REGEX.test(id)) return false;
  return true;
}

// Bare element-name tags that match too broadly to anchor a step on their own.
// When a locator is (or comma-list-contains) just one of these names with no
// id/class/attribute/combinator/pseudo qualifier, warm execute clicks the first
// matching node on the page — which will be the wrong one the moment the UI
// grows. Kept as a constant so new bare tags can be added without touching the
// detector.
export const BARE_ELEMENT_NAMES: ReadonlySet<string> = new Set([
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'form',
  'label',
  'div',
  'span',
  'li',
  'tr',
  'td',
  'th',
  'option',
  'img',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'nav',
  'main',
  'article',
  'section',
  'aside',
  'header',
  'footer',
  'ul',
  'ol',
]);

export type BareLocatorIssue =
  | { kind: 'bare-element'; fragment: string }
  | { kind: 'universal'; fragment: string }
  | { kind: 'attribute-only'; fragment: string };

/**
 * Scan a css locator string for over-broad fragments. Splits on top-level
 * commas (commas inside `[...]` or `(...)` are ignored so `a[href*=","]` or
 * `:is(a, button)` aren't mis-parsed). Returns the first offending fragment,
 * categorized, or null if every fragment carries some narrowing qualifier.
 */
export function detectBareElementLocator(css: string): BareLocatorIssue | null {
  const fragments = splitTopLevelCommas(css);
  for (const raw of fragments) {
    const frag = raw.trim();
    if (frag.length === 0) continue;
    if (frag === '*') {
      return { kind: 'universal', fragment: frag };
    }
    // Bare element-name: lowercase letters + digits only, no id/class/attr/
    // combinator/pseudo anywhere. Matches entries in BARE_ELEMENT_NAMES.
    if (/^[a-z][a-z0-9]*$/.test(frag) && BARE_ELEMENT_NAMES.has(frag)) {
      return { kind: 'bare-element', fragment: frag };
    }
    // Attribute-only (no leading element name): starts with `[` or `.` or `#`
    // is common. Reject ONLY the attribute-only case (`[type="submit"]`, chains
    // of `[...]`), because attribute selectors without an element qualifier
    // scan every tag on the page. `.classname` and `#id` alone are allowed —
    // scope stays tight per the task spec.
    if (/^\[/.test(frag)) {
      // Allow if an element name precedes (guarded by the first regex) — here
      // we know it starts with `[`, so any non-bracket content that isn't a
      // combinator means it's still a chain of brackets / pseudos, which is
      // attribute-only.
      // eslint-disable-next-line sonarjs/slow-regex
      const stripped = frag.replace(/\[[^\]]*\]/g, '').trim();
      // After removing all `[...]` chunks, if what remains is empty or only
      // pseudo-classes (`:hover`, `:nth-child(1)`), it's attribute-only with
      // no element qualifier — reject.
      if (stripped.length === 0 || /^:[a-z-]/.test(stripped)) {
        return { kind: 'attribute-only', fragment: frag };
      }
    }
  }
  return null;
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function a11yHasName(a11y: unknown): boolean {
  if (!isPlainObject(a11y)) return false;
  const name = a11y.name;
  return typeof name === 'string' && name.length > 0;
}

function checkLocatorCss(css: string, a11y: unknown, where: string): void {
  // a11y with a non-empty name anchors the element uniquely; the css is a
  // fallback and may be broad.
  if (a11yHasName(a11y)) return;
  const issue = detectBareElementLocator(css);
  if (!issue) return;
  if (issue.kind === 'attribute-only') {
    throw new Error(
      `invalid_strategy: ${where} locator ${JSON.stringify(css)} has no element qualifier ` +
        `(e.g. use "button[type=\\"submit\\"]" not "[type=\\"submit\\"]"). Bare attribute-only ` +
        `selectors match too broadly.`,
    );
  }
  const bare = issue.fragment;
  throw new Error(
    `invalid_strategy: ${where} locator has fragment "${bare}" (bare element-name matches every ` +
      `${bare} on the page, warm execute will click the wrong one if the page grows). Tighten the ` +
      `css with an id/attribute/text, or add an a11y locator: ` +
      `\`{"a11y": {"role": "button", "name": "<button label>"}}\`. Comma-list fallbacks to bare ` +
      `element-names are the usual culprit — remove the bare part.`,
  );
}

export interface RecordedPathStepShapeOpts {
  /** When false, the `id` field is not required on the step. Used for
   *  inline step arrays (wsOpen.steps) that aren't patchable and don't
   *  serve as partial-replay anchors. Top-level recorded-path.steps
   *  always requires id (the patch_step handle + discovered_at_step_id
   *  target live there). */
  requireId?: boolean;
}

export function validateRecordedPathStepShape(
  i: number,
  item: Record<string, unknown>,
  where = `recorded-path.steps[${i}]`,
  opts: RecordedPathStepShapeOpts = {},
): void {
  const parsed = recordedPathStepSchema.safeParse(item);
  if (!parsed.success) {
    const issues = zodErrorToIssues(parsed.error, where);
    const bullets = issues.map((issue) => `  - ${issue}`).join('\n');
    const issueLabel = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
    throw new Error(
      `invalid_strategy: ${where} has ${issueLabel} — fix all before retrying:\n${bullets}`,
    );
  }
  const { requireId = true } = opts;
  const action = item.action;
  if (typeof action !== 'string') {
    return;
  }

  if (!RECORDED_PATH_ACTIONS.includes(action as (typeof RECORDED_PATH_ACTIONS)[number])) {
    const suggestion =
      typeof action === 'string' ? didYouMeanSuffix(action, RECORDED_PATH_ACTIONS) : '';
    const allowedActions = RECORDED_PATH_ACTIONS.map((a) => `"${a}"`).join(', ');
    throw new Error(
      `invalid_strategy: ${where}.action = "${action}" is not a recognized recorded-path action. ` +
        `Allowed: ${allowedActions}${suggestion}. ` +
        `Common mistakes: "scroll" (use the browser tool, not a saved step), ` +
        `"keyPress" / "keydown" (use "key_press" with a "key" field), ` +
        `"hover" / "focus" (not supported — use "click" as a proxy).\n\n` +
        `Expected shape:\n  { "id": "<snake_case slug>", "action": "<one of the allowed actions>", "locators"?: {...}, "value"?: "...", ... }\n\n` +
        `See klura://reference#recorded-path-schema.`,
    );
  }

  // Every recorded-path step carries a stable slug id. The id is the handle
  // patch_step uses (so later patches survive step reordering) and the target
  // `notes.discovered_at_step_id` references so the runtime can partial-replay
  // up to that anchor when a primary strategy misses.
  const id = item.id;
  if (typeof id !== 'string' || id.length === 0) {
    if (requireId) {
      throw new Error(
        `invalid_strategy: ${where}.id is required — every recorded-path step needs a stable slug id (e.g. "click_send", "type_message", "navigate_inbox"). See klura://reference#recorded-path-schema.`,
      );
    }
    // requireId=false (wsOpen.steps): id is optional, skip id checks and
    // continue on to the rest of the step shape validation below.
  } else {
    // Order the pre-regex heuristic checks first so the error message
    // matches the actual anti-pattern rather than the generic regex hint.
    if (/^\d+$/.test(id)) {
      throw new Error(
        `invalid_strategy: ${where}.id = ${JSON.stringify(id)} is purely numeric — pure numbers aren't descriptive. Name what the step does (e.g. "click_submit", "navigate_inbox", "${action}_${id}").`,
      );
    }
    if (id.includes('-')) {
      throw new Error(
        `invalid_strategy: ${where}.id = ${JSON.stringify(id)} contains dashes — step_ids are snake_case, not kebab-case or uuid. Use underscores: ${JSON.stringify(id.replace(/-/g, '_'))}.`,
      );
    }
    // Catch hash/hex-looking ids (digits + a-f, 16+ chars) before the generic
    // regex check so agents get the descriptive-name nudge rather than the
    // "starts-with-a-letter" rule.
    if (STEP_ID_HEXISH_REGEX.test(id)) {
      throw new Error(
        `invalid_strategy: ${where}.id = ${JSON.stringify(id)} looks like a hash/hex string — use a descriptive snake_case name that says what the step does (e.g. "click_send_button", "type_recipient_email").`,
      );
    }
    if (!STEP_ID_REGEX.test(id)) {
      throw new Error(
        `invalid_strategy: ${where}.id = ${JSON.stringify(id)} is not a valid step id — must match /^[a-z][a-z0-9_]{2,39}$/ (snake_case, starts with a letter, 3-40 chars). Examples: "click_send", "type_message_body", "navigate_inbox".`,
      );
    }
    if (STEP_ID_RESERVED.has(id)) {
      const reservedList = [...STEP_ID_RESERVED].map((r) => `"${r}"`).join(', ');
      const suggestion = id === 'step' ? 'send' : id;
      throw new Error(
        `invalid_strategy: ${where}.id = ${JSON.stringify(id)} is a reserved word (one of: ${reservedList}). Pick a more specific name like "click_${suggestion}".`,
      );
    }
  }

  if ('optional' in item && item.optional !== undefined) {
    if (typeof item.optional !== 'boolean') {
      throw new Error(`invalid_strategy: ${where}.optional must be a boolean`);
    }
  }

  // Optional `page` field anchors the step to a specific tracked sub-page —
  // `"main"` (the page the session opened with) or `"popup-N"` (the Nth
  // popup observed during discovery). Drives multi-tab flows: a step that
  // clicks "Allow" inside an OAuth consent popup carries `page:"popup-1"`.
  // Replay reads this field; absent or `"main"` keeps the historical
  // single-page semantics. See klura://reference#popups.
  if ('page' in item && item.page !== undefined) {
    const pageVal = item.page;
    if (typeof pageVal !== 'string') {
      throw new Error(
        `invalid_strategy: ${where}.page must be a string page handle ("main" or "popup-N"). See klura://reference#popups.`,
      );
    }
    const PAGE_HANDLE_REGEX = /^(main|popup-[1-9]\d*)$/;
    if (!PAGE_HANDLE_REGEX.test(pageVal)) {
      throw new Error(
        `invalid_strategy: ${where}.page = ${JSON.stringify(pageVal)} is not a valid page handle. ` +
          `Allowed: "main" (the page the session opened with) or a "popup-N" id from a popup ` +
          `observed during discovery (1-indexed, no leading zero — e.g. "popup-1", "popup-2"). ` +
          `See klura://reference#popups.`,
      );
    }
  }

  const needsLocators =
    action === 'click' || action === 'type' || action === 'fill_editor' || action === 'select';
  if (!needsLocators) return;

  const locators = item.locators;
  if (!isPlainObject(locators)) {
    throw new Error(
      `invalid_strategy: ${where} (action:"${action}") requires a "locators" object — ` +
        `at minimum one of {a11y, css}, ideally both. A bare "selector" string has no healing ` +
        `fallback and breaks the first time the element's text or attributes drift (cookie banners, ` +
        `A/B tests, locale changes). Full shape + examples + sharable-skill locale variant table: ` +
        `klura://reference#recorded-path-schema. Short form: ` +
        `{a11y: {role, name}, css: "...", alternatives: [{a11y, css}, ...]}.`,
    );
  }

  const a11y = locators.a11y;
  const css = locators.css;
  const hasA11y = isPlainObject(a11y);
  const hasCss = typeof css === 'string' && css.length > 0;
  if (!hasA11y && !hasCss) {
    throw new Error(
      `invalid_strategy: ${where}.locators must declare at least one of {a11y, css} — ` +
        `both empty means the runtime has nothing to try. Ideally declare BOTH so there is a ` +
        `fallback when the primary drifts.`,
    );
  }

  if (hasA11y && isPlainObject(a11y)) {
    const roleVal = a11y.role;
    if (typeof roleVal !== 'string' || roleVal.length === 0) {
      throw new Error(
        `invalid_strategy: ${where}.locators.a11y.role must be a non-empty string ` +
          `(e.g. "button", "textbox", "link"). See the a11y tree output from start_session for ` +
          `the role taxonomy klura emits.`,
      );
    }
  }

  if (hasCss && typeof css === 'string') {
    checkLocatorCss(css, a11y, `${where}.locators`);
  }

  if ('alternatives' in locators && locators.alternatives !== undefined) {
    if (!Array.isArray(locators.alternatives)) {
      throw new Error(`invalid_strategy: ${where}.locators.alternatives must be an array`);
    }
    locators.alternatives.forEach((alt: unknown, j: number) => {
      if (!isPlainObject(alt)) {
        throw new Error(
          `invalid_strategy: ${where}.locators.alternatives[${j}] must be an object with {a11y, css}`,
        );
      }
      const altHasA11y = isPlainObject(alt.a11y);
      const altHasCss = typeof alt.css === 'string' && alt.css.length > 0;
      if (!altHasA11y && !altHasCss) {
        throw new Error(
          `invalid_strategy: ${where}.locators.alternatives[${j}] must declare at least one of ` +
            `{a11y, css} — an empty alternative is just noise.`,
        );
      }
      if (altHasCss && typeof alt.css === 'string') {
        checkLocatorCss(alt.css, alt.a11y, `${where}.locators.alternatives[${j}]`);
      }
    });
  }
}

/**
 * Step-id uniqueness check across the whole steps array. Called after the
 * per-step shape check succeeds so error ordering stays intuitive.
 */
export function validateRecordedPathStepIdUniqueness(
  steps: ReadonlyArray<Record<string, unknown>>,
): void {
  const seen = new Map<string, number>();
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    if (!s || typeof s !== 'object') continue;
    const id = (s as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const prev = seen.get(id);
    if (prev !== undefined) {
      throw new Error(
        `invalid_strategy: steps[${i}].id = "${id}" collides with steps[${prev}].id — use "${id}_2" or a more specific name`,
      );
    }
    seen.set(id, i);
  }
}
