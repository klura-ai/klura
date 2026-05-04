import fs from 'fs';
import http from 'http';
import os from 'os';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { BrowserDriver } from '../drivers/interface';
import type { FocusState, Session, SubPage } from '../drivers/types/session';
import { getDeviceProfile } from '../identity/devices';
import { signViewerToken, tokenIntegrity } from './jwt';
import { getRemoteSecret } from './secret';

interface ViewerSession {
  token: string;
  port: number;
  sessionId: string;
  server: http.Server;
  wss: WebSocketServer;
  viewerWs: WebSocket | null;
  captureInterval: NodeJS.Timeout | null;
  unsubscribeFocus: (() => void) | null;
  unsubscribeSubPages: (() => void) | null;
  prompt: string;
  /**
   * Currently-streamed page handle: `"main"` (the page the session opened
   * with) or a `"popup-N"` id from `session.subPages`. Switched by the
   * client via the `switch_page` input message and read on every screencast
   * tick so streaming follows the user's active tab. `onFocusChange` and
   * input dispatch (`mouseClick`, `keyPress`, ...) all thread this through
   * the `{page}` opt so the headless browser receives input on the same
   * page the user sees in the viewer.
   */
  activePage: string;
}

const activeViewers = new Map<string, ViewerSession>();

function startCaptureInterval(
  driver: BrowserDriver,
  session: Session,
  ws: WebSocket,
  quality: number,
  viewer: ViewerSession,
  fps: number,
): NodeJS.Timeout {
  return setInterval(
    () => {
      const handle = viewer.activePage;
      const opts = handle === 'main' ? undefined : { page: handle };
      driver
        .screenshotJpeg(session, quality, opts)
        .then((frame) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        })
        .catch(() => {
          // Session may have closed, or the active sub-page handle was
          // closed and the viewer hasn't switched off it yet. Either way
          // the next tick re-evaluates `viewer.activePage` so a recovery
          // (client switches back to main) resumes streaming.
        });
    },
    Math.round(1000 / fps),
  );
}

/**
 * Push the current sub-page list to the connected viewer client. Called on
 * connect (so the tab strip renders immediately) and from the
 * `onSubPagesChange` subscription (popup opened / closed / url-title
 * refresh). The client renders one button per entry and sends back
 * `{type: 'switch_page', id}` when the user picks one.
 */
function sendSubPagesSnapshot(ws: WebSocket, viewer: ViewerSession, subPages: SubPage[]): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    const list = subPages.map((p) => ({
      id: p.id,
      url: p.url,
      title: p.title,
      closedAt: p.closedAt,
    }));
    ws.send(
      JSON.stringify({
        type: 'sub_pages',
        active: viewer.activePage,
        list,
      }),
    );
  } catch {
    /* closed */
  }
}

