import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseBoundedRecord,
  parseExactRecord,
  parseInteger,
  parseString,
  PublicContractError,
} from '../public/contracts/common';
import { canonicalJson, parseStrictJson, type JsonValueV1 } from '../public/contracts/json';

/**
 * Scheduler-local traffic policy. Public package policies satisfy this shape;
 * trusted local execution also uses it for HTTP(S) origins outside a package.
 */
export interface OriginSchedulerTrafficPolicyV1 {
  origin: string;
  max_concurrency: number;
  requests_per_second: number;
  burst: number;
  min_delay_ms: number;
  max_redirect_hops: number;
  circuit_breaker: {
    transient_failure_threshold: number;
    transient_window_ms: number;
    cooldown_ms: number;
  };
}

export type SchedulerCompletionV1 = 'success' | 'transient_failure' | 'neutral';

export interface OriginSchedulerPermitV1 {
  release(completion: SchedulerCompletionV1): void;
}

export interface OriginSchedulerAdmissionOptionsV1 {
  signal?: AbortSignal;
  workload_id?: string;
}

export interface OriginSchedulerOptionsV1 {
  state_path?: string;
  now?: () => number;
}

export interface OriginSchedulerOriginStatusV1 {
  origin: string;
  active_requests: number;
  queued_requests: number;
  queued_workloads: number;
  blocker: 'concurrency' | 'rate_limit' | 'minimum_delay' | 'circuit_open' | null;
  next_admission_at_ms: number | null;
  circuit_open_until_ms: number | null;
}

export interface OriginSchedulerSnapshotV1 {
  scheduler_snapshot_schema_version: 1;
  origins: OriginSchedulerOriginStatusV1[];
}

export class OriginSchedulerError extends PublicContractError {
  constructor(
    public readonly code: 'origin_circuit_open' | 'cancelled',
    message: string,
  ) {
    super('origin_scheduler', message);
    this.name = 'OriginSchedulerError';
  }
}

export class OriginSchedulerV1 {
  private readonly entries = new Map<string, OriginEntryV1>();
  private readonly recovered: Map<string, PersistedOriginStateV1>;
  private readonly now: () => number;
  private readonly statePath: string | null;

  constructor(options: OriginSchedulerOptionsV1 = {}) {
    this.now = options.now ?? Date.now;
    this.statePath = options.state_path ?? null;
    this.recovered =
      this.statePath === null
        ? new Map<string, PersistedOriginStateV1>()
        : readPersistedState(this.statePath);
  }

  async acquire(
    policy: OriginSchedulerTrafficPolicyV1,
    options: OriginSchedulerAdmissionOptionsV1 = {},
  ): Promise<OriginSchedulerPermitV1> {
    const signal = options.signal;
    if (signal?.aborted) {
      throw new OriginSchedulerError('cancelled', 'caller cancelled before scheduler admission');
    }
    const workloadId = parseWorkloadId(options.workload_id);
    const entry = this.getEntry(policy);
    return new Promise<OriginSchedulerPermitV1>((resolve, reject) => {
      const queued: QueuedAdmissionV1 = {
        resolve,
        reject,
        signal,
        workload_id: workloadId,
        abort: () => undefined,
      };
      const abort = (): void => {
        this.removeQueued(entry, queued);
        reject(
          new OriginSchedulerError(
            'cancelled',
            'caller cancelled while queued for origin admission',
          ),
        );
      };
      queued.abort = abort;
      signal?.addEventListener('abort', abort, { once: true });
      this.enqueue(entry, queued);
      this.drain(entry);
    });
  }

  /** Returns structural queue state without sending traffic or admitting work. */
  snapshot(): OriginSchedulerSnapshotV1 {
    const now = this.now();
    const origins = new Set<string>([...this.entries.keys(), ...this.recovered.keys()]);
    const statuses: OriginSchedulerOriginStatusV1[] = [];
    for (const origin of origins) {
      const entry = this.entries.get(origin);
      const recovered = this.recovered.get(origin);
      const status =
        entry === undefined
          ? recoveredStatus(origin, recovered, now)
          : entryStatus(origin, entry, now);
      if (status !== null) statuses.push(status);
    }
    statuses.sort((left, right) => left.origin.localeCompare(right.origin));
    return { scheduler_snapshot_schema_version: 1, origins: statuses };
  }

