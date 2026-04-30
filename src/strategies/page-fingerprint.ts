// Page fingerprint — structural skeleton extracted from an a11y tree string +
// URL at recorded-step capture time, re-extracted live at warm-execute time,
// and diffed to detect whether the page drifted enough that replaying the
// authored step would target the wrong element. Runtime-internal: captured
// automatically, never authored by the LLM, surfaced to the agent only as
// part of a `recorded_step_failed` checkpoint context on hard drift.
//
// Fields are deliberately content-blind (no feed items, no live counts, no
// ad bodies) and cheap to compute — a single pass over the a11y-tree lines
// with tolerant parsing. Malformed or empty input yields an empty fingerprint
// rather than throwing: missing a drift check is strictly better than aborting
// a warm run because we couldn't parse the tree.

export interface FormSignature {
  inputs: string[]; // input `name` attributes, sorted
  buttons: string[]; // button labels inside the form, sorted
}

export interface PageFingerprint {
  url_path: string;
  primary_heading: string;
  landmark_roles: string[];
  has_dialog: boolean;
  form_signature: FormSignature | null;
  visible_primary_buttons: string[];
}

export interface DriftFieldChange {
  saved: unknown;
  live: unknown;
}

export interface DriftClassification {
  severity: 'none' | 'soft' | 'hard';
  fields: string[];
  details: Record<string, DriftFieldChange>;
}

const LANDMARK_ROLES = new Set([
  'main',
  'form',
  'nav',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'search',
  'article',
]);

const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);

interface ParsedNode {
  indent: number;
  role: string;
  name: string;
  /** Raw attributes bracket (e.g. `[level=1]`) — kept raw so callers can
   *  parse out what they need without us eagerly splitting attribute lists. */
  attrs: string;
  lineIdx: number;
}

// Playwright's aria-snapshot format emits lines like:
//   - heading "Foo" [level=1]
//   - button "Submit"
//   - textbox "Email"
//   - main:
//   - form:
//   - /url: "https://..."
// We match `- <role>[ "<name>"][ [attrs]]` and ignore attribute child lines
// (those start with `- /`). Trailing `:` (container marker) is stripped from
// the role.
// eslint-disable-next-line sonarjs/slow-regex
const LINE_REGEX = /^(\s*)- ([A-Za-z][A-Za-z0-9_-]*):?\s*(?:"((?:[^"\\]|\\.)*)")?\s*(.*)$/;

function parseTree(a11yTree: string): ParsedNode[] {
  if (typeof a11yTree !== 'string' || a11yTree.length === 0) return [];
  const out: ParsedNode[] = [];
  const lines = a11yTree.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    // Attribute-child lines (e.g. `- /url: "..."`) carry no role — skip.
    const trimmed = line.trimStart();
    if (trimmed.startsWith('- /')) continue;
    const m = LINE_REGEX.exec(line);
    if (!m) continue;
    const indent = (m[1] ?? '').length;
    const role = (m[2] ?? '').toLowerCase();
    const name = m[3] ?? '';
    const attrs = (m[4] ?? '').trim();
    if (!role) continue;
    out.push({ indent, role, name, attrs, lineIdx: i });
  }
  return out;
}

function urlPathOf(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return '';
  try {
    return new URL(url).pathname;
  } catch {
    // Not absolute — treat the whole thing as a path (strip query / hash).
    const q = url.indexOf('?');
    const h = url.indexOf('#');
    const cut = [q, h].filter((n) => n >= 0).sort((a, b) => a - b)[0];
    return cut === undefined ? url : url.slice(0, cut);
  }
}

function headingLevel(attrs: string): number {
  const m = /level=(\d+)/.exec(attrs);
  return m ? Number(m[1]) : 99;
}

function emptyFingerprint(urlPath = ''): PageFingerprint {
  return {
    url_path: urlPath,
    primary_heading: '',
    landmark_roles: [],
    has_dialog: false,
    form_signature: null,
    visible_primary_buttons: [],
  };
}

