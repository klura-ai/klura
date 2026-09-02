import fs from 'node:fs';
import path from 'node:path';
import {
  parseCapabilityId,
  parseInteger,
  parsePackageId,
  parsePackageVersion,
  parseSessionName,
  parseStableContractId,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  type CapabilityIdV1,
  type PackageIdV1,
  type PackageVersionV1,
} from '../public/contracts/common';
import {
  assertJsonValue,
  canonicalJson,
  parseStrictJson,
  type JsonValueV1,
} from '../public/contracts/json';
import {
  calculateCollectionContractDigest,
  type CsvColumnV1,
} from '../public/contracts/collection';
import { parsePublicToolPackage } from '../public/contracts/package';
import {
  followConsumerDaemon,
  invokeConsumerDaemon,
  ConsumerDaemonClientError,
} from './daemon-client';
import { isConsumerRunOutputFailure, type ConsumerRunOutputFailureV1 } from './run-output-failure';
import {
  isConsumerDaemonFailure,
  isConsumerRunSessionFailure,
  isConsumerRunFailure,
  isDetachedRunAccepted,
  isResumeRunAccepted,
  type ConsumerDaemonFailureV1,
  type ConsumerRunSessionFailureV1,
  type DetachedRunAcceptedV1,
  type ResumeRunAcceptedV1,
  type CancelRunResponseV1,
  type WaitRunResponseV1,
  type ConsumerDaemonRunItemStreamEventV1,
} from './daemon-routes';
import { createForegroundAbort } from './foreground-abort';
import { InstalledPackageError } from './installed-package';
import { exportCommittedRunItems, RunResultError } from './scrape/result-reader';
import {
  DEFAULT_INLINE_OUTPUT_MAX_BYTES_V1,
  type RunOutputFormatV1,
  type RunOutputV1,
} from './scrape/output';
import { createRunOperationId, parseRunId } from './scrape/journal';
import type { LocalScrapeRunResultV1 } from './scrape/run-service';
import { RunStoreV1 } from './scrape/run-store';
import { ConsumerLocalListingServiceV1 } from './local-listing';
import type { CompletePackageLoginResultV1, OpenPackageLoginResultV1 } from './login-service';
import { ConsumerRegistryServiceV1 } from './registry-service';
import { createDefaultConsumerRegistryService } from './registry/default-service';
import { PackageStoreV1 } from './store/package-store';

interface ConsumerCliDependenciesV1 {
  registry_service?: Pick<ConsumerRegistryServiceV1, 'search' | 'show' | 'install'>;
}

/** Prints the compact consumer-first command surface without starting local services. */
export function printConsumerUsage(): void {
  console.log(`klura — local web data tools

Usage: klura <command> [options]

Get a maintained local tool:
  search [query] [--cursor <opaque>] [--limit N] [--json]
  show <package[.capability]> [--version <version>] [--json]
  install <package[@version]> [--json]
  installed [--cursor <opaque>] [--limit N] [--json]

Use an installed tool:
  call <package.capability> --input <json|@file> [--session <name>] [--timeout-ms N] [--json]
  run <package.capability> --input <json|@file> [--input-mode <id>] [--session <name>]
      [--output <path> --format <json|ndjson|csv>] [--max-items N] [--max-pages N]
      [--max-requests N] [--timeout-ms N] [--max-concurrency N] [--limit <id>=<n>]
      [--detach] [--json]
  export <run-id> --output <path> [--format <json|ndjson|csv>] [--json]
  runs list [--cursor <opaque>] [--limit N] [--json]
  runs show <run-id> [--json]
  runs items <run-id> [--after-sequence N] [--limit N] [--format <json|ndjson>] [--follow]
  runs wait|resume|cancel <run-id> [--json]
  runs discard <run-id> --yes [--json]
  login <package> [--auth <contract>] [--session <name>] [--json]
  login complete <interaction-id> [--json]
  session clear <package> [--auth <contract>] [--session <name>] [--json]
  remove <package> [--json]
  doctor [--json]

Create or maintain a tool:
  klura factory --help`);
}