  private getEntry(policy: OriginSchedulerTrafficPolicyV1): OriginEntryV1 {
    const existing = this.entries.get(policy.origin);
    if (existing) {
      existing.policy = mergeConservatively(existing.policy, policy);
      existing.tokens = Math.min(existing.tokens, existing.policy.burst);
      return existing;
    }
    const now = this.now();
    const recovered = this.recovered.get(policy.origin);
    const failures = (recovered?.transient_failures ?? []).filter(
      (timestamp) => timestamp >= now - policy.circuit_breaker.transient_window_ms,
    );
    const circuitOpenUntil = recovered?.circuit_open_until ?? 0;
    if (circuitOpenUntil <= now && failures.length === 0) this.recovered.delete(policy.origin);
    const entry: OriginEntryV1 = {
      policy,
      queues: new Map(),
      workload_order: [],
      next_workload_index: 0,
      active: 0,
      tokens: policy.burst,
      last_refill_at: now,
      next_admission_at: now,
      transient_failures: failures,
      circuit_open_until: circuitOpenUntil > now ? circuitOpenUntil : 0,
      timer: null,
    };
    this.entries.set(policy.origin, entry);
    return entry;
  }

  private drain(entry: OriginEntryV1): void {
    const now = this.now();
    this.refill(entry, now);
    this.dropCancelled(entry);
    if (queuedCount(entry) === 0) return;
    if (entry.circuit_open_until > now) {
      this.rejectQueuedForOpenCircuit(entry);
      return;
    }
    while (
      queuedCount(entry) > 0 &&
      entry.active < entry.policy.max_concurrency &&
      entry.tokens >= 1 &&
      now >= entry.next_admission_at
    ) {
      const queued = this.dequeueRoundRobin(entry);
      if (!queued) break;
      queued.signal?.removeEventListener('abort', queued.abort);
      entry.active += 1;
      entry.tokens -= 1;
      entry.next_admission_at = now + entry.policy.min_delay_ms;
      let released = false;
      queued.resolve({
        release: (completion): void => {
          if (released) return;
          released = true;
          entry.active -= 1;
          this.recordCompletion(entry, completion);
          this.drain(entry);
        },
      });
    }
    this.scheduleNextAdmission(entry);
  }

  private enqueue(entry: OriginEntryV1, queued: QueuedAdmissionV1): void {
    let queue = entry.queues.get(queued.workload_id);
    if (!queue) {
      queue = [];
      entry.queues.set(queued.workload_id, queue);
      entry.workload_order.push(queued.workload_id);
    }
    queue.push(queued);
  }

  private dequeueRoundRobin(entry: OriginEntryV1): QueuedAdmissionV1 | null {
    while (entry.workload_order.length > 0) {
      const index = entry.next_workload_index % entry.workload_order.length;
      const workloadId = entry.workload_order[index];
      if (!workloadId) return null;
      entry.next_workload_index = (index + 1) % entry.workload_order.length;
      const queue = entry.queues.get(workloadId);
      const queued = queue?.shift();
      if (!queued) {
        this.removeWorkload(entry, workloadId);
        continue;
      }
      if ((queue?.length ?? 0) === 0) this.removeWorkload(entry, workloadId);
      return queued;
    }
    return null;
  }

  private removeQueued(entry: OriginEntryV1, queued: QueuedAdmissionV1): void {
    const queue = entry.queues.get(queued.workload_id);
    if (!queue) return;
    const index = queue.indexOf(queued);
    if (index < 0) return;
    queue.splice(index, 1);
    if (queue.length === 0) this.removeWorkload(entry, queued.workload_id);
  }

