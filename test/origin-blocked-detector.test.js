// origin-blocked detector unit tests: pure structural — no driver, no
// pool, no vendor brand names. Five orthogonal signals
// (http_failure, cross_host_redirect, shape_anomaly,
// challenge_iframe_shape, block_page_shape). Fire rule:
// http_failure OR challenge_iframe_shape OR (cross_host_redirect AND
// shape_anomaly). Vendor attribution removed entirely — agents branch
// on shape, never on brand.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectOriginBlocked, isResolvableChallengeShape, isIframeOnlyMinimalContent } =
  await import('../dist/phases/origin-blocked-detector.js');

const RICH_LANDING_TREE =
  'navigation primary\nheading "Welcome"\nmain content area\n' +
  'link About\nlink Products\nheading "Featured"\nbutton "Sign in"\narticle';

const IFRAME_MINIMAL_TREE = 'iframe role: iframe\nbutton "Verify you are human"\niframe inner';

// ---- Fire rule -----------------------------------------------------

test('http_failure alone fires (same host 4xx)', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/blocked',
    finalUrl: 'https://www.example.test/blocked',
    navStatus: 403,
  });
  assert.ok(adv);
  assert.ok(adv.signals.includes('http_failure'));
  assert.equal(adv.signals.length, 1);
});

test('cross_host_redirect + shape_anomaly fires (iframe-dominated proxy landing)', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://challenge.elsewhere.test/index.html',
    navStatus: 200,
    a11yTree: IFRAME_MINIMAL_TREE,
  });
  assert.ok(adv);
  assert.ok(adv.signals.includes('cross_host_redirect'));
  assert.ok(adv.signals.includes('shape_anomaly'));
});

test('cross_host_redirect alone does NOT fire (no shape anomaly)', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://auth.example.test/login',
    navStatus: 200,
    a11yTree: RICH_LANDING_TREE,
  });
  assert.equal(adv, null);
});

test('challenge_iframe_shape fires (cross-origin iframe + minimal landmarks)', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://www.example.test/',
    navStatus: 200,
    a11yTree: 'iframe role: iframe\nbutton "Verify"',
    iframes: [{ src: 'https://challenge.elsewhere.test/widget.html' }],
  });
  assert.ok(adv);
  assert.ok(adv.signals.includes('challenge_iframe_shape'));
});

test('challenge_iframe_shape does NOT fire when iframe is same-origin', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://www.example.test/',
    navStatus: 200,
    a11yTree: 'iframe role: iframe\nbutton x',
    iframes: [{ src: 'https://www.example.test/embed.html' }],
  });
  // No signals fire → no advisory.
  assert.equal(adv, null);
});

test('block_page_shape fires when http_failure AND landmarks >= 5', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://www.example.test/',
    navStatus: 403,
    a11yTree: RICH_LANDING_TREE,
  });
  assert.ok(adv);
  assert.ok(adv.signals.includes('http_failure'));
  assert.ok(adv.signals.includes('block_page_shape'));
});

test('benign 200, same host → no advisory', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/products',
    finalUrl: 'https://www.example.test/products',
    navStatus: 200,
    a11yTree: RICH_LANDING_TREE,
  });
  assert.equal(adv, null);
});

test('null navStatus + benign nav + no a11y → no advisory', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://www.example.test/welcome',
    navStatus: null,
  });
  assert.equal(adv, null);
});

test('malformed URLs → null (no crash)', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'not a url',
    finalUrl: 'also not a url',
    navStatus: null,
  });
  assert.equal(adv, null);
});

// ---- No vendor field anywhere ------------------------------------

test('advisory has NO vendor field (vendor concept removed)', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://www.example.test/',
    navStatus: 403,
  });
  assert.ok(adv);
  assert.equal(Object.prototype.hasOwnProperty.call(adv, 'vendor'), false);
});

// ---- Recommended action prose ------------------------------------

