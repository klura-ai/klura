import { sha256Digest } from '../../public/contracts/common';
import type { LocalScrapeRunResultV1 } from './run-result';
import type { ExecutionStateV1 } from './run-state';
import {
  calculateTerminalDescriptorDigest,
  type JournalEventV1,
  type RunCompletionStopV1,
  type TerminalRunStopV1,
  type TerminalResultDescriptorV1,
} from './journal';
import { FileRunOutputSinkV1, RunOutputSinkError } from './output-sink';

export class OutputPublicationPendingError extends Error {
  constructor(cause: unknown) {
    super('prepared output could not be finalized in the active process', { cause });
    this.name = 'OutputPublicationPendingError';
  }
}

export function createTerminalDescriptor(
  state: Pick<ExecutionStateV1, 'summary'>,
  resultKind: LocalScrapeRunResultV1['kind'],
  stop: TerminalRunStopV1,
  sink: FileRunOutputSinkV1 | null,
): TerminalResultDescriptorV1 {
  const partial = resultKind === 'scrape_partial';
  return {
    descriptor_schema_version: 1,
    result_kind: resultKind,
    stop,
    summary: { ...state.summary },
    output:
      resultKind === 'scrape_failure'
        ? { kind: 'none' }
        : (sink?.terminalOutput(partial) ?? { kind: 'inline', partial }),
  };
}

export function publishFileOutput(input: {
  sink: FileRunOutputSinkV1 | null;
  descriptor: TerminalResultDescriptorV1;
  append_emergency: (
    event: Extract<JournalEventV1, { kind: 'output_prepared' | 'output_committed' }>,
  ) => void;
}): void {
  if (input.sink === null) return;
  if (input.descriptor.output.kind !== 'file') {
    throw new RunOutputSinkError(
      'output_sink_failure',
      'file sink has no file terminal descriptor',
    );
  }
  const prepared = input.descriptor.output.partial
    ? input.sink.preparePartial()
    : input.sink.prepareComplete();
  if (prepared.path !== input.descriptor.output.path) {
    throw new RunOutputSinkError(
      'output_sink_failure',
      'prepared output path does not match descriptor',
    );
  }
  const descriptorDigest = calculateTerminalDescriptorDigest(input.descriptor);
  input.append_emergency({
    kind: 'output_prepared',
    path_digest: sha256Digest(prepared.path),
    content_digest: prepared.content_digest,
    byte_length: prepared.byte_length,
    terminal_descriptor: input.descriptor,
    terminal_descriptor_digest: descriptorDigest,
  });
  try {
    input.sink.commitPrepared(prepared);
  } catch (error) {
    if (!(error instanceof RunOutputSinkError)) throw error;
    try {
      input.sink.completePrepared(prepared);
    } catch (recoveryError) {
      throw new OutputPublicationPendingError(recoveryError);
    }
  }
  input.append_emergency({
    kind: 'output_committed',
    content_digest: prepared.content_digest,
    byte_length: prepared.byte_length,
    terminal_descriptor_digest: descriptorDigest,
  });
}

export function terminalJournalEvent(
  descriptor: TerminalResultDescriptorV1,
): Extract<JournalEventV1, { kind: 'terminal' }> {
  return {
    kind: 'terminal',
    descriptor,
    descriptor_digest: calculateTerminalDescriptorDigest(descriptor),
  };
}

type FinalizationEventV1 = Extract<
  JournalEventV1,
  { kind: 'output_prepared' | 'output_committed' | 'terminal' }
>;

export interface FinalizedIncompleteOutputV1 {
  kind: 'scrape_partial' | 'scrape_failure';
  stop: Extract<LocalScrapeRunResultV1, { kind: 'scrape_partial' | 'scrape_failure' }>['stop'];
}

export type FinalizedSuccessfulRunV1 =
  | { kind: 'scrape_outcome'; stop: RunCompletionStopV1 }
  | FinalizedIncompleteOutputV1;

export function finalizeSuccessfulOutput(input: {
  state: Pick<ExecutionStateV1, 'summary'>;
  stop: RunCompletionStopV1;
  sink: FileRunOutputSinkV1 | null;
  append_emergency: (event: FinalizationEventV1) => void;
}): void {
  const descriptor = createTerminalDescriptor(
    input.state,
    'scrape_outcome',
    input.stop,
    input.sink,
  );
  publishFileOutput({
    sink: input.sink,
    descriptor,
    append_emergency: input.append_emergency,
  });
  input.append_emergency(terminalJournalEvent(descriptor));
}

export function finalizeIncompleteOutput(input: {
  state: Pick<ExecutionStateV1, 'summary'>;
  stop: Extract<LocalScrapeRunResultV1, { kind: 'scrape_partial' | 'scrape_failure' }>['stop'];
  sink: FileRunOutputSinkV1 | null;
  append_emergency: (event: FinalizationEventV1) => void;
}): FinalizedIncompleteOutputV1 {
  const kind = input.state.summary.items_emitted > 0 ? 'scrape_partial' : 'scrape_failure';
  if (input.sink === null || input.stop === 'output_sink_failure' || kind === 'scrape_failure') {
    input.sink?.discard();
    const descriptor = createTerminalDescriptor(input.state, kind, input.stop, null);
    input.append_emergency(terminalJournalEvent(descriptor));
    return { kind, stop: input.stop };
  }
  try {
    const descriptor = createTerminalDescriptor(input.state, kind, input.stop, input.sink);
    publishFileOutput({
      sink: input.sink,
      descriptor,
      append_emergency: input.append_emergency,
    });
    input.append_emergency(terminalJournalEvent(descriptor));
    return { kind, stop: input.stop };
  } catch (error) {
    if (!(error instanceof RunOutputSinkError)) throw error;
    input.sink.discard();
    const descriptor = createTerminalDescriptor(input.state, kind, 'output_sink_failure', null);
    input.append_emergency(terminalJournalEvent(descriptor));
    return { kind, stop: 'output_sink_failure' };
  }
}

export function finalizeSuccessfulRun(input: {
  state: Pick<ExecutionStateV1, 'summary'>;
  stop: RunCompletionStopV1;
  sink: FileRunOutputSinkV1 | null;
  append_emergency: (event: FinalizationEventV1) => void;
}): FinalizedSuccessfulRunV1 {
  try {
    finalizeSuccessfulOutput(input);
    return { kind: 'scrape_outcome', stop: input.stop };
  } catch (error) {
    if (!(error instanceof RunOutputSinkError)) throw error;
    return finalizeIncompleteOutput({
      state: input.state,
      stop: 'output_sink_failure',
      sink: input.sink,
      append_emergency: input.append_emergency,
    });
  }
}
