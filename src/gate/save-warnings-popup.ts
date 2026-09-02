// Popup-addressing-without-trigger save warning.
//
// Recorded-path strategies can pin individual steps to a tracked sub-page
// (e.g. an OAuth consent popup) via `step.page: "popup-1"`. At warm replay,
// the runtime needs `popup-1` to actually open at the right point in the
// flow — usually because an earlier step clicked the trigger that fired
// `window.open()` / followed a `target=_blank` link. When the discovery
// session never observed any popup at all (`session.subPages` is empty or
// missing), saving a strategy that depends on `popup-1` is virtually
// guaranteed to fail at warm-replay: nothing in the flow opens the popup
// the saved steps target. Surfaced as an ack-able save_warning so the agent
// can fix the steps, or ack with a reason — e.g. they're saving a strategy
// whose popup is opened via a side channel like a browser extension; rare
// but not zero.

import type { Strategy } from '../strategies/skills';
import type { Session } from '../drivers/types/session';
import type { SaveWarning } from './save-warnings';

export function detectPopupAddressingWithoutTrigger(
  data: Strategy,
  session: Session | null | undefined,
): SaveWarning[] {
  if (data.strategy !== 'recorded-path') return [];
  const steps = (data as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const stepArray = steps as unknown[];
  const offending: Array<{ index: number; id: string; page: string }> = [];
  for (let i = 0; i < stepArray.length; i += 1) {
    const step = stepArray[i];
    if (!step || typeof step !== 'object') continue;
    const page = (step as { page?: unknown }).page;
    if (typeof page !== 'string' || page === 'main') continue;
    offending.push({
      index: i,
      id:
        typeof (step as { id?: unknown }).id === 'string'
          ? (step as { id: string }).id
          : `step_${i}`,
      page,
    });
  }
  if (offending.length === 0) return [];
  // Distinct popup handles the steps reference.
  const referenced = Array.from(new Set(offending.map((o) => o.page)));
  // Did the discovery session observe any of these popups?
  const observed = new Set((session?.subPages ?? []).map((p) => p.id));
  const unobserved = referenced.filter((id) => !observed.has(id));
  if (unobserved.length === 0) return [];
  const referencedFmt = referenced.map((p) => JSON.stringify(p)).join(', ');
  const unobservedFmt = unobserved.map((p) => JSON.stringify(p)).join(', ');
  const stepsFmt = offending
    .filter((o) => unobserved.includes(o.page))
    .map((o) => `steps[${o.index}] (id ${JSON.stringify(o.id)}, page ${JSON.stringify(o.page)})`)
    .join('; ');
  return [
    {
      kind: 'popup_addressing_without_trigger',
      message:
        `Recorded-path references popup handles [${referencedFmt}] but the discovery session ` +
        `never observed [${unobservedFmt}] — no step in this flow opens the popup that these ` +
        `steps target, so warm replay will fail at the first popup-pinned step. Offending: ` +
        `${stepsFmt}.`,
      hint:
        `Either (a) add the click that triggers window.open() / opens the target=_blank link ` +
        `as a step before the popup-pinned ones, (b) re-discover the flow so the popup is ` +
        `actually observed (session.subPages will fill in), or (c) ack via ` +
        `notes.save_warnings_acked: [{kind: "popup_addressing_without_trigger", reason: "..."}] ` +
        `if the popup is opened by a side channel (browser extension, prior tab) — describe ` +
        `the channel. See klura://reference#popups.`,
    },
  ];
}
