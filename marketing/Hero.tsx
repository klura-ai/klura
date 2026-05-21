import React from "react";
import { AbsoluteFill, interpolate, random, useCurrentFrame } from "remotion";
import { BrowserMock, LAYOUT } from "./BrowserMock";
import { NetworkCall, NetworkPalette, NetworkPanel } from "./NetworkPanel";
import { messageFor, PersonCycle } from "./scenes";
import { StrategyFile, StrategyFilePalette } from "./StrategyFile";

// Hero loop: user prompts klura → first-execution discovers the API in the
// real UI → browser slides off, the saved skill (config file) slides in →
// next prompt fires the saved skill straight at the API across recipients.
// A persistent prompt bar at the bottom carries the user voice; the in-page
// chat input + status strip carry the agent's actions.

const REPLAY_RECIPIENTS = ["bob", "carol", "dave", "eve"];

const PROMPT_ADAM = "Say hello to Adam";

// Phase timings (30fps).
const PRE_ADAM_TYPE_START = 0;
const PRE_ADAM_TYPE_DURATION = 30; // ~1s typing
const PRE_ADAM_LOAD_DURATION = 15; // 0.5s spinner before learn fires
const LEARN_START = PRE_ADAM_TYPE_DURATION + PRE_ADAM_LOAD_DURATION; // 45
const LEARN_DURATION = 90;
const LIFT_START = LEARN_START + LEARN_DURATION; // 135
const LIFT_DURATION = 35;
const SLIDE_START = LIFT_START + LIFT_DURATION; // 170
const SLIDE_DURATION = 25;
const SLIDE_END = SLIDE_START + SLIDE_DURATION; // 195
// Horizontal travel for the page swap — chrome window slides out left, config
// window slides in right. The phase pills ride the same distance.
const SLIDE_OFFSCREEN_X = 1320;
// Replay begins the instant the config page finishes sliding in. Every
// recipient runs one full cycle: type the prompt → submit → spinner up while
// the saved skill walks the network calls → clear. See replayPromptStateAt.
const REPLAY_START = SLIDE_END; // 195
const REPLAY_TYPE_FRAMES = 16; // typing the prompt char-by-char
const REPLAY_SCROLL_PER_CALL = 11; // spinner up, arrow dwells on one net row
const REPLAY_CLEAR_FRAMES = 6; // prompt + spinner clear before the next one

// Tight typing window for the in-page chat input — fast staccato burst.
const TYPE_START_FRAC = 0.42;
const TYPE_END_FRAC = 0.50;
const ADAM_TAP_FRAC = 0.20;
const INPUT_TAP_FRAC = 0.40;
const SEND_FRAC = 0.93;
const SEND_FLASH_FRAMES = 6;
const TAP_DURATION_FRAMES = 18;
const SCENE_OFFSET_Y = 0;

const LEARN_CYCLE: PersonCycle = {
  personIdx: 0,
  startFrame: LEARN_START,
  duration: LEARN_DURATION,
  message: messageFor(0),
};

const NETWORK_CALLS: NetworkCall[] = [
  {
    method: "GET",
    path: "/api/contacts",
    appearsAt: LEARN_START + 4,
    completesAt: LEARN_START + 22,
  },
  {
    method: "GET",
    path: "/api/conversations/adam",
    appearsAt: LEARN_START + 28,
    completesAt: LEARN_START + 46,
    prunedFromSkill: true,
  },
  {
    method: "POST",
    path: "/api/messages/send",
    appearsAt: LEARN_START + 84,
    completesAt: LEARN_START + 90,
    body: { to: "adam", text: "Hello Adam!" },
  },
  {
    method: "GET",
    path: "/api/messages/ack",
    appearsAt: LEARN_START + 86,
    completesAt: LEARN_START + 92,
  },
];

const ACTIVE_CALL_INDICES = NETWORK_CALLS
  .map((c, i) => (c.prunedFromSkill ? -1 : i))
  .filter((i) => i >= 0);

