// Unit tests for validateStrategyShape — the exhaustive schema check that
// runs at save time. Covers the deeper nested fields (generated,
// notes.params, baseUrl scheme) beyond the basic required-field matrix.

import test from 'node:test';
import assert from 'node:assert';
import { validateStrategyShape } from '../dist/strategies/skills.js';

function expectReject(data, matcher) {
  assert.throws(
    () => validateStrategyShape(data),
    (err) => {
      assert.match(err.message, /^invalid_strategy:/);
      if (matcher instanceof RegExp) assert.match(err.message, matcher);
      else if (typeof matcher === 'string') assert.ok(err.message.includes(matcher));
      return true;
    },
  );
}

const base = () => ({
  strategy: 'fetch',
  baseUrl: 'https://api.example.com',
  endpoint: '/x',
});

// ---- generated shape ----

test('generated: {code: string} accepted', () => {
  validateStrategyShape({
    ...base(),
    generated: { ts: { code: 'return String(Date.now())' } },
  });
});

test('generated: {instruction: string} accepted', () => {
  validateStrategyShape({
    ...base(),
    generated: { sig: { instruction: 'compute sha256 of userId+timestamp' } },
  });
});

test('generated entry without code or instruction is rejected', () => {
  expectReject(
    { ...base(), generated: { sig: { value: 'x' } } },
    /must contain either a "code" .* or "instruction"/,
  );
});

test('generated entry with both code and instruction is rejected', () => {
  expectReject(
    {
      ...base(),
      generated: { sig: { code: 'return 1', instruction: 'do stuff' } },
    },
    /exactly one of "code" or "instruction"/,
  );
});

test('generated.code must be a string', () => {
  expectReject({ ...base(), generated: { sig: { code: 42 } } }, /generated\.sig\.code/);
});

test('generated.code cannot be empty', () => {
  expectReject({ ...base(), generated: { sig: { code: '' } } }, /non-empty string of JavaScript/);
});

test('generated.code over the size cap is rejected', () => {
  expectReject({ ...base(), generated: { sig: { code: 'x'.repeat(10_001) } } }, /too long/);
});

test('generated.instruction must be a string', () => {
  expectReject(
    { ...base(), generated: { sig: { instruction: 123 } } },
    /instruction.*(must be a non-empty string|expected string)/,
  );
});

test('generated.examples must be an array', () => {
  expectReject(
    {
      ...base(),
      generated: { sig: { instruction: 'x', examples: 'not an array' } },
    },
    /examples.*(must be an array|expected array)/,
  );
});

test('generated.examples must contain only strings', () => {
  expectReject(
    {
      ...base(),
      generated: { sig: { instruction: 'x', examples: ['a', 42] } },
    },
    /examples(\[1\]|\.1).*(must be a string|expected string)/,
  );
});

test('generated entry must be an object', () => {
  expectReject(
    { ...base(), generated: { sig: 'just a string' } },
    /generated\.sig.*(must be an object|expected object)/,
  );
});

// ---- notes.params shape ----

test('notes.params: string entry accepted (legacy shape)', () => {
  validateStrategyShape({
    ...base(),
    notes: { params: { user_id: 'The numeric GitHub user id' } },
  });
});

test('notes.params: structured ParamDoc accepted', () => {
  validateStrategyShape({
    ...base(),
    notes: {
      params: {
        user_id: { description: 'User id', kind: 'id', example: '123' },
      },
    },
  });
});

test('notes.params.kind must be from the allowed enum', () => {
  expectReject(
    {
      ...base(),
      notes: { params: { user_id: { kind: 'integer' } } },
    },
    /kind.*one of.*"id".*"slug".*"text"/,
  );
});

test('notes.params.example must be a string', () => {
  expectReject(
    {
      ...base(),
      notes: { params: { user_id: { example: 123 } } },
    },
    /notes\.params\.user_id\.example.*(must be a string|expected string)/,
  );
});

test('notes.params.example over 2000 chars is rejected', () => {
  expectReject(
    {
      ...base(),
      notes: { params: { user_id: { example: 'x'.repeat(2001) } } },
    },
    /example is too long/,
  );
});

test('notes.params entry must be a string or an object', () => {
  expectReject(
    {
      ...base(),
      notes: { params: { user_id: 42 } },
    },
    /must be a string|must be an object|tried 2 shapes/,
  );
});

