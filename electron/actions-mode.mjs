// The actions mode: the tray's switch, its menus, the in-app panel's request and the confirmation for On
// (docs/actions-toggle.md; plan D8: from helpers.mjs, which re-exports it). Pure, no Electron.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../server/atomic.mjs';
import { HUB_SETTINGS_FILE } from './shell-paths.mjs';
import { isAppUrl } from './shell-policy.mjs';

// ---------------------------------------------------------------- actions mode (docs/actions-toggle.md)

// Modes of the server's action layer; the server reads <hub>\settings.json "actions" (server/hub.mjs)
export const ACTION_MODES = Object.freeze(['off', 'dry', 'live']);

// The server's rule: off|dry|live after trimming, in any case; anything else is off
export function normalizeActionsMode(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ACTION_MODES.includes(v) ? v : 'off';
}

// <hub>\settings.json as an object: { ok: true, file, data, exists } or { ok: false, code, detail?, file? }.
//   NO_HUB               the hub folder is missing or not a folder (it is never created here)
//   SETTINGS_UNREADABLE  the file exists but cannot be read (a folder, no access, ...)
//   SETTINGS_INVALID     the file is not a JSON object (a byte order mark is tolerated)
// A missing file is fine: { ok: true, data: {}, exists: false }.
function readHubSettings(hubPath, fsImpl = fs) {
  if (typeof hubPath !== 'string' || !hubPath.trim()) return { ok: false, code: 'NO_HUB' };
  let isDir = false;
  try {
    isDir = fsImpl.statSync(hubPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { ok: false, code: 'NO_HUB' };
  const file = path.join(hubPath, HUB_SETTINGS_FILE);
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, file, data: {}, exists: false };
    return { ok: false, code: 'SETTINGS_UNREADABLE', detail: e?.code || 'error', file };
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, code: 'SETTINGS_INVALID', file };
  return { ok: true, file, data, exists: true };
}

// The stored mode, for the tray's radio items. Any problem reads as off, like the server.
export function readHubActionsSetting(hubPath, fsImpl = fs) {
  const r = readHubSettings(hubPath, fsImpl);
  return r.ok ? normalizeActionsMode(r.data.actions) : 'off';
}

export const tempSuffix = () => `${process.pid}-${randomBytes(6).toString('hex')}`;

// Sets "actions" in <hub>\settings.json and keeps every other key and value. Atomic: the full new text goes to a
// new temporary file next to settings.json ('wx', never an existing file), which then replaces settings.json in a
// single rename; settings.json itself is never opened for writing, so it is either the old or the new text.
// A file that exists but cannot be read is never touched; one that cannot be parsed is kept aside as
// settings.json.broken before a new one is written (writeHubSetting). The hub folder is never created.
// Returns { ok: true, file } or { ok: false, code: INVALID_MODE | NO_HUB | SETTINGS_UNREADABLE | SETTINGS_INVALID |
// WRITE_FAILED, detail?, file? }. fsImpl and suffix are injectable for tests.
export function writeHubActionsSetting(hubPath, mode, { fsImpl = fs, suffix = tempSuffix } = {}) {
  if (!ACTION_MODES.includes(mode)) return { ok: false, code: 'INVALID_MODE' };
  return writeHubSetting(hubPath, (data) => ({ ...data, actions: mode }), { fsImpl, suffix });
}

// The language the person chose in Settings (docs/shell.md): 'en' or 'tr' sets "language"; 'auto' removes the key
// (SiberSentez then follows Windows). Same atomic write and the same refusals as writeHubActionsSetting.
export const LANGUAGE_CHOICES = Object.freeze(['auto', 'en', 'tr']);
export const LANGUAGE_IPC_CHANNEL = 'sibersentez:set-language';
export function writeHubLanguageSetting(hubPath, lang, { fsImpl = fs, suffix = tempSuffix } = {}) {
  if (!LANGUAGE_CHOICES.includes(lang)) return { ok: false, code: 'INVALID_LANGUAGE' };
  return writeHubSetting(
    hubPath,
    (data) => {
      const { language, ...rest } = data;
      return lang === 'auto' ? rest : { ...rest, language: lang };
    },
    { fsImpl, suffix },
  );
}

