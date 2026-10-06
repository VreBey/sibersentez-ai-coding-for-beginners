// In-app actions switch (docs/actions-toggle.md §3b). The header indicator opens a small panel right under itself: the
// three modes, each with one line that says what it means, the stored one marked. Off and Preview apply at once; On
// asks inside the same panel first (a short warning with Turn on / Cancel). No native dialog, no second window.
// The panel changes the mode only through the desktop shell's bridge, window.sibersentezShell.setActionsMode(mode)
// (electron/preload.cjs). A page in a plain browser has no bridge: it cannot change the mode, and the indicator explains
// where the mode is changed instead. Either way the page reads the mode from GET /api/actions (actions.js).
// The first part is pure (state machine, keyboard map, markup, the resume record) and node-tested
// (test/actions-in-app.test.mjs); createActionsSwitch wires it to the DOM. Loading the module touches neither the DOM
// nor the network.

import { esc } from './format.js';
import { t, modeName } from './i18n.js';

export const SWITCH_MODES = Object.freeze(['off', 'dry', 'live']);
const modeOf = (m) => (SWITCH_MODES.includes(m) ? m : 'off');
const DESC_KEYS = Object.freeze({ off: 'actionsSwitchDescOff', dry: 'actionsSwitchDescDry', live: 'actionsSwitchDescLive' });

// ---------------------------------------------------------------- the bridge

// The shell's bridge when the page runs in the SiberSentez window, else null (a plain browser: the mode cannot change here)
export function shellBridge(win) {
  const b = win?.sibersentezShell;
  return b && typeof b.setActionsMode === 'function' ? b : null;
}

// QA only (?qa=1&actpanel=...): a stand-in that never reaches the shell or the server, so a headless screenshot can
// show each step. It answers "saved" (saves: true) or "refused"; nothing is ever changed through it.
export function qaBridge(saves = false) {
  return Object.freeze({
    setActionsMode: async (mode) => (saves ? { changed: true, mode, reason: 'saved' } : { changed: false, mode: null, reason: 'refused' }),
  });
}

// ---------------------------------------------------------------- state

// { open, step, current, focus, error, saved }
//   step     'choose'  the three options (error: a string id shown above them after a failed attempt)
//            'confirm' the question before On, under the options (Off and Preview can still be picked)
//            'saving'  the request is with the shell; Esc and outside clicks wait for its answer
//            'saved'   the shell saved the mode (saved); the server takes it at once (the page then learns it: 'mode'
//                      closes the panel) or, when it cannot, restarts and the window reloads by itself
//   current  the stored mode as the page knows it (GET /api/actions)
//   focus    the option that holds the keyboard focus
export function initialSwitch(current = 'off') {
  const m = modeOf(current);
  return { open: false, step: 'choose', current: m, focus: m, error: null, saved: null };
}

// The string id that explains why the shell did not change the mode (its reply: helpers.mjs panelReply)
const WRITE_ERRORS = Object.freeze({ SETTINGS_INVALID: 'actionsSwitchErrInvalid', SETTINGS_UNREADABLE: 'actionsSwitchErrRead', WRITE_FAILED: 'actionsSwitchErrWrite', NO_HUB: 'actionsSwitchErrNoHub' });
export function replyError(reply) {
  if (reply?.reason === 'busy') return 'actionsSwitchErrBusy';
  if (reply?.reason === 'write-failed') return (Object.hasOwn(WRITE_ERRORS, reply.code) && WRITE_ERRORS[reply.code]) || 'actionsSwitchErrWrite';
  return 'actionsSwitchErrOther';
}

const NONE = Object.freeze([]);
const focusOn = (target) => ({ type: 'focus', target });

function closed(s, restore) {
  const step = s.step === 'saved' ? 'saved' : 'choose';
  return { state: { ...s, open: false, step, focus: s.current, error: null }, effects: [{ type: 'closed', restore: restore === true }] };
}