  private removeWorkload(entry: OriginEntryV1, workloadId: string): void {
    entry.queues.delete(workloadId);
    const index = entry.workload_order.indexOf(workloadId);
    if (index < 0) return;
    entry.workload_order.splice(index, 1);
    if (entry.workload_order.length === 0) {
      entry.next_workload_index = 0;
      return;
    }
    if (index < entry.next_workload_index) entry.next_workload_index -= 1;
    if (entry.next_workload_index >= entry.workload_order.length) {
      entry.next_workload_index = 0;
    }
  }

  private refill(entry: OriginEntryV1, now: number): void {
    const elapsed = Math.max(0, now - entry.last_refill_at);
    entry.last_refill_at = now;
    entry.tokens = Math.min(
      entry.policy.burst,
      entry.tokens + (elapsed * entry.policy.requests_per_second) / 1_000,
    );
  }

  private recordCompletion(entry: OriginEntryV1, completion: SchedulerCompletionV1): void {
    const now = this.now();
    const windowStart = now - entry.policy.circuit_breaker.transient_window_ms;
    entry.transient_failures = entry.transient_failures.filter(
      (timestamp) => timestamp >= windowStart,
    );
    if (completion === 'transient_failure') {
      entry.transient_failures.push(now);
      if (
        entry.transient_failures.length >= entry.policy.circuit_breaker.transient_failure_threshold
      ) {
        entry.circuit_open_until = now + entry.policy.circuit_breaker.cooldown_ms;
        entry.transient_failures = [];
      }
    }
    this.persist();
  }

  private scheduleNextAdmission(entry: OriginEntryV1): void {
    if (queuedCount(entry) === 0 || entry.circuit_open_until > this.now()) return;
    const tokenDelay =
      entry.tokens >= 1
        ? 0
        : Math.ceil(((1 - entry.tokens) * 1_000) / entry.policy.requests_per_second);
    const wait = Math.max(0, entry.next_admission_at - this.now(), tokenDelay);
    if (wait === 0) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.drain(entry);
    }, wait);
  }

  private rejectQueuedForOpenCircuit(entry: OriginEntryV1): void {
    for (const queued of this.queuedAdmissions(entry)) {
      this.removeQueued(entry, queued);
      queued.signal?.removeEventListener('abort', queued.abort);
      queued.reject(new OriginSchedulerError('origin_circuit_open', 'origin circuit is open'));
    }
  }

  private dropCancelled(entry: OriginEntryV1): void {
    for (const queued of this.queuedAdmissions(entry)) {
      if (!queued.signal?.aborted) continue;
      this.removeQueued(entry, queued);
      queued.signal.removeEventListener('abort', queued.abort);
      queued.reject(
        new OriginSchedulerError('cancelled', 'caller cancelled while queued for origin admission'),
      );
    }
  }

  private queuedAdmissions(entry: OriginEntryV1): QueuedAdmissionV1[] {
    return [...entry.queues.values()].flatMap((queue) => [...queue]);
  }

  private persist(): void {
    if (this.statePath === null) return;
    const now = this.now();
    const states = new Map(this.recovered);
    for (const [origin, entry] of this.entries) {
      const state: PersistedOriginStateV1 = {
        circuit_open_until: entry.circuit_open_until,
        transient_failures: entry.transient_failures,
      };
      if (state.circuit_open_until > now || state.transient_failures.length > 0) {
        states.set(origin, state);
      } else {
        states.delete(origin);
      }
    }
    writePersistedState(this.statePath, states);
  }
}

