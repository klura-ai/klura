import { PublicHttpExecutionError } from '../node-http';
import type { BrowserEgressRuleV1, BrowserResourcePolicyV1 } from './resource-policy';

/** Signed byte limits for browser request bodies in an authentication session. */
export interface BrowserRequestBodyPolicyV1 {
  max_encoded_request_body_bytes_per_browser_task: number;
  max_single_request_body_bytes: number;
  max_encoded_request_body_bytes_by_rule: Readonly<Record<string, number>>;
}

export interface BrowserFetchRequestBodyV1 {
  post_data: string | null;
  has_post_data: boolean;
  post_data_entries: Array<{ bytes: string | null }> | null;
}

export interface AdmittedBrowserRequestBodyV1 {
  policy: BrowserRequestBodyPolicyV1;
  bytes: number;
}

export interface BrowserRequestBodyAdmissionsV1 {
  task: AdmittedBrowserRequestBodyV1;
  operation: AdmittedBrowserRequestBodyV1 | null;
}

export function validateBrowserRequestBodiesForRule(
  body: BrowserFetchRequestBodyV1,
  resourcePolicy: BrowserResourcePolicyV1,
  operationPolicy: BrowserRequestBodyPolicyV1 | undefined,
  rule: BrowserEgressRuleV1,
  preflight: boolean,
): BrowserRequestBodyAdmissionsV1 | PublicHttpExecutionError {
  const task = validateBrowserRequestBodyForRule(
    body,
    requestBodyPolicyForBrowserResourcePolicy(resourcePolicy),
    rule,
  );
  const operation =
    operationPolicy === undefined
      ? null
      : validateBrowserRequestBodyForRule(body, operationPolicy, rule);
  if (task === null) {
    return new PublicHttpExecutionError('invalid_request', 'browser request body policy is absent');
  }
  if (task instanceof PublicHttpExecutionError) return task;
  if (operation instanceof PublicHttpExecutionError) return operation;
  if (preflight && task.bytes !== 0) {
    return new PublicHttpExecutionError(
      'request_blocked',
      'browser CORS preflight must have an empty request body',
    );
  }
  return { task, operation };
}

export function parseBrowserFetchRequestBody(value: unknown): BrowserFetchRequestBodyV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  let postData: string | null = null;
  if (Object.hasOwn(record, 'postData')) {
    if (typeof record.postData !== 'string') return null;
    postData = record.postData;
  }
  let hasPostData = false;
  const hasPostDataReported = Object.hasOwn(record, 'hasPostData');
  if (hasPostDataReported) {
    if (typeof record.hasPostData !== 'boolean') return null;
    hasPostData = record.hasPostData;
  }
  let entries: Array<{ bytes: string | null }> | null = null;
  if (Object.hasOwn(record, 'postDataEntries')) {
    if (!Array.isArray(record.postDataEntries)) return null;
    entries = [];
    for (const entry of record.postDataEntries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const bytes = (entry as Record<string, unknown>).bytes;
      if (bytes !== undefined && typeof bytes !== 'string') return null;
      entries.push({ bytes: bytes ?? null });
    }
  }
  if (hasPostDataReported && !hasPostData && (postData !== null || entries !== null)) return null;
  return { post_data: postData, has_post_data: hasPostData, post_data_entries: entries };
}

export function validateBrowserRequestBodyForRule(
  body: BrowserFetchRequestBodyV1,
  policy: BrowserRequestBodyPolicyV1 | undefined,
  rule: BrowserEgressRuleV1,
): AdmittedBrowserRequestBodyV1 | PublicHttpExecutionError | null {
  if (policy === undefined) return null;
  const ruleMaximum = policy.max_encoded_request_body_bytes_by_rule[rule.rule_id];
  if (
    !Number.isSafeInteger(policy.max_encoded_request_body_bytes_per_browser_task) ||
    policy.max_encoded_request_body_bytes_per_browser_task < 0 ||
    !Number.isSafeInteger(policy.max_single_request_body_bytes) ||
    policy.max_single_request_body_bytes < 0 ||
    typeof ruleMaximum !== 'number' ||
    !Number.isSafeInteger(ruleMaximum) ||
    ruleMaximum < 0
  ) {
    return new PublicHttpExecutionError(
      'invalid_request',
      'browser request body policy is invalid',
    );
  }
  const maximum = Math.min(
    policy.max_encoded_request_body_bytes_per_browser_task,
    policy.max_single_request_body_bytes,
    ruleMaximum,
  );
  const bytes = measureParsedBrowserRequestBodyBytes(body, maximum);
  if (bytes === null) {
    return new PublicHttpExecutionError(
      'request_blocked',
      'browser request body cannot be structurally accounted',
    );
  }
  if (bytes > ruleMaximum || bytes > policy.max_single_request_body_bytes) {
    return new PublicHttpExecutionError(
      'request_blocked',
      'browser request body exceeds its signed rule limit',
    );
  }
  return { policy, bytes };
}

/**
 * Counts CDP request bytes without accepting an unaccountable body representation.
 * `null` means the browser reported a body but did not expose bounded bytes for it.
 */
export function measureBrowserRequestBodyBytes(
  value: unknown,
  maximumBytes: number,
): number | null {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return null;
  const body = parseBrowserFetchRequestBody(value);
  return body === null ? null : measureParsedBrowserRequestBodyBytes(body, maximumBytes);
}

function measureParsedBrowserRequestBodyBytes(
  body: BrowserFetchRequestBodyV1,
  maximumBytes: number,
): number | null {
  if (body.post_data_entries !== null) {
    let total = 0;
    const chunks: Buffer[] = [];
    for (const entry of body.post_data_entries) {
      if (entry.bytes === null) return null;
      const remaining = maximumBytes - total;
      const bytes = boundedBase64ByteLength(entry.bytes, Math.max(remaining, 0));
      if (bytes === null) return null;
      total += bytes;
      if (total > maximumBytes) return total;
      chunks.push(Buffer.from(entry.bytes, 'base64'));
    }
    if (
      body.post_data !== null &&
      !Buffer.concat(chunks, total).equals(Buffer.from(body.post_data, 'utf8'))
    ) {
      return null;
    }
    return total;
  }
  if (body.post_data !== null) {
    if (body.post_data.length > maximumBytes) return maximumBytes + 1;
    const bytes = Buffer.byteLength(body.post_data, 'utf8');
    return bytes > maximumBytes ? maximumBytes + 1 : bytes;
  }
  return body.has_post_data ? null : 0;
}

function requestBodyPolicyForBrowserResourcePolicy(
  policy: BrowserResourcePolicyV1,
): BrowserRequestBodyPolicyV1 {
  return {
    max_encoded_request_body_bytes_per_browser_task:
      policy.max_encoded_request_body_bytes_per_browser_task,
    max_single_request_body_bytes: policy.max_single_request_body_bytes,
    max_encoded_request_body_bytes_by_rule: Object.fromEntries(
      policy.egress_rules.map((rule) => [rule.rule_id, rule.max_encoded_request_body_bytes]),
    ),
  };
}

function boundedBase64ByteLength(value: string, maximumBytes: number): number | null {
  const maximumEncoded = Math.ceil(((maximumBytes + 1) * 4) / 3) + 4;
  if (value.length > maximumEncoded) return maximumBytes + 1;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes.byteLength : null;
}
