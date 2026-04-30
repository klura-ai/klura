// Unit tests for runtime-auto page fingerprint extraction + drift classification.
//
// The fingerprint is captured from the a11y-tree string + URL at mutating-
// action time (click / type / fill_editor / select) and re-captured live at
// warm-execute time to detect structural drift before the locator resolves.
// Malformed input MUST NOT throw — an empty fingerprint is safer than
// aborting warm runs on parse errors.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-page-fingerprint-'));
process.env.KLURA_HOME = TMP;
test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const {
  capturePageFingerprint,
  diffFingerprints,
  describeDrift,
  PageDriftError,
} = await import('../dist/strategies/page-fingerprint.js');

// ---- Fingerprint extraction --------------------------------------------

test('capturePageFingerprint: extracts form-page skeleton', () => {
  const tree = [
    '- document:',
    '  - main:',
    '    - heading "Sign in" [level=1]',
    '    - form:',
    '      - textbox "Email"',
    '      - textbox "Password"',
    '      - button "Sign in"',
    '      - button "Cancel"',
    '    - button "Forgot password"',
  ].join('\n');
  const fp = capturePageFingerprint(tree, 'https://example.com/login');
  assert.equal(fp.url_path, '/login');
  assert.equal(fp.primary_heading, 'Sign in');
  assert.deepEqual(fp.landmark_roles, ['form', 'main']);
  assert.equal(fp.has_dialog, false);
  assert.deepEqual(fp.form_signature, {
    inputs: ['Email', 'Password'],
    buttons: ['Cancel', 'Sign in'],
  });
  assert.deepEqual(fp.visible_primary_buttons, ['Cancel', 'Forgot password', 'Sign in']);
});

test('capturePageFingerprint: flags dialog presence', () => {
  const tree = [
    '- document:',
    '  - main:',
    '    - heading "Settings" [level=1]',
    '    - button "Save"',
    '  - dialog:',
    '    - heading "Accept updated Terms" [level=2]',
    '    - button "I agree"',
    '    - button "Read more"',
  ].join('\n');
  const fp = capturePageFingerprint(tree, 'https://example.com/settings');
  assert.equal(fp.has_dialog, true);
  assert.equal(fp.primary_heading, 'Settings'); // heading level 1 beats level 2
  assert.ok(fp.visible_primary_buttons.includes('I agree'));
});

test('capturePageFingerprint: lower-level heading picked when no h1', () => {
  const tree = [
    '- document:',
    '  - heading "Section" [level=3]',
    '  - heading "Sub" [level=4]',
  ].join('\n');
  const fp = capturePageFingerprint(tree, 'https://example.com/x');
  assert.equal(fp.primary_heading, 'Section');
});

test('capturePageFingerprint: empty input → empty fingerprint, no throw', () => {
  const fp = capturePageFingerprint('', '');
  assert.equal(fp.url_path, '');
  assert.equal(fp.primary_heading, '');
  assert.deepEqual(fp.landmark_roles, []);
  assert.equal(fp.has_dialog, false);
  assert.equal(fp.form_signature, null);
  assert.deepEqual(fp.visible_primary_buttons, []);
});

test('capturePageFingerprint: malformed tree → empty fingerprint, no throw', () => {
  const garbage = 'not an a11y tree at all\n@@@\n{{{{';
  const fp = capturePageFingerprint(garbage, 'not-a-url');
  // Malformed lines are skipped; parser returns nothing structural; URL is
  // treated as a path since it's not absolute.
  assert.equal(fp.primary_heading, '');
  assert.equal(fp.has_dialog, false);
});

test('capturePageFingerprint: url path only — drops query / hash', () => {
  const fp = capturePageFingerprint('- document:', 'https://a.example/b/c?x=1#hash');
  assert.equal(fp.url_path, '/b/c');
});

test('capturePageFingerprint: navigation landmark canonicalized to nav', () => {
  const tree = ['- document:', '  - navigation:', '    - link "Home"'].join('\n');
  const fp = capturePageFingerprint(tree, 'https://example.com/x');
  assert.deepEqual(fp.landmark_roles, ['nav']);
});

// ---- Drift classification ----------------------------------------------

const FORM_PAGE = [
  '- document:',
  '  - main:',
  '    - heading "Submit ticket" [level=1]',
  '    - form:',
  '      - textbox "Subject"',
  '      - button "Submit"',
  '      - button "Cancel"',
].join('\n');

