import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveBody } = await import('../dist/execution/vars.js');

test('whole-value body placeholders preserve JSON argument types', () => {
  const resolved = resolveBody(
    {
      urls: '{{directUrls}}',
      limit: '{{resultsLimit}}',
      enabled: '{{enabled}}',
      options: '{{options}}',
    },
    {
      directUrls: ['https://example.com/a', 'https://example.com/b'],
      resultsLimit: 3,
      enabled: true,
      options: { order: 'newest' },
    },
  );
  assert.deepEqual(resolved, {
    urls: ['https://example.com/a', 'https://example.com/b'],
    limit: 3,
    enabled: true,
    options: { order: 'newest' },
  });
});

test('embedded placeholders remain string interpolation', () => {
  const resolved = resolveBody(
    { route: 'items/{{ids}}' },
    { ids: ['a', 'b'] },
  );
  assert.deepEqual(resolved, { route: 'items/["a","b"]' });
});

test('resolved JSON values are cloned rather than shared with caller args', () => {
  const directUrls = ['https://example.com/a'];
  const resolved = resolveBody({ urls: '{{directUrls}}' }, { directUrls });
  resolved.urls.push('https://example.com/b');
  assert.deepEqual(directUrls, ['https://example.com/a']);
});