// settings.json with one change (update: data -> new data), written atomically (see writeHubActionsSetting). A file
// that cannot be parsed is not overwritten: when the person changes a setting it is kept aside, byte for byte, as
// settings.json.broken (settings.json.broken-2 ... when that name is taken, like the hub's other broken files), then a
// new settings.json is written from nothing. Returns keptAside (the new name) when that happened.
function writeHubSetting(hubPath, update, { fsImpl = fs, suffix = tempSuffix, wait } = {}) {
  let cur = readHubSettings(hubPath, fsImpl);
  let keptAside = null;
  if (!cur.ok && cur.code === 'SETTINGS_INVALID') {
    keptAside = brokenName(cur.file, fsImpl);
    if (!keptAside) return cur;
    try {
      fsImpl.renameSync(cur.file, keptAside);
    } catch (e) {
      return { ...cur, detail: e?.code || 'error' };
    }
    cur = { ok: true, file: cur.file, data: {}, exists: false };
  }
  if (!cur.ok) return cur;
  const text = JSON.stringify(update(cur.data), null, 2) + '\n';
  const tmp = path.join(path.dirname(cur.file), `${HUB_SETTINGS_FILE}.${suffix()}.tmp`);
  try {
    writeFileAtomic(cur.file, text, { fsImpl, tmp, wait });
  } catch (e) {
    return { ok: false, code: 'WRITE_FAILED', detail: e?.code || 'error', file: cur.file, ...(keptAside ? { keptAside } : {}) };
  }
  return keptAside ? { ok: true, file: cur.file, keptAside } : { ok: true, file: cur.file };
}

// A free name next to a broken file: <file>.broken, then <file>.broken-2 ... -9 (null when all are taken)
function brokenName(file, fsImpl = fs) {
  for (let i = 1; i <= 9; i++) {
    const name = i === 1 ? `${file}.broken` : `${file}.broken-${i}`;
    try {
      fsImpl.lstatSync(name);
    } catch (e) {
      if (e?.code === 'ENOENT') return name;
    }
  }
  return null;
}

// How the shell applies a mode it has just saved (docs/actions-toggle.md §3.5). A running, ready server is asked over
// its own channel to read the mode again (call(): the message names no mode); it switches at once and answers with the
// mode it now runs in. Only an answer naming the saved mode counts; anything else (no server or one still starting, an
// older server that does not know the request, a timeout, another mode) falls back to restart(), the requested
// restart that reads settings.json at start. Returns 'live' or 'restart'.
export async function applyActionsModeLive({ requested, serverReady = false, call, restart, log = () => {} }) {
  if (serverReady) {
    let r;
    try {
      r = await call();
    } catch {
      r = { ok: false, reason: 'error' };
    }
    if (r?.ok === true && r.mode === requested) {
      log(`actions mode applied without a restart: ${requested}`);
      return 'live';
    }
    log(`actions mode not applied in place (${r?.ok === true ? `server runs ${r?.mode}` : r?.reason || 'no answer'}); restarting`);
  }
  restart();
  return 'restart';
}

// The tray's switch as one flow; main.mjs passes in the Electron parts:
//   current    the stored mode       requested  the radio item the user picked
//   confirm()  the native confirmation, resolves true only when the user accepted; asked only for 'live'
//   write(m)   writeHubActionsSetting      apply(m)  the server takes the new mode (applyActionsModeLive)
// Nothing is written unless the choice is valid, differs from the stored mode and (for 'live') was confirmed;
// nothing is applied unless the write succeeded. A confirmation that fails counts as cancelled.
// Returns { changed, mode, reason: 'saved' | 'same' | 'cancelled' | 'write-failed' | 'invalid', error? }.
export async function changeActionsMode({ current, requested, confirm, write, apply }) {
  const from = normalizeActionsMode(current);
  if (!ACTION_MODES.includes(requested)) return { changed: false, mode: from, reason: 'invalid' };
  if (requested === from) return { changed: false, mode: from, reason: 'same' };
  if (requested === 'live') {
    let accepted = false;
    try {
      accepted = (await confirm()) === true;
    } catch {
      accepted = false;
    }
    if (!accepted) return { changed: false, mode: from, reason: 'cancelled' };
  }
  const w = write(requested);
  if (!w || w.ok !== true) return { changed: false, mode: from, reason: 'write-failed', error: w || { ok: false, code: 'WRITE_FAILED' } };
  await apply(requested);
  return { changed: true, mode: requested, reason: 'saved' };
}

