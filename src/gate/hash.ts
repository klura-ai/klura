// Centralized payload hash for Level-3 token-gated gates.
//
// Every gate that binds a token to a payload (save-audit, consent-audit,
// future gates) hashes through THIS function. Swapping the scheme is a
// one-file change — important because a model that learns the scheme could
// in principle pre-compute matching hashes for a modified payload to claim
// it audited version A and committed version B.
//
// Current implementation: stable-sorted JSON + SHA-256 truncated to 16 hex
// chars. Fine against current models; cheap to swap to keyed HMAC with a
// runtime-boot secret if the threat model escalates.

import { createHash } from 'node:crypto';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort((a, b) => a.localeCompare(b));
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return `${JSON.stringify(k)}:${stableStringify(v)}`;
  });
  return `{${parts.join(',')}}`;
}

export function hashGatePayload(value: unknown): string {
  const canonical = stableStringify(value);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
