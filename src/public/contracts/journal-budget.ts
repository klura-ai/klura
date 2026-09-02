/** Journal budget accounting shared by the package parser, which refuses a
 *  collection whose declared durable budgets cannot hold its own ceilings, and
 *  the run journal, which spends those budgets. Both sides read one set of
 *  numbers so a package that parses is a package that can finish. */

export const JOURNAL_FRAME_HEADER_BYTES_V1 = 4;
export const JOURNAL_FRAME_TRAILER_BYTES_V1 = 32;
/** Largest body an emergency frame (cancel, interrupt, terminal, output) may carry. */
export const JOURNAL_EMERGENCY_FRAME_BODY_BYTES_V1 = 65_536;
/** Frames held back from ordinary work so a run can always terminalize. */
export const JOURNAL_EMERGENCY_FRAME_RESERVE_V1 = 5;
/** Bytes held back from ordinary work for those emergency frames. */
export const JOURNAL_EMERGENCY_BYTE_RESERVE_V1 =
  JOURNAL_EMERGENCY_FRAME_RESERVE_V1 *
  (JOURNAL_FRAME_HEADER_BYTES_V1 +
    JOURNAL_EMERGENCY_FRAME_BODY_BYTES_V1 +
    JOURNAL_FRAME_TRAILER_BYTES_V1);

/** Journal frames a run appends outside any task or item: run_created,
 *  output_prepared, output_committed, and terminal, plus the emergency frames
 *  the capacity check keeps free at all times. */
export const JOURNAL_FRAMES_FIXED_V1 = 4 + JOURNAL_EMERGENCY_FRAME_RESERVE_V1;
/** Journal frames one task may append: attempt_intent, attempt_observed,
 *  task_completed, node_progressed or node_completed, and one node_enqueued
 *  for a child it fans out to. */
export const JOURNAL_FRAMES_PER_TASK_V1 = 5;
/** Journal frames one emitted item appends: item_buffered, item_committed,
 *  and sink_committed. */
export const JOURNAL_FRAMES_PER_ITEM_V1 = 3;
/** Encoded size allowance for one ordinary frame; every ordinary frame kind
 *  the run appends encodes well under it, and the run tests hold it there. */
export const JOURNAL_ORDINARY_FRAME_BYTES_V1 = 1_024;

/** The fewest journal frames under which a run can still reach every declared
 *  task and item ceiling without exhausting its durable budget. */
export function minimumJournalFrames(policy: { max_tasks: number; max_items: number }): number {
  return (
    JOURNAL_FRAMES_FIXED_V1 +
    JOURNAL_FRAMES_PER_TASK_V1 * policy.max_tasks +
    JOURNAL_FRAMES_PER_ITEM_V1 * policy.max_items
  );
}

/** The fewest journal bytes that hold the emergency reserve plus one ordinary
 *  allowance for each frame the ceilings can need. */
export function minimumJournalBytes(policy: { max_tasks: number; max_items: number }): number {
  return (
    JOURNAL_EMERGENCY_BYTE_RESERVE_V1 +
    JOURNAL_ORDINARY_FRAME_BYTES_V1 * minimumJournalFrames(policy)
  );
}