interface OriginEntryV1 {
  policy: OriginSchedulerTrafficPolicyV1;
  queues: Map<string, QueuedAdmissionV1[]>;
  workload_order: string[];
  next_workload_index: number;
  active: number;
  tokens: number;
  last_refill_at: number;
  next_admission_at: number;
  transient_failures: number[];
  circuit_open_until: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface QueuedAdmissionV1 {
  resolve: (permit: OriginSchedulerPermitV1) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  workload_id: string;
  abort: () => void;
}

interface PersistedOriginStateV1 {
  circuit_open_until: number;
  transient_failures: number[];
}

function entryStatus(
  origin: string,
  entry: OriginEntryV1,
  now: number,
): OriginSchedulerOriginStatusV1 | null {
  const queuedRequests = queuedCount(entry);
  const circuitOpen = entry.circuit_open_until > now;
  if (entry.active === 0 && queuedRequests === 0 && !circuitOpen) return null;
  const tokens = Math.min(
    entry.policy.burst,
    entry.tokens +
      (Math.max(0, now - entry.last_refill_at) * entry.policy.requests_per_second) / 1_000,
  );
  let blocker: OriginSchedulerOriginStatusV1['blocker'] = null;
  if (circuitOpen) {
    blocker = 'circuit_open';
  } else if (queuedRequests > 0 && entry.active >= entry.policy.max_concurrency) {
    blocker = 'concurrency';
  } else if (queuedRequests > 0 && tokens < 1) {
    blocker = 'rate_limit';
  } else if (queuedRequests > 0 && entry.next_admission_at > now) {
    blocker = 'minimum_delay';
  }
  let nextAdmissionAt: number | null = null;
  if (blocker === 'circuit_open') {
    nextAdmissionAt = entry.circuit_open_until;
  } else if (blocker === 'rate_limit') {
    nextAdmissionAt = now + Math.ceil(((1 - tokens) * 1_000) / entry.policy.requests_per_second);
  } else if (blocker === 'minimum_delay') {
    nextAdmissionAt = entry.next_admission_at;
  }
  return {
    origin,
    active_requests: entry.active,
    queued_requests: queuedRequests,
    queued_workloads: entry.queues.size,
    blocker,
    next_admission_at_ms: nextAdmissionAt,
    circuit_open_until_ms: circuitOpen ? entry.circuit_open_until : null,
  };
}

function recoveredStatus(
  origin: string,
  recovered: PersistedOriginStateV1 | undefined,
  now: number,
): OriginSchedulerOriginStatusV1 | null {
  if (recovered === undefined || recovered.circuit_open_until <= now) return null;
  return {
    origin,
    active_requests: 0,
    queued_requests: 0,
    queued_workloads: 0,
    blocker: 'circuit_open',
    next_admission_at_ms: recovered.circuit_open_until,
    circuit_open_until_ms: recovered.circuit_open_until,
  };
}

function queuedCount(entry: OriginEntryV1): number {
  let count = 0;
  for (const queue of entry.queues.values()) count += queue.length;
  return count;
}

function parseWorkloadId(value: string | undefined): string {
  if (value === undefined) return 'foreground';
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 256) {
    throw new PublicContractError(
      'origin_scheduler.workload_id',
      'must be a non-empty UTF-8 string',
    );
  }
  return value;
}

