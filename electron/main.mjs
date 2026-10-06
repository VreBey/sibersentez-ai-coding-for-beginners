// SiberSentez desktop shell: the Electron main process.
// Duties: single-instance lock; preparing the hub folder (server/hub.mjs → initHub); starting the panel server
// in a separate process on a free port of its own range and supervising it; locking the window to
// http://127.0.0.1:<port>/ only; system tray; logs; QA mode (optionally hidden: nothing reaches the screen).
// Every decision lives in helpers.mjs as a pure, tested function; this file only wires them to Electron.
// Security: the window is sandboxed (sandbox + contextIsolation, nodeIntegration off). Its preload
// (electron/preload.cjs) gives the page exactly three functions over three IPC channels that the shell honours only
// from the main window's top frame on the server origin (bridgeSender): setActionsMode(mode), pickProjectFolder() and
// saveProjectIdea(projectId, text); nothing else reaches the renderer. Permission requests are denied except
// notifications and clipboard writes from our own origin; the page may only send network requests to its own origin.
// New project (docs/start-flow.md, step 2): the folder picker is the shell's; the chosen folder is checked here and
// remembered by the server in the program's project memory (<hub>\registry\discovered.json), which the shell asks for
// over the server process's own message channel (createServerCalls). The page gets the project id, never a path.
// Actions (docs/actions-toggle.md): the user's SIBERSENTEZ_ACTIONS never reaches the server; the server takes the
// mode from the hub's settings.json. Within SiberSentez only this shell writes it, through one function
// (chooseActionsMode) reached from the tray's Actions submenu, the same submenu in the window menu (Alt), and the
// in-app panel under the page's header indicator (§3b, through the preload). Turning actions On is confirmed first on
// every path: in the panel itself; for the tray and the window menu the shell brings the window up and the panel asks,
// and only when no window can ask does a native dialog. A page in a plain browser has no preload, so it can read the
// mode (/api/actions) but never change it. The confirmation guards against accidents, it is not a security boundary:
// any program running as the same user can edit settings.json, and SIBERSENTEZ_HUB chooses which hub (and settings.json)
// is used. Each time a server becomes ready the tray and the window menu are rebuilt from the stored mode, and when
// the shell finds actions On without having switched them on itself, it warns (tray balloon and a dialog) once for
// that change, recorded in shell.json.
//
// Environment variables:
//   SIBERSENTEZ_HUB          hub folder (default %USERPROFILE%\SiberSentez); must be a local absolute folder
//   SIBERSENTEZ_DATA_DIR     Electron data and log folder (default %APPDATA%\SiberSentez); trials pass a temp folder
//   SIBERSENTEZ_QA_SHOT      PNG path for a screenshot taken after the window loads (never overwrites); then quit
//   SIBERSENTEZ_QA_DELAY_MS  wait before the screenshot, and before the QA actions switch (default 5000)
//   SIBERSENTEZ_QA_QUIT_MS   quit the app after this many ms
//   SIBERSENTEZ_QA_ACTIONS   off|dry: switch the actions mode through the tray's code path after the first page load
//                         (live is refused); a screenshot then waits for the reloaded page
//   SIBERSENTEZ_QA_HIDDEN    1: a QA run that shows nothing: the window is never shown (off screen, no taskbar button),
//                         no tray icon, no native dialog, no notification, no external program (helpers.mjs
//                         readQaShellOptions); the person at this computer keeps working while it runs
//   SIBERSENTEZ_QA_PROBES    1: after the first page load run the fixed QA probes (runQaProbes), then quit
//   SIBERSENTEZ_QA_PROJECT_DIR  hidden runs only: the folder the probes add as a project (the picker's path, no picker)
// In a packaged build the SIBERSENTEZ_QA_* variables only work together with the --qa switch.
import { app, BrowserWindow, Menu, Tray, dialog as electronDialog, ipcMain, nativeImage, session, shell, utilityProcess } from 'electron';
import { fork as forkNode, spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  rendererReloadPlan,
  ACTIONS_IPC_CHANNEL,
  ATTENTION_IPC_CHANNEL,
  attentionBadgeBitmap,
  attentionPlan,
  attentionRequest,
  HUB_SETTINGS_FILE,
  LOGIN_ITEM_NAME,
  NEW_PROJECT_HANDOVER_MS,
  NEW_PROJECT_SCRIPT,
  PANEL_CONFIRM_LIVE_SCRIPT,
  PANEL_HANDOVER_MS,
  PROJECT_IDEA_IPC_CHANNEL,
  PROJECT_PICK_IPC_CHANNEL,
  QA_ACTIONS_SCRIPTS,
  QA_SERVED_MODE_SCRIPT,
  QA_BRIDGE_PROBE_SCRIPT,
  QA_KIT_PROBE_SCRIPT,
  QA_ABOUT_PROBE_SCRIPT,
  QA_PANEL_PATH,
  QA_PANEL_PROBE_SCRIPT,
  SHELL_STATE_FILE,
  actionsMenuItems,
  actionsSubmenuTemplate,
  appOrigin,
  bridgeSender,
  buildServerEnv,
  checkActionsOnReady,
  checkLocalDir,
  checkProjectFolder,
  confirmActionsLive,
  createServerCalls,
  createsTray,
  decideNavigation,
  describeUrl,
  explicitLanguage,
  findFreePort,
  foldersOverlap,
  guardDialogs,
  initialSupervisor,
  isAppUrl,
  newProjectFromTray,
  panelReply,
  panelRequest,
  permissionAllowed,
  pickLanguage,
  pickProjectFolder,
  libraryPickReply,
  libraryFolderDialogOptions,
  LIBRARY_PICK_IPC_CHANNEL,
  LANGUAGE_CHOICES,
  LANGUAGE_IPC_CHANNEL,
  writeHubLanguageSetting,
  projectIdeaRequest,
  projectReply,
  readHubActionsSetting,
  readHubLanguageSetting,
  readQaActionsMode,
  readQaOptions,
  readQaShellOptions,
  readShellState,
  requestActionsMode,
  requestAllowed,
  resolveHubPath,
  restartDue,
  settingsRestartPlan,
  applyActionsModeLive,
  settleWithin,
  shellNavigation,
  stopServerProcess,
  superviseStep,
  switchActionsMode,
  systemFolderRules,
  updateShellState,
  waitForServer,
  windowOptions,
  windowShowPlan,
  windowUrl,
  LEGACY_HUB_DIR_NAME,
  legacyHubPlan
} from './helpers.mjs';
import { createLogger } from './logger.mjs';
import { createTerminals, TERMINAL_IPC, termOpenRequest, confirmQuitWithTerminals, avoidForkOnKill, taskkillTree } from './terminals.mjs';
import { formatString, getStrings } from './strings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ID = 'app.sibersentez.panel';
const ICON_PATH = path.join(here, 'assets', 'icon.png');
const TRAY_ICON_PATH = path.join(here, 'assets', 'tray.png');
const PRELOAD_PATH = path.join(here, 'preload.cjs');
const START_HIDDEN = process.argv.includes('--hidden');
const READY_TIMEOUT_MS = 30000;
const SERVER_EXIT_WAIT_MS = 5000; // a requested restart waits this long for the old process, then as long again after a force kill
const HOME_DIR = os.homedir();

// The product was renamed (2026-09-30): ORKESTRA_* variables are still honoured under the new names
for (const k of Object.keys(process.env)) {
  if (!k.toUpperCase().startsWith('ORKESTRA_')) continue;
  const next = 'SIBERSENTEZ_' + k.slice(9);
  if (process.env[next] === undefined) process.env[next] = process.env[k];
}
const QA = readQaOptions({ env: process.env, argv: process.argv, isPackaged: app.isPackaged });
const QA_ACTIONS = readQaActionsMode({ env: process.env, qa: QA });
// A QA run that shows nothing, and the QA probes (both only in QA mode)
const QA_SHELL = readQaShellOptions({ env: process.env, qa: QA });