test('notes.params description over cap is rejected', () => {
  expectReject(
    {
      ...base(),
      notes: { params: { user_id: { description: 'x'.repeat(2001) } } },
    },
    /description is too long/,
  );
});

// ---- baseUrl / origin scheme ----

test('javascript: baseUrl is rejected', () => {
  expectReject(
    { strategy: 'fetch', baseUrl: 'javascript:alert(1)', endpoint: '/x' },
    /uses javascript: scheme/,
  );
});

test('file: baseUrl is rejected', () => {
  expectReject(
    { strategy: 'fetch', baseUrl: 'file:///etc/passwd', endpoint: '/x' },
    /uses file: scheme/,
  );
});

test('data: baseUrl is rejected', () => {
  expectReject(
    { strategy: 'fetch', baseUrl: 'data:text/html,<script>', endpoint: '/x' },
    /uses data: scheme/,
  );
});

test('malformed baseUrl is rejected', () => {
  expectReject({ strategy: 'fetch', baseUrl: '://nope', endpoint: '/x' }, /not a parseable URL/);
});

test('https baseUrl is accepted', () => {
  validateStrategyShape({
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/x',
  });
});

test('http baseUrl is accepted (local dev)', () => {
  validateStrategyShape({
    strategy: 'fetch',
    baseUrl: 'http://localhost:3000',
    endpoint: '/x',
  });
});

// ---- smoke tests: baseline shape still works ----

test('full fetch strategy with all optional fields passes', () => {
  validateStrategyShape({
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/users/{{id}}',
    method: 'GET',
    headers: { Accept: 'application/json' },
    contentType: 'json',
    body: { nested: { a: 1 } },
    params: { limit: '10' },
    generated: { reqId: { code: 'return String(Date.now())' } },
    notes: {
      params: { id: { kind: 'id', example: '42' } },
    },
  });
});

test('fetch with page-extract prereq passes', () => {
  validateStrategyShape({
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/graphql',
    prerequisites: [
      {
        name: 'nonce',
        kind: 'page-extract',
        url: 'https://example.com',
        vars: { nonce: { selector: 'meta[name=csrf-token]', attr: 'content' } },
      },
    ],
  });
});

// ---- fetch-extract prereq ----

test('fetch with fetch-extract prereq passes', () => {
  validateStrategyShape({
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/graphql',
    prerequisites: [
      {
        name: 'resolve_repo',
        kind: 'fetch-extract',
        url: 'https://api.github.com/repos/{{owner}}/{{repo}}',
        vars: { repositoryId: 'node_id' },
      },
    ],
  });
});

test('fetch-extract rejects when url is missing', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: '/x',
      prerequisites: [{ name: 'r', kind: 'fetch-extract', vars: { id: 'node_id' } }],
    },
    /fetch-extract.*\.url is required/s,
  );
});

test('fetch-extract rejects when vars is missing or empty', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: '/x',
      prerequisites: [
        { name: 'r', kind: 'fetch-extract', url: 'https://api.example.com/repo', vars: {} },
      ],
    },
    /fetch-extract.*\.vars must be a non-empty object/s,
  );
});

test('fetch-extract rejects page-extract-shaped var entries', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'r',
          kind: 'fetch-extract',
          url: 'https://api.example.com/repo',
          vars: { id: { selector: '#x', attr: 'content' } },
        },
      ],
    },
    /vars\.id must be string|dot-path/,
  );
});

test('fetch-extract accepts optional method, headers_map, fetch_body', () => {
  validateStrategyShape({
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/x',
    prerequisites: [
      {
        name: 'r',
        kind: 'fetch-extract',
        url: 'https://api.example.com/search',
        method: 'POST',
        headers_map: { 'Content-Type': 'application/json', 'X-API-Key': '{{api_key}}' },
        fetch_body: { query: '{{q}}' },
        vars: { firstId: 'data.items[0].id' },
      },
    ],
  });
});

test('fetch-extract rejects bad method', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'r',
          kind: 'fetch-extract',
          url: 'https://api.example.com/x',
          method: 'FETCH',
          vars: { id: 'id' },
        },
      ],
    },
    /method.*must be one of/,
  );
});

test('fetch-extract rejects headers_map with non-string values', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'r',
          kind: 'fetch-extract',
          url: 'https://api.example.com/x',
          headers_map: { Accept: 42 },
          vars: { id: 'id' },
        },
      ],
    },
    /headers_map.*Accept.*string/,
  );
});

// ---- js-eval prereq ----