// The tray's switch with the hub as its only state: reads the stored mode, then runs changeActionsMode with the
// hub's writer. writable: false (the hub overlaps the program folder) refuses every write with NO_HUB.
// remember(mode) runs after a successful write and before apply: the shell notes which mode it set itself.
// read and write are injectable for tests. Returns changeActionsMode's result plus from (the stored mode before).
export async function switchActionsMode({ hubPath, writable = true, requested, confirm, apply, remember = () => {}, read = readHubActionsSetting, write = writeHubActionsSetting }) {
  const from = read(hubPath);
  let keptAside = null;
  const result = await changeActionsMode({
    current: from,
    requested,
    confirm,
    write: (mode) => {
      const w = writable ? write(hubPath, mode) : { ok: false, code: 'NO_HUB' };
      if (w?.keptAside) keptAside = w.keptAside;
      if (w?.ok === true) remember(mode);
      return w;
    },
    apply,
  });
  return keptAside ? { ...result, from, keptAside } : { ...result, from };
}

// The native confirmation before actions go live, left for the tray and the window menu when no window can show the
// in-app panel (liveConfirmation 'native', or the page did not take the question in time). Cancel is the first button,
// the default and the Esc answer; only the second button (ACTIONS_CONFIRM_OK) turns actions on.
export const ACTIONS_CONFIRM_OK = 1;