export function capturePageFingerprint(a11yTree: string, url: string): PageFingerprint {
  try {
    const urlPath = urlPathOf(url);
    const nodes = parseTree(a11yTree);
    if (nodes.length === 0) return emptyFingerprint(urlPath);

    // Primary heading — lowest-level (1 wins over 2) heading; ties broken by
    // document order.
    let primaryHeading = '';
    let bestLevel = Infinity;
    for (const n of nodes) {
      if (n.role !== 'heading' || !n.name) continue;
      const lvl = headingLevel(n.attrs);
      if (lvl < bestLevel) {
        bestLevel = lvl;
        primaryHeading = n.name;
      }
    }

    // Landmark role set.
    const landmarks = new Set<string>();
    let hasDialog = false;
    for (const n of nodes) {
      if (LANDMARK_ROLES.has(n.role)) landmarks.add(normalizeLandmark(n.role));
      if (DIALOG_ROLES.has(n.role)) hasDialog = true;
    }

    // Form signature — first top-level form node (shallowest indent wins).
    let formNode: ParsedNode | null = null;
    let formIndent = Infinity;
    let formIdx = -1;
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      if (n === undefined) continue;
      if (n.role === 'form' && n.indent < formIndent) {
        formNode = n;
        formIndent = n.indent;
        formIdx = i;
      }
    }
    let formSignature: FormSignature | null = null;
    if (formNode && formIdx >= 0) {
      const inputs: string[] = [];
      const buttons: string[] = [];
      for (let j = formIdx + 1; j < nodes.length; j += 1) {
        const child = nodes[j];
        if (child === undefined) continue;
        if (child.indent <= formIndent) break;
        if (child.role === 'textbox' || child.role === 'searchbox' || child.role === 'combobox') {
          if (child.name) inputs.push(child.name);
        }
        if (child.role === 'button' && child.name) {
          buttons.push(child.name);
        }
      }
      formSignature = {
        inputs: [...inputs].sort((a, b) => a.localeCompare(b)),
        buttons: [...buttons].sort((a, b) => a.localeCompare(b)),
      };
    }

    // Visible primary buttons — every button node in the tree. Content-blind
    // by design: we don't filter by viewport, we only read what the a11y
    // snapshot surfaces.
    const buttons: string[] = [];
    for (const n of nodes) {
      if (n.role === 'button' && n.name) buttons.push(n.name);
    }

    return {
      url_path: urlPath,
      primary_heading: primaryHeading,
      landmark_roles: [...landmarks].sort((a, b) => a.localeCompare(b)),
      has_dialog: hasDialog,
      form_signature: formSignature,
      visible_primary_buttons: dedupeSorted(buttons),
    };
  } catch {
    // Parse failure falls back to empty — the diff function treats empty
    // fingerprints as non-actionable (returns 'none'), so a check that
    // can't run degrades to "proceed" rather than "abort".
    return emptyFingerprint();
  }
}

function normalizeLandmark(role: string): string {
  // Playwright emits both `nav` and `navigation` depending on the HTML tag —
  // canonicalize to `nav` so the set compare doesn't drift on copy changes.
  if (role === 'navigation') return 'nav';
  return role;
}