const baseJsEval = () => ({
  strategy: 'fetch',
  baseUrl: 'https://www.example.com',
  endpoint: '/api/submit',
  prerequisites: [
    {
      name: 'mintToken',
      kind: 'js-eval',
      url: 'https://www.example.com/new',
      expression: 'await window.__pageGuard.mintSubmitToken()',
      binds: 'pageToken',
      return_shape: { kind: 'string', min_length: 20, max_length: 4000 },
    },
  ],
});

test('fetch with js-eval prereq passes', () => {
  validateStrategyShape(baseJsEval());
});

test('prereq: "type" is silently aliased to "kind" (LLM drift convenience)', () => {
  // Observed across multiple field reports: agents write `type: "js-eval"`
  // instead of `kind: "js-eval"`. Per principles.md §"If the LLM keeps
  // making the same mistake, the runtime is wrong," accept the term the
  // LLM reaches for rather than reject + force a rename round-trip.
  const s = {
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/submit',
    prerequisites: [
      {
        name: 'mintToken',
        type: 'js-eval', // <-- wrong field name; validator should alias to kind
        url: 'https://www.example.com/new',
        expression: 'await window.mint()',
        binds: 'pageToken',
        return_shape: { kind: 'string', min_length: 20 },
      },
    ],
  };
  assert.doesNotThrow(() => validateStrategyShape(s));
});

test('prereq: "type" alias does not override an explicit "kind"', () => {
  // If both are present, `kind` wins — silently dropping an explicit
  // kind for a stray `type` would be worse than either rejecting or
  // keeping kind as-authored.
  const s = {
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/submit',
    prerequisites: [
      {
        name: 'mint',
        type: 'page-extract', // <-- ignored when kind is present
        kind: 'js-eval',
        url: 'https://www.example.com/new',
        expression: 'await window.mint()',
        binds: 'tok',
        return_shape: { kind: 'string' },
      },
    ],
  };
  // If the alias overrode method, this would be rejected as page-extract
  // (missing vars). Passing = method was preserved.
  assert.doesNotThrow(() => validateStrategyShape(s));
});

test('js-eval rejects when url is missing', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'm',
          kind: 'js-eval',
          expression: 'window.x.mint()',
          binds: 'tok',
          return_shape: { kind: 'string' },
        },
      ],
    },
    /js-eval.*\.url is required/s,
  );
});

test('js-eval rejects when expression is missing', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'm',
          kind: 'js-eval',
          url: 'https://www.example.com/new',
          binds: 'tok',
          return_shape: { kind: 'string' },
        },
      ],
    },
    /expression is required/,
  );
});

test('js-eval rejects unbalanced expression', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'm',
          kind: 'js-eval',
          url: 'https://www.example.com/new',
          expression: 'window.foo.mint(',
          binds: 'tok',
          return_shape: { kind: 'string' },
        },
      ],
    },
    /unbalanced brackets or quotes/,
  );
});

test('js-eval rejects missing binds', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'm',
          kind: 'js-eval',
          url: 'https://www.example.com/new',
          expression: 'window.x.mint()',
          return_shape: { kind: 'string' },
        },
      ],
    },
    /binds/,
  );
});

test('js-eval rejects missing return_shape', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'm',
          kind: 'js-eval',
          url: 'https://www.example.com/new',
          expression: 'window.x.mint()',
          binds: 'tok',
        },
      ],
    },
    /return_shape/,
  );
});

test('js-eval rejects bad return_shape.kind', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'm',
          kind: 'js-eval',
          url: 'https://www.example.com/new',
          expression: 'window.x.mint()',
          binds: 'tok',
          return_shape: { kind: 'float' },
        },
      ],
    },
    /return_shape\.kind.*(float|one of)/,
  );
});

test('js-eval rejects min_length / max_length on non-string kind', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'm',
          kind: 'js-eval',
          url: 'https://www.example.com/new',
          expression: 'window.x.mint()',
          binds: 'tok',
          return_shape: { kind: 'number', min_length: 10 },
        },
      ],
    },
    /min_length .*only valid when kind === "string"/,
  );
});

test('js-eval rejects required_keys on non-object kind', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'm',
          kind: 'js-eval',
          url: 'https://www.example.com/new',
          expression: 'window.x.mint()',
          binds: 'tok',
          return_shape: { kind: 'string', required_keys: ['token'] },
        },
      ],
    },
    /required_keys is only valid when kind === "object"/,
  );
});

