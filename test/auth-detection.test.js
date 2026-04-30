import test from 'node:test';
import assert from 'node:assert';
import { looksLikeAuthFailure, looksLikeStaleEndpoint } from '../dist/execution.js';

// looksLikeAuthFailure is structural: HTTP status (401/403), login-wall final
// URL, and machine-readable code-enum fields (`error`, `code`, `errors[].type`,
// `errors[].extensions.code`). Free-text prose fields (`message`,
// `errors[].message`) are NOT scanned — keyword-regex banks misclassify
// internationalized messages and ship as a strictly worse LLM. See
// runtime/docs/principles.md §"Crisp vs fuzzy".

test('looksLikeAuthFailure: 401 → true', () => {
  assert.strictEqual(looksLikeAuthFailure({ status: 401, body: {} }, ''), true);
});

test('looksLikeAuthFailure: 403 → true', () => {
  assert.strictEqual(looksLikeAuthFailure({ status: 403, body: {} }, ''), true);
});

test('looksLikeAuthFailure: 200 with /login in final URL → true', () => {
  assert.strictEqual(
    looksLikeAuthFailure({ status: 200, body: '<html>login</html>' }, 'https://example.com/login'),
    true,
  );
  assert.strictEqual(
    looksLikeAuthFailure({ status: 200, body: '' }, 'https://example.com/auth/signin?redirect=/home'),
    true,
  );
  assert.strictEqual(
    looksLikeAuthFailure({ status: 200, body: '' }, 'https://example.com/sessions/new'),
    true,
  );
});

test('looksLikeAuthFailure: body.error with structural code "session_expired" → true', () => {
  assert.strictEqual(
    looksLikeAuthFailure({ status: 200, body: { error: 'session_expired' } }, ''),
    true,
  );
});

test('looksLikeAuthFailure: body.code "UNAUTHORIZED" → true', () => {
  assert.strictEqual(
    looksLikeAuthFailure({ status: 200, body: { code: 'UNAUTHORIZED' } }, ''),
    true,
  );
});

test('looksLikeAuthFailure: body.error free-text prose → false (no keyword scan)', () => {
  assert.strictEqual(
    looksLikeAuthFailure(
      { status: 200, body: { error: 'Session expired, please log in again' } },
      '',
    ),
    false,
  );
});

test('looksLikeAuthFailure: body.message prose → false (message field never scanned)', () => {
  assert.strictEqual(
    looksLikeAuthFailure({ status: 200, body: { message: 'Unauthorized access' } }, ''),
    false,
  );
});

test('looksLikeAuthFailure: 400 with bad-args error → false', () => {
  assert.strictEqual(
    looksLikeAuthFailure({ status: 400, body: { error: 'invalid_param: query is required' } }, ''),
    false,
  );
});

test('looksLikeAuthFailure: 429 rate limit → false', () => {
  assert.strictEqual(
    looksLikeAuthFailure({ status: 429, body: { error: 'rate_limit_exceeded' } }, ''),
    false,
  );
});

test('looksLikeAuthFailure: 500 server error → false', () => {
  assert.strictEqual(
    looksLikeAuthFailure({ status: 500, body: { error: 'internal server error' } }, ''),
    false,
  );
});

test('looksLikeAuthFailure: 200 with legitimate data → false', () => {
  assert.strictEqual(
    looksLikeAuthFailure(
      { status: 200, body: { results: [{ name: 'Pizza Place' }] } },
      'https://example.com/api/search',
    ),
    false,
  );
});

test('looksLikeAuthFailure: 200 on /api/account (not a login URL) → false', () => {
  assert.strictEqual(
    looksLikeAuthFailure({ status: 200, body: { ok: true } }, 'https://example.com/api/account'),
    false,
  );
});

test('looksLikeAuthFailure: null body → false', () => {
  assert.strictEqual(looksLikeAuthFailure({ status: 200, body: null }, ''), false);
});

test('looksLikeAuthFailure: undefined finalUrl → handles gracefully', () => {
  assert.strictEqual(looksLikeAuthFailure({ status: 200, body: {} }, ''), false);
});

// --- GraphQL-shaped auth errors ---

test('looksLikeAuthFailure: 404 with GraphQL AUTHENTICATION error type → true', () => {
  assert.strictEqual(
    looksLikeAuthFailure(
      {
        status: 404,
        body: {
          errors: [
            {
              type: 'AUTHENTICATION',
              message: "Couldn't authenticate you",
              extensions: { code: 'authenticationError' },
            },
          ],
          data: {},
        },
      },
      'https://github.com/_graphql',
    ),
    true,
  );
});

