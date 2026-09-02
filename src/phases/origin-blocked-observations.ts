// Session-scoped record of what the origin-blocked detector actually saw.
//
// The detector fires on a landing and its advisory goes to the agent. That
// advisory is also the runtime's ONLY structural evidence that a host refused
// or challenged this session — and `abort_session` needs it later, when the
// agent classifies the abort. Without a record, every ledger entry is an
// agent's claim, and three claims read exactly like three measurements.
//
// Recording is append-on-fire and bounded; matching is host equality against
// either end of the observed navigation (a challenge that redirects cross-host
// still corroborates a refusal of the requested host).

import type { OriginBlockedAdvisory } from './origin-blocked-detector';
import type { Session } from '../drivers/types/session';

/** Cap on retained advisories per session. A blocked session re-detects on
 *  every navigate; only the fact that a host was observed blocked matters, so
 *  the newest few are enough. */
const MAX_OBSERVATIONS = 20;

/** Carrier of the observation list. Narrow structural type so callers can pass
 *  a live `Session` or a plain object in tests. */
type ObservationCarrier = Pick<Session, 'originBlockedObservations'>;

/** Record a detector advisory against the session that produced it. */
export function recordOriginBlockedObservation(
  session: ObservationCarrier,
  advisory: OriginBlockedAdvisory,
): void {
  const list = session.originBlockedObservations ?? [];
  list.push(advisory);
  session.originBlockedObservations =
    list.length > MAX_OBSERVATIONS ? list.slice(-MAX_OBSERVATIONS) : list;
}

/**
 * The first advisory this session recorded whose requested or final host
 * matches `host`, or `undefined` when the runtime observed nothing on that
 * host. Host comparison is case-insensitive and exact — a subdomain is a
 * different host, and treating it as the same would let an unrelated
 * observation vouch for the abort.
 */
export function findOriginBlockedObservation(
  session: ObservationCarrier,
  host: string | null | undefined,
): OriginBlockedAdvisory | undefined {
  if (typeof host !== 'string' || host.length === 0) return undefined;
  const needle = host.toLowerCase();
  return (session.originBlockedObservations ?? []).find(
    (o) => o.requested_host === needle || o.final_host === needle,
  );
}
