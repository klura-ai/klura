import {
  parseExactRecord,
  parseInteger,
  parseRfc3339Instant,
  parseString,
  PublicContractError,
} from '../public/contracts/common';
import fs from 'node:fs';
import {
  inspectStoredRun,
  RunInspectionError,
  type StoredRunInspectionV1,
} from './scrape/inspection';
import { canonicalJson, parseStrictJson, type JsonValueV1 } from '../public/contracts/json';
import { parseRunId, type RunIdV1 } from './scrape/journal';
import {
  readCommittedRunItemsPage,
  type CommittedRunItemV1,
  type CommittedRunItemsPageV1,
  type ReadCommittedRunItemsPageOptionsV1,
} from './scrape/result-reader';
import { RunStoreV1 } from './scrape/run-store';
import { PackageStoreV1 } from './store/package-store';

const RUN_LIST_CURSOR_MAXIMUM_BYTES_V1 = 1_024;
const RUN_LIST_PAGE_DEFAULT_LIMIT_V1 = 25;
const RUN_LIST_PAGE_MAXIMUM_LIMIT_V1 = 100;
const RUN_LIST_ADAPTER_MAXIMUM_BYTES_V1 = 20_480;

export interface QuarantinedRunSummaryV1 {
  kind: 'quarantined_run';
  run_id: RunIdV1;
  created_at: string;
  code: 'journal_corrupt';
}

export type ListedRunV1 = StoredRunInspectionV1 | QuarantinedRunSummaryV1;

export type DiscardRunResultV1 =
  | { kind: 'discarded'; run_id: RunIdV1 }
  | { kind: 'not_quarantined'; run_id: RunIdV1 };

export interface ListedRunsPageV1 {
  items: ListedRunV1[];
  next_cursor: string | null;
}

export type RunItemStreamEventV1 =
  | { kind: 'item'; item: CommittedRunItemV1 }
  | { kind: 'end'; lifecycle: 'terminal' | 'interrupted'; last_sequence: number };

export interface RunStateWaitResultV1 {
  changed: boolean;
  snapshot: StoredRunInspectionV1;
}

interface RunsCursorV1 {
  schema_version: 1;
  operation: 'runs';
  created_at: string;
  run_id: RunIdV1;
}

export class RunListError extends PublicContractError {
  constructor(
    public readonly code: 'invalid_options' | 'cursor_invalid' | 'output_too_large_for_adapter',
    message: string,
  ) {
    super('runs.list', message);
    this.name = 'RunListError';
  }
}

/** Provides local run inspection and explicit removal of corrupted journals. */
export class ConsumerRunServiceV1 {
  private readonly runs: RunStoreV1;
  readonly home: string;

  constructor(store = new PackageStoreV1()) {
    this.home = store.paths.home;
    this.runs = new RunStoreV1(store.paths.home);
  }

  show(runId: RunIdV1): StoredRunInspectionV1 {
    return inspectStoredRun(this.runs, runId);
  }

  private listAll(): ListedRunV1[] {
    const listed: ListedRunV1[] = [];
    for (const runId of this.runs.listRunIds()) {
      const meta = this.runs.read(runId);
      try {
        listed.push(inspectStoredRun(this.runs, runId));
      } catch (error) {
        if (!(error instanceof RunInspectionError)) throw error;
        listed.push({
          kind: 'quarantined_run',
          run_id: runId,
          created_at: meta.payload.created_at,
          code: 'journal_corrupt',
        });
      }
    }
    return listed.sort((left, right) => {
      const leftCreatedAt = runCreatedAt(left);
      const rightCreatedAt = runCreatedAt(right);
      return leftCreatedAt.localeCompare(rightCreatedAt) || left.run_id.localeCompare(right.run_id);
    });
  }

  listPage(input: unknown): ListedRunsPageV1 {
    const options = parseRunListOptions(input);
    const cursor = parseRunsCursor(options.cursor);
    const available = this.listAll().filter(
      (run) => cursor === null || compareRunSortKey(run, cursor) > 0,
    );
    return buildRunPage(available, options.limit);
  }

  items(runId: RunIdV1, options: ReadCommittedRunItemsPageOptionsV1 = {}): CommittedRunItemsPageV1 {
    this.show(runId);
    return readCommittedRunItemsPage(this.runs, runId, options);
  }