test('looksLikeAuthFailure: 200 with GraphQL UNAUTHENTICATED extensions.code → true', () => {
  assert.strictEqual(
    looksLikeAuthFailure(
      {
        status: 200,
        body: { errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] },
      },
      '',
    ),
    true,
  );
});

test('looksLikeAuthFailure: 200 with GraphQL message prose → false (message never scanned)', () => {
  assert.strictEqual(
    looksLikeAuthFailure(
      {
        status: 200,
        body: { errors: [{ message: 'You need to authenticate to access this resource' }] },
      },
      '',
    ),
    false,
  );
});

test('looksLikeAuthFailure: 200 with REST body.code UNAUTHORIZED → true', () => {
  assert.strictEqual(
    looksLikeAuthFailure({ status: 200, body: { code: 'UNAUTHORIZED' } }, ''),
    true,
  );
});

test('looksLikeAuthFailure: 400 with GraphQL INVALID_PARAM (not auth) → false', () => {
  assert.strictEqual(
    looksLikeAuthFailure(
      {
        status: 400,
        body: { errors: [{ type: 'INVALID_PARAM', message: 'id is required' }] },
      },
      '',
    ),
    false,
  );
});

test('looksLikeAuthFailure: 200 with GraphQL rate-limit message → false', () => {
  assert.strictEqual(
    looksLikeAuthFailure(
      {
        status: 200,
        body: { errors: [{ message: 'rate limit exceeded, retry in 60s' }] },
      },
      '',
    ),
    false,
  );
});

test('looksLikeAuthFailure: 200 with body.errors non-array → handles gracefully', () => {
  assert.strictEqual(
    looksLikeAuthFailure({ status: 200, body: { errors: 'some string' } }, ''),
    false,
  );
  assert.strictEqual(
    looksLikeAuthFailure({ status: 200, body: { errors: { wat: 'yes' } } }, ''),
    false,
  );
});

test('looksLikeAuthFailure: multiple GraphQL errors, one with AUTHENTICATION type → true', () => {
  assert.strictEqual(
    looksLikeAuthFailure(
      {
        status: 200,
        body: {
          errors: [
            { message: 'warning: deprecated field' },
            { type: 'AUTHENTICATION', message: 'bad credentials' },
          ],
        },
      },
      '',
    ),
    true,
  );
});

// --- looksLikeStaleEndpoint ---
//
// Status-only check. 404/410/405 are unambiguous "endpoint retired" signals.
// 400 is ambiguous (can mean bad-args, validation failure, or stale endpoint
// — varies by API), so it's deferred to the auth/generic path. Body-text
// keyword matching is intentionally absent.

test('looksLikeStaleEndpoint: 404 → true', () => {
  assert.strictEqual(looksLikeStaleEndpoint({ status: 404, body: {} }), true);
});

test('looksLikeStaleEndpoint: 410 Gone → true', () => {
  assert.strictEqual(looksLikeStaleEndpoint({ status: 410, body: {} }), true);
});

test('looksLikeStaleEndpoint: 405 Method Not Allowed → true', () => {
  assert.strictEqual(looksLikeStaleEndpoint({ status: 405, body: {} }), true);
});

test('looksLikeStaleEndpoint: 400 → false (ambiguous; deferred to auth/generic path)', () => {
  assert.strictEqual(
    looksLikeStaleEndpoint({ status: 400, body: { error: 'invalid user id' } }),
    false,
  );
  assert.strictEqual(
    looksLikeStaleEndpoint({ status: 400, body: { message: 'missing parameter: recipient' } }),
    false,
  );
  assert.strictEqual(
    looksLikeStaleEndpoint({ status: 400, body: { error: 'user does not exist' } }),
    false,
  );
});

test('looksLikeStaleEndpoint: 401 → false (auth path handles this)', () => {
  assert.strictEqual(looksLikeStaleEndpoint({ status: 401, body: {} }), false);
});

test('looksLikeStaleEndpoint: 403 → false (auth path handles this)', () => {
  assert.strictEqual(looksLikeStaleEndpoint({ status: 403, body: {} }), false);
});

test('looksLikeStaleEndpoint: 500 → false', () => {
  assert.strictEqual(
    looksLikeStaleEndpoint({ status: 500, body: { error: 'internal server error' } }),
    false,
  );
});

test('looksLikeStaleEndpoint: 200 OK → false', () => {
  assert.strictEqual(looksLikeStaleEndpoint({ status: 200, body: { ok: true } }), false);
});

test('looksLikeStaleEndpoint: null body on 400 → false', () => {
  assert.strictEqual(looksLikeStaleEndpoint({ status: 400, body: null }), false);
});
