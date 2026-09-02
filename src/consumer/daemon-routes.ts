import { PublicContractError, type SessionNameV1 } from '../public/contracts/common';
import { type JsonValueV1 } from '../public/contracts/json';
import { CONSUMER_WIRE_CONTRACTS, parseConsumerWireBody } from './contracts/tool-contracts';
import { ConsumerCallServiceV1, type CallInstalledCapabilityResultV1 } from './call-service';
import { InstalledPackageError, isInstalledPackageErrorCode } from './installed-package';
import {
  ConsumerScrapeRunServiceV1,
  ConsumerRunSessionError,
  type StartedInstalledScrapeRunV1,
  type StartInstalledScrapeRunResultV1,
} from './run-service';
import {
  type RunCancellationSourceV1,
  type RunIdV1,
  type RunOperationIdV1,
} from './scrape/journal';
import {
  DEFAULT_INLINE_OUTPUT_MAX_BYTES_V1,
  RunOutputError,
  type RunOutputV1,
} from './scrape/output';
import { type ConsumerRunOutputFailureV1 } from './run-output-failure';
import { RunOperationError, RunOperationStoreV1 } from './scrape/run-operations';
import { RunStoreV1 } from './scrape/run-store';
import { awaitWithSignal } from './daemon-wait';
import {
  parseCancelRunResponse,
  parseDetachedRunAcceptance,
  parseDiscardRunResponse,
  parseResumeRunAcceptance,
} from './run-operation-contracts';
import {
  ConsumerRunServiceV1,
  RunListError,
  type DiscardRunResultV1,
  type ListedRunsPageV1,
  type RunItemStreamEventV1,
  type RunStateWaitResultV1,
} from './runs';
import type { StoredRunInspectionV1 } from './scrape/inspection';
import { defaultConsumerHome, PackageStoreV1 } from './store/package-store';
import { readConsumerRuntimeVersion } from './runtime-version';
import {
  ConsumerLocalListingServiceV1,
  type ListInstalledPackagesResultV1,
  type RemovePackageResultV1,
} from './local-listing';
import type {
  ConsumerRegistryServiceV1,
  InstallPackageResultV1,
  SearchPackagesResultV1,
  ShowPackageResultV1,
} from './registry-service';
import { createDefaultConsumerRegistryService } from './registry/default-service';
import type { CommittedRunItemsPageV1 } from './scrape/result-reader';
import { ConsumerDoctorServiceV1, type ConsumerDoctorResultV1 } from './doctor';
import { ConsumerSessionServiceV1, type ClearPackageSessionResultV1 } from './session-service';
import {
  ConsumerLoginServiceV1,
  type CompletePackageLoginResultV1,
  type OpenPackageLoginResultV1,
} from './login-service';

export interface ConsumerDaemonExecutionServicesV1 {
  call(input: {
    package_id: string;
    capability: string;
    input: JsonValueV1;
    options?: { session_name?: SessionNameV1; timeout_ms?: number; signal?: AbortSignal };
  }): Promise<CallInstalledCapabilityResultV1>;
  clearSession(input: {
    package_id: string;
    authentication_contract_id?: string;
    session_name?: string;
  }): ClearPackageSessionResultV1;
  openLogin(input: {
    package_id: string;
    authentication_contract_id?: string;
    session_name?: string;
  }): Promise<OpenPackageLoginResultV1>;
  completeLogin(input: { interaction_id: string }): Promise<CompletePackageLoginResultV1>;
  start(input: {
    package_id: string;
    capability: string;
    input: JsonValueV1;
    caller_bounds: unknown;
    input_mode_id?: string;
    output?: RunOutputV1;
    inline_output_max_bytes?: number;
    session_name?: SessionNameV1;
    run_id?: RunIdV1;
    operation_id?: RunOperationIdV1;
    signal?: AbortSignal;
  }): Promise<StartInstalledScrapeRunResultV1>;
  startDetached(input: {
    package_id: string;
    capability: string;
    input: JsonValueV1;
    caller_bounds: unknown;
    input_mode_id?: string;
    output?: RunOutputV1;
    inline_output_max_bytes?: number;
    session_name?: SessionNameV1;
    run_id?: RunIdV1;
    operation_id?: RunOperationIdV1;
    signal?: AbortSignal;
  }): StartedInstalledScrapeRunV1;
  resume(input: {
    run_id: string;
    signal?: AbortSignal;
    cancellation_source?: () => DaemonCancellationSourceV1;
  }): Promise<StartInstalledScrapeRunResultV1>;
}
type DaemonCancellationSourceV1 = RunCancellationSourceV1;
export interface ConsumerDaemonFailureV1 {
  kind: 'consumer_daemon_failure';
  code: InstalledPackageError['code'];
}
export interface ConsumerRunSessionFailureV1 {
  kind: 'consumer_run_session_failure';
  code: 'session_required' | 'session_invalid' | 'session_in_use';
}
export interface DetachedRunAcceptedV1 {
  kind: 'run_accepted';
  operation_id: RunOperationIdV1;
  package_id: string;
  version: string;
  package_digest: string;
  capability: string;
  run_id: string;
}