export async function runConsumerCli(
  args: readonly string[],
  dependencies: ConsumerCliDependenciesV1 = {},
): Promise<number> {
  const command = args[0];
  const json = args.includes('--json');
  if (
    command === undefined ||
    command === 'help' ||
    command === '--help' ||
    command === '-h' ||
    args.includes('--help') ||
    args.includes('-h')
  ) {
    printConsumerUsage();
    return 0;
  }
  try {
    switch (command) {
      case 'search':
        return await searchRegistry(args, json, dependencies);
      case 'show':
        return await showRegistryPackage(args, json, dependencies);
      case 'install':
        return await installRegistryPackage(args, json, dependencies);
      case 'installed':
        return listInstalledPackages(args, json);
      case 'remove':
        return removeInstalledPackage(args, json);
      case 'call':
        assertFlags(args, 2, new Set(['--input', '--session', '--timeout-ms']));
        return await callPackage(args, json);
      case 'run':
        assertFlags(
          args,
          2,
          new Set([
            '--input',
            '--max-items',
            '--max-pages',
            '--max-requests',
            '--timeout-ms',
            '--max-concurrency',
            '--input-mode',
            '--session',
            '--limit',
            '--output',
            '--format',
          ]),
          new Set(['--limit']),
          new Set(['--json', '--detach']),
        );
        return await runPackage(args, json);
      case 'export':
        assertFlags(args, 2, new Set(['--output', '--format']));
        return render(exportRun(args), json);
      case 'runs':
        return await runInspectionCommand(args, json);
      case 'login':
        return await loginCommand(args, json);
      case 'session':
        return await sessionCommand(args, json);
      case 'doctor':
        assertFlags(args, 1, new Set());
        return await runConsumerDoctor(json);
      default:
        return renderInputFailure('unknown consumer command', json);
    }
  } catch (error) {
    if (error instanceof CliInputError) return renderInputFailure(error.message, json);
    return renderFailure(error, json);
  }
}

async function searchRegistry(
  args: readonly string[],
  json: boolean,
  dependencies: ConsumerCliDependenciesV1,
): Promise<number> {
  const query = optionalPositional(args, 1);
  assertFlags(args, query === undefined ? 1 : 2, new Set(['--cursor', '--limit']));
  const input: { query?: string; cursor?: string; limit?: number } = {};
  if (query !== undefined) input.query = query;
  const cursor = optionalFlag(args, '--cursor');
  if (cursor !== undefined) input.cursor = cursor;
  const limit = optionalBoundedInteger(args, '--limit', 1, 50);
  if (limit !== undefined) input.limit = limit;
  const registry = dependencies.registry_service ?? createDefaultConsumerRegistryService();
  return renderConsumerResult(await registry.search(input), json);
}

async function showRegistryPackage(
  args: readonly string[],
  json: boolean,
  dependencies: ConsumerCliDependenciesV1,
): Promise<number> {
  assertFlags(args, 2, new Set(['--version']));
  const selector = parsePackageOptionalCapabilitySelector(
    requirePositional(args, 1, 'show <package[.capability]>'),
    'show selector',
  );
  const version = optionalFlag(args, '--version');
  const input: {
    package_id: PackageIdV1;
    capability?: CapabilityIdV1;
    version?: PackageVersionV1;
  } = {
    package_id: selector.package_id,
  };
  if (selector.capability !== undefined) input.capability = selector.capability;
  if (version !== undefined) input.version = parseCliPackageVersion(version);
  const registry = dependencies.registry_service ?? createDefaultConsumerRegistryService();
  return renderConsumerResult(await registry.show(input), json);
}

async function installRegistryPackage(
  args: readonly string[],
  json: boolean,
  dependencies: ConsumerCliDependenciesV1,
): Promise<number> {
  assertFlags(args, 2, new Set());
  const selector = parsePackageVersionSelector(
    requirePositional(args, 1, 'install <package[@version]>'),
  );
  const registry = dependencies.registry_service ?? createDefaultConsumerRegistryService();
  return renderConsumerResult(await registry.install(selector), json);
}

function renderConsumerResult(value: { kind: string }, json: boolean): number {
  render(value, json);
  return value.kind === 'consumer_failure' ? 3 : 0;
}

