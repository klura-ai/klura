# Popups — multi-tab tracking

A **sub-page** is any page in the session's `BrowserContext` other than the one the session opened with. Popups (`window.open`), `target=_blank` tabs, OAuth consent windows, Google Drive pickers, Stripe Checkout in popup mode, calendar detail tabs — anything that lands as a second `Page` object inside the same context.

Klura tracks every sub-page automatically and addresses them by stable handle (`popup-1`, `popup-2`, ...) through the `page` opt on `perform_action` and on the agent-facing inspection tools (`get_screenshot`, `get_a11y_tree`, `find_in_page`, `get_attribute`). Drivers route the underlying playwright `Page` lookup through a private `WeakMap<Session, Map<handle, Page>>` so the rest of the runtime addresses sub-pages exclusively by handle — no driver state leaks into agent-facing surfaces.

Distinct from [checkpoints](checkpoints.md) and [interruptions](interruptions.md): a popup is plain page state, not a mid-flow event. Drivers track them passively, the same way they track WebSocket frames or the network log.

## Handles

- The page the session opened with is `"main"`.
- Each new sub-page gets the next monotonic id: `"popup-1"`, `"popup-2"`, ...
- Ids never reuse. A popup that opened, was assigned `popup-1`, and closed leaves its `subPages` entry behind with `closedAt` set; the next popup is `popup-2`. This keeps recorded-path step pinning unambiguous — `popup-1` always means the first popup of the run.

## Storage shape

| Layer | Storage | What it holds |
| --- | --- | --- |
| Driver-private | `WeakMap<Session, Map<handle, Page>>` keyed by handle (`'main'`, `'popup-N'`) | Raw playwright `Page` references. Non-driver code physically cannot reach in. |
| Session (public) | `Session.subPages: SubPage[]` | Metadata only — `{id, url, title?, openerId, openedAt, closedAt?}`. Echoed in tool responses so the agent learns about popups appearing without a separate list call. |
| Driver-private extras | `nextPopupSuffix`, `popupContextListener`, `subPagesListeners` | Monotonic id counter, the `context.on('page')` listener (for warm-pool detach), and the subscriber set the remote viewer reads from. |

## Lifecycle

| Event | Effect |
| --- | --- |
| `context.on('page')` fires (popup opens) | Driver assigns next handle (`popup-N`), pushes `SubPage` entry, stores raw `Page`, subscribes to popup nav + close. Subscribers are notified. |
| Popup navigates inside itself | Entry's `url` updates; `title` refreshes on a microtask. Subscribers notified. |
| `page.on('close')` fires | Entry stays in `subPages` with `closedAt` set; raw page reference released so the GC can reclaim. Subscribers notified. |
| `resetSession` (warm-pool recycle) | All popup entries are dropped, the listener is detached, the suffix counter resets to 1. The next session starts with a clean sub-page list. |
| `destroySession` | The whole `BrowserContext` is closed; popups close as a side effect. |

## Agent-facing surface

`perform_action` and inspection tools all take an optional `page` opt; default is `"main"`. Unknown handles reject with a shape error citing the open list. Closed handles reject with a separate "is closed" error so the agent can distinguish "popup never existed" from "popup already closed."

Every `perform_action` response carries the current `subPages` snapshot when at least one sub-page has been observed; the field is omitted on the typical (no-popup) response so existing tool consumers see no shape change.

`navigate` always targets `main` — popups change URL by clicking links inside themselves, not by being driven through a top-level navigation tool.

For full schema + examples see `klura://reference#popups`.

## Recorded-path

A recorded-path step can pin to a sub-page via `step.page: "popup-N"`. At replay, the runtime reads the field, waits briefly for the popup to appear in `session.subPages` (handles the race where a prior step triggered `window.open` but `context.on('page')` hasn't fired yet — capped at `POPUP_OPEN_WAIT_MS`), and routes the action through the resolved handle. If the popup never opens or already closed, the runtime raises a `recorded_step_failed` checkpoint that names the offending handle and the open list.

The save-strategy audit composes a Detector — `popup_addressing_without_trigger` — that fires when a saved strategy references popup handles the discovery session never observed. Surfaces as a save-warning (acked via `notes.save_warnings_acked`); the agent either fixes the steps to include the click that opens the popup, re-discovers the flow, or acks with a one-sentence reason if the popup is opened by a side channel (browser extension, prior tab).

## Remote viewer

The viewer renders a tab strip across the top of the canvas when at least one sub-page has been observed. Clicking a tab sends a `switch_page` control message; the server updates `viewer.activePage`, rebinds `onFocusChange` to the new page, and the next screencast tick streams the chosen page. Closed popups stay in the strip with strikethrough styling. See [remote.md](remote.md#multi-tab--popups).

Touch dispatch is bound to a session-scoped CDP client that targets the main page; the viewer falls back to mouse events when the active tab is a popup so the click still lands.

## Driver support matrix

| Driver | Sub-page tracking | `page` opt routing | Viewer tab strip |
| --- | --- | --- | --- |
| `playwright` | Yes — `context.on('page')` listener | Yes — through `_page(session, handle)` | Yes |

Custom drivers that don't maintain a sub-page surface inherit the no-op default (`onSubPagesChange` returns immediately) and can address only `main`.
