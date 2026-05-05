// Snapshot the rendered output of every named Zod schema that produces an
// agent-facing synopsis. A schema edit changes the snapshot — failing test
// forces deliberate review of the agent-visible message. A new hand-written
// hint string sneaking back into the codebase has no snapshot to align with
// — also failing. Either path requires explicit acknowledgment.
//
// Pair with the formatter-coverage block: every Zod issue code must produce
// something more useful than "Invalid input". Catches future Zod versions
// adding codes the formatter forgot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  renderZodSkeletonInline,
  renderZodSkeleton,
  describeShape,
  zodErrorToIssues,
} from '../dist/strategies/schemas/zod-helpers.js';
import {
  paramDocSchema,
  notesParamsSchema,
  notesSchema,
  saveWarningAckSchema,
} from '../dist/strategies/schemas/notes.js';
import { describeNotesAllowlist } from '../dist/strategies/validate/notes.js';

// ---------------------------------------------------------------------------
// Synopsis snapshots — every drift point in one place.
// ---------------------------------------------------------------------------

test('paramDocSchema renders inline with kind enum + observed_values + semantic guidance', () => {
  // The kind enum's `.describe()` carries semantic guidance ("text for
  // counts/numbers, id for opaque server IDs, ...") that surfaces inline as
  // a `// <description>` tail comment — single source, no external doubling.
  const inline = renderZodSkeletonInline(paramDocSchema);
  assert.match(inline, /^\{ description\?: string, kind\?: "id" \| "slug" \| "email" \| "url" \| "uuid" \| "enum" \| "text"  \/\//);
  assert.match(inline, /Counts\/limits\/numbers.*are "text"/);
  assert.match(inline, /, source\?: string, example\?: string, observed_values\?: \{ value: string, label\?: string \}\[\] \}$/);
});

test('describeShape is the project-wide alias for renderZodSkeletonInline', () => {
  assert.strictEqual(
    describeShape(paramDocSchema),
    renderZodSkeletonInline(paramDocSchema),
  );
});

test('notesParamsSchema renders inline as record-of-(string|paramDoc)', () => {
  const inline = renderZodSkeletonInline(notesParamsSchema);
  assert.match(inline, /^\{ <key>: string \| \{ description\?: string, kind\?: "id" \| "slug"/);
  assert.match(inline, /\}\[\] \} \}  \/\/ caller-arg documentation$/);
});

test('saveWarningAckSchema renders inline with required fields and per-field descriptions', () => {
  assert.strictEqual(
    renderZodSkeletonInline(saveWarningAckSchema),
    '{ kind: string  // emitted warning kind, reason: string  // one-sentence justification }',
  );
});

test('notesSchema renders inline as { params?, description?, anchor_type?, save_warnings_acked? }', () => {
  const inline = renderZodSkeletonInline(notesSchema);
  for (const key of ['params', 'description', 'anchor_type', 'save_warnings_acked']) {
    assert.ok(
      inline.includes(`${key}?:`),
      `notesSchema inline missing optional field "${key}":\n${inline}`,
    );
  }
});