// One step of the switch. Returns { state, effects }; effects, in order:
//   { type: 'set', mode }         send the mode to the shell (the caller answers with { type: 'result', reply })
//   { type: 'focus', target }     'option' (the option in state.focus) | 'cancel' (the question's Cancel) | 'status'
//   { type: 'closed', restore }   the panel closed; restore: give the focus back to where it was before it opened
// Events:
//   open { confirm? }  opens on the options, or (confirm: true, the shell handing over a menu's On) on the question
//   toggle             the indicator: opens, or closes and gives the focus back
//   close { restore? } escape  outside (a click or the focus elsewhere; the focus stays where it went)
//   pick { mode }      an option: the stored one closes; Off and Preview are sent at once; On asks first
//   confirm  cancel    the question's two buttons
//   move { by }  first  last   arrow keys, Home and End move the focus between the options (nothing is applied)
//   result { reply }   the shell's answer to 'set'
//   mode { mode }      the page learned a new stored mode (GET /api/actions)
export function switchStep(state, event) {
  const s = state || initialSwitch();
  const e = event || {};
  const busy = s.step === 'saving';
  const same = { state: s, effects: NONE };
  switch (e.type) {
    case 'open':
      if (busy || s.step === 'saved') return { state: { ...s, open: true }, effects: NONE };
      if (e.confirm === true) return { state: { ...s, open: true, step: 'confirm', focus: 'live', error: null }, effects: [focusOn('cancel')] };
      return { state: { ...s, open: true, step: 'choose', focus: s.current, error: null }, effects: [focusOn('option')] };
    case 'toggle':
      return s.open ? switchStep(s, { type: 'close', restore: true }) : switchStep(s, { type: 'open' });
    case 'close':
      return !s.open || busy ? same : closed(s, e.restore);
    case 'escape':
      if (!s.open || busy) return same;
      if (s.step === 'confirm') return { state: { ...s, step: 'choose', focus: 'live' }, effects: [focusOn('option')] };
      return closed(s, true);
    case 'outside':
      return !s.open || busy ? same : closed(s, false);
    case 'pick': {
      if (!s.open || (s.step !== 'choose' && s.step !== 'confirm') || !SWITCH_MODES.includes(e.mode)) return same;
      if (e.mode === 'live' && s.step === 'confirm') return { state: s, effects: [focusOn('cancel')] };
      if (e.mode === s.current) return closed(s, true);
      if (e.mode === 'live') return { state: { ...s, step: 'confirm', focus: 'live', error: null }, effects: [focusOn('cancel')] };
      return { state: { ...s, step: 'saving', focus: e.mode, error: null }, effects: [{ type: 'set', mode: e.mode }] };
    }
    case 'confirm':
      if (!s.open || s.step !== 'confirm') return same;
      return { state: { ...s, step: 'saving', focus: 'live', error: null }, effects: [{ type: 'set', mode: 'live' }] };
    case 'cancel':
      if (!s.open || s.step !== 'confirm') return same;
      return { state: { ...s, step: 'choose', focus: 'live' }, effects: [focusOn('option')] };
    case 'move':
    case 'first':
    case 'last': {
      if (!s.open || busy || s.step === 'saved') return same;
      const i = SWITCH_MODES.indexOf(s.focus);
      const n = SWITCH_MODES.length;
      const next = e.type === 'first' ? 0 : e.type === 'last' ? n - 1 : (((i + (e.by < 0 ? -1 : 1)) % n) + n) % n;
      return { state: { ...s, focus: SWITCH_MODES[next] }, effects: [focusOn('option')] };
    }
    case 'result': {
      if (!busy) return same;
      const r = e.reply && typeof e.reply === 'object' ? e.reply : {};
      if (r.changed === true && r.reason === 'saved' && SWITCH_MODES.includes(r.mode)) {
        // The page may have learned the new mode before this answer (the server's event came first): done
        if (s.current === r.mode) return closed({ ...s, step: 'choose', saved: null, error: null }, true);
        return { state: { ...s, open: true, step: 'saved', saved: r.mode, error: null }, effects: [focusOn('status')] };
      }
      if (r.reason === 'same') return closed({ ...s, step: 'choose', current: SWITCH_MODES.includes(r.mode) ? r.mode : s.current }, true);
      return { state: { ...s, step: 'choose', error: replyError(r) }, effects: [focusOn('option')] };
    }
    case 'mode': {
      const m = modeOf(e.mode);
      // The saved mode is in force without a restart: the panel's work is done
      if (s.step === 'saved' && m === s.saved) return closed({ ...s, step: 'choose', current: m, focus: m, saved: null }, true);
      return { state: { ...s, current: m, focus: s.open ? s.focus : m }, effects: NONE };
    }
    default:
      return same;
  }
}

