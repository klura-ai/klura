// `navigate` is a valid action on perform_action. Implementation lives at
// runtime/src/tools/perform-action.ts (case 'navigate' calls driver.navigate).
// The MCP schema in the colocated TOOL_DEF must include it in the action
// enum so agents see it as an option — without that, agents fall back to
// js_eval('window.location.href = ...') which costs an extra round and is
// non-obvious.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TOOL_REGISTRY } = require('../dist/index');

function getPerformAction() {
  const def = TOOL_REGISTRY.find((t) => t.name === 'perform_action');
  assert.ok(def, 'perform_action tool must exist in TOOL_REGISTRY');
  return def;
}

test('perform_action MCP schema includes "navigate" in the action enum', () => {
  const performAction = getPerformAction();
  const actionEnum = performAction.inputSchema.properties.action.enum;
  assert.ok(Array.isArray(actionEnum), 'action property has an enum array');
  assert.ok(
    actionEnum.includes('navigate'),
    `action enum must include "navigate"; got: ${JSON.stringify(actionEnum)}`,
  );
  for (const required of ['click', 'type', 'select', 'fill_editor']) {
    assert.ok(actionEnum.includes(required), `existing action "${required}" present`);
  }
});

test('perform_action description mentions navigate semantics', () => {
  const performAction = getPerformAction();
  assert.match(
    performAction.description,
    /navigate.*selector.*url|navigate: selector=<url>/i,
    `description should explain navigate semantics; got: ${performAction.description.slice(0, 200)}`,
  );
});

test('perform_action schema declares both `text` and `value` (CiC convention)', () => {
  // The Claude-in-Chrome computer tool uses `text` for the string to type;
  // klura historically used `value`. The schema declares both so an LLM's
  // instinct from CiC translates directly. The handler's dispatch
  // (`args.text ?? args.value`) lives next to the impl in
  // runtime/src/tools/perform-action.ts and is a one-liner that doesn't
  // warrant an indirect runtime test.
  const performAction = getPerformAction();
  assert.ok(
    performAction.inputSchema.properties.text,
    'schema must declare `text` property',
  );
  assert.ok(
    performAction.inputSchema.properties.value,
    'schema must keep `value` for backwards compatibility',
  );
});