function listInstalledPackages(args: readonly string[], json: boolean): number {
  assertFlags(args, 1, new Set(['--cursor', '--limit']));
  const cursor = optionalFlag(args, '--cursor');
  const limit = optionalBoundedInteger(args, '--limit', 1, 100);
  const input: { cursor?: string; limit?: number } = {};
  if (cursor !== undefined) input.cursor = cursor;
  if (limit !== undefined) input.limit = limit;
  return renderConsumerResult(new ConsumerLocalListingServiceV1().installed(input), json);
}

function removeInstalledPackage(args: readonly string[], json: boolean): number {
  assertFlags(args, 2, new Set());
  const packageId = parseCliPackageId(requirePositional(args, 1, 'remove <package> [--json]'));
  return renderConsumerResult(
    new ConsumerLocalListingServiceV1().remove({ package_id: packageId }),
    json,
  );
}

async function runInspectionCommand(args: readonly string[], json: boolean): Promise<number> {
  const subcommand = args[1];
  if (subcommand === 'list') {
    assertFlags(args, 2, new Set(['--cursor', '--limit']));
    const result = await invokeConsumerDaemon('/consumer/runs/list', {
      cursor: optionalFlag(args, '--cursor') ?? null,
      limit: optionalBoundedInteger(args, '--limit', 1, 100) ?? null,
    });
    return renderConsumerResult(result as { kind: string }, json);
  }
  if (subcommand === 'show') {
    assertFlags(args, 3, new Set());
    let runId;
    try {
      runId = parseRunId(requirePositional(args, 2, 'runs show <run-id>'), 'run_id');
    } catch (error) {
      throw new CliInputError(errorMessage(error));
    }
    const run = await invokeConsumerDaemon('/consumer/runs/show', { run_id: runId });
    if (isConsumerRunFailure(run)) return renderConsumerResult(run, json);
    return render({ kind: 'run', run }, json);
  }
  if (subcommand === 'items') {
    assertFlags(
      args,
      3,
      new Set(['--after-sequence', '--limit', '--format']),
      new Set(),
      new Set(['--json', '--follow']),
    );
    let runId;
    try {
      runId = parseRunId(requirePositional(args, 2, 'runs items <run-id>'), 'run_id');
    } catch (error) {
      throw new CliInputError(errorMessage(error));
    }
    const follow = args.includes('--follow');
    const format = optionalFlag(args, '--format') ?? 'json';
    if (format !== 'json' && format !== 'ndjson') {
      throw new CliInputError('runs items --format must be json or ndjson');
    }
    if (follow) {
      if (format !== 'ndjson') {
        throw new CliInputError('runs items --follow requires --format ndjson');
      }
      if (json) throw new CliInputError('runs items --follow cannot use --json');
      const observer = createForegroundAbort();
      try {
        for await (const event of followConsumerDaemon<ConsumerDaemonRunItemStreamEventV1>(
          '/consumer/runs/items/follow',
          {
            run_id: runId,
            after_sequence: optionalNonNegativeInteger(args, '--after-sequence') ?? null,
          },
          observer.signal,
        )) {
          process.stdout.write(`${canonicalJson(event as unknown as JsonValueV1)}\n`);
          if (event.kind === 'failure') return 3;
        }
        return 0;
      } catch (error) {
        if (error instanceof ConsumerDaemonClientError && error.code === 'cancelled') return 0;
        throw error;
      } finally {
        observer.dispose();
      }
    }
    const page = await invokeConsumerDaemon('/consumer/runs/items', {
      run_id: runId,
      after_sequence: optionalNonNegativeInteger(args, '--after-sequence') ?? null,
      limit: optionalBoundedInteger(args, '--limit', 1, 100) ?? null,
    });
    if (isConsumerRunFailure(page)) return renderConsumerResult(page, json);
    return render({ kind: 'run_items', page }, json);
  }
  if (subcommand === 'resume') {
    assertFlags(args, 3, new Set());
    let runId;
    try {
      runId = parseRunId(requirePositional(args, 2, 'runs resume <run-id>'), 'run_id');
    } catch (error) {
      throw new CliInputError(errorMessage(error));
    }
    const started = await invokeConsumerDaemon<ResumeRunAcceptedV1 | ConsumerDaemonFailureV1>(
      '/consumer/runs/resume',
      { run_id: runId, operation_id: createRunOperationId() },
    );
    if (isConsumerDaemonFailure(started)) {
      throw new InstalledPackageError(
        started.code,
        'consumer daemon rejected the installed package',
      );
    }
    if (!isResumeRunAccepted(started)) {
      throw new ConsumerDaemonClientError(
        'daemon_protocol',
        'daemon did not accept the scrape resume',
      );
    }
    const result = await waitForForegroundRun(started.run_id);
    if (isConsumerDaemonFailure(result)) {
      throw new InstalledPackageError(
        result.code,
        'consumer daemon rejected the installed package',
      );
    }
    if (!('result' in result)) return render({ kind: 'run_resume', run: result }, json);
    const exit = scrapeExitCode(result.result);
    render({ kind: 'run_resume', ...result }, json);
    return exit;
  }
  if (subcommand === 'wait') {
    assertFlags(args, 3, new Set());
    let runId;
    try {
      runId = parseRunId(requirePositional(args, 2, 'runs wait <run-id>'), 'run_id');
    } catch (error) {
      throw new CliInputError(errorMessage(error));
    }
    const observer = new AbortController();
    let result;
    try {
      result = await invokeConsumerDaemon<WaitRunResponseV1 | ConsumerDaemonFailureV1>(
        '/consumer/runs/wait',
        { run_id: runId },
        observer.signal,
      );
    } finally {
      observer.abort();
    }
    if (isConsumerRunFailure(result)) return renderConsumerResult(result, json);
    if (isConsumerDaemonFailure(result)) {
      throw new InstalledPackageError(
        result.code,
        'consumer daemon rejected the installed package',
      );
    }
    if ('result' in result) {
      const exit = scrapeExitCode(result.result);
      render({ kind: 'run_wait', ...result }, json);
      return exit;
    }
    return render({ kind: 'run_wait', run: result }, json);
  }
  if (subcommand === 'cancel') {
    assertFlags(args, 3, new Set());
    let runId;
    try {
      runId = parseRunId(requirePositional(args, 2, 'runs cancel <run-id>'), 'run_id');
    } catch (error) {
      throw new CliInputError(errorMessage(error));
    }
    const result = await invokeConsumerDaemon<CancelRunResponseV1 | ConsumerDaemonFailureV1>(
      '/consumer/runs/cancel',
      { run_id: runId, source: 'cli_cancel', operation_id: createRunOperationId() },
    );
    if (isConsumerDaemonFailure(result)) {
      throw new InstalledPackageError(
        result.code,
        'consumer daemon rejected the installed package',
      );
    }
    return render(result, json);
  }
  if (subcommand === 'discard') {
    assertFlags(args, 3, new Set(), new Set(), new Set(['--json', '--yes']));
    if (!args.includes('--yes')) {
      throw new CliInputError('runs discard requires --yes');
    }
    let runId;
    try {
      runId = parseRunId(requirePositional(args, 2, 'runs discard <run-id> --yes'), 'run_id');
    } catch (error) {
      throw new CliInputError(errorMessage(error));
    }
    const result = await invokeConsumerDaemon('/consumer/runs/discard', {
      run_id: runId,
      operation_id: createRunOperationId(),
    });
    if (isConsumerRunFailure(result)) return renderConsumerResult(result, json);
    return render({ kind: 'run_discard', result }, json);
  }
  throw new CliInputError('usage: klura runs <list|show|items|wait|resume|cancel|discard>');
}

