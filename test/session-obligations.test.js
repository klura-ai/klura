// Session-obligation lift-required reminder. Pure function over Session
// state — no driver, no pool, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { computeSessionObligation } = await import('../dist/session-obligations.js');

// Default session shape represents a COMMITTED session — one capability
// declared at start_session. Tests covering the exploration exemption
// override `declaredCapabilities: []` explicitly.
function mkSession(overrides = {}) {
  return {
    id: 'sess_test',
    intercepted: [],
    intercepting: false,
    declaredCapabilities: [{ capability: 'test_cap', args: {}, declared_at: 0 }],
    ...overrides,
  };
}

test('returns null for read-only session (no perform_action history)', () => {
  const session = mkSession({ performActionHistory: [] });
  assert.equal(computeSessionObligation(session), null);
});

test('returns null when only navigate / wait actions logged', () => {
  const session = mkSession({
    performActionHistory: [
      { at: 1, action: 'navigate', url: 'https://x.test/' },
      { at: 2, action: 'wait' },
    ],
  });
  assert.equal(computeSessionObligation(session), null);
});

test('fires after a click action with no save', () => {
  const session = mkSession({
    performActionHistory: [
      { at: 1, action: 'navigate', url: 'https://x.test/' },
      { at: 2, action: 'click', selector: 'button' },
    ],
  });
  const obl = computeSessionObligation(session);
  assert.ok(obl);
  assert.equal(obl.kind, 'lift_required');
  assert.equal(obl.session_id, 'sess_test');
  assert.equal(obl.mutating_actions, 1);
});

test('fires after a type action with no save', () => {
  const session = mkSession({
    performActionHistory: [{ at: 1, action: 'type', value: 'hello' }],
  });
  const obl = computeSessionObligation(session);
  assert.ok(obl);
  assert.equal(obl.mutating_actions, 1);
});

test('counts all mutating action kinds', () => {
  const session = mkSession({
    performActionHistory: [
      { at: 1, action: 'click' },
      { at: 2, action: 'type', value: 'x' },
      { at: 3, action: 'fill_editor', value: 'y' },
      { at: 4, action: 'key_press', key: 'Enter' },
      { at: 5, action: 'select', value: 'opt' },
      { at: 6, action: 'navigate' },  // not counted
      { at: 7, action: 'wait' },       // not counted
    ],
  });
  const obl = computeSessionObligation(session);
  assert.equal(obl.mutating_actions, 5);
});

test('clears after a save_strategy that came AFTER the last mutation', () => {
  const session = mkSession({
    performActionHistory: [
      { at: 1, action: 'click' },
      { at: 2, action: 'type', value: 'x' },
    ],
    savedCapabilities: [{ capability: 'send_message', at: 3, tier: 'page-script' }],
  });
  assert.equal(computeSessionObligation(session), null);
});

test('re-fires when a fresh mutation happens after a save', () => {
  const session = mkSession({
    performActionHistory: [
      { at: 1, action: 'click' },
      { at: 2, action: 'type', value: 'x' },
    ],
    savedCapabilities: [{ capability: 'send_message', at: 3, tier: 'page-script' }],
  });
  // Add a new mutation after the save:
  session.performActionHistory.push({ at: 4, action: 'click' });
  const obl = computeSessionObligation(session);
  assert.ok(obl);
});

test('message text mentions end_drive and LIFT', () => {
  const session = mkSession({
    performActionHistory: [{ at: 1, action: 'click' }],
  });
  const obl = computeSessionObligation(session);
  assert.match(obl.message, /end_drive/);
  assert.match(obl.message, /LIFT/);
  assert.match(obl.message, /klura:\/\/reference/);
});

test('TRIAGE phase names submit_triage_plan as path forward, not save_strategy', () => {
  const session = mkSession({
    phase: 'triage',
    performActionHistory: [{ at: 1, action: 'click' }],
  });
  const obl = computeSessionObligation(session);
  assert.match(obl.message, /TRIAGE/);
  assert.match(obl.message, /submit_triage_plan/);
  assert.match(obl.message, /Do not tell the user the task is complete/);
  // Triage prose mentions save_strategy only to note that it's blocked
  // (not as the path forward). The unified no-false-MUST test below
  // covers the regression against re-introducing "MUST be" claims.
  assert.match(obl.message, /save_strategy.*hard-blocked|save_strategy.*unlocks/);
});

