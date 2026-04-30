// Unit tests for the recorded-path step validator and optional-step shape.
//
// Covers:
//   - validateStrategyShape rejects click/type/select steps without locators
//   - validateStrategyShape rejects locators where both a11y and css are
//     missing or empty
//   - validateStrategyShape rejects locators.a11y missing a role
//   - validateStrategyShape rejects non-boolean optional values
//   - validateStrategyShape accepts a well-formed recorded-path with both
//     primary locators and alternatives
//   - navigate + wait steps are exempt from the locators requirement

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-recorded-path-shape-'));
process.env.KLURA_HOME = TMP;

const { validateStrategyShape } = await import('../dist/strategies/skills.js');

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeStep(overrides = {}) {
  return {
    id: 'click_accept_all',
    action: 'click',
    locators: {
      a11y: { role: 'button', name: 'Accept all' },
      css: "button[data-testid='accept-button']",
    },
    ...overrides,
  };
}

test('accepts recorded-path with primary a11y + css locators', () => {
  validateStrategyShape({
    strategy: 'recorded-path',
    steps: [makeStep()],
  });
});

test('accepts recorded-path with alternatives array', () => {
  validateStrategyShape({
    strategy: 'recorded-path',
    steps: [
      makeStep({
        locators: {
          a11y: { role: 'button', name: 'Accept all' },
          css: "button[data-testid='accept-button']",
          alternatives: [
            { a11y: { role: 'button', name: 'OK' } },
            { css: '.cookie-ok-btn' },
          ],
        },
      }),
    ],
  });
});

test('accepts optional: true / false', () => {
  validateStrategyShape({
    strategy: 'recorded-path',
    steps: [makeStep({ optional: true }), makeStep({ id: 'click_accept_all_2', optional: false })],
  });
});

test('rejects optional with a non-boolean value', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ optional: 'true' })],
      }),
    /optional must be a boolean/,
  );
});

test('rejects click step with no locators object', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [{ id: 'click_accept', action: 'click', selector: 'text=Accept all' }],
      }),
    /requires a "locators" object/,
  );
});

test('rejects click step with empty locators object', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [{ id: 'click_empty', action: 'click', locators: {} }],
      }),
    /at least one of \{a11y, css\}/,
  );
});

test('rejects locators.a11y without a role', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [
          {
            id: 'click_no_role',
            action: 'click',
            locators: { a11y: { name: 'Accept all' }, css: '.cookie-btn' },
          },
        ],
      }),
    /locators\.a11y\.role must be a non-empty string/,
  );
});

test('rejects alternatives with empty entries', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [
          makeStep({
            locators: {
              css: 'button#submit',
              alternatives: [{}],
            },
          }),
        ],
      }),
    /alternatives\[0\] must declare at least one of \{a11y, css\}/,
  );
});

test('navigate step is exempt from locators requirement', () => {
  validateStrategyShape({
    strategy: 'recorded-path',
    steps: [
      { id: 'navigate_home', action: 'navigate', url: 'https://example.com' },
      makeStep(),
    ],
  });
});

test('wait step is exempt from locators requirement', () => {
  validateStrategyShape({
    strategy: 'recorded-path',
    steps: [
      { id: 'wait_loaded', action: 'wait', condition: 'selector', waitSelector: '.loaded', timeout: 3000 },
      makeStep(),
    ],
  });
});

test('rejects type step without locators', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [{ id: 'type_search', action: 'type', selector: '#search', value: 'hello' }],
      }),
    /requires a "locators" object/,
  );
});

test('rejects select step without locators', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [{ id: 'select_country', action: 'select', selector: '#country', value: 'SE' }],
      }),
    /requires a "locators" object/,
  );
});

test('accepts key_press action', () => {
  validateStrategyShape({
    strategy: 'recorded-path',
    steps: [
      { id: 'navigate_home', action: 'navigate', url: 'https://example.com' },
      { id: 'key_ctrl_end', action: 'key_press', key: 'Control+End' },
    ],
  });
});

test('rejects unknown action names at save time', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [{ action: 'scroll', value: '0,400' }],
      }),
    /not a recognized recorded-path action/,
  );
});

test('rejects camelCase "keyPress" with a useful hint', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [{ action: 'keyPress', key: 'Enter' }],
      }),
    /key_press.*key.*field/,
  );
});

test('rejects hover action with a useful hint', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [
          makeStep({ action: 'hover' }),
        ],
      }),
    /hover.*not supported/,
  );
});

test('accepts fill_editor action with locators + value', () => {
  validateStrategyShape({
    strategy: 'recorded-path',
    steps: [
      makeStep({
        action: 'fill_editor',
        locators: {
          a11y: { role: 'textbox', name: 'Message' },
          css: 'div[contenteditable="true"][role="textbox"]',
        },
        value: '{{message}}',
      }),
    ],
  });
});

test('rejects fill_editor without locators (same rule as type)', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [{ id: 'type_body', action: 'fill_editor', selector: '.composer', value: 'hi' }],
      }),
    /requires a "locators" object/,
  );
});

// ---- post-navigation extract shape (response field) ----

test('accepts recorded-path with response: {format: "html", extract: {...}}', () => {
  validateStrategyShape({
    strategy: 'recorded-path',
    steps: [{ id: 'navigate_home', action: 'navigate', url: 'https://example.com' }],
    response: {
      format: 'html',
      extract: {
        title: { selector: 'h1' },
        items: { selector: '.item', multiple: true },
      },
    },
  });
});

test('rejects recorded-path response with format: "json"', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [{ id: 'navigate_home', action: 'navigate', url: 'https://example.com' }],
        response: { format: 'json', extract: { title: { selector: 'h1' } } },
      }),
    /response\.format must be "html"/,
  );
});

