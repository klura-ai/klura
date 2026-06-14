// detectRecordedPathInlinesLookup correlates a /search|/lookup XHR to the
// click/type that fired it (by timestamp) instead of scanning the whole
// session's captured-URL set — so an unrelated exploration navigate to /search
// for a DIFFERENT capability no longer false-flags a recorded-path saved later.

import test from 'node:test';
import assert from 'node:assert/strict';

const { detectRecordedPathInlinesLookup } = await import(
  '../dist/gate/save-warnings-recorded-path-lookup.js'
);

const RP = { strategy: 'recorded-path', steps: [] };

test('flags a /search XHR fired shortly after a click (real inlined lookup)', () => {
  const actions = [
    { action: 'type', at: 1000 },
    { action: 'click', at: 2000 },
  ];
  const intercepted = [{ url: 'https://x.test/restaurants/search?q=thai', timestamp: 2300 }];
  const w = detectRecordedPathInlinesLookup(RP, intercepted, actions, 'place_order');
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'recorded_path_inlines_lookup');
});

test('does NOT flag a /search from a direct navigate (exploration, not click-triggered)', () => {
  // The platform-map false-positive: /search captured during exploration earlier
  // in a map session, not triggered by the recorded path's click/type.
  const actions = [
    { action: 'navigate', at: 1000 },
    { action: 'type', at: 5000 },
    { action: 'click', at: 6000 },
  ];
  const intercepted = [{ url: 'https://x.test/restaurants/search?q=thai', timestamp: 1100 }];
  assert.deepEqual(detectRecordedPathInlinesLookup(RP, intercepted, actions, 'place_order'), []);
});

test('suppressed when the capability itself is a lookup_*', () => {
  const actions = [{ action: 'click', at: 2000 }];
  const intercepted = [{ url: 'https://x.test/restaurants/search?q=thai', timestamp: 2300 }];
  assert.deepEqual(
    detectRecordedPathInlinesLookup(RP, intercepted, actions, 'lookup_restaurant_by_name'),
    [],
  );
});

test('no warning when there are no click/type actions at all', () => {
  const actions = [{ action: 'navigate', at: 1000 }];
  const intercepted = [{ url: 'https://x.test/restaurants/search?q=thai', timestamp: 1100 }];
  assert.deepEqual(detectRecordedPathInlinesLookup(RP, intercepted, actions, 'place_order'), []);
});