test('LIFT phase names save_strategy + iteration loop with don\'t-claim-done', () => {
  const session = mkSession({
    phase: 'lift',
    performActionHistory: [{ at: 1, action: 'click' }],
  });
  const obl = computeSessionObligation(session);
  assert.match(obl.message, /LIFT/);
  assert.match(obl.message, /save_strategy/);
  // Iteration loop guidance is the load-bearing piece: agent must know
  // that save_strategy_rejected is the iteration signal, not a stop.
  assert.match(obl.message, /audit_token/);
  assert.match(obl.message, /iteration loop/);
  assert.match(obl.message, /Do not tell the user the task is complete/);
});

// ---------- Exploration-session exemption ----------

test('exploration: no-cap no-save click-only session returns null', () => {
  // Field-report shape: agent calls start_session({platform}) with no
  // capability, clicks one nav link to look around, never declares or
  // saves. This is research, not RE — obligation must not fire.
  const session = mkSession({
    declaredCapabilities: [],
    performActionHistory: [{ at: 1, action: 'click', selector: 'a.nav-link' }],
  });
  assert.equal(computeSessionObligation(session), null);
});

test('exploration: no-cap multiple clicks still null', () => {
  const session = mkSession({
    declaredCapabilities: [],
    performActionHistory: [
      { at: 1, action: 'click' },
      { at: 2, action: 'click' },
      { at: 3, action: 'select', value: 'opt' },
      { at: 4, action: 'key_press', key: 'Tab' },
    ],
  });
  assert.equal(computeSessionObligation(session), null);
});

test('exploration: write action ends the exemption (typing is commitment)', () => {
  // Even without a declared capability, typing into a field is a strong
  // commitment signal — the agent did something user-meaningful, runtime
  // should nudge to declare a capability.
  const session = mkSession({
    declaredCapabilities: [],
    performActionHistory: [
      { at: 1, action: 'click' },
      { at: 2, action: 'type', value: 'hello' },
    ],
  });
  const obl = computeSessionObligation(session);
  assert.ok(obl);
  assert.equal(obl.kind, 'lift_required');
});

test('exploration: save_strategy attempt ends the exemption', () => {
  // Once the agent tried to save, they committed — re-fire normally so
  // they can iterate on save audit rejections.
  const session = mkSession({
    declaredCapabilities: [],
    saveAttemptCount: 1,
    performActionHistory: [{ at: 1, action: 'click' }],
  });
  const obl = computeSessionObligation(session);
  assert.ok(obl);
});

test('exploration: declared capability ends the exemption', () => {
  // Belt-and-braces: explicit declaration forces obligation regardless
  // of write/save state. Default mkSession already has one declared
  // capability, so this just asserts the default path keeps firing.
  const session = mkSession({
    performActionHistory: [{ at: 1, action: 'click' }],
  });
  const obl = computeSessionObligation(session);
  assert.ok(obl);
});

// ---------- Nav-only click filter ----------

test('nav-only click followed by via:click navigation is filtered', () => {
  // Field-report case: clicking a top-nav link triggers a real browser
  // navigation captured by the framenavigated listener with via:'click'.
  // No XHR with payload, no form data. Demote to navigation-equivalent.
  const session = mkSession({
    declaredCapabilities: [],
    performActionHistory: [{ at: 1000, action: 'click', selector: 'a' }],
    domNavigations: [{ at: 1100, url: 'https://x.test/inner', via: 'click' }],
  });
  // Even with declaredCapabilities: [] the exemption applies, but assert
  // explicitly that the click was filtered from the mutation count by
  // re-running with a declared capability — obligation must still be
  // null if the only mutation was a nav-only click.
  assert.equal(computeSessionObligation(session), null);
  const committed = mkSession({
    performActionHistory: [{ at: 1000, action: 'click', selector: 'a' }],
    domNavigations: [{ at: 1100, url: 'https://x.test/inner', via: 'click' }],
  });
  assert.equal(computeSessionObligation(committed), null);
});

test('nav-only click filter accepts SPA route channels', () => {
  // pushState / replaceState / popstate / hashchange all count as
  // navigation, not data submit. React/Vue/SvelteKit link clicks land
  // here.
  for (const via of ['pushState', 'replaceState', 'popstate', 'hashchange']) {
    const session = mkSession({
      performActionHistory: [{ at: 1000, action: 'click' }],
      domNavigations: [{ at: 1100, url: 'https://x.test/r', via }],
    });
    assert.equal(computeSessionObligation(session), null, `via:${via} should filter`);
  }
});

