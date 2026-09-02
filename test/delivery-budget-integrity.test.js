// Verification fires `execute()` directly and therefore reads a result body
// whole. The delivery path does not: a body over the inline budget reaches an
// agent compacted, or replaced by a truncation notice. So a strategy could
// verify clean against bytes its own caller never receives.
//
// Observed on reddit: a page-script returning the raw 30 KB listing verified,
// went active, and every warm caller got `<truncated: 30850 chars…>` — two
// complete posts out of ten, in a string that does not parse.

import test from 'node:test';
import assert from 'node:assert/strict';

const { assessDeliveryBudget, describeCollectionIntegrityFinding, SEMANTIC_REVIEW_REASONS } =
  await import('../dist/execution/collection-emptiness.js');
const { EXECUTE_RESULT_BODY_INLINE_BUDGET } = await import('../dist/response/response-size.js');

const BUDGET = EXECUTE_RESULT_BODY_INLINE_BUDGET;

// A strategy that declares where its rows live, which is what scopes every
// collection-integrity check.
function strategy() {
  return {
    schema_version: 1,
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/items',
    response: { format: 'json', extract: undefined },
    notes: {
      params: {},
      returns: { items: 'the rows' },
    },
  };
}

function rows(count, extraCharsPerRow = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `t3_${i}`,
    title: `Post ${i}`,
    ...(extraCharsPerRow > 0 ? { selftext: 'x'.repeat(extraCharsPerRow) } : {}),
  }));
}

test('a shaped body under the budget produces no finding', () => {
  const body = { items: rows(10) };
  assert.ok(JSON.stringify(body).length < BUDGET, 'fixture must actually be under budget');

  assert.deepEqual(assessDeliveryBudget(strategy(), body, BUDGET), []);
});

test('an unshaped body over the budget is flagged', () => {
  const body = { items: rows(10, 2500) };
  const total = JSON.stringify(body).length;
  assert.ok(total > BUDGET, 'fixture must actually be over budget');

  const findings = assessDeliveryBudget(strategy(), body, BUDGET);
  assert.equal(findings.length, 1);

  const finding = findings[0];
  assert.equal(finding.reason, SEMANTIC_REVIEW_REASONS.collectionExceedsDeliveryBudget);
  assert.equal(finding.total_chars, total);
  assert.equal(finding.budget_chars, BUDGET);
  assert.equal(finding.row_count, 10, 'the rows are real — that is what makes this worth saying');
});

test('the finding describes itself in terms an author can act on', () => {
  const [finding] = assessDeliveryBudget(strategy(), { items: rows(10, 2500) }, BUDGET);
  const text = describeCollectionIntegrityFinding(finding);

  assert.match(text, /10 rows/);
  assert.match(text, new RegExp(String(BUDGET)));
  assert.match(
    text,
    /truncation notice/,
    'the consequence is what distinguishes this from a size warning nobody acts on',
  );
});

test('a body with no declared collection is out of scope', () => {
  const bare = { schema_version: 1, strategy: 'fetch', method: 'GET', baseUrl: 'http://example.test', endpoint: '/x', notes: { params: {} } };
  const huge = { blob: 'x'.repeat(BUDGET * 2) };

  assert.deepEqual(
    assessDeliveryBudget(bare, huge, BUDGET),
    [],
    'a capability returning one large document has a different conversation to have',
  );
});

test('exactly at the budget is not over it', () => {
  const filler = 'x'.repeat(Math.max(0, BUDGET - JSON.stringify({ items: [{ id: 't3_0', title: 'p', selftext: '' }] }).length));
  const body = { items: [{ id: 't3_0', title: 'p', selftext: filler }] };
  assert.equal(JSON.stringify(body).length, BUDGET, 'fixture must sit exactly on the boundary');

  assert.deepEqual(assessDeliveryBudget(strategy(), body, BUDGET), []);
});
