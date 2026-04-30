// Pure response builder for the get_send_encoder tool. Wraps the
// driver-supplied capture info with a stable js_eval handle path and structural
// advice. Kept dependency-free so it can be unit-tested without spinning up a
// pool, driver, or browser.
//
// CRITICAL: the response must contain ZERO brand-specific or framework-
// specific tokens. The runtime exposes WHAT was captured; the LLM reasons about
// WHERE the encoder lives in the page from the source it reads via
// get_js_source. Agent-facing surfaces stay platform-agnostic — the test for
// this module asserts the response against a forbidden-token allowlist.

export interface SendEncoderDriverInfo {
  sent_args_preview: string;
  sent_args_type: string;
  sent_args_byte_length: number;
  ws_url: string;
  head_hex: string;
  ts: number;
  handle_alive: boolean;
  /** Key used to address the captured entry in the page-side cache.
   *  Differs from the agent's `ws_i` (the latter counts sent + received;
   *  this one counts only sent). Plumbed through so `encoder_handle`
   *  points at the right slot regardless of how received frames have
   *  shifted ws_i. */
  encoder_key: string;
}

export interface SendEncoderResponse extends SendEncoderDriverInfo {
  encoder_handle: string;
  advice: string;
}

export function composeSendEncoderResponse(
  info: SendEncoderDriverInfo,
  wsI: number,
): SendEncoderResponse {
  const handle = `window.__kluraSendEncoders[${info.encoder_key}]`;
  return {
    ...info,
    encoder_handle: handle,
    advice:
      `The captured WebSocket instance is at ${handle}.ws; the original send args are at ${handle}.sentArgs ` +
      `(type: ${info.sent_args_type}, ${info.sent_args_byte_length} bytes). ` +
      `Read the encoder source via inspect_ws_frame(${wsI}).js_callstack + get_js_source(<file>, {line}) ` +
      `to learn what transforms produced these bytes from the input you typed. From there: ` +
      `(a) if the source shows the encoder lives at a stable global path you can re-locate at warm time, ` +
      `save a page-script strategy with a js-eval prereq calling that path; ` +
      `(b) if the encoder is closure-private, write generated.frame.code in a Node sandbox reproducing the transforms you read in source; ` +
      `(c) for in-session verification of either path, js_eval(\`return ${handle}.ws.send(<your_constructed_bytes>)\`) ` +
      `sends through the same connection that produced the captured frame.`,
  };
}
