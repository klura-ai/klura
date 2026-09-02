import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { canonicalJson, parseStrictJson, type JsonValueV1 } from '../../../public/contracts/json';
import { validateJsonSchema } from '../../../public/contracts/json-schema';
import type {
  PublicBrowserPageScriptStrategyV1,
  PublicBrowserPageScriptResultShapeV1,
  PublicReadCapabilityV1,
} from '../../../public/contracts/package';
import { evaluateValueExpression } from '../../../public/contracts/value-expression';
import { PublicHttpExecutionError, type PublicHttpResponseV1 } from '../node-http';
import {
  BrowserInteractionExecutionError,
  executeBrowserInteractionProgram,
} from './interaction-executor';
import {
  createPublicBrowserContextOptions,
  installPublicSinglePageGuard,
  launchPublicBrowser,
} from './context';
import {
  installBrowserNetworkBoundary,
  type BrowserNetworkBoundaryV1,
  type PublicBrowserExecutionOptionsV1,
} from './executor';
import { resolveNavigationUrl, waitForBrowserStrategy } from './navigation-helpers';
import { evaluateOutcomeSelectors } from './outcome-selectors';
import { startPinnedEgressProxy, type PinnedEgressProxyV1 } from './pinned-proxy';

const PREPARATION_PROJECTION = {
  item_selector: 'html',
  cardinality: 'one',
  fields: {
    document_text: { kind: 'text', selector: null, required: false },
  },
} as const;

type ReviewedPageProgramFailureCodeV1 =
  | 'response_too_large'
  | 'response_contract_mismatch'
  | 'transport_failure';

class ReviewedPageProgramExecutionError extends Error {
  constructor(
    public readonly code: ReviewedPageProgramFailureCodeV1,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewedPageProgramExecutionError';
  }
}

