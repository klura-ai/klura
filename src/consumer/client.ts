import path from 'node:path';
import {
  parseCapabilityId,
  parseInteger,
  parsePackageId,
  parseSessionName,
  parseStableContractId,
  parseString,
  PublicContractError,
  PUBLIC_CONTRACT_LIMITS,
  type CapabilityIdV1,
  type PackageIdV1,
} from '../public/contracts/common';
import { assertJsonValue, type JsonValueV1 } from '../public/contracts/json';
import { isConsumerRunOutputFailure, type ConsumerRunOutputFailureV1 } from './run-output-failure';
import {
  isConsumerDaemonFailure,
  isConsumerRunOperationFailure,
  isConsumerRunSessionFailure,
  isConsumerListRunsFailure,
  isConsumerRunFailure,
  isCancelRunResponse,
  isDiscardRunResponse,
  isDetachedRunAccepted,
  isResumeRunAccepted,
  type CancelRunResponseV1,
  type ConsumerDaemonFailureV1,
  type ConsumerDaemonRunItemStreamEventV1,
  type ConsumerDaemonRunStateWaitResponseV1,
  type ConsumerRunOperationFailureV1,
  type ConsumerRunSessionFailureV1,
  type ConsumerDaemonListRunsResponseV1,
  type ConsumerRunFailureV1,
  type DetachedRunAcceptedV1,
  type DiscardRunResponseV1,
  type ResumeRunAcceptedV1,
  type WaitRunResponseV1,
} from './daemon-routes';
import {
  ConsumerDaemonClientError,
  followConsumerDaemon,
  invokeConsumerDaemon,
} from './daemon-client';
import {
  type ConsumerPageOptionsV1,
  type ListInstalledPackagesResultV1,
  type RemovePackageResultV1,
} from './local-listing';
import {
  type InstallPackageResultV1,
  type SearchPackagesResultV1,
  type ShowPackageResultV1,
} from './registry-service';
import type { ListedRunV1, RunItemStreamEventV1 } from './runs';
import type { CallInstalledCapabilityResultV1 } from './call-service';
import {
  createRunOperationId,
  parseRunId,
  parseRunOperationId,
  type RunCancellationSourceV1,
  type RunIdV1,
} from './scrape/journal';
import {
  DEFAULT_INLINE_OUTPUT_MAX_BYTES_V1,
  parseRunOutput,
  type RunOutputFormatV1,
  type RunOutputV1,
} from './scrape/output';
import type { CommittedRunItemsPageV1 } from './scrape/result-reader';
import type { StoredRunInspectionV1 } from './scrape/inspection';
import type { ConsumerDoctorResultV1 } from './doctor';
import type { ClearPackageSessionResultV1 } from './session-service';
import type { CompletePackageLoginResultV1, OpenPackageLoginResultV1 } from './login-service';

export interface ConsumerCapabilitySelectorV1 {
  package_id: PackageIdV1;
  capability: CapabilityIdV1;
}

export interface ConsumerRunOutputV1 {
  kind: 'file';
  path: string;
  format: RunOutputFormatV1;
}

export interface ConsumerStartRunOptionsV1 {
  operation_id?: string;
  session_name?: string;
  input_mode_id?: string;
  output?: { kind: 'inline' } | ConsumerRunOutputV1;
  max_items?: number;
  max_pages?: number;
  max_requests?: number;
  timeout_ms?: number;
  max_concurrency?: number;
  limits?: Record<string, number>;
}

export interface ConsumerRunCommandOptionsV1 {
  operation_id?: string;
}

export interface ConsumerCallOptionsV1 {
  session_name?: string;
  timeout_ms?: number;
  signal?: AbortSignal;
}

export interface ConsumerClearSessionOptionsV1 {
  authentication_contract_id?: string;
  session_name?: string;
}

export interface ConsumerOpenLoginOptionsV1 {
  authentication_contract_id?: string;
  session_name?: string;
}