test('describeNotesAllowlist emits one bullet per notes top-level field', () => {
  const out = describeNotesAllowlist();
  const lines = out.split('\n');
  assert.strictEqual(lines.length, 4, `expected 4 lines, got:\n${out}`);
  assert.match(lines[0], /^ {2}params: \{ <key>: string \| \{/);
  assert.match(lines[0], /\/\/ caller-arg documentation$/);
  assert.match(lines[1], /^ {2}description: string {2}\/\/ one-line summary/);
  assert.match(
    lines[2],
    /^ {2}anchor_type: "module" \| "protocol" \| "dom" \| "unknown" {2}\/\/ page-script durability/,
  );
  assert.match(
    lines[3],
    /^ {2}save_warnings_acked: \{ kind: string {2}\/\/ emitted warning kind, reason: string {2}\/\/ one-sentence justification \}\[\] {2}\/\/ agent acknowledgement/,
  );
});

test('describeNotesAllowlist contains every key derived from notesSchema.shape', () => {
  const expectedKeys = Object.keys(notesSchema.shape);
  const out = describeNotesAllowlist();
  for (const key of expectedKeys) {
    assert.ok(
      out.includes(`  ${key}:`),
      `describeNotesAllowlist missing key "${key}" derived from notesSchema.shape`,
    );
  }
});

// ---------------------------------------------------------------------------
// Multi-line skeleton — used in save_strategy rejection block. Same source
// (z.toJSONSchema) as the inline form. If both diverge, the skeletons that
// agents see in different surfaces drift apart.
// ---------------------------------------------------------------------------

test('renderZodSkeleton multi-line and renderZodSkeletonInline agree on field set', () => {
  const block = renderZodSkeleton(paramDocSchema);
  const inline = renderZodSkeletonInline(paramDocSchema);
  const fields = inline.match(/\b\w+\??:/g) ?? [];
  assert.ok(fields.length > 0, 'inline rendering yielded no fields');
  for (const f of fields) {
    const fieldName = f.replace('?', '').replace(':', '');
    assert.match(
      block,
      new RegExp(`"${fieldName}"\\??:`),
      `multi-line block missing field "${fieldName}" present inline`,
    );
  }
});

// ---------------------------------------------------------------------------
// Issue-code coverage — the squash sentinel.
// ---------------------------------------------------------------------------

test('invalid_union surfaces per-branch detail (not "Invalid input")', () => {
  const schema = z.union([z.string(), z.number()]);
  const result = schema.safeParse({});
  assert.ok(!result.success);
  const issues = zodErrorToIssues(result.error, 'x');
  assert.ok(issues.length > 0, 'no issues returned');
  for (const issue of issues) {
    assert.ok(
      !/Invalid input$/.test(issue),
      `invalid_union squashed to "Invalid input": ${issue}`,
    );
  }
});

test('strict-object unrecognized_keys names the unknown field', () => {
  const schema = z.object({ a: z.string() }).strict();
  const result = schema.safeParse({ a: 'x', b: 1 });
  assert.ok(!result.success);
  const issues = zodErrorToIssues(result.error, 'note');
  assert.ok(
    issues.some((i) => /has unknown field "b"/.test(i)),
    `expected unknown-field text, got: ${issues.join(' | ')}`,
  );
});

test('record + union (the notes.params shape) yields per-branch detail on object reject', () => {
  const inner = z.object({ kind: z.enum(['id', 'slug']) }).strict();
  const schema = z.record(z.string(), z.union([z.string(), inner]));
  const result = schema.safeParse({ user_id: { kind: 'integer', extra: 'bad' } });
  assert.ok(!result.success);
  const issues = zodErrorToIssues(result.error, 'notes.params');
  const blob = issues.join('\n');
  assert.ok(
    /unknown field "extra"|tried 2 shapes/.test(blob),
    `expected unknown-field or multi-branch detail, got: ${blob}`,
  );
  assert.ok(!/Invalid input$/m.test(blob), `still squashing to "Invalid input":\n${blob}`);
});

test('responseSchema renders inline with from field + semantic guidance', async () => {
  const { responseSchema } = await import('../dist/strategies/schemas/response.js');
  const inline = renderZodSkeletonInline(responseSchema);
  // The new `from` field carries semantic guidance about when to use it.
  assert.match(inline, /from\?: string {2}\/\/ name of a prereq whose bound value IS the strategy result/);
  assert.match(inline, /strategy does NOT fire HTTP \/ WS \/ UI replay/);
  // Existing fields preserved.
  assert.match(inline, /format\?: "json" \| "html"/);
});

test('zod issue codes — none format to bare "Invalid input"', () => {
  const cases = [
    { label: 'invalid_type', schema: z.string(), input: 42 },
    { label: 'too_small (string min)', schema: z.string().min(3), input: 'a' },
    { label: 'too_big (string max)', schema: z.string().max(2), input: 'abc' },
    { label: 'invalid_format (regex)', schema: z.string().regex(/^\d+$/), input: 'abc' },
    { label: 'unrecognized_keys (strict)', schema: z.object({ a: z.string() }).strict(), input: { a: 'x', b: 1 } },
    { label: 'invalid_value (literal)', schema: z.literal('exact'), input: 'other' },
    { label: 'invalid_union', schema: z.union([z.string(), z.number()]), input: {} },
    {
      label: 'custom (refine)',
      schema: z.string().refine((v) => v.startsWith('prefix_'), { message: 'must start with prefix_' }),
      input: 'nope',
    },
  ];
  for (const { label, schema, input } of cases) {
    const result = schema.safeParse(input);
    assert.ok(!result.success, `${label}: expected rejection`);
    const issues = zodErrorToIssues(result.error, 'fld');
    for (const i of issues) {
      assert.ok(
        !/^fld(\.\w+)*: Invalid input$/.test(i),
        `${label} squashed to "Invalid input": ${i}`,
      );
    }
  }
});
