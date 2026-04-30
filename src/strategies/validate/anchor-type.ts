// Enum-check notes.anchor_type and scope it to page-script saves. Other tiers
// have no anchor choice (fetch runs in Node, recorded-path replays UI), so
// anchor_type on them is a classification error — flag it at save time so the
// agent learns to declare it only where it belongs.

import { didYouMeanSuffix } from '../../validators';
import { isPlainObject } from './helpers';
import { ANCHOR_TYPES } from './constants';

export function validateNotesAnchorType(data: Record<string, unknown>, tier: string): void {
  const notes = data.notes;
  if (!isPlainObject(notes)) return;
  const anchor = notes.anchor_type;
  if (anchor === undefined) return;
  if (tier !== 'page-script') {
    throw new Error(
      `invalid_strategy: notes.anchor_type is only valid for strategy:"page-script" (${tier} has no anchor choice — fetch runs in Node, recorded-path replays UI actions).`,
    );
  }
  if (
    typeof anchor !== 'string' ||
    !ANCHOR_TYPES.includes(anchor as (typeof ANCHOR_TYPES)[number])
  ) {
    const allowed = ANCHOR_TYPES.map((a) => `"${a}"`).join(', ');
    const suggestion =
      typeof anchor === 'string' ? didYouMeanSuffix(anchor, [...ANCHOR_TYPES]) : '';
    throw new Error(
      `invalid_strategy: notes.anchor_type = ${JSON.stringify(anchor)} is not allowed; must be one of: ${allowed}${suggestion}. See klura://reference#page-script-anchors for what each value means.`,
    );
  }
}
