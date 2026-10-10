// @ts-check
// QA mode, the hidden QA run and the window's options (plan D8: from helpers.mjs, which re-exports it). Pure, no
// Electron.
import path from 'node:path';
import { checkLocalDir } from './shell-paths.mjs';

// ---------------------------------------------------------------- QA mode

// QA variables are honoured in development, and in a packaged build only together with the --qa switch.
export function readQaOptions({ env = {}, argv = [], isPackaged = false } = {}) {
  const text = (k) => (typeof env[k] === 'string' ? env[k].trim() : '');
  const int = (k) => {
    const n = Number(text(k));
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const off = { enabled: false, ignored: false, rejected: null, shot: null, quitMs: 0, delayMs: 5000 };
  const requested = Boolean(text('SIBERSENTEZ_QA_SHOT') || text('SIBERSENTEZ_QA_QUIT_MS'));
  if (!requested) return off;
  if (isPackaged && !argv.includes('--qa')) return { ...off, ignored: true };
  let shot = null;
  let rejected = null;
  const rawShot = text('SIBERSENTEZ_QA_SHOT');
  if (rawShot) {
    const dir = checkLocalDir(path.dirname(rawShot));
    if (dir.ok && /\.png$/i.test(rawShot)) shot = path.join(dir.path, path.basename(rawShot));
    else rejected = dir.ok ? 'screenshot must be a .png file' : `screenshot folder: ${dir.reason}`;
  }
  const quitMs = int('SIBERSENTEZ_QA_QUIT_MS');
  return { enabled: Boolean(shot || quitMs), ignored: false, rejected, shot, quitMs, delayMs: int('SIBERSENTEZ_QA_DELAY_MS') || 5000 };
}

// SIBERSENTEZ_QA_ACTIONS=off|dry: in QA mode only (qa = readQaOptions(...)), the shell switches the actions mode through
// the tray's own code path after the first page load. 'live' is refused: QA never runs real actions.
// Returns { mode: 'off' | 'dry' | null, rejected: null | reason }.
/** @param {{ env?: Record<string, string | undefined>, qa?: any }} [options] */
export function readQaActionsMode({ env = {}, qa = null } = {}) {
  const v = typeof env.SIBERSENTEZ_QA_ACTIONS === 'string' ? env.SIBERSENTEZ_QA_ACTIONS.trim().toLowerCase() : '';
  if (!v || !qa?.enabled) return { mode: null, rejected: null };
  if (v === 'off' || v === 'dry') return { mode: v, rejected: null };
  return { mode: null, rejected: v === 'live' ? 'SIBERSENTEZ_QA_ACTIONS=live is refused (QA never runs real actions)' : 'SIBERSENTEZ_QA_ACTIONS must be off or dry' };
}

// ---------------------------------------------------------------- the hidden QA run (SIBERSENTEZ_QA_HIDDEN)

// Settings of a QA run that shows nothing (the person at this computer keeps working while it runs). All of them only in
// QA mode (qa = readQaOptions(...)); outside it they are ignored:
//   SIBERSENTEZ_QA_HIDDEN=1        the window is never shown (windowOptions, windowShowPlan), no tray icon (createsTray),
//                               no native dialog (guardDialogs), no notifications (permissionAllowed), no external
//                               program (openExternal, openPath)
//   SIBERSENTEZ_QA_PROBES=1        after the first page load the shell runs its fixed QA probes and quits (main.mjs runQaProbes)
//   SIBERSENTEZ_QA_PROJECT_DIR     hidden runs only: a local folder the probes add as a project through the server's
//                               message channel, the picker's own path without the picker (never shown in the log)
// Returns { hidden, probes, projectDir, rejected }.
export function readQaShellOptions({ env = {}, qa = null } = {}) {
  const text = (k) => (typeof env[k] === 'string' ? env[k].trim() : '');
  const off = { hidden: false, probes: false, projectDir: null, rejected: null };
  if (!qa?.enabled) return off;
  const hidden = text('SIBERSENTEZ_QA_HIDDEN') === '1';
  const probes = text('SIBERSENTEZ_QA_PROBES') === '1';
  let projectDir = null;
  let rejected = null;
  const raw = text('SIBERSENTEZ_QA_PROJECT_DIR');
  if (raw && !hidden) rejected = 'SIBERSENTEZ_QA_PROJECT_DIR needs SIBERSENTEZ_QA_HIDDEN=1';
  else if (raw) {
    const c = checkLocalDir(raw);
    if (c.ok) projectDir = c.path;
    else rejected = `SIBERSENTEZ_QA_PROJECT_DIR: ${c.reason}`;
  }
  return { hidden, probes, projectDir, rejected };
}

// Where a window that is never shown sits: far outside every screen, in case anything ever showed it anyway
export const QA_HIDDEN_POSITION = -32000;

// The look the page chose in Settings (public/js/theme.js, docs/theme.md): the window's title bar follows it
// (nativeTheme.themeSource) and so does the colour the window shows before the page paints
export const THEME_IPC_CHANNEL = 'sibersentez:set-theme';
export const THEME_CHOICES = Object.freeze(['dark', 'light', 'system']);
export const WINDOW_BACKGROUND = Object.freeze({ dark: '#0c0e14', light: '#F2F5F8' });

// The main window's options. A hidden QA run: never shown (show: false), no taskbar button, placed off screen; it still
// paints while hidden (paintWhenInitiallyHidden) and is not throttled in the background, so the page runs its timers
// and capturePage works.
export function windowOptions({ qaHidden = false, preload = undefined, icon = undefined, devTools = false } = {}) {
  const options = {
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'SiberSentez',
    icon,
    backgroundColor: WINDOW_BACKGROUND.dark,
    autoHideMenuBar: true,
    webPreferences: {
      // One preload for the window's three bridge functions (electron/preload.cjs); sandboxed, isolated, top frame only
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      devTools: devTools === true,
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      paintWhenInitiallyHidden: true,
    },
  };
  if (qaHidden === true) {
    Object.assign(options, { x: QA_HIDDEN_POSITION, y: QA_HIDDEN_POSITION, skipTaskbar: true });
    options.webPreferences.backgroundThrottling = false;
  }
  return options;
}

// What the shell does with the window once it is ready to show, and whenever something asks to bring it up:
//   'never'     a hidden QA run: nothing ever shows it (the request is only logged)
//   'inactive'  a visible QA run: shown without taking the focus
//   'show'      a normal start       'stay'  a start with --hidden (at login): it stays in the tray until opened
// bringUp: a later request (tray, second launch, a hand-over), which shows the window unless the run is hidden.
export function windowShowPlan({ qa = false, qaHidden = false, startHidden = false, bringUp = false } = {}) {
  if (qa && qaHidden) return 'never';
  if (bringUp) return 'show';
  if (qa) return 'inactive';
  return startHidden ? 'stay' : 'show';
}

// Whether the shell puts its icon in the tray: never in a hidden QA run
export function createsTray({ qaHidden = false } = {}) {
  return qaHidden !== true;
}

// Electron's dialog module as main.mjs uses it. A hidden QA run opens no native dialog at all: each call is logged and
// answered as if cancelled (showMessageBox: the cancel button, or 0; showOpenDialog: canceled; showErrorBox: nothing).
// Otherwise the calls go to Electron unchanged.
export function guardDialogs(dialog, { hidden = false, log = (_line) => {} } = {}) {
  if (hidden !== true) {
    return {
      showMessageBox: (...args) => dialog.showMessageBox(...args),
      showOpenDialog: (...args) => dialog.showOpenDialog(...args),
      showSaveDialog: (...args) => dialog.showSaveDialog(...args),
      showErrorBox: (...args) => dialog.showErrorBox(...args),
    };
  }
  const optionsOf = (args) => args.find((a) => a && typeof a === 'object' && !Array.isArray(a) && ('buttons' in a || 'message' in a)) || {};
  return {
    showMessageBox: async (...args) => {
      const o = optionsOf(args);
      log('QA hidden: native message box skipped');
      return { response: Number.isInteger(o.cancelId) ? o.cancelId : 0, checkboxChecked: false };
    },
    showOpenDialog: async () => {
      log('QA hidden: native folder picker skipped');
      return { canceled: true, filePaths: [] };
    },
    showSaveDialog: async () => {
      log('QA hidden: native save dialog skipped');
      return { canceled: true, filePath: '' };
    },
    showErrorBox: () => {
      log('QA hidden: native error box skipped');
    },
  };
}

// The QA probes' scripts, run in the page with webContents.executeJavaScript. Fixed text, no data from anywhere.
//   BRIDGE   which functions window.sibersentezShell has: "name:type" sorted and joined by ',' ('missing' without it)
//   KIT      skills and agents of the SiberSentez kit in the roster of /api/snapshot: '{"skill":n,"agent":n}'. The
//            roster is read once the logs are (server/index.mjs): asked every second, at most 30 times (a computer
//            with many logs took 12 s, 2026-10-09)
//   PANEL    whether the actions panel under the header indicator is open: 'open' | 'closed' | 'missing'
//   ACTIONS  setActionsMode(mode) through the bridge, the page's own path; resolves the shell's reply as JSON
export const QA_BRIDGE_PROBE_SCRIPT =
  "(() => { const s = window.sibersentezShell; if (!s) return 'missing'; return Object.keys(s).sort().map((k) => k + ':' + typeof s[k]).join(','); })()";
export const QA_KIT_PROBE_SCRIPT =
  "(async () => { let out = 'error'; for (let i = 0; i < 30; i++) { try { const s = await (await fetch('/api/snapshot')).json(); const kit = (s.roster || []).filter((x) => (x.sources || []).includes('kit')); out = JSON.stringify({ skill: kit.filter((x) => x.kind === 'skill').length, agent: kit.filter((x) => x.kind === 'agent').length }); if (kit.length) return out; } catch {} await new Promise((r) => setTimeout(r, 1000)); } return out; })()";
// The versions Settings copies for a problem report (GET /api/about): the packaged server reads package.json in app.asar
export const QA_ABOUT_PROBE_SCRIPT = "fetch('/api/about').then((r) => r.text(), () => 'error')";
export const QA_PANEL_PROBE_SCRIPT =
  "(() => { const p = document.querySelector('#actPanel'); if (!p) return 'missing'; const r = p.getBoundingClientRect(); return !p.hidden && r.width > 0 && r.height > 0 ? 'open' : 'closed'; })()";
export const QA_ACTIONS_SCRIPTS = Object.freeze({
  off: "window.sibersentezShell.setActionsMode('off').then((r) => JSON.stringify(r), () => 'error')",
  dry: "window.sibersentezShell.setActionsMode('dry').then((r) => JSON.stringify(r), () => 'error')",
  live: "window.sibersentezShell.setActionsMode('live').then((r) => JSON.stringify(r), () => 'error')",
});
// What the page's server says the actions mode is now (after a switch taken in place): the status and the mode only,
// never the token
export const QA_SERVED_MODE_SCRIPT =
  "fetch('/api/actions', { cache: 'no-store' }).then(async (r) => JSON.stringify({ status: r.status, mode: r.ok ? (await r.json()).mode : 'off' }), () => 'error')";
// The page the panel probe loads: the panel's own QA hook (public/js/main.js, ?qa=1&actpanel=choose)
export const QA_PANEL_PATH = '/?qa=1&actpanel=choose';
// The next step on a laptop screen (docs/internal/development-review-2026-10-06.md §3): the window is set to 1366 x 768 and the
// building page loaded. The strip is shown, in the first screen, as wide as it can be without a sideways scroll, says
// something, and comes first for the keyboard: its button (when it has one) before every other control of the
// building, and it takes the focus; no control of the building jumps the order with a positive tabindex. '{"shown":true,...}' or 'missing' (no strip yet).
export const QA_LAPTOP_SIZE = Object.freeze({ width: 1366, height: 768 });
export const QA_LAPTOP_PATH = '/?qa=1';
// The page's own size: the window is corrected by the difference (an off-screen window's size can differ a few
// pixels from the page's after the screen scale is applied)
export const QA_VIEWPORT_SCRIPT = 'JSON.stringify([innerWidth, innerHeight])';
// The building's example (its play button): a step with a button, so the keyboard check has one to find first
// The keyboard on the page (review U01, U03): real key events (main.mjs qaKeyboardProbe) and these fixed reads. The
// search dialog keeps Tab inside and closes on Escape with focus back to its button; the menu's down arrow moves to
// the next screen button. Each returns a JSON text or a boolean; nothing is changed but focus.
export const QA_KEYS_SCRIPTS = Object.freeze({
  focusSearch: "(() => { const b = document.getElementById('paletteBtn'); if (b) b.focus(); return document.activeElement === b; })()",
  searchState: "JSON.stringify({ open: !document.querySelector('.palette-wrap')?.hidden, inInput: document.activeElement === document.querySelector('.palette input'), focus: document.activeElement?.id || document.activeElement?.tagName || null })",
  focusMenu: "(() => { const b = document.querySelector('.side-nav [data-tab=\"today\"]'); if (b) b.focus(); return document.activeElement === b; })()",
  menuState: "JSON.stringify({ focus: document.activeElement?.dataset?.tab || null, current: [...document.querySelectorAll('[aria-current=\"page\"]')].map((b) => b.dataset.tab), tabRoles: document.querySelectorAll('.side [role=\"tab\"], .side [role=\"tablist\"], section.panel[role=\"tabpanel\"]').length })",
});
export const QA_LAPTOP_DEMO_SCRIPT = "(() => { const b = document.querySelector('[data-ws=\"play\"]'); if (!b) return 'missing'; b.click(); return 'started'; })()";
export const QA_LAPTOP_PROBE_SCRIPT =
  "(() => { const s = document.querySelector('[data-ws=\"next\"]'); if (!s) return 'missing'; const r = s.getBoundingClientRect(); const text = (s.querySelector('[data-ws=\"next-text\"]')?.textContent || '').trim(); const go = s.querySelector('[data-ws=\"next-go\"]'); const root = s.parentElement; const focusables = [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter((e) => !e.hidden && !e.disabled && e.tabIndex >= 0 && e.getClientRects().length); const first = focusables[0] || null; let focused = null; if (go && !go.hidden) { go.focus(); focused = document.activeElement === go; go.blur(); } return JSON.stringify({ shown: r.width > 0 && r.height > 0, firstScreen: r.top >= 0 && r.bottom <= innerHeight, inWidth: r.left >= 0 && r.right <= innerWidth + 0.5, noSideScroll: document.documentElement.scrollWidth <= innerWidth, text: text.length > 0, oneLineFits: s.scrollWidth <= s.clientWidth + 1, keyboardFirst: !focusables.some((e) => e.tabIndex > 0) && (go && !go.hidden ? first === go && focused === true : !first || !s.contains(first) || first === go), step: s.dataset.step || '', width: innerWidth, height: innerHeight }); })()";
