// Context-bound page-script primitives: `evaluate_in_iframe`,
// `evaluate_in_iframe_chain`, `evaluate_in_worker`. Third RE-toolkit
// axis parallel to binary-WS (`inspect_ws_frame` + `try_generator`) and
// HTTP-signer-source (`search_js_source` + `read_js_function`).
//
// When a captured request 200:ed live but the same request from the
// main frame's context (`js_eval` / Node-side fetch) returns 401/403,
// the server may be validating tokens that bind to the JS-execution
// context that generated them — vendor SDK init in an iframe, proof-
// of-work bound to its WebWorker origin, iframe-init-bound CSRF
// cookies. These primitives give the agent access to the matching
// execution context so the request can fire from where the server
// expects it. The runtime never RE:s the binding itself; the agent
// composes the in-context JS, the runtime hosts the context.
//
// Driver-method shape lives on `BrowserDriver` (interface.ts) so
// non-playwright drivers can no-op cleanly. Recording into the
// session's `ArtifactAccumulator` lets the lift-time signer-discovery
// gate credit context-bound usage as RE evidence.

import { pool } from '../runtime-state';
import { ensureAccumulator, ringPush, digestSelector } from '../strategies/discovery-artifact';
import { guardLargeResult } from '../response/response-size';
import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from './types';

export interface EvaluateInIframeArgs {
  session_id: string;
  iframe_src: string;
  expression: string;
  wait_for_ms?: number;
  timeout_ms?: number;
  cleanup?: boolean;
}

type EvalResponse =
  | ({ ok: true; duration_ms: number } & Record<string, unknown>)
  | { ok: false; error: string };

