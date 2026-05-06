// Unit tests for validateNoOpaqueUserParams — the save-time heuristic
// that catches the "I missed step 7" hallucination class. The agent sees
// an opaque internal ID in the captured request body, assumes the caller
// must supply it, and documents it under notes.params. The validator
// rejects that save and tells the agent to trace the value to a DOM source
// via find_in_page and save a page-extract prereq instead.
//
// The rules:
//   - Only fires when the placeholder is ACTUALLY referenced in an
//     interpolable field (endpoint, body, headers). Pure documentation
//     params that aren't used don't matter.
//   - Only fires when NO prereq produces the same variable name. A prereq
//     shadows the param at resolve time, so the params entry is harmless
//     legacy documentation.
//   - Fires on example values matching opaque shapes: prefixed internal IDs
//     (`R_kgDO*`), URI-schemed handles (`gid://*`), long hex, UUID, ULID,
//     base64-shaped blobs ≥30 chars.
//   - Does NOT fire on human-typable values: small integers, slugs, emails,
//     usernames, prose.

import test from 'node:test';
import assert from 'node:assert';
import { validateNoOpaqueUserParams } from '../dist/strategies/skills.js';

function expectReject(data, needle) {
  assert.throws(
    () => validateNoOpaqueUserParams(data),
    (err) => {
      assert.match(err.message, /^invalid_strategy: notes\.params\./);
      if (typeof needle === 'string') assert.ok(err.message.includes(needle), `message missing ${JSON.stringify(needle)}: ${err.message}`);
      else if (needle instanceof RegExp) assert.match(err.message, needle);
      return true;
    },
  );
}

function expectAccept(data) {
  validateNoOpaqueUserParams(data);
}

// ---- opaque shapes — should REJECT ----

test('github R_kgDO-style prefixed opaque ID is rejected', () => {
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'POST /graphql',
    body: { repositoryId: '{{repositoryId}}' },
    notes: {
      params: {
        repositoryId: { kind: 'id', example: 'R_kgDOSBP1dw', description: 'The repo node id' },
      },
    },
  };
  expectReject(data, 'R_kgDOSBP1dw');
  expectReject(data, 'opaque-internal-ID');
});

test('gid:// URI-schemed opaque ID is rejected', () => {
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'GET /items/{{itemId}}',
    notes: {
      params: {
        itemId: { kind: 'id', example: 'gid://service/Item/42' },
      },
    },
  };
  expectReject(data, 'URI-scheme');
});

test('long hex blob (MongoDB ObjectId) is rejected', () => {
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'GET /docs/{{docId}}',
    notes: {
      params: {
        docId: { kind: 'id', example: '507f1f77bcf86cd799439011' },
      },
    },
  };
  expectReject(data, 'long hex blob');
});

test('UUID is rejected', () => {
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'GET /orders/{{orderId}}',
    notes: {
      params: {
        orderId: { example: '550e8400-e29b-41d4-a716-446655440000' },
      },
    },
  };
  expectReject(data, 'UUID');
});

test('ULID is rejected', () => {
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'GET /events/{{eventId}}',
    notes: {
      params: {
        eventId: { example: '01HZXY3D7N9M2P4QR5V7W8TBK1' },
      },
    },
  };
  expectReject(data, 'ULID');
});

test('base64-shaped blob ≥30 chars is rejected', () => {
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'POST /submit',
    body: { token: '{{token}}' },
    notes: {
      params: {
        token: { example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9aBc123def456' },
      },
    },
  };
  expectReject(data, 'base64-shaped');
});

// ---- legitimate user args — should ACCEPT ----

test('small integer ID (issue number) is accepted', () => {
  expectAccept({
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'GET /issues/{{issueNumber}}',
    notes: {
      params: {
        issueNumber: { kind: 'id', example: '42' },
      },
    },
  });
});

test('human-readable slug is accepted', () => {
  expectAccept({
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'GET /repos/{{owner}}/{{repo}}',
    notes: {
      params: {
        owner: { kind: 'slug', example: 'klura-ai' },
        repo: { kind: 'slug', example: 'scratch' },
      },
    },
  });
});

test('email example is accepted', () => {
  expectAccept({
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'POST /users/{{email}}',
    notes: {
      params: {
        email: { kind: 'email', example: 'alice@example.com' },
      },
    },
  });
});

test('prose example (title text) is accepted', () => {
  expectAccept({
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'POST /posts',
    body: { title: '{{title}}' },
    notes: {
      params: {
        title: { kind: 'text', example: 'My first post' },
      },
    },
  });
});