export interface ConsumerClientFailureV1 {
  result_schema_version: 1;
  kind: 'consumer_failure';
  operation:
    | 'call'
    | 'clear_session'
    | 'open_login'
    | 'complete_login'
    | 'start_run'
    | 'get_run'
    | 'list_runs'
    | 'list_run_items'
    | 'wait_run'
    | 'resume_run'
    | 'cancel_run'
    | 'discard_run';
  code:
    | 'invalid_options'
    | 'cursor_invalid'
    | 'output_too_large_for_adapter'
    | 'output_sink_required'
    | 'package_not_installed'
    | 'capability_not_found'
    | 'runtime_incompatible'
    | 'local_state_invalid'
    | 'session_required'
    | 'session_invalid'
    | 'session_in_use'
    | 'operation_conflict'
    | 'operation_in_progress'
    | 'run_not_found';
  retryable: false;
  package_id: PackageIdV1 | null;
  suggested_action?: { kind: 'use_output_sink' };
}

export type ConsumerCallInvocationResultV1 =
  | ({ result_schema_version: 1; kind: 'call_result' } & CallInstalledCapabilityResultV1)
  | ConsumerClientFailureV1;

export type ConsumerClearSessionResultV1 =
  | ({ result_schema_version: 1 } & ClearPackageSessionResultV1)
  | ConsumerClientFailureV1;

export type ConsumerOpenLoginResultV1 =
  | ({ result_schema_version: 1 } & OpenPackageLoginResultV1)
  | ConsumerClientFailureV1;

export type ConsumerCompleteLoginResultV1 =
  | ({ result_schema_version: 1 } & CompletePackageLoginResultV1)
  | ConsumerClientFailureV1;

export type ConsumerStartRunResultV1 =
  | ({ result_schema_version: 1 } & DetachedRunAcceptedV1)
  | ConsumerClientFailureV1;

export type ConsumerResumeRunResultV1 =
  | ({ result_schema_version: 1 } & ResumeRunAcceptedV1)
  | ConsumerClientFailureV1;

export type ConsumerCancelRunResultV1 =
  | ({ result_schema_version: 1 } & CancelRunResponseV1)
  | ConsumerClientFailureV1;

export type ConsumerWaitRunResultV1 =
  | ({ result_schema_version: 1; kind: 'run_wait' } & WaitRunResponseV1)
  | ConsumerClientFailureV1;

export type ConsumerRunStateWaitResultV1 =
  | {
      result_schema_version: 1;
      kind: 'run_state';
      changed: boolean;
      snapshot: StoredRunInspectionV1;
    }
  | ConsumerClientFailureV1;

export type ConsumerGetRunResultV1 =
  | { result_schema_version: 1; kind: 'run'; run: StoredRunInspectionV1 }
  | ConsumerClientFailureV1;

export type ConsumerListRunsResultV1 =
  | { result_schema_version: 1; kind: 'runs'; items: ListedRunV1[]; next_cursor: string | null }
  | ConsumerClientFailureV1;

export type ConsumerListRunItemsResultV1 =
  | { result_schema_version: 1; kind: 'run_items'; page: CommittedRunItemsPageV1 }
  | ConsumerClientFailureV1;

export type ConsumerDiscardRunResultV1 =
  | { result_schema_version: 1; kind: 'run_discard'; result: DiscardRunResponseV1 }
  | ConsumerClientFailureV1;

export type ConsumerRunItemStreamEventV1 =
  | RunItemStreamEventV1
  | { kind: 'failure'; failure: ConsumerClientFailureV1 };

export interface ConsumerRunHandleV1 {
  readonly run_id: RunIdV1;
  get(): Promise<ConsumerGetRunResultV1>;
  wait(options?: { signal?: AbortSignal }): Promise<ConsumerWaitRunResultV1>;
  items(options?: {
    after_sequence?: number;
    signal?: AbortSignal;
  }): AsyncIterable<ConsumerRunItemStreamEventV1>;
  cancel(): Promise<ConsumerCancelRunResultV1>;
}

