import type { PublicReadCapabilityV1 } from '../../public/contracts/package';
import type { ScrapeRunPolicyV1 } from '../../public/contracts/scrape-policy';

const RESULT_ENVELOPE_BYTES_V1 = 1_024;

export function maximumBufferedResultBytes(capability: PublicReadCapabilityV1): number {
  return capability.max_encoded_outcome_bytes + RESULT_ENVELOPE_BYTES_V1;
}

/** One waiting chain can hold one whole page of validated, uncommitted item output. */
export function maximumBufferedPageBytes(
  policy: ScrapeRunPolicyV1,
  capability: PublicReadCapabilityV1,
): number {
  return Math.max(maximumBufferedResultBytes(capability), policy.max_output_bytes);
}

export class AttemptOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptOrderError';
  }
}

/** Serializes every chain in one dispatch batch in deterministic order. */
export class AttemptOrderV1 {
  private nextAllocated = 0;
  private nextCommit = 0;
  private aborted = false;
  private abortReason: Error | undefined;
  private readonly waiters = new Map<
    number,
    { resolve: () => void; reject: (reason: Error) => void }
  >();

  allocate(): number {
    const ordinal = this.nextAllocated;
    this.nextAllocated += 1;
    return ordinal;
  }

  nextOrdinal(): number {
    return this.nextAllocated;
  }

  waitForTurn(ordinal: number): Promise<void> {
    this.assertAllocated(ordinal);
    if (this.aborted) {
      return Promise.reject(this.abortReason ?? new AttemptOrderError('attempt execution aborted'));
    }
    if (ordinal === this.nextCommit) return Promise.resolve();
    if (this.waiters.has(ordinal)) {
      throw new AttemptOrderError('one attempt ordinal has more than one waiter');
    }
    return new Promise((resolve, reject) => {
      this.waiters.set(ordinal, { resolve, reject });
    });
  }

  abort(reason: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.abortReason =
      reason instanceof Error ? reason : new AttemptOrderError('attempt execution aborted');
    for (const waiter of this.waiters.values()) waiter.reject(this.abortReason);
    this.waiters.clear();
  }

  releaseTurn(ordinal: number): void {
    this.assertAllocated(ordinal);
    if (ordinal !== this.nextCommit) {
      throw new AttemptOrderError('attempt ordinal is not the current commit turn');
    }
    this.nextCommit += 1;
    if (this.aborted) return;
    const next = this.waiters.get(this.nextCommit);
    if (next === undefined) return;
    this.waiters.delete(this.nextCommit);
    next.resolve();
  }

  private assertAllocated(ordinal: number): void {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= this.nextAllocated) {
      throw new AttemptOrderError('attempt ordinal was not allocated');
    }
  }
}

/** Releases only a chain that acquired its deterministic commit turn. */
export function releaseOwnedAttemptTurn(
  order: AttemptOrderV1,
  ordinal: number | null,
  ownsTurn: boolean,
): void {
  if (!ownsTurn || ordinal === null) return;
  order.releaseTurn(ordinal);
}

/** Limits concurrent chain results to the signed durable reordering budget. */
export function resolveBoundedAttemptConcurrency(
  policy: ScrapeRunPolicyV1,
  capabilities: Readonly<Record<string, PublicReadCapabilityV1>>,
): number {
  const bytesPerWaitingAttempt = Math.max(
    ...Object.values(capabilities).map((capability) =>
      maximumBufferedPageBytes(policy, capability),
    ),
  );
  const waitingAttempts = Math.floor(
    policy.durable.max_reorder_buffer_bytes / bytesPerWaitingAttempt,
  );
  return Math.min(policy.max_concurrency, waitingAttempts + 1);
}
