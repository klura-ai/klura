// Drift guard for the Zod-driven save-strategy schema catalog. Asserts
// that every prereq schema's required fields surface in the dynamic
// catalog, so a future schema change can never silently drop a field
// from the agent-facing surface.
//
// With this test in place, adding a required field to any prereq schema in
// `runtime/src/strategies/schemas/prereqs.ts` automatically appears in
// the catalog (and an attempt to render WITHOUT it would fail this test).

import test from 'node:test';
import assert from 'node:assert/strict';

const { z } = await import('zod');
const { renderSaveStrategySchemaMarkdown, getSaveStrategySchema } = await import(
  '../dist/strategies/schema-catalog.js'
);
const { prereqSchemas, PREREQ_KINDS } = await import('../dist/strategies/schemas/prereqs.js');

test('catalog covers every recognized prereq kind', () => {
  const cat = getSaveStrategySchema();
  const catalogKinds = Object.keys(cat.prereqs).sort();
  const expected = [...PREREQ_KINDS].sort();
  assert.deepStrictEqual(catalogKinds, expected);
});

test('catalog exposes every strategy tier', () => {
  const cat = getSaveStrategySchema();
  assert.deepStrictEqual(Object.keys(cat.tiers).sort(), ['fetch', 'page-script', 'recorded-path']);
});

// For each prereq kind, every field marked required by the Zod schema
// must appear in the rendered shape skeleton. Walks `z.toJSONSchema(s)`
// — the same mechanism the renderer uses — and asserts the rendering
// surfaces all of `required[]`.
for (const kind of PREREQ_KINDS) {
  test(`catalog renders every required field for kind "${kind}"`, () => {
    const schema = prereqSchemas[kind];
    const json = z.toJSONSchema(schema, { unrepresentable: 'any' });
    const required = Array.isArray(json.required) ? json.required : [];
    const cat = getSaveStrategySchema();
    const skeleton = cat.prereqs[kind].shape_skeleton;
    for (const field of required) {
      assert.ok(
        skeleton.includes(`"${field}":`),
        `prereq "${kind}" required field "${field}" missing from rendered skeleton:\n${skeleton}`,
      );
    }
  });
}

test('full markdown render includes the original-bug field: js-eval.name', () => {
  const md = renderSaveStrategySchemaMarkdown();
  assert.match(md, /js-eval/);
  // The whole point of this work — `name` is enumerated for js-eval.
  const jsEvalSection = md.split('**`page-extract`**')[0];
  assert.match(jsEvalSection, /"name":/);
});

test('tier-scoped render to "recorded-path" includes prereq kinds (capability prereqs supported)', () => {
  const md = renderSaveStrategySchemaMarkdown({ tier: 'recorded-path' });
  assert.match(md, /Prereq kinds/);
  assert.match(md, /Recorded-path step/);
});

test('tier-scoped render to "fetch" includes prereq kinds', () => {
  const md = renderSaveStrategySchemaMarkdown({ tier: 'fetch' });
  assert.match(md, /Prereq kinds/);
  assert.match(md, /fetch strategy/);
  assert.match(md, /baseUrl/);
  assert.match(md, /endpoint/);
  assert.match(md, /HTTP strategies require `baseUrl` \+ `endpoint`/);
});
