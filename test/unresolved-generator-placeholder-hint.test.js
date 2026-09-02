// A generator placeholder left standing is a different mistake from a missing
// argument, and the generic advice for the latter cannot be followed for it:
// no caller arg and no `notes.params.<name>.example` can satisfy `{{__gen.X}}`.
//
// Observed on reddit: the agent needed `&after=` present on later pages and
// absent on the first, reached for a generator, and post-save verification came
// back `not_run` with `unresolved_placeholders`. The first save went active
// unverified, every correction was then staged as a candidate, and candidates
// need verification evidence that could never be produced — nine correct
// strategies stranded behind one that ignored the cursor.

import test from 'node:test';
import assert from 'node:assert/strict';

const { assertNoUnresolvedPlaceholders } = await import('../dist/execution/vars.js');

function messageFrom(value, field) {
  try {
    assertNoUnresolvedPlaceholders(value, field);
  } catch (err) {
    return err.message;
  }
  return null;
}

test('a resolved string throws nothing', () => {
  assert.equal(messageFrom('https://example.test/r/programming/new.json?limit=10', 'request URL'), null);
});

test('a generator placeholder names the affordance that actually applies', () => {
  const message = messageFrom(
    'https://example.test/r/x/new.json?limit=10{{__gen.after_qs}}',
    'request URL',
  );

  assert.match(message, /unresolved_placeholders/);
  assert.match(message, /\{\{__gen\.after_qs\}\}/);
  assert.match(
    message,
    /no caller argument or `notes\.params\.<name>\.example` can satisfy/,
    'the generic remedy is impossible here, and saying so is the point',
  );
  assert.match(
    message,
    /optional: true/,
    'the shape that reaches for a generator is a sometimes-present query segment',
  );
});

test('an ordinary missing argument gets no generator advice', () => {
  const message = messageFrom('https://example.test/r/{{subreddit}}/new.json', 'request URL');

  assert.match(message, /\{\{subreddit\}\}/);
  assert.doesNotMatch(
    message,
    /optional: true/,
    'a plain missing arg is fixed by supplying it — pointing at optional would misdirect',
  );
});

test('a mix reports both, and the generator advice is scoped to the generator', () => {
  const message = messageFrom(
    'https://example.test/r/{{subreddit}}/new.json?x={{__gen.token}}',
    'request URL',
  );

  assert.match(message, /\{\{subreddit\}\}/);
  assert.match(message, /\{\{__gen\.token\}\}/);
  assert.match(message, /`\{\{__gen\.token\}\}` is a generator/);
  assert.doesNotMatch(
    message,
    /`\{\{subreddit\}\}` is a generator/,
    'only the generator may be described as one',
  );
});

test('several generators are described in the plural', () => {
  const message = messageFrom('/p?a={{__gen.one}}&b={{__gen.two}}', 'request URL');
  assert.match(message, /are generators/);
});