test('short-int counter is accepted', () => {
  expectAccept({
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'GET /page/{{page}}',
    notes: {
      params: {
        page: { kind: 'id', example: '1' },
      },
    },
  });
});

// ---- exemption rules ----

test('opaque example in an UNREFERENCED param is accepted (documentation only)', () => {
  // If the placeholder isn't actually interpolated anywhere, the opaque
  // shape doesn't matter — it's just documentation for future authors.
  expectAccept({
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'GET /static/path',
    notes: {
      params: {
        legacyId: { kind: 'id', example: 'R_kgDOSBP1dw' },
      },
    },
  });
});

test('opaque example IS accepted when a prereq produces the same name', () => {
  // Prereq var shadows the param entry at resolve time — the params entry
  // is legacy description and harmless.
  expectAccept({
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'POST /graphql',
    body: { repositoryId: '{{repositoryId}}' },
    prerequisites: [
      {
        name: 'extractRepoId',
        kind: 'page-extract',
        url: 'https://example.com/{{owner}}/{{repo}}/issues/new',
        vars: {
          repositoryId: { selector: "script[data-target='react-partial.embeddedData']", attr: 'data-embedded-data' },
        },
      },
    ],
    notes: {
      params: {
        repositoryId: { kind: 'id', example: 'R_kgDOSBP1dw', description: 'echoed from prereq' },
        owner: { kind: 'slug', example: 'klura-ai' },
        repo: { kind: 'slug', example: 'scratch' },
      },
    },
  });
});

test('missing notes.params is a no-op', () => {
  expectAccept({
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'GET /static',
  });
});

test('notes without params is a no-op', () => {
  expectAccept({
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'GET /static',
    notes: { quirks: 'none' },
  });
});

test('param with no example is skipped (no shape to classify)', () => {
  expectAccept({
    strategy: 'fetch',
    baseUrl: 'https://example.com',
    endpoint: 'GET /x/{{y}}',
    notes: {
      params: {
        y: { kind: 'id', description: 'some id' },
      },
    },
  });
});

// ---- accumulator-grounded rejections ----
//
// The shape-regex bank is narrow (base64 blobs, UUID, ObjectId). Some
// opaque internal IDs are shapes the regex bank intentionally doesn't
// match — e.g. a 15-digit Messenger thread_id is pure numeric, same
// shape as an order number or tracking code a real user might type.
// The ground-truth signal is the accumulator: if the classifier
// observed this exact value in the response body of a lookup-shaped
// request, we have a receipt that the value comes from server-side
// machinery, not from the caller's fingers. That trumps shape analysis.

import {
  recordLookupCandidate,
  clearForSession,
  findCandidatesForLiteral,
} from '../dist/response/session-observations.js';

test('accumulator match: 15-digit numeric thread_id observed in lookup response → rejected', () => {
  const sid = 'sess-acc-1';
  clearForSession(sid);
  recordLookupCandidate(sid, {
    request_i: 47,
    url: 'https://www.example.com/api/graphql/',
    method: 'POST',
    input_shape: {
      method: 'POST',
      url_host: 'www.example.com',
      url_path: '/api/graphql/',
      query_keys: null,
      body_keys: ['query'],
      path_tail: null,
    },
    output_shape: {
      response_format: 'json',
      has_array_of_objects: true,
      id_fields: [
        {
          field_path: 'data.search.threads[0].id',
          value_shape: '10+ digit numeric',
          sample_value: '156025504001094',
        },
      ],
    },
    looks_like_lookup: true,
    lookup_confidence: 0.9,
  });

  const data = {
    strategy: 'page-script',
    protocol: 'websocket',
    transport: 'browser',
    baseUrl: 'https://www.example.com',
    wsUrl: 'wss://edge-chat.example.com/chat',
    frameEncoding: 'binary',
    generated: {
      frame: {
        code: "const text = String(args.text); const threadId = String(args.thread_id); return Buffer.from(text + threadId).toString('base64');",
      },
    },
    notes: {
      params: {
        text: { kind: 'text', example: 'Hello!' },
        thread_id: {
          kind: 'id',
          example: '156025504001094',
          description: 'Numeric thread ID of the recipient',
        },
      },
    },
  };

  assert.throws(
    () => validateNoOpaqueUserParams(data, sid, 'test-platform'),
    (err) => {
      assert.match(err.message, /notes\.params\.thread_id\.example/);
      assert.ok(
        err.message.includes('lookup accumulator observed this exact value'),
        `message missing accumulator reason: ${err.message}`,
      );
      return true;
    },
  );

  clearForSession(sid);
});