  /**
   * Waits once for a durable journal advance. The filesystem watcher is the
   * event source; the optional timeout only bounds this one observer.
   */
  async waitState(
    runId: RunIdV1,
    options: { after_state_version?: number; wait_timeout_ms?: number; signal?: AbortSignal } = {},
  ): Promise<RunStateWaitResultV1> {
    const afterStateVersion =
      options.after_state_version === undefined
        ? undefined
        : parseInteger(
            options.after_state_version,
            'run.wait.after_state_version',
            0,
            Number.MAX_SAFE_INTEGER,
          );
    const waitTimeoutMs =
      options.wait_timeout_ms === undefined
        ? 20_000
        : parseInteger(options.wait_timeout_ms, 'run.wait.wait_timeout_ms', 0, 25_000);
    const initial = this.show(runId);
    if (
      afterStateVersion === undefined ||
      initial.state_version !== afterStateVersion ||
      isWaitTerminal(initial)
    ) {
      return { changed: true, snapshot: initial };
    }
    const watcher = new JournalChangeWatcherV1(this.runs.journalPath(runId));
    const timeout = new AbortController();
    const merged = mergeAbortSignals(options.signal, timeout.signal);
    const timer = setTimeout(() => {
      timeout.abort();
    }, waitTimeoutMs);
    timer.unref();
    try {
      for (;;) {
        const snapshot = this.show(runId);
        if (snapshot.state_version !== afterStateVersion || isWaitTerminal(snapshot)) {
          return { changed: true, snapshot };
        }
        const event = await watcher.next({ signal: merged.signal });
        if (event === 'aborted') {
          if (options.signal?.aborted) throw abortError();
          if (timeout.signal.aborted) {
            const snapshot = this.show(runId);
            return {
              changed: snapshot.state_version !== afterStateVersion || isWaitTerminal(snapshot),
              snapshot,
            };
          }
          throw abortError();
        }
      }
    } finally {
      clearTimeout(timer);
      merged.dispose();
      watcher.close();
    }
  }

  /** Streams committed items when their journal frames become durable. */
  async *followItems(
    runId: RunIdV1,
    options: { after_sequence?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<RunItemStreamEventV1> {
    let afterSequence = parseInteger(
      options.after_sequence ?? 0,
      'run.items.after_sequence',
      0,
      1e9,
    );
    this.show(runId);
    const watcher = new JournalChangeWatcherV1(this.runs.journalPath(runId));
    try {
      while (!options.signal?.aborted) {
        let page: CommittedRunItemsPageV1;
        do {
          page = this.items(runId, { after_sequence: afterSequence, limit: 100 });
          for (const item of page.items) {
            afterSequence = item.sequence;
            yield { kind: 'item', item };
          }
        } while (page.next_after_sequence !== null);
        const inspection = this.show(runId);
        if (
          inspection.lifecycle.kind === 'terminal' ||
          inspection.lifecycle.kind === 'interrupted'
        ) {
          yield {
            kind: 'end',
            lifecycle: inspection.lifecycle.kind,
            last_sequence: afterSequence,
          };
          return;
        }
        if ((await watcher.next({ signal: options.signal })) !== 'changed') return;
      }
    } finally {
      watcher.close();
    }
  }

  discard(runId: RunIdV1): DiscardRunResultV1 {
    try {
      this.show(runId);
      return { kind: 'not_quarantined', run_id: runId };
    } catch (error) {
      if (!(error instanceof RunInspectionError)) throw error;
      this.runs.discard(runId);
      return { kind: 'discarded', run_id: runId };
    }
  }
}

class JournalChangeWatcherV1 {
  private changed = false;
  private failure: Error | null = null;
  private waiter: (() => void) | null = null;
  private readonly watcher: fs.FSWatcher;

  constructor(path: string) {
    this.watcher = fs.watch(path, { persistent: false }, () => {
      this.changed = true;
      this.wake();
    });
    this.watcher.once('error', (error) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.wake();
    });
  }

  async next(options: { signal?: AbortSignal } = {}): Promise<'aborted' | 'changed'> {
    const { signal } = options;
    if (signal?.aborted) return 'aborted';
    if (this.failure !== null) throw this.failure;
    if (this.changed) {
      this.changed = false;
      return 'changed';
    }
    return await new Promise<'aborted' | 'changed'>((resolve, reject) => {
      const abort = (): void => {
        finish(undefined, 'aborted');
      };
      const finish = (error?: Error, result: 'aborted' | 'changed' = 'changed'): void => {
        this.waiter = null;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(result);
      };
      this.waiter = (): void => {
        if (this.failure !== null) {
          finish(this.failure);
          return;
        }
        this.changed = false;
        finish(undefined, 'changed');
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (this.failure !== null) {
        finish(this.failure);
      } else if (this.changed) {
        this.waiter();
      }
    });
  }

  close(): void {
    this.waiter = null;
    this.watcher.close();
  }

  private wake(): void {
    this.waiter?.();
  }
}

function isWaitTerminal(snapshot: StoredRunInspectionV1): boolean {
  return snapshot.lifecycle.kind === 'terminal' || snapshot.lifecycle.kind === 'interrupted';
}

function abortError(): Error {
  const error = new Error('run state wait was cancelled');
  error.name = 'AbortError';
  return error;
}

function mergeAbortSignals(
  left: AbortSignal | undefined,
  right: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const forward = (): void => {
    controller.abort();
  };
  left?.addEventListener('abort', forward, { once: true });
  right.addEventListener('abort', forward, { once: true });
  if (left?.aborted || right.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: (): void => {
      left?.removeEventListener('abort', forward);
      right.removeEventListener('abort', forward);
    },
  };
}

function runCreatedAt(run: ListedRunV1): string {
  return 'created_at' in run ? run.created_at : run.meta.payload.created_at;
}

function parseRunListOptions(input: unknown): { cursor?: string; limit: number } {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new PublicContractError('runs.list', 'must be an object');
    }
    const record = input as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'cursor' && key !== 'limit') {
        throw new PublicContractError(`runs.list.${key}`, 'is not allowed');
      }
    }
    return {
      cursor:
        record.cursor === undefined
          ? undefined
          : parseString(record.cursor, 'runs.list.cursor', RUN_LIST_CURSOR_MAXIMUM_BYTES_V1),
      limit:
        record.limit === undefined
          ? RUN_LIST_PAGE_DEFAULT_LIMIT_V1
          : parseInteger(record.limit, 'runs.list.limit', 1, RUN_LIST_PAGE_MAXIMUM_LIMIT_V1),
    };
  } catch (error) {
    throw new RunListError('invalid_options', errorMessage(error));
  }
}

