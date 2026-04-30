// Unit tests for tryStructuralHeal — the warm-execute self-heal layer that
// runs between cascade-failure and the recorded_step_failed checkpoint
// emission. Exercises the two structural layers (substring name match,
// role-only uniqueness), the disable flag, and the failure modes that fall
// through to the existing checkpoint path.

import test from 'node:test';
import assert from 'node:assert';

const { tryStructuralHeal } = await import('../dist/execution/heal.js');

const FAKE_SESSION = { id: 'sess-test', subPages: [] };

function makeDriver({ findByRoleTolerantImpl, click, type, fillEditor, select } = {}) {
  const calls = {
    click: [],
    type: [],
    fillEditor: [],
    select: [],
    findByRoleTolerant: [],
  };
  return {
    calls,
    async click(session, selector, opts) {
      calls.click.push({ selector, opts });
      if (click) return click(session, selector, opts);
      return undefined;
    },
    async type(session, selector, value, opts) {
      calls.type.push({ selector, value, opts });
      if (type) return type(session, selector, value, opts);
    },
    async fillEditor(session, selector, value, opts) {
      calls.fillEditor.push({ selector, value, opts });
      if (fillEditor) return fillEditor(session, selector, value, opts);
    },
    async select(session, selector, value, opts) {
      calls.select.push({ selector, value, opts });
      if (select) return select(session, selector, value, opts);
    },
    async findByRoleTolerant(session, role, name, nameMatch, opts) {
      calls.findByRoleTolerant.push({ role, name, nameMatch, opts });
      if (findByRoleTolerantImpl) {
        return findByRoleTolerantImpl({ role, name, nameMatch, opts });
      }
      return null;
    },
  };
}

const ENABLED = { structural: true };
const DISABLED = { structural: false };

test('heal: substring layer matches when role+name uniquely resolves under tolerant matching', async () => {
  const driver = makeDriver({
    findByRoleTolerantImpl: ({ nameMatch, name }) => {
      // Substring match for "Submit" hits the live "Submit Form" button.
      if (nameMatch === 'substring' && name === 'Submit') {
        return { accessibleName: 'Submit Form' };
      }
      return null;
    },
  });
  const result = await tryStructuralHeal(
    driver,
    FAKE_SESSION,
    {
      staticLocators: {
        a11y: { role: 'button', name: 'Submit' },
        css: '#submit-btn',
      },
      action: 'click',
    },
    undefined,
    ENABLED,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.layer, 'substring');
  // Patched primary uses the LIVE name; original a11y demoted to alternatives.
  assert.deepStrictEqual(result.patchedLocators.a11y, { role: 'button', name: 'Submit Form' });
  assert.strictEqual(result.patchedLocators.css, '#submit-btn');
  assert.deepStrictEqual(result.patchedLocators.alternatives, [
    { a11y: { role: 'button', name: 'Submit' } },
  ]);
  // Retry called the heal-built selector through driver.click.
  assert.strictEqual(driver.calls.click.length, 1);
  assert.strictEqual(driver.calls.click[0].selector, 'role=button[name="Submit Form"]');
});

test('heal: role-only layer fires when substring misses but role uniquely identifies', async () => {
  const driver = makeDriver({
    findByRoleTolerantImpl: ({ nameMatch, role }) => {
      // "Submit" is not a substring of "Send" — substring layer misses.
      if (nameMatch === 'substring') return null;
      // Role-only finds the one button on the page.
      if (nameMatch === 'any' && role === 'button') {
        return { accessibleName: 'Send' };
      }
      return null;
    },
  });
  const result = await tryStructuralHeal(
    driver,
    FAKE_SESSION,
    {
      staticLocators: {
        a11y: { role: 'button', name: 'Submit' },
        css: '#submit-btn',
      },
      action: 'click',
    },
    undefined,
    ENABLED,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.layer, 'role-only');
  assert.deepStrictEqual(result.patchedLocators.a11y, { role: 'button', name: 'Send' });
  assert.strictEqual(driver.calls.click[0].selector, 'role=button[name="Send"]');
});