/** Executes signed, maintainer-reviewed source only inside an isolated browser page. */
export async function executeBrowserPageScriptStrategy(
  capability: PublicReadCapabilityV1,
  strategy: PublicBrowserPageScriptStrategyV1,
  options: PublicBrowserExecutionOptionsV1,
): Promise<PublicHttpResponseV1> {
  if (!capability.strategies.includes(strategy)) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'strategy is absent from the selected capability',
    );
  }
  if (capability.authentication.mode !== 'none' || options.storage_state !== undefined) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'browser page-script execution does not admit authenticated browser state',
    );
  }
  if (capability.browser_resources === null) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'browser page script has no resource policy',
    );
  }
  if (!Number.isSafeInteger(options.timeout_ms) || options.timeout_ms < 1) {
    throw new PublicHttpExecutionError('invalid_request', 'timeout_ms must be a positive integer');
  }
  if (
    !Number.isSafeInteger(options.max_target_requests) ||
    options.max_target_requests < 1 ||
    options.max_target_requests > capability.max_target_requests_per_call
  ) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'max_target_requests must fit the selected capability budget',
    );
  }
  validateJsonSchema(options.input, capability.input_schema, 'call.input');
  let argumentsValue: JsonValueV1;
  try {
    argumentsValue = evaluateValueExpression(strategy.program.arguments, {
      input: options.input,
      bindings: options.bindings,
    });
  } catch (error) {
    throw new PublicHttpExecutionError('invalid_request', errorMessage(error));
  }
  const url = resolveNavigationUrl(
    strategy,
    options.input,
    options.bindings,
    capability.navigation_origins,
  );
  const deadline = new AbortController();
  const deadlineState = { timed_out: false };
  const timer = setTimeout(() => {
    deadlineState.timed_out = true;
    deadline.abort();
  }, options.timeout_ms);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  let browser: Browser | null = null;
  let proxy: PinnedEgressProxyV1 | null = null;
  let boundary: BrowserNetworkBoundaryV1 | null = null;
  try {
    if (signal.aborted) {
      throw new PublicHttpExecutionError('cancelled', 'caller cancelled before browser launch');
    }
    proxy = await startPinnedEgressProxy({
      allowed_origins: capability.browser_resources.egress_rules.map((rule) => rule.origin),
      max_wire_bytes: capability.browser_resources.max_proxy_wire_bytes_per_browser_task,
      connect_timeout_ms: Math.min(options.timeout_ms, 60_000),
      resolve_host: options.resolve_host,
    });
    browser = await launchPublicBrowser(proxy);
    const context = await browser.newContext(createPublicBrowserContextOptions(undefined));
    const pageProgramRunner = await installReviewedPageProgramRunner(context);
    await context.routeWebSocket('**/*', (webSocket) => webSocket.close());
    const page = await context.newPage();
    const pageGuard = await installPublicSinglePageGuard(context, page);
    boundary = await installBrowserNetworkBoundary({
      page,
      capability,
      options: { ...options, signal },
    });
    const abort = (): void => {
      void context.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeout_ms,
      });
      if (!response) {
        throw new PublicHttpExecutionError(
          'transport_failure',
          'browser navigation did not produce a document response',
          boundary.target_requests(),
        );
      }
      await waitForBrowserStrategy(page, boundary, strategy.wait, signal, options.timeout_ms);
      if (strategy.interaction !== null) {
        await executeBrowserInteractionProgram({
          page,
          program: strategy.interaction,
          projection: PREPARATION_PROJECTION,
          maximum_output_bytes: capability.max_encoded_outcome_bytes,
          expression_context: { input: options.input, bindings: options.bindings },
          strategy_id: strategy.strategy_id,
          network: boundary,
          signal,
          timeout_ms: options.timeout_ms,
        });
      }
      assertPageScriptOrigin(page.url(), capability.navigation_origins[0] as string);
      const scriptScope = boundary.beginPageScript(
        strategy.strategy_id,
        strategy.program.expect,
        strategy.program.request_body_limits,
      );
      let body: JsonValueV1;
      try {
        body = await executeReviewedPageProgram(
          page,
          pageProgramRunner,
          strategy.program.source,
          argumentsValue,
          strategy.program.result_shape,
          capability.max_encoded_outcome_bytes,
        );
        if (strategy.program.expect.wait !== null) {
          await waitForBrowserStrategy(
            page,
            boundary,
            strategy.program.expect.wait,
            signal,
            options.timeout_ms,
          );
        }
        await boundary.finishPageScript(scriptScope, strategy.program.expect, signal);
      } catch (error) {
        boundary.abortPageScript(scriptScope);
        throw error;
      }
      const selectorMatches = await evaluateOutcomeSelectors(page, capability, strategy);
      pageGuard.assertHealthy();
      boundary.assertHealthy();
      return {
        status: 200,
        headers: {},
        media_type: 'application/json',
        body_kind: Array.isArray(body) ? 'json_array' : 'json_object',
        body,
        target_requests: boundary.target_requests(),
        html_selector_exists: (selector: string) => selectorMatches.get(selector) ?? false,
      };
    } finally {
      signal.removeEventListener('abort', abort);
      await context.close();
    }
  } catch (error) {
    const targetRequests = boundary?.target_requests() ?? 0;
    if (deadlineState.timed_out) {
      throw new PublicHttpExecutionError(
        'request_timeout',
        'browser page-script deadline expired',
        targetRequests,
      );
    }
    if (signal.aborted) {
      throw new PublicHttpExecutionError(
        'cancelled',
        'caller cancelled browser page-script execution',
        targetRequests,
      );
    }
    if (error instanceof PublicHttpExecutionError) throw error;
    if (error instanceof BrowserInteractionExecutionError) {
      throw new PublicHttpExecutionError(
        'browser_interaction_failed',
        error.message,
        targetRequests,
        error.failure,
      );
    }
    if (error instanceof ReviewedPageProgramExecutionError) {
      throw new PublicHttpExecutionError(error.code, error.message, targetRequests);
    }
    throw new PublicHttpExecutionError('transport_failure', errorMessage(error), targetRequests);
  } finally {
    clearTimeout(timer);
    await boundary?.close();
    await browser?.close();
    await proxy?.close();
  }
}

