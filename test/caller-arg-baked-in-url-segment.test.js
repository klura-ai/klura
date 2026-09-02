// Whole-field equality is the crispest form of "this caller's value is baked
// in", and it misses the shape that actually appears: the value embedded in a
// longer URL. Observed twice in one evening — a documentation section inside a
// prereq URL, and a search term inside a maps request path. Both strategies
// templated the argument somewhere harmless while the request kept addressing
// the discovery value, so the placeholder check was satisfied and the capability
// answered for one input regardless of what a caller passed.
//
// The rule stays structural: complete path segments or an entire query value,
// which is the same test literal provenance already applies. A coincidental
// substring is not evidence.

import test from 'node:test';
import assert from 'node:assert/strict';

const { detectCallerArgBaked } = await import('../dist/gate/save-warnings-caller-arg.js');

function strategyWithPrereqUrl(url) {
  return {
    schema_version: 1,
    strategy: 'page-script',
    baseUrl: 'https://developer.mozilla.org',
    endpoint: '/search?q={{section}}',
    prerequisites: [{ name: 'listing', kind: 'js-eval', method: 'js-eval', url, expression: 'x' }],
    notes: { params: { section: { kind: 'text', example: 'Web/API' } } },
  };
}

const declared = [{ args: { section: 'Web/API' } }];

test('a caller value occupying whole path segments is flagged', () => {
  const warnings = detectCallerArgBaked(
    strategyWithPrereqUrl('https://developer.mozilla.org/en-US/docs/Web/API'),
    declared,
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /2 consecutive path segments/);
  assert.match(
    warnings[0].message,
    /templating "section" elsewhere in the strategy does not change where the request actually points/,
    'the point is that a placeholder somewhere else does not redeem a baked target',
  );
});

test('a coincidental substring is not flagged', () => {
  // `Web/API` does not occupy segments here — `apidocs` merely contains "api".
  const warnings = detectCallerArgBaked(
    strategyWithPrereqUrl('https://developer.mozilla.org/apidocs/webapi/index'),
    declared,
  );
  assert.deepEqual(warnings, []);
});

test('a whole query value is flagged', () => {
  const warnings = detectCallerArgBaked(
    strategyWithPrereqUrl('https://developer.mozilla.org/search?section=Web/API&page=1'),
    [{ args: { section: 'Web/API' } }],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /`section` query value/);
});

test('a templated URL is left alone', () => {
  const warnings = detectCallerArgBaked(
    strategyWithPrereqUrl('https://developer.mozilla.org/en-US/docs/{{section}}'),
    declared,
  );
  assert.deepEqual(warnings, [], 'a templated field is already parameterized');
});

test('whole-field equality still reports the original wording', () => {
  const warnings = detectCallerArgBaked(
    {
      schema_version: 1,
      strategy: 'fetch',
      method: 'GET',
      baseUrl: 'https://example.test',
      endpoint: '/x',
      headers: { 'x-section': 'Web/API' },
      notes: { params: {} },
    },
    declared,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /is exactly the value/);
});