interface ConsumerClientDependenciesV1 {
  inline_output_max_bytes?: number;
  invoke_daemon?: <Result>(
    route:
      | '/consumer/search'
      | '/consumer/show'
      | '/consumer/install'
      | '/consumer/installed'
      | '/consumer/remove'
      | '/consumer/doctor'
      | '/consumer/session/clear'
      | '/consumer/login/open'
      | '/consumer/login/complete'
      | '/consumer/call'
      | '/consumer/run'
      | '/consumer/runs/resume'
      | '/consumer/runs/wait'
      | '/consumer/runs/wait-state'
      | '/consumer/runs/cancel'
      | '/consumer/runs/show'
      | '/consumer/runs/list'
      | '/consumer/runs/items'
      | '/consumer/runs/discard',
    body: JsonValueV1,
    signal?: AbortSignal,
  ) => Promise<Result>;
}

/**
 * Consumer-first local facade. It accepts only separate structural selectors and never
 * selects discovery or a registry authority from caller input.
 */
export class KluraConsumerClientV1 {
  private readonly invokeDaemon: NonNullable<ConsumerClientDependenciesV1['invoke_daemon']>;

  private readonly inlineOutputMaxBytes: number;

  constructor(dependencies: ConsumerClientDependenciesV1 = {}) {
    this.invokeDaemon = dependencies.invoke_daemon ?? invokeConsumerDaemon;
    this.inlineOutputMaxBytes = parseInteger(
      dependencies.inline_output_max_bytes ?? DEFAULT_INLINE_OUTPUT_MAX_BYTES_V1,
      'consumer_client.inline_output_max_bytes',
      1,
      DEFAULT_INLINE_OUTPUT_MAX_BYTES_V1,
    );
  }

  async search(query?: string, options?: ConsumerPageOptionsV1): Promise<SearchPackagesResultV1> {
    return this.invokeDaemon<SearchPackagesResultV1>('/consumer/search', {
      query: query ?? null,
      cursor: options?.cursor ?? null,
      limit: options?.limit ?? null,
    });
  }

  async show(input: unknown): Promise<ShowPackageResultV1> {
    const record = registryInputRecord(input, 'show');
    return this.invokeDaemon<ShowPackageResultV1>('/consumer/show', {
      package_id: record.package_id ?? null,
      version: record.version ?? null,
      capability: record.capability ?? null,
    });
  }

  async install(input: unknown): Promise<InstallPackageResultV1> {
    const record = registryInputRecord(input, 'install');
    return this.invokeDaemon<InstallPackageResultV1>('/consumer/install', {
      package_id: record.package_id ?? null,
      version: record.version ?? null,
    });
  }

  async installed(options: ConsumerPageOptionsV1 = {}): Promise<ListInstalledPackagesResultV1> {
    return this.invokeDaemon<ListInstalledPackagesResultV1>('/consumer/installed', {
      cursor: options.cursor ?? null,
      limit: options.limit ?? null,
    });
  }

  async remove(packageId: PackageIdV1): Promise<RemovePackageResultV1> {
    return this.invokeDaemon<RemovePackageResultV1>('/consumer/remove', { package_id: packageId });
  }

  async doctor(): Promise<ConsumerDoctorResultV1> {
    return this.invokeDaemon<ConsumerDoctorResultV1>('/consumer/doctor', {});
  }

  async clearSession(
    packageId: PackageIdV1,
    options: ConsumerClearSessionOptionsV1 = {},
  ): Promise<ConsumerClearSessionResultV1> {
    try {
      const selectedPackageId = parsePackageId(packageId, 'clear_session.package_id');
      const authenticationContractId =
        options.authentication_contract_id === undefined
          ? null
          : parseStableContractId(
              options.authentication_contract_id,
              'clear_session.options.authentication_contract_id',
            );
      const sessionName =
        options.session_name === undefined
          ? null
          : parseSessionName(options.session_name, 'clear_session.options.session_name');
      const result = await this.invokeDaemon<ClearPackageSessionResultV1>(
        '/consumer/session/clear',
        {
          package_id: selectedPackageId,
          authentication_contract_id: authenticationContractId,
          session_name: sessionName,
        },
      );
      return { result_schema_version: 1, ...result };
    } catch (error) {
      return inputFailure('clear_session', knownPackageId(packageId), error);
    }
  }