async function callPackage(args: readonly string[], json: boolean): Promise<number> {
  const selector = parsePackageCapabilitySelector(
    requirePositional(args, 1, 'call <package.capability>'),
  );
  const inputArgument = requireFlag(args, '--input');
  const timeout = optionalPositiveInteger(args, '--timeout-ms');
  const sessionName = optionalSessionName(args, '--session');
  const input = parseCliInput(inputArgument);
  const foreground = createForegroundAbort();
  let result;
  try {
    result = await invokeConsumerDaemon<
      | {
          package_id: string;
          version: string;
          package_digest: string;
          capability: string;
          result: unknown;
        }
      | ConsumerDaemonFailureV1
    >(
      '/consumer/call',
      {
        package_id: selector.package_id,
        capability: selector.capability,
        input,
        session_name: sessionName ?? null,
        timeout_ms: timeout ?? null,
      },
      foreground.signal,
    );
  } finally {
    foreground.dispose();
  }
  if (isConsumerDaemonFailure(result)) {
    throw new InstalledPackageError(result.code, 'consumer daemon rejected the installed package');
  }
  return render({ kind: 'call', ...result }, json);
}

async function runPackage(args: readonly string[], json: boolean): Promise<number> {
  const selector = parsePackageCapabilitySelector(
    requirePositional(args, 1, 'run <package.capability>'),
  );
  const input = parseCliInput(requireFlag(args, '--input'));
  const sessionName = optionalSessionName(args, '--session');
  const callerBounds: Record<string, JsonValueV1> = {};
  const maxItems = optionalPositiveInteger(args, '--max-items');
  const maxPages = optionalPositiveInteger(args, '--max-pages');
  const maxRequests = optionalPositiveInteger(args, '--max-requests');
  const timeout = optionalPositiveInteger(args, '--timeout-ms');
  const maxConcurrency = optionalPositiveInteger(args, '--max-concurrency');
  const limits = parseNamedLimits(args);
  if (maxItems !== undefined) callerBounds.max_items = maxItems;
  if (maxPages !== undefined) callerBounds.max_pages = maxPages;
  if (maxRequests !== undefined) callerBounds.max_requests = maxRequests;
  if (timeout !== undefined) callerBounds.timeout_ms = timeout;
  if (maxConcurrency !== undefined) callerBounds.max_concurrency = maxConcurrency;
  if (limits !== undefined) callerBounds.limits = limits;
  const output = optionalFlag(args, '--output');
  const format = parseOutputFormat(args);
  const detach = args.includes('--detach');
  if (format !== undefined && output === undefined) {
    throw new CliInputError('--format requires --output');
  }
  const requestedOutput = resolveCliRunOutput(output, format);
  const started = await invokeConsumerDaemon<
    | DetachedRunAcceptedV1
    | ConsumerDaemonFailureV1
    | ConsumerRunOutputFailureV1
    | ConsumerRunSessionFailureV1
  >('/consumer/run', {
    package_id: selector.package_id,
    capability: selector.capability,
    input,
    caller_bounds: callerBounds,
    input_mode_id: optionalFlag(args, '--input-mode') ?? null,
    output: requestedOutput ?? null,
    inline_output_max_bytes: DEFAULT_INLINE_OUTPUT_MAX_BYTES_V1,
    session_name: sessionName ?? null,
    detach: true,
    operation_id: createRunOperationId(),
  });
  if (isConsumerDaemonFailure(started)) {
    throw new InstalledPackageError(started.code, 'consumer daemon rejected the installed package');
  }
  if (isConsumerRunOutputFailure(started)) {
    return render(
      {
        result_schema_version: 1,
        kind: 'consumer_failure',
        operation: 'start_run',
        code: 'output_sink_required',
        retryable: false,
        package_id: selector.package_id,
        suggested_action: { kind: 'use_output_sink' },
      },
      json,
    );
  }
  if (isConsumerRunSessionFailure(started)) {
    const failure = {
      result_schema_version: 1,
      kind: 'consumer_failure' as const,
      operation: 'start_run',
      code: started.code,
      retryable: false,
      package_id: selector.package_id,
    };
    return renderConsumerResult(failure, json);
  }
  if (!isDetachedRunAccepted(started)) {
    throw new ConsumerDaemonClientError('daemon_protocol', 'daemon did not accept the scrape run');
  }
  if (detach) return render({ ...started, output: requestedOutput ?? null }, json);
  const result = await waitForForegroundRun(started.run_id);
  if (isConsumerDaemonFailure(result)) {
    throw new InstalledPackageError(result.code, 'consumer daemon rejected the installed package');
  }
  if (!('result' in result))
    return render({ kind: 'run', run: result, output: requestedOutput ?? null }, json);
  const exit = scrapeExitCode(result.result);
  render({ kind: 'run', ...result, output: requestedOutput ?? null }, json);
  return exit;
}

