// A prereq whose own `url` needs the value that prereq produces cannot run:
// the url must resolve before the prereq executes, so the placeholder is still
// unresolved at that moment.
//
// Nothing caught this before. `validatePlaceholderReferences` treats a
// prereq-bound name as declared — correctly, in general — so the cycle passed
// validation, saved clean, and returned nothing on replay. It also hid a
// caller input: a placeholder satisfied by a bind never has to appear in
// notes.params, so the saved contract omitted an argument the caller must
// supply.
//
// Observed on a bench fixture run: `get_video` saved a js-eval prereq
// `video_id_from_page` binding `video_id` whose url was
// `/@{{username}}/video/{{video_id}}`. Both variants failed with "no video id
// in the result".

import test from 'node:test';
import assert from 'node:assert';
import { validateNoCircularPrereqBinding } from '../dist/strategies/validate.js';

function expectReject(strategy, ...expectedFragments) {
  assert.throws(
    () => validateNoCircularPrereqBinding(strategy),
    (err) => {
      assert.match(err.message, /invalid_strategy: prerequisites\[\d+\]/);
      for (const fragment of expectedFragments) assert.match(err.message, fragment);
      return true;
    },
  );
}

test('the observed shape: js-eval binding a value its own url needs', () => {
  expectReject(
    {
      strategy: 'page-script',
      prerequisites: [
        {
          name: 'video_id_from_page',
          kind: 'js-eval',
          url: 'https://example.test/@{{username}}/video/{{video_id}}',
          binds: 'video_id',
          expression: 'return document.title;',
        },
      ],
    },
    /is circular/,
    /\{\{video_id\}\}/,
    /video_id_from_page/,
  );
});

test('the rejection names both remedies, caller-input first', () => {
  try {
    validateNoCircularPrereqBinding({
      prerequisites: [
        { name: 'p', kind: 'js-eval', url: '/v/{{vid}}', binds: 'vid', expression: 'x' },
      ],
    });
    assert.fail('expected a rejection');
  } catch (err) {
    assert.match(err.message, /notes\.params\.vid/);
    assert.match(err.message, /its OWN prereq placed before this one/);
  }
});

test('page-extract vars keys are produced names too', () => {
  expectReject(
    {
      prerequisites: [
        {
          name: 'grab',
          kind: 'page-extract',
          url: 'https://example.test/order/{{order_id}}',
          vars: { order_id: { selector: '#oid' } },
        },
      ],
    },
    /\{\{order_id\}\}/,
  );
});

test('whitespace inside the braces is still the same reference', () => {
  expectReject(
    {
      prerequisites: [
        { name: 'p', kind: 'js-eval', url: '/v/{{ video_id }}', binds: 'video_id', expression: 'x' },
      ],
    },
    /circular/,
  );
});

// ---- shapes that must keep working ----

test('chaining across prereqs is untouched', () => {
  assert.doesNotThrow(() =>
    validateNoCircularPrereqBinding({
      prerequisites: [
        { name: 'find_id', kind: 'js-eval', url: 'https://example.test/', binds: 'video_id', expression: 'x' },
        {
          name: 'load_detail',
          kind: 'js-eval',
          url: 'https://example.test/video/{{video_id}}',
          binds: 'detail',
          expression: 'x',
        },
      ],
    }),
  );
});

test('a caller arg in a prereq url is the normal case', () => {
  assert.doesNotThrow(() =>
    validateNoCircularPrereqBinding({
      prerequisites: [
        {
          name: 'load',
          kind: 'js-eval',
          url: 'https://example.test/@{{username}}/video/{{video_id}}',
          binds: 'video_data',
          expression: 'x',
        },
      ],
      notes: { params: { username: {}, video_id: {} } },
    }),
  );
});

test('a prereq may reference its own bind outside the url', () => {
  // Only the url has to resolve before the prereq runs; an expression
  // mentioning the name it produces is not a scheduling cycle.
  assert.doesNotThrow(() =>
    validateNoCircularPrereqBinding({
      prerequisites: [
        {
          name: 'p',
          kind: 'js-eval',
          url: 'https://example.test/',
          binds: 'token',
          expression: 'return window.token; // token',
        },
      ],
    }),
  );
});

test('prereqs without a url, and non-array prerequisites, are skipped', () => {
  assert.doesNotThrow(() => validateNoCircularPrereqBinding({ prerequisites: [] }));
  assert.doesNotThrow(() => validateNoCircularPrereqBinding({}));
  assert.doesNotThrow(() =>
    validateNoCircularPrereqBinding({ prerequisites: [{ name: 'c', kind: 'cached', binds: 'v' }] }),
  );
  assert.doesNotThrow(() =>
    validateNoCircularPrereqBinding({ prerequisites: 'not-an-array' }),
  );
});

test('a name that merely contains another name is not a match', () => {
  assert.doesNotThrow(() =>
    validateNoCircularPrereqBinding({
      prerequisites: [
        { name: 'p', kind: 'js-eval', url: '/v/{{video_id_long}}', binds: 'video_id', expression: 'x' },
      ],
    }),
  );
});