function dedupeSorted(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function formSignaturesEqual(a: FormSignature | null, b: FormSignature | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return setsEqual(a.inputs, b.inputs) && setsEqual(a.buttons, b.buttons);
}

/**
 * Classify drift between a saved (at discovery) and live (at warm-execute)
 * fingerprint. `targetLabel` is the name/label of the element the step is
 * about to act on (from locators.a11y.name or a css heuristic) — used to
 * check that the target still exists in the live fingerprint.
 *
 * Classification:
 *   hard  → abort before the click fires
 *   soft  → proceed, attach advisory
 *   none  → proceed silently
 */
export function diffFingerprints(
  saved: PageFingerprint,
  live: PageFingerprint,
  targetLabel?: string,
): DriftClassification {
  const details: Record<string, DriftFieldChange> = {};
  const fields: string[] = [];
  let severity: 'none' | 'soft' | 'hard' = 'none';

  // If the saved fingerprint is empty (capture failed at discovery), there's
  // nothing to diff against — treat as none and let the step proceed.
  const savedIsEmpty =
    saved.url_path === '' &&
    saved.primary_heading === '' &&
    saved.landmark_roles.length === 0 &&
    saved.visible_primary_buttons.length === 0 &&
    saved.form_signature === null &&
    !saved.has_dialog;
  if (savedIsEmpty) return { severity: 'none', fields, details };

  // HARD: url_path mismatch
  if (saved.url_path && live.url_path && saved.url_path !== live.url_path) {
    fields.push('url_path');
    details.url_path = { saved: saved.url_path, live: live.url_path };
    severity = 'hard';
  }

  // HARD: a dialog materialized where none was at discovery
  if (!saved.has_dialog && live.has_dialog) {
    fields.push('has_dialog');
    details.has_dialog = { saved: false, live: true };
    severity = 'hard';
  }

  // HARD: the target form is gone
  if (saved.form_signature !== null && live.form_signature === null) {
    fields.push('form_signature');
    details.form_signature = { saved: saved.form_signature, live: null };
    severity = 'hard';
  }

  // HARD: the target button/input is not present anywhere we'd expect it.
  if (typeof targetLabel === 'string' && targetLabel.length > 0) {
    const inButtons = live.visible_primary_buttons.includes(targetLabel);
    const inForm = !!(
      live.form_signature &&
      (live.form_signature.buttons.includes(targetLabel) ||
        live.form_signature.inputs.includes(targetLabel))
    );
    const wasInSaved =
      saved.visible_primary_buttons.includes(targetLabel) ||
      !!(
        saved.form_signature &&
        (saved.form_signature.buttons.includes(targetLabel) ||
          saved.form_signature.inputs.includes(targetLabel))
      );
    if (wasInSaved && !inButtons && !inForm) {
      fields.push('target_missing');
      details.target_missing = { saved: targetLabel, live: null };
      severity = 'hard';
    }
  }

  if (severity === 'hard') {
    return { severity, fields: [...new Set(fields)], details };
  }

  // SOFT: primary_heading text changed but landmarks + form_signature hold
  if (
    saved.primary_heading &&
    live.primary_heading &&
    saved.primary_heading !== live.primary_heading
  ) {
    fields.push('primary_heading');
    details.primary_heading = { saved: saved.primary_heading, live: live.primary_heading };
    severity = 'soft';
  }

  // SOFT: new button labels appeared but all originals retained
  const savedBtnSet = new Set(saved.visible_primary_buttons);
  const liveBtnSet = new Set(live.visible_primary_buttons);
  const addedButtons: string[] = [];
  for (const b of liveBtnSet) if (!savedBtnSet.has(b)) addedButtons.push(b);
  const droppedButtons: string[] = [];
  for (const b of savedBtnSet) if (!liveBtnSet.has(b)) droppedButtons.push(b);
  if (droppedButtons.length === 0 && addedButtons.length > 0) {
    fields.push('visible_primary_buttons_added');
    details.visible_primary_buttons_added = {
      saved: [...savedBtnSet].sort((a, b) => a.localeCompare(b)),
      live: [...addedButtons].sort((a, b) => a.localeCompare(b)),
    };
    if (severity === 'none') severity = 'soft';
  }

  // SOFT: landmark set changed only in ordering (setsEqual handles identity,
  // so this bucket fires when sets differ by at most one side-role without a
  // core landmark swap). Keep simple: any landmark diff that isn't hard-level
  // is soft.
  if (!setsEqual(saved.landmark_roles, live.landmark_roles)) {
    fields.push('landmark_roles');
    details.landmark_roles = {
      saved: saved.landmark_roles,
      live: live.landmark_roles,
    };
    if (severity === 'none') severity = 'soft';
  }

  // SOFT: form_signature changed shape but still present
  if (
    saved.form_signature !== null &&
    live.form_signature !== null &&
    !formSignaturesEqual(saved.form_signature, live.form_signature)
  ) {
    fields.push('form_signature_changed');
    details.form_signature_changed = {
      saved: saved.form_signature,
      live: live.form_signature,
    };
    if (severity === 'none') severity = 'soft';
  }

  return { severity, fields: [...new Set(fields)], details };
}

/**
 * Runtime error thrown by the recorded-path step loop when the live page
 * fingerprint diverges from the step-authored fingerprint beyond recovery.
 * Caught by the outer executor wrapper and routed through
 * `invokeCheckpointAndGate('recorded_step_failed', ...)` with
 * `context.reason: "page_drifted_before_step"` + the diff.
 */
export class PageDriftError extends Error {
  readonly diff: DriftClassification;
  readonly stepId?: string;
  constructor(message: string, diff: DriftClassification, stepId?: string) {
    super(message);
    this.name = 'PageDriftError';
    this.diff = diff;
    this.stepId = stepId;
  }
}

/**
 * Render a drift diff into a short human-readable string for checkpoint
 * prompts and logs. Keeps the wording short — the structured diff stays on
 * `context.diff` for programmatic use.
 */
export function describeDrift(diff: DriftClassification): string {
  const parts: string[] = [];
  for (const field of diff.fields) {
    const change = diff.details[field];
    if (!change) continue;
    if (field === 'has_dialog') {
      parts.push('a dialog/modal appeared on the page where none was at discovery');
    } else if (field === 'url_path') {
      parts.push(`url path changed: ${String(change.saved)} → ${String(change.live)}`);
    } else if (field === 'form_signature') {
      parts.push('the form targeted at discovery is no longer present');
    } else if (field === 'target_missing') {
      parts.push(`the step's target (${String(change.saved)}) is not present`);
    } else if (field === 'primary_heading') {
      parts.push(`heading changed: "${String(change.saved)}" → "${String(change.live)}"`);
    } else if (field === 'visible_primary_buttons_added') {
      const added = Array.isArray(change.live) ? (change.live as string[]).join(', ') : '';
      parts.push(`new buttons appeared: ${added}`);
    } else if (field === 'landmark_roles') {
      parts.push('page landmark structure shifted');
    } else if (field === 'form_signature_changed') {
      parts.push('form inputs/buttons changed shape');
    }
  }
  return parts.join('; ');
}