// Data folder: the single-instance lock depends on it, so it is set before the lock is requested
const dataDirCheck = process.env.SIBERSENTEZ_DATA_DIR?.trim() ? checkLocalDir(process.env.SIBERSENTEZ_DATA_DIR, { homeDir: HOME_DIR }) : null;
if (dataDirCheck?.ok) {
  app.setPath('userData', dataDirCheck.path);
  app.setPath('sessionData', dataDirCheck.path);
  app.setAppLogsPath(path.join(dataDirCheck.path, 'logs'));
} else {
  app.setAppLogsPath();
}

const LOG_DIR = app.getPath('logs');
const mainLog = createLogger({ dir: LOG_DIR, name: 'main' });
const serverLog = createLogger({ dir: LOG_DIR, name: 'server' });
const log = (m) => mainLog.write(m);
// Every native dialog of the shell goes through this: a hidden QA run opens none (each call is logged and cancelled)
const dialog = guardDialogs(electronDialog, { hidden: QA_SHELL.hidden, log });

const state = {
  rendererLosses: [], // when the page's renderer was lost (rendererReloadPlan)
  rendererReload: null,
  hubPath: null,
  hubInit: 'not started',
  lang: 'en',
  port: null,
  origin: null,
  instance: randomBytes(16).toString('hex'), // never logged
  server: null, // { kind, pid, alive, exited, kill(), forceKill() }
  retired: new Set(), // server processes stopped on purpose that have not exited yet; stopped again when the app quits
  supervisor: initialSupervisor(),
  quitting: false,
  restartTimer: null,
  launching: false,
  hubOverlaps: false, // the hub overlaps the program folder: the shell writes nothing there
  pageLang: null, // 'en' | 'tr' when the hub's settings.json names it; passed to the page as ?lang=
  restartAfterLaunch: false, // a setting changed while a launch was running: restart once that server is ready
  reloadOnReady: false, // after a requested restart: reload the window so the page reads the new mode
  switchingActions: false, // an actions mode change is in progress (its confirmation may be open)
  pickingFolder: false, // the new-project folder picker is open
};
// Calls to the current server process over its message channel (new project, the idea)
const serverCalls = createServerCalls();
let S = getStrings('en'); // user-visible texts of the current language
let win = null;
let tray = null;
let qaShotScheduled = false;
let qaActionsStep = QA_ACTIONS.mode ? 'pending' : 'none'; // 'pending' -> 'running' -> 'done'

function setLanguage(lang) {
  state.lang = lang;
  S = getStrings(lang);
}

// ---------------------------------------------------------------- hub folder

// server/hub.mjs belongs to the server agent; if it or initHub is missing the step is skipped safely.
// The product was renamed (Orkestra -> SiberSentez, 2026-09-30): a default hub under the old name is moved to the new
// one once, before the server reads it (a rename on the same drive: nothing is copied). If the move fails the old
// folder is used as it is and nothing is lost; the next start tries again.
function migrateLegacyHub(hub) {
  const oldPath = path.join(path.dirname(hub.path), LEGACY_HUB_DIR_NAME);
  let oldIsDir = false;
  try {
    const st = fs.lstatSync(oldPath);
    oldIsDir = st.isDirectory() && !st.isSymbolicLink();
  } catch {
    oldIsDir = false;
  }
  if (legacyHubPlan({ source: hub.source, newExists: fs.existsSync(hub.path), oldIsDir }) !== 'move') return hub.path;
  // The old app's hub, moved or not: its actions mode was set by the old app (its own start warned about a change
  // made outside it), so the shell takes it as seen once the hub is known (rememberLegacyMode)
  state.hubFromLegacy = true;
  try {
    fs.renameSync(oldPath, hub.path);
    log('hub moved from the old product name to the new one');
    return hub.path;
  } catch (e) {
    log(`hub could not be moved (${e?.code || 'error'}); using the old folder`);
    return oldPath;
  }
}

async function prepareHub(hubPath) {
  const appDir = path.dirname(process.execPath);
  if (foldersOverlap(hubPath, appDir)) {
    // The uninstaller deletes the program folder: a hub inside it (or around it) would be lost. The check also
    // compares the real paths, so a junction, a symbolic link or an 8.3 short name cannot sidestep it.
    state.hubInit = 'skipped (overlaps the program folder)';
    state.hubOverlaps = true;
    log(`hub: ${hubPath} overlaps the program folder ${appDir}; skeleton not created`);
    if (!QA.enabled) {
      dialog.showMessageBox({ type: 'warning', title: S.hubOverlapTitle, message: S.hubOverlapTitle, detail: formatString(S.hubOverlapBody, { hub: hubPath, app: appDir }) }).catch(() => {});
    }
    return;
  }
  const file = path.join(app.getAppPath(), 'server', 'hub.mjs');
  if (!fs.existsSync(file)) {
    state.hubInit = 'skipped (server/hub.mjs missing)';
    log('hub: server/hub.mjs not found; skeleton not created');
    return;
  }
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    state.hubInit = 'skipped (hub.mjs failed to load)';
    log(`hub: server/hub.mjs failed to load: ${e?.message}`);
    return;
  }
  if (typeof mod.initHub !== 'function') {
    state.hubInit = 'skipped (initHub not exported)';
    log('hub: initHub is not exported; skeleton not created');
    return;
  }
  try {
    const created = await mod.initHub(hubPath);
    const list = Array.isArray(created) ? created : [];
    state.hubInit = list.length ? `created: ${list.join(', ')}` : 'already present (untouched)';
    log(`hub: ${hubPath} · ${state.hubInit}`);
  } catch (e) {
    state.hubInit = 'error';
    log(`hub could not be prepared: ${e?.message}`);
  }
}

// ---------------------------------------------------------------- server process

function pipeLines(stream, prefix) {
  if (!stream) return;
  stream.setEncoding('utf8');
  let carry = '';
  stream.on('data', (chunk) => {
    const parts = (carry + chunk).split(/\r?\n/);
    carry = parts.pop();
    for (const line of parts) if (line.trim()) serverLog.write(`${prefix}${line}`);
  });
  stream.on('end', () => {
    if (carry.trim()) serverLog.write(`${prefix}${carry}`);
    carry = '';
  });
}