function resolveCliRunOutput(
  output: string | undefined,
  format: RunOutputFormatV1 | undefined,
): RunOutputV1 | undefined {
  if (output === undefined) return undefined;
  return {
    kind: 'file',
    requested_path: path.resolve(output),
    format: format ?? 'ndjson',
  };
}

async function waitForForegroundRun(
  runId: string,
): Promise<WaitRunResponseV1 | ConsumerDaemonFailureV1> {
  const foreground = createForegroundAbort();
  try {
    try {
      return await invokeConsumerDaemon<WaitRunResponseV1 | ConsumerDaemonFailureV1>(
        '/consumer/runs/wait',
        { run_id: runId },
        foreground.signal,
      );
    } catch (error) {
      if (!(error instanceof ConsumerDaemonClientError) || error.code !== 'cancelled') throw error;
      const cancellation = await invokeConsumerDaemon<
        CancelRunResponseV1 | ConsumerDaemonFailureV1
      >('/consumer/runs/cancel', {
        run_id: runId,
        source: 'foreground_sigint',
        operation_id: createRunOperationId(),
      });
      if (isConsumerDaemonFailure(cancellation)) {
        throw new InstalledPackageError(
          cancellation.code,
          'consumer daemon rejected the installed package',
        );
      }
      return await invokeConsumerDaemon<WaitRunResponseV1 | ConsumerDaemonFailureV1>(
        '/consumer/runs/wait',
        { run_id: runId },
      );
    }
  } finally {
    foreground.dispose();
  }
}

