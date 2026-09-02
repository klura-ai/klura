import { PublicContractError, PUBLIC_CONTRACT_LIMITS } from '../../public/contracts/common';
import {
  calculateCollectionContractDigest,
  type CsvColumnV1,
} from '../../public/contracts/collection';
import { parseStrictJson } from '../../public/contracts/json';
import { parsePublicToolPackage } from '../../public/contracts/package';
import { type JournalEventV1, type RunIdV1 } from './journal';
import { appendEmergencyJournalFrame } from './journal-emergency';
import { partialOutputPath } from './output';
import {
  FileRunOutputSinkV1,
  openFileRunOutputSink,
  recoverPreparedFileOutput,
  RunOutputSinkError,
} from './output-sink';
import {
  createTerminalDescriptor,
  publishFileOutput,
  terminalJournalEvent,
} from './output-finalization';
import { recoverRunState, RunRecoveryError, type RecoveredRunStateV1 } from './recovery';
import { RunStoreV1, type RunMetaEnvelopeV1 } from './run-store';
import { PackageStoreV1 } from '../store/package-store';

export type StartupRunRecoveryV1 =
  | { run_id: RunIdV1; kind: 'interrupted' | 'already_interrupted' | 'terminal' | 'cancelled' }
  | { run_id: RunIdV1; kind: 'quarantined' };

/** Marks valid unfinished runs as interrupted before the consumer daemon accepts work. */
export function interruptUnfinishedRunsAtStartup(home: string): StartupRunRecoveryV1[] {
  const store = new RunStoreV1(home);
  const results: StartupRunRecoveryV1[] = [];
  for (const runId of store.listRunIds()) {
    try {
      const meta = store.read(runId).payload;
      const recovered = recoverRunState(store, runId);
      if (recovered.terminal) {
        results.push({ run_id: runId, kind: 'terminal' });
        continue;
      }
      if (recovered.output_finalization !== null) {
        completePreparedOutput(store, runId, meta, recovered);
        results.push({ run_id: runId, kind: 'terminal' });
        continue;
      }
      if (recovered.cancellation_requested) {
        completeCancelledRun(store, runId, meta, recovered);
        results.push({ run_id: runId, kind: 'cancelled' });
        continue;
      }
      if (recovered.interrupted) {
        results.push({ run_id: runId, kind: 'already_interrupted' });
        continue;
      }
      appendEmergencyJournalFrame(
        runId,
        store.journalPath(runId),
        meta.effective_bounds.policy.durable.max_journal_bytes,
        {
          sequence: recovered.last_sequence,
          execution_epoch: recovered.last_execution_epoch,
          previous_digest: recovered.last_frame_digest,
          maximum_journal_frames: meta.effective_bounds.policy.durable.max_journal_frames,
        },
        { kind: 'interrupted', reason: 'daemon_stopped' },
      );
      results.push({ run_id: runId, kind: 'interrupted' });
    } catch (error) {
      if (error instanceof RunRecoveryError || error instanceof PublicContractError) {
        results.push({ run_id: runId, kind: 'quarantined' });
        continue;
      }
      throw error;
    }
  }
  return results;
}

function completeCancelledRun(
  store: RunStoreV1,
  runId: RunIdV1,
  meta: RunMetaEnvelopeV1['payload'],
  recovered: RecoveredRunStateV1,
): void {
  const append = createRecoveryAppender(store, runId, meta, recovered);
  const resultKind = recovered.summary.items_emitted > 0 ? 'scrape_partial' : 'scrape_failure';
  if (resultKind === 'scrape_failure' || meta.output.kind === 'inline') {
    const descriptor = createTerminalDescriptor(
      { summary: recovered.summary },
      resultKind,
      'cancelled',
      null,
    );
    append(terminalJournalEvent(descriptor));
    return;
  }
  let sink: FileRunOutputSinkV1 | null = null;
  try {
    sink = openFileRunOutputSink(
      store,
      meta.output,
      runId,
      meta.output.format === 'csv' ? resolveRunCsvColumns(store.paths.home, meta) : null,
      meta.effective_bounds.policy,
      true,
    );
    if (sink === null) throw new RunRecoveryError('file run did not create an output sink');
    const descriptor = createTerminalDescriptor(
      { summary: recovered.summary },
      'scrape_partial',
      'cancelled',
      sink,
    );
    publishFileOutput({ sink, descriptor, append_emergency: append });
    append(terminalJournalEvent(descriptor));
  } catch (error) {
    if (!(error instanceof RunOutputSinkError)) throw error;
    sink?.discard();
    const descriptor = createTerminalDescriptor(
      { summary: recovered.summary },
      'scrape_partial',
      'output_sink_failure',
      null,
    );
    append(terminalJournalEvent(descriptor));
  }
}