test('js-eval accepts object return_shape with required_keys', () => {
  validateStrategyShape({
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/x',
    prerequisites: [
      {
        name: 'm',
        kind: 'js-eval',
        url: 'https://www.example.com/new',
        expression: 'await window.x.mintFull()',
        binds: 'tok',
        return_shape: { kind: 'object', required_keys: ['token', 'expires_at'] },
      },
    ],
  });
});

test('js-eval accepts refresh options', () => {
  validateStrategyShape({
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/x',
    prerequisites: [
      {
        name: 'm',
        kind: 'js-eval',
        url: 'https://www.example.com/new',
        expression: 'await window.x.mint()',
        binds: 'tok',
        return_shape: { kind: 'string' },
        refresh: { enabled: true, interval_seconds: 60, jitter_seconds: 10 },
      },
    ],
  });
});

test('js-eval rejects refresh.interval_seconds below floor', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'm',
          kind: 'js-eval',
          url: 'https://www.example.com/new',
          expression: 'window.x.mint()',
          binds: 'tok',
          return_shape: { kind: 'string' },
          refresh: { enabled: true, interval_seconds: 2 },
        },
      ],
    },
    /below the minimum/,
  );
});

test('js-eval rejects timeout_ms over hard cap', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'm',
          kind: 'js-eval',
          url: 'https://www.example.com/new',
          expression: 'window.x.mint()',
          binds: 'tok',
          return_shape: { kind: 'string' },
          timeout_ms: 60000,
        },
      ],
    },
    /exceeds the hard cap/,
  );
});

test('js-eval over 8KB expression is rejected', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'm',
          kind: 'js-eval',
          url: 'https://www.example.com/new',
          expression: 'a' + '.a'.repeat(4500),
          binds: 'tok',
          return_shape: { kind: 'string' },
        },
      ],
    },
    /must be at most 8192 characters/,
  );
});

test('js-eval accepts args_template (per-call signer mode)', () => {
  validateStrategyShape({
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/api/submit',
    body: { input: '{{text}}' },
    prerequisites: [
      {
        name: 'sig',
        kind: 'js-eval',
        url: 'https://www.example.com/new',
        expression: 'await window.__sign({url: args.endpoint, body: args.body})',
        binds: 'request_signature',
        return_shape: { kind: 'string', min_length: 28 },
        args_template: { endpoint: '{{endpoint}}', body: '{{request_body}}' },
      },
    ],
  });
});

test('js-eval rejects non-object args_template', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'sig',
          kind: 'js-eval',
          url: 'https://www.example.com/new',
          expression: 'await window.__sign(args)',
          binds: 'tok',
          return_shape: { kind: 'string' },
          args_template: 'body=foo',
        },
      ],
    },
    /args_template.*(plain object|expected record|record)/,
  );
});

test('js-eval accepts frame selector (iframe-scoped expression)', () => {
  validateStrategyShape({
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/x',
    prerequisites: [
      {
        name: 'cf',
        kind: 'js-eval',
        url: 'https://www.example.com/checkout',
        frame: 'iframe[src*="cloudflare"]',
        expression: 'await window.turnstile.execute()',
        binds: 'cf_token',
        return_shape: { kind: 'string', min_length: 100 },
      },
    ],
  });
});

test('js-eval rejects empty frame selector', () => {
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/x',
      prerequisites: [
        {
          name: 'cf',
          kind: 'js-eval',
          url: 'https://www.example.com/checkout',
          frame: '',
          expression: 'await window.turnstile.execute()',
          binds: 'cf_token',
          return_shape: { kind: 'string' },
        },
      ],
    },
    /frame.*(non-empty|≥|character|too small)/,
  );
});

test('js-eval rejects args_template + refresh.enabled (mutually exclusive)', () => {
  // Per-call args make the result body-dependent; refresh re-mints on a fixed
  // clock with no per-call args. Combining them would cache a signature for
  // one body and serve it back for a different body — silently wrong. Reject
  // loudly with the explicit choice the agent has to make.
  expectReject(
    {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: '/api/submit',
      body: { input: '{{text}}' },
      prerequisites: [
        {
          name: 'sig',
          kind: 'js-eval',
          url: 'https://www.example.com/new',
          expression: 'await window.__sign(args)',
          binds: 'sig',
          return_shape: { kind: 'string', min_length: 28 },
          args_template: { body: '{{request_body}}' },
          refresh: { enabled: true, interval_seconds: 60 },
        },
      ],
    },
    /args_template and refresh\.enabled.*mutually exclusive/,
  );
});

