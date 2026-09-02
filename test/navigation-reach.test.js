// A prereq that navigates and then evaluates assumes the document it evaluates
// against is the one it asked for. An origin that redirects some visitors — a
// consent interstitial, a region gate, a login wall — breaks that assumption
// under a 200, and the expression runs against the wrong page.
//
// These pin the comparison, the gate-vs-moved distinction that makes the
// finding actionable, and the rule that an unmakeable comparison never accuses.

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  assessNavigationReach,
  describeNavigationReachMiss,
  navigationReachMissFrom,
  NavigationReachError,
} = await import('../dist/execution/navigation-reach.js');

const PLACE = 'https://www.google.com/maps/place/Bakery/data=!1s0x1:0x2';

test('arrival: same origin and path is an arrival', () => {
  assert.equal(assessNavigationReach(PLACE, PLACE), null);
});

test('arrival: query and hash drift do not count as a miss', () => {
  // Servers routinely normalize, append tracking params and rewrite fragments
  // on a page that IS the requested one.
  assert.equal(
    assessNavigationReach(PLACE, `${PLACE}?entry=ttu&g_ep=Egoy#frag`),
    null,
  );
});

test('arrival: a same-origin path change alone is NOT a miss', () => {
  // Deliberate under-reporting. Single-page apps rewrite their own path after
  // load — a maps place page appends the viewport within seconds — so treating
  // a path change as a miss would fire on healthy navigations far more often
  // than on real ones. A same-origin gate is still caught, via the carried
  // parameter below.
  assert.equal(assessNavigationReach(PLACE, 'https://www.google.com/sorry/index'), null);
  assert.equal(
    assessNavigationReach(PLACE, 'https://www.google.com/maps/place/Bakery/@57,11,16z/data=!1s0x1:0x2'),
    null,
    'the viewport rewrite this very site performs must read as an arrival',
  );
});

test('miss: a same-origin gate is still caught when it carries the URL forward', () => {
  const miss = assessNavigationReach(PLACE, `https://www.google.com/sorry/index?continue=${encodeURIComponent(PLACE)}`);
  assert.ok(miss, 'same origin, but it is holding the requested URL to return to');
  assert.equal(miss.requested_carried_as_parameter, true);
});

test('gate: the requested URL held as a query value marks a gate, not a moved page', () => {
  const reached = `https://consent.google.com/m?continue=${encodeURIComponent(PLACE)}&gl=SE`;
  const miss = assessNavigationReach(PLACE, reached);
  assert.ok(miss);
  assert.equal(miss.requested_carried_as_parameter, true);
  assert.match(describeNavigationReachMiss(miss, 'read_photo_page'), /holding it to return to/);
  assert.match(describeNavigationReachMiss(miss, 'read_photo_page'), /not a page that moved/);
});

test('gate: the parameter name is never read — only that a value carries the URL', () => {
  // ?continue= / ?return_to= / ?next= all vary by site; matching the name would
  // be a keyword bank. Containment is the structural fact.
  for (const key of ['continue', 'return_to', 'next', 'dest', 'zzz']) {
    const miss = assessNavigationReach(
      PLACE,
      `https://gate.example/x?${key}=${encodeURIComponent(PLACE)}`,
    );
    assert.equal(miss.requested_carried_as_parameter, true, `failed for ?${key}=`);
  }
});

test('moved: a cross-origin destination that does not carry the URL reads as moved', () => {
  const miss = assessNavigationReach(PLACE, 'https://other.example/maps/place/Other');
  assert.ok(miss);
  assert.equal(miss.requested_carried_as_parameter, false);
  assert.match(describeNavigationReachMiss(miss, 'p'), /moved, renamed or withdrawn/);
});

test('silence: an unparseable URL on either side never accuses', () => {
  // A comparison that cannot be made must not produce a finding.
  assert.equal(assessNavigationReach('not a url', PLACE), null);
  assert.equal(assessNavigationReach(PLACE, '///'), null);
  assert.equal(assessNavigationReach('', ''), null);
});

test('miss: landing on about:blank is a miss — the navigation went nowhere real', () => {
  const miss = assessNavigationReach(PLACE, 'about:blank');
  assert.ok(miss, 'a blank document is not the page that was requested');
  assert.equal(miss.requested_carried_as_parameter, false);
});

test('recovery: the miss is found through a wrapped cause chain', () => {
  const miss = assessNavigationReach(PLACE, 'https://consent.google.com/m');
  const inner = new NavigationReachError('never arrived', miss, 'read_photo_page');
  const wrapped = new Error('execute failed', { cause: new Error('prereq failed', { cause: inner }) });
  assert.deepEqual(navigationReachMissFrom(wrapped), miss);
});

test('recovery: an ordinary failure keeps its ordinary handling', () => {
  assert.equal(navigationReachMissFrom(new Error('selector not found')), null);
  assert.equal(navigationReachMissFrom(undefined), null);
});

test('recovery: a self-referential cause chain terminates', () => {
  const a = new Error('a');
  a.cause = a;
  assert.equal(navigationReachMissFrom(a), null);
});