// utilityProcess is preferred; otherwise child_process.fork with Electron's own Node mode (ELECTRON_RUN_AS_NODE).
// Note: packaged builds turn the RunAsNode fuse off (package.json → build.electronFuses), so this fallback does
// not work there; utilityProcess always exists in Electron 44, the fallback is for development and old versions.
function spawnServer(port, onExit) {
  const entry = path.join(app.getAppPath(), 'server', 'index.mjs');
  const env = buildServerEnv(process.env, { port, hubPath: state.hubPath, instance: state.instance });
  let markExited = () => {};
  // exited: settles when the process is gone (a requested restart waits for it so the port is free again).
  // forceKill: terminates the process by pid, only while no exit was seen (a pid is never reused before that).
  const handle = { kind: '', pid: undefined, alive: true, kill: () => {}, exited: new Promise((resolve) => (markExited = resolve)) };
  handle.forceKill = () => {
    if (handle.alive && Number.isInteger(handle.pid)) process.kill(handle.pid, 'SIGKILL');
  };
  if (typeof utilityProcess?.fork === 'function') {
    const child = utilityProcess.fork(entry, [], { env, stdio: 'pipe', serviceName: 'SiberSentez server' });
    handle.kind = 'utilityProcess';
    handle.kill = () => child.kill();
    handle.post = (msg) => child.postMessage(msg);
    child.on('message', (msg) => serverCalls.receive(handle, msg));
    child.on('spawn', () => {
      handle.pid = child.pid;
      log(`server started (utilityProcess, pid ${child.pid}, port ${port})`);
    });
    child.on('exit', (code) => {
      handle.alive = false;
      markExited();
      onExit(handle, code);
    });
    pipeLines(child.stdout, '');
    pipeLines(child.stderr, '[stderr] ');
  } else {
    const child = forkNode(entry, [], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    handle.kind = 'ELECTRON_RUN_AS_NODE';
    handle.pid = child.pid;
    handle.kill = () => child.kill();
    handle.post = (msg) => child.send(msg);
    child.on('message', (msg) => serverCalls.receive(handle, msg));
    log(`server started (ELECTRON_RUN_AS_NODE, pid ${child.pid}, port ${port})`);
    child.on('exit', (code) => {
      handle.alive = false;
      markExited();
      onExit(handle, code);
    });
    child.on('error', (e) => log(`server process error: ${e?.message}`));
    pipeLines(child.stdout, '');
    pipeLines(child.stderr, '[stderr] ');
  }
  return handle;
}

function onServerExit(handle, code) {
  log(`server exited (code ${code}, pid ${handle.pid ?? '?'})`);
  serverCalls.drop(handle);
  state.retired.delete(handle);
  if (state.server !== handle) return; // an old process or one stopped on purpose
  state.server = null;
  serverGone();
  if (state.quitting) return;
  onServerFailure('exited');
}

// No server answers for the window until the next one is ready: its old port may be taken by another program in
// the meantime, so the window reaches nothing (navigation and requestAllowed deny everything while origin is null)
// and reloads once the next server is ready.
function serverGone() {
  state.origin = null;
  state.reloadOnReady = true;
}

// Every failure (crash, not ready in time, foreign answer, no free port) goes through the supervisor
function onServerFailure(reason) {
  if (state.quitting || state.restartTimer) return;
  const { state: next, action } = superviseStep(state.supervisor, { type: 'failed', at: Date.now() });
  state.supervisor = next;
  if (action.type === 'give-up') return giveUp(reason, action.failures);
  log(`server restart in ${action.delayMs} ms (attempt ${action.attempt}, reason: ${reason})`);
  state.restartTimer = setTimeout(onRestartDue, action.delayMs);
}

// A due restart never gets lost: while a launch is still running it is checked again shortly (restartDue)
function onRestartDue() {
  state.restartTimer = null;
  const next = restartDue({ quitting: state.quitting, launching: state.launching, serverAlive: Boolean(state.server?.alive) });
  if (next.type === 'wait') {
    state.restartTimer = setTimeout(onRestartDue, next.delayMs);
    return;
  }
  if (next.type === 'drop') {
    log(`restart dropped (${next.reason})`);
    return;
  }
  launchServer().catch((e) => log(`restart failed: ${e?.message}`));
}

async function launchServer() {
  if (state.quitting || state.launching) return;
  state.launching = true;
  try {
    let port;
    try {
      // On restart the previous port is tried first (an open page keeps its address)
      port = await findFreePort({ preferred: state.port });
    } catch (e) {
      log(`no free port: ${e?.message}`);
      onServerFailure('no free port');
      return;
    }
    // A process started from here on reads the settings as they are now: an earlier change needs no restart
    state.restartAfterLaunch = false;
    const handle = spawnServer(port, onServerExit);
    state.server = handle;
    const result = await waitForServer(port, {
      instance: state.instance,
      timeoutMs: READY_TIMEOUT_MS,
      shouldStop: () => !handle.alive || state.quitting,
    });
    if (state.quitting) return;
    if (result === 'ready' && handle.alive) return onServerReady(port);
    if (result === 'foreign') log(`port ${port} answered without our instance id; it is never loaded`);
    else log(`server did not become ready on port ${port} (${result})`);
    if (state.server === handle) state.server = null;
    if (handle.alive) {
      state.retired.add(handle);
      handle.kill();
    }
    onServerFailure(result === 'foreign' ? 'foreign server' : 'not ready');
  } finally {
    state.launching = false;
  }
}

function giveUp(reason, failures) {
  log(`server failed ${failures} times in a row (last: ${reason}); quitting`);
  if (!QA.enabled) dialog.showErrorBox(S.errorTitle, formatString(S.errorServer, { logDir: LOG_DIR }));
  state.quitting = true;
  stopServer('gave up');
  app.exit(1);
}

function onServerReady(port) {
  const changed = state.port !== port;
  state.port = port;
  state.origin = appOrigin(port);
  state.supervisor = superviseStep(state.supervisor, { type: 'ready', at: Date.now() }).state;
  log(`server ready: ${state.origin}/`);
  if (QA.enabled) {
    const summary = { port, origin: state.origin, hub: state.hubPath, hubInit: state.hubInit, server: state.server?.kind, lang: state.lang, actions: readHubActionsSetting(state.hubPath) };
    log(`QA summary: ${JSON.stringify(summary)}`);
  }
  if (state.restartAfterLaunch) {
    // A setting changed while this server was starting; it may have read the old value
    state.restartAfterLaunch = false;
    restartServerOnRequest('settings changed while the server was starting').catch((e) => log(`requested restart failed: ${e?.message}`));
    return;
  }
  const reload = state.reloadOnReady;
  state.reloadOnReady = false;
  if (!win) createWindow();
  else if (changed || reload) win.loadURL(pageUrl());
  qaSignal('server-ready');
  checkActionsMode();
}

function pageUrl() {
  return windowUrl(state.origin, state.pageLang);
}

// A restart the shell asks for itself (a server setting changed). Not a failure: the supervisor gets a
// 'requested' event, which never raises the failure count, and onServerExit ignores the old process because it
// is no longer the current one. The old process is stopped, force-killed if it does not exit in time, and kept in
// state.retired until it exits, so quitting stops it too. The window reloads once the new server is ready.
async function restartServerOnRequest(reason) {
  if (state.quitting) return;
  const old = state.server;
  state.supervisor = superviseStep(state.supervisor, { type: 'requested', at: Date.now() }).state;
  state.server = null;
  serverGone();
  log(`server restart requested (${reason}); not counted as a failure`);
  if (old?.alive) {
    state.retired.add(old);
    const how = await stopServerProcess(old, { waitMs: SERVER_EXIT_WAIT_MS });
    log(`old server (pid ${old.pid ?? '?'}): ${how}`);
  }
  if (state.quitting) return;
  if (state.launching) {
    state.restartAfterLaunch = true;
    return;
  }
  await launchServer();
}

// A saved actions mode: in place when the server is running and the window shows it, else by a requested restart
function applyActionsMode(mode) {
  return applyActionsModeLive({
    requested: mode,
    serverReady: Boolean(state.server?.alive && !state.launching && state.origin),
    call: () => serverCalls.call(state.server, 'actions-reload'),
    restart: () => applyServerSettingsChange('actions mode'),
    log,
  });
}

// The server reads its other settings only at start: apply a change according to where the server lifecycle stands
function applyServerSettingsChange(reason) {
  const plan = settingsRestartPlan({ quitting: state.quitting, launching: state.launching, serverAlive: Boolean(state.server?.alive) });
  log(`server settings changed (${reason}): ${plan}`);
  if (plan === 'restart-now') restartServerOnRequest(reason).catch((e) => log(`requested restart failed: ${e?.message}`));
  else if (plan === 'after-launch') state.restartAfterLaunch = true;
}

function stopServer(reason) {
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }
  const s = state.server;
  state.server = null;
  if (s?.alive) {
    log(`stopping server (${reason})`);
    try {
      s.kill();
    } catch (e) {
      log(`server could not be stopped: ${e?.message}`);
    }
  }
  // Old processes of a requested restart that have not exited yet
  for (const old of state.retired) {
    if (!old.alive) continue;
    log(`stopping an old server (pid ${old.pid ?? '?'}, ${reason})`);
    try {
      old.forceKill();
    } catch (e) {
      log(`old server could not be stopped: ${e?.message}`);
    }
  }
}

// ---------------------------------------------------------------- security wiring

function openExternal(url) {
  if (QA_SHELL.hidden) return log('QA hidden: external link not opened');
  shell.openExternal(url).catch((e) => log(`external link could not be opened: ${e?.message}`));
}

// The retired shell path (§3b) is decided by the tested shellNavigation first and is only ever cancelled; every other
// url by decideNavigation.
function applyNavigation(kind, url, cancel) {
  const retired = shellNavigation({ url, origin: state.origin });
  if (retired) {
    if (retired.cancel) cancel();
    log(`${kind}: retired shell path cancelled`);
    return retired;
  }
  const d = decideNavigation(kind, url, state.origin);
  if (d.cancel) cancel();
  if (d.openExternal) {
    log(`${kind}: opened in the default browser: ${describeUrl(url)}`);
    openExternal(url);
  } else if (d.cancel) {
    log(`${kind} blocked: ${describeUrl(url)}`);
  }
  return d;
}