test('click followed by via:submit navigation is NOT filtered', () => {
  // A form-post click that redirects fires via:'submit' — that IS a
  // mutation regardless of the navigation aftermath. Filter must not
  // drop these.
  const session = mkSession({
    performActionHistory: [{ at: 1000, action: 'click', selector: 'button[type=submit]' }],
    domNavigations: [{ at: 1100, url: 'https://x.test/posted', via: 'submit' }],
  });
  const obl = computeSessionObligation(session);
  assert.ok(obl);
  assert.equal(obl.mutating_actions, 1);
});

test('click followed by navigation outside the window is NOT filtered', () => {
  // The window is 1500ms post-click; a navigation that lands later was
  // caused by something else (e.g. a subsequent action), so the click
  // stands as a mutation.
  const session = mkSession({
    performActionHistory: [{ at: 1000, action: 'click' }],
    domNavigations: [{ at: 5000, url: 'https://x.test/later', via: 'click' }],
  });
  const obl = computeSessionObligation(session);
  assert.ok(obl);
  assert.equal(obl.mutating_actions, 1);
});

test('mixed: nav-only click + real type still fires (type counted)', () => {
  // Click A (nav-only, filtered) then type X (counted). Obligation
  // should fire on the type alone, mutating_actions: 1.
  const session = mkSession({
    performActionHistory: [
      { at: 1000, action: 'click', selector: 'a.nav' },
      { at: 3000, action: 'type', value: 'query' },
    ],
    domNavigations: [{ at: 1100, url: 'https://x.test/inner', via: 'click' }],
  });
  const obl = computeSessionObligation(session);
  assert.ok(obl);
  assert.equal(obl.mutating_actions, 1);
});

// ---------- No-false-MUST regression ----------
//
// The drive-phase obligation used to claim "Your next tool call MUST be
// end_drive" — but in drive phase, perform_action and reads are still
// admissible. The false MUST trained the agent that klura's MUST claims
// are advisory, which then devalued the structurally-true MUSTs in
// checkpoint / interruption gates. These tests guard the prose against
// re-introducing that lie.

test('drive obligation does not claim "MUST be end_drive next"', () => {
  const session = mkSession({ performActionHistory: [{ at: 1, action: 'click' }] });
  const obl = computeSessionObligation(session);
  assert.doesNotMatch(obl.message, /MUST be end_drive/);
  assert.doesNotMatch(obl.message, /next tool call MUST/i);
  // Honest framing replaces the lie: "before ending your turn".
  assert.match(obl.message, /Before ending your turn/);
  // end_drive is still named — just not as the literal next call.
  assert.match(obl.message, /end_drive/);
});

test('drive obligation has anti-fabrication signal', () => {
  // Drive was the only branch missing "do not tell the user the task is
  // complete." Field report bolagsverket: agent fabricated success
  // ("Strategin är sparad i klura! 🎉") because no signal said don't.
  const session = mkSession({ performActionHistory: [{ at: 1, action: 'click' }] });
  const obl = computeSessionObligation(session);
  assert.match(obl.message, /Do not tell the user the task is complete/);
  assert.match(obl.message, /klura has persisted nothing/);
});

test('drive obligation acknowledges that perform_action / reads are still admissible', () => {
  // The agent must not read the obligation as a hard pre-emption that
  // forces them to call end_drive immediately. Naming the admissible
  // alternatives makes the constraint structurally accurate.
  const session = mkSession({ performActionHistory: [{ at: 1, action: 'click' }] });
  const obl = computeSessionObligation(session);
  assert.match(obl.message, /perform_action/);
  assert.match(obl.message, /Keep driving|keep driving/);
});

test('all three phase variants frame as "before ending your turn", not "MUST be next"', () => {
  // Unifies admissibility-honest framing across drive / triage / lift.
  // No phase claims a tool MUST be the literal next call.
  const drive = computeSessionObligation(
    mkSession({ performActionHistory: [{ at: 1, action: 'click' }] }),
  );
  const triage = computeSessionObligation(
    mkSession({ phase: 'triage', performActionHistory: [{ at: 1, action: 'click' }] }),
  );
  const lift = computeSessionObligation(
    mkSession({ phase: 'lift', performActionHistory: [{ at: 1, action: 'click' }] }),
  );
  for (const obl of [drive, triage, lift]) {
    assert.ok(obl, 'obligation should fire');
    assert.doesNotMatch(obl.message, /next tool call MUST/i);
    assert.doesNotMatch(obl.message, /MUST be `?(end_drive|save_strategy|submit_triage_plan)`?/);
    assert.match(obl.message, /Do not end your turn yet/);
    assert.match(obl.message, /Do not tell the user the task is complete/);
  }
});