test('heal: returns ok:false when neither layer finds a unique match', async () => {
  const driver = makeDriver({
    findByRoleTolerantImpl: () => null,
  });
  const result = await tryStructuralHeal(
    driver,
    FAKE_SESSION,
    {
      staticLocators: { a11y: { role: 'button', name: 'Submit' } },
      action: 'click',
    },
    undefined,
    ENABLED,
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no_unique_match');
  assert.strictEqual(driver.calls.click.length, 0);
});

test('heal: disabled flag short-circuits before any driver call', async () => {
  const driver = makeDriver({
    findByRoleTolerantImpl: () => {
      throw new Error('should not be called when disabled');
    },
  });
  const result = await tryStructuralHeal(
    driver,
    FAKE_SESSION,
    {
      staticLocators: { a11y: { role: 'button', name: 'Submit' } },
      action: 'click',
    },
    undefined,
    DISABLED,
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'disabled');
  assert.strictEqual(driver.calls.findByRoleTolerant.length, 0);
});

test('heal: returns ok:false when retry action throws (no spurious patch)', async () => {
  const driver = makeDriver({
    findByRoleTolerantImpl: () => ({ accessibleName: 'Submit Form' }),
    click: () => {
      throw new Error('retry click still fails');
    },
  });
  const result = await tryStructuralHeal(
    driver,
    FAKE_SESSION,
    {
      staticLocators: { a11y: { role: 'button', name: 'Submit' } },
      action: 'click',
    },
    undefined,
    ENABLED,
  );
  assert.strictEqual(result.ok, false);
  // Both layers tried; both retries threw.
  assert.strictEqual(result.reason, 'no_unique_match');
});

test('heal: returns ok:false (no_role) when step has no a11y locator captured', async () => {
  const driver = makeDriver();
  const result = await tryStructuralHeal(
    driver,
    FAKE_SESSION,
    {
      staticLocators: { css: '#submit-btn' },
      action: 'click',
    },
    undefined,
    ENABLED,
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no_role');
  assert.strictEqual(driver.calls.findByRoleTolerant.length, 0);
});

test('heal: returns ok:false (unhealable_action) for non-click/type actions', async () => {
  const driver = makeDriver();
  const result = await tryStructuralHeal(
    driver,
    FAKE_SESSION,
    {
      staticLocators: { a11y: { role: 'button', name: 'Submit' } },
      action: 'wait',
    },
    undefined,
    ENABLED,
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'unhealable_action');
});

test('heal: type action retries with the resolved value through the new selector', async () => {
  const driver = makeDriver({
    findByRoleTolerantImpl: ({ name, nameMatch }) =>
      nameMatch === 'substring' && name === 'Search' ? { accessibleName: 'Search the docs' } : null,
  });
  const result = await tryStructuralHeal(
    driver,
    FAKE_SESSION,
    {
      staticLocators: { a11y: { role: 'textbox', name: 'Search' } },
      action: 'type',
      value: 'klura',
    },
    undefined,
    ENABLED,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(driver.calls.type.length, 1);
  assert.strictEqual(driver.calls.type[0].selector, 'role=textbox[name="Search the docs"]');
  assert.strictEqual(driver.calls.type[0].value, 'klura');
});

test('heal: walks alternatives when primary a11y candidate misses', async () => {
  const driver = makeDriver({
    findByRoleTolerantImpl: ({ name, nameMatch }) => {
      // Primary "Sign In" misses, alternative "Log In" hits with substring.
      if (nameMatch === 'substring' && name === 'Sign In') return null;
      if (nameMatch === 'substring' && name === 'Log In') {
        return { accessibleName: 'Log In Now' };
      }
      return null;
    },
  });
  const result = await tryStructuralHeal(
    driver,
    FAKE_SESSION,
    {
      staticLocators: {
        a11y: { role: 'button', name: 'Sign In' },
        alternatives: [{ a11y: { role: 'button', name: 'Log In' } }],
      },
      action: 'click',
    },
    undefined,
    ENABLED,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.layer, 'substring');
  assert.deepStrictEqual(result.patchedLocators.a11y, { role: 'button', name: 'Log In Now' });
  // Original primary demoted to head of alternatives, original alternative
  // preserved after it.
  assert.deepStrictEqual(result.patchedLocators.alternatives, [
    { a11y: { role: 'button', name: 'Sign In' } },
    { a11y: { role: 'button', name: 'Log In' } },
  ]);
});

test('heal: pageOpts threaded through to driver calls (popup-pinned step)', async () => {
  const driver = makeDriver({
    findByRoleTolerantImpl: () => ({ accessibleName: 'Confirm' }),
  });
  await tryStructuralHeal(
    driver,
    FAKE_SESSION,
    {
      staticLocators: { a11y: { role: 'button', name: 'Confirm' } },
      action: 'click',
    },
    { page: 'popup-1' },
    ENABLED,
  );
  // findByRoleTolerant + click both saw the popup handle.
  assert.deepStrictEqual(driver.calls.findByRoleTolerant[0].opts, { page: 'popup-1' });
  assert.deepStrictEqual(driver.calls.click[0].opts, { page: 'popup-1' });
});

test('heal: cracks role+name out of css when snapshot syntax was saved into the css field', async () => {
  // Auto-synth before structured-a11y capture saved selectors like
  // `button "Submit"` into the css field with no a11y entry. Heal must
  // fall back to parsing the snapshot string so existing strategies on
  // disk still get the rescan.
  const driver = makeDriver({
    findByRoleTolerantImpl: ({ name, nameMatch }) =>
      nameMatch === 'any' ? { accessibleName: 'Send' } : null,
  });
  const result = await tryStructuralHeal(
    driver,
    FAKE_SESSION,
    {
      staticLocators: { css: 'button "Submit"' },
      action: 'click',
    },
    undefined,
    ENABLED,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.layer, 'role-only');
  assert.strictEqual(driver.calls.click[0].selector, 'role=button[name="Send"]');
});

test('heal: substring layer skips candidates with no captured name (no false-positive role-only)', async () => {
  // Candidate has only role, no name. Substring layer needs a name to match
  // against — should skip cleanly and let role-only run.
  const driver = makeDriver({
    findByRoleTolerantImpl: ({ nameMatch }) =>
      nameMatch === 'any' ? { accessibleName: 'Click me' } : null,
  });
  const result = await tryStructuralHeal(
    driver,
    FAKE_SESSION,
    {
      staticLocators: { a11y: { role: 'button' } },
      action: 'click',
    },
    undefined,
    ENABLED,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.layer, 'role-only');
  // Only the role-only call landed on the driver (no substring probes).
  const substringProbes = driver.calls.findByRoleTolerant.filter(
    (c) => c.nameMatch === 'substring',
  );
  assert.strictEqual(substringProbes.length, 0);
});
