// Parser for Playwright a11y-snapshot-style selector strings —
//   `<role> "<name>"` (e.g. `button "Submit"`, `textbox "Name"`).
// Agents trained on Playwright snapshot output reach for this syntax when
// driving the browser via `perform_action`, and the close-session
// auto-synthesizer captures the agent's selector verbatim into the saved
// step's `locators.css`. Two consumers need to crack the snapshot string
// back into structured `{role, name}`:
//
//   1. Auto-synth — produce a proper `locators.a11y` alongside the css so
//      the cascade and self-heal layer can both reach for role-based
//      matching.
//   2. Self-heal — when an existing strategy was saved with css-only
//      locators, extract role/name from the snapshot string before
//      attempting structural rescan.
//
// The role list and regex shape mirror the same vocabulary the Playwright
// driver's `resolveLocator` accepts (`runtime/src/drivers/playwright.ts`),
// so anything cracked here would have resolved through the cascade with
// the same selector string.

const A11Y_ROLES =
  'button|textbox|searchbox|link|checkbox|radio|combobox|heading|img|tab|switch|slider|spinbutton|progressbar|menuitem|menuitemcheckbox|menuitemradio|option|dialog|alertdialog|alert|banner|navigation|main|complementary|contentinfo|form|region|search|paragraph|list|listitem|table|row|cell|columnheader|rowheader|separator|toolbar|menu|menubar|tablist|tabpanel|tree|treeitem|treegrid|group|article|figure|status|timer|tooltip|log|marquee|math|note|directory|document|feed|grid|gridcell|mark|meter|scrollbar|term|definition|insertion|deletion|emphasis|strong|subscript|superscript|time|code|blockquote';

const SNAPSHOT_RE = new RegExp(`^(${A11Y_ROLES})(?:\\s+"(.+?)")?(?:\\[(\\d+)\\])?$`);

/**
 * If `selector` matches Playwright's a11y-snapshot syntax, return the
 * structured form. Otherwise return null so the caller can treat it as a
 * plain CSS selector.
 */
export function parseSnapshotSelector(
  selector: string | undefined,
): { role: string; name?: string } | null {
  if (!selector) return null;
  const m = SNAPSHOT_RE.exec(selector);
  if (!m || !m[1]) return null;
  const role = m[1];
  const name = m[2];
  return name ? { role, name } : { role };
}