// { top, url } of the frame that sent an IPC message, for panelRequest; a frame that is already gone reads as not a top
// frame
function frameFacts(frame) {
  if (!frame) return null;
  try {
    return { top: frame.parent === null, url: frame.url };
  } catch {
    return { top: false, url: '' };
  }
}

// For every webContents (window, DevTools): navigation only within our origin, no new windows, no webview
function hardenContents(contents) {
  contents.on('will-navigate', (event, url) => applyNavigation('navigate', url, () => event.preventDefault()));
  contents.on('will-redirect', (event, url) => applyNavigation('redirect', url, () => event.preventDefault()));
  contents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return; // the main frame is handled by will-navigate
    applyNavigation('frame', details.url, () => details.preventDefault());
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log('webview blocked');
  });
  contents.setWindowOpenHandler(({ url }) => {
    applyNavigation('window-open', url, () => {});
    return { action: 'deny' };
  });
}

function hardenSession(ses) {
  // A hidden QA run also denies notifications (nothing of that run reaches the screen)
  const qaHidden = QA_SHELL.hidden;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const ok = permissionAllowed(permission, details?.requestingUrl || wc?.getURL?.(), state.origin, { qaHidden });
    if (!ok) log(`permission denied: ${permission}`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, state.origin, { qaHidden }));
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.on('will-download', (event) => {
    event.preventDefault();
    log('download blocked');
  });
  // Defence in depth: even if CSP were bypassed, the page may only reach its own origin
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const ok = requestAllowed(details.url, state.origin);
    if (!ok) log(`network request blocked: ${describeUrl(details.url)}`);
    callback({ cancel: !ok });
  });
}

// ---------------------------------------------------------------- window

// The window's options are the tested windowOptions (sandboxed, isolated, no Node; the preload's three functions;
// DevTools only in development). A hidden QA run: never shown, no taskbar button, off screen.
// "What needs you" on the taskbar (docs/attention.md §4): the page's count of waiting sessions and its words for it.
// A dot over the taskbar button while someone waits, the words in the tray's tooltip, a flash when the count grows
// while the window is in the background. Checked like every bridge call (attentionRequest); never logged per call.
const attention = { count: 0, tooltip: null, badge: null };
function onAttention(event, count, text) {
  const check = attentionRequest({ count, text, ...senderFacts(event) });
  if (!check.ok) return { ok: false, reason: check.reason === 'invalid' ? 'invalid' : 'refused' };
  const plan = attentionPlan({ count: check.count, text: check.text, previous: attention.count, focused: Boolean(win?.isFocused()), baseTooltip: S.trayTooltip });
  attention.count = check.count;
  attention.tooltip = plan.tooltip;
  if (win && !win.isDestroyed()) {
    if (plan.overlay) {
      attention.badge = attention.badge || nativeImage.createFromBitmap(attentionBadgeBitmap(16), { width: 16, height: 16 });
      win.setOverlayIcon(attention.badge, check.text);
    } else win.setOverlayIcon(null, '');
    if (plan.flash) win.flashFrame(true);
  }
  tray?.setToolTip(plan.tooltip);
  return { ok: true };
}

function createWindow() {
  win = new BrowserWindow(windowOptions({ qaHidden: QA_SHELL.hidden, preload: PRELOAD_PATH, icon: ICON_PATH, devTools: !app.isPackaged }));

  win.on('close', (event) => {
    if (state.quitting) return;
    event.preventDefault(); // closing hides to the tray; the real exit is Quit in the tray
    win.hide();
    showTrayHint();
  });
  win.on('closed', () => {
    win = null;
  });
  // The taskbar button stops flashing once the person comes to the window
  win.on('focus', () => win?.flashFrame(false));
  win.once('ready-to-show', () => {
    const plan = windowShowPlan({ qa: QA.enabled, qaHidden: QA_SHELL.hidden, startHidden: START_HIDDEN });
    if (plan === 'inactive') win.showInactive();
    else if (plan === 'show') win.show();
    else if (plan === 'never') log('QA hidden: the window is ready and stays hidden');
  });
  win.webContents.on('did-finish-load', () => {
    log(`window loaded: ${describeUrl(win?.webContents.getURL())}`);
    qaSignal('page-loaded');
    scheduleQaActions();
    scheduleQaShot();
    scheduleQaProbes();
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted by a newer navigation
    log(`page failed to load (${code} ${desc}): ${describeUrl(url)}`);
    setTimeout(() => {
      if (win && state.origin && state.server?.alive) win.loadURL(pageUrl());
    }, 1500);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`renderer process gone: ${details.reason}`);
    if (state.quitting || details.reason === 'clean-exit') return;
    // One pending reload at a time, waiting longer each time; the third loss in two minutes stops (rendererReloadPlan)
    const plan = rendererReloadPlan(state.rendererLosses, Date.now());
    state.rendererLosses = plan.times;
    clearTimeout(state.rendererReload);
    if (plan.delayMs == null) {
      log(`renderer lost ${plan.times.length} times in two minutes: not reloading again (open the window from the tray to try)`);
      return;
    }
    state.rendererReload = setTimeout(() => win?.webContents.reload(), plan.delayMs);
  });

  win.loadURL(pageUrl());
}

// Brings the window up (the tray, a second launch, a hand-over to the panel). A hidden QA run never shows it: the
// request is only logged (windowShowPlan).
function showWindow(reason = 'request') {
  if (!win) {
    if (state.origin) createWindow();
    return;
  }
  if (windowShowPlan({ qa: QA.enabled, qaHidden: QA_SHELL.hidden, bringUp: true }) === 'never') {
    log(`QA hidden: window not shown (${reason})`);
    return;
  }
  if (win.isMinimized()) win.restore();
  // A page whose renderer was lost and no longer reloads by itself gets one fresh try when the person comes back
  if (win.webContents.isCrashed()) {
    state.rendererLosses = [];
    win.webContents.reload();
  }
  win.show();
  win.focus();
}

function buildAppMenu() {
  const view = [
    { role: 'reload', label: S.menuReload },
    { type: 'separator' },
    { role: 'resetZoom', label: S.menuActualSize },
    { role: 'zoomIn', label: S.menuZoomIn },
    { role: 'zoomOut', label: S.menuZoomOut },
    { type: 'separator' },
    { role: 'togglefullscreen', label: S.menuFullScreen },
  ];
  if (!app.isPackaged) view.push({ type: 'separator' }, { role: 'toggleDevTools', label: S.menuDevTools });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: S.menuApp,
        submenu: [
          { label: S.menuHideWindow, accelerator: 'CmdOrCtrl+W', click: () => win?.hide() },
          { type: 'separator' },
          { label: S.menuQuit, accelerator: 'CmdOrCtrl+Q', click: () => quitWithTerminalsConfirmed('menu: Quit') },
        ],
      },
      // The tray's Actions submenu, reachable with Alt too (Windows 11 hides new tray icons; §3a)
      { label: S.trayActions, submenu: actionsSubmenu('menu') },
      { label: S.menuView, submenu: view },
    ]),
  );
}

// ---------------------------------------------------------------- tray

// Start at login: the packaged app registers its own exe, development registers electron.exe + the app folder.
// On Windows the setting must be read back with the same name, path and arguments.
function loginItemOptions() {
  return { name: LOGIN_ITEM_NAME, path: process.execPath, args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'] };
}

function readOpenAtLogin() {
  try {
    return app.getLoginItemSettings(loginItemOptions()).openAtLogin === true;
  } catch {
    return false;
  }
}

// Called only when the user clicks the checkbox in the tray
function setOpenAtLogin(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemOptions() });
    log(`start at login: ${enabled ? 'on' : 'off'}`);
  } catch (e) {
    log(`start at login could not be changed: ${e?.message}`);
  }
  refreshTrayMenu();
}

function openHubFolder() {
  if (!state.hubPath) return;
  if (QA_SHELL.hidden) return log('QA hidden: hub folder not opened');
  shell.openPath(state.hubPath).then((err) => {
    if (err) log(`hub folder could not be opened: ${err}`);
  });
}

// ---------------------------------------------------------------- actions mode (docs/actions-toggle.md)

