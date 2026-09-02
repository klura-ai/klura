import type {
  CapabilityIdV1,
  PackageIdV1,
  PackageVersionV1,
  Sha256DigestV1,
} from '../public/contracts/common';
import {
  parsePackageVersion,
  parseSessionName,
  PUBLIC_CONTRACT_LIMITS,
  runtimeSupportsVersion,
  type SessionNameV1,
} from '../public/contracts/common';
import { parseStrictJson, type JsonValueV1 } from '../public/contracts/json';
import { calculateAuthenticationContractDigest } from '../public/contracts/authentication';
import { parsePublicToolPackage, type PublicReadCapabilityV1 } from '../public/contracts/package';
import { PublicCallerV1 } from './call';
import { getConsumerOriginScheduler } from './execution/shared-scheduler';
import { InstalledPackageError, InstalledPackageResolverV1 } from './installed-package';
import {
  ScrapeRunServiceV1,
  type LocalScrapeRunResultV1,
  type RunSessionBindingV1,
} from './scrape/run-service';
import {
  createRunId,
  parseRunId,
  type RunCancellationSourceV1,
  type RunIdV1,
} from './scrape/journal';
import { RunStoreV1, type RunMetaV1 } from './scrape/run-store';
import type { RunOutputV1 } from './scrape/output';
import { SessionStoreError, SessionStoreV1 } from './sessions/store';
import { PackageStoreV1 } from './store/package-store';

export interface StartInstalledScrapeRunInputV1 {
  run_id?: string;
  operation_id?: string;
  package_id: PackageIdV1 | string;
  capability: CapabilityIdV1 | string;
  input: JsonValueV1;
  caller_bounds: unknown;
  input_mode_id?: string;
  output?: RunOutputV1;
  inline_output_max_bytes?: number;
  session_name?: SessionNameV1 | string;
  signal?: AbortSignal;
}

export interface StartInstalledScrapeRunResultV1 {
  package_id: PackageIdV1;
  version: PackageVersionV1;
  package_digest: Sha256DigestV1;
  capability: CapabilityIdV1;
  result: LocalScrapeRunResultV1;
}

export interface ResumeInstalledScrapeRunInputV1 {
  run_id: string;
  signal?: AbortSignal;
  cancellation_source?: () => RunCancellationSourceV1;
}

export interface StartedInstalledScrapeRunV1 {
  package_id: PackageIdV1;
  version: PackageVersionV1;
  package_digest: Sha256DigestV1;
  capability: CapabilityIdV1;
  run_id: string;
  completion: Promise<StartInstalledScrapeRunResultV1>;
  cancel(source?: RunCancellationSourceV1): boolean;
}

export class ConsumerRunSessionError extends Error {
  constructor(
    public readonly code: 'session_required' | 'session_invalid' | 'session_in_use',
    message: string,
  ) {
    super(message);
    this.name = 'ConsumerRunSessionError';
  }
}

interface AttachedRunSessionV1 {
  selector: {
    package_id: PackageIdV1;
    authentication_contract_id: string;
    session_name: SessionNameV1;
  };
  binding: RunSessionBindingV1;
}

/** Starts a run from the exact immutable artifact selected by installed.json. */
export class ConsumerScrapeRunServiceV1 {
  private readonly resolver: InstalledPackageResolverV1;
  private readonly runs: ScrapeRunServiceV1;
  private readonly sessions: SessionStoreV1;
  private readonly runtimeVersion: PackageVersionV1;

  constructor(
    private readonly store: PackageStoreV1,
    runtimeVersion: PackageVersionV1 | string,
    caller = new PublicCallerV1(),
  ) {
    this.runtimeVersion = parsePackageVersion(runtimeVersion, 'runtime_version');
    this.resolver = new InstalledPackageResolverV1(store, this.runtimeVersion);
    this.runs = new ScrapeRunServiceV1(
      new RunStoreV1(store.paths.home),
      caller,
      undefined,
      getConsumerOriginScheduler(store.paths.home),
    );
    this.sessions = new SessionStoreV1(store.paths.home);
  }

  async start(input: StartInstalledScrapeRunInputV1): Promise<StartInstalledScrapeRunResultV1> {
    const started = this.startDetached(input);
    return started.completion;
  }