// Keyboard inside the open switch: the event for a key, or null (the key keeps its own meaning, e.g. Tab, Enter)
export function switchKey(key, step) {
  if (key === 'Escape') return { type: 'escape' };
  if (step !== 'choose' && step !== 'confirm') return null;
  if (key === 'ArrowDown' || key === 'ArrowRight') return { type: 'move', by: 1 };
  if (key === 'ArrowUp' || key === 'ArrowLeft') return { type: 'move', by: -1 };
  if (key === 'Home') return { type: 'first' };
  if (key === 'End') return { type: 'last' };
  return null;
}

// ---------------------------------------------------------------- markup

// The indicator's texts: its visible text, its accessible name and its tooltip. With the bridge the indicator opens the
// panel; without it (a plain browser) the tooltip says where the mode is changed.
export function indicatorModel(mode, canChange) {
  const text = t('actionsIndicator', { mode: modeName(modeOf(mode)) });
  if (canChange) return { text, label: text, title: `${text}. ${t('actionsSwitchTip')}` };
  const title = `${text}. ${t('actionsHowTo')}`;
  return { text, label: title, title };
}

const busyAttr = (on) => (on ? ' aria-disabled="true"' : '');

// The panel's inner markup for a state (the panel element itself carries role="dialog" and aria-labelledby)
export function switchHtml(state) {
  const s = state || initialSwitch();
  const locked = s.step === 'saving' || s.step === 'saved';
  const options = SWITCH_MODES.map((m) => {
    const cur = m === s.current;
    const cls = `asw-opt m-${m}${cur ? ' is-current' : ''}${s.step === 'confirm' && m === 'live' ? ' is-asking' : ''}`;
    const now = cur ? ` <span class="asw-now">${esc(t('actionsSwitchCurrent'))}</span>` : '';
    return (
      `<button type="button" class="${cls}" role="radio" aria-checked="${cur}" tabindex="${m === s.focus ? 0 : -1}" data-asw-mode="${m}" data-asw-key="option:${m}" aria-describedby="aswDesc-${m}"${busyAttr(locked)}>` +
      `<span class="asw-dot" aria-hidden="true"></span>` +
      `<span class="asw-text"><span class="asw-name">${esc(modeName(m))}${now}</span><span class="asw-desc" id="aswDesc-${m}">${esc(t(DESC_KEYS[m]))}</span></span>` +
      `</button>`
    );
  }).join('');
  const error = s.error && s.step === 'choose' ? `<p class="asw-error" role="alert">${esc(t(s.error))}</p>` : '';
  const asking = s.step === 'confirm' || (s.step === 'saving' && s.focus === 'live');
  const confirm = asking
    ? `<div class="asw-confirm" role="group" aria-labelledby="aswConfirmTitle" aria-describedby="aswConfirmBody">` +
      `<p class="asw-confirm-title" id="aswConfirmTitle">${esc(t('actionsSwitchConfirmTitle'))}</p>` +
      `<p class="asw-confirm-body" id="aswConfirmBody">${esc(t('actionsSwitchConfirmBody'))}</p>` +
      `<div class="asw-confirm-btns">` +
      `<button type="button" class="act-btn" data-asw-act="cancel" data-asw-key="cancel"${busyAttr(locked)}>${esc(t('actionsSwitchConfirmCancel'))}</button>` +
      `<button type="button" class="act-btn danger" data-asw-act="confirm" data-asw-key="confirm"${busyAttr(locked)}>${esc(t('actionsSwitchConfirmOk'))}</button>` +
      `</div></div>`
    : '';
  const statusText = s.step === 'saving' ? t('actionsSwitchSaving') : s.step === 'saved' ? t('actionsSwitchSaved', { mode: modeName(s.saved) }) : '';
  const status = `<p class="asw-status${statusText ? '' : ' is-empty'}" role="status" tabindex="-1" data-asw-key="status">${esc(statusText)}</p>`;
  return (
    `<div class="asw-head"><h2 class="asw-title" id="actPanelTitle">${esc(t('actionsSwitchTitle'))}</h2>` +
    `<p class="asw-intro" id="actPanelIntro">${esc(t('actionsSwitchIntro'))}</p></div>` +
    error +
    `<div class="asw-options" role="radiogroup" aria-labelledby="actPanelTitle">${options}</div>` +
    confirm +
    status +
    `<p class="asw-note">${esc(t('actionsSwitchNote'))}</p>`
  );
}