// The viewer is a self-contained HTML page served by the runtime. It streams
// JPEG frames over WebSocket, forwards pointer/keyboard input, and — on devices
// with a virtual keyboard — maintains a hidden input that mirrors focus from
// the server-side page so iOS/Android can surface their native keyboard when
// the remote page has an editable element focused.
//
// Pointer events are forwarded as pointer_down/pointer_move/pointer_up and the
// server dispatches them as mouse OR touch events based on whether the session
// was created with hasTouch. This keeps modality consistent with what the
// server browser advertises — it's not about evading detection, it's about
// being truthful: if the context is mobile-emulated, input should be touch; if
// desktop, mouse.
// Served when ?v doesn't match the recomputed hash of ?token at HTTP
// page-load — the URL bytes were modified somewhere between server-mint
// and browser-load (chat renderer, clipboard extension, etc.). The token
// is dead either way (string-eq vs in-memory minted token would also
// fail), but a clear "URL was corrupted" message gives the user a
// recoverable next step instead of a silent "Disconnected."
const URL_CORRUPTED_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>klura viewer — URL corrupted</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 36em; margin: 4em auto; padding: 0 1em; line-height: 1.5; color: #222; }
  h1 { font-size: 1.4em; }
  code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
  .hint { background: #fff8e0; border-left: 3px solid #d4b400; padding: 0.7em 1em; margin: 1em 0; }
</style>
</head>
<body>
<h1>This URL got corrupted in transit</h1>
<p>The viewer URL carries a JWT signed by the klura runtime. Some byte of the URL changed between when the server minted it and when your browser loaded it — typically because a chat renderer, clipboard handler, or browser extension rewrote one or more characters of the token.</p>
<div class="hint">
  <strong>To recover:</strong> tell the agent verbatim — <em>"refresh the remote viewer"</em>. The agent will call <code>stop_remote_session</code> then <code>start_remote_session</code>. <strong>This does NOT end your drive</strong> — your browser session, captured traffic, and discovery progress all survive. You'll get a fresh URL.
</div>
<div class="hint">
  <strong>If it keeps happening:</strong> the runtime can also auto-open the URL on your machine instead of pasting it through chat. Set <code>remote.auto_open</code> to <code>"always"</code> in <code>~/.klura/config.json</code>, or have the agent call <code>configure({path: "remote.auto_open", value: "always"})</code>. Or shorten what gets relayed: <code>remote.short_url: true</code> (default) sends a 16-char redirect URL through chat instead of the full JWT.
</div>
<p>This URL is dead — the corrupted token won't authenticate. Closing this tab is safe.</p>
</body>
</html>`;

const VIEWER_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#111;display:flex;flex-direction:column;height:100vh;overflow:hidden;touch-action:none}
#stage{flex:1 1 auto;min-height:0;display:flex;justify-content:center;align-items:center;overflow:hidden}
canvas{max-width:100%;max-height:100%;cursor:pointer;touch-action:none;display:block}
#status{flex:0 0 40px;height:40px;padding:0 16px;display:flex;align-items:center;justify-content:center;gap:12px;color:#fff;font-family:system-ui;font-size:14px}
.connecting{background:#f59e0b}
.connected{background:#10b981}
.resolved{background:#6366f1}
#done-btn,#kbd-btn,#proceed-btn{display:none;padding:4px 14px;border:1px solid rgba(255,255,255,0.6);border-radius:4px;background:transparent;color:#fff;font-size:13px;cursor:pointer}
#done-btn:hover,#kbd-btn:hover,#proceed-btn:hover{background:rgba(255,255,255,0.15)}
/* Tab strip — only visible once the session has at least one popup open.
   The runtime always emits a sub_pages message with the main page on connect,
   so a single-page session never shows the strip and the layout stays
   identical to the historical viewer. */
#tabs{flex:0 0 auto;display:none;background:#1f2937;padding:6px 10px;gap:6px;overflow-x:auto;color:#fff;font-family:system-ui;font-size:12px}
#tabs.has-popups{display:flex}
.tab{flex:0 0 auto;padding:4px 10px;border:1px solid rgba(255,255,255,0.4);border-radius:4px;background:transparent;color:#fff;cursor:pointer;white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis}
.tab.active{background:rgba(99,102,241,0.45);border-color:#a5b4fc}
.tab.closed{opacity:0.4;cursor:not-allowed;text-decoration:line-through}
.tab:hover:not(.closed):not(.active){background:rgba(255,255,255,0.12)}
/* Hidden input sits off-screen but is still focusable, so iOS/Android will
   surface their native keyboard when it receives focus inside a user
   gesture. opacity:0 would also work, but position:fixed + top:-9999 is
   the most broadly compatible. */
#kbd-input{position:fixed;top:-9999px;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;margin:0;font-size:16px}
</style>
</head>
<body>
<div id="status" class="connecting">
  <span id="status-text">Connecting...</span>
  <button id="kbd-btn" type="button">Keyboard</button>
  <button id="proceed-btn" type="button">Continue anyway</button>
  <button id="done-btn" type="button">Done</button>
</div>
<div id="tabs" role="tablist" aria-label="Open pages"></div>
<div id="stage"><canvas id="screen"></canvas></div>
<input id="kbd-input" type="text" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
<script>
// Server OS is injected at serve time. Used by the macOS keyboard shim below to
// decide whether to translate Cmd/Option combos for a Linux server, or pass
// them through unchanged for a macOS server.
const SERVER_OS={{SERVER_OS}};
const canvas=document.getElementById('screen'),ctx=canvas.getContext('2d');
const kbdInput=document.getElementById('kbd-input');
const kbdBtn=document.getElementById('kbd-btn');
const proceedBtn=document.getElementById('proceed-btn');
const doneBtn=document.getElementById('done-btn');
const token=new URLSearchParams(location.search).get('token');
const proto=location.protocol==='https:'?'wss:':'ws:';
const ws=new WebSocket(proto+'//'+location.host+'/ws?token='+token);
ws.binaryType='arraybuffer';

// Client-side device detection. We only expose the virtual-keyboard UI on
// devices that actually have one; desktops use their physical keyboard via
// document.addEventListener('keydown', ...) as before.
const hasVirtualKbd=('ontouchstart' in window) && (navigator.maxTouchPoints>0);

// Tracks whether the server-side page currently has an editable element
// focused. Updated by focus-change messages from the runtime. Used inside
// gesture handlers to decide whether to synchronously focus the hidden input
// (iOS requires this to pop the keyboard).
let serverFocus=null;
// Text currently in the hidden input. We diff against this on every input event
// to emit the correct sequence of typetext/backspace messages, so autocorrect
// replacements, composed input, and paste all work uniformly.
let kbdValue='';

// Push the current viewport size up to the server so the headless browser
// resizes to match the client canvas. Sends one message on initial connect and
// a debounced one on subsequent window resizes.
let _resizeTimer=null;
function sendViewportSize(){
  // Measure the stage (canvas-hosting) area, not the whole window, so the
  // status bar's space isn't counted. On mobile, visualViewport applies the
  // post-zoom adjustment — we subtract the status bar height from it.
  const stage=document.getElementById('stage');
  const rect=stage.getBoundingClientRect();
  const w=Math.round(rect.width);
  const h=Math.round(rect.height);
  if(w<=0||h<=0)return;
  if(ws.readyState===1)ws.send(JSON.stringify({type:'viewport',width:w,height:h}));
}

ws.onopen=()=>{
  // Send device capabilities as the first message so the server can validate
  // this client matches the session's device profile.
  ws.send(JSON.stringify({
    type:'capabilities',
    maxTouchPoints:navigator.maxTouchPoints||0,
    hasTouch:('ontouchstart' in window)||(navigator.maxTouchPoints>0),
    screenWidth:screen.width,
    screenHeight:screen.height,
    devicePixelRatio:window.devicePixelRatio||1,
  }));
  // Then push initial viewport so the server browser resizes to match.
  sendViewportSize();
  setStatus('Connected','connected');
  doneBtn.style.display='block';
  if(hasVirtualKbd) kbdBtn.style.display='block';
};
window.addEventListener('resize',()=>{
  // Debounce so window dragging doesn't fire 60 setViewportSize calls/sec.
  if(_resizeTimer)clearTimeout(_resizeTimer);
  _resizeTimer=setTimeout(sendViewportSize,200);
});
window.visualViewport?.addEventListener('resize',()=>{
  if(_resizeTimer)clearTimeout(_resizeTimer);
  _resizeTimer=setTimeout(sendViewportSize,200);
});
ws.onclose=(e)=>{
  // 4002 = URL corrupted in transit (server-side integrity check).
  // Distinguish from generic disconnect so the user sees a recoverable
  // remedy instead of a silent "Disconnected."
  if(e.code===4002){
    setStatus('URL was corrupted in transit. Ask the agent for a fresh start_remote_session call and click the new URL directly.','connecting');
  }else{
    setStatus('Disconnected','connecting');
  }
  doneBtn.style.display='none';
  kbdBtn.style.display='none';
};

ws.onmessage=async(e)=>{
  if(typeof e.data==='string'){
    const msg=JSON.parse(e.data);
    if(msg.type==='resolved'){
      setStatus('Done! You can close this tab.','resolved');
      return;
    }
    if(msg.type==='prompt'){
      if(msg.text) setStatus(msg.text,'connected');
      return;
    }
    if(msg.type==='error'){
      setStatus(msg.message||'Connection rejected','connecting');
      return;
    }
    if(msg.type==='warning'){
      setStatus(msg.message||'Warning','connecting');
      proceedBtn.style.display='block';
      return;
    }
    if(msg.type==='focus'){
      serverFocus=msg.state||null;
      applyKbdInputType(serverFocus);
      // If server loses focus on an editable, drop our hidden keyboard too so
      // iOS retracts the virtual keyboard. Don't auto-focus on gain — iOS
      // blocks programmatic focus outside a user gesture.
      if(!serverFocus && document.activeElement===kbdInput) kbdInput.blur();
      return;
    }
    if(msg.type==='sub_pages'){
      renderTabs(msg.active||'main', Array.isArray(msg.list)?msg.list:[]);
      return;
    }
    return;
  }
  const blob=new Blob([e.data],{type:'image/jpeg'});
  const img=await createImageBitmap(blob);
  canvas.width=img.width;canvas.height=img.height;
  ctx.drawImage(img,0,0);
};

function send(type,props){if(ws.readyState===1)ws.send(JSON.stringify({type,...props}))}
function norm(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}}
function normTouch(t){const r=canvas.getBoundingClientRect();return{x:(t.clientX-r.left)/r.width,y:(t.clientY-r.top)/r.height}}



const tabsEl=document.getElementById('tabs');
function renderTabs(active,list){
  // Always include "main" first; the server only sends popup entries in the
  // list because session.subPages tracks sub-pages, not the main page.
  const entries=[{id:'main',label:'main',closed:false}];
  for(const p of list){
    const labelText=p.title||p.url||p.id;
    entries.push({id:p.id,label:labelText.length>40?labelText.slice(0,37)+'…':labelText,closed:typeof p.closedAt==='number'});
  }
  // Hide the strip entirely when no popup has ever been observed — keeps
  // the single-page session layout identical to the historical viewer.
  const hasPopups=list.length>0;
  tabsEl.classList.toggle('has-popups',hasPopups);
  tabsEl.textContent='';
  for(const e of entries){
    const btn=document.createElement('button');
    btn.type='button';
    btn.className='tab'+(e.id===active?' active':'')+(e.closed?' closed':'');
    btn.textContent=e.label;
    btn.title=e.id;
    btn.dataset.pageId=e.id;
    if(!e.closed&&e.id!==active){
      btn.addEventListener('click',()=>send('switch_page',{id:e.id}));
    }
    tabsEl.appendChild(btn);
  }
}

function applyKbdInputType(state){
  // Match the hidden input's type and inputmode to what the server-side focused
  // element is, so iOS shows the right keyboard layout (digits for number,
  // email layout for email, etc). Password is a special case: we flip
  // type=password so characters don't show, at the cost of letting the OS offer
  // to save (mitigated by no form wrapper + autocomplete=off).
  if(!state||!state.editable){
    kbdInput.type='text';
    kbdInput.removeAttribute('inputmode');
    return;
  }
  const t=state.inputType||'text';
  const mapping={password:'password',email:'email',tel:'tel',number:'text',url:'url',search:'search'};
  kbdInput.type=mapping[t]||'text';
  if(t==='number'){kbdInput.setAttribute('inputmode','decimal')}
  else if(state.inputMode){kbdInput.setAttribute('inputmode',state.inputMode)}
  else{kbdInput.removeAttribute('inputmode')}
}

// --- pointer forwarding --- Uses a unified pointer_* protocol; the server
// dispatches as mouse or touch based on session.hasTouch. Mouse events are only
// bound on non-touch clients to avoid synthetic mouse events that iOS fires
// after a touchend (which would double-dispatch).
let pointerDown=false;
if(!hasVirtualKbd){
  canvas.addEventListener('mousedown',e=>{pointerDown=true;send('pointer_down',norm(e))});
  canvas.addEventListener('mouseup',e=>{pointerDown=false;send('pointer_up',norm(e))});
  // Buffer latest position and flush on rAF — ~60hz cap, only when moved. Free
  // hover included (not just drag) so the server has real waypoints for
  // Catmull-Rom interpolation even before a click.
  let _pendingMove=null;
  let _lastMove={x:-1,y:-1};
  canvas.addEventListener('mousemove',e=>{_pendingMove=norm(e)});
  (function _flushMove(){requestAnimationFrame(_flushMove);if(!_pendingMove)return;const p=_pendingMove;_pendingMove=null;if(p.x===_lastMove.x&&p.y===_lastMove.y)return;_lastMove=p;send('pointer_move',p)})();
  canvas.addEventListener('wheel',e=>{e.preventDefault();send('scroll',{...norm(e),deltaX:e.deltaX,deltaY:e.deltaY})},{passive:false});
}else{
  canvas.addEventListener('touchstart',e=>{
    e.preventDefault();
    const t=e.touches[0];pointerDown=true;
    send('pointer_down',normTouch(t));
    // Synchronously in this gesture: if the server tells us an editable is
    // focused, focus the hidden input now so iOS pops its keyboard. This is the
    // key trick — focus() outside a user gesture would be ignored.
    if(serverFocus&&serverFocus.editable){
      kbdValue=kbdInput.value='';
      kbdInput.focus();
    }
  },{passive:false});
  canvas.addEventListener('touchmove',e=>{
    e.preventDefault();
    const t=e.touches[0];
    send('pointer_move',normTouch(t));
  },{passive:false});
  canvas.addEventListener('touchend',e=>{
    e.preventDefault();
    pointerDown=false;
    // touchend carries no touches[], use changedTouches for final position
    const t=e.changedTouches&&e.changedTouches[0];
    if(t)send('pointer_up',normTouch(t));
    else send('pointer_up',{x:0,y:0});
  },{passive:false});
}

// --- keyboard forwarding --- Desktop: plain document-level keydown. Mobile:
// routed through the hidden input; see diffAndSend below.
//
// The macOS keyboard shim below applies when the SERVER is Linux/Windows
// (containerized Linux Chromium, or local Linux Chrome). It intercepts
// Cmd/Option combinations on the macOS client and translates them to the
// Ctrl/Alt sequences the server actually expects. On a macOS server,
// driver.keyPress('Meta+c') already fires Command+c via Playwright's OS-aware
// keyboard, so the shim becomes a passthrough.
//
// Each translated combo emits one or more send('keypress', ...) calls in
// sequence. The server processes them in order via driver.keyPress.
if(!hasVirtualKbd){
  const isMacClient=/Mac|iPhone|iPad/.test(navigator.platform);
  const serverIsMac=SERVER_OS==='darwin';
  const shimActive=isMacClient && !serverIsMac;

  // Send a single keypress with explicit modifier flags. Server-side builds
  // Playwright combo string (Meta+Shift+a, Control+c, etc.).
  function sendKey(key,opts={}){
    send('keypress',{
      key,
      meta:!!opts.meta,
      ctrl:!!opts.ctrl,
      shift:!!opts.shift,
      alt:!!opts.alt,
    });
  }

  document.addEventListener('keydown',e=>{
    // Swallow bare Meta/Alt down-events. Never forward as standalone keypress —
    // the server would interpret them as held modifiers and get out of sync
    // with our subsequent translated sequences.
    if(e.key==='Meta'||e.key==='Alt'){
      e.preventDefault();
      return;
    }

    // Paste path is identical for all client/server combinations: read local
    // clipboard and forward as typetext. Works on both Cmd+V (mac) and Ctrl+V
    // (linux/windows clients).
    if((e.metaKey||e.ctrlKey)&&e.key==='v'){
      e.preventDefault();
      navigator.clipboard.readText().then(t=>{if(t)send('typetext',{text:t})}).catch(()=>{});
      return;
    }

    // macOS shim: translate Cmd/Option combos into the Linux equivalents the
    // server's Chromium understands. Skipped when serverIsMac.
    if(shimActive){
      const k=e.key.toLowerCase();
      const shift=e.shiftKey;

      if(e.metaKey){
        // Cmd + letter -> Ctrl + letter (clipboard, undo, select-all, etc.)
        if(k.length===1&&k>='a'&&k<='z'){
          e.preventDefault();
          sendKey(e.key.toUpperCase(),{ctrl:true,shift});
          return;
        }
        // Cmd + Backspace -> select-to-line-start then Backspace
        if(k==='backspace'){
          e.preventDefault();
          sendKey('Home',{shift:true});
          sendKey('Backspace');
          return;
        }
        // Cmd + Delete -> select-to-line-end then Delete
        if(k==='delete'){
          e.preventDefault();
          sendKey('End',{shift:true});
          sendKey('Delete');
          return;
        }
        // Cmd + arrows -> Home/End for line nav, vertical for page nav
        if(k==='arrowleft'){ e.preventDefault(); sendKey('Home',{shift}); return; }
        if(k==='arrowright'){ e.preventDefault(); sendKey('End',{shift}); return; }
        if(k==='arrowup'){ e.preventDefault(); sendKey('Home',{ctrl:true,shift}); return; }
        if(k==='arrowdown'){ e.preventDefault(); sendKey('End',{ctrl:true,shift}); return; }
        // Other Cmd combos: pass through as Ctrl + the original key so
        // server-side picks up something rather than nothing.
        e.preventDefault();
        sendKey(e.key,{ctrl:true,shift});
        return;
      }

      if(e.altKey){
        // Option + arrow -> Ctrl + arrow (word navigation)
        if(k==='arrowleft'){ e.preventDefault(); sendKey('ArrowLeft',{ctrl:true,shift}); return; }
        if(k==='arrowright'){ e.preventDefault(); sendKey('ArrowRight',{ctrl:true,shift}); return; }
        // Option + Backspace -> word-delete-back
        if(k==='backspace'){ e.preventDefault(); sendKey('Backspace',{ctrl:true}); return; }
        // Option + Delete -> word-delete-forward
        if(k==='delete'){ e.preventDefault(); sendKey('Delete',{ctrl:true}); return; }
        // Option + <letter>: macOS produces a Unicode char (Option+a = å).
        // e.key already contains the produced char. Send as typetext with NO
        // modifier so the server inserts the literal character instead of
        // treating it as Alt+<key> (which Linux Chrome reads as a menu
        // accelerator).
        if(e.key.length===1){
          e.preventDefault();
          send('typetext',{text:e.key});
          return;
        }
        // Other Option combos: pass through.
        e.preventDefault();
        sendKey(e.key,{alt:true,shift});
        return;
      }
    }

    // Default path (no shim, or modifier-free key).
    //
    // Single printable character without Ctrl/Meta → send as typetext (goes to
    // Playwright's keyboard.type/insertText, which handles arbitrary Unicode).
    // keyboard.press() only accepts a fixed set of key names, so routing 'å' /
    // 'ö' / 'ñ' / '中' through keypress drops the character. Shift and Alt are
    // intentionally folded in: Shift already produces the uppercase/symbol
    // variant in e.key, and Option+letter on macOS already produces the
    // composed char (å, ´, etc.) in e.key — both cases want the literal
    // character inserted, not a modifier combo.
    e.preventDefault();
    if(e.key.length===1 && !e.ctrlKey && !e.metaKey){
      send('typetext',{text:e.key});
      return;
    }
    send('keypress',{
      key:e.key,
      meta:e.metaKey||false,
      ctrl:e.ctrlKey||false,
      shift:e.shiftKey||false,
      alt:e.altKey||false,
    });
  });
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
}

// Manual keyboard toggle: tapping this button is itself a user gesture, so
// focus() here always works (even if serverFocus isn't editable).
kbdBtn.addEventListener('click',()=>{
  if(document.activeElement===kbdInput){kbdInput.blur()}
  else{kbdValue=kbdInput.value='';kbdInput.focus()}
});

proceedBtn.addEventListener('click',()=>{
  proceedBtn.style.display='none';
  send('proceed');
});

doneBtn.addEventListener('click',()=>{
  if(ws.readyState===1){
    send('done');
    // Let the 'done' frame flush, then close the WS explicitly so the server
    // sees a proper close frame instead of relying on the browser's
    // tab-teardown to tear the TCP connection. window.close() silently fails in
    // browsers when the tab wasn't script-opened, so it can't be trusted as the
    // sole teardown path.
    setTimeout(()=>{
      try{ws.close(1000,'user-done')}catch{}
      try{window.close()}catch{}
    },200);
  }else{
    try{window.close()}catch{}
  }
});

// Hidden-input event handling: diff kbdValue → kbdInput.value and send the
// correct sequence of typetext + backspace to the server. This covers plain
// typing, iOS autocorrect replacements (which fire input with
// inputType=insertReplacementText), paste, and composed/emoji input.
kbdInput.addEventListener('input',()=>{
  const current=kbdInput.value;
  if(current===kbdValue)return;
  // Find longest common prefix.
  let i=0;const min=Math.min(current.length,kbdValue.length);
  while(i<min && current[i]===kbdValue[i]) i++;
  // Anything after i in the old value needs to be deleted.
  const toDelete=kbdValue.length-i;
  for(let k=0;k<toDelete;k++) send('keypress',{key:'Backspace'});
  // Anything after i in the new value needs to be typed.
  const toType=current.slice(i);
  if(toType) send('typetext',{text:toType});
  kbdValue=current;
});

// Special keys that iOS fires as real keydown even inside inputs.
kbdInput.addEventListener('keydown',e=>{
  const k=e.key;
  if(k==='Enter'||k==='Tab'||k==='ArrowUp'||k==='ArrowDown'||k==='ArrowLeft'||k==='ArrowRight'||k==='Escape'){
    e.preventDefault();
    send('keypress',{key:k});
  }
});

function setStatus(msg,cls){document.getElementById('status-text').textContent=msg;document.getElementById('status').className=cls}
</script>
</body>
</html>`;

interface InputEvent {
  type: string;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
  text?: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  // capabilities message fields
  hasTouch?: boolean;
  maxTouchPoints?: number;
  screenWidth?: number;
  screenHeight?: number;
  // viewport message fields (client-driven resize)
  width?: number;
  height?: number;
  devicePixelRatio?: number;
  // switch_page message field — the sub-page handle the client wants to
  // stream and dispatch input to. `"main"` or `"popup-N"`.
  id?: string;
}

/**
 * Crockford-style base32 alphabet (no I/L/O/U), case-insensitive at decode
 * time but we always emit uppercase. Used for the short-link token; chosen
 * over base64url so a casual visual read of the token in chat doesn't trip
 * over the `_`/`-` distinction that bites the long JWT URL.
 */
const SHORT_TOKEN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SHORT_TOKEN_LENGTH = 16; // 16 * 5 = 80 bits of entropy — brute-force-resistant.
const SHORT_TOKEN_TTL_MS = 60_000; // 60s window from mint to first redirect.

function mintShortToken(): string {
  const bytes = crypto.randomBytes(SHORT_TOKEN_LENGTH);
  let out = '';
  for (let i = 0; i < SHORT_TOKEN_LENGTH; i++) {
    // bytes is always SHORT_TOKEN_LENGTH long by construction, and the
    // alphabet covers all 32 values 0..31, so this index is always defined.
    const byte = bytes[i] ?? 0;
    const ch = SHORT_TOKEN_ALPHABET[byte & 0x1f] ?? '0';
    out += ch;
  }
  return out;
}

interface ShortLinkRecord {
  token: string;
  integrity: string;
  expiresAt: number;
  consumed: boolean;
}

export async function startViewer(
  sessionId: string,
  driver: BrowserDriver,
  session: Session,
  opts: { fps?: number; quality?: number; prompt?: string; enableShortUrl?: boolean } = {},
): Promise<{
  token: string;
  integrity: string;
  localUrl: string;
  port: number;
  shortToken: string | null;
}> {
  // HS256 JWT (see ./jwt.ts) signed with ~/.klura/remote-secret.key. The
  // viewer mints once at startup and verifies on every WS upgrade.
  const token = signViewerToken({
    sid: sessionId,
    secret: getRemoteSecret(),
    ttlSeconds: 3600,
  });
  // 15fps gives visible cursor blink (~500ms period) and smooth-enough text
  // entry feedback. Below ~10fps the caret can land entirely in the gap between
  // polls and appear stuck.
  const fps = opts.fps ?? 15;
  const quality = opts.quality ?? 60;
  const prompt =
    (opts.prompt?.trim() || 'Solve the blocker') + ', then press Done or tell me in chat';

  // Inject SERVER_OS into the HTML so the client-side macOS keyboard shim knows
  // whether to translate Cmd/Option combos. process.platform returns
  // 'darwin'|'linux'|'win32'|... — we forward verbatim and the client compares
  // against 'darwin'.
  const serverOsLiteral = JSON.stringify(os.platform());
  const renderedHtml = VIEWER_HTML.replace('{{SERVER_OS}}', serverOsLiteral);

  // Short-link redirect. Maps a short opaque base32 token → the full
  // `?token=<JWT>&v=<integrity>` query string. Single-use + 60s TTL; the
  // long JWT URL is still served directly for callers who already hold
  // it (e.g. anyone who stored the auto-opened browser address bar).
  const shortToken = opts.enableShortUrl ? mintShortToken() : null;
  const integrity = tokenIntegrity(token);
  const shortLink: ShortLinkRecord | null = shortToken
    ? { token, integrity, expiresAt: Date.now() + SHORT_TOKEN_TTL_MS, consumed: false }
    : null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    // Short-link redirect: GET /r/<short> → 302 to /?token=...&v=...
    // Single-use; the record is marked consumed on first hit so a leaked
    // short URL can't be replayed.
    if (url.pathname.startsWith('/r/')) {
      const supplied = url.pathname.slice(3);
      if (!shortLink || !shortToken || supplied !== shortToken) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      if (shortLink.consumed) {
        res.writeHead(410, { 'Content-Type': 'text/plain' });
        res.end('short link already consumed — ask the agent to refresh the remote viewer');
        return;
      }
      if (Date.now() > shortLink.expiresAt) {
        res.writeHead(410, { 'Content-Type': 'text/plain' });
        res.end('short link expired — ask the agent to refresh the remote viewer');
        return;
      }
      shortLink.consumed = true;
      res.writeHead(302, {
        Location: `/?token=${shortLink.token}&v=${shortLink.integrity}`,
      });
      res.end();
      return;
    }
    // Integrity check on the page-load query string. When ?v doesn't
    // match the recomputed hash of ?token, the URL was corrupted between
    // server-mint and browser-load. Serve a short error page instead of
    // the viewer; the WS handler also rejects with code 4002 if the page
    // somehow loads anyway.
    const suppliedToken = url.searchParams.get('token');
    const suppliedV = url.searchParams.get('v');
    if (
      suppliedToken !== null &&
      suppliedV !== null &&
      suppliedV !== tokenIntegrity(suppliedToken)
    ) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(URL_CORRUPTED_HTML);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderedHtml);
  });

  const wss = new WebSocketServer({ server });

  const viewer: ViewerSession = {
    token,
    port: 0,
    sessionId,
    server,
    wss,
    viewerWs: null,
    captureInterval: null,
    unsubscribeFocus: null,
    unsubscribeSubPages: null,
    prompt,
    activePage: 'main',
  };

  // Whether to dispatch pointer events as touches (true) or mouse (false). Read
  // from the session at viewer-start time — cheap, and only ever needs to match
  // the server browser's advertised capabilities, not the client's. A desktop
  // client pressing into a touch-emulated server still dispatches as touch; a
  // mobile client pressing into a desktop server still dispatches as mouse.
  // Modality matches what the server browser tells the page it supports, which
  // is the honest thing to do.
  const touchMode = session.hasTouch === true;

  wss.on('connection', (ws, req) => {
    const connUrl = new URL(req.url ?? '/', 'http://localhost');
    const supplied = connUrl.searchParams.get('token');
    const suppliedV = connUrl.searchParams.get('v');
    // Integrity check first — distinguishes "URL got corrupted in transit"
    // (single-character change between server-mint and browser-handshake)
    // from "wrong token" (an attacker or stale session). Both reject, but
    // the corruption case has a recoverable user-facing remedy: ask the
    // agent for a fresh URL.
    if (supplied !== null && suppliedV !== tokenIntegrity(supplied)) {
      const expectedV = tokenIntegrity(supplied);
      console.error(
        `[viewer] WS rejected for session ${sessionId}: url_corrupted_in_transit\n` +
          `  reqUrl=${req.url ?? '<no-url>'}\n` +
          `  supplied v=${suppliedV ?? '<v-absent>'} but recompute(token)=${expectedV}\n` +
          `  → token bytes were modified somewhere between server-mint and browser-handshake (chat renderer, clipboard, proxy)`,
      );
      ws.close(4002, 'URL corrupted in transit');
      return;
    }
    if (supplied !== token) {
      const fp = (s: string | null): string => {
        if (s === null) return 'absent';
        const sha = crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
        const mid = s.slice(40, 60);
        return `len=${s.length} sha256[0..16]=${sha} mid[40..60]=${mid} typeof=${typeof s}`;
      };
      const reqUrl = req.url ?? '<no-url>';
      console.error(
        `[viewer] WS rejected for session ${sessionId}: token mismatch\n  reqUrl=${reqUrl}\n  expected: ${fp(token)}\n  supplied: ${fp(supplied)}`,
      );
      ws.close(4001, 'Invalid token');
      return;
    }

    viewer.viewerWs = ws;

    // Wait for the client's capabilities message before starting the session.
    // The client sends {type:'capabilities', hasTouch, maxTouchPoints,
    // screenWidth, screenHeight, devicePixelRatio} as its first message. We
    // compare these against the session's device profile and warn on mismatch
    // (fingerprint contradiction may trigger bot detection). The session still
    // starts — blocking would lock users out of their own session when they
    // only have the "wrong" device handy.
    let validated = false;

    function startViewerSession(): void {
      validated = true;
      console.error(`[viewer] Client connected for session ${sessionId} (touchMode=${touchMode})`);

      try {
        ws.send(JSON.stringify({ type: 'prompt', text: viewer.prompt }));
      } catch {
        /* closed */
      }

      driver
        .onFocusChange(
          session,
          (state: FocusState | null) => {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify({ type: 'focus', state }));
              } catch {
                /* closed */
              }
            }
          },
          viewer.activePage === 'main' ? undefined : { page: viewer.activePage },
        )
        .then((unsub) => {
          viewer.unsubscribeFocus = unsub;
        })
        .catch((err: unknown) => {
          console.warn(`[viewer] onFocusChange failed: ${String(err)}`);
        });

      // Initial sub-pages snapshot — the tab strip renders immediately
      // even when no popup ever opens (just shows "main").
      sendSubPagesSnapshot(ws, viewer, session.subPages ?? []);
      // Live updates: popup open / close / url-title refresh. Drivers
      // without sub-page support inherit the no-op default and the strip
      // never grows past "main".
      driver
        .onSubPagesChange(session, (subPages) => {
          sendSubPagesSnapshot(ws, viewer, subPages);
        })
        .then((unsub) => {
          viewer.unsubscribeSubPages = unsub;
        })
        .catch((err: unknown) => {
          console.warn(`[viewer] onSubPagesChange failed: ${String(err)}`);
        });

      viewer.captureInterval = startCaptureInterval(driver, session, ws, quality, viewer, fps);
    }

    // Ring buffer of the last 4 normalised pointer positions for Catmull-Rom
    // interpolation. Each entry is [normX, normY] as received from the client.
    const moveHistory: [number, number][] = [];

    // Handle input events from viewer
    ws.on('message', (data: Buffer) => {
      // eslint-disable-next-line sonarjs/cognitive-complexity
      void (async () => {
        try {
          const event = JSON.parse(data.toString()) as InputEvent;

          // First message must be capabilities — validate device match. Per the
          // daemon=device refactor, the daemon has exactly one device profile
          // shared by every session. The default `desktop` preset already
          // accepts touch input, so mouse↔touch on a desktop-viewport session
          // is a non-issue and doesn't warn. The case worth flagging is a
          // mobile/desktop layout mismatch: the page was laid out for a narrow
          // viewport but the client is on a wide screen, or vice versa. That's
          // the one the user can't fix post-hoc without reloading the context
          // under a different profile.
          if (event.type === 'capabilities') {
            const profile = getDeviceProfile();
            const clientWidth = event.screenWidth ?? 0;
            const profileIsMobileSize = profile.viewport.width < 500;
            const clientIsMobileSize = clientWidth > 0 && clientWidth < 500;
            const layoutMismatch = clientWidth > 0 && profileIsMobileSize !== clientIsMobileSize;
            if (layoutMismatch) {
              const clientClass = clientIsMobileSize ? 'mobile device' : 'desktop';
              const suggested = clientIsMobileSize ? 'iphone-15' : 'desktop';
              console.error(
                `[viewer] Layout mismatch warning for session ${sessionId}: ` +
                  `session=${profile.viewport.width}w, client=${clientWidth}w`,
              );
              try {
                ws.send(
                  JSON.stringify({
                    type: 'warning',
                    message:
                      `You're connecting from a ${clientClass} but this daemon spawned the browser at ` +
                      `${profile.viewport.width}×${profile.viewport.height} (${profile.name ?? 'desktop'}). ` +
                      `Input will work either way, but the page was laid out for the daemon's viewport — ` +
                      `some elements may be harder to interact with. To fix this for future sessions, run ` +
                      `\`klura device set --preset ${suggested}\` (or run a dedicated daemon for ${clientClass} ` +
                      `use via a separate KLURA_HOME). See docs/identities-and-device.md for details. ` +
                      `Continue anyway?`,
                  }),
                );
              } catch {
                /* closed */
              }
              return; // wait for 'proceed' message
            }
            startViewerSession();
            return;
          }

          // User accepted the device mismatch warning
          if (event.type === 'proceed') {
            if (!validated) {
              console.error(`[viewer] User accepted device mismatch for session ${sessionId}`);
              startViewerSession();
            }
            return;
          }

          // User clicked "Done" in the viewer — write flag file so the LLM's
          // polling loop can wake up without needing a chat message. Done is
          // ALWAYS processed, even before the device-capabilities handshake
          // resolves. A user who clicks Done on an unvalidated session is
          // saying "I'm finished, move on regardless" — waiting for `validated`
          // could silently drop the message if the capabilities exchange hasn't
          // completed yet (happens on fast captcha solves where the user clicks
          // Done within the first 1–2 seconds of opening the viewer). This
          // branch must stay above the `!validated` guard below.
          if (event.type === 'done') {
            fs.writeFileSync(`/tmp/klura-remote-done-${viewer.sessionId}`, '');
            return;
          }

          // Drop other input types until validated — keystrokes, mouse clicks,
          // viewport resizes all require a validated session because they could
          // otherwise be replayed to the wrong page or accepted from an
          // unverified client. Done is the one exception above.
          if (!validated) return;

          // Client viewport changed (initial connect or window resize). Resize
          // the headless browser's viewport to match so the screenshot pipeline
          // stays coherent. Drivers that can't resize on the fly fall back to a
          // no-op (default impl on BrowserDriver), which leaves the page at its
          // original viewport.
          if (event.type === 'viewport') {
            const w = Math.round(event.width ?? 0);
            const h = Math.round(event.height ?? 0);
            if (w > 0 && h > 0) {
              try {
                await driver.setViewport(session, w, h);
              } catch (err) {
                console.warn(`[viewer] setViewport ${w}x${h} failed: ${String(err)}`);
              }
            }
            return;
          }

          // Client picked a different sub-page from the tab strip. Switch
          // the active handle so the next screencast tick streams that
          // page; rebind onFocusChange so the mobile-keyboard-shadow
          // input stays in sync with whichever page is on screen.
          if (event.type === 'switch_page') {
            const target = typeof event.id === 'string' ? event.id : 'main';
            const list = session.subPages ?? [];
            const valid =
              target === 'main' ||
              // eslint-disable-next-line sonarjs/no-nested-functions
              list.some((p) => p.id === target && p.closedAt === undefined);
            if (!valid) {
              try {
                ws.send(
                  JSON.stringify({
                    type: 'warning',
                    message: `Cannot switch to page ${JSON.stringify(target)} — handle is unknown or already closed.`,
                  }),
                );
              } catch {
                /* closed */
              }
              return;
            }
            viewer.activePage = target;
            // Drop the old focus subscription (it was bound to the prior
            // page) and rebind on the new one.
            if (viewer.unsubscribeFocus) {
              try {
                viewer.unsubscribeFocus();
              } catch {
                /* ignore */
              }
              viewer.unsubscribeFocus = null;
            }
            try {
              const unsub = await driver.onFocusChange(
                session,
                // eslint-disable-next-line sonarjs/no-nested-functions
                (state: FocusState | null) => {
                  if (ws.readyState === WebSocket.OPEN) {
                    try {
                      ws.send(JSON.stringify({ type: 'focus', state }));
                    } catch {
                      /* closed */
                    }
                  }
                },
                target === 'main' ? undefined : { page: target },
              );
              viewer.unsubscribeFocus = unsub;
            } catch (err) {
              console.warn(`[viewer] onFocusChange rebind failed: ${String(err)}`);
            }
            // Echo the new active handle back so the client's tab strip
            // highlights the right tab even if multiple tabs were clicked
            // in quick succession.
            sendSubPagesSnapshot(ws, viewer, session.subPages ?? []);
            return;
          }

          const vp = driver.viewportSize(session);
          const x = (event.x ?? 0) * vp.width;
          const y = (event.y ?? 0) * vp.height;
          // Page-handle threading for input dispatch — every action call
          // routes through the active sub-page handle. `undefined` for
          // main keeps the historical argv shape on the common path.
          const pageOpts = viewer.activePage === 'main' ? undefined : { page: viewer.activePage };

          // Touch dispatch routes through a session-scoped CDP client today
          // and only addresses the main page; force mouse dispatch when the
          // active handle is a sub-page so popup interactions still land.
          const useTouch = touchMode && viewer.activePage === 'main';
          switch (event.type) {
            // Unified pointer protocol — translate to mouse or touch based on
            // the server context's advertised touch support.
            case 'pointer_down':
            case 'mousedown':
              if (useTouch) await driver.touchStart(session, x, y);
              else await driver.mouseDown(session, x, y, pageOpts);
              break;
            case 'pointer_move': {
              // Catmull-Rom interpolation: buffer real waypoints and
              // reconstruct the physically plausible curve the human's hand
              // actually travelled. No randomness — every interpolated point is
              // fully determined by real human positions. Steps are
              // distance-proportional so fast sweeping movement and slow
              // deliberate movement both feel natural.
              moveHistory.push([event.x ?? 0, event.y ?? 0]);
              if (moveHistory.length > 4) moveHistory.shift();
              if (useTouch) {
                await driver.touchMove(session, x, y);
              } else if (moveHistory.length < 2) {
                await driver.mouseMove(session, x, y, undefined, pageOpts);
              } else {
                // Build the 4 control points (duplicate endpoints when < 4
                // available)
                const h = moveHistory;
                const n = h.length;
                const fallback: [number, number] = h[0] ?? [0, 0];
                const p0: [number, number] = n >= 4 ? (h[n - 4] ?? fallback) : fallback;
                const p1: [number, number] = n >= 3 ? (h[n - 3] ?? fallback) : fallback;
                const p2: [number, number] = n >= 2 ? (h[n - 2] ?? fallback) : fallback;
                const p3: [number, number] = h[n - 1] ?? fallback;
                // Catmull-Rom: interpolate between p1 and p2
                const STEPS = 8;
                for (let i = 1; i <= STEPS; i++) {
                  const t = i / STEPS;
                  const t2 = t * t,
                    t3 = t2 * t;
                  const cx =
                    0.5 *
                    (2 * p1[0] +
                      (-p0[0] + p2[0]) * t +
                      (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
                      (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
                  const cy =
                    0.5 *
                    (2 * p1[1] +
                      (-p0[1] + p2[1]) * t +
                      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
                      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
                  await driver.mouseMove(
                    session,
                    cx * vp.width,
                    cy * vp.height,
                    undefined,
                    pageOpts,
                  );
                }
              }
              break;
            }
            case 'pointer_up':
            case 'mouseup':
              if (useTouch) await driver.touchEnd(session, x, y);
              else await driver.mouseUp(session, x, y, pageOpts);
              break;
            case 'tap':
            case 'click':
              if (useTouch) await driver.touchTap(session, x, y);
              else await driver.mouseClick(session, x, y, pageOpts);
              break;

            // Legacy names — kept so older viewer HTML caches don't break
            // during a soft reload. Same modality-aware dispatch.
            case 'mousemove':
              if (useTouch) await driver.touchMove(session, x, y);
              else await driver.mouseMove(session, x, y, undefined, pageOpts);
              break;

            case 'keypress':
              if (event.key) {
                // Build Playwright modifier string: "Meta+Shift+a",
                // "Control+c", etc.
                const mods: string[] = [];
                if (event.meta) mods.push('Meta');
                if (event.ctrl) mods.push('Control');
                if (event.shift) mods.push('Shift');
                if (event.alt) mods.push('Alt');
                // Don't include bare modifier keys as the final key
                const bareModifiers = ['Meta', 'Control', 'Shift', 'Alt'];
                if (bareModifiers.includes(event.key)) break;
                const combo = mods.length > 0 ? mods.join('+') + '+' + event.key : event.key;
                await driver.keyPress(session, combo, pageOpts);
              }
              break;
            case 'typetext':
              if (event.text) await driver.typeText(session, event.text, pageOpts);
              break;
            case 'scroll':
              await driver.scroll(session, x, y, event.deltaX ?? 0, event.deltaY ?? 0, pageOpts);
              break;
          }
        } catch {
          // Input failed, ignore
        }
      })();
    });

    ws.on('close', () => {
      viewer.viewerWs = null;
      if (viewer.captureInterval) clearInterval(viewer.captureInterval);
      viewer.captureInterval = null;
      if (viewer.unsubscribeFocus) {
        viewer.unsubscribeFocus();
        viewer.unsubscribeFocus = null;
      }
      if (viewer.unsubscribeSubPages) {
        viewer.unsubscribeSubPages();
        viewer.unsubscribeSubPages = null;
      }
    });
  });

  // Listen on random port
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      resolve();
    });
  });

  const addr = server.address();
  viewer.port = typeof addr === 'object' && addr ? addr.port : 0;

  activeViewers.set(sessionId, viewer);
  console.error(`[viewer] Started on port ${viewer.port} for session ${sessionId}`);

  return {
    token,
    integrity,
    localUrl: `http://localhost:${viewer.port}?token=${token}&v=${integrity}`,
    port: viewer.port,
    shortToken,
  };
}

export async function stopViewer(sessionId: string): Promise<void> {
  const viewer = activeViewers.get(sessionId);
  if (!viewer) return;

  if (viewer.captureInterval) clearInterval(viewer.captureInterval);
  if (viewer.unsubscribeFocus) {
    viewer.unsubscribeFocus();
    viewer.unsubscribeFocus = null;
  }
  if (viewer.unsubscribeSubPages) {
    viewer.unsubscribeSubPages();
    viewer.unsubscribeSubPages = null;
  }
  if (viewer.viewerWs) viewer.viewerWs.close();

  await new Promise<void>((resolve) => {
    viewer.wss.close(() => {
      viewer.server.close(() => {
        resolve();
      });
    });
  });

  activeViewers.delete(sessionId);
  console.error(`[viewer] Stopped for session ${sessionId}`);
}