function readPersistedState(statePath: string): Map<string, PersistedOriginStateV1> {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(statePath);
  } catch (error) {
    if (isMissingFile(error)) return new Map();
    throw new PublicContractError('scheduler_state', 'could not read persistent scheduler state');
  }
  try {
    const record = parseExactRecord(
      parseStrictJson(bytes, 'scheduler_state', 256 * 1024, 12),
      'scheduler_state',
      ['scheduler_state_schema_version', 'origins'],
    );
    if (record.scheduler_state_schema_version !== 1) {
      throw new PublicContractError('scheduler_state.scheduler_state_schema_version', 'must be 1');
    }
    const origins = parseBoundedRecord(record.origins, 'scheduler_state.origins', 1_024);
    const states = new Map<string, PersistedOriginStateV1>();
    for (const [origin, value] of Object.entries(origins)) {
      const parsedOrigin = parseHttpOrigin(origin, `scheduler_state.origins.${origin}`);
      if (parsedOrigin !== origin) {
        throw new PublicContractError(
          `scheduler_state.origins.${origin}`,
          'must use canonical origin',
        );
      }
      const entry = parseExactRecord(value, `scheduler_state.origins.${origin}`, [
        'circuit_open_until',
        'transient_failures',
      ]);
      if (!Array.isArray(entry.transient_failures) || entry.transient_failures.length > 10) {
        throw new PublicContractError(
          `scheduler_state.origins.${origin}.transient_failures`,
          'must contain at most ten timestamps',
        );
      }
      const transientFailures = entry.transient_failures.map((timestamp, index) =>
        parseInteger(
          timestamp,
          `scheduler_state.origins.${origin}.transient_failures[${index}]`,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      );
      for (let index = 1; index < transientFailures.length; index += 1) {
        const previous = transientFailures[index - 1];
        const current = transientFailures[index];
        if (previous === undefined || current === undefined || current < previous) {
          throw new PublicContractError(
            `scheduler_state.origins.${origin}.transient_failures`,
            'must be in ascending order',
          );
        }
      }
      states.set(origin, {
        circuit_open_until: parseInteger(
          entry.circuit_open_until,
          `scheduler_state.origins.${origin}.circuit_open_until`,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        transient_failures: transientFailures,
      });
    }
    return states;
  } catch (error) {
    if (error instanceof PublicContractError) throw error;
    throw new PublicContractError('scheduler_state', 'contains invalid persistent scheduler state');
  }
}

function writePersistedState(
  statePath: string,
  states: ReadonlyMap<string, PersistedOriginStateV1>,
): void {
  const origins: Record<string, JsonValueV1> = {};
  for (const [origin, state] of [...states.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    origins[origin] = {
      circuit_open_until: state.circuit_open_until,
      transient_failures: [...state.transient_failures].sort((left, right) => left - right),
    };
  }
  const bytes = Buffer.from(canonicalJson({ scheduler_state_schema_version: 1, origins }), 'utf8');
  const directory = path.dirname(statePath);
  const temporary = path.join(directory, `.${path.basename(statePath)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, statePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (error instanceof PublicContractError) throw error;
    throw new PublicContractError('scheduler_state', 'could not persist scheduler state');
  } finally {
    if (fd !== null) fs.closeSync(fd);
    removeTemporaryIfPresent(temporary);
  }
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}

function removeTemporaryIfPresent(temporary: string): void {
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw new PublicContractError(
      'scheduler_state',
      'could not clean up persistent scheduler state',
    );
  }
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function mergeConservatively(
  left: OriginSchedulerTrafficPolicyV1,
  right: OriginSchedulerTrafficPolicyV1,
): OriginSchedulerTrafficPolicyV1 {
  if (left.origin !== right.origin) {
    throw new PublicContractError('origin_scheduler', 'cannot merge different origins');
  }
  return {
    origin: left.origin,
    max_concurrency: Math.min(left.max_concurrency, right.max_concurrency),
    requests_per_second: Math.min(left.requests_per_second, right.requests_per_second),
    burst: Math.min(left.burst, right.burst),
    min_delay_ms: Math.max(left.min_delay_ms, right.min_delay_ms),
    max_redirect_hops: Math.min(left.max_redirect_hops, right.max_redirect_hops),
    circuit_breaker: {
      transient_failure_threshold: Math.min(
        left.circuit_breaker.transient_failure_threshold,
        right.circuit_breaker.transient_failure_threshold,
      ),
      transient_window_ms: Math.max(
        left.circuit_breaker.transient_window_ms,
        right.circuit_breaker.transient_window_ms,
      ),
      cooldown_ms: Math.max(left.circuit_breaker.cooldown_ms, right.circuit_breaker.cooldown_ms),
    },
  };
}

function parseHttpOrigin(value: unknown, field: string): string {
  const text = parseString(value, field);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PublicContractError(field, 'must be an HTTP(S) origin');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    text !== url.origin
  ) {
    throw new PublicContractError(field, 'must be a canonical HTTP(S) origin');
  }
  return text;
}