export async function evaluateInIframe(args: EvaluateInIframeArgs): Promise<EvalResponse> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.iframe_src !== 'string' || args.iframe_src.length === 0) {
    throw new Error('iframe_src is required (non-empty string)');
  }
  if (typeof args.expression !== 'string' || args.expression.length === 0) {
    throw new Error('expression is required (non-empty string)');
  }
  if (args.expression.length > 4096) throw new Error('expression must be ≤ 4096 chars');
  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 10_000, 1000), 60_000);
  const waitForMs = Math.min(Math.max(args.wait_for_ms ?? 1500, 0), 30_000);
  const cleanup = args.cleanup !== false;
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  ringPush(ensureAccumulator(session).evaluateInIframeCalls, {
    src_digest: digestSelector(args.iframe_src),
    expression_digest: digestSelector(args.expression),
    at: new Date().toISOString(),
  });
  const t0 = Date.now();
  try {
    const result = await driver.evaluateInIframe(session, {
      src: args.iframe_src,
      expression: args.expression,
      waitForMs,
      timeoutMs,
      cleanup,
    });
    const guarded = guardLargeResult(result, undefined, undefined, 'evaluate_in_iframe');
    return { ok: true, ...guarded, duration_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface EvaluateInIframeChainArgs {
  session_id: string;
  iframe_src: string;
  steps: Array<{ expression: string; wait_for_ms?: number }>;
  timeout_ms?: number;
  cleanup?: boolean;
  return_all?: boolean;
}

export async function evaluateInIframeChain(
  args: EvaluateInIframeChainArgs,
): Promise<EvalResponse> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.iframe_src !== 'string' || args.iframe_src.length === 0) {
    throw new Error('iframe_src is required (non-empty string)');
  }
  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    throw new Error('steps is required (non-empty array)');
  }
  if (args.steps.length > 10) throw new Error('steps capped at 10 per call');
  for (let i = 0; i < args.steps.length; i++) {
    const s = args.steps[i];
    if (!s || typeof s.expression !== 'string' || s.expression.length === 0) {
      throw new Error(`steps[${i}].expression is required (non-empty string)`);
    }
    if (s.expression.length > 4096) throw new Error(`steps[${i}].expression must be ≤ 4096 chars`);
  }
  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 15_000, 1000), 90_000);
  const cleanup = args.cleanup !== false;
  const returnAll = args.return_all === true;
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  ringPush(ensureAccumulator(session).evaluateInIframeChainCalls, {
    src_digest: digestSelector(args.iframe_src),
    step_count: args.steps.length,
    at: new Date().toISOString(),
  });
  const t0 = Date.now();
  try {
    const result = await driver.evaluateInIframeChain(session, {
      src: args.iframe_src,
      steps: args.steps.map((s) => ({
        expression: s.expression,
        waitForMs: Math.min(Math.max(s.wait_for_ms ?? 0, 0), 30_000),
      })),
      timeoutMs,
      cleanup,
      returnAll,
    });
    const guarded = guardLargeResult(result, undefined, undefined, 'evaluate_in_iframe_chain');
    return { ok: true, ...guarded, duration_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface EvaluateInWorkerArgs {
  session_id: string;
  worker_source: string;
  message?: unknown;
  timeout_ms?: number;
}

export async function evaluateInWorker(args: EvaluateInWorkerArgs): Promise<EvalResponse> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.worker_source !== 'string' || args.worker_source.length === 0) {
    throw new Error('worker_source is required (non-empty string)');
  }
  if (args.worker_source.length > 16_384) throw new Error('worker_source must be ≤ 16384 chars');
  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 10_000, 1000), 60_000);
  const session = pool.getSession(args.session_id);
  const driver = pool.driverFor(args.session_id);
  ringPush(ensureAccumulator(session).evaluateInWorkerCalls, {
    source_digest: digestSelector(args.worker_source),
    at: new Date().toISOString(),
  });
  const t0 = Date.now();
  try {
    const result = await driver.evaluateInWorker(session, {
      source: args.worker_source,
      message: args.message,
      timeoutMs,
    });
    const guarded = guardLargeResult(result, undefined, undefined, 'evaluate_in_worker');
    return { ok: true, ...guarded, duration_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.evaluateInIframe,
    description:
      'Spawn an iframe at `iframe_src` on the active page, run `expression` inside `iframe.contentWindow`, return the result, optionally remove the iframe. Same response shape as `js_eval`. Use when a captured request 200:ed live but the same request from main-frame context (`js_eval` / Node fetch) returns 401/403 — the server may be validating tokens bound to the JS-execution context that generated them (vendor SDK init in an iframe, KPSDK-class proof-of-work bound to its iframe origin, iframe-init-bound CSRF cookies). The iframe gives the request the matching execution context. Third RE-toolkit axis parallel to `inspect_ws_frame` + `try_generator` (binary WS) and `search_js_source` + `read_js_function` (HTTP signer). Cross-origin iframes are opaque from the parent — `iframe_src` must be same-origin to the page (or `"/"` for the page\'s own origin). Cross-origin loads return `iframe_eval_failed`. Expression cap 4096 chars; timeout default 10000ms (max 60000).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        iframe_src: {
          type: 'string',
          description:
            'URL or path the iframe loads. Must be same-origin to the active page (cross-origin is opaque from the parent — agent cannot read into it). `"/"` works for most cases — the iframe loads the site\'s root in a fresh context.',
        },
        expression: {
          type: 'string',
          description: 'JS expression to run inside iframe.contentWindow. Async OK.',
        },
        wait_for_ms: {
          type: 'number',
          description:
            "Post-load settle wait before running the expression — gives the iframe's own JS (vendor SDKs, frameworks) time to initialize. Default 1500, max 30000.",
        },
        timeout_ms: { type: 'number', description: 'Overall cap. Default 10000, max 60000.' },
        cleanup: {
          type: 'boolean',
          description:
            'Remove the iframe after evaluation. Default true. Set false when chaining multiple calls against the same iframe state — prefer `evaluate_in_iframe_chain` for that.',
        },
      },
      required: ['session_id', 'iframe_src', 'expression'],
    },
    handler: (args: any) =>
      evaluateInIframe({
        session_id: args.session_id,
        iframe_src: args.iframe_src,
        expression: args.expression,
        wait_for_ms: args.wait_for_ms,
        timeout_ms: args.timeout_ms,
        cleanup: args.cleanup,
      }),
  },
  {
    name: TOOL_NAMES.evaluateInIframeChain,
    description:
      'Spawn ONE iframe at `iframe_src` and run a sequence of expressions inside its context, persisting state across steps. Returns the last step\'s result (or all steps when `return_all: true`). Use when a single tool call needs "wait for vendor SDK ready" → "fetch protected route" → "return result" as one chain — saves the spawn cost of multiple `evaluate_in_iframe` calls, and keeps the context alive between steps (initialized globals, in-flight promises, cookies set by the first step). Steps cap at 10. Per-step `wait_for_ms` lets the agent settle between operations (e.g. "wait 200ms after fetch for the response handler to run"). Same response shape as `js_eval`.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        iframe_src: {
          type: 'string',
          description: 'Same as `evaluate_in_iframe.iframe_src` — must be same-origin to the page.',
        },
        steps: {
          type: 'array',
          description:
            'Ordered list of expressions to run inside the spawned iframe. Each step receives the iframe state mutated by prior steps.',
          items: {
            type: 'object',
            properties: {
              expression: { type: 'string', description: 'JS expression. Async OK.' },
              wait_for_ms: {
                type: 'number',
                description:
                  'Pre-step settle wait. Default 0. Use for steps that follow async work the previous step kicked off.',
              },
            },
            required: ['expression'],
          },
        },
        timeout_ms: {
          type: 'number',
          description: 'Overall cap across all steps. Default 15000, max 90000.',
        },
        cleanup: {
          type: 'boolean',
          description: 'Remove the iframe after the chain. Default true.',
        },
        return_all: {
          type: 'boolean',
          description:
            'When true, return an array of all step results. Default false (last step only — the canonical "final fetch result" shape).',
        },
      },
      required: ['session_id', 'iframe_src', 'steps'],
    },
    handler: (args: any) =>
      evaluateInIframeChain({
        session_id: args.session_id,
        iframe_src: args.iframe_src,
        steps: args.steps,
        timeout_ms: args.timeout_ms,
        cleanup: args.cleanup,
        return_all: args.return_all,
      }),
  },
  {
    name: TOOL_NAMES.evaluateInWorker,
    description:
      "Spawn a Web Worker from `worker_source` on the active page, optionally `postMessage(message)`, wait for the first response message, terminate. The worker source MUST call `self.postMessage(result)` when its computation is done — otherwise the call times out. Use when the server binds tokens to a WebWorker context (vendor SDKs that run proof-of-work in a dedicated worker so the main thread never sees the computation; the resulting token only validates on requests fired from that worker). Pair with `search_js_source` / `read_js_function` to extract the relevant worker-bootstrap code from the vendor's bundle, then run it here. Same response shape as `js_eval`. Source cap 16384 chars; timeout default 10000ms (max 60000).",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        worker_source: {
          type: 'string',
          description:
            'Worker JS source. Runs inside a dedicated Worker via a blob URL. MUST call `self.postMessage(result)` to return.',
        },
        message: {
          description:
            'Payload posted to the worker via `postMessage` on spawn. The worker reads it via `self.onmessage = (e) => { ... e.data ... }`.',
        },
        timeout_ms: { type: 'number', description: 'Default 10000, max 60000.' },
      },
      required: ['session_id', 'worker_source'],
    },
    handler: (args: any) =>
      evaluateInWorker({
        session_id: args.session_id,
        worker_source: args.worker_source,
        message: args.message,
        timeout_ms: args.timeout_ms,
      }),
  },
];