function parseRunsCursor(value: string | undefined): RunsCursorV1 | null {
  if (value === undefined) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
      throw new PublicContractError('runs.list.cursor', 'must be unpadded base64url');
    }
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) {
      throw new PublicContractError('runs.list.cursor', 'must be canonical base64url');
    }
    const decoded = parseStrictJson(bytes, 'runs.list.cursor', RUN_LIST_CURSOR_MAXIMUM_BYTES_V1, 4);
    if (canonicalJson(decoded) !== bytes.toString('utf8')) {
      throw new PublicContractError('runs.list.cursor', 'must contain canonical JSON');
    }
    const record = parseExactRecord(decoded, 'runs.list.cursor', [
      'schema_version',
      'operation',
      'created_at',
      'run_id',
    ]);
    if (parseInteger(record.schema_version, 'runs.list.cursor.schema_version', 1, 1) !== 1) {
      throw new PublicContractError('runs.list.cursor.schema_version', 'must be 1');
    }
    if (record.operation !== 'runs') {
      throw new PublicContractError('runs.list.cursor.operation', 'must be "runs"');
    }
    return {
      schema_version: 1,
      operation: 'runs',
      created_at: parseRfc3339Instant(record.created_at, 'runs.list.cursor.created_at'),
      run_id: parseRunId(record.run_id, 'runs.list.cursor.run_id'),
    };
  } catch (error) {
    throw new RunListError('cursor_invalid', errorMessage(error));
  }
}

function buildRunPage(available: ListedRunV1[], requestedLimit: number): ListedRunsPageV1 {
  const items: ListedRunV1[] = [];
  for (const candidate of available) {
    if (items.length === requestedLimit) break;
    const candidateItems = [...items, candidate];
    const hasMore = candidateItems.length < available.length;
    const candidatePage: ListedRunsPageV1 = {
      items: candidateItems,
      next_cursor: hasMore ? encodeRunsCursor(candidate) : null,
    };
    if (
      Buffer.byteLength(canonicalJson(candidatePage as unknown as JsonValueV1), 'utf8') >
      RUN_LIST_ADAPTER_MAXIMUM_BYTES_V1
    ) {
      break;
    }
    items.push(candidate);
  }
  if (items.length === 0 && available.length > 0) {
    throw new RunListError(
      'output_too_large_for_adapter',
      'one run inspection cannot fit the adapter result limit',
    );
  }
  const last = items.at(-1);
  const hasMore = items.length < available.length;
  if (hasMore && last === undefined) {
    throw new RunListError('output_too_large_for_adapter', 'page has no bounded cursor');
  }
  return {
    items,
    next_cursor: hasMore && last !== undefined ? encodeRunsCursor(last) : null,
  };
}

function encodeRunsCursor(run: ListedRunV1): string {
  const cursor: RunsCursorV1 = {
    schema_version: 1,
    operation: 'runs',
    created_at: runCreatedAt(run),
    run_id: run.run_id,
  };
  return Buffer.from(canonicalJson(cursor as unknown as JsonValueV1), 'utf8').toString('base64url');
}

function compareRunSortKey(run: ListedRunV1, cursor: RunsCursorV1): number {
  return (
    runCreatedAt(run).localeCompare(cursor.created_at) || run.run_id.localeCompare(cursor.run_id)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
