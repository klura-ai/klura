// Repro: llm-tests/search-enforcement/fresh-discovery v7b. Agent typed
// "Hey Adam, long time no chat." into the message composer (perform_action
// action:"type"), then clicked "Send" (perform_action action:"click").
// The POST /api/conversations/{id}/messages fired with body.text = the typed
// value. The param-observation pipeline saw the Send click correlate with
// the POST, walked the action history, and SHOULD have skipped recording
// `text` as a ui_click observation because the value appears in a preceding
// type action.
//
// Yet the save-audit rejection at r16 surfaced `Observed click labels: ["Send"]`
// for `text` — proof that the filter did not fire. This test exercises the
// extracted `deriveUiClickObservations` helper directly with the exact session
// shape and asserts no observation is recorded for the typed value.

import test from 'node:test';
import assert from 'node:assert/strict';

const { deriveUiClickObservations } = await import(
  '../dist/response/session-observations.js'
);

// Timestamps are wall-clock ms; relative ordering is what matters.
const TYPE_SEARCH_ADAM_AT = 1_000_000;
const SEARCH_REQUEST_AT = 1_000_500;
const CLICK_SEARCH_RESULT_AT = 1_001_000;
const TYPE_MESSAGE_BODY_AT = 1_002_000;
const CLICK_SEND_AT = 1_002_500;
const POST_REQUEST_AT = 1_003_000;
const GET_CONVERSATION_AT = 1_003_100;

function v7bHistory() {
  return [
    {
      at: TYPE_SEARCH_ADAM_AT,
      action: 'type',
      selector: 'searchbox "Search members by name"',
      value: 'Adam',
    },
    {
      at: CLICK_SEARCH_RESULT_AT,
      action: 'click',
      selector: 'button "Adam Search result"',
      locators: { name: 'Adam Search result' },
    },
    {
      at: TYPE_MESSAGE_BODY_AT,
      action: 'type',
      selector: 'textbox "Type a message"',
      value: 'Hey Adam, long time no chat.',
    },
    {
      at: CLICK_SEND_AT,
      action: 'click',
      selector: 'button "Send"',
      locators: { name: 'Send' },
    },
  ];
}

function v7bPostEntry() {
  return {
    method: 'POST',
    url: 'http://127.0.0.1:55537/api/conversations/93210/messages',
    headers: { 'Content-Type': 'application/json' },
    postData: { text: 'Hey Adam, long time no chat.' },
    status: 201,
    responseBody: '{"ok":true,"id":"msg-1"}',
    timestamp: POST_REQUEST_AT,
  };
}

test('v7b repro: typed message body must NOT record a ui_click observation under "Send"', () => {
  const history = v7bHistory();
  const entry = v7bPostEntry();
  // Correlated UI: the "Send" click preceded the POST within the correlation
  // window. The filter should walk history, find the preceding type action
  // with value="Hey Adam, ...", and skip recording the observation.
  const ui = {
    kind: 'click',
    element_text: 'Send',
    action_at: CLICK_SEND_AT,
    request_at: POST_REQUEST_AT,
  };
  const obs = deriveUiClickObservations(entry, history, ui, 4);
  // No observation should fire — the typed-value filter must skip the body
  // because "Hey Adam, long time no chat." appears in a preceding type
  // action's value.
  assert.deepEqual(
    obs,
    [],
    `Expected typed-value filter to skip "text" observation; got: ${JSON.stringify(obs)}`,
  );
});

test('typed value with timestamp AFTER the request is NOT in the lookback (filter must skip)', () => {
  // Negative-time-order shape: type record's `at` >= ui.request_at — the
  // filter's `rec.at >= ui.request_at` clause excludes such records from
  // recentTypedValues. The POST still gets its observation recorded because
  // the typed value isn't in the lookback set.
  const history = [
    {
      at: POST_REQUEST_AT + 100, // AFTER the request
      action: 'type',
      selector: 'textbox',
      value: 'Hey Adam, long time no chat.',
    },
  ];
  const entry = v7bPostEntry();
  const ui = {
    kind: 'click',
    element_text: 'Send',
    action_at: POST_REQUEST_AT - 200,
    request_at: POST_REQUEST_AT,
  };
  const obs = deriveUiClickObservations(entry, history, ui, 4);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].param_name, 'text');
});

test('typed value too long ago (> 5min) is dropped from lookback (filter must NOT skip)', () => {
  // Beyond TYPED_LOOKBACK_MS the typed value is treated as stale and the
  // observation IS recorded — this is the deliberate hedge against ancient
  // typed values that happen to coincide with much-later XHR params.
  const history = [
    {
      at: POST_REQUEST_AT - 6 * 60 * 1000, // 6 min ago
      action: 'type',
      selector: 'textbox',
      value: 'Hey Adam, long time no chat.',
    },
  ];
  const entry = v7bPostEntry();
  const ui = {
    kind: 'click',
    element_text: 'Send',
    action_at: POST_REQUEST_AT - 200,
    request_at: POST_REQUEST_AT,
  };
  const obs = deriveUiClickObservations(entry, history, ui, 4);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].source.label, 'Send');
});

test('non-typed actions (key_press, navigate) do NOT contribute to the typed-value set', () => {
  // Only `type` and `fill_editor` record a typed value. A key_press or
  // navigate action with a matching value (whatever shape) is irrelevant
  // — keys are focus-relative; nav values are URLs.
  const history = [
    {
      at: TYPE_MESSAGE_BODY_AT,
      action: 'key_press',
      key: 'Enter',
      value: 'Hey Adam, long time no chat.',
    },
    {
      at: CLICK_SEND_AT,
      action: 'click',
      selector: 'button',
      locators: { name: 'Send' },
    },
  ];
  const entry = v7bPostEntry();
  const ui = {
    kind: 'click',
    element_text: 'Send',
    action_at: CLICK_SEND_AT,
    request_at: POST_REQUEST_AT,
  };
  const obs = deriveUiClickObservations(entry, history, ui, 4);
  // The key_press is NOT in the typed-set, so the body observation IS
  // recorded. (A key_press is a navigation-event, not a value-bearing
  // action — the value field on the record is for selector contexts that
  // don't apply here.)
  assert.equal(obs.length, 1);
});

test('typed-then-suffix-edit: filter does NOT skip if the typed value differs from the body', () => {
  // Real-world divergence: agent typed "Hey Adam" then the page auto-
  // suffixed ", long time no chat." (or vice versa). The POST body's text
  // does NOT match the type action's value string exactly. The filter is
  // exact-match — divergence by even one char means the observation IS
  // recorded. This is the conservative branch; over-recording with the wrong
  // label "Send" is the catch-22 the upstream filter is trying to prevent.
  const history = [
    {
      at: TYPE_MESSAGE_BODY_AT,
      action: 'type',
      selector: 'textbox',
      value: 'Hey Adam', // shorter
    },
    {
      at: CLICK_SEND_AT,
      action: 'click',
      selector: 'button',
      locators: { name: 'Send' },
    },
  ];
  const entry = v7bPostEntry(); // body.text is the FULL "Hey Adam, long time no chat."
  const ui = {
    kind: 'click',
    element_text: 'Send',
    action_at: CLICK_SEND_AT,
    request_at: POST_REQUEST_AT,
  };
  const obs = deriveUiClickObservations(entry, history, ui, 4);
  // Filter doesn't catch — the recorded observation has label "Send" and
  // value = the full message body. This documents the failure mode the
  // upstream filter can't reach without prose-matching, which the
  // principles forbid.
  assert.equal(obs.length, 1);
  assert.equal(obs[0].value, 'Hey Adam, long time no chat.');
});