// The stored mode (the hub's settings.json); the server reads the same key when it starts
function currentActionsMode() {
  return readHubActionsSetting(state.hubPath);
}

// The Actions submenu of the tray ('tray') and of the window menu ('menu'): radio items built by the tested helper
// from the stored mode, each wired to chooseActionsMode
function actionsSubmenu(source) {
  return actionsSubmenuTemplate(S, currentActionsMode(), chooseActionsMode, source);
}

// Both menus that show the mode, rebuilt together from the stored mode
function refreshMenus() {
  refreshTrayMenu();
  buildAppMenu();
}

// The page's one request (§3b): window.sibersentezShell.setActionsMode(mode) from electron/preload.cjs. Honoured only
// when the tested panelRequest accepts the sender (the main window's top frame, showing the server origin) and the mode;
// then it takes the same path as the menus, with the panel's own confirmation for On. The answer carries no path
// (panelReply). Never throws back into the page.
async function onPanelActionsRequest(event, mode) {
  const check = panelRequest({
    mode,
    mainWindow: Boolean(win && !win.isDestroyed() && event?.sender === win.webContents),
    frame: frameFacts(event?.senderFrame),
    origin: state.origin,
  });
  if (!check.ok) {
    log(`actions request from a page refused (${check.reason})`);
    return panelReply({ changed: false, reason: 'refused' });
  }
  try {
    return panelReply(await chooseActionsMode(check.mode, 'panel'));
  } catch (e) {
    log(`actions request failed: ${e?.message}`);
    return panelReply({ changed: false, reason: 'error' });
  }
}

// The window shows the panel right now (the server origin), so it can ask about On itself
function panelWindowReady() {
  if (!win || win.isDestroyed()) return false;
  try {
    return isAppUrl(win.webContents.getURL(), state.origin);
  } catch {
    return false;
  }
}

// On chosen in the tray or the window menu (§3b): bring the window up and let its panel ask. Resolves true when the
// page took the question (the mode then changes only if the user presses Turn on there); false when it did not answer
// true within PANEL_HANDOVER_MS, and the native dialog asks instead.
async function handOverToPanel() {
  if (!panelWindowReady()) return false;
  showWindow();
  return (await settleWithin(() => win.webContents.executeJavaScript(PANEL_CONFIRM_LIVE_SCRIPT), PANEL_HANDOVER_MS, false)) === true;
}

// Native confirmation before actions go live (the tested flow in helpers.mjs); QA never turns them on
function confirmActionsOn() {
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : null;
  return confirmActionsLive({ S, qa: QA.enabled, parent, showMessageBox: (...args) => dialog.showMessageBox(...args) });
}

// shell.json in the shell's data folder (not the hub)
function shellStateFile() {
  return path.join(app.getPath('userData'), SHELL_STATE_FILE);
}

// The mode this shell wrote (or warned about) for this hub; unexpectedLiveMode compares against it
// After the hub came over from the old product name: the new shell's memory (shell.json, in the new app-data folder)
// is empty, so actions left On by the old app would read as switched on outside the app and warn on the first start
function rememberLegacyMode() {
  if (!state.hubFromLegacy) return;
  const mode = currentActionsMode();
  rememberActionsMode(mode);
  log(`actions mode taken over with the old hub: ${mode}`);
}

function rememberActionsMode(mode) {
  if (!updateShellState(shellStateFile(), { actionsModeSeen: { hub: state.hubPath, mode } })) log('shell state could not be saved');
}

// Every time a server is ready (the tested flow in helpers.mjs): the tray is rebuilt from the stored mode, and actions
// found On that this shell did not switch on are recorded in shell.json and reported, once for each such change
function checkActionsMode() {
  checkActionsOnReady({
    hubPath: state.hubPath,
    qa: QA.enabled,
    read: currentActionsMode,
    seen: () => readShellState(shellStateFile()).actionsModeSeen,
    remember: rememberActionsMode,
    warn: showUnexpectedLiveWarning,
    refreshTray: refreshMenus,
    log,
  });
}

// The warning itself: a tray balloon and a dialog, texts from the string table
function showUnexpectedLiveWarning() {
  const detail = formatString(S.actionsUnexpectedBody, { file: path.join(state.hubPath || '', HUB_SETTINGS_FILE) });
  tray?.displayBalloon({ iconType: 'warning', title: S.actionsUnexpectedTitle, content: detail });
  const options = { type: 'warning', title: S.actionsUnexpectedTitle, message: S.actionsUnexpectedTitle, detail, buttons: [S.actionsUnexpectedOk], noLink: true };
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : null;
  (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)).catch(() => {});
}

// A settings.json that could not be parsed was kept aside before a new one was written (helpers.mjs writeHubSetting)
function keptAsideLogged(r) {
  if (r?.keptAside) log(`settings.json could not be parsed; kept aside as ${path.basename(r.keptAside)} and written again`);
  return r;
}

function showActionsError(error) {
  if (QA.enabled) return;
  const file = error?.file || path.join(state.hubPath || '', HUB_SETTINGS_FILE);
  const code = error?.code;
  const detail =
    code === 'SETTINGS_INVALID'
      ? formatString(S.actionsErrorInvalid, { file })
      : code === 'SETTINGS_UNREADABLE'
        ? formatString(S.actionsErrorRead, { file, code: error?.detail || code })
        : code === 'WRITE_FAILED'
          ? formatString(S.actionsErrorWrite, { file, code: error?.detail || code })
          : S.actionsErrorNoHub;
  dialog.showMessageBox({ type: 'error', title: S.actionsErrorTitle, message: S.actionsErrorTitle, detail }).catch(() => {});
}

// The only way the mode changes: the radio items of the tray and of the window menu, the in-app panel (source 'panel',
// through onPanelActionsRequest) and the QA switch call this. Order: confirmation for On (the tested requestActionsMode:
// in the panel, or handed to the panel for a menu, or the native dialog) -> atomic write of settings.json -> restart of the
// server, which reads the new mode. Cancel or a failed write keeps the previous mode; both menus are rebuilt from the
// stored value either way. A failed write is shown in the panel when the panel asked, otherwise in a native dialog.
async function chooseActionsMode(requested, source) {
  if (state.switchingActions) {
    refreshMenus();
    return { changed: false, reason: 'busy' };
  }
  state.switchingActions = true;
  try {
    const result = await requestActionsMode({
      requested,
      source,
      current: currentActionsMode(),
      qa: QA.enabled,
      windowReady: panelWindowReady(),
      handOver: handOverToPanel,
      confirmNative: confirmActionsOn,
      switchMode: (confirm) =>
        switchActionsMode({
          hubPath: state.hubPath,
          writable: !state.hubOverlaps,
          requested,
          confirm,
          remember: rememberActionsMode,
          apply: (mode) => applyActionsMode(mode),
        }),
    });
    keptAsideLogged(result);
    log(`actions mode (${source}): ${result.from} -> ${requested}: ${result.reason}${result.error ? ` (${result.error.code}${result.error.detail ? ` ${result.error.detail}` : ''})` : ''}`);
    if (result.reason === 'write-failed' && source !== 'panel') showActionsError(result.error);
    return result;
  } catch (e) {
    log(`actions mode could not be changed: ${e?.message}`);
    return { changed: false, reason: 'error' };
  } finally {
    state.switchingActions = false;
    refreshMenus();
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setToolTip(attention.tooltip || S.trayTooltip);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: S.trayOpen, click: () => showWindow('tray') },
      { label: S.trayNewProject, click: () => startNewProjectFromTray().catch((e) => log(`new project from the tray failed: ${e?.message}`)) },
      { label: S.trayOpenHub, click: openHubFolder },
      { type: 'separator' },
      { label: S.trayActions, submenu: actionsSubmenu('tray') },
      { label: S.trayStartAtLogin, type: 'checkbox', checked: readOpenAtLogin(), click: (item) => setOpenAtLogin(item.checked) },
      { type: 'separator' },
      { label: S.trayQuit, click: () => quitWithTerminalsConfirmed('tray: Quit') },
    ]),
  );
}

