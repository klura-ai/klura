// derivePathSegmentObservations grounds a path-segment templated enum param
// (`/users/{{recipient}}/reply`) by matching the session's captured URLs against
// the endpoint template — the page's sibling links (/users/alice/inbox,
// /users/bob/inbox, …) reveal the recipient enum even though the agent never
// hit the /reply route during discovery. Query-slot grounding
// (deriveLinkUrlObservations) doesn't cover path segments.

import test from 'node:test';
import assert from 'node:assert/strict';

const { derivePathSegmentObservations } = await import(
  '../dist/response/session-observations.js'
);

const BASE = 'https://chat.test';

test('grounds a path-segment param from ≥2 same-shape sibling URLs', () => {
  const obs = derivePathSegmentObservations(
    '/users/{{recipient}}/reply',
    [
      'https://chat.test/users/alice/inbox',
      'https://chat.test/users/bob/inbox',
      'https://chat.test/users/charlie/inbox',
    ],
    BASE,
  );
  const values = obs.filter((o) => o.param_name === 'recipient').map((o) => o.value).sort();
  assert.deepEqual(values, ['alice', 'bob', 'charlie']);
  assert.equal(obs[0].source.kind, 'url_variance');
});

test('requires ≥2 distinct values (a single sibling is not an enum)', () => {
  const obs = derivePathSegmentObservations(
    '/users/{{recipient}}/reply',
    ['https://chat.test/users/alice/inbox'],
    BASE,
  );
  assert.deepEqual(obs, []);
});

test('does not harvest across different shapes (settings route is not a recipient)', () => {
  // /users/settings (2 segs) and /users/alice/inbox (3 segs) are different
  // shapes — only same-shape groups with ≥2 distinct values count.
  const obs = derivePathSegmentObservations(
    '/users/{{recipient}}/reply',
    ['https://chat.test/users/settings', 'https://chat.test/users/alice/inbox'],
    BASE,
  );
  assert.deepEqual(obs, []);
});

test('static prefix must match — unrelated routes excluded', () => {
  const obs = derivePathSegmentObservations(
    '/users/{{recipient}}/reply',
    [
      'https://chat.test/orders/alice/view',
      'https://chat.test/orders/bob/view',
    ],
    BASE,
  );
  assert.deepEqual(obs, []);
});

test('no path-segment params → empty (query-only endpoints unaffected)', () => {
  const obs = derivePathSegmentObservations(
    '/search?q={{query}}',
    ['https://chat.test/search?q=thai', 'https://chat.test/search?q=pizza'],
    BASE,
  );
  assert.deepEqual(obs, []);
});

test('groups by full shape so suffix variance separates distinct routes', () => {
  // /users/*/inbox and /users/*/profile are distinct shapes; each needs its own
  // ≥2 to count. Here inbox has 2 (alice,bob) → harvested; profile has 1 → not.
  const obs = derivePathSegmentObservations(
    '/users/{{recipient}}/reply',
    [
      'https://chat.test/users/alice/inbox',
      'https://chat.test/users/bob/inbox',
      'https://chat.test/users/carol/profile',
    ],
    BASE,
  );
  const values = obs.map((o) => o.value).sort();
  assert.deepEqual(values, ['alice', 'bob']);
});