test('js-eval allows args_template with refresh.enabled:false (no-op)', () => {
  // refresh.enabled !== true is a no-op anyway; only explicit `enabled: true`
  // collides with per-call mode. An incidentally-present refresh block with
  // enabled:false should not block a per-call signer.
  validateStrategyShape({
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: '/x',
    prerequisites: [
      {
        name: 'sig',
        kind: 'js-eval',
        url: 'https://www.example.com/new',
        expression: 'await window.__sign(args)',
        binds: 'sig',
        return_shape: { kind: 'string' },
        args_template: { body: '{{request_body}}' },
        refresh: { enabled: false },
      },
    ],
  });
});

// ---- fetch response extraction ----

test('fetch without response field is valid (backcompat: json default)', () => {
  validateStrategyShape({ ...base(), method: 'GET' });
});

test('fetch response.format=html with GET + non-empty extract is valid', () => {
  validateStrategyShape({
    ...base(),
    method: 'GET',
    response: {
      format: 'html',
      extract: { title: { selector: 'h1' } },
    },
  });
});

test('fetch html extract with multiple:true is valid', () => {
  validateStrategyShape({
    ...base(),
    method: 'GET',
    response: {
      format: 'html',
      extract: { items: { selector: 'li.order', multiple: true } },
    },
  });
});

test('fetch html extract with attr is valid', () => {
  validateStrategyShape({
    ...base(),
    method: 'GET',
    response: {
      format: 'html',
      extract: { url: { selector: 'a.more', attr: 'href' } },
    },
  });
});

test('fetch response.format=html on POST is rejected', () => {
  expectReject(
    {
      ...base(),
      method: 'POST',
      response: { format: 'html', extract: { title: { selector: 'h1' } } },
    },
    /requires a GET method/,
  );
});

test('fetch response.format=html with empty extract is rejected', () => {
  expectReject(
    { ...base(), method: 'GET', response: { format: 'html', extract: {} } },
    /non-empty "extract" object/,
  );
});

test('fetch response.format=html with missing extract is rejected', () => {
  expectReject(
    { ...base(), method: 'GET', response: { format: 'html' } },
    /non-empty "extract" object/,
  );
});

test('fetch extract entry missing selector is rejected', () => {
  expectReject(
    {
      ...base(),
      method: 'GET',
      response: { format: 'html', extract: { title: { attr: 'content' } } },
    },
    /requires a "selector" string|selector is required/,
  );
});

test('fetch extract entry selector must be non-empty string', () => {
  expectReject(
    {
      ...base(),
      method: 'GET',
      response: { format: 'html', extract: { title: { selector: '' } } },
    },
    /requires a "selector" string/,
  );
});

test('fetch extract entry attr must be a string if present', () => {
  expectReject(
    {
      ...base(),
      method: 'GET',
      response: {
        format: 'html',
        extract: { title: { selector: 'h1', attr: 42 } },
      },
    },
    /\.attr.*(must be a string|expected string)/,
  );
});

test('fetch extract entry multiple must be a boolean if present', () => {
  expectReject(
    {
      ...base(),
      method: 'GET',
      response: {
        format: 'html',
        extract: { items: { selector: 'li', multiple: 'yes' } },
      },
    },
    /\.multiple.*(must be a boolean|expected boolean)/,
  );
});

test('fetch format=json with extract present is rejected (loud)', () => {
  expectReject(
    {
      ...base(),
      method: 'GET',
      response: { format: 'json', extract: { title: { selector: 'h1' } } },
    },
    /extract is only valid when response\.format = "html"/,
  );
});

test('fetch extract on default (absent) format is rejected', () => {
  expectReject(
    {
      ...base(),
      method: 'GET',
      response: { extract: { title: { selector: 'h1' } } },
    },
    /extract is only valid when response\.format = "html"/,
  );
});

test('fetch response.format=xml is rejected (deferred)', () => {
  expectReject(
    {
      ...base(),
      method: 'GET',
      response: { format: 'xml', extract: { title: { selector: 'h1' } } },
    },
    /must be "json" or "html"|must be one of "json" \| "html"/,
  );
});