  startDetached(input: StartInstalledScrapeRunInputV1): StartedInstalledScrapeRunV1 {
    const resolved = this.resolver.resolveCapability(input.package_id, input.capability);
    const runId =
      input.run_id === undefined ? createRunId() : parseRunId(input.run_id, 'run.run_id');
    const session = this.attachStartSession(resolved, input.session_name, runId);
    let started;
    try {
      started = this.runs.startDetached({
        run_id: runId,
        ...(input.operation_id === undefined ? {} : { operation_id: input.operation_id }),
        artifact: {
          package_id: resolved.installed.package_id,
          version: resolved.installed.version,
          package_digest: resolved.installed.package_digest,
          capability: resolved.capability_id,
          runtime_range: resolved.installed.runtime_range,
        },
        owner: resolved.capability,
        capabilities: resolved.package.capabilities,
        input: input.input,
        caller_bounds: input.caller_bounds,
        input_mode_id: input.input_mode_id,
        output: input.output,
        inline_output_max_bytes: input.inline_output_max_bytes,
        ...(session === undefined ? {} : { session: session.binding }),
        signal: input.signal,
      });
    } catch (error) {
      this.releaseAttachedSession(session, runId);
      throw error;
    }
    return {
      package_id: resolved.installed.package_id,
      version: resolved.installed.version,
      package_digest: resolved.installed.package_digest,
      capability: resolved.capability_id,
      run_id: started.run_id,
      completion: started.completion
        .then((result) => ({
          package_id: resolved.installed.package_id,
          version: resolved.installed.version,
          package_digest: resolved.installed.package_digest,
          capability: resolved.capability_id,
          result,
        }))
        .finally(() => {
          this.releaseAttachedSession(session, runId);
        }),
      cancel: (source) => started.cancel(source),
    };
  }

  async resume(input: ResumeInstalledScrapeRunInputV1): Promise<StartInstalledScrapeRunResultV1> {
    const runStore = new RunStoreV1(this.store.paths.home);
    const meta = runStore.read(input.run_id).payload;
    const artifact = meta.artifact;
    if (!runtimeSupportsVersion(artifact.runtime_range, this.runtimeVersion)) {
      throw new InstalledPackageError(
        'runtime_incompatible',
        'immutable run artifact excludes this runtime',
      );
    }
    const toolPackage = parsePublicToolPackage(
      parseStrictJson(
        this.store.readArtifact(artifact.package_digest),
        'stored_package',
        PUBLIC_CONTRACT_LIMITS.packageBytes,
        PUBLIC_CONTRACT_LIMITS.maxPackageDepth,
      ),
    );
    if (
      toolPackage.package_id !== artifact.package_id ||
      toolPackage.version !== artifact.version
    ) {
      throw new InstalledPackageError(
        'local_state_invalid',
        'immutable run artifact does not match its stored package identity',
      );
    }
    const capability = toolPackage.capabilities[artifact.capability];
    if (!capability) {
      throw new InstalledPackageError(
        'local_state_invalid',
        'immutable run capability is absent from its stored package',
      );
    }
    const session = this.attachResumeSession(meta, toolPackage, capability, input.run_id);
    let result;
    try {
      result = await this.runs.resume({
        run_id: input.run_id,
        artifact,
        owner: capability,
        capabilities: toolPackage.capabilities,
        ...(session === undefined ? {} : { session: session.binding }),
        signal: input.signal,
        cancellation_source: input.cancellation_source,
      });
    } finally {
      this.releaseAttachedSession(session, input.run_id);
    }
    return {
      package_id: artifact.package_id,
      version: artifact.version,
      package_digest: artifact.package_digest,
      capability: artifact.capability,
      result,
    };
  }