export interface ResumeRunAcceptedV1 {
  kind: 'run_resume_accepted';
  operation_id: RunOperationIdV1;
  run_id: string;
}

export type WaitRunResponseV1 = StartInstalledScrapeRunResultV1 | StoredRunInspectionV1;

export type ConsumerDaemonRunStateWaitResponseV1 = RunStateWaitResultV1 | ConsumerRunFailureV1;

export interface CancelRunResponseV1 {
  kind: 'run_cancellation_requested' | 'run_not_active';
  operation_id: RunOperationIdV1;
  run_id: string;
}

export type DiscardRunResponseV1 = DiscardRunResultV1 & { operation_id: RunOperationIdV1 };

export interface ConsumerRunOperationFailureV1 {
  kind: 'consumer_run_operation_failure';
  code: 'operation_conflict' | 'operation_in_progress' | 'local_state_invalid';
}

export interface ConsumerListRunsFailureV1 {
  result_schema_version: 1;
  kind: 'consumer_failure';
  operation: 'list_runs';
  code: 'invalid_options' | 'cursor_invalid' | 'output_too_large_for_adapter';
  retryable: false;
  package_id: null;
}

export type ConsumerDaemonListRunsResponseV1 = ListedRunsPageV1 | ConsumerListRunsFailureV1;

export interface ConsumerRunFailureV1 {
  result_schema_version: 1;
  kind: 'consumer_failure';
  operation: 'get_run' | 'list_run_items' | 'wait_run' | 'discard_run';
  code: 'run_not_found' | 'local_state_invalid';
  retryable: false;
  package_id: null;
}

export type ConsumerDaemonRunResponseV1 =
  | StoredRunInspectionV1
  | CommittedRunItemsPageV1
  | DiscardRunResultV1
  | DiscardRunResponseV1
  | RunStateWaitResultV1
  | ConsumerRunFailureV1;

export type ConsumerDaemonRunItemStreamEventV1 =
  | RunItemStreamEventV1
  | { kind: 'failure'; failure: ConsumerRunFailureV1 };

export function isConsumerListRunsFailure(value: unknown): value is ConsumerListRunsFailureV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.result_schema_version === 1 &&
    record.kind === 'consumer_failure' &&
    record.operation === 'list_runs' &&
    (record.code === 'invalid_options' ||
      record.code === 'cursor_invalid' ||
      record.code === 'output_too_large_for_adapter') &&
    record.retryable === false &&
    record.package_id === null
  );
}

export function isConsumerRunFailure(value: unknown): value is ConsumerRunFailureV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.result_schema_version === 1 &&
    record.kind === 'consumer_failure' &&
    (record.operation === 'get_run' ||
      record.operation === 'list_run_items' ||
      record.operation === 'wait_run' ||
      record.operation === 'discard_run') &&
    (record.code === 'run_not_found' || record.code === 'local_state_invalid') &&
    record.retryable === false &&
    record.package_id === null
  );
}

export type ConsumerDaemonLocalResultV1 =
  | SearchPackagesResultV1
  | ShowPackageResultV1
  | InstallPackageResultV1
  | ListInstalledPackagesResultV1
  | RemovePackageResultV1
  | ConsumerDaemonListRunsResponseV1
  | ConsumerDaemonRunResponseV1
  | ConsumerDoctorResultV1;

