// `navigate` is a valid action on perform_action. Implementation lives at
// runtime/src/tools/perform-action.ts:504-509 (case 'navigate' calls
// driver.navigate). The MCP schema in mcp/tools.js must include it in the
// action enum so agents see it as an option — without that, agents fall
// back to js_eval('window.location.href = ...') which costs an extra round
// and is non-obvious.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('perform_action MCP schema includes "navigate" in the action enum', () => {
  // Stub klura — defineTools only reads constants for compose helpers.
  const stubKlura = {
    GRAPH_MODES: ['discover', 'map', 'execute'],
    CHECKPOINT_KINDS: [],
    composeAckHint: () => '',
  };
  const defineTools = require('../../mcp/tools.js');
  const tools = defineTools(stubKlura);
  const performAction = tools.find((t) => t.name === 'perform_action');
  assert.ok(performAction, 'perform_action tool must exist in catalog');
  const actionEnum = performAction.inputSchema.properties.action.enum;
  assert.ok(Array.isArray(actionEnum), 'action property has an enum array');
  assert.ok(
    actionEnum.includes('navigate'),
    `action enum must include "navigate"; got: ${JSON.stringify(actionEnum)}`,
  );
  // Sanity: existing actions still present.
  for (const required of ['click', 'type', 'select', 'fill_editor']) {
    assert.ok(actionEnum.includes(required), `existing action "${required}" present`);
  }
});

test('perform_action description mentions navigate semantics', () => {
  const stubKlura = {
    GRAPH_MODES: ['discover', 'map', 'execute'],
    CHECKPOINT_KINDS: [],
    composeAckHint: () => '',
  };
  const defineTools = require('../../mcp/tools.js');
  const tools = defineTools(stubKlura);
  const performAction = tools.find((t) => t.name === 'perform_action');
  assert.match(
    performAction.description,
    /navigate.*selector.*url|navigate: selector=<url>/i,
    `description should explain navigate semantics; got: ${performAction.description.slice(0, 200)}`,
  );
});

test('perform_action accepts both `text` and `value` (CiC convention)', () => {
  // The Claude-in-Chrome computer tool uses `text` for the string to type;
  // klura historically used `value`. Both are accepted now (text wins
  // if both supplied) so the LLM's instinct from CiC translates directly.
  const stubKlura = {
    GRAPH_MODES: ['discover', 'map', 'execute'],
    CHECKPOINT_KINDS: [],
    composeAckHint: () => '',
  };
  const defineTools = require('../../mcp/tools.js');
  const tools = defineTools(stubKlura);
  const performAction = tools.find((t) => t.name === 'perform_action');
  assert.ok(
    performAction.inputSchema.properties.text,
    'schema must declare `text` property',
  );
  assert.ok(
    performAction.inputSchema.properties.value,
    'schema must keep `value` for backwards compatibility',
  );

  // Handler dispatch: text wins over value when both present, value
  // works alone, text alone works.
  let captured = null;
  const stubPerform = {
    ...stubKlura,
    performAction: (...a) => {
      captured = a;
      return Promise.resolve({});
    },
  };
  const tools2 = defineTools(stubPerform);
  const pa = tools2.find((t) => t.name === 'perform_action');
  pa.handler({ session_id: 's', action: 'type', selector: 'input', text: 'hello' });
  assert.equal(captured[3], 'hello', 'text passed through');
  pa.handler({ session_id: 's', action: 'type', selector: 'input', value: 'world' });
  assert.equal(captured[3], 'world', 'value still works (back-compat)');
  pa.handler({ session_id: 's', action: 'type', selector: 'input', text: 'a', value: 'b' });
  assert.equal(captured[3], 'a', 'text wins when both supplied');
});
