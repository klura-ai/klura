// Unit tests for the response shape of get_send_encoder.
//
// CRITICAL: this test asserts the response body contains ZERO brand- or
// framework-specific identifiers (Facebook, Messenger, Apollo, Redux, MQTT,
// Reddit, etc.) — the design principle in docs/principles.md is that
// LLM-facing surfaces stay platform-agnostic, and this addendum's "let the LLM reason
// about WHERE the encoder lives" stance breaks immediately if the runtime
// even hints at a hardcoded global path. The advice text MUST describe
// primitives (handles, transforms, prereqs) and let the agent pick the path.

import test from 'node:test';
import assert from 'node:assert';

const { composeSendEncoderResponse } = await import(
  '../dist/response/send-encoder-shape.js'
);

// Forbidden tokens — anything brand- or framework-specific that would
// constitute a runtime-injected hint about where the agent should look.
// If a future feature legitimately needs to mention one of these, it
// belongs in REFERENCE.md, not in a runtime tool response.
const FORBIDDEN_BRAND_TOKENS = [
  /facebook/i,
  /messenger/i,
  /\bMQTT\b/,
  /apollo/i,
  /\bRedux\b/,
  /__APOLLO__/,
  /__REDUX__/,
  /__INITIAL_STATE__/,
  /__NEXT_DATA__/,
  /\bwindow\.M\b/,
  /reddit/i,
  /github/i,
  /tiktok/i,
  /instagram/i,
  /twitter/i,
];

function assertResponseIsBrandFree(obj) {
  const json = JSON.stringify(obj);
  for (const re of FORBIDDEN_BRAND_TOKENS) {
    assert.ok(!re.test(json), `response contains forbidden brand token ${re}: ${json}`);
  }
}

const SAMPLE_INFO = {
  sent_args_preview: '32fd0900076c735f726571',
  sent_args_type: 'TypedArray',
  sent_args_byte_length: 1255,
  ws_url: 'wss://chat.example.com/ws',
  head_hex: '32fd09000700076c735f72',
  ts: 1729345234234,
  handle_alive: true,
  encoder_key: '168',
};

test('composeSendEncoderResponse: encoder_handle uses encoder_key (not ws_i)', () => {
  // ws_i counts sent + received frames; encoder_key is the page-side
  // cache index that counts only sent. They diverge on chatty sites.
  // The handle must address the page-side cache using encoder_key.
  const a = composeSendEncoderResponse(SAMPLE_INFO, 504);
  assert.strictEqual(a.encoder_handle, 'window.__kluraSendEncoders[168]');
  const b = composeSendEncoderResponse({ ...SAMPLE_INFO, encoder_key: '7' }, 100);
  assert.strictEqual(b.encoder_handle, 'window.__kluraSendEncoders[7]');
});

test('composeSendEncoderResponse: spreads driver info verbatim', () => {
  const r = composeSendEncoderResponse(SAMPLE_INFO, 5);
  assert.strictEqual(r.sent_args_preview, SAMPLE_INFO.sent_args_preview);
  assert.strictEqual(r.sent_args_type, SAMPLE_INFO.sent_args_type);
  assert.strictEqual(r.sent_args_byte_length, SAMPLE_INFO.sent_args_byte_length);
  assert.strictEqual(r.ws_url, SAMPLE_INFO.ws_url);
  assert.strictEqual(r.head_hex, SAMPLE_INFO.head_hex);
  assert.strictEqual(r.ts, SAMPLE_INFO.ts);
  assert.strictEqual(r.handle_alive, SAMPLE_INFO.handle_alive);
});

test('composeSendEncoderResponse: advice references the right next-step tools', () => {
  const r = composeSendEncoderResponse(SAMPLE_INFO, 471);
  assert.match(r.advice, /inspect_ws_frame/);
  assert.match(r.advice, /get_js_source/);
  assert.match(r.advice, /js_eval/);
  assert.match(r.advice, /generated\.frame\.code/);
  assert.match(r.advice, /page-script/);
});

test('composeSendEncoderResponse: advice references the captured handle', () => {
  const r = composeSendEncoderResponse(SAMPLE_INFO, 471);
  // Handle is addressed by encoder_key (168), not ws_i (471) — but the
  // advice mentions ws_i when referring the agent to inspect_ws_frame /
  // js_callstack (those ARE indexed by ws_i). Both conventions are
  // semantically correct in their context.
  assert.match(r.advice, /window\.__kluraSendEncoders\[168\]\.ws/);
  assert.match(r.advice, /window\.__kluraSendEncoders\[168\]\.sentArgs/);
  assert.match(r.advice, /inspect_ws_frame\(471\)/);
});

test('composeSendEncoderResponse: response is brand-free (principles.md compliance)', () => {
  const r = composeSendEncoderResponse(SAMPLE_INFO, 471);
  assertResponseIsBrandFree(r);
});

test('composeSendEncoderResponse: brand-free across many ws_i values', () => {
  for (const i of [0, 1, 100, 471, 9999]) {
    const r = composeSendEncoderResponse(SAMPLE_INFO, i);
    assertResponseIsBrandFree(r);
  }
});

test('composeSendEncoderResponse: handles type variations without brand drift', () => {
  for (const sent_args_type of ['string', 'ArrayBuffer', 'TypedArray', 'Blob', 'unknown']) {
    const r = composeSendEncoderResponse({ ...SAMPLE_INFO, sent_args_type }, 0);
    assertResponseIsBrandFree(r);
    assert.match(r.advice, new RegExp(sent_args_type));
  }
});

test('composeSendEncoderResponse: advice does NOT suggest a specific global path', () => {
  const r = composeSendEncoderResponse(SAMPLE_INFO, 0);
  // The advice must use language like "if the source shows the encoder lives
  // at a stable global path" — leaving the AGENT to pick the path. It MUST
  // NOT contain a literal `window.<X>.<fn>(` pattern that would name a
  // specific location.
  assert.doesNotMatch(r.advice, /window\.\w+\.\w+\s*\(/, `advice should not name a specific global function: ${r.advice}`);
});