const REPLAY_LOAD_FRAMES = REPLAY_SCROLL_PER_CALL * ACTIVE_CALL_INDICES.length;
const REPLAY_CYCLE_FRAMES =
  REPLAY_TYPE_FRAMES + REPLAY_LOAD_FRAMES + REPLAY_CLEAR_FRAMES;

const HOLD_FRAMES = 30;

export const HERO_DURATION =
  REPLAY_START + REPLAY_CYCLE_FRAMES * REPLAY_RECIPIENTS.length + HOLD_FRAMES;

function fakeUuid(seed: string): string {
  const hex = "0123456789abcdef";
  const ch = (i: number) => hex[Math.floor(random(`${seed}-${i}`) * 16)];
  const block = (n: number, off: number) =>
    Array.from({ length: n }, (_, i) => ch(off + i)).join("");
  return `${block(8, 0)}-${block(4, 8)}-${block(4, 12)}-${block(4, 16)}-${block(12, 20)}`;
}

function staccatoTypedAt(c: PersonCycle, frame: number): string {
  const startF = c.startFrame + c.duration * TYPE_START_FRAC;
  const endF = c.startFrame + c.duration * TYPE_END_FRAC;
  if (frame < startF) return "";
  if (frame >= endF) return c.message;
  const progress = (frame - startF) / (endF - startF);
  return c.message.slice(0, Math.floor(progress * c.message.length));
}

function typedPromptAt(
  start: number,
  duration: number,
  target: string,
  frame: number
): string {
  if (frame < start) return "";
  if (frame >= start + duration) return target;
  const progress = (frame - start) / duration;
  return target.slice(0, Math.floor(progress * target.length));
}

type PromptKind = "typing" | "loading" | "idle";
interface PromptBarState {
  kind: PromptKind;
  text: string;
}