  async openLogin(
    packageId: PackageIdV1,
    options: ConsumerOpenLoginOptionsV1 = {},
  ): Promise<ConsumerOpenLoginResultV1> {
    let selectedPackageId: PackageIdV1 | null = null;
    try {
      selectedPackageId = parsePackageId(packageId, 'open_login.package_id');
      const authenticationContractId =
        options.authentication_contract_id === undefined
          ? null
          : parseStableContractId(
              options.authentication_contract_id,
              'open_login.options.authentication_contract_id',
            );
      const sessionName =
        options.session_name === undefined
          ? null
          : parseSessionName(options.session_name, 'open_login.options.session_name');
      const result = await this.invokeDaemon<OpenPackageLoginResultV1>('/consumer/login/open', {
        package_id: selectedPackageId,
        authentication_contract_id: authenticationContractId,
        session_name: sessionName,
      });
      return { result_schema_version: 1, ...result };
    } catch (error) {
      return inputFailure('open_login', selectedPackageId, error);
    }
  }

  async completeLogin(interactionId: string): Promise<ConsumerCompleteLoginResultV1> {
    try {
      const selectedInteractionId = parseString(interactionId, 'complete_login.interaction_id', 48);
      const result = await this.invokeDaemon<CompletePackageLoginResultV1>(
        '/consumer/login/complete',
        { interaction_id: selectedInteractionId },
      );
      return { result_schema_version: 1, ...result };
    } catch (error) {
      return inputFailure('complete_login', null, error);
    }
  }

  async call(
    selector: ConsumerCapabilitySelectorV1,
    input: JsonValueV1,
    options: ConsumerCallOptionsV1 = {},
  ): Promise<ConsumerCallInvocationResultV1> {
    let selected: ConsumerCapabilitySelectorV1;
    try {
      selected = parseCapabilitySelector(selector, 'call.selector');
      assertJsonValue(input, 'call.input', PUBLIC_CONTRACT_LIMITS.maxDepth);
      const timeout =
        options.timeout_ms === undefined
          ? null
          : parseInteger(options.timeout_ms, 'call.options.timeout_ms', 1, 300_000);
      const sessionName =
        options.session_name === undefined
          ? null
          : parseSessionName(options.session_name, 'call.options.session_name');
      const result = await this.invokeDaemon<
        CallInstalledCapabilityResultV1 | ConsumerDaemonFailureV1
      >(
        '/consumer/call',
        {
          package_id: selected.package_id,
          capability: selected.capability,
          input,
          session_name: sessionName,
          timeout_ms: timeout,
        },
        options.signal,
      );
      if (isConsumerDaemonFailure(result))
        return daemonFailure('call', selected.package_id, result);
      return { result_schema_version: 1, kind: 'call_result', ...result };
    } catch (error) {
      return inputFailure('call', knownPackageId(selector), error);
    }
  }