/**
 * Installs one non-replaceable main-world runner before target scripts execute.
 * Its closure captures pristine intrinsics while preserving local js-eval
 * access to page-defined globals.
 */
export async function installReviewedPageProgramRunner(context: BrowserContext): Promise<string> {
  const runnerName = `__klura_reviewed_page_program_${randomUUID().replaceAll('-', '')}`;
  await context.addInitScript(installReviewedPageProgramRunnerInPage, runnerName);
  return runnerName;
}

/**
 * Executes reviewed source through the sealed page runner and strictly
 * reparses its JSON in Node.
 */
export async function executeReviewedPageProgram(
  page: Page,
  runnerName: string,
  source: string,
  input: JsonValueV1,
  resultShape: PublicBrowserPageScriptResultShapeV1,
  maximumBytes: number,
): Promise<JsonValueV1> {
  const inputJson = canonicalJson(input);
  const resultShapeJson = canonicalJson({
    kind: resultShape.kind,
    required_keys: resultShape.required_keys,
  });
  const runnerResult: unknown = await page.evaluate(
    async ({ runnerName, source, inputJson, resultShapeJson, maximumBytes }) => {
      const runner = (
        globalThis as unknown as Record<
          string,
          (
            source: string,
            inputJson: string,
            resultShapeJson: string,
            maximumBytes: number,
          ) => Promise<
            | { kind: 'success'; encoded: string }
            | {
                kind: 'failure';
                code: 'output_too_large' | 'result_contract_mismatch' | 'execution_failed';
              }
          >
        >
      )[runnerName];
      if (typeof runner !== 'function') {
        throw new TypeError('reviewed page program runner is unavailable');
      }
      return await runner(source, inputJson, resultShapeJson, maximumBytes);
    },
    { runnerName, source, inputJson, resultShapeJson, maximumBytes },
  );
  if (runnerResult === null || typeof runnerResult !== 'object') {
    throw new ReviewedPageProgramExecutionError(
      'transport_failure',
      'reviewed page program runner returned an invalid envelope',
    );
  }
  const envelope = runnerResult as Record<string, unknown>;
  if (envelope.kind === 'failure') {
    if (envelope.code === 'output_too_large') {
      throw new ReviewedPageProgramExecutionError(
        'response_too_large',
        'page program result exceeds its signed byte ceiling',
      );
    }
    if (envelope.code === 'result_contract_mismatch') {
      throw new ReviewedPageProgramExecutionError(
        'response_contract_mismatch',
        'page program result violates its signed result contract',
      );
    }
    if (envelope.code === 'execution_failed') {
      throw new ReviewedPageProgramExecutionError(
        'transport_failure',
        'reviewed page program execution failed',
      );
    }
    throw new ReviewedPageProgramExecutionError(
      'transport_failure',
      'reviewed page program runner returned an unknown failure code',
    );
  }
  if (envelope.kind !== 'success' || typeof envelope.encoded !== 'string') {
    throw new ReviewedPageProgramExecutionError(
      'transport_failure',
      'reviewed page program runner returned an invalid success envelope',
    );
  }
  const encoded = envelope.encoded;
  if (Buffer.byteLength(encoded, 'utf8') > maximumBytes) {
    throw new ReviewedPageProgramExecutionError(
      'response_too_large',
      'page program result exceeds its signed byte ceiling',
    );
  }
  let result: JsonValueV1;
  try {
    result = parseStrictJson(encoded, 'page program result', maximumBytes, 32);
  } catch {
    throw new ReviewedPageProgramExecutionError(
      'response_contract_mismatch',
      'page program result is not bounded strict JSON',
    );
  }
  if (result === null || typeof result !== 'object') {
    throw new ReviewedPageProgramExecutionError(
      'response_contract_mismatch',
      'reviewed page program result must be a JSON object or array',
    );
  }
  try {
    assertReviewedPageProgramResultShape(result, resultShape);
  } catch {
    throw new ReviewedPageProgramExecutionError(
      'response_contract_mismatch',
      'page program result violates its signed result shape',
    );
  }
  return result;
}