  private attachStartSession(
    resolved: ReturnType<InstalledPackageResolverV1['resolveCapability']>,
    sessionName: StartInstalledScrapeRunInputV1['session_name'],
    runId: RunIdV1,
  ): AttachedRunSessionV1 | undefined {
    const collection = resolved.capability.collection;
    if (collection === null) return undefined;
    const authentication = resolved.capability.authentication;
    const selectedName =
      sessionName === undefined ? undefined : parseSessionName(sessionName, 'run.session_name');
    if (authentication.mode === 'none') {
      if (selectedName !== undefined) {
        throw new ConsumerRunSessionError(
          'session_invalid',
          'a session cannot be selected for an unauthenticated collection',
        );
      }
      return undefined;
    }
    const taskCapabilities = collection.task_kinds.map((task) => {
      const capability = resolved.package.capabilities[task.capability];
      if (capability === undefined) {
        throw new InstalledPackageError(
          'local_state_invalid',
          'collection task capability is absent from the immutable package',
        );
      }
      if (
        capability.authentication.mode === 'none' ||
        capability.authentication.authentication_contract_id !==
          authentication.authentication_contract_id
      ) {
        throw new InstalledPackageError(
          'local_state_invalid',
          'collection task capability does not share its authentication realm',
        );
      }
      return capability;
    });
    if (selectedName === undefined) {
      if (taskCapabilities.some((capability) => capability.authentication.mode === 'required')) {
        throw new ConsumerRunSessionError(
          'session_required',
          'this collection requires a selected local session',
        );
      }
      return undefined;
    }
    const contract =
      resolved.package.authentication_contracts[authentication.authentication_contract_id];
    if (contract === undefined) {
      throw new InstalledPackageError(
        'local_state_invalid',
        'authentication contract is absent from the immutable package',
      );
    }
    const selector = {
      package_id: resolved.installed.package_id,
      authentication_contract_id: authentication.authentication_contract_id,
      session_name: selectedName,
    };
    let leased = false;
    try {
      const pointer = this.sessions.claimRunLease(selector, runId);
      leased = true;
      const expectedContractDigest = calculateAuthenticationContractDigest(contract);
      if (pointer.authentication_contract_digest !== expectedContractDigest) {
        throw new ConsumerRunSessionError(
          'session_invalid',
          'local session does not match the immutable authentication contract',
        );
      }
      const local = this.sessions.read(selector);
      if (
        local.pointer.generation !== pointer.generation ||
        local.pointer.state_digest !== pointer.state_digest ||
        local.pointer.authentication_contract_digest !== pointer.authentication_contract_digest ||
        local.pointer.lease?.owner_id !== runId ||
        local.pointer.lease.base_generation !== pointer.generation
      ) {
        throw new ConsumerRunSessionError(
          'session_invalid',
          'local session lease does not bind the selected generation',
        );
      }
      return {
        selector,
        binding: {
          reference: {
            authentication_contract_id: pointer.authentication_contract_id,
            session_name: pointer.session_name,
            generation: pointer.generation,
            state_digest: pointer.state_digest,
            authentication_contract_digest: pointer.authentication_contract_digest,
          },
          browser_storage_state: local.state,
        },
      };
    } catch (error) {
      if (leased) this.sessions.releaseRunLease(selector, runId);
      if (error instanceof ConsumerRunSessionError) throw error;
      if (error instanceof SessionStoreError) {
        let code: ConsumerRunSessionError['code'] = 'session_invalid';
        if (error.code === 'session_not_found') code = 'session_required';
        else if (error.code === 'session_in_use') code = 'session_in_use';
        throw new ConsumerRunSessionError(code, 'local session cannot be used for this run');
      }
      throw error;
    }
  }

  private attachResumeSession(
    meta: RunMetaV1,
    toolPackage: ReturnType<typeof parsePublicToolPackage>,
    capability: PublicReadCapabilityV1,
    runId: string,
  ): AttachedRunSessionV1 | undefined {
    const reference = meta.session;
    if (reference === undefined) return undefined;
    const authentication = capability.authentication;
    if (
      authentication.mode === 'none' ||
      authentication.authentication_contract_id !== reference.authentication_contract_id
    ) {
      throw new InstalledPackageError(
        'local_state_invalid',
        'immutable run session does not match its selected capability realm',
      );
    }
    const contract = toolPackage.authentication_contracts[reference.authentication_contract_id];
    if (
      contract === undefined ||
      calculateAuthenticationContractDigest(contract) !== reference.authentication_contract_digest
    ) {
      throw new InstalledPackageError(
        'local_state_invalid',
        'immutable run session does not match its authentication contract',
      );
    }
    const selector = {
      package_id: meta.artifact.package_id,
      authentication_contract_id: reference.authentication_contract_id,
      session_name: reference.session_name,
    };
    let local;
    try {
      local = this.sessions.read(selector);
    } catch (error) {
      if (error instanceof SessionStoreError) {
        throw new ConsumerRunSessionError(
          error.code === 'session_in_use' ? 'session_in_use' : 'session_invalid',
          'session pinned by this run is unavailable',
        );
      }
      throw error;
    }
    if (
      local.pointer.generation !== reference.generation ||
      local.pointer.state_digest !== reference.state_digest ||
      local.pointer.authentication_contract_digest !== reference.authentication_contract_digest ||
      local.pointer.lease?.owner_id !== runId ||
      local.pointer.lease.base_generation !== reference.generation
    ) {
      throw new ConsumerRunSessionError(
        local.pointer.lease === null ? 'session_invalid' : 'session_in_use',
        'session lease does not match immutable run metadata',
      );
    }
    return { selector, binding: { reference, browser_storage_state: local.state } };
  }

  private releaseAttachedSession(session: AttachedRunSessionV1 | undefined, runId: string): void {
    if (session === undefined) return;
    this.sessions.releaseRunLease(session.selector, runId);
  }
}