function exportRun(args: readonly string[]): {
  run_id: string;
  items_written: number;
  bytes_written: number;
  path: string;
} {
  let runId;
  try {
    runId = parseRunId(requirePositional(args, 1, 'export <run-id> --output <path>'), 'run_id');
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
  return exportRunItems(
    new PackageStoreV1(),
    runId,
    requireFlag(args, '--output'),
    parseOutputFormat(args),
  );
}

function scrapeExitCode(result: LocalScrapeRunResultV1): number {
  if (result.kind === 'scrape_outcome') return 0;
  return result.stop === 'cancelled' ? 130 : 4;
}

function exportRunItems(
  store: PackageStoreV1,
  runId: ReturnType<typeof parseRunId>,
  output: string,
  format: RunOutputFormatV1 | undefined,
): ReturnType<typeof exportCommittedRunItems> {
  try {
    const runStore = new RunStoreV1(store.paths.home);
    const outputFormat = format ?? 'ndjson';
    return exportCommittedRunItems(runStore, runId, output, {
      format: outputFormat,
      csv_columns: outputFormat === 'csv' ? resolveRunCsvColumns(store, runStore, runId) : null,
    });
  } catch (error) {
    if (error instanceof RunResultError) throw new CliInputError(errorMessage(error));
    throw error;
  }
}

function resolveRunCsvColumns(
  store: PackageStoreV1,
  runStore: RunStoreV1,
  runId: ReturnType<typeof parseRunId>,
): readonly CsvColumnV1[] | null {
  const meta = runStore.read(runId).payload;
  const packageValue = parseStrictJson(
    store.readArtifact(meta.artifact.package_digest),
    'stored_package',
    PUBLIC_CONTRACT_LIMITS.packageBytes,
    PUBLIC_CONTRACT_LIMITS.maxPackageDepth,
  );
  const toolPackage = parsePublicToolPackage(packageValue);
  const capability = toolPackage.capabilities[meta.artifact.capability];
  if (!capability || capability.collection === null) return null;
  if (
    calculateCollectionContractDigest(capability.collection) !==
    meta.artifact.collection_contract_digest
  ) {
    throw new PublicContractError(
      'run.collection_contract_digest',
      'does not match the immutable collection contract',
    );
  }
  return capability.collection.csv_columns;
}

async function runConsumerDoctor(json: boolean): Promise<number> {
  const result = await invokeConsumerDaemon('/consumer/doctor', {});
  return render(result, json);
}

async function sessionCommand(args: readonly string[], json: boolean): Promise<number> {
  if (args[1] !== 'clear') {
    throw new CliInputError(
      'usage: klura session clear <package> [--auth <contract>] [--session <name>]',
    );
  }
  assertFlags(args, 3, new Set(['--auth', '--session']));
  const packageId = parseCliPackageId(requirePositional(args, 2, 'session clear <package>'));
  const auth = optionalFlag(args, '--auth');
  const sessionName = optionalSessionName(args, '--session');
  const result = await invokeConsumerDaemon('/consumer/session/clear', {
    package_id: packageId,
    authentication_contract_id:
      auth === undefined ? null : parseStableContractId(auth, 'session clear --auth'),
    session_name: sessionName ?? null,
  });
  return render(result, json);
}

async function loginCommand(args: readonly string[], json: boolean): Promise<number> {
  if (args[1] === 'complete') {
    assertFlags(args, 3, new Set());
    const result = await invokeConsumerDaemon<
      CompletePackageLoginResultV1 | ConsumerDaemonFailureV1
    >('/consumer/login/complete', {
      interaction_id: requirePositional(args, 2, 'login complete <interaction-id>'),
    });
    if (isConsumerDaemonFailure(result)) {
      throw new InstalledPackageError(
        result.code,
        'consumer daemon rejected the installed package',
      );
    }
    return render(result, json);
  }
  assertFlags(args, 2, new Set(['--auth', '--session']));
  const packageId = parseCliPackageId(requirePositional(args, 1, 'login <package>'));
  const auth = optionalFlag(args, '--auth');
  const sessionName = optionalSessionName(args, '--session');
  const result = await invokeConsumerDaemon<OpenPackageLoginResultV1 | ConsumerDaemonFailureV1>(
    '/consumer/login/open',
    {
      package_id: packageId,
      authentication_contract_id:
        auth === undefined ? null : parseStableContractId(auth, 'login --auth'),
      session_name: sessionName ?? null,
    },
  );
  if (isConsumerDaemonFailure(result)) {
    throw new InstalledPackageError(result.code, 'consumer daemon rejected the installed package');
  }
  return render(result, json);
}

function parsePackageCapabilitySelector(value: string): {
  package_id: PackageIdV1;
  capability: CapabilityIdV1;
} {
  const separator = value.indexOf('.');
  if (separator <= 0 || separator !== value.lastIndexOf('.')) {
    throw new CliInputError('call selector must be <package.capability>');
  }
  return {
    package_id: parseCliPackageId(value.slice(0, separator)),
    capability: parseCliCapabilityId(value.slice(separator + 1)),
  };
}

function parsePackageOptionalCapabilitySelector(
  value: string,
  field: string,
): { package_id: PackageIdV1; capability?: CapabilityIdV1 } {
  const separator = value.indexOf('.');
  if (separator === -1) return { package_id: parseCliPackageId(value) };
  if (separator <= 0 || separator !== value.lastIndexOf('.')) {
    throw new CliInputError(`${field} must be <package[.capability]>`);
  }
  return {
    package_id: parseCliPackageId(value.slice(0, separator)),
    capability: parseCliCapabilityId(value.slice(separator + 1)),
  };
}

function parsePackageVersionSelector(value: string): {
  package_id: PackageIdV1;
  version?: PackageVersionV1;
} {
  const separator = value.indexOf('@');
  if (separator === -1) return { package_id: parseCliPackageId(value) };
  if (separator <= 0 || separator !== value.lastIndexOf('@')) {
    throw new CliInputError('install selector must be <package[@version]>');
  }
  return {
    package_id: parseCliPackageId(value.slice(0, separator)),
    version: parseCliPackageVersion(value.slice(separator + 1)),
  };
}

function parseCliPackageId(value: string): PackageIdV1 {
  try {
    return parsePackageId(value, 'package');
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
}

function parseCliCapabilityId(value: string): CapabilityIdV1 {
  try {
    return parseCapabilityId(value, 'capability');
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
}

function optionalSessionName(args: readonly string[], flag: string): string | undefined {
  const value = optionalFlag(args, flag);
  if (value === undefined) return undefined;
  try {
    return parseSessionName(value, flag);
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
}

function parseCliPackageVersion(value: string): PackageVersionV1 {
  try {
    return parsePackageVersion(value, 'version');
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
}

function parseCliInput(value: string): JsonValueV1 {
  let bytes: Buffer;
  if (value.startsWith('@')) {
    const inputPath = value.slice(1);
    if (!inputPath) throw new CliInputError('--input @path requires a path');
    try {
      const stats = fs.statSync(inputPath);
      if (!stats.isFile() || stats.size > PUBLIC_CONTRACT_LIMITS.packageBytes) {
        throw new CliInputError('--input file must be a bounded regular file');
      }
      bytes = fs.readFileSync(inputPath);
    } catch (error) {
      if (error instanceof CliInputError) throw error;
      throw new CliInputError('--input file could not be read');
    }
  } else {
    bytes = Buffer.from(value, 'utf8');
  }
  try {
    return parseStrictJson(
      bytes,
      'call.input',
      PUBLIC_CONTRACT_LIMITS.packageBytes,
      PUBLIC_CONTRACT_LIMITS.maxDepth,
    );
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
}

function optionalPositiveInteger(args: readonly string[], flag: string): number | undefined {
  return optionalBoundedInteger(args, flag, 1, 300_000);
}

function optionalNonNegativeInteger(args: readonly string[], flag: string): number | undefined {
  return optionalBoundedInteger(args, flag, 0, 1_000_000_000);
}

function optionalBoundedInteger(
  args: readonly string[],
  flag: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = optionalFlag(args, flag);
  if (value === undefined) return undefined;
  try {
    return parseInteger(Number(value), flag, minimum, maximum);
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
}

function parseNamedLimits(args: readonly string[]): Record<string, number> | undefined {
  const values = flagValues(args, '--limit');
  if (values.length === 0) return undefined;
  const limits: Record<string, number> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator < 1 || separator !== value.lastIndexOf('=')) {
      throw new CliInputError('--limit requires <id>=<positive-integer>');
    }
    const id = value.slice(0, separator);
    let amount: number;
    try {
      parseStableContractId(id, '--limit id');
      amount = parseInteger(Number(value.slice(separator + 1)), '--limit value', 1, 1_000_000);
    } catch (error) {
      throw new CliInputError(errorMessage(error));
    }
    if (Object.hasOwn(limits, id)) throw new CliInputError(`duplicate --limit ${id}`);
    limits[id] = amount;
  }
  return limits;
}

function parseOutputFormat(args: readonly string[]): RunOutputFormatV1 | undefined {
  const value = optionalFlag(args, '--format');
  if (value === undefined) return undefined;
  if (value === 'json' || value === 'ndjson' || value === 'csv') return value;
  throw new CliInputError('--format must be json, ndjson, or csv');
}

function requireFlag(args: readonly string[], flag: string): string {
  const value = optionalFlag(args, flag);
  if (value === undefined) throw new CliInputError(`${flag} is required`);
  return value;
}

function optionalFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new CliInputError(`${flag} requires a value`);
  return value;
}

function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new CliInputError(`${flag} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

function assertFlags(
  args: readonly string[],
  start: number,
  valueFlags: ReadonlySet<string>,
  repeatedFlags = new Set<string>(),
  bareFlags = new Set<string>(['--json']),
): void {
  const seen = new Set<string>();
  for (let index = start; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag || !flag.startsWith('--'))
      throw new CliInputError(`unexpected argument ${flag ?? ''}`);
    if (seen.has(flag) && !repeatedFlags.has(flag))
      throw new CliInputError(`duplicate flag ${flag}`);
    seen.add(flag);
    if (bareFlags.has(flag)) continue;
    if (!valueFlags.has(flag)) throw new CliInputError(`unknown flag ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new CliInputError(`${flag} requires a value`);
    index += 1;
  }
}

function requirePositional(args: readonly string[], index: number, usage: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new CliInputError(`usage: klura ${usage}`);
  return value;
}

function optionalPositional(args: readonly string[], index: number): string | undefined {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

function render(value: unknown, _json: boolean): number {
  assertJsonValue(value, 'consumer_cli_result', PUBLIC_CONTRACT_LIMITS.maxDepth);
  const serialized = canonicalJson(value);
  process.stdout.write(`${serialized}\n`);
  return 0;
}

function renderInputFailure(message: string, json: boolean): number {
  const value = { kind: 'failure', code: 'invalid_input' };
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stderr.write(`${message}\n`);
  return 2;
}

function renderFailure(error: unknown, json: boolean): number {
  let code: string = 'local_state_invalid';
  if (error instanceof InstalledPackageError) code = error.code;
  else if (error instanceof ConsumerDaemonClientError && error.code === 'cancelled') {
    code = 'cancelled';
  }
  const value = { kind: 'failure', code };
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stderr.write(`${errorMessage(error)}\n`);
  return 3;
}

class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliInputError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
