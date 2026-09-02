import {
  JOURNAL_EMERGENCY_FRAME_BODY_BYTES_V1,
  JOURNAL_FRAME_HEADER_BYTES_V1,
  JOURNAL_FRAME_TRAILER_BYTES_V1,
} from '../../public/contracts/journal-budget';
import {
  appendJournalFrame,
  encodeJournalFrame,
  type JournalEventV1,
  type JournalFrameV1,
  type RunIdV1,
} from './journal';
import type { ExecutionStateV1 } from './run-state';

export interface EmergencyJournalCursorV1 {
  sequence: number;
  execution_epoch: number;
  previous_digest: ExecutionStateV1['previous_digest'];
  maximum_journal_frames: number;
}

/** Appends one bounded frame from the terminalization allowance. */
export function appendEmergencyJournalFrame(
  runId: RunIdV1,
  journalPath: string,
  maximumJournalBytes: number,
  cursor: EmergencyJournalCursorV1,
  event: JournalEventV1,
): JournalFrameV1 {
  if (cursor.sequence >= cursor.maximum_journal_frames) {
    throw new Error('journal frame budget cannot record a terminal result');
  }
  const body = {
    frame_schema_version: 1 as const,
    run_id: runId,
    sequence: cursor.sequence + 1,
    execution_epoch: cursor.execution_epoch,
    previous_frame_digest: cursor.previous_digest,
    event,
  };
  if (
    encodeJournalFrame(body).byteLength -
      JOURNAL_FRAME_HEADER_BYTES_V1 -
      JOURNAL_FRAME_TRAILER_BYTES_V1 >
    JOURNAL_EMERGENCY_FRAME_BODY_BYTES_V1
  ) {
    throw new Error('emergency journal event exceeds its reserved body budget');
  }
  return appendJournalFrame(journalPath, body, maximumJournalBytes, cursor.maximum_journal_frames);
}

/** Appends an emergency journal event from the terminalization allowance. */
export function appendEmergencyJournalEvent(
  runId: RunIdV1,
  journalPath: string,
  maximumJournalBytes: number,
  state: ExecutionStateV1,
  event: JournalEventV1,
): void {
  const appended = appendEmergencyJournalFrame(
    runId,
    journalPath,
    maximumJournalBytes,
    state,
    event,
  );
  state.sequence = appended.body.sequence;
  state.previous_digest = appended.digest;
  if (event.kind === 'terminal') state.terminal = true;
}
