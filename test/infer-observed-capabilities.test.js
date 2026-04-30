// Map-mode auto-inference: derive observed_capabilities from
// runtime-collected url_graph + forms_seen so the agent doesn't have to call
// `record_observed_capability` for every page they walked. Pure function over
// SessionNavigation[] / SessionFormObservation[] / existing logbook entries.

import test from 'node:test';
import assert from 'node:assert/strict';

const { inferObservedCapabilitiesFromGraph } = await import(
  '../dist/working-dir/url-graph.js'
);

function nav(url, atOffset = 0) {
  return { at: Date.now() + atOffset, url, via: 'nav' };
}

function form(url, action, method, fieldNames = []) {
  return {
    at: Date.now(),
    url,
    action,
    method,
    fields: fieldNames.map((n) => ({ name: n, type: 'text' })),
  };
}

test('single POST form → infers one write capability', () => {
  const out = inferObservedCapabilitiesFromGraph(
    [],
    [form('https://x.example/cart', 'https://x.example/api/cart/add', 'POST', ['item', 'qty'])],
    [],
  );
  assert.equal(out.length, 1);
  const e = out[0];
  assert.equal(e.name, 'add_to_cart');
  assert.equal(e.evidence.source, 'auto_inferred_graph_map');
  assert.equal(e.evidence.kind, 'form_post');
  assert.equal(e.evidence.method, 'POST');
  assert.deepEqual(e.evidence.fields, ['item', 'qty']);
});

test('three navigations to distinct routes → three read capabilities', () => {
  const out = inferObservedCapabilitiesFromGraph(
    [
      nav('https://x.example/orders'),
      nav('https://x.example/checkout', 10),
      nav('https://x.example/restaurants/r1', 20),
    ],
    [],
    [],
  );
  const names = out.map((e) => e.name).sort();
  assert.deepEqual(names, ['view_checkout', 'view_orders', 'view_restaurants'].sort());
  for (const e of out) {
    assert.equal(e.evidence.source, 'auto_inferred_graph_map');
    assert.equal(e.evidence.kind, 'page_visit');
  }
});

test('form action overlapping a navigation URL → form wins (no duplicate read)', () => {
  const out = inferObservedCapabilitiesFromGraph(
    [nav('https://x.example/checkout')],
    [form('https://x.example/checkout', 'https://x.example/checkout', 'POST', ['email'])],
    [],
  );
  // Only the form-derived capability should land.
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'checkout');
  assert.equal(out[0].evidence.kind, 'form_post');
});

test('pre-existing manual entry with same name → not overwritten', () => {
  const existing = [
    {
      name: 'view_orders',
      evidence: { source: 'ui', selector: '[data-orders]' },
      why_not_lifted: 'turn_budget',
      first_observed_at: '2026-01-01T00:00:00Z',
      last_observed_at: '2026-01-01T00:00:00Z',
      observed_in_sessions: 1,
    },
  ];
  const out = inferObservedCapabilitiesFromGraph(
    [nav('https://x.example/orders')],
    [],
    existing,
  );
  // The inference skipped view_orders because it already exists.
  assert.equal(out.find((e) => e.name === 'view_orders'), undefined);
});

test('GET form → no inference (only write methods generate write capabilities)', () => {
  const out = inferObservedCapabilitiesFromGraph(
    [],
    [form('https://x.example/search', 'https://x.example/search', 'GET', ['q'])],
    [],
  );
  assert.equal(out.length, 0);
});