test('accumulator miss: same 15-digit numeric with no observation → accepted (shape alone is not enough)', () => {
  const sid = 'sess-acc-2';
  clearForSession(sid);

  // No accumulator data. 15-digit numeric is NOT in the shape bank so
  // (without a receipt) the validator has to defer to the LLM. The
  // agent's responsibility at this point — SKILL.md steps 7-8 tell them
  // to trace opaque values.
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: 'GET /threads/{{thread_id}}',
    notes: {
      params: {
        thread_id: { kind: 'id', example: '156025504001094' },
      },
    },
  };

  validateNoOpaqueUserParams(data, sid, 'test-platform');
});

test('accumulator-grounded path does not fire without session context (programmatic save)', () => {
  // No sessionId → accumulator lookup is skipped — same behavior as
  // before this addendum. Shape-regex bank is the only signal.
  const data = {
    strategy: 'fetch',
    baseUrl: 'https://www.example.com',
    endpoint: 'GET /threads/{{thread_id}}',
    notes: {
      params: {
        thread_id: { kind: 'id', example: '156025504001094' },
      },
    },
  };
  validateNoOpaqueUserParams(data);
});

// ---- caller-arg exemption: user-typed values bypass accumulator rejection ----

test('caller-arg exemption: user-typed value also echoed in lookup response → accepted', async () => {
  // Bauhaus-shape: agent types a SKU into a search field, server's
  // autocomplete responds with [{sku: "<typed>", name: "..."}], then agent
  // saves a strategy with notes.params.sku.example = "<typed>" and
  // kind: "id". Without the exemption the accumulator match rejects the
  // save even though the value is by-construction caller-sourced.
  const { setTypedValuesProvider } = await import('../dist/strategies/skills.js');
  const sid = 'sess-typed-1';
  clearForSession(sid);
  recordLookupCandidate(sid, {
    request_i: 3,
    url: 'https://www.example.com/search/ajax/suggest/?q=sku-12345',
    method: 'GET',
    input_shape: {
      method: 'GET',
      url_host: 'www.example.com',
      url_path: '/search/ajax/suggest/',
      query_keys: ['q'],
      body_keys: null,
      path_tail: null,
    },
    output_shape: {
      response_format: 'json',
      has_array_of_objects: true,
      id_fields: [
        {
          field_path: 'data.suggestions[0].sku',
          value_shape: 'short alphanumeric',
          sample_value: 'sku-12345',
        },
      ],
    },
    looks_like_lookup: true,
    lookup_confidence: 0.85,
  });

  setTypedValuesProvider(() => new Set(['sku-12345']));
  try {
    const data = {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: 'GET /products/{{sku}}',
      notes: {
        params: {
          sku: { kind: 'id', example: 'sku-12345', description: 'SKU' },
        },
      },
    };
    validateNoOpaqueUserParams(data, sid, 'test-platform');
  } finally {
    setTypedValuesProvider(null);
    clearForSession(sid);
  }
});

test('caller-arg exemption: lookup-only value (never typed) still rejects', async () => {
  // Negative case: the literal appears in a captured lookup response but
  // the user never typed it. Provider returns a Set without the value.
  // Behavior unchanged — accumulator match still rejects.
  const { setTypedValuesProvider } = await import('../dist/strategies/skills.js');
  const sid = 'sess-typed-2';
  clearForSession(sid);
  recordLookupCandidate(sid, {
    request_i: 1,
    url: 'https://www.example.com/api/threads',
    method: 'GET',
    input_shape: {
      method: 'GET',
      url_host: 'www.example.com',
      url_path: '/api/threads',
      query_keys: null,
      body_keys: null,
      path_tail: null,
    },
    output_shape: {
      response_format: 'json',
      has_array_of_objects: true,
      id_fields: [
        {
          field_path: 'data[0].id',
          value_shape: '15+ digit numeric',
          sample_value: '156025504001094',
        },
      ],
    },
    looks_like_lookup: true,
    lookup_confidence: 0.9,
  });

  setTypedValuesProvider(() => new Set(['something_else']));
  try {
    const data = {
      strategy: 'fetch',
      baseUrl: 'https://www.example.com',
      endpoint: 'GET /threads/{{thread_id}}',
      notes: {
        params: {
          thread_id: { kind: 'id', example: '156025504001094' },
        },
      },
    };
    assert.throws(
      () => validateNoOpaqueUserParams(data, sid, 'test-platform'),
      /lookup accumulator observed this exact value/,
    );
  } finally {
    setTypedValuesProvider(null);
    clearForSession(sid);
  }
});