// This whole function is serialized into the browser before target scripts execute.
/* eslint-disable
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unnecessary-type-arguments,
  @typescript-eslint/restrict-plus-operands,
  @typescript-eslint/unbound-method,
  sonarjs/code-eval
*/
function installReviewedPageProgramRunnerInPage(runnerName: string): void {
  const defineProperty = Object.defineProperty;
  const objectPrototype = Object.prototype;
  const functionCall = Function.prototype.call;
  const arrayIsArray = Array.isArray;
  const numberIsFinite = Number.isFinite;
  const numberIsSafeInteger = Number.isSafeInteger;
  const objectGetPrototypeOf = Object.getPrototypeOf;
  const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const reflectOwnKeys = Reflect.ownKeys;
  const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const arrayIncludes = Function.prototype.call.bind(Array.prototype.includes);
  const jsonStringify = JSON.stringify;
  const jsonParse = JSON.parse;
  const scalarToString = String;
  const FunctionCtor = Function;
  const TypeErrorCtor = TypeError;
  const RangeErrorCtor = RangeError;
  const TextEncoderCtor = TextEncoder;
  const Uint8ArrayCtor = Uint8Array;
  const WeakSetCtor = WeakSet;
  const encodeBytes = functionCall.bind(TextEncoder.prototype.encode);
  const typedArrayPrototype = objectGetPrototypeOf(Uint8ArrayCtor.prototype);
  const byteLengthGetter = objectGetOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
  if (byteLengthGetter === undefined) {
    throw new TypeErrorCtor('reviewed page program byte counter is unavailable');
  }
  const getByteLength = functionCall.bind(byteLengthGetter);
  const weakSetHas = functionCall.bind(WeakSet.prototype.has);
  const weakSetAdd = functionCall.bind(WeakSet.prototype.add);
  const arrayPush = functionCall.bind(Array.prototype.push);
  const arrayJoin = functionCall.bind(Array.prototype.join);
  const runner = async (
    source: string,
    inputJson: string,
    resultShapeJson: string,
    maximumBytes: number,
  ): Promise<
    | { kind: 'success'; encoded: string }
    | {
        kind: 'failure';
        code: 'output_too_large' | 'result_contract_mismatch' | 'execution_failed';
      }
  > => {
    const encoder = new TextEncoderCtor();
    const seen = new WeakSetCtor<object>();
    const pieces: string[] = [];
    const outputTooLarge = new RangeErrorCtor(
      'page program result exceeds its signed byte ceiling',
    );
    const resultContractMismatch = new TypeErrorCtor(
      'page program result violates its signed result contract',
    );
    let encodedBytes = 0;
    let nodes = 0;
    const failResultContract = (): never => {
      throw resultContractMismatch;
    };
    const append = (piece: string): void => {
      encodedBytes += getByteLength(encodeBytes(encoder, piece));
      if (encodedBytes > maximumBytes) {
        throw outputTooLarge;
      }
      arrayPush(pieces, piece);
    };
    const encodeJson = (value: unknown, depth: number): void => {
      nodes += 1;
      if (nodes > 65536 || depth > 32) {
        return failResultContract();
      }
      if (value === null) {
        append('null');
        return;
      }
      if (typeof value === 'string') {
        append(jsonStringify(value));
        return;
      }
      if (typeof value === 'boolean') {
        append(value ? 'true' : 'false');
        return;
      }
      if (typeof value === 'number') {
        if (!numberIsFinite(value)) {
          return failResultContract();
        }
        append(scalarToString(value));
        return;
      }
      if (typeof value !== 'object') {
        return failResultContract();
      }
      if (weakSetHas(seen, value)) {
        return failResultContract();
      }
      weakSetAdd(seen, value);
      if (arrayIsArray(value)) {
        if (!numberIsSafeInteger(value.length) || value.length > 65536) {
          return failResultContract();
        }
        const keys = reflectOwnKeys(value);
        if (keys.length !== value.length + 1 || !arrayIncludes(keys, 'length')) {
          return failResultContract();
        }
        append('[');
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = objectGetOwnPropertyDescriptor(value, scalarToString(index));
          if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, 'value')) {
            return failResultContract();
          }
          if (index > 0) append(',');
          encodeJson(descriptor.value, depth + 1);
        }
        append(']');
        return;
      }
      const prototype = objectGetPrototypeOf(value);
      if (prototype !== objectPrototype && prototype !== null) {
        return failResultContract();
      }
      const keys = reflectOwnKeys(value);
      append('{');
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        if (typeof key !== 'string') {
          return failResultContract();
        }
        const descriptor = objectGetOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, 'value')) {
          return failResultContract();
        }
        if (index > 0) append(',');
        append(jsonStringify(key));
        append(':');
        encodeJson(descriptor.value, depth + 1);
      }
      append('}');
    };
    let output: unknown;
    let resultShape: {
      kind: 'object' | 'array';
      required_keys: string[];
    };
    try {
      const program = FunctionCtor('return (' + source + ');')();
      if (typeof program !== 'function') {
        return { kind: 'failure', code: 'execution_failed' };
      }
      const input = jsonParse(inputJson);
      resultShape = jsonParse(resultShapeJson);
      output = await program(input);
    } catch {
      return { kind: 'failure', code: 'execution_failed' };
    }
    try {
      if (output === null || typeof output !== 'object') {
        return failResultContract();
      }
      if (resultShape.kind === 'array') {
        if (!arrayIsArray(output)) {
          return failResultContract();
        }
      } else {
        if (arrayIsArray(output)) {
          return failResultContract();
        }
        for (const key of resultShape.required_keys) {
          const descriptor = objectGetOwnPropertyDescriptor(output, key);
          if (
            !descriptor ||
            !descriptor.enumerable ||
            !hasOwn(descriptor, 'value') ||
            descriptor.value === undefined ||
            descriptor.value === null
          ) {
            return failResultContract();
          }
        }
      }
      encodeJson(output, 0);
      const encoded = arrayJoin(pieces, '');
      jsonParse(encoded);
      return { kind: 'success', encoded };
    } catch (error) {
      if (error === outputTooLarge) {
        return { kind: 'failure', code: 'output_too_large' };
      }
      if (error === resultContractMismatch) {
        return { kind: 'failure', code: 'result_contract_mismatch' };
      }
      return { kind: 'failure', code: 'execution_failed' };
    }
  };
  defineProperty(globalThis, runnerName, {
    value: runner,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}
/* eslint-enable
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unnecessary-type-arguments,
  @typescript-eslint/restrict-plus-operands,
  @typescript-eslint/unbound-method,
  sonarjs/code-eval
*/

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : canonicalJson(String(error));
}

function assertPageScriptOrigin(actualUrl: string, expectedOrigin: string): void {
  let actualOrigin: string;
  try {
    actualOrigin = new URL(actualUrl).origin;
  } catch {
    throw new PublicHttpExecutionError(
      'request_blocked',
      'browser page-script main frame has no valid reviewed origin',
    );
  }
  if (actualOrigin !== expectedOrigin) {
    throw new PublicHttpExecutionError(
      'request_blocked',
      'browser page-script main frame left its sole reviewed origin',
    );
  }
}

function assertReviewedPageProgramResultShape(
  result: Exclude<JsonValueV1, null | boolean | number | string>,
  shape: PublicBrowserPageScriptResultShapeV1,
): void {
  if (shape.kind === 'array') {
    if (!Array.isArray(result)) {
      throw new Error('reviewed page program result must be a JSON array');
    }
    return;
  }
  if (Array.isArray(result)) {
    throw new Error('reviewed page program result must be a JSON object');
  }
  for (const key of shape.required_keys) {
    if (!Object.hasOwn(result, key) || result[key] === null) {
      throw new Error(`reviewed page program result is missing required key ${key}`);
    }
  }
}