function promptStateAt(frame: number): PromptBarState {
  const adamTypeEnd = PRE_ADAM_TYPE_START + PRE_ADAM_TYPE_DURATION;

  if (frame < adamTypeEnd) {
    return {
      kind: "typing",
      text: typedPromptAt(
        PRE_ADAM_TYPE_START,
        PRE_ADAM_TYPE_DURATION,
        PROMPT_ADAM,
        frame
      ),
    };
  }
  if (frame < SLIDE_START) {
    return { kind: "loading", text: PROMPT_ADAM };
  }
  // Slide + replay window: prompt is empty here until the component takes over
  // and drives it per recipient (see replayPromptStateAt).
  return { kind: "idle", text: "" };
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// One later-execution prompt cycle: type the command (white, no spinner), then
// hold it grayed out with the spinner up while the saved skill runs, then clear.
function replayPromptStateAt(
  cycleFrame: number,
  recipient: string
): PromptBarState {
  const prompt = `Say hello to ${capitalize(recipient)}`;
  if (cycleFrame < REPLAY_TYPE_FRAMES) {
    return {
      kind: "typing",
      text: typedPromptAt(0, REPLAY_TYPE_FRAMES, prompt, cycleFrame),
    };
  }
  if (cycleFrame < REPLAY_TYPE_FRAMES + REPLAY_LOAD_FRAMES) {
    return { kind: "loading", text: prompt };
  }
  return { kind: "idle", text: "" };
}

type Theme = "light" | "dark";

interface HeroPalette {
  network: NetworkPalette & { neutralDot: string };
  strategy: StrategyFilePalette;
  promptBg: string;
  promptText: string;
  promptMuted: string;
  promptBorder: string;
}

const PALETTES: Record<Theme, HeroPalette> = {
  // light page bg → dark overlay pills
  light: {
    network: {
      pillBg: "rgba(20, 18, 16, 0.96)",
      pillBorder: "rgba(255, 255, 255, 0.08)",
      text: "#f1ebe1",
      muted: "#a89e8e",
      accent: "#e85d2f",
      success: "#88a274",
      rowHighlight: "rgba(232, 93, 47, 0.16)",
      neutralDot: "#f1ebe1",
    },
    strategy: {
      panelBg: "rgba(20, 18, 16, 0.97)",
      panelBorder: "rgba(255, 255, 255, 0.10)",
      titleBg: "rgba(28, 25, 22, 0.97)",
      titleText: "#a89e8e",
      text: "#f1ebe1",
      muted: "#a89e8e",
      punct: "#6b6660",
      string: "#e85d2f",
      highlight: "rgba(245, 217, 95, 0.22)",
    },
    promptBg: "rgba(20, 18, 16, 0.96)",
    promptText: "#f1ebe1",
    promptMuted: "#857c6e",
    promptBorder: "rgba(255, 255, 255, 0.08)",
  },
  // dark page bg → light overlay pills
  dark: {
    network: {
      pillBg: "rgba(241, 235, 225, 0.97)",
      pillBorder: "rgba(0, 0, 0, 0.10)",
      text: "#1f1d1a",
      muted: "#857c6e",
      accent: "#c14a23",
      success: "#5a7a48",
      rowHighlight: "rgba(193, 74, 35, 0.14)",
      neutralDot: "#1f1d1a",
    },
    strategy: {
      panelBg: "rgba(241, 235, 225, 0.97)",
      panelBorder: "rgba(0, 0, 0, 0.10)",
      titleBg: "rgba(232, 224, 211, 0.97)",
      titleText: "#857c6e",
      text: "#1f1d1a",
      muted: "#857c6e",
      punct: "#a89e8e",
      string: "#c14a23",
      highlight: "rgba(232, 174, 47, 0.30)",
    },
    promptBg: "rgba(20, 18, 16, 0.96)",
    promptText: "#f1ebe1",
    promptMuted: "#857c6e",
    promptBorder: "rgba(255, 255, 255, 0.08)",
  },
};

interface HeroProps {
  background: string;
  theme: Theme;
}

export const Hero: React.FC<HeroProps> = ({ background, theme }) => {
  const palette = PALETTES[theme];
  const frame = useCurrentFrame();

  const inLearn = frame >= LEARN_START && frame < LIFT_START;
  const inLift = frame >= LIFT_START && frame < SLIDE_START;
  const inReplay = frame >= REPLAY_START;
  // Netlog flips to its saved-skill presentation as soon as the slide completes.
  const inExecuteMode = frame >= SLIDE_END;

  const sendFireFrame =
    LEARN_CYCLE.startFrame + LEARN_CYCLE.duration * SEND_FRAC;
  const sendFired = frame >= sendFireFrame;

  // Replay is a stack of per-recipient cycles. `replayCycleFrame` is the frame
  // within the current recipient's cycle; the arrow only walks the network
  // rows during that cycle's load phase (spinner up).
  let arrowAtRow: number | null = null;
  let loopIdx = 0;
  let replayCycleFrame = 0;
  if (inReplay) {
    const replayFrame = frame - REPLAY_START;
    loopIdx = Math.min(
      Math.floor(replayFrame / REPLAY_CYCLE_FRAMES),
      REPLAY_RECIPIENTS.length - 1
    );
    replayCycleFrame = replayFrame - loopIdx * REPLAY_CYCLE_FRAMES;
    const loadFrame = replayCycleFrame - REPLAY_TYPE_FRAMES;
    if (loadFrame >= 0 && loadFrame < REPLAY_LOAD_FRAMES) {
      const callIdx = Math.min(
        Math.floor(loadFrame / REPLAY_SCROLL_PER_CALL),
        ACTIVE_CALL_INDICES.length - 1
      );
      arrowAtRow = ACTIVE_CALL_INDICES[callIdx];
    }
  }

  const recipientName = REPLAY_RECIPIENTS[loopIdx];

  const sent: { person: number; text: string }[] = [];
  if (sendFired) {
    sent.push({ person: LEARN_CYCLE.personIdx, text: LEARN_CYCLE.message });
  }

  let inputText = "";
  if (frame >= LEARN_START && frame < LIFT_START) {
    inputText = staccatoTypedAt(LEARN_CYCLE, frame);
  } else if (frame >= LIFT_START) {
    inputText = LEARN_CYCLE.message;
  }

  const sendHighlight =
    frame >= sendFireFrame && frame <= sendFireFrame + SEND_FLASH_FRAMES;

  // Browser opacity: dimmed before learn (waiting for prompt to flush),
  // bright during learn, dim again from lift onward as focus shifts.
  let browserOpacity: number;
  if (frame < LEARN_START) {
    browserOpacity = 0.35;
  } else if (frame < LIFT_START) {
    browserOpacity = interpolate(
      frame,
      [LEARN_START, LEARN_START + 6],
      [0.35, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
  } else {
    browserOpacity = interpolate(
      frame,
      [LIFT_START, SLIDE_START],
      [1, 0.5],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
  }

  const browserShiftX = interpolate(
    frame,
    [SLIDE_START, SLIDE_END],
    [0, -SLIDE_OFFSCREEN_X],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const browserMounted = frame < SLIDE_END;

  // Config file slides in from the right into the space the browser is leaving.
  // It dims slightly once replay starts so the JSON popup reads cleanly on top.
  const configShiftX = interpolate(
    frame,
    [SLIDE_START, SLIDE_END],
    [SLIDE_OFFSCREEN_X, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const configMounted = frame >= SLIDE_START;
  const configOpacity = interpolate(
    frame,
    [REPLAY_START, REPLAY_START + 10],
    [1, 0.55],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const popupCall = arrowAtRow !== null ? NETWORK_CALLS[arrowAtRow] : null;
  const showPopup = inReplay && popupCall && popupCall.body;

  const promptState = inReplay
    ? replayPromptStateAt(replayCycleFrame, recipientName)
    : promptStateAt(frame);

  return (
    <AbsoluteFill style={{ background }}>
      <StatusStack frame={frame} palette={palette.network} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `translateY(${SCENE_OFFSET_Y}px)`,
        }}
      >
        {browserMounted && (
          <div
            style={{
              opacity: browserOpacity,
              transform: `translateX(${browserShiftX}px)`,
            }}
          >
            <BrowserMock
              activePerson={LEARN_CYCLE.personIdx}
              inputText={inputText}
              sentMessages={sent}
              highlightSend={sendHighlight}
            />
          </div>
        )}
        {inLearn && <ClickTaps frame={frame} accent={palette.network.accent} />}
        {configMounted && (
          <div
            style={{
              position: "absolute",
              left: 80,
              top: 100,
              width: 540,
              opacity: configOpacity,
              transform: `translateX(${configShiftX}px)`,
              zIndex: 1,
            }}
          >
            <StrategyFile
              filename="~/.klura/skills/chat.so/send_message.json"
              palette={palette.strategy}
              frame={frame}
            />
          </div>
        )}
        {/* Netlog + popup ride above the slide so the config emerges from
            behind them on its way to its final resting spot. */}
        <div style={{ position: "absolute", inset: 0, zIndex: 2 }}>
          <NetworkPanel
            frame={frame}
            calls={NETWORK_CALLS}
            replayMode={inExecuteMode}
            arrowAtRow={arrowAtRow}
            palette={palette.network}
          />
          {showPopup && popupCall && (
            <JsonPopup
              method={popupCall.method}
              path={popupCall.path}
              body={{
                to: recipientName,
                text: `Hello ${capitalize(recipientName)}!`,
                token: fakeUuid(`post-${loopIdx}`),
              }}
              palette={palette.network}
            />
          )}
        </div>
      </div>
      <PromptBar state={promptState} frame={frame} palette={palette} />
    </AbsoluteFill>
  );
};

interface Tap {
  fireAt: number;
  x: number;
  y: number;
}

const TAPS: Tap[] = [
  {
    fireAt: LEARN_CYCLE.startFrame + LEARN_CYCLE.duration * ADAM_TAP_FRAC,
    x: LAYOUT.personRow(0).centerX,
    y: LAYOUT.personRow(0).centerY,
  },
  {
    fireAt: LEARN_CYCLE.startFrame + LEARN_CYCLE.duration * INPUT_TAP_FRAC,
    x: LAYOUT.input.centerX,
    y: LAYOUT.input.centerY,
  },
  {
    fireAt: LEARN_CYCLE.startFrame + LEARN_CYCLE.duration * SEND_FRAC,
    x: LAYOUT.send.centerX,
    y: LAYOUT.send.centerY,
  },
];

const ClickTaps: React.FC<{ frame: number; accent: string }> = ({
  frame,
  accent,
}) => {
  return (
    <>
      {TAPS.map((tap, i) => {
        const elapsed = frame - tap.fireAt;
        if (elapsed < 0 || elapsed > TAP_DURATION_FRAMES) return null;
        const t = elapsed / TAP_DURATION_FRAMES;
        const radius = interpolate(t, [0, 1], [6, 38]);
        const opacity = interpolate(t, [0, 1], [0.85, 0]);
        const ringSize = radius * 2;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: tap.x - radius,
              top: tap.y - radius,
              width: ringSize,
              height: ringSize,
              borderRadius: "50%",
              border: `2px solid ${accent}`,
              opacity,
              pointerEvents: "none",
              boxShadow: `0 0 12px ${accent}66`,
            }}
          />
        );
      })}
    </>
  );
};

const STATUS_TEXTS = {
  first: "first execution",
  later: "later executions",
} as const;

// Each phase pill rides its window: "first execution" tracks the chrome window
// (slides off the left with the page), "later executions" tracks the config
// window (slides in from the right). Same travel, same velocity — no fade.
const StatusStack: React.FC<{
  frame: number;
  palette: NetworkPalette & { neutralDot: string };
}> = ({ frame, palette }) => {
  const browserShiftX = interpolate(
    frame,
    [SLIDE_START, SLIDE_END],
    [0, -SLIDE_OFFSCREEN_X],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const configShiftX = interpolate(
    frame,
    [SLIDE_START, SLIDE_END],
    [SLIDE_OFFSCREEN_X, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <>
      {frame < SLIDE_END && (
        <StatusPill
          label={STATUS_TEXTS.first}
          accent={false}
          shiftX={browserShiftX}
          frame={frame}
          palette={palette}
        />
      )}
      {frame >= SLIDE_START && (
        <StatusPill
          label={STATUS_TEXTS.later}
          accent
          shiftX={configShiftX}
          frame={frame}
          palette={palette}
        />
      )}
    </>
  );
};

const StatusPill: React.FC<{
  label: string;
  accent: boolean;
  shiftX: number;
  frame: number;
  palette: NetworkPalette & { neutralDot: string };
}> = ({ label, accent, shiftX, frame, palette }) => {
  const pulse = 0.6 + 0.4 * Math.abs(Math.sin(frame * 0.12));
  const dotColor = accent ? palette.accent : palette.neutralDot;
  const borderColor = accent ? palette.accent : palette.pillBorder;

  return (
    <div
      style={{
        position: "absolute",
        top: 24,
        left: "50%",
        transform: `translateX(-50%) translateX(${shiftX}px)`,
        zIndex: 3,
        display: "flex",
        alignItems: "center",
        gap: 18,
        fontFamily: "'Geist Mono', ui-monospace, monospace",
        fontSize: 22,
        letterSpacing: 0.3,
        background: palette.pillBg,
        border: `1px solid ${borderColor}`,
        borderRadius: 10,
        padding: "12px 28px",
        boxShadow: "0 16px 48px rgba(0,0,0,0.35)",
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: dotColor,
          boxShadow: `0 0 14px ${dotColor}`,
          opacity: pulse,
        }}
      />
      <span style={{ color: palette.text }}>{label}</span>
    </div>
  );
};

const JsonPopup: React.FC<{
  method: string;
  path: string;
  body: Record<string, string>;
  palette: NetworkPalette;
}> = ({ method, path, body, palette }) => {
  return (
    <div
      style={{
        position: "absolute",
        right: 100,
        top: 320,
        width: 480,
        background: palette.pillBg,
        border: `1px solid ${palette.accent}66`,
        borderRadius: 8,
        padding: "12px 16px",
        fontFamily: "'Geist Mono', ui-monospace, monospace",
        fontSize: 13,
        color: palette.text,
        boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: palette.muted,
          marginBottom: 8,
          letterSpacing: 2,
          textTransform: "uppercase",
        }}
      >
        {method} {path}
      </div>
      <div style={{ color: palette.muted }}>{`{`}</div>
      {Object.entries(body).map(([k, v], i, arr) => (
        <div key={k} style={{ paddingLeft: 14 }}>
          <span style={{ color: palette.muted }}>"{k}"</span>
          <span style={{ color: palette.muted }}>: </span>
          <span style={{ color: palette.accent }}>"{v}"</span>
          {i < arr.length - 1 ? (
            <span style={{ color: palette.muted }}>,</span>
          ) : (
            ""
          )}
        </div>
      ))}
      <div style={{ color: palette.muted }}>{`}`}</div>
    </div>
  );
};

const PromptBar: React.FC<{
  state: PromptBarState;
  frame: number;
  palette: HeroPalette;
}> = ({ state, frame, palette }) => {
  const isLoading = state.kind === "loading";
  const isTyping = state.kind === "typing";
  const isIdle = state.kind === "idle";

  return (
    <div
      style={{
        position: "absolute",
        left: 200,
        right: 200,
        bottom: 24,
        height: 48,
        background: palette.promptBg,
        borderRadius: 24,
        display: "flex",
        alignItems: "center",
        padding: "0 22px",
        gap: 14,
        fontFamily: "'Geist Mono', ui-monospace, monospace",
        fontSize: 16,
        boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
        border: `1px solid ${palette.promptBorder}`,
      }}
    >
      <span style={{ color: palette.promptMuted, fontSize: 16 }}>›</span>
      <span
        style={{
          color: isLoading ? palette.promptMuted : palette.promptText,
          flex: 1,
          letterSpacing: 0.3,
          minHeight: 18,
        }}
      >
        {state.text}
        {isTyping && <PromptCaret color={palette.promptText} frame={frame} />}
        {isIdle && (
          <PromptCaret color={palette.promptText} frame={frame} idle />
        )}
      </span>
      {isLoading && <Spinner color={palette.promptText} frame={frame} />}
    </div>
  );
};

const PromptCaret: React.FC<{
  color: string;
  frame: number;
  idle?: boolean;
}> = ({ color, frame, idle }) => {
  const visible = frame % 30 < 15;
  return (
    <span
      style={{
        display: "inline-block",
        width: 2,
        height: 16,
        background: color,
        marginLeft: idle ? 0 : 2,
        verticalAlign: "middle",
        opacity: visible ? 0.85 : 0,
      }}
    />
  );
};

const Spinner: React.FC<{ color: string; frame: number }> = ({
  color,
  frame,
}) => {
  const rotation = (frame * 18) % 360;
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 18 18"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <circle
        cx={9}
        cy={9}
        r={7}
        fill="none"
        stroke={color}
        strokeOpacity={0.2}
        strokeWidth={2.2}
      />
      <path
        d="M 9 2 A 7 7 0 0 1 16 9"
        fill="none"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    </svg>
  );
};