test('diffFingerprints: identical trees → none', () => {
  const a = capturePageFingerprint(FORM_PAGE, 'https://example.com/ticket');
  const b = capturePageFingerprint(FORM_PAGE, 'https://example.com/ticket');
  const d = diffFingerprints(a, b, 'Submit');
  assert.equal(d.severity, 'none');
  assert.deepEqual(d.fields, []);
});

test('diffFingerprints: heading change only → soft', () => {
  const a = capturePageFingerprint(FORM_PAGE, 'https://example.com/ticket');
  const renamed = FORM_PAGE.replace('Submit ticket', 'Submit a ticket');
  const b = capturePageFingerprint(renamed, 'https://example.com/ticket');
  const d = diffFingerprints(a, b, 'Submit');
  assert.equal(d.severity, 'soft');
  assert.ok(d.fields.includes('primary_heading'));
});

test('diffFingerprints: url_path change → hard', () => {
  const a = capturePageFingerprint(FORM_PAGE, 'https://example.com/ticket');
  const b = capturePageFingerprint(FORM_PAGE, 'https://example.com/ticket/new');
  const d = diffFingerprints(a, b, 'Submit');
  assert.equal(d.severity, 'hard');
  assert.ok(d.fields.includes('url_path'));
});

test('diffFingerprints: dialog materialized → hard', () => {
  const a = capturePageFingerprint(FORM_PAGE, 'https://example.com/ticket');
  const withDialog = FORM_PAGE + '\n  - dialog:\n    - heading "Accept updated Terms" [level=2]\n    - button "I agree"';
  const b = capturePageFingerprint(withDialog, 'https://example.com/ticket');
  const d = diffFingerprints(a, b, 'Submit');
  assert.equal(d.severity, 'hard');
  assert.ok(d.fields.includes('has_dialog'));
  assert.equal(d.details.has_dialog.saved, false);
  assert.equal(d.details.has_dialog.live, true);
});

test('diffFingerprints: target form gone → hard', () => {
  const a = capturePageFingerprint(FORM_PAGE, 'https://example.com/ticket');
  const noForm = ['- document:', '  - main:', '    - heading "Submit ticket" [level=1]'].join('\n');
  const b = capturePageFingerprint(noForm, 'https://example.com/ticket');
  const d = diffFingerprints(a, b, 'Submit');
  assert.equal(d.severity, 'hard');
  assert.ok(d.fields.includes('form_signature'));
});

test('diffFingerprints: target button missing → hard', () => {
  const a = capturePageFingerprint(FORM_PAGE, 'https://example.com/ticket');
  const swapped = FORM_PAGE.replace('button "Submit"', 'button "Publish"');
  const b = capturePageFingerprint(swapped, 'https://example.com/ticket');
  const d = diffFingerprints(a, b, 'Submit');
  assert.equal(d.severity, 'hard');
  assert.ok(d.fields.includes('target_missing'));
});

test('diffFingerprints: new buttons added (originals retained) → soft', () => {
  const a = capturePageFingerprint(FORM_PAGE, 'https://example.com/ticket');
  const extra = FORM_PAGE.replace(
    '      - button "Cancel"',
    '      - button "Cancel"\n      - button "Draft"\n      - button "Preview"',
  );
  const b = capturePageFingerprint(extra, 'https://example.com/ticket');
  const d = diffFingerprints(a, b, 'Submit');
  assert.equal(d.severity, 'soft');
  assert.ok(d.fields.includes('visible_primary_buttons_added'));
});

test('diffFingerprints: saved empty → none (degrades safely)', () => {
  const a = capturePageFingerprint('', '');
  const b = capturePageFingerprint(FORM_PAGE, 'https://example.com/ticket');
  const d = diffFingerprints(a, b, 'Submit');
  assert.equal(d.severity, 'none');
});

// ---- describeDrift + PageDriftError ------------------------------------

test('describeDrift: renders hard-drift dialog prose', () => {
  const d = diffFingerprints(
    capturePageFingerprint(FORM_PAGE, 'https://example.com/ticket'),
    capturePageFingerprint(
      FORM_PAGE + '\n  - dialog:\n    - heading "Accept updated Terms" [level=2]',
      'https://example.com/ticket',
    ),
    'Submit',
  );
  const s = describeDrift(d);
  assert.match(s, /dialog/i);
});

test('PageDriftError: exposes diff + stepId', () => {
  const d = { severity: 'hard', fields: ['has_dialog'], details: { has_dialog: { saved: false, live: true } } };
  const e = new PageDriftError('drift', d, 'click_submit');
  assert.equal(e.name, 'PageDriftError');
  assert.equal(e.stepId, 'click_submit');
  assert.equal(e.diff, d);
});
