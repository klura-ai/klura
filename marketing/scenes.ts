import { LAYOUT, PEOPLE } from "./BrowserMock";
import { Waypoint } from "./Cursor";

export interface PersonCycle {
  personIdx: number;
  startFrame: number;
  duration: number; // total frames for this cycle
  message: string;
}

export interface CycleResult {
  waypoints: Waypoint[];
  // sentAtFrame: when the message gets appended to sentMessages
  sentAtFrame: number;
  sentMessage: { person: number; text: string };
}

// Build waypoints + send-event for a single click-person → type → send cycle.
// Timings are scaled to the cycle's duration so the same routine works for
// slow learning passes (120f) and fast executing bursts (12f).
export function buildCycle(c: PersonCycle): CycleResult {
  const t = (frac: number) => c.startFrame + Math.round(c.duration * frac);
  const row = LAYOUT.personRow(c.personIdx);

  // Cursor flows continuously: previous cycle's send-click is the starting
  // point for this cycle's move to the person row. No re-anchored intro point.
  // Action timings leave room for the agent thought to fully type out before
  // the action fires (logical: agent thinks, then acts).
  const waypoints: Waypoint[] = [
    { frame: t(0.28), x: row.centerX, y: row.centerY, click: true },
    { frame: t(0.62), x: LAYOUT.input.centerX, y: LAYOUT.input.centerY, click: true },
    { frame: t(0.88), x: LAYOUT.input.centerX, y: LAYOUT.input.centerY },
    { frame: t(0.93), x: LAYOUT.send.centerX, y: LAYOUT.send.centerY, click: true },
  ];

  return {
    waypoints,
    sentAtFrame: t(0.93),
    sentMessage: { person: c.personIdx, text: c.message },
  };
}

// Returns the typed text at `frame` for a single cycle, animating char-by-char
// between the typing window [t(0.65), t(0.86)].
export function typedTextAt(c: PersonCycle, frame: number): string | null {
  const t = (frac: number) => c.startFrame + c.duration * frac;
  if (frame < c.startFrame || frame > c.startFrame + c.duration) return null;
  if (frame < t(0.65)) return "";
  if (frame >= t(0.86)) return c.message;
  const progress = (frame - t(0.65)) / (t(0.86) - t(0.65));
  const chars = Math.floor(progress * c.message.length);
  return c.message.slice(0, chars);
}

export function messageFor(personIdx: number): string {
  const name = PEOPLE[personIdx];
  return `Hello ${name}!`;
}