  async startRun(
    selector: ConsumerCapabilitySelectorV1,
    input: JsonValueV1,
    options: ConsumerStartRunOptionsV1 = {},
  ): Promise<ConsumerStartRunResultV1> {
    let selected: ConsumerCapabilitySelectorV1;
    try {
      selected = parseCapabilitySelector(selector, 'start_run.selector');
      assertJsonValue(input, 'start_run.input', PUBLIC_CONTRACT_LIMITS.maxDepth);
      const { callerBounds, inputMode, output, sessionName } = parseStartOptions(options);
      const operationId =
        options.operation_id === undefined
          ? createRunOperationId()
          : parseRunOperationId(options.operation_id, 'start_run.options.operation_id');
      const result = await this.invokeDaemon<
        | DetachedRunAcceptedV1
        | ConsumerDaemonFailureV1
        | ConsumerRunOutputFailureV1
        | ConsumerRunSessionFailureV1
        | ConsumerRunOperationFailureV1
      >('/consumer/run', {
        package_id: selected.package_id,
        capability: selected.capability,
        input,
        caller_bounds: callerBounds,
        input_mode_id: inputMode ?? null,
        output: output ?? null,
        inline_output_max_bytes: this.inlineOutputMaxBytes,
        session_name: sessionName ?? null,
        detach: true,
        operation_id: operationId,
      });
      if (isConsumerDaemonFailure(result))
        return daemonFailure('start_run', selected.package_id, result);
      if (isConsumerRunOutputFailure(result)) {
        return daemonFailure('start_run', selected.package_id, result);
      }
      if (isConsumerRunSessionFailure(result))
        return daemonFailure('start_run', selected.package_id, result);
      if (isConsumerRunOperationFailure(result)) {
        return daemonFailure('start_run', selected.package_id, result);
      }
      if (!isDetachedRunAccepted(result)) return localFailure('start_run', selected.package_id);
      return { result_schema_version: 1, ...result };
    } catch (error) {
      return inputFailure('start_run', knownPackageId(selector), error);
    }
  }

  async run(
    selector: ConsumerCapabilitySelectorV1,
    input: JsonValueV1,
    options: ConsumerStartRunOptionsV1 & { signal?: AbortSignal } = {},
  ): Promise<ConsumerWaitRunResultV1 | ConsumerStartRunResultV1> {
    const started = await this.startRun(selector, input, options);
    if (started.kind === 'consumer_failure') return started;
    const runId = parseRunId(started.run_id, 'start_run.result.run_id');
    try {
      return await this.waitRun(runId, { signal: options.signal });
    } catch (error) {
      if (!isCancellation(error)) throw error;
      const cancelled = await this.cancelRun(runId);
      if (cancelled.kind === 'consumer_failure') return cancelled;
      return this.waitRun(runId);
    }
  }

  async getRun(runId: RunIdV1): Promise<ConsumerGetRunResultV1> {
    try {
      const parsed = parseRunId(runId, 'get_run.run_id');
      const result = await this.invokeDaemon<StoredRunInspectionV1 | ConsumerRunFailureV1>(
        '/consumer/runs/show',
        {
          run_id: parsed,
        },
      );
      if (isConsumerRunFailure(result)) return result;
      return {
        result_schema_version: 1,
        kind: 'run',
        run: result,
      };
    } catch (error) {
      return runFailure('get_run', error);
    }
  }