export {
  isCancelRunResponse,
  isDetachedRunAccepted,
  isDiscardRunResponse,
  isResumeRunAccepted,
} from './run-operation-contracts';

export function isConsumerDaemonFailure(value: unknown): value is ConsumerDaemonFailureV1 {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'consumer_daemon_failure' &&
    isInstalledPackageErrorCode((value as { code?: unknown }).code)
  );
}

export function isConsumerRunSessionFailure(value: unknown): value is ConsumerRunSessionFailureV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === 'consumer_run_session_failure' &&
    (record.code === 'session_required' ||
      record.code === 'session_invalid' ||
      record.code === 'session_in_use')
  );
}

export function isConsumerRunOperationFailure(
  value: unknown,
): value is ConsumerRunOperationFailureV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === 'consumer_run_operation_failure' &&
    (record.code === 'operation_conflict' ||
      record.code === 'operation_in_progress' ||
      record.code === 'local_state_invalid')
  );
}

/** Private daemon route adapter over the shared consumer execution services. */
export class ConsumerDaemonRoutesV1 {
  private readonly activeRuns = new Map<
    string,
    {
      completion: Promise<StartInstalledScrapeRunResultV1>;
      cancel: (source: DaemonCancellationSourceV1) => boolean;
    }
  >();
  private readonly completedRuns = new Map<string, StartInstalledScrapeRunResultV1>();
  private readonly operationStore: RunOperationStoreV1;
  private readonly registryService: Pick<ConsumerRegistryServiceV1, 'search' | 'show' | 'install'>;

  constructor(
    private readonly services: ConsumerDaemonExecutionServicesV1 = createServices(),
    private readonly runInspection = new ConsumerRunServiceV1(),
    private readonly onActiveRunChange: () => void = () => undefined,
    private readonly localListing = new ConsumerLocalListingServiceV1(),
    registryService: Pick<ConsumerRegistryServiceV1, 'search' | 'show' | 'install'> | null = null,
    private readonly doctorService: Pick<
      ConsumerDoctorServiceV1,
      'inspect'
    > = new ConsumerDoctorServiceV1(),
    operationStore?: RunOperationStoreV1,
  ) {
    const home = (runInspection as { home?: unknown }).home;
    const consumerHome = typeof home === 'string' ? home : defaultConsumerHome();
    this.operationStore = operationStore ?? new RunOperationStoreV1(consumerHome);
    this.registryService = registryService ?? createDefaultConsumerRegistryService(consumerHome);
  }

  activeRunCount(): number {
    return this.activeRuns.size;
  }

