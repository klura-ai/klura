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
    /navigate.*URL.*selector|navigate.*top-level page navigation/i,
    `description should explain navigate semantics; got: ${performAction.description.slice(0, 200)}`,
  );
});