// No tray icon in a hidden QA run (createsTray): every tray use below already copes with tray === null
function createTray() {
  if (!createsTray({ qaHidden: QA_SHELL.hidden })) {
    log('QA hidden: no tray icon');
    return;
  }
  let image = nativeImage.createFromPath(TRAY_ICON_PATH);
  if (image.isEmpty()) image = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16, quality: 'best' });
  tray = new Tray(image);
  tray.on('click', () => showWindow('tray'));
  tray.on('double-click', () => showWindow('tray'));
  refreshTrayMenu();
}

// One-time balloon the first time the window is hidden to the tray; remembered in the data folder
function showTrayHint() {
  if (QA.enabled || !tray) return;
  if (readShellState(shellStateFile()).trayHintShown) return;
  tray.displayBalloon({ iconType: 'info', title: S.trayHintTitle, content: S.trayHintBody });
  updateShellState(shellStateFile(), { trayHintShown: true }); // if it cannot be saved the hint shows again next time
}

// ---------------------------------------------------------------- a new project (docs/start-flow.md, step 2)

// The folders a new project may not be, as the shell knows them; the server adds the catalog's own rules (AppData,
// the temp folder, the personal Claude folder, ...). The system folders (systemFolderRules: %SystemRoot% and all
// below it; the Program Files, ProgramData and OneDrive roots themselves) are refused as 'broad', like the server does.
function projectFolderRules() {
  const known = (name) => {
    try {
      return app.getPath(name);
    } catch {
      return null;
    }
  };
  const usual = ['Desktop', 'Documents', 'Downloads'].map((d) => path.join(HOME_DIR, d));
  const system = systemFolderRules(process.env);
  return {
    homeDir: HOME_DIR,
    broadDirs: [known('desktop'), known('documents'), known('downloads'), ...usual, ...system.roots].filter(Boolean),
    systemTrees: system.trees,
    hubPath: state.hubPath,
    programDirs: [path.dirname(process.execPath), app.getAppPath()],
  };
}

// The sender of a bridge call as bridgeSender reads it (the same facts onPanelActionsRequest passes)
function senderFacts(event) {
  return { mainWindow: Boolean(win && !win.isDestroyed() && event?.sender === win.webContents), frame: frameFacts(event?.senderFrame), origin: state.origin };
}

// window.sibersentezShell.pickProjectFolder(): only from the main window's top frame on the server origin, one picker at
// a time, modal to the window. The chosen folder is checked here (checkProjectFolder) and again by the server, which
// remembers it as a project. The answer (projectReply) carries the project id, never the path; the log says what
// happened, never which folder. Works in every actions mode: the project memory is the program's own record.
async function onPickProjectFolderRequest(event) {
  const check = bridgeSender(senderFacts(event));
  if (!check.ok) {
    log(`new project request from a page refused (${check.reason})`);
    return projectReply({ ok: false, reason: 'refused' });
  }
  if (state.pickingFolder) return projectReply({ ok: false, reason: 'busy' });
  state.pickingFolder = true;
  try {
    const result = await pickProjectFolder({
      S,
      showOpenDialog: (options) => dialog.showOpenDialog(win, options),
      check: (folder) => checkProjectFolder(folder, projectFolderRules()),
      add: (folder) => serverCalls.call(state.server, 'project-add', { path: folder }),
    });
    const reply = projectReply(result);
    log(`new project: ${reply.ok ? (reply.existed ? 'already listed' : 'added') : reply.reason}`);
    return reply;
  } catch (e) {
    log(`new project failed: ${e?.message}`);
    return projectReply({ ok: false, reason: 'error' });
  } finally {
    state.pickingFolder = false;
  }
}

// window.sibersentezShell.setLanguage(lang): the language chosen in Settings ('auto' | 'en' | 'tr'). Same sender rule;
// written into the hub's settings.json, the menus take it at once and the window loads again in that language.
async function onSetLanguageRequest(event, lang) {
  const check = bridgeSender(senderFacts(event));
  if (!check.ok) {
    log(`language request from a page refused (${check.reason})`);
    return { ok: false, reason: 'refused' };
  }
  if (!LANGUAGE_CHOICES.includes(lang)) return { ok: false, reason: 'invalid' };
  const r = keptAsideLogged(writeHubLanguageSetting(state.hubPath, lang));
  if (!r.ok) {
    log(`language not saved (${r.code})`);
    return { ok: false, reason: 'error' };
  }
  const setting = lang === 'auto' ? null : lang;
  setLanguage(pickLanguage({ setting, locale: app.getLocale() }));
  state.pageLang = explicitLanguage(setting);
  refreshMenus();
  log(`language: ${state.lang} (chosen in Settings)`);
  // The answer first, then the page loads again with the new language
  setTimeout(() => {
    if (win && !win.isDestroyed() && state.origin) win.loadURL(pageUrl());
  }, 80);
  return { ok: true };
}

// window.sibersentezShell.pickLibraryFolder(): the folder picker of "Add to the library", with the same sender rule and
// one picker at a time. Answers { ok, path } (libraryPickReply); the log never names the folder.
async function onPickLibraryFolderRequest(event) {
  const check = bridgeSender(senderFacts(event));
  if (!check.ok) {
    log(`library folder request from a page refused (${check.reason})`);
    return { ok: false, reason: 'refused' };
  }
  if (state.pickingFolder) return { ok: false, reason: 'busy' };
  state.pickingFolder = true;
  try {
    const reply = libraryPickReply(await dialog.showOpenDialog(win, libraryFolderDialogOptions(S)));
    log(`library folder: ${reply.ok ? 'chosen' : reply.reason}`);
    return reply;
  } catch (e) {
    log(`library folder picker failed: ${e?.message}`);
    return { ok: false, reason: 'error' };
  } finally {
    state.pickingFolder = false;
  }
}

// window.sibersentezShell.saveProjectIdea(projectId, text): checked by projectIdeaRequest (the same sender rule), stored by
// the server with the project's memory entry (only a project it already remembers). The text is never logged.
async function onSaveProjectIdeaRequest(event, projectId, text) {
  const check = projectIdeaRequest({ projectId, text, ...senderFacts(event) });
  if (!check.ok) {
    log(`idea request from a page refused (${check.reason})`);
    return projectReply({ ok: false, reason: check.reason === 'invalid' ? 'invalid' : 'refused' });
  }
  try {
    return projectReply(await serverCalls.call(state.server, 'project-idea', { projectId: check.projectId, idea: check.text }));
  } catch (e) {
    log(`idea could not be saved: ${e?.message}`);
    return projectReply({ ok: false, reason: 'error' });
  }
}

// "New project…" in the tray (the tested newProjectFromTray): the window comes up and its page starts the same flow as
// its header button, through the bridge. One fixed script, no data; a page that does not take it within the time limit
// is logged. While the window cannot take it (the server is restarting, an error page) the tray says so in a balloon.
async function startNewProjectFromTray() {
  return newProjectFromTray({
    windowReady: panelWindowReady(),
    show: () => showWindow('tray: new project'),
    handOver: () => settleWithin(() => win.webContents.executeJavaScript(NEW_PROJECT_SCRIPT), NEW_PROJECT_HANDOVER_MS, false),
    notify: showNewProjectNotReady,
    log,
  });
}

// The tray balloon for "New project…" while the window is not ready (texts from the string table)
function showNewProjectNotReady() {
  tray?.displayBalloon({ iconType: 'info', title: S.newProjectNotReadyTitle, content: S.newProjectNotReadyBody });
}

// ---------------------------------------------------------------- QA and exit

// Permission states as the page sees them (read-only query; the clipboard itself is not touched)
const QA_PERMISSION_PROBE = `Promise.all(['clipboard-write', 'clipboard-read', 'notifications', 'geolocation'].map((name) =>
  navigator.permissions.query({ name }).then((s) => name + '=' + s.state, () => name + '=error'))).then((r) => r.join(', '))`;

// QA actions switch (SIBERSENTEZ_QA_ACTIONS): after the first page load and the QA delay, the mode changes through
// chooseActionsMode, the tray's own path. The tray submenu's template is logged before and after.
function logQaActionsMenu(when) {
  const items = actionsMenuItems(S, currentActionsMode()).map(({ label, checked }) => ({ label, checked }));
  log(`QA tray actions menu (${when}): ${JSON.stringify({ label: S.trayActions, submenu: items })}`);
}