function createRecoveryAppender(
  store: RunStoreV1,
  runId: RunIdV1,
  meta: RunMetaEnvelopeV1['payload'],
  recovered: RecoveredRunStateV1,
): (
  event: Extract<JournalEventV1, { kind: 'output_prepared' | 'output_committed' | 'terminal' }>,
) => void {
  let sequence = recovered.last_sequence;
  let previousFrameDigest = recovered.last_frame_digest;
  return (event) => {
    const appended = appendEmergencyJournalFrame(
      runId,
      store.journalPath(runId),
      meta.effective_bounds.policy.durable.max_journal_bytes,
      {
        sequence,
        execution_epoch: recovered.last_execution_epoch,
        previous_digest: previousFrameDigest,
        maximum_journal_frames: meta.effective_bounds.policy.durable.max_journal_frames,
      },
      event,
    );
    sequence = appended.body.sequence;
    previousFrameDigest = appended.digest;
  };
}

function resolveRunCsvColumns(
  home: string,
  meta: RunMetaEnvelopeV1['payload'],
): readonly CsvColumnV1[] | null {
  const artifact = meta.artifact;
  const packageStore = new PackageStoreV1(home);
  const toolPackage = parsePublicToolPackage(
    parseStrictJson(
      packageStore.readArtifact(artifact.package_digest),
      'stored_package',
      PUBLIC_CONTRACT_LIMITS.packageBytes,
      PUBLIC_CONTRACT_LIMITS.maxPackageDepth,
    ),
  );
  if (toolPackage.package_id !== artifact.package_id || toolPackage.version !== artifact.version) {
    throw new RunRecoveryError('immutable run artifact does not match its stored package identity');
  }
  const capability = toolPackage.capabilities[artifact.capability];
  if (capability?.collection === null || capability === undefined) {
    throw new RunRecoveryError('immutable run collection is unavailable for output recovery');
  }
  if (
    calculateCollectionContractDigest(capability.collection) !== artifact.collection_contract_digest
  ) {
    throw new RunRecoveryError('immutable run collection does not match its stored package');
  }
  return capability.collection.csv_columns;
}

function completePreparedOutput(
  store: RunStoreV1,
  runId: RunIdV1,
  meta: RunMetaEnvelopeV1['payload'],
  recovered: RecoveredRunStateV1,
): void {
  const finalization = recovered.output_finalization;
  if (finalization === null) throw new RunRecoveryError('prepared output is unavailable');
  if (meta.output.kind !== 'file') {
    throw new RunRecoveryError('prepared output conflicts with inline run metadata');
  }
  const descriptor = finalization.prepared.terminal_descriptor;
  if (descriptor.output.kind !== 'file') {
    throw new RunRecoveryError('prepared output has no file terminal descriptor');
  }
  const expectedPath = descriptor.output.partial
    ? partialOutputPath(meta.output, runId)
    : meta.output.requested_path;
  if (descriptor.output.path !== expectedPath) {
    throw new RunRecoveryError('prepared output path conflicts with immutable run metadata');
  }
  recoverPreparedFileOutput(meta.output, runId, {
    path: descriptor.output.path,
    byte_length: finalization.prepared.byte_length,
    content_digest: finalization.prepared.content_digest,
  });
  const append = createRecoveryAppender(store, runId, meta, recovered);
  if (!finalization.committed) {
    append({
      kind: 'output_committed',
      content_digest: finalization.prepared.content_digest,
      byte_length: finalization.prepared.byte_length,
      terminal_descriptor_digest: finalization.prepared.terminal_descriptor_digest,
    });
  }
  append({
    kind: 'terminal',
    descriptor,
    descriptor_digest: finalization.prepared.terminal_descriptor_digest,
  });
}