  async listRuns(
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ConsumerListRunsResultV1> {
    try {
      const result = await this.invokeDaemon<ConsumerDaemonListRunsResponseV1>(
        '/consumer/runs/list',
        { cursor: options.cursor ?? null, limit: options.limit ?? null },
      );
      if (isConsumerListRunsFailure(result)) return result;
      return { result_schema_version: 1, kind: 'runs', ...result };
    } catch (error) {
      return runFailure('list_runs', error);
    }
  }

  async listRunItems(
    runId: RunIdV1,
    options: { after_sequence?: number; limit?: number } = {},
  ): Promise<ConsumerListRunItemsResultV1> {
    try {
      const parsed = parseRunId(runId, 'list_run_items.run_id');
      const afterSequence =
        options.after_sequence === undefined
          ? null
          : parseInteger(options.after_sequence, 'list_run_items.options.after_sequence', 0, 1e9);
      const limit =
        options.limit === undefined
          ? null
          : parseInteger(options.limit, 'list_run_items.options.limit', 1, 100);
      const result = await this.invokeDaemon<CommittedRunItemsPageV1 | ConsumerRunFailureV1>(
        '/consumer/runs/items',
        {
          run_id: parsed,
          after_sequence: afterSequence,
          limit,
        },
      );
      if (isConsumerRunFailure(result)) return result;
      return {
        result_schema_version: 1,
        kind: 'run_items',
        page: result,
      };
    } catch (error) {
      return runFailure('list_run_items', error);
    }
  }

  async *items(
    runId: RunIdV1,
    options: { after_sequence?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<ConsumerRunItemStreamEventV1> {
    try {
      const parsed = parseRunId(runId, 'items.run_id');
      const afterSequence =
        options.after_sequence === undefined
          ? null
          : parseInteger(options.after_sequence, 'items.options.after_sequence', 0, 1e9);
      for await (const event of followConsumerDaemon<ConsumerDaemonRunItemStreamEventV1>(
        '/consumer/runs/items/follow',
        { run_id: parsed, after_sequence: afterSequence },
        options.signal,
      )) {
        if (event.kind === 'failure') {
          yield { kind: 'failure', failure: event.failure };
          return;
        }
        yield event;
      }
    } catch (error) {
      if (!isCancellation(error)) {
        yield { kind: 'failure', failure: runFailure('list_run_items', error) };
      }
    }
  }

  async resumeRun(
    runId: RunIdV1,
    options: ConsumerRunCommandOptionsV1 = {},
  ): Promise<ConsumerResumeRunResultV1> {
    try {
      const parsed = parseRunId(runId, 'resume_run.run_id');
      const operationId =
        options.operation_id === undefined
          ? createRunOperationId()
          : parseRunOperationId(options.operation_id, 'resume_run.options.operation_id');
      const result = await this.invokeDaemon<
        ResumeRunAcceptedV1 | ConsumerDaemonFailureV1 | ConsumerRunOperationFailureV1
      >('/consumer/runs/resume', { run_id: parsed, operation_id: operationId });
      if (isConsumerDaemonFailure(result)) return daemonFailure('resume_run', null, result);
      if (isConsumerRunOperationFailure(result)) return daemonFailure('resume_run', null, result);
      if (!isResumeRunAccepted(result)) return localFailure('resume_run', null);
      return { result_schema_version: 1, ...result };
    } catch (error) {
      return inputFailure('resume_run', null, error);
    }
  }

  async cancelRun(
    runId: RunIdV1,
    source: RunCancellationSourceV1 = 'sdk_cancel',
    options: ConsumerRunCommandOptionsV1 = {},
  ): Promise<ConsumerCancelRunResultV1> {
    try {
      const parsed = parseRunId(runId, 'cancel_run.run_id');
      const operationId =
        options.operation_id === undefined
          ? createRunOperationId()
          : parseRunOperationId(options.operation_id, 'cancel_run.options.operation_id');
      const result = await this.invokeDaemon<
        CancelRunResponseV1 | ConsumerDaemonFailureV1 | ConsumerRunOperationFailureV1
      >('/consumer/runs/cancel', { run_id: parsed, source, operation_id: operationId });
      if (isConsumerDaemonFailure(result)) return daemonFailure('cancel_run', null, result);
      if (isConsumerRunOperationFailure(result)) return daemonFailure('cancel_run', null, result);
      if (!isCancelRunResponse(result)) return localFailure('cancel_run', null);
      return { result_schema_version: 1, ...result };
    } catch (error) {
      return inputFailure('cancel_run', null, error);
    }
  }

  async waitRun(
    runId: RunIdV1,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConsumerWaitRunResultV1> {
    try {
      const parsed = parseRunId(runId, 'wait_run.run_id');
      const result = await this.invokeDaemon<
        WaitRunResponseV1 | ConsumerDaemonFailureV1 | ConsumerRunFailureV1
      >('/consumer/runs/wait', { run_id: parsed }, options.signal);
      if (isConsumerRunFailure(result)) return result;
      if (isConsumerDaemonFailure(result)) return daemonFailure('wait_run', null, result);
      return { result_schema_version: 1, kind: 'run_wait', ...result };
    } catch (error) {
      return inputFailure('wait_run', null, error);
    }
  }

  /** Waits once for durable state to differ from the caller's known journal version. */
  async waitRunState(
    runId: RunIdV1,
    options: {
      after_state_version?: number;
      wait_timeout_ms?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ConsumerRunStateWaitResultV1> {
    try {
      const parsed = parseRunId(runId, 'wait_run_state.run_id');
      const afterStateVersion =
        options.after_state_version === undefined
          ? null
          : parseInteger(
              options.after_state_version,
              'wait_run_state.options.after_state_version',
              0,
              Number.MAX_SAFE_INTEGER,
            );
      const waitTimeoutMs =
        options.wait_timeout_ms === undefined
          ? null
          : parseInteger(
              options.wait_timeout_ms,
              'wait_run_state.options.wait_timeout_ms',
              0,
              25_000,
            );
      const result = await this.invokeDaemon<ConsumerDaemonRunStateWaitResponseV1>(
        '/consumer/runs/wait-state',
        {
          run_id: parsed,
          after_state_version: afterStateVersion,
          wait_timeout_ms: waitTimeoutMs,
        },
        options.signal,
      );
      if (isConsumerRunFailure(result)) return result;
      return { result_schema_version: 1, kind: 'run_state', ...result };
    } catch (error) {
      return inputFailure('wait_run', null, error);
    }
  }

  async discardRun(
    runId: RunIdV1,
    options: ConsumerRunCommandOptionsV1 = {},
  ): Promise<ConsumerDiscardRunResultV1> {
    try {
      const parsed = parseRunId(runId, 'discard_run.run_id');
      const operationId =
        options.operation_id === undefined
          ? createRunOperationId()
          : parseRunOperationId(options.operation_id, 'discard_run.options.operation_id');
      const result = await this.invokeDaemon<
        DiscardRunResponseV1 | ConsumerRunFailureV1 | ConsumerRunOperationFailureV1
      >('/consumer/runs/discard', { run_id: parsed, operation_id: operationId });
      if (isConsumerRunFailure(result)) return result;
      if (isConsumerRunOperationFailure(result)) {
        return daemonFailure('discard_run', null, result);
      }
      if (!isDiscardRunResponse(result)) return localFailure('discard_run', null);
      return {
        result_schema_version: 1,
        kind: 'run_discard',
        result,
      };
    } catch (error) {
      return runFailure('discard_run', error);
    }
  }

  handle(runId: RunIdV1): ConsumerRunHandleV1 {
    const parsed = parseRunId(runId, 'run_handle.run_id');
    return {
      run_id: parsed,
      get: () => this.getRun(parsed),
      wait: (options) => this.waitRun(parsed, options),
      items: (options) => this.items(parsed, options),
      cancel: () => this.cancelRun(parsed),
    };
  }
}

function parseCapabilitySelector(value: unknown, field: string): ConsumerCapabilitySelectorV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be an object');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, 'package_id') ||
    !Object.hasOwn(record, 'capability')
  ) {
    throw new PublicContractError(field, 'must contain only package_id and capability');
  }
  return {
    package_id: parsePackageId(record.package_id, `${field}.package_id`),
    capability: parseCapabilityId(record.capability, `${field}.capability`),
  };
}

function parseStartOptions(options: ConsumerStartRunOptionsV1): {
  callerBounds: JsonValueV1;
  inputMode: string | undefined;
  output: RunOutputV1 | undefined;
  sessionName: string | undefined;
} {
  const bounds: Record<string, JsonValueV1> = {};
  for (const key of [
    'max_items',
    'max_pages',
    'max_requests',
    'timeout_ms',
    'max_concurrency',
  ] as const) {
    const value = options[key];
    if (value !== undefined)
      bounds[key] = parseInteger(value, `start_run.options.${key}`, 1, 1_000_000_000);
  }
  if (options.limits !== undefined) {
    const limitsInput: unknown = options.limits;
    if (!limitsInput || typeof limitsInput !== 'object' || Array.isArray(limitsInput)) {
      throw new PublicContractError('start_run.options.limits', 'must be an object');
    }
    const limits: Record<string, number> = {};
    for (const [key, value] of Object.entries(limitsInput)) {
      parseStableContractId(key, `start_run.options.limits.${key}`);
      limits[key] = parseInteger(value, `start_run.options.limits.${key}`, 1, 1_000_000_000);
    }
    bounds.limits = limits;
  }
  const inputMode =
    options.input_mode_id === undefined
      ? undefined
      : parseStableContractId(options.input_mode_id, 'start_run.options.input_mode_id');
  const output = parseConsumerRunOutput(options.output);
  const sessionName =
    options.session_name === undefined
      ? undefined
      : parseSessionName(options.session_name, 'start_run.options.session_name');
  return { callerBounds: bounds, inputMode, output, sessionName };
}

function parseConsumerRunOutput(value: unknown): RunOutputV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError('start_run.options.output', 'must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'inline') {
    if (Object.keys(record).length !== 1) {
      throw new PublicContractError(
        'start_run.options.output',
        'inline output has no extra fields',
      );
    }
    return parseRunOutput({ kind: 'inline' }, 'start_run.options.output');
  }
  if (record.kind !== 'file' || Object.keys(record).length !== 3) {
    throw new PublicContractError(
      'start_run.options.output',
      'must be an inline output or file output with path and format',
    );
  }
  return parseRunOutput(
    {
      kind: 'file',
      requested_path: typeof record.path === 'string' ? path.resolve(record.path) : record.path,
      format: record.format,
    },
    'start_run.options.output',
  );
}

function knownPackageId(input: unknown): PackageIdV1 | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  try {
    return parsePackageId((input as Record<string, unknown>).package_id, 'package_id');
  } catch {
    return null;
  }
}

function registryInputRecord(
  value: unknown,
  operation: 'show' | 'install',
): Record<string, JsonValueV1> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(operation, 'must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed =
    operation === 'show' ? ['package_id', 'version', 'capability'] : ['package_id', 'version'];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new PublicContractError(`${operation}.${key}`, 'is not allowed');
    }
  }
  assertJsonValue(record, operation, PUBLIC_CONTRACT_LIMITS.maxDepth);
  return record as Record<string, JsonValueV1>;
}

