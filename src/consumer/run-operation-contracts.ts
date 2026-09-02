import {
  parseCapabilityId,
  parseExactRecord,
  parsePackageId,
  parsePackageVersion,
  parseSha256Digest,
} from '../public/contracts/common';
import { parseRunId, parseRunOperationId } from './scrape/journal';
import { RunOperationError } from './scrape/run-operations';
import type {
  CancelRunResponseV1,
  DetachedRunAcceptedV1,
  DiscardRunResponseV1,
  ResumeRunAcceptedV1,
} from './daemon-routes';

export function isDetachedRunAccepted(value: unknown): value is DetachedRunAcceptedV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === 'run_accepted' &&
    typeof record.operation_id === 'string' &&
    typeof record.package_id === 'string' &&
    typeof record.version === 'string' &&
    typeof record.package_digest === 'string' &&
    typeof record.capability === 'string' &&
    typeof record.run_id === 'string'
  );
}

export function isResumeRunAccepted(value: unknown): value is ResumeRunAcceptedV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === 'run_resume_accepted' &&
    typeof record.operation_id === 'string' &&
    typeof record.run_id === 'string'
  );
}

export function isCancelRunResponse(value: unknown): value is CancelRunResponseV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === 'run_cancellation_requested' || record.kind === 'run_not_active') &&
    typeof record.operation_id === 'string' &&
    typeof record.run_id === 'string'
  );
}

export function isDiscardRunResponse(value: unknown): value is DiscardRunResponseV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === 'discarded' || record.kind === 'not_quarantined') &&
    typeof record.operation_id === 'string' &&
    typeof record.run_id === 'string'
  );
}

export function parseDetachedRunAcceptance(value: unknown, field: string): DetachedRunAcceptedV1 {
  const record = parseExactRecord(value, field, [
    'kind',
    'operation_id',
    'package_id',
    'version',
    'package_digest',
    'capability',
    'run_id',
  ]);
  if (record.kind !== 'run_accepted') {
    throw new RunOperationError('local_state_invalid', 'stored operation is not a run acceptance');
  }
  return {
    kind: 'run_accepted',
    operation_id: parseRunOperationId(record.operation_id, `${field}.operation_id`),
    package_id: parsePackageId(record.package_id, `${field}.package_id`),
    version: parsePackageVersion(record.version, `${field}.version`),
    package_digest: parseSha256Digest(record.package_digest, `${field}.package_digest`),
    capability: parseCapabilityId(record.capability, `${field}.capability`),
    run_id: parseRunId(record.run_id, `${field}.run_id`),
  };
}

export function parseResumeRunAcceptance(value: unknown, field: string): ResumeRunAcceptedV1 {
  const record = parseExactRecord(value, field, ['kind', 'operation_id', 'run_id']);
  if (record.kind !== 'run_resume_accepted') {
    throw new RunOperationError(
      'local_state_invalid',
      'stored operation is not a resume acceptance',
    );
  }
  return {
    kind: 'run_resume_accepted',
    operation_id: parseRunOperationId(record.operation_id, `${field}.operation_id`),
    run_id: parseRunId(record.run_id, `${field}.run_id`),
  };
}

export function parseCancelRunResponse(value: unknown, field: string): CancelRunResponseV1 {
  const record = parseExactRecord(value, field, ['kind', 'operation_id', 'run_id']);
  if (record.kind !== 'run_cancellation_requested' && record.kind !== 'run_not_active') {
    throw new RunOperationError('local_state_invalid', 'stored operation is not a cancel result');
  }
  return {
    kind: record.kind,
    operation_id: parseRunOperationId(record.operation_id, `${field}.operation_id`),
    run_id: parseRunId(record.run_id, `${field}.run_id`),
  };
}

export function parseDiscardRunResponse(value: unknown, field: string): DiscardRunResponseV1 {
  const record = parseExactRecord(value, field, ['kind', 'operation_id', 'run_id']);
  if (record.kind !== 'discarded' && record.kind !== 'not_quarantined') {
    throw new RunOperationError('local_state_invalid', 'stored operation is not a discard result');
  }
  return {
    kind: record.kind,
    operation_id: parseRunOperationId(record.operation_id, `${field}.operation_id`),
    run_id: parseRunId(record.run_id, `${field}.run_id`),
  };
}