// ---------------------------------------------------------------- where the user was, across the reload

// A mode change restarts the panel server and the shell reloads the window. The tab and the open drawer are kept in
// this window's sessionStorage when the page goes away, and put back once after the next load.
export const RESUME_KEY = 'sibersentez.resume';
const RESUME_TYPES = Object.freeze(['project', 'session', 'agent', 'roster']);
const RESUME_SECTIONS = Object.freeze(['skills', 'install']);

// Keep the place only for a reload that follows a restart: a mode change asked from the panel, or a server that went
// away while this page was open (a change from the tray, a crash). A manual reload of a healthy page starts fresh.
export function keepPlace({ switching = false, serverLost = false } = {}) {
  return switching === true || serverLost === true;
}

function cleanTarget(d) {
  if (!d || typeof d !== 'object' || !RESUME_TYPES.includes(d.type)) return null;
  if (typeof d.id !== 'string' || !d.id || d.id.length > 512) return null;
  const out = { type: d.type, id: d.id };
  if (RESUME_SECTIONS.includes(d.section)) out.section = d.section;
  return out;
}

// The record to store: JSON of { tab, drawer }, or null when there is nothing worth keeping
export function resumeRecord({ tab, drawer } = {}, tabs = []) {
  const rec = { tab: tabs.includes(tab) ? tab : null, drawer: cleanTarget(drawer) };
  return rec.tab || rec.drawer ? JSON.stringify(rec) : null;
}

// The stored record read back; anything unexpected reads as nothing
export function readResume(raw, tabs = []) {
  const none = { tab: null, drawer: null };
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return none;
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return none;
  }
  if (!v || typeof v !== 'object') return none;
  return { tab: tabs.includes(v.tab) ? v.tab : null, drawer: cleanTarget(v.drawer) };
}

// ---------------------------------------------------------------- DOM