function scheduleQaActions() {
  if (qaActionsStep !== 'pending') return;
  qaActionsStep = 'running';
  setTimeout(async () => {
    logQaActionsMenu('before');
    const r = await chooseActionsMode(QA_ACTIONS.mode, 'qa');
    logQaActionsMenu('after');
    qaActionsStep = 'done';
    // No change means no restart and no reload: the page on screen is final
    if (!r?.changed) scheduleQaShot();
  }, QA.delayMs);
}

function scheduleQaShot() {
  // With a QA actions switch the screenshot waits for the page reloaded after the restart; the probes take their own
  if (!QA.shot || QA_SHELL.probes || qaShotScheduled || (qaActionsStep !== 'none' && qaActionsStep !== 'done')) return;
  qaShotScheduled = true;
  setTimeout(async () => {
    log(`QA permissions: ${await qaRun(QA_PERMISSION_PROBE)}`);
    await qaCapture(QA.shot);
    quitApp('QA: screenshot taken');
  }, QA.delayMs);
}

// Every script the QA code runs in the page goes through here: fixed texts only (QA_PERMISSION_PROBE and the probes'
// scripts in helpers.mjs). An error is returned as text, never thrown.
async function qaRun(script) {
  try {
    return await win.webContents.executeJavaScript(script);
  } catch (e) {
    return `error: ${e?.message}`;
  }
}

// The window's page as a PNG (never overwrites an existing file). A hidden window paints its first page by itself
// (windowOptions); after a later navigation it may still hold an old frame. While a capture runs the page counts as
// visible to its renderer (Electron's capturer count), so a first capture asks for a new frame and the second one,
// a moment later, takes it.
async function qaCapture(file) {
  try {
    await win.webContents.capturePage();
    win.webContents.invalidate();
    await qaSleep(1500);
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, image.toPNG(), { flag: 'wx' }); // never overwrites an existing file
    const { width, height } = image.getSize();
    log(`QA: screenshot saved (${width}x${height}${image.isEmpty() ? ', empty' : ''})`);
  } catch (e) {
    log(`QA: screenshot failed: ${e?.code || e?.message}`);
  }
}

// ---------------------------------------------------------------- QA probes (SIBERSENTEZ_QA_PROBES)
// Each probe writes one line "QA probe <name>: <result>" to the main log, which qa/electron-qa.ps1 reads. Nothing of a
// probe needs a visible window, a dialog or the tray; the project probe runs only in a hidden run.

