// An in-page fetch parsed as JSON that receives a document fails with a
// SyntaxError about an unexpected `<`. That reads as a parsing mistake, and the
// parsing is fine: the endpoint refused the request and answered with markup.
//
// Observed on reddit — `/r/<sub>/new.json` answers 200 in a warm session and 403
// with an HTML block page to a cold caller. One session re-derived the same
// fetch across eight consecutive saves, debugging its JSON handling, because
// nothing in the error said the response was a page.

import test from 'node:test';
import assert from 'node:assert/strict';

const { runJsEvalPrereq } = await import('../dist/execution/js-eval.js');

function driverThrowing(message) {
  return {
    getUrl: async () => 'https://example.test/page',
    navigate: async () => {},
    evaluateExpression: async (_s, expression) => {
      if (expression === 'document.readyState') return 'complete';
      throw new SyntaxError(message);
    },
  };
}

async function messageFrom(driver) {
  try {
    await runJsEvalPrereq(driver, {}, {
      name: 'list_posts',
      url: 'https://example.test/page',
      expression: "const r = await fetch('/api.json'); return await r.json();",
      returnShape: 'string',
      timeoutMs: 5000,
    });
  } catch (err) {
    return err.message;
  }
  return null;
}

test('a JSON parse failure over markup is named as a refused request', async () => {
  const message = await messageFrom(
    driverThrowing(`Unexpected token '<', "<body clas"... is not valid JSON`),
  );

  assert.match(message, /response was markup, not JSON/);
  assert.match(message, /the parse is not the problem/);
  assert.match(
    message,
    /refuses unauthenticated or non-browser callers|interstitial|login wall/,
    'the agent needs the candidate explanations, not just the observation',
  );
  assert.match(
    message,
    /read that instead of the API path/,
    'and the move that follows from it',
  );
});

test('an ordinary runtime error keeps the generic causes', async () => {
  const message = await messageFrom(driverThrowing('window.__store is undefined'));

  assert.match(message, /Common causes/);
  assert.doesNotMatch(
    message,
    /response was markup/,
    'claiming a refused request where none happened would misdirect',
  );
});

test('a JSON error with no markup token is not called a refusal', async () => {
  const message = await messageFrom(driverThrowing('Unexpected end of JSON input'));

  assert.doesNotMatch(message, /response was markup/);
  assert.match(message, /Common causes/);
});
