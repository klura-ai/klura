import {
  parseExactRecord,
  parseStableContractId,
  parseString,
  PublicContractError,
} from '../../public/contracts/common';
import type { JournalEventV1, RunNodeIdV1, RunStopV1 } from './journal';

/** Upper bound on a recorded stop reason; longer causes are cut, never dropped. */
export const STOP_REASON_MESSAGE_BYTES_V1 = 512;

/** Fits a cause into one stop_reason frame. */
export function boundStopReasonMessage(message: string): string {
  const bytes = Buffer.from(message, 'utf8');
  if (bytes.byteLength <= STOP_REASON_MESSAGE_BYTES_V1) return message;
  let cut = bytes.subarray(0, STOP_REASON_MESSAGE_BYTES_V1 - 4).toString('utf8');
  while (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function parseRunNodeId(value: unknown, field: string): RunNodeIdV1 {
  if (typeof value !== 'string' || !/^node_v1_[0-9a-f]{32}$/.test(value)) {
    throw new PublicContractError(field, 'must be a canonical run node id');
  }
  return value as RunNodeIdV1;
}

export function parseRunStop(value: unknown, field: string): RunStopV1 {
  if (
    value === 'cancelled' ||
    value === 'deadline_exhausted' ||
    value === 'task_failed' ||
    value === 'run_budget_exhausted' ||
    value === 'item_invalid' ||
    value === 'output_sink_failure'
  ) {
    return value;
  }
  throw new PublicContractError(field, 'is invalid');
}

/** The frame that records why a stop was chosen: the deciding check's own
 *  message beside the stop, the node, and the task kind it applied to. */
export function parseStopReasonEvent(
  value: unknown,
  field: string,
): Extract<JournalEventV1, { kind: 'stop_reason' }> {
  const record = parseExactRecord(value, field, [
    'kind',
    'node_id',
    'task_kind_id',
    'stop',
    'message',
  ]);
  return {
    kind: 'stop_reason',
    node_id: record.node_id === null ? null : parseRunNodeId(record.node_id, `${field}.node_id`),
    task_kind_id:
      record.task_kind_id === null
        ? null
        : parseStableContractId(record.task_kind_id, `${field}.task_kind_id`),
    stop: parseRunStop(record.stop, `${field}.stop`),
    message: parseString(record.message, `${field}.message`, STOP_REASON_MESSAGE_BYTES_V1),
  };
}
