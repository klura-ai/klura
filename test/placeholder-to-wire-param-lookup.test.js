// `validateCallerInputKindsAndEnums` looks up ParamObservations to decide
// whether a caller_input param has UI-click observations (forces `kind:
// "enum"` with `observed_values`) or genuinely accepts free-form text. The
// runtime records observations under the WIRE-level param name (e.g.
// `category` for `?category=italian`), but agent strategies are keyed by
// the PLACEHOLDER name in `notes.params` (e.g. `{{cuisine}}`). When an
// agent renames the placeholder away from the wire name —
// `endpoint: "/api/restaurants?category={{cuisine}}"` — the observation
// lookup needs to resolve the placeholder back to the wire name(s) it's
// templated against, or the must-be-enum gate silently misses the
// UI-click signal and accepts a free-text save it shouldn't have.
//
// Reproduced live in v4 llm-tests/enum-grounding/fresh-discovery — agent
// saved `kind: "text"` for cuisine, audit didn't reject, warm-execute
// then hallucinated `category="pizza"` from prompt with nothing to
// fuzzy-match against. This test pins the placeholder→wire resolution.

import test from 'node:test';
import assert from 'node:assert';

const saveAudit = await import('../dist/gate/save-audit.js');
const { wireParamNamesForPlaceholder, validateCallerInputKindsAndEnums } = saveAudit;

test('wireParamNamesForPlaceholder: query-string param renamed away from wire name', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    endpoint: '/api/restaurants?category={{cuisine}}',
  };
  assert.deepEqual(wireParamNamesForPlaceholder(strategy, 'cuisine'), ['category']);
});

test('wireParamNamesForPlaceholder: query-string param with same wire+placeholder name', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    endpoint: '/api/items?q={{q}}',
  };
  assert.deepEqual(wireParamNamesForPlaceholder(strategy, 'q'), ['q']);
});

test('wireParamNamesForPlaceholder: multiple wire params in URL', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    endpoint: '/api/search?q={{query}}&category={{cuisine}}&page={{cuisine}}',
  };
  // {{cuisine}} appears at both category and page.
  assert.deepEqual(
    wireParamNamesForPlaceholder(strategy, 'cuisine').sort(),
    ['category', 'page'],
  );
  assert.deepEqual(wireParamNamesForPlaceholder(strategy, 'query'), ['q']);
});

test('wireParamNamesForPlaceholder: JSON body field renamed', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    endpoint: '/api/messages',
    body: { text: '{{message}}', to: '{{recipient_id}}' },
  };
  assert.deepEqual(wireParamNamesForPlaceholder(strategy, 'message'), ['text']);
  assert.deepEqual(wireParamNamesForPlaceholder(strategy, 'recipient_id'), ['to']);
});

test('wireParamNamesForPlaceholder: nested JSON body', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    endpoint: '/api/x',
    body: { outer: { inner: '{{value}}' } },
  };
  assert.deepEqual(wireParamNamesForPlaceholder(strategy, 'value'), ['inner']);
});

test('wireParamNamesForPlaceholder: path-segment placeholder returns no wire name', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    endpoint: '/api/users/{{user_id}}/messages',
  };
  // Path segments have no key=value structure; nothing to return.
  assert.deepEqual(wireParamNamesForPlaceholder(strategy, 'user_id'), []);
});

test('wireParamNamesForPlaceholder: placeholder not in strategy returns empty', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    endpoint: '/api/restaurants?category={{cuisine}}',
  };
  assert.deepEqual(wireParamNamesForPlaceholder(strategy, 'nothing'), []);
});

test('validateCallerInputKindsAndEnums: renamed placeholder still fires must-be-enum on UI-click observations', () => {
  // This is the enum-grounding repro: endpoint uses {{cuisine}}, wire param
  // is `category`, observations are recorded under `category`, but the
  // strategy's notes.params is keyed by `cuisine` and provenance says
  // {caller_input: "cuisine"}. The audit must bridge the rename or it lets
  // a `kind: "text"` save through despite click observations on `category`.
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    endpoint: '/api/restaurants?category={{cuisine}}',
    notes: {
      params: {
        cuisine: {
          description: 'Cuisine category.',
          kind: 'text',
        },
      },
    },
  };
  const provenance = {
    endpoint: { caller_input: 'cuisine' },
  };
  const observedParamValues = {
    // Recorded under the WIRE name (what the URL actually carries):
    category: [
      {
        param_name: 'category',
        value: 'italian',
        source: { kind: 'ui_click', label: 'Taste the pride of Napoli' },
        observed_at: Date.now(),
      },
    ],
  };
  const issues = validateCallerInputKindsAndEnums(strategy, provenance, observedParamValues);
  assert.ok(issues.length > 0, 'audit must surface an issue for kind:text + ui-click observations');
  // The specific rejection prose should name the placeholder (what the
  // agent declared) so the agent knows where to fix it.
  assert.ok(
    issues.some((i) => i.includes('notes.params.cuisine')),
    'rejection should name notes.params.cuisine, the placeholder the agent owns',
  );
  // And it should cite the observed click label so the ack-anti-canned
  // path can verify the agent actually read the captured signal.
  assert.ok(
    issues.some((i) => i.includes('Taste the pride of Napoli')),
    'rejection should cite the observed click label(s) for grounding',
  );
});

test('validateCallerInputKindsAndEnums: no observations under either name → no spurious rejection', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    endpoint: '/api/messages',
    body: { text: '{{message}}' },
    notes: { params: { message: { kind: 'text' } } },
  };
  const provenance = { 'body.text': { caller_input: 'message' } };
  const observedParamValues = {};
  const issues = validateCallerInputKindsAndEnums(strategy, provenance, observedParamValues);
  // Without any ui_click observations on either `message` or the wire `text`,
  // the must-be-enum gate stays quiet — kind:"text" is legitimate for a
  // free-form message body.
  assert.equal(issues.length, 0, `no observations, no rejection: got ${JSON.stringify(issues)}`);
});