// Wires the switch to the indicator button and its panel element.
//   bridge         shellBridge(window) (or qaBridge in QA); null: the indicator only explains (onUnavailable)
//   getMode()      the stored mode as the page knows it
//   onUnavailable  called for a click without a bridge (main.js shows the how-to)
// Returns { render, setMode, open, confirmLive, isOpen, pendingReload, state }.
export function createActionsSwitch({ button, panel, bridge = null, getMode = () => 'off', onUnavailable = () => {}, doc = document }) {
  const wrap = panel?.parentElement && panel.parentElement.contains(button) ? panel.parentElement : null;
  let state = initialSwitch(getMode());
  let opener = null;
  let swallowUntil = 0;

  function render() {
    if (!button) return;
    const m = indicatorModel(state.current, Boolean(bridge));
    button.dataset.mode = state.current;
    button.innerHTML = `<i aria-hidden="true"></i><span>${esc(m.text)}</span>`;
    button.title = m.title;
    button.setAttribute('aria-label', m.label);
    if (bridge && panel) {
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', panel.id);
      button.setAttribute('aria-expanded', String(state.open));
    }
    // On is the normal state (docs/simplify.md): the indicator shows only when actions are off or in Preview, or while
    // its panel is open (the Settings' "Change" opens it from there)
    button.hidden = state.current === 'live' && !state.open;
  }

  function renderPanel() {
    if (!panel) return;
    panel.hidden = !state.open;
    if (!state.open) return;
    const active = doc.activeElement;
    const key = active && panel.contains(active) ? active.dataset?.aswKey : null;
    const html = switchHtml(state);
    if (panel._html !== html) {
      panel._html = html;
      panel.innerHTML = html;
      if (key) panel.querySelector(`[data-asw-key="${key}"]`)?.focus({ preventScroll: true });
    }
  }

  function focusTarget(target) {
    const sel = target === 'option' ? `[data-asw-key="option:${state.focus}"]` : `[data-asw-key="${target}"]`;
    panel?.querySelector(sel)?.focus({ preventScroll: true });
  }

  function restoreFocus() {
    const back = opener && opener.isConnected && !opener.closest?.('[inert],[hidden]') ? opener : button;
    opener = null;
    back?.focus?.({ preventScroll: true });
  }

  // Who waits for the shell's answer besides the panel: the drawer's "Turn actions on and install" (turnOn)
  let waiting = null;
  async function send(mode) {
    let reply;
    try {
      reply = await bridge.setActionsMode(mode);
    } catch {
      reply = { changed: false, mode: null, reason: 'error' };
    }
    dispatch({ type: 'result', reply });
    const w = waiting;
    waiting = null;
    w?.(reply);
  }

  function dispatch(event) {
    const wasOpen = state.open;
    if (!wasOpen && (event.type === 'open' || event.type === 'toggle')) {
      const a = doc.activeElement;
      opener = a && a !== doc.body && !wrap?.contains(a) ? a : button;
    }
    const { state: next, effects } = switchStep(state, event);
    state = next;
    render();
    renderPanel();
    for (const fx of effects) {
      if (fx.type === 'focus') focusTarget(fx.target);
      else if (fx.type === 'closed' && fx.restore) restoreFocus();
      else if (fx.type === 'closed') opener = null;
      else if (fx.type === 'set' && bridge) send(fx.mode);
    }
    return effects;
  }

  button?.addEventListener('click', () => {
    if (!bridge) return onUnavailable();
    dispatch({ type: 'toggle' });
  });

  panel?.addEventListener('click', (e) => {
    const opt = e.target.closest?.('[data-asw-mode]');
    if (opt) return dispatch({ type: 'pick', mode: opt.dataset.aswMode });
    const act = e.target.closest?.('[data-asw-act]');
    if (act) dispatch({ type: act.dataset.aswAct === 'confirm' ? 'confirm' : 'cancel' });
  });

  // While open the switch owns the keyboard: no global shortcut (tabs, replay, the drawer's Esc) sees these keys
  (wrap || panel)?.addEventListener('keydown', (e) => {
    if (!state.open) return;
    e.stopPropagation();
    const ev = switchKey(e.key, state.step);
    if (!ev) return;
    e.preventDefault();
    // From the indicator itself the arrows step into the panel
    if (ev.type !== 'escape' && !panel.contains(e.target)) return focusTarget('option');
    dispatch(ev);
  });

  // The focus left the switch (Tab, a click elsewhere): close without pulling the focus back
  (wrap || panel)?.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    if (state.open && to && !(wrap || panel).contains(to)) dispatch({ type: 'outside' });
  });

  // A click outside closes the panel and does nothing else: the click that closes it is not passed on
  doc.addEventListener(
    'pointerdown',
    (e) => {
      if (!state.open || (wrap || panel).contains(e.target) || button?.contains(e.target)) return;
      const effects = dispatch({ type: 'outside' });
      if (!effects.some((fx) => fx.type === 'closed')) return;
      e.stopPropagation();
      swallowUntil = Date.now() + 700;
    },
    true,
  );
  for (const type of ['click', 'auxclick', 'contextmenu']) {
    doc.addEventListener(
      type,
      (e) => {
        if (Date.now() > swallowUntil) return;
        if (type === 'click' || type === 'auxclick') swallowUntil = 0;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
  }

  // The indicator stays hidden until the first setMode (the mode is known once GET /api/actions answered)
  return {
    render,
    setMode(mode) {
      dispatch({ type: 'mode', mode });
    },
    open() {
      if (bridge) dispatch({ type: 'open' });
    },
    // The shell hands a menu's On over (PANEL_CONFIRM_LIVE_SCRIPT): open on the question. true when it is shown.
    confirmLive() {
      if (!bridge || state.step === 'saving' || state.step === 'saved') return false;
      dispatch({ type: 'open', confirm: true });
      return state.open && state.step === 'confirm';
    },
    // The drawer's "Turn actions on and install" (docs/direction.md §3.2): the drawer asked its own question, with this
    // switch's words for what On does, so the switch goes from its question straight to saving On, through its one
    // bridge call, and shows it like any change. Resolves with the shell's reply ({ changed, mode, reason, code? }).
    turnOn() {
      if (!bridge || state.step === 'saving' || state.step === 'saved' || waiting) return Promise.resolve({ changed: false, mode: null, reason: 'busy' });
      return new Promise((resolve) => {
        waiting = resolve;
        dispatch({ type: 'open', confirm: true });
        if (dispatch({ type: 'confirm' }).some((fx) => fx.type === 'set')) return;
        waiting = null;
        resolve({ changed: false, mode: null, reason: 'error' });
      });
    },
    isOpen: () => state.open,
    pendingReload: () => state.step === 'saving' || state.step === 'saved',
    state: () => state,
  };
}