export function actionsConfirmOptions(S, platform = process.platform) {
  return {
    type: 'warning',
    title: S.actionsConfirmTitle,
    message: S.actionsConfirmTitle,
    detail: platform === 'win32' ? S.actionsConfirmBody : S.actionsConfirmBody_unix,
    buttons: [S.actionsConfirmCancel, S.actionsConfirmOk],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

// The confirmation as one flow; main.mjs passes Electron's dialog.showMessageBox. Resolves true only when the user
// pressed the On button. QA mode never asks and never turns actions on; a dialog that fails, or any other answer,
// counts as Cancel. parent (a visible window, or null) makes the dialog modal to that window.
// This is a guard against switching actions on by accident, not a security boundary (see buildServerEnv).
export async function confirmActionsLive({ S, qa = false, parent = null, showMessageBox }) {
  if (qa) return false;
  const options = actionsConfirmOptions(S);
  let r;
  try {
    r = parent ? await showMessageBox(parent, options) : await showMessageBox(options);
  } catch {
    return false;
  }
  return r?.response === ACTIONS_CONFIRM_OK;
}

// The tray's "Actions" submenu: three radio items, labels from strings.mjs (S), the stored mode checked
export function actionsMenuItems(S, mode) {
  const m = normalizeActionsMode(mode);
  const label = { off: S.trayActionsOff, dry: S.trayActionsDry, live: S.trayActionsLive };
  return ACTION_MODES.map((id) => ({ id: `actions-${id}`, mode: id, type: 'radio', label: label[id], checked: id === m }));
}

// The "Actions" submenu as an Electron menu template, one builder for the tray and for the window menu (§3a): each
// radio item calls choose(mode, source). main.mjs passes chooseActionsMode, the one path that changes the mode, so
// both menus switch (and confirm On) the same way; source only names the menu in the log.
export function actionsSubmenuTemplate(S, mode, choose, source) {
  return actionsMenuItems(S, mode).map((it) => ({ label: it.label, type: 'radio', checked: it.checked, click: () => choose(it.mode, source) }));
}

// ---------------------------------------------------------------- the in-app switch (docs/actions-toggle.md §3b)

// The one IPC channel of the window: electron/preload.cjs exposes window.sibersentezShell.setActionsMode(mode), which
// invokes it with the mode and nothing else. The preload keeps its own copy of the name (a sandboxed preload cannot
// import this module); test/actions-in-app.test.mjs checks that both are the same.
export const ACTIONS_IPC_CHANNEL = 'sibersentez:set-actions-mode';

// Who may use the window's bridge (every function of electron/preload.cjs). The shell passes what Electron says about
// the sender of the IPC message:
//   mainWindow  the message comes from the main window's own webContents (not DevTools, not any other contents)
//   frame       { top, url } of the sending frame: it must be that window's top frame (not a subframe) and it must show
//               the server origin right now (not an error page; nothing while no server is ready). null: the frame
//               navigated away or is gone.
// Returns { ok: true } or { ok: false, reason: 'not-main-window' | 'not-top-frame' | 'not-app-origin' }.
export function bridgeSender({ mainWindow = false, frame = null, origin = null } = {}) {
  if (mainWindow !== true) return { ok: false, reason: 'not-main-window' };
  if (!frame || frame.top !== true) return { ok: false, reason: 'not-top-frame' };
  if (!isAppUrl(frame.url, origin)) return { ok: false, reason: 'not-app-origin' };
  return { ok: true };
}

// Whether a setActionsMode call from a page may change the mode: the sender rule above (bridgeSender), and the mode
// is exactly 'off' | 'dry' | 'live' (no other spelling, no other type).
// Returns { ok: true, mode } or { ok: false, reason }. The confirmation for On happened in the page (§3b); this is not a
// security boundary against code running in our own page, see actions-toggle.md §2.
export function panelRequest({ mode, mainWindow = false, frame = null, origin = null } = {}) {
  const sender = bridgeSender({ mainWindow, frame, origin });
  if (!sender.ok) return sender;
  if (typeof mode !== 'string' || !ACTION_MODES.includes(mode)) return { ok: false, reason: 'invalid-mode' };
  return { ok: true, mode };
}

// What the page gets back from setActionsMode: whether the mode changed, the mode, the reason and, for a failed write,
// the error code. Never a path or any other detail of the shell. reason: 'saved' | 'same' | 'busy' | 'write-failed' |
// 'cancelled' | 'refused' | 'invalid' | 'error'.
export function panelReply(result) {
  const r = result && typeof result === 'object' ? result : {};
  const reply = {
    changed: r.changed === true,
    mode: ACTION_MODES.includes(r.mode) ? r.mode : null,
    reason: typeof r.reason === 'string' && /^[a-z-]{1,32}$/.test(r.reason) ? r.reason : 'error',
  };
  const code = r.error?.code;
  if (typeof code === 'string' && /^[A-Z_]{1,32}$/.test(code)) reply.code = code;
  return reply;
}

// How a switch to On is confirmed, by where the request comes from (§3b):
//   'none'    not a switch to On (Off, Preview, On while On is stored, an unknown value): nothing to confirm
//   'refuse'  QA mode: actions are never turned on
//   'page'    the in-app panel ('panel'): the page asked the user in the panel before it called setActionsMode('live')
//   'panel'   the tray or the window menu while the window shows the panel (windowReady): the shell brings the window
//             up and hands the question to the panel; if the page does not take it, the native dialog asks instead
//   'native'  otherwise (no window that can ask): the native confirmation dialog
export function liveConfirmation({ requested, current, source, qa = false, windowReady = false } = {}) {
  if (requested !== 'live' || normalizeActionsMode(current) === 'live') return 'none';
  if (qa) return 'refuse';
  if (source === 'panel') return 'page';
  return windowReady === true ? 'panel' : 'native';
}

// chooseActionsMode's routing as one flow; main.mjs passes in the Electron parts:
//   handOver()        bring the window up and hand the question to its panel; resolves true when the page took it
//   confirmNative()   the native confirmation (confirmActionsLive)
//   switchMode(confirm)  switchActionsMode with the confirmation to use
// 'panel' route taken by the page: nothing is written now ({ reason: 'in-panel' }); the panel sends On itself once the
// user presses Turn on there. Not taken: the native dialog asks. 'page': the panel already asked. 'refuse': never On.
export async function requestActionsMode({ requested, source, current, qa = false, windowReady = false, handOver, confirmNative, switchMode }) {
  const how = liveConfirmation({ requested, current, source, qa, windowReady });
  if (how === 'panel') {
    let took = false;
    try {
      took = (await handOver()) === true;
    } catch {
      took = false;
    }
    if (took) return { changed: false, mode: normalizeActionsMode(current), from: normalizeActionsMode(current), reason: 'in-panel' };
  }
  const confirm = how === 'page' ? async () => true : how === 'refuse' ? async () => false : confirmNative;
  return switchMode(confirm);
}

// Run in the window's page by the shell (webContents.executeJavaScript) to hand a menu's On over to the panel: the
// page's switch opens with the On question and answers true; anything else (no switch, a page without the bridge, an
// error) answers false and the native dialog asks. The answer is only ever used as "the page took it": the mode still
// changes only through setActionsMode, after the user pressed Turn on in the panel.
export const PANEL_CONFIRM_LIVE_SCRIPT = "(() => { try { return window.sibersentezActionsPanel?.confirmLive?.() === true; } catch { return false; } })()";

// How long the shell waits for the page to take the question before the native dialog asks
export const PANEL_HANDOVER_MS = 1500;

// Resolves what `promise` resolves within ms; `fallback` if it takes longer, rejects, or throws while being created.
export function settleWithin(promiseOrFn, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    const done = (v) => {
      clearTimeout(timer);
      resolve(v);
    };
    let p;
    try {
      p = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
    } catch {
      done(fallback);
      return;
    }
    Promise.resolve(p).then(done, () => done(fallback));
  });
}