function daemonFailure(
  operation: ConsumerClientFailureV1['operation'],
  packageId: PackageIdV1 | null,
  failure:
    | ConsumerDaemonFailureV1
    | ConsumerRunOutputFailureV1
    | ConsumerRunSessionFailureV1
    | ConsumerRunOperationFailureV1,
): ConsumerClientFailureV1 {
  return {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation,
    code: failure.code,
    retryable: false,
    package_id: packageId,
    ...(failure.kind === 'consumer_run_output_failure'
      ? { suggested_action: { kind: 'use_output_sink' } as const }
      : {}),
  };
}

function inputFailure(
  operation: ConsumerClientFailureV1['operation'],
  packageId: PackageIdV1 | null,
  error: unknown,
): ConsumerClientFailureV1 {
  if (!(error instanceof PublicContractError)) throw error;
  return {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation,
    code: 'invalid_options',
    retryable: false,
    package_id: packageId,
  };
}

function localFailure(
  operation: ConsumerClientFailureV1['operation'],
  packageId: PackageIdV1 | null,
): ConsumerClientFailureV1 {
  return {
    result_schema_version: 1,
    kind: 'consumer_failure',
    operation,
    code: 'local_state_invalid',
    retryable: false,
    package_id: packageId,
  };
}

function runFailure(
  operation: Extract<
    ConsumerClientFailureV1['operation'],
    'get_run' | 'list_runs' | 'list_run_items' | 'discard_run'
  >,
  error: unknown,
): ConsumerClientFailureV1 {
  if (error instanceof PublicContractError && error.field === 'run_id') {
    return {
      result_schema_version: 1,
      kind: 'consumer_failure',
      operation,
      code: 'run_not_found',
      retryable: false,
      package_id: null,
    };
  }
  if (error instanceof PublicContractError) return inputFailure(operation, null, error);
  throw error;
}

function isCancellation(error: unknown): boolean {
  return error instanceof ConsumerDaemonClientError && error.code === 'cancelled';
}