test('rejects recorded-path response with empty extract', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [{ id: 'navigate_home', action: 'navigate', url: 'https://example.com' }],
        response: { format: 'html', extract: {} },
      }),
    /requires a non-empty "extract"/,
  );
});

// ---- step id validation (#36) ----

test('rejects click step missing id', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [
          {
            action: 'click',
            locators: { a11y: { role: 'button', name: 'OK' }, css: 'button.ok' },
          },
        ],
      }),
    /id is required/,
  );
});

test('rejects navigate step missing id', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [{ action: 'navigate', url: 'https://example.com' }],
      }),
    /id is required/,
  );
});

test('rejects step with id that does not match the regex (camelCase)', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: 'clickAccept' })],
      }),
    /not a valid step id/,
  );
});

test('rejects step with id starting with a digit', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: '1_click' })],
      }),
    /not a valid step id/,
  );
});

test('rejects step with id shorter than 3 chars', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: 'ab' })],
      }),
    /not a valid step id/,
  );
});

test('rejects reserved-word id "step"', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: 'step' })],
      }),
    /reserved word/,
  );
});

test('rejects purely numeric id with descriptive prose', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: '12345' })],
      }),
    /purely numeric.*pure numbers aren't descriptive/,
  );
});

test('rejects pure integer-looking id "42"', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: '42' })],
      }),
    /purely numeric/,
  );
});

test('rejects kebab-case id with snake_case suggestion', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: 'click-send' })],
      }),
    /snake_case, not kebab-case or uuid.*click_send/,
  );
});

test('rejects UUID-with-dashes id as kebab-case', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' })],
      }),
    /snake_case, not kebab-case or uuid/,
  );
});

test('rejects 32-char hex-only id as hash-like', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: 'a'.repeat(32) })],
      }),
    /looks like a hash\/hex string/,
  );
});

test('rejects 16-char hex-only id at the boundary', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: '0123456789abcdef' })],
      }),
    /looks like a hash\/hex string/,
  );
});

test('rejects duplicate ids within one strategy with collision suggestion', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: 'click_send' }), makeStep({ id: 'click_send' })],
      }),
    /collides with steps\[0\]\.id/,
  );
});

test('accepts distinct snake_case ids', () => {
  validateStrategyShape({
    strategy: 'recorded-path',
    steps: [
      makeStep({ id: 'click_send' }),
      makeStep({ id: 'click_confirm' }),
      makeStep({ id: 'key_enter', action: 'key_press', key: 'Enter' }),
    ],
  });
});

// ---- auto-step-id heuristic (non-LLM paths) ----

test('assignAutoStepIds: deterministic ids from locator a11y names', async () => {
  const { assignAutoStepIds } = await import('../dist/strategies/auto-step-id.js');
  const steps = [
    { action: 'navigate', url: 'https://example.com/inbox' },
    { action: 'click', locators: { a11y: { role: 'button', name: 'Compose' } } },
    { action: 'type', locators: { a11y: { role: 'textbox', name: 'Recipient' } }, value: 'bob' },
    { action: 'click', locators: { a11y: { role: 'button', name: 'Send' } } },
  ];
  assignAutoStepIds(steps);
  assert.equal(steps[0].id, 'navigate_inbox');
  assert.equal(steps[1].id, 'click_compose');
  assert.equal(steps[2].id, 'type_recipient');
  assert.equal(steps[3].id, 'click_send');
});

test('assignAutoStepIds: collisions get _2, _3 suffix', async () => {
  const { assignAutoStepIds } = await import('../dist/strategies/auto-step-id.js');
  const steps = [
    { action: 'click', locators: { a11y: { role: 'button', name: 'OK' } } },
    { action: 'click', locators: { a11y: { role: 'button', name: 'OK' } } },
    { action: 'click', locators: { a11y: { role: 'button', name: 'OK' } } },
  ];
  assignAutoStepIds(steps);
  assert.equal(steps[0].id, 'click_ok');
  assert.equal(steps[1].id, 'click_ok_2');
  assert.equal(steps[2].id, 'click_ok_3');
});

test('assignAutoStepIds: falls back to {action}_{index} when slug is empty', async () => {
  const { assignAutoStepIds } = await import('../dist/strategies/auto-step-id.js');
  const steps = [
    { action: 'click', locators: { css: '#' } },
    { action: 'click', locators: { css: '   ' } },
  ];
  assignAutoStepIds(steps);
  // CSS slugify handles '#' and whitespace — the heuristic may fall back
  // to `click_0` / `click_1` or something unique.
  assert.ok(steps[0].id && steps[0].id.length > 0);
  assert.ok(steps[1].id && steps[1].id.length > 0);
  assert.notEqual(steps[0].id, steps[1].id);
});

// ---- notes vs runtime_meta separation ----

test('rejects discovered_at_step_id on notes (runtime-owned, lives on runtime_meta)', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: 'click_send' })],
        notes: { discovered_at_step_id: 'click_send' },
      }),
    /notes has unknown field "discovered_at_step_id"/,
  );
});

test('rejects discovered_from_url on notes (runtime-owned, lives on runtime_meta)', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'recorded-path',
        steps: [makeStep({ id: 'click_send' })],
        notes: { discovered_from_url: 'https://example.com/x' },
      }),
    /notes has unknown field "discovered_from_url"/,
  );
});

test('rejects response field on page-script tier', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'page-script',
        baseUrl: 'https://example.com',
        endpoint: '/api/x',
        response: { format: 'html', extract: { title: { selector: 'h1' } } },
      }),
    /only valid on fetch and recorded-path/,
  );
});
