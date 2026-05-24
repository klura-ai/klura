// Numeric-range URL params (?limit=, ?offset=, ?page=) get incidentally
// captured when pagination buttons fire requests. The click values are
// arbitrary positions in a numeric range, not members of an enumerable
// option set — so `detectUngroundedEnumPlaceholder` and the kind:"text"+
// clicks branch in `validateCallerInputParamKind` skip them.
//
// These tests pin the skip so a future refactor doesn't accidentally
// resurrect the false-positive against integer-only observations.

import test from 'node:test';
import assert from 'node:assert';

const saveWarnings = await import('../dist/gate/save-warnings.js');
const saveAudit = await import('../dist/gate/save-audit.js');
const observationShape = await import('../dist/gate/observation-shape.js');
const { detectUngroundedEnumPlaceholder } = saveWarnings;
const { validateCallerInputKindsAndEnums } = saveAudit;
const { observedValuesAreIntegerRange } = observationShape;

test('observedValuesAreIntegerRange: empty input returns false', () => {
  assert.strictEqual(observedValuesAreIntegerRange([]), false);
});

test('observedValuesAreIntegerRange: all bare integers returns true', () => {
  const obs = [{ value: '10' }, { value: '20' }, { value: '50' }];
  assert.strictEqual(observedValuesAreIntegerRange(obs), true);
});

test('observedValuesAreIntegerRange: negative integers accepted (delta-shaped ranges)', () => {
  const obs = [{ value: '-5' }, { value: '0' }, { value: '5' }];
  assert.strictEqual(observedValuesAreIntegerRange(obs), true);
});

test('observedValuesAreIntegerRange: any non-integer value returns false', () => {
  const obs = [{ value: '10' }, { value: 'italian' }, { value: '20' }];
  assert.strictEqual(observedValuesAreIntegerRange(obs), false);
});

test('observedValuesAreIntegerRange: decimal strings return false', () => {
  const obs = [{ value: '10.5' }, { value: '20' }];
  assert.strictEqual(observedValuesAreIntegerRange(obs), false);
});

test('detectUngroundedEnumPlaceholder: skips ?limit= with integer-only click values', () => {
  const data = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/api/messages?limit={{limit}}',
    notes: {
      params: {
        limit: { kind: 'text', example: '50' },
      },
    },
  };
  const observedParamValues = {
    limit: [
      { value: '10', source: { kind: 'ui_click', label: '10' } },
      { value: '20', source: { kind: 'ui_click', label: '20' } },
    ],
  };
  const warnings = detectUngroundedEnumPlaceholder(data, observedParamValues);
  assert.deepStrictEqual(
    warnings,
    [],
    'numeric-range param must not trigger ungrounded_enum_placeholder',
  );
});

test('detectUngroundedEnumPlaceholder: still fires on string-shaped click values', () => {
  const data = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/api/restaurants?category={{cuisine}}',
    notes: {
      params: {
        cuisine: { kind: 'text' },
      },
    },
  };
  const observedParamValues = {
    category: [
      { value: 'italian', source: { kind: 'ui_click', label: 'Italian' } },
      { value: 'mexican', source: { kind: 'ui_click', label: 'Mexican' } },
    ],
  };
  const warnings = detectUngroundedEnumPlaceholder(data, observedParamValues);
  assert.strictEqual(warnings.length, 1, 'string-shaped enum still flagged');
  assert.strictEqual(warnings[0].kind, 'ungrounded_enum_placeholder');
});

test('validateCallerInputKindsAndEnums: kind:"text" + integer-only clicks → no issues', () => {
  const data = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/api/messages?limit={{limit}}',
    notes: {
      params: {
        limit: { kind: 'text', example: '50' },
      },
    },
  };
  const provenance = {
    endpoint: { caller_input: 'limit' },
  };
  const observedParamValues = {
    limit: [
      { value: '10', source: { kind: 'ui_click', label: '10' } },
      { value: '20', source: { kind: 'ui_click', label: '20' } },
    ],
  };
  const issues = validateCallerInputKindsAndEnums(data, provenance, observedParamValues);
  assert.deepStrictEqual(
    issues,
    [],
    'kind:"text" on integer-range param must not require text_kind_justification',
  );
});

test('detectUngroundedEnumPlaceholder: Discord-snowflake-shaped IDs (19-digit) are integer-only → skipped', () => {
  // Repro: discord fetch_messages where channel_id is captured via UI clicks
  // through the channel sidebar. snowflakes are 18-19 digit integers — they
  // pass the integer-range test, so the enum-grounding warning skips. The
  // agent can declare kind:"id" or kind:"text" without being forced into
  // text_kind_justification or into kind:"enum" + observed_values.
  const data = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://discord.com',
    endpoint: '/api/v9/channels/{{channel_id}}/messages',
    notes: {
      params: {
        channel_id: { kind: 'id' },
      },
    },
  };
  // The detector parses the endpoint as URL — path-segment placeholders
  // don't show up in searchParams, so this case isn't actually flagged by
  // detectUngroundedEnumPlaceholder. Use a query-shape repro instead.
  const queryData = {
    ...data,
    endpoint: '/api/v9/channels/messages?channel_id={{channel_id}}',
  };
  const observedParamValues = {
    channel_id: [
      { value: '1103262088631169024', source: { kind: 'ui_click', label: 'Shibo' } },
      { value: '1234567890123456789', source: { kind: 'ui_click', label: 'Adam' } },
    ],
  };
  const warnings = detectUngroundedEnumPlaceholder(queryData, observedParamValues);
  assert.deepStrictEqual(
    warnings,
    [],
    'snowflake-id click observations must skip the enum-grounding warning',
  );
});

test('validateCallerInputKindsAndEnums: kind:"id" + snowflake clicks → no text_kind_justification demand', () => {
  const data = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://discord.com',
    endpoint: '/api/v9/channels/{{channel_id}}/messages',
    notes: {
      params: {
        channel_id: { kind: 'id', example: '1103262088631169024' },
      },
    },
  };
  // literal_provenance answer pretends the endpoint is templated for the
  // purpose of caller-input registration; what matters is the kind:"id" +
  // UI-click + integer-only check.
  const provenance = {
    endpoint: { caller_input: 'channel_id' },
  };
  const observedParamValues = {
    channel_id: [
      { value: '1103262088631169024', source: { kind: 'ui_click', label: 'Shibo' } },
    ],
  };
  const issues = validateCallerInputKindsAndEnums(data, provenance, observedParamValues);
  assert.deepStrictEqual(
    issues,
    [],
    'snowflake-id clicks must not force text_kind_justification on kind:"id"',
  );
});

test('validateCallerInputKindsAndEnums: kind:"text" + string-shaped clicks still requires justification', () => {
  const data = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/api/restaurants?category={{cuisine}}',
    notes: {
      params: {
        cuisine: { kind: 'text' },
      },
    },
  };
  const provenance = {
    endpoint: { caller_input: 'cuisine' },
  };
  const observedParamValues = {
    cuisine: [
      { value: 'italian', source: { kind: 'ui_click', label: 'Italian' } },
      { value: 'mexican', source: { kind: 'ui_click', label: 'Mexican' } },
    ],
  };
  const issues = validateCallerInputKindsAndEnums(data, provenance, observedParamValues);
  assert.ok(
    issues.length > 0,
    'string-shaped enum without grounding still must reject',
  );
});