test('recommended_action: INFORMATIONAL lead, never abort-first', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/blocked',
    finalUrl: 'https://www.example.test/blocked',
    navStatus: 403,
  });
  assert.ok(adv);
  assert.match(adv.recommended_action, /^INFORMATIONAL/);
  assert.match(adv.recommended_action, /klura's job is to figure out HOW/);
  assert.match(adv.recommended_action, /Try these first/);
  assert.match(adv.recommended_action, /Last resort/);
  const lastResortIdx = adv.recommended_action.indexOf('Last resort');
  const abortIdx = adv.recommended_action.indexOf('abort_session({kind:');
  assert.ok(
    lastResortIdx > 0 && abortIdx > lastResortIdx,
    'abort_session must appear in the Last resort section, not the lead',
  );
});

test('recommended_action: lists wait+resnap, alternate paths, RE the gate, remote session', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://www.example.test/',
    navStatus: 403,
  });
  assert.ok(adv);
  assert.match(adv.recommended_action, /Wait \+ re-snap/);
  assert.match(adv.recommended_action, /alternate entry paths/);
  assert.match(adv.recommended_action, /RE the challenge surface/);
  assert.match(adv.recommended_action, /start_remote_session/);
});

test('recommended_action: challenge_iframe_shape head mentions iframe + a11y limitation', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://www.example.test/',
    navStatus: 200,
    a11yTree: 'iframe role: iframe\nbutton x',
    iframes: [{ src: 'https://challenge.elsewhere.test/widget' }],
  });
  assert.ok(adv);
  assert.match(adv.recommended_action, /cross-origin iframe/);
  assert.match(adv.recommended_action, /a11y/);
});

test('recommended_action: block_page_shape head mentions styled error page', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://www.example.test/',
    navStatus: 403,
    a11yTree: RICH_LANDING_TREE,
  });
  assert.ok(adv);
  assert.match(adv.recommended_action, /styled page/);
  assert.match(adv.recommended_action, /server-side block/);
});

// ---- Resolvable-challenge shape ----------------------------------

test('isIframeOnlyMinimalContent: iframe-heavy minimal a11y → true', () => {
  assert.equal(isIframeOnlyMinimalContent(IFRAME_MINIMAL_TREE), true);
});

test('isIframeOnlyMinimalContent: rich landing → false', () => {
  assert.equal(isIframeOnlyMinimalContent(RICH_LANDING_TREE), false);
});

test('isIframeOnlyMinimalContent: no iframes → false', () => {
  assert.equal(isIframeOnlyMinimalContent('heading "Hello"\nbutton "Click"'), false);
});

test('isResolvableChallengeShape: cross_host_redirect + iframe-only + 200 → true', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://challenge.elsewhere.test/bot-check',
    navStatus: 200,
    a11yTree: IFRAME_MINIMAL_TREE,
  });
  assert.ok(adv);
  assert.equal(isResolvableChallengeShape(adv, IFRAME_MINIMAL_TREE, 200), true);
});

test('isResolvableChallengeShape: only http_failure (no cross_host_redirect) → false', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://www.example.test/',
    navStatus: 403,
  });
  assert.ok(adv);
  assert.equal(isResolvableChallengeShape(adv, 'iframe', 403), false);
});

test('isResolvableChallengeShape: nav status 5xx → false (upstream unhealthy)', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://challenge.elsewhere.test/bot-check',
    navStatus: 500,
    a11yTree: IFRAME_MINIMAL_TREE,
  });
  assert.ok(adv);
  assert.equal(isResolvableChallengeShape(adv, 'iframe button', 500), false);
});

test('isResolvableChallengeShape: rich a11y after cross-host redirect → false', () => {
  const adv = detectOriginBlocked({
    requestedUrl: 'https://www.example.test/',
    finalUrl: 'https://login.elsewhere.test/auth',
    navStatus: 200,
    a11yTree: RICH_LANDING_TREE,
  });
  // Cross-host + rich a11y = legit cross-host redirect (login, etc) — no fire.
  assert.equal(adv, null);
});