// One-shot signals of the shell's own events: the next ready server, the next finished page load
const qaWaiters = { 'server-ready': [], 'page-loaded': [] };
function qaSignal(name) {
  const list = qaWaiters[name];
  if (!list?.length) return;
  qaWaiters[name] = [];
  for (const resolve of list) resolve(true);
}
function qaNext(name, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    qaWaiters[name].push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
const qaSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const qaJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
function qaProbe(name, value) {
  log(`QA probe ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

let qaProbesStarted = false;
function scheduleQaProbes() {
  if (!QA_SHELL.probes || qaProbesStarted) return;
  qaProbesStarted = true;
  setTimeout(() => {
    runQaProbes()
      .catch((e) => log(`QA probes failed: ${e?.message}`))
      .finally(() => quitApp('QA: probes done'));
  }, QA.delayMs);
}

// setActionsMode(mode) through the page's bridge (the in-app panel's path, IPC and all). The running server takes the
// mode in place (docs/actions-toggle.md §3.5), which the shell has awaited before the bridge answers: the probe asks
// the page's server for the mode it now serves and checks that the same server process is still the one
async function qaSwitchThroughBridge(mode) {
  const oldPid = state.server?.pid ?? null;
  const reply = qaJson(await qaRun(QA_ACTIONS_SCRIPTS[mode]));
  const stored = currentActionsMode();
  const served = qaJson(await qaRun(QA_SERVED_MODE_SCRIPT));
  qaProbe(`actions ${mode}`, { reply, stored, served, sameServer: oldPid !== null && (state.server?.pid ?? null) === oldPid });
}

// A new project the way the header button adds one, without the picker: the tested pickProjectFolder with the QA
// folder as the picker's answer, the shell's folder check, and the server's 'project-add' over its message channel;
// then the idea. The log gets the replies (projectReply: never a path).
async function qaProjectProbe() {
  const rules = projectFolderRules();
  const reasonOf = (folder) => checkProjectFolder(folder, rules).reason || 'ok';
  qaProbe('folder rule inside the hub', reasonOf(path.join(state.hubPath, 'registry')));
  qaProbe('folder rule holding the hub', reasonOf(path.dirname(state.hubPath)));
  const systemRoot = systemFolderRules(process.env).trees[0];
  qaProbe('folder rule system folder', systemRoot ? reasonOf(path.join(systemRoot, 'System32')) : 'no SystemRoot');
  const added = projectReply(
    await pickProjectFolder({
      S,
      showOpenDialog: async () => ({ canceled: false, filePaths: [QA_SHELL.projectDir] }),
      check: (folder) => checkProjectFolder(folder, rules),
      add: (folder) => serverCalls.call(state.server, 'project-add', { path: folder }),
    }),
  );
  qaProbe('project-add', added);
  if (!added.ok) return;
  qaProbe('project-idea', projectReply(await serverCalls.call(state.server, 'project-idea', { projectId: added.projectId, idea: 'QA: a small test project' })));
}

// The actions panel through its own QA hook (?qa=1&actpanel=choose), and a screenshot of it
async function qaPanelProbe() {
  const loaded = qaNext('page-loaded', 30000);
  win.loadURL(`${state.origin}${QA_PANEL_PATH}`);
  if (!(await loaded)) return qaProbe('actions panel', 'page not loaded');
  let panel = 'closed';
  for (let i = 0; i < 40 && panel !== 'open'; i++) {
    await qaSleep(250);
    panel = await qaRun(QA_PANEL_PROBE_SCRIPT);
  }
  qaProbe('actions panel', panel);
  if (QA.shot) await qaCapture(QA.shot);
}

async function runQaProbes() {
  qaProbe('hidden', { hidden: QA_SHELL.hidden, visible: Boolean(win?.isVisible()), tray: Boolean(tray) });
  qaProbe('bridge', await qaRun(QA_BRIDGE_PROBE_SCRIPT));
  qaProbe('kit', await qaRun(QA_KIT_PROBE_SCRIPT));
  qaProbe('about', await qaRun(QA_ABOUT_PROBE_SCRIPT));
  qaProbe('kit folder', { packaged: app.isPackaged, resourcesKit: app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'kit', 'catalog.json')) });
  // On is never reached in QA: not through the page's bridge, not through the tray's path
  qaProbe('actions live via bridge', { reply: qaJson(await qaRun(QA_ACTIONS_SCRIPTS.live)), stored: currentActionsMode() });
  const viaTray = await chooseActionsMode('live', 'tray');
  qaProbe('actions live via tray', { changed: viaTray.changed, reason: viaTray.reason, stored: currentActionsMode() });
  await qaSwitchThroughBridge('dry');
  await qaSwitchThroughBridge('off');
  if (QA_SHELL.hidden && QA_SHELL.projectDir) await qaProjectProbe();
  else qaProbe('project-add', 'skipped (needs SIBERSENTEZ_QA_HIDDEN=1 and SIBERSENTEZ_QA_PROJECT_DIR)');
  await qaPanelProbe();
  await qaTerminalProbe();
  qaProbe('hidden at the end', { visible: Boolean(win?.isVisible()), tray: Boolean(tray) });
}

// The embedded terminals' pseudo console in this build (docs/embedded-terminal.md): node-pty loads from outside the
// archive and runs one fixed command in the temp folder; nothing reaches the window
async function qaTerminalProbe() {
  const unpacked = app.isPackaged ? fs.existsSync(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node')) : null;
  const result = await new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = loadPty().spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/c', 'echo sibersentez-pty-ok'], { name: 'xterm-256color', useConpty: true, cwd: os.tmpdir(), cols: 80, rows: 24, env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows' } }); // an empty environment: CreateProcess error 87 on current Windows
    } catch (e) {
      resolve({ loaded: false, error: e?.code || e?.message || 'error' });
      return;
    }
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        // gone
      }
      resolve({ loaded: true, exitCode: null, echoed: out.includes('sibersentez-pty-ok') });
    }, 10000);
    p.onData((d) => (out += d));
    p.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve({ loaded: true, exitCode, echoed: out.includes('sibersentez-pty-ok') });
    });
  });
  qaProbe('terminal', { unpacked, ...result });
}

function quitApp(reason) {
  if (!state.quitting) log(`quit: ${reason}`);
  state.quitting = true;
  terminals.closeAll();
  app.quit();
}

// ---------------------------------------------------------------- embedded terminals (docs/embedded-terminal.md)
// node-pty is loaded on the first terminal only, so a program whose pty binaries cannot load still starts and
// reports it when a terminal is asked for
let ptyModule = null;
function loadPty() {
  if (!ptyModule) ptyModule = createRequire(import.meta.url)('node-pty');
  return ptyModule;
}
const terminals = createTerminals({
  // Closing a terminal ends its shell tree with taskkill, never with node-pty's fork (avoidForkOnKill)
  spawn: (file, args, opts) => avoidForkOnKill(loadPty().spawn(file, args, { name: 'xterm-256color', useConpty: true, ...opts }), (pid) => taskkillTree(spawnProcess, pid)),
  // Output goes only to the main window while it shows the app (panelWindowReady); what it misses stays in the
  // terminal's buffer, which the page asks for when it loads (list)
  send: (channel, ...args) => {
    if (win && !win.isDestroyed() && panelWindowReady()) win.webContents.send(channel, ...args);
  },
  log,
  env: process.env,
});

// Every terminal call passes the bridge's sender rule first (main window, top frame, the app's origin)
const termSenderOk = (event) => bridgeSender(senderFacts(event)).ok;

async function onTermOpen(event, req, cols, rows) {
  if (!termSenderOk(event)) {
    log('terminal request from a page refused (sender)');
    return { ok: false, reason: 'refused' };
  }
  const r = termOpenRequest(req);
  if (!r.ok) return { ok: false, reason: 'invalid' };
  // Where it opens is the server's answer (the terminal action's checks, live mode only); the page sent ids only
  const target = await serverCalls.call(state.server, 'terminal-target', r.target);
  if (target?.ok !== true || typeof target.dir !== 'string') return { ok: false, reason: typeof target?.reason === 'string' ? target.reason : 'refused' };
  try {
    return terminals.open({ dir: target.dir, title: target.title, projectId: target.projectId || null, cols, rows, launch: target.program || null });
  } catch (e) {
    log(`terminal could not start: ${e?.message}`);
    return { ok: false, reason: 'no-pty' };
  }
}

async function quitWithTerminalsConfirmed(reason) {
  const ok = await confirmQuitWithTerminals({ count: terminals.count(), S, qa: QA.enabled, parent: win && !win.isDestroyed() && win.isVisible() ? win : null, showMessageBox: (...a) => dialog.showMessageBox(...a) });
  if (ok) quitApp(reason);
  else log(`quit cancelled: terminals running`);
}

function main() {
  app.setAppUserModelId(APP_ID);
  if (QA_SHELL.hidden) {
    // Electron reports an uncaught error of the main process in a native dialog; a hidden run logs it and quits instead
    process.on('uncaughtException', (e) => {
      log(`QA hidden: uncaught error: ${e?.stack || e?.message}`);
      state.quitting = true;
      stopServer('uncaught error');
      app.exit(1);
    });
  }
  app.on('second-instance', () => {
    log(QA_SHELL.hidden ? 'second launch: the window stays hidden (QA hidden)' : 'second launch: existing window brought to front');
    showWindow('second launch');
  });
  app.on('web-contents-created', (_e, contents) => hardenContents(contents));
  app.on('window-all-closed', () => {
    /* the app lives in the tray; it only exits through Quit */
  });
  app.on('before-quit', () => {
    state.quitting = true;
  });
  app.on('will-quit', () => {
    // Every way out (not only the menus' Quit): the terminals' programs stop with the app
    terminals.closeAll();
    stopServer('app quitting');
    tray?.destroy();
    tray = null;
    log('app closed');
  });

  app
    .whenReady()
    .then(async () => {
      const locale = app.getLocale();
      setLanguage(pickLanguage({ locale }));
      log(`SiberSentez ${app.getVersion()} starting (packaged: ${app.isPackaged}, QA: ${QA.enabled}, Electron ${process.versions.electron})`);
      if (dataDirCheck && !dataDirCheck.ok) log(`SIBERSENTEZ_DATA_DIR ignored (${dataDirCheck.reason}); using the default data folder`);
      if (QA.ignored) log('SIBERSENTEZ_QA_* ignored: a packaged build needs the --qa switch');
      if (QA.rejected) log(`QA option rejected: ${QA.rejected}`);
      if (QA_ACTIONS.rejected) log(`QA option rejected: ${QA_ACTIONS.rejected}`);
      if (QA_SHELL.rejected) log(`QA option rejected: ${QA_SHELL.rejected}`);
      if (QA.enabled) log(`QA shell: ${JSON.stringify({ hidden: QA_SHELL.hidden, probes: QA_SHELL.probes, projectDir: Boolean(QA_SHELL.projectDir) })}`);
      hardenSession(session.defaultSession);
      // The preload's channels (§3b, docs/start-flow.md): every call is checked by bridgeSender (panelRequest,
      // projectIdeaRequest) before anything happens
      ipcMain.handle(ACTIONS_IPC_CHANNEL, onPanelActionsRequest);
      ipcMain.handle(PROJECT_PICK_IPC_CHANNEL, onPickProjectFolderRequest);
      ipcMain.handle(LIBRARY_PICK_IPC_CHANNEL, onPickLibraryFolderRequest);
      ipcMain.handle(LANGUAGE_IPC_CHANNEL, onSetLanguageRequest);
      ipcMain.handle(PROJECT_IDEA_IPC_CHANNEL, onSaveProjectIdeaRequest);
      ipcMain.handle(ATTENTION_IPC_CHANNEL, onAttention);
      ipcMain.handle(TERMINAL_IPC.open, onTermOpen);
      ipcMain.handle(TERMINAL_IPC.list, (event) => (termSenderOk(event) ? terminals.list() : []));
      ipcMain.handle(TERMINAL_IPC.close, (event, id) => termSenderOk(event) && terminals.close(id));
      ipcMain.on(TERMINAL_IPC.write, (event, id, data) => termSenderOk(event) && terminals.write(id, data));
      ipcMain.on(TERMINAL_IPC.resize, (event, id, cols, rows) => termSenderOk(event) && terminals.resize(id, cols, rows));
      // SIBERSENTEZ_HUB is honoured and passed on to the server: it chooses the hub, and so the settings.json the actions
      // mode is read from. It is not a way around the tray (a program that can set it can edit settings.json too).
      const hub = resolveHubPath(process.env, HOME_DIR);
      if (hub.rejected) log(`SIBERSENTEZ_HUB ignored (${hub.rejected}); using the default hub folder`);
      state.hubPath = migrateLegacyHub(hub);
      rememberLegacyMode();
      await prepareHub(state.hubPath);
      const languageSetting = readHubLanguageSetting(state.hubPath);
      setLanguage(pickLanguage({ setting: languageSetting, locale }));
      state.pageLang = explicitLanguage(languageSetting);
      log(`language: ${state.lang} (locale ${locale})`);
      log(`actions mode: ${currentActionsMode()}`);
      buildAppMenu();
      createTray();
      if (QA.quitMs) setTimeout(() => quitApp(`QA: ${QA.quitMs} ms elapsed`), QA.quitMs);
      await launchServer();
    })
    .catch((e) => {
      log(`startup failed: ${e?.stack || e?.message}`);
      if (!QA.enabled) dialog.showErrorBox(S.errorTitle, formatString(S.errorStartup, { message: String(e?.message || e) }));
      state.quitting = true;
      stopServer('startup failed');
      app.exit(1);
    });
}

if (app.requestSingleInstanceLock()) {
  main();
} else {
  log('another SiberSentez is already running; it was notified, this instance exits');
  app.quit();
}