  followItems(
    body: unknown,
    signal?: AbortSignal,
  ): AsyncIterable<ConsumerDaemonRunItemStreamEventV1> {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/runs/items/follow'],
      body,
      'consumer.runs.items.follow',
    );
    return this.streamRunItems(
      record.run_id,
      record.after_sequence === null ? undefined : record.after_sequence,
      signal,
    );
  }

  async invoke(
    method: string | undefined,
    route: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<
    | CallInstalledCapabilityResultV1
    | StartInstalledScrapeRunResultV1
    | DetachedRunAcceptedV1
    | ResumeRunAcceptedV1
    | CancelRunResponseV1
    | DiscardRunResponseV1
    | StoredRunInspectionV1
    | ConsumerDaemonFailureV1
    | ConsumerRunOutputFailureV1
    | ConsumerRunSessionFailureV1
    | ConsumerRunOperationFailureV1
    | ConsumerDaemonLocalResultV1
    | ClearPackageSessionResultV1
    | OpenPackageLoginResultV1
    | CompletePackageLoginResultV1
  > {
    if (method !== 'POST') {
      throw new PublicContractError('consumer_daemon.method', 'must be POST');
    }
    try {
      switch (route) {
        case '/consumer/search':
          return await this.search(body);
        case '/consumer/show':
          return await this.show(body);
        case '/consumer/install':
          return await this.install(body);
        case '/consumer/installed':
          return this.installed(body);
        case '/consumer/remove':
          return this.remove(body);
        case '/consumer/doctor':
          return this.doctor(body);
        case '/consumer/session/clear':
          return this.clearSession(body);
        case '/consumer/login/open':
          return await this.openLogin(body);
        case '/consumer/login/complete':
          return await this.completeLogin(body);
        case '/consumer/call':
          return await this.call(body, signal);
        case '/consumer/run':
          return this.start(body);
        case '/consumer/runs/resume':
          return this.resume(body);
        case '/consumer/runs/wait':
          return await this.wait(body, signal);
        case '/consumer/runs/wait-state':
          return await this.waitState(body, signal);
        case '/consumer/runs/cancel':
          return this.cancel(body);
        case '/consumer/runs/show':
          return this.showRun(body);
        case '/consumer/runs/list':
          return this.listRuns(body);
        case '/consumer/runs/items':
          return this.listRunItems(body);
        case '/consumer/runs/discard':
          return this.discardRun(body);
        default:
          throw new PublicContractError(
            'consumer_daemon.route',
            'is not a consumer execution route',
          );
      }
    } catch (error) {
      if (error instanceof ConsumerRunSessionError) {
        return { kind: 'consumer_run_session_failure', code: error.code };
      }
      if (error instanceof InstalledPackageError) {
        return { kind: 'consumer_daemon_failure', code: error.code };
      }
      if (error instanceof RunOutputError && error.code === 'output_sink_required') {
        return { kind: 'consumer_run_output_failure', code: error.code };
      }
      if (error instanceof RunOperationError) {
        return { kind: 'consumer_run_operation_failure', code: error.code };
      }
      throw error;
    }
  }

  private async search(body: unknown): Promise<SearchPackagesResultV1> {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/search'],
      body,
      'consumer.search',
    );
    return this.registryService.search({
      ...(record.query === null ? {} : { query: record.query }),
      ...(record.cursor === null ? {} : { cursor: record.cursor }),
      ...(record.limit === null ? {} : { limit: record.limit }),
    });
  }

  private async show(body: unknown): Promise<ShowPackageResultV1> {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/show'],
      body,
      'consumer.show',
    );
    return this.registryService.show({
      package_id: record.package_id,
      ...(record.version === null ? {} : { version: record.version }),
      ...(record.capability === null ? {} : { capability: record.capability }),
    });
  }

  private async install(body: unknown): Promise<InstallPackageResultV1> {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/install'],
      body,
      'consumer.install',
    );
    return this.registryService.install({
      package_id: record.package_id,
      ...(record.version === null ? {} : { version: record.version }),
    });
  }

  private installed(body: unknown): ListInstalledPackagesResultV1 {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/installed'],
      body,
      'consumer.installed',
    );
    return this.localListing.installed({
      ...(record.cursor === null ? {} : { cursor: record.cursor }),
      ...(record.limit === null ? {} : { limit: record.limit }),
    });
  }

  private remove(body: unknown): RemovePackageResultV1 {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/remove'],
      body,
      'consumer.remove',
    );
    return this.localListing.remove({ package_id: record.package_id });
  }

  private doctor(body: unknown): ConsumerDoctorResultV1 {
    parseConsumerWireBody(CONSUMER_WIRE_CONTRACTS['/consumer/doctor'], body, 'consumer.doctor');
    return this.doctorService.inspect();
  }

  private clearSession(body: unknown): ClearPackageSessionResultV1 {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/session/clear'],
      body,
      'consumer.session.clear',
    );
    return this.services.clearSession({
      package_id: record.package_id,
      ...(record.authentication_contract_id === null
        ? {}
        : { authentication_contract_id: record.authentication_contract_id }),
      ...(record.session_name === null ? {} : { session_name: record.session_name }),
    });
  }

  private async openLogin(body: unknown): Promise<OpenPackageLoginResultV1> {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/login/open'],
      body,
      'consumer.login.open',
    );
    return await this.services.openLogin({
      package_id: record.package_id,
      ...(record.authentication_contract_id === null
        ? {}
        : { authentication_contract_id: record.authentication_contract_id }),
      ...(record.session_name === null ? {} : { session_name: record.session_name }),
    });
  }

  private async completeLogin(body: unknown): Promise<CompletePackageLoginResultV1> {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/login/complete'],
      body,
      'consumer.login.complete',
    );
    return await this.services.completeLogin({ interaction_id: record.interaction_id });
  }

  private async call(
    body: unknown,
    signal?: AbortSignal,
  ): Promise<CallInstalledCapabilityResultV1> {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/call'],
      body,
      'consumer.call',
    );
    return this.services.call({
      package_id: record.package_id,
      capability: record.capability,
      input: record.input,
      options: {
        ...(record.session_name === null ? {} : { session_name: record.session_name }),
        ...(record.timeout_ms === null ? {} : { timeout_ms: record.timeout_ms }),
        signal,
      },
    });
  }

  private start(body: unknown): DetachedRunAcceptedV1 | ConsumerRunOutputFailureV1 {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/run'],
      body,
      'consumer.run',
    );
    const inputMode = record.input_mode_id === null ? undefined : record.input_mode_id;
    const output = record.output === null ? undefined : record.output;
    const inlineOutputMaxBytes =
      record.inline_output_max_bytes === null
        ? DEFAULT_INLINE_OUTPUT_MAX_BYTES_V1
        : record.inline_output_max_bytes;
    const sessionName = record.session_name === null ? undefined : record.session_name;
    const operationId = record.operation_id;
    const packageId = record.package_id;
    const capability = record.capability;
    const argumentsValue: JsonValueV1 = {
      package_id: packageId,
      capability,
      input: record.input,
      caller_bounds: record.caller_bounds,
      input_mode_id: inputMode ?? null,
      output: output ?? null,
      inline_output_max_bytes: inlineOutputMaxBytes,
      session_name: sessionName ?? null,
    };
    const reservation = this.operationStore.reserve({
      operation_id: operationId,
      command: 'start',
      arguments: argumentsValue,
    });
    if (reservation.record.result !== null) {
      return parseDetachedRunAcceptance(reservation.record.result, 'run_operation.result');
    }
    const runId = reservation.record.run_id;
    if (runId === null) {
      throw new RunOperationError(
        'local_state_invalid',
        'start operation lacks its reserved run id',
      );
    }
    const existing = this.existingStartAcceptance(runId, operationId);
    if (existing !== null) {
      this.operationStore.complete(operationId, existing as unknown as JsonValueV1);
      return existing;
    }
    let started: StartedInstalledScrapeRunV1;
    try {
      started = this.services.startDetached({
        package_id: packageId,
        capability,
        input: record.input,
        caller_bounds: record.caller_bounds,
        ...(inputMode === undefined ? {} : { input_mode_id: inputMode }),
        ...(output === undefined ? {} : { output }),
        inline_output_max_bytes: inlineOutputMaxBytes,
        ...(sessionName === undefined ? {} : { session_name: sessionName }),
        run_id: runId,
        operation_id: operationId,
      });
    } catch (error) {
      if (error instanceof RunOutputError && error.code === 'output_sink_required') {
        this.operationStore.abandon(operationId);
      }
      throw error;
    }
    this.registerActiveRun(started.run_id, started.completion, (source) => started.cancel(source));
    const accepted: DetachedRunAcceptedV1 = {
      kind: 'run_accepted',
      operation_id: operationId,
      package_id: started.package_id,
      version: started.version,
      package_digest: started.package_digest,
      capability: started.capability,
      run_id: started.run_id,
    };
    this.operationStore.complete(operationId, accepted as unknown as JsonValueV1);
    return accepted;
  }

  private resume(body: unknown): ResumeRunAcceptedV1 {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/runs/resume'],
      body,
      'consumer.runs.resume',
    );
    const runId = record.run_id;
    const operationId = record.operation_id;
    if (this.operationStore.read(operationId) === null && this.activeRuns.has(runId)) {
      throw new RunOperationError('operation_conflict', 'run is already resuming');
    }
    const reservation = this.operationStore.reserve({
      operation_id: operationId,
      command: 'resume',
      arguments: { run_id: runId },
      run_id: runId,
    });
    if (reservation.record.result !== null) {
      return parseResumeRunAcceptance(reservation.record.result, 'run_operation.result');
    }
    const controller = new AbortController();
    let cancellationSource: DaemonCancellationSourceV1 = 'cli_cancel';
    const completion = this.services.resume({
      run_id: runId,
      signal: controller.signal,
      cancellation_source: () => cancellationSource,
    });
    this.registerActiveRun(runId, completion, (source) => {
      cancellationSource = source;
      controller.abort();
      return true;
    });
    const accepted: ResumeRunAcceptedV1 = {
      kind: 'run_resume_accepted',
      operation_id: operationId,
      run_id: runId,
    };
    this.operationStore.complete(operationId, accepted as unknown as JsonValueV1);
    return accepted;
  }

  private async wait(
    body: unknown,
    signal?: AbortSignal,
  ): Promise<WaitRunResponseV1 | ConsumerRunFailureV1> {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/runs/wait'],
      body,
      'consumer.runs.wait',
    );
    const runId = record.run_id;
    const active = this.activeRuns.get(runId);
    if (active !== undefined) return await awaitWithSignal(active.completion, signal);
    const completed = this.completedRuns.get(runId);
    if (completed !== undefined) return completed;
    try {
      return this.runInspection.show(runId);
    } catch (error) {
      return runFailure('wait_run', error);
    }
  }

  private async waitState(
    body: unknown,
    signal?: AbortSignal,
  ): Promise<ConsumerDaemonRunStateWaitResponseV1> {
    try {
      const record = parseConsumerWireBody(
        CONSUMER_WIRE_CONTRACTS['/consumer/runs/wait-state'],
        body,
        'consumer.runs.wait_state',
      );
      return await this.runInspection.waitState(record.run_id, {
        ...(record.after_state_version === null
          ? {}
          : { after_state_version: record.after_state_version }),
        ...(record.wait_timeout_ms === null ? {} : { wait_timeout_ms: record.wait_timeout_ms }),
        signal,
      });
    } catch (error) {
      return runFailure('wait_run', error);
    }
  }

  private cancel(body: unknown): CancelRunResponseV1 {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/runs/cancel'],
      body,
      'consumer.runs.cancel',
    );
    const runId = record.run_id;
    const operationId = record.operation_id;
    const reservation = this.operationStore.reserve({
      operation_id: operationId,
      command: 'cancel',
      arguments: { run_id: runId, source: record.source },
      run_id: runId,
    });
    if (reservation.record.result !== null) {
      return parseCancelRunResponse(reservation.record.result, 'run_operation.result');
    }
    const active = this.activeRuns.get(runId);
    const result: CancelRunResponseV1 =
      active === undefined || !active.cancel(record.source)
        ? { kind: 'run_not_active', operation_id: operationId, run_id: runId }
        : { kind: 'run_cancellation_requested', operation_id: operationId, run_id: runId };
    this.operationStore.complete(operationId, result as unknown as JsonValueV1);
    return result;
  }

  private showRun(body: unknown): StoredRunInspectionV1 | ConsumerRunFailureV1 {
    try {
      const record = parseConsumerWireBody(
        CONSUMER_WIRE_CONTRACTS['/consumer/runs/show'],
        body,
        'consumer.runs.show',
      );
      return this.runInspection.show(record.run_id);
    } catch (error) {
      return runFailure('get_run', error);
    }
  }

  private listRuns(body: unknown): ConsumerDaemonListRunsResponseV1 {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/runs/list'],
      body,
      'consumer.runs.list',
    );
    try {
      return this.runInspection.listPage({
        ...(record.cursor === null ? {} : { cursor: record.cursor }),
        ...(record.limit === null ? {} : { limit: record.limit }),
      });
    } catch (error) {
      if (!(error instanceof RunListError)) throw error;
      return {
        result_schema_version: 1,
        kind: 'consumer_failure',
        operation: 'list_runs',
        code: error.code,
        retryable: false,
        package_id: null,
      };
    }
  }

  private listRunItems(body: unknown): CommittedRunItemsPageV1 | ConsumerRunFailureV1 {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/runs/items'],
      body,
      'consumer.runs.items',
    );
    const options = {
      ...(record.after_sequence === null ? {} : { after_sequence: record.after_sequence }),
      ...(record.limit === null ? {} : { limit: record.limit }),
    };
    try {
      return this.runInspection.items(record.run_id, options);
    } catch (error) {
      return runFailure('list_run_items', error);
    }
  }

  private async *streamRunItems(
    runId: import('./scrape/journal').RunIdV1,
    afterSequence: number | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<ConsumerDaemonRunItemStreamEventV1> {
    try {
      for await (const event of this.runInspection.followItems(runId, {
        ...(afterSequence === undefined ? {} : { after_sequence: afterSequence }),
        signal,
      })) {
        yield event;
      }
    } catch (error) {
      if (!signal?.aborted) {
        yield { kind: 'failure', failure: runFailure('list_run_items', error) };
      }
    }
  }

  private discardRun(body: unknown): DiscardRunResponseV1 | ConsumerRunFailureV1 {
    const record = parseConsumerWireBody(
      CONSUMER_WIRE_CONTRACTS['/consumer/runs/discard'],
      body,
      'consumer.runs.discard',
    );
    const runId = record.run_id;
    const operationId = record.operation_id;
    try {
      const reservation = this.operationStore.reserve({
        operation_id: operationId,
        command: 'discard',
        arguments: { run_id: runId },
        run_id: runId,
      });
      if (reservation.record.result !== null) {
        return parseDiscardRunResponse(reservation.record.result, 'run_operation.result');
      }
      const result: DiscardRunResponseV1 = {
        ...this.runInspection.discard(runId),
        operation_id: operationId,
      };
      this.operationStore.complete(operationId, result as unknown as JsonValueV1);
      return result;
    } catch (error) {
      if (error instanceof RunOperationError) throw error;
      return runFailure('discard_run', error);
    }
  }

  private existingStartAcceptance(
    runId: RunIdV1,
    operationId: RunOperationIdV1,
  ): DetachedRunAcceptedV1 | null {
    const store = new RunStoreV1(this.runInspection.home);
    let meta;
    try {
      meta = store.read(runId).payload;
    } catch (error) {
      if (error instanceof PublicContractError && error.field === 'run_id') return null;
      throw error;
    }
    this.runInspection.show(runId);
    if (meta.start_operation_id !== operationId) {
      throw new RunOperationError(
        'operation_conflict',
        'reserved run metadata belongs to a different start operation',
      );
    }
    return {
      kind: 'run_accepted',
      operation_id: operationId,
      package_id: meta.artifact.package_id,
      version: meta.artifact.version,
      package_digest: meta.artifact.package_digest,
      capability: meta.artifact.capability,
      run_id: runId,
    };
  }

  private registerActiveRun(
    runId: string,
    completion: Promise<StartInstalledScrapeRunResultV1>,
    cancel: (source: DaemonCancellationSourceV1) => boolean,
  ): void {
    this.activeRuns.set(runId, { completion, cancel });
    this.onActiveRunChange();
    void completion.then(
      (result) => {
        this.completeActiveRun(runId, result);
      },
      () => {
        this.completeActiveRun(runId);
      },
    );
  }

  private completeActiveRun(runId: string, result?: StartInstalledScrapeRunResultV1): void {
    this.activeRuns.delete(runId);
    if (result !== undefined) {
      this.completedRuns.set(runId, result);
      if (this.completedRuns.size > 128) {
        const oldest = this.completedRuns.keys().next().value;
        if (oldest !== undefined) this.completedRuns.delete(oldest);
      }
    }
    this.onActiveRunChange();
  }
}

function createServices(): ConsumerDaemonExecutionServicesV1 {
  const store = new PackageStoreV1();
  const runtimeVersion = readConsumerRuntimeVersion();
  const calls = new ConsumerCallServiceV1(store, runtimeVersion);
  const runs = new ConsumerScrapeRunServiceV1(store, runtimeVersion);
  const sessions = new ConsumerSessionServiceV1(store, runtimeVersion);
  const logins = new ConsumerLoginServiceV1(store, runtimeVersion);
  return {
    call: calls.call.bind(calls),
    clearSession: sessions.clear.bind(sessions),
    openLogin: logins.open.bind(logins),
    completeLogin: logins.complete.bind(logins),
    start: runs.start.bind(runs),
    startDetached: runs.startDetached.bind(runs),
    resume: runs.resume.bind(runs),
  };
}

function runFailure(
  operation: ConsumerRunFailureV1['operation'],
  error: unknown,
): ConsumerRunFailureV1 {
  if (!(error instanceof PublicContractError)) throw error;
  return {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation,
    code: error.field === 'run_id' ? 'run_not_found' : 'local_state_invalid',
    retryable: false,
    package_id: null,
  };
}
