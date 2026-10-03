import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StableContractIdV1 } from '../../public/contracts/common';
import type { JsonValueV1 } from '../../public/contracts/json';
import type {
  PublicBrowserPageScriptStrategyV1,
  PublicHttpStrategyV1,
  PublicReadCapabilityV1,
  PublicToolPackageV1,
} from '../../public/contracts/package';
import { PublicCallerV1, type PublicCallResultV1 } from '../../consumer/call';
import {
  PublicHttpExecutionError,
  executeNodeHttpStrategy,
  type PublicExecutionDiagnosticV1,
  type PublicHttpResponseV1,
} from '../../consumer/execution/node-http';
import { executeBrowserNavigationStrategy } from '../../consumer/execution/public-browser/executor';
import { executeBrowserHttpStrategy } from '../../consumer/execution/public-browser/http-executor';
import { executeBrowserPageScriptStrategy } from '../../consumer/execution/public-browser/page-script-executor';
import { RunStoreV1, type RunArtifactRefV1 } from '../../consumer/scrape/run-store';
import { ScrapeRunServiceV1, type LocalScrapeRunResultV1 } from '../../consumer/scrape/run-service';
import { readCommittedRunItems } from '../../consumer/scrape/result-reader';

/** The default smoke executors: one consumer call and one collection run
 *  through the public kernel, with every response recorded as evidence. */
export interface SmokeExecutionV1 {
  result: PublicCallResultV1;
  responses: Array<{ strategy_id: StableContractIdV1; response: PublicHttpResponseV1 }>;
  diagnostics: PublicExecutionDiagnosticV1[];
}

export interface SmokeRunExecutionV1 {
  result: LocalScrapeRunResultV1;
  items: JsonValueV1[];
  responses: Array<{ strategy_id: StableContractIdV1; response: PublicHttpResponseV1 }>;
  diagnostics: PublicExecutionDiagnosticV1[];
}

export interface SmokeRunFixtureV1 {
  input: JsonValueV1;
  caller_bounds: JsonValueV1;
  input_mode_id: StableContractIdV1 | null;
}

export interface SmokeRunContextV1 {
  capabilities: PublicToolPackageV1['capabilities'];
  artifact: Omit<RunArtifactRefV1, 'collection_contract_digest'>;
}

export async function smokeCall(
  capability: PublicReadCapabilityV1,
  input: JsonValueV1,
  session?: JsonValueV1,
): Promise<SmokeExecutionV1> {
  const responses: SmokeExecutionV1['responses'] = [];
  const diagnostics: PublicExecutionDiagnosticV1[] = [];
  const pageScriptExecutor = async (
    target: PublicReadCapabilityV1,
    strategy: PublicBrowserPageScriptStrategyV1,
    options: Parameters<typeof executeBrowserPageScriptStrategy>[2],
  ): Promise<PublicHttpResponseV1> => {
    try {
      const response = await executeBrowserPageScriptStrategy(target, strategy, options);
      responses.push({ strategy_id: strategy.strategy_id, response });
      return response;
    } catch (error) {
      if (error instanceof PublicHttpExecutionError && error.diagnostic !== null) {
        diagnostics.push(error.diagnostic);
      }
      throw error;
    }
  };
  const caller = new PublicCallerV1(
    recordingHttpExecutor(executeNodeHttpStrategy, responses, diagnostics),
    Math.random,
    executeBrowserNavigationStrategy,
    recordingHttpExecutor(executeBrowserHttpStrategy, responses, diagnostics),
    pageScriptExecutor,
  );
  return {
    result: await caller.call(
      capability,
      input,
      session === undefined ? {} : { browser_storage_state: session },
    ),
    responses,
    diagnostics,
  };
}

/** Wraps an http executor so every response it produces — projected exactly as
 *  the outcome contracts will see it — is captured as fixture evidence. */
function recordingHttpExecutor<Options>(
  execute: (
    target: PublicReadCapabilityV1,
    strategy: PublicHttpStrategyV1,
    options: Options,
  ) => Promise<PublicHttpResponseV1>,
  responses: Array<{ strategy_id: StableContractIdV1; response: PublicHttpResponseV1 }>,
  diagnostics: PublicExecutionDiagnosticV1[],
): (
  target: PublicReadCapabilityV1,
  strategy: PublicHttpStrategyV1,
  options: Options,
) => Promise<PublicHttpResponseV1> {
  return async (target, strategy, options) => {
    try {
      const response = await execute(target, strategy, options);
      responses.push({ strategy_id: strategy.request.strategy_id, response });
      return response;
    } catch (error) {
      if (error instanceof PublicHttpExecutionError && error.diagnostic !== null) {
        diagnostics.push(error.diagnostic);
      }
      throw error;
    }
  };
}

export async function smokeRun(
  capability: PublicReadCapabilityV1,
  fixture: SmokeRunFixtureV1,
  context: SmokeRunContextV1,
): Promise<SmokeRunExecutionV1> {
  const responses: SmokeRunExecutionV1['responses'] = [];
  const diagnostics: PublicExecutionDiagnosticV1[] = [];
  // Target executions are serialized so the recorded response order replays
  // deterministically through the tools repository's order-sensitive queue.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const pageScriptExecutor = (
    target: PublicReadCapabilityV1,
    strategy: PublicBrowserPageScriptStrategyV1,
    options: Parameters<typeof executeBrowserPageScriptStrategy>[2],
  ): Promise<PublicHttpResponseV1> =>
    serialize(async () => {
      try {
        const response = await executeBrowserPageScriptStrategy(target, strategy, options);
        responses.push({ strategy_id: strategy.strategy_id, response });
        return response;
      } catch (error) {
        if (error instanceof PublicHttpExecutionError && error.diagnostic !== null) {
          diagnostics.push(error.diagnostic);
        }
        throw error;
      }
    });
  const serializedHttp = <Options>(
    execute: (
      target: PublicReadCapabilityV1,
      strategy: PublicHttpStrategyV1,
      options: Options,
    ) => Promise<PublicHttpResponseV1>,
  ) => {
    const recording = recordingHttpExecutor(execute, responses, diagnostics);
    return (target: PublicReadCapabilityV1, strategy: PublicHttpStrategyV1, options: Options) =>
      serialize(() => recording(target, strategy, options));
  };
  const caller = new PublicCallerV1(
    serializedHttp(executeNodeHttpStrategy),
    Math.random,
    executeBrowserNavigationStrategy,
    serializedHttp(executeBrowserHttpStrategy),
    pageScriptExecutor,
  );
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-export-run-smoke-'));
  try {
    const store = new RunStoreV1(home);
    const service = new ScrapeRunServiceV1(store, caller);
    const result = await service.start({
      artifact: context.artifact,
      owner: capability,
      capabilities: context.capabilities,
      input: fixture.input,
      caller_bounds: fixture.caller_bounds,
      ...(fixture.input_mode_id === null ? {} : { input_mode_id: fixture.input_mode_id }),
      output: {
        kind: 'file',
        requested_path: path.join(home, 'smoke-output.ndjson'),
        format: 'ndjson',
      },
    });
    const items =
      result.kind === 'scrape_outcome' ? readCommittedRunItems(store, result.run_id) : [];
    return { result, items, responses, diagnostics };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