test('response field on fetch with prereqs is accepted', () => {
  // After the tier merge, `fetch` covers both the prereqs-present and
  // prereqs-absent cases. `response.extract` is valid on any fetch shape.
  const parsed = JSON.parse(
    JSON.stringify({
      strategy: 'fetch',
      baseUrl: 'https://api.example.com',
      endpoint: 'GET /x',
      prerequisites: [{ name: 'n', kind: 'cached', value: 'v' }],
      response: { format: 'html', extract: { title: { selector: 'h1' } } },
    }),
  );
  validateStrategyShape(parsed);
});

test('response field on page-script is rejected', () => {
  expectReject(
    {
      strategy: 'page-script',
      baseUrl: 'https://api.example.com',
      endpoint: '/x',
      response: { format: 'html', extract: { title: { selector: 'h1' } } },
    },
    /"response" field is only valid on fetch/,
  );
});

test('fetch response must be an object (not a string)', () => {
  expectReject(
    { ...base(), method: 'GET', response: 'html' },
    /response.*(must be an object|expected record)/,
  );
});

// ---- Common-training-prior re-priming ----
// When the LLM reaches for a tier name or field it learned from reading
// similar-shape APIs, the rejection body re-primes with the current
// vocabulary at the decision point. See principles.md §"Priming agents".

test('unrecognized tier "http-fetch" rejected with three-tier shortlist', () => {
  expectReject(
    { strategy: 'http-fetch', baseUrl: 'https://x', endpoint: '/y' },
    /"strategy" = "http-fetch" is not one of klura's tiers/,
  );
});

test('unrecognized tier rejection names fetch / page-script / recorded-path in the body', () => {
  assert.throws(
    () => validateStrategyShape({ strategy: 'http-fetch', baseUrl: 'https://x', endpoint: '/y' }),
    (err) => {
      assert.match(err.message, /fetch \(OPTIMAL WHEN ACHIEVABLE\)/);
      assert.match(err.message, /page-script \(REALISTIC DEFAULT/);
      assert.match(err.message, /recorded-path \(LAST RESORT\)/);
      return true;
    },
  );
});

test('unrecognized tier: same re-priming fires for other hallucinated names too', () => {
  // Common training priors from other frameworks all get the same tutorial.
  for (const bogus of ['api-call', 'script', 'scrape', 'playwright']) {
    expectReject(
      { strategy: bogus, baseUrl: 'https://x', endpoint: '/y' },
      /is not one of klura's tiers/,
    );
  }
});

test('unrecognized tier: missing "strategy" field gets the same tutorial', () => {
  expectReject(
    { baseUrl: 'https://x', endpoint: '/y' },
    /"strategy" = \(missing\) is not one of klura's tiers/,
  );
});

test('notes.description accepted as a top-level notes field', () => {
  // Natural shape from the LLM's prior — every schema has a
  // description. Per principles.md §"If the LLM keeps making the
  // same mistake, the runtime is wrong," we accept what the LLM
  // reaches for rather than rejecting and offering a did-you-mean.
  validateStrategyShape({
    ...base(),
    notes: {
      description: 'Send a message to a recipient by thread id.',
      params: { text: { example: 'hi' } },
    },
  });
});

// ---- Aggregated shape errors ----
// When a save has multiple independent deep-shape violations, the
// validator reports them all at once instead of one-at-a-time. Saves the
// agent 4-6 rounds of cascading fix-resubmit.

test('multiple deep-shape errors aggregate into one rejection with bullets', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'fetch',
        baseUrl: 'ftp://bad-scheme.example.com',
        endpoint: '/x',
        generated: { frame: 'not-an-object-or-string' },
        notes: { definitely_not_allowed: 'x' },
      }),
    (err) => {
      assert.match(err.message, /^invalid_strategy:/);
      // Multiple shape problems folded into one response
      assert.match(err.message, /shape problems — fix all of these/);
      // Both underlying issues named in the bullet list
      assert.match(err.message, /baseUrl/);
      assert.match(err.message, /notes/);
      // Bullet-list formatting present
      assert.match(err.message, /\n {2}•/);
      return true;
    },
  );
});

test('single deep-shape error keeps the compact single-line format (no bullets)', () => {
  assert.throws(
    () =>
      validateStrategyShape({
        strategy: 'fetch',
        baseUrl: 'ftp://bad-scheme.example.com',
        endpoint: '/x',
      }),
    (err) => {
      assert.match(err.message, /^invalid_strategy:/);
      assert.doesNotMatch(err.message, /shape problems — fix all of these/);
      return true;
    },
  );
});
