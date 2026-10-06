// Pure helpers for the SiberSentez desktop shell. They never import Electron: the main process (main.mjs) only
// wires them to Electron events, and test/electron.test.mjs exercises their behaviour with plain Node.
// Covered: free port lookup, folder validation, hub path, navigation/request/permission policy (with the retired
// shell path), server environment, readiness probe, the restart supervisor and stopping a server on purpose, the
// actions-mode switch, its menus, the in-app panel's IPC request and the confirmation for On (docs/actions-toggle.md),
// the new-project bridge (folder picker, folder rules, the idea, calls to the server process; docs/start-flow.md),
// the shell's own state file, QA options, UI language and log redaction.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export const HOST = '127.0.0.1';
// The shell's own port range. It stays away from 4545, the default of a standalone panel the user may run,
// so starting the app first at login never pushes that panel off its port.
export const PORT_RANGE_START = 47700;
export const PORT_RANGE_END = 47799;
export const HUB_DIR_NAME = 'SiberSentez';
// The hub's name before the product was renamed (2026-09-30): its folder is moved to the new name once
export const LEGACY_HUB_DIR_NAME = 'Orkestra';
export const HUB_SETTINGS_FILE = 'settings.json';
// The server echoes SIBERSENTEZ_INSTANCE in this response header; the shell only trusts a port that answers with it
export const INSTANCE_HEADER = 'x-sibersentez-instance';
// Registry value name of the "Start at login" entry (build/installer.nsh deletes the same name on uninstall)
export const LOGIN_ITEM_NAME = 'app.sibersentez.panel';
export const SUPPORTED_LANGUAGES = Object.freeze(['en', 'tr']);
// Permissions granted to our own origin only: desktop notifications (public/js/notify.js) and writing to the
// clipboard (the "Copy" buttons). Reading the clipboard and everything else stays denied.
export const ALLOWED_PERMISSIONS = Object.freeze(['notifications', 'clipboard-sanitized-write']);
const MAX_URL_LENGTH = 4096;
const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------- ports

// Tells whether a port is free on 127.0.0.1 by trying to listen on it.
// It never connects, so a server already on that port receives no request.
export function isPortFree(port, host = HOST) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host }, () => probe.close(() => resolve(true)));
  });
}

// First free port in [start, end]; `preferred` (e.g. the previous port on a restart) is tried first when it
// lies inside the range. Throws when the whole range is busy.
export async function findFreePort({ start = PORT_RANGE_START, end = PORT_RANGE_END, preferred = null, host = HOST } = {}) {
  const valid = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
  if (!valid(start) || !valid(end) || end < start) throw new RangeError(`invalid port range: ${start}-${end}`);
  const order = [];
  if (Number.isInteger(preferred) && preferred >= start && preferred <= end) order.push(preferred);
  for (let p = start; p <= end; p++) if (p !== preferred) order.push(p);
  for (const port of order) {
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`no free port found (${start}-${end})`);
}

// ---------------------------------------------------------------- paths

function comparable(p) {
  const r = path.resolve(p);
  const trimmed = r.length > path.parse(r).root.length ? r.replace(/[\\/]+$/, '') : r;
  return IS_WINDOWS ? trimmed.toLowerCase() : trimmed;
}

export function samePath(a, b) {
  return comparable(a) === comparable(b);
}

// True when `child` lies strictly inside `parent`
export function isInside(child, parent) {
  const c = comparable(child);
  const p = comparable(parent);
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c !== p && c.startsWith(prefix);
}

// True when the two folders are the same or one contains the other (as written)
export function pathsOverlap(a, b) {
  return samePath(a, b) || isInside(a, b) || isInside(b, a);
}

// Real form of a path: the deepest existing ancestor goes through realpath (junctions, symbolic links and 8.3
// short names are resolved), the part that does not exist yet is appended unchanged. Never throws: if nothing
// along the path exists (e.g. a missing drive) the lexical absolute form is returned.
export function canonicalPath(p, realpath = fs.realpathSync.native) {
  const absolute = path.resolve(p);
  let current = absolute;
  const tail = [];
  for (;;) {
    try {
      return path.join(realpath(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

// Overlap check that cannot be sidestepped with a junction, a symbolic link or a short name:
// the folders overlap if they do so as written or in their real form.
export function foldersOverlap(a, b, realpath = fs.realpathSync.native) {
  return pathsOverlap(a, b) || pathsOverlap(canonicalPath(a, realpath), canonicalPath(b, realpath));
}

// A folder coming from an environment variable must be a local absolute path (a drive letter on Windows):
// not a network (UNC) or device path, not a drive root, and neither the home folder nor one of its parents.
export function checkLocalDir(raw, { homeDir } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' };
  const v = raw.trim();
  if (/^[\\/]{2}/.test(v)) return { ok: false, reason: 'network or device path' };
  if (IS_WINDOWS ? !/^[a-zA-Z]:[\\/]/.test(v) : !path.isAbsolute(v)) return { ok: false, reason: 'not an absolute local path' };
  if (/[<>:"|?*\u0000-\u001f]/.test(IS_WINDOWS ? v.slice(2) : v)) return { ok: false, reason: 'invalid characters' };
  const resolved = path.resolve(v);
  if (samePath(resolved, path.parse(resolved).root)) return { ok: false, reason: 'drive root' };
  if (typeof homeDir === 'string' && homeDir.trim() && (samePath(resolved, homeDir) || isInside(homeDir, resolved))) {
    return { ok: false, reason: 'home folder or one of its parents' };
  }
  return { ok: true, path: resolved };
}

// Hub folder: a valid SIBERSENTEZ_HUB, otherwise <home>\SiberSentez. An invalid SIBERSENTEZ_HUB is reported in `rejected`.
export function resolveHubPath(env, homeDir) {
  const raw = env?.SIBERSENTEZ_HUB;
  let rejected = null;
  if (typeof raw === 'string' && raw.trim()) {
    const c = checkLocalDir(raw, { homeDir });
    if (c.ok) return { path: c.path, source: 'env', rejected: null };
    rejected = c.reason;
  }
  if (typeof homeDir !== 'string' || !homeDir.trim()) throw new Error('home folder unknown; cannot resolve the hub path');
  return { path: path.join(homeDir.trim(), HUB_DIR_NAME), source: 'default', rejected };
}

// What to do with a hub that still has the old product's name (pure). Only the default hub is ever moved (a hub named
// by SIBERSENTEZ_HUB is the person's choice); only when the new folder is not there and the old one is a real folder.
// Returns 'move' (rename the old folder to the new name), or 'none'.
export function legacyHubPlan({ source, newExists, oldIsDir }) {
  return source === 'default' && !newExists && oldIsDir ? 'move' : 'none';
}

// ---------------------------------------------------------------- navigation, requests, permissions

// The only origin the window may show
export function appOrigin(port) {
  return `http://${HOST}:${port}`;
}

function parseUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL_LENGTH) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// Own-origin rule: scheme + 127.0.0.1 + port must match exactly, without username/password.
// If the origin is not a valid http://127.0.0.1:<port> (e.g. the server is not ready yet) nothing matches,
// so "null"-origin URLs such as data: or file: can never slip through "null" === "null".
export function isAppUrl(raw, origin) {
  if (typeof origin !== 'string' || !origin.startsWith(`http://${HOST}:`)) return false;
  const u = parseUrl(raw);
  return !!u && u.origin === origin && !u.username && !u.password;
}

// External link rule: http and https only, non-empty host, no credentials.
// Schemes such as file:, javascript:, data:, mailto: or ms-settings: never reach the OS or the default browser.
export function isExternalUrl(raw) {
  const u = parseUrl(raw);
  return !!u && (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password;
}

// 'allow' = stays in the window, 'external' = may open in the default browser, 'deny' = blocked
export function classifyNavigation(raw, origin) {
  if (isAppUrl(raw, origin)) return 'allow';
  if (isExternalUrl(raw)) return 'external';
  return 'deny';
}

// What to do with a navigation attempt. kind:
//   'navigate'    main-frame navigation (link click, location change): own origin proceeds; an external
//                 http(s) link is cancelled and opened in the default browser; anything else is cancelled
//   'redirect'    server redirect: only within our origin, never opened externally
//   'frame'       subframe navigation: only within our origin, never opened externally
//   'window-open' window.open / target=_blank: no new windows ever; an external http(s) link goes to the browser
export function decideNavigation(kind, raw, origin) {
  const verdict = classifyNavigation(raw, origin);
  if (kind === 'window-open') return { cancel: true, openExternal: verdict === 'external' };
  if (verdict === 'allow' && (kind === 'navigate' || kind === 'redirect' || kind === 'frame')) return { cancel: false, openExternal: false };
  return { cancel: true, openExternal: kind === 'navigate' && verdict === 'external' };
}

// A retired same-origin path. Until the in-app switch (docs/actions-toggle.md §3b) the page navigated its own window
// here to make the shell open a native chooser. Nothing asks for it any more and it opens nothing now; the navigation
// guard still cancels exactly this navigation so that a stale caller never replaces the panel with the server's 404.
export const SHELL_ACTIONS_MODE_PATH = '/__shell/actions-mode';

// True only for exactly <origin>/__shell/actions-mode: no query, no fragment, no credentials, no other spelling of the
// path that the URL parser does not reduce to it (Electron hands the guard the parsed, canonical URL).
export function isShellActionsModeUrl(raw, origin) {
  if (!isAppUrl(raw, origin)) return false;
  return parseUrl(raw).href === `${origin}${SHELL_ACTIONS_MODE_PATH}`;
}

// The navigation guard's decision for the retired path. null: the url is not <origin>/__shell/actions-mode and the
// ordinary rules (decideNavigation) apply. Otherwise the navigation is cancelled, whatever started it, and nothing else
// happens: no dialog, no mode change, never the browser. Returns null | { cancel: true, openExternal: false }.
export function shellNavigation({ url, origin } = {}) {
  if (!isShellActionsModeUrl(url, origin)) return null;
  return { cancel: true, openExternal: false };
}

// Network filter: the page may only reach its own origin (ws/wss are checked like http/https)
export function requestAllowed(raw, origin) {
  if (typeof raw !== 'string') return false;
  return isAppUrl(raw.replace(/^ws(s?):/i, 'http$1:'), origin);
}

// Permission rule: everything is denied except ALLOWED_PERMISSIONS requested by our own origin. A hidden QA run
// (readQaShellOptions) denies notifications too: a desktop notification would reach the screen of the person at
// this computer, and no window of that run is ever shown.
export function permissionAllowed(permission, requestingUrl, origin, { qaHidden = false } = {}) {
  if (qaHidden === true && permission === 'notifications') return false;
  return ALLOWED_PERMISSIONS.includes(permission) && isAppUrl(requestingUrl, origin);
}

// ---------------------------------------------------------------- server process

// Variables never passed to the server. SIBERSENTEZ_ACTIONS: the installed app takes the actions mode only from the
// hub's settings.json, so this variable cannot switch actions on. That is not a security boundary: SIBERSENTEZ_HUB
// does reach the server and chooses which settings.json is read, and any program running as the same user can edit
// that file (docs/actions-toggle.md). Node/Electron switches and the shell's own QA/data settings do not belong to
// the server either.
const STRIPPED_ENV = ['SIBERSENTEZ_ACTIONS', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'SIBERSENTEZ_QA_SHOT', 'SIBERSENTEZ_QA_QUIT_MS', 'SIBERSENTEZ_QA_DELAY_MS', 'SIBERSENTEZ_QA_ACTIONS', 'SIBERSENTEZ_QA_HIDDEN', 'SIBERSENTEZ_QA_PROBES', 'SIBERSENTEZ_QA_PROJECT_DIR', 'SIBERSENTEZ_DATA_DIR'];
const SET_ENV = ['SIBERSENTEZ_PORT', 'SIBERSENTEZ_HUB', 'SIBERSENTEZ_INSTANCE'];

// Environment for the server process. Names are compared case-insensitively (Windows environment).
export function buildServerEnv(baseEnv, { port, hubPath, instance }) {
  const env = { ...(baseEnv || {}) };
  for (const key of Object.keys(env)) {
    const k = key.toUpperCase();
    // The same variables under the product's old name (renamed 2026-09-30) are dropped too: the server would take
    // them over (server/config.mjs adoptLegacyEnv)
    const bare = k.startsWith('ORKESTRA_') ? 'SIBERSENTEZ_' + k.slice(9) : k;
    if (STRIPPED_ENV.includes(bare) || SET_ENV.includes(bare)) delete env[key];
  }
  env.SIBERSENTEZ_PORT = String(port);
  env.SIBERSENTEZ_INSTANCE = String(instance);
  if (hubPath) env.SIBERSENTEZ_HUB = hubPath;
  return env;
}

// One readiness probe. Requests the home page with headers that satisfy the server's own access rules
// (Host = 127.0.0.1:<port>, Sec-Fetch-Site = same-origin) and checks the instance header:
//   'ready'   200 and our instance id    'foreign' any answer without our instance id (another server)
//   'down'    no answer yet, or our instance but not 200 yet
export function probeServer(port, { instance, timeoutMs = 1500, host = HOST } = {}) {
  if (typeof instance !== 'string' || !instance) throw new TypeError('probeServer needs the instance id');
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = http.get(
      { host, port, path: '/', agent: false, timeout: timeoutMs, headers: { Host: `${host}:${port}`, 'Sec-Fetch-Site': 'same-origin' } },
      (res) => {
        res.resume();
        if (res.headers[INSTANCE_HEADER] !== instance) return finish('foreign');
        finish(res.statusCode === 200 ? 'ready' : 'down');
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish('down');
    });
    req.on('error', () => finish('down'));
  });
}

// Polls until: 'ready' | 'foreign' (another server owns the port; never load it) | 'timeout' | 'stopped'
export async function waitForServer(port, { instance, timeoutMs = 30000, intervalMs = 250, shouldStop = () => false, host = HOST } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (shouldStop()) return 'stopped';
    const r = await probeServer(port, { instance, host });
    if (shouldStop()) return 'stopped';
    if (r !== 'down') return r;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return 'timeout';
}

// Delay before a restart: 1 s, 2 s, 4 s ... capped at 30 s
export function restartDelay(attempt, { baseMs = 1000, maxMs = 30000 } = {}) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(maxMs, baseMs * 2 ** Math.min(n, 20));
}

// Restart supervisor as a pure state machine.
//   state  { failures, readyAt }     events  { type: 'ready', at } | { type: 'failed', at } | { type: 'requested', at }
// A server that stayed up for stableMs earns a fresh start (failures = 0), but that credit is used once:
// readyAt is cleared on every failure, so a later crash loop at startup backs off and finally gives up.
// 'requested' is a restart the shell asks for itself (a server setting changed): it is not a failure, so it never
// raises the count, never waits for a backoff delay and never gives up. A run that was stable by then ends with a
// fresh start, exactly as a later failure would have found it.
export const SUPERVISOR_DEFAULTS = Object.freeze({ maxFailures: 5, stableMs: 60000, baseMs: 1000, maxMs: 30000 });

export function initialSupervisor() {
  return { failures: 0, readyAt: 0 };
}

// After the page's renderer is gone (a crash, out of memory): reload it after 1, 2, 4 s; the third loss within two
// minutes stops reloading, so a page that crashes on load does not start a renderer every second (pure). times: the
// earlier losses (ms); returns { times, delayMs } or { times, delayMs: null } when it stops.
export const RENDERER_RELOAD = Object.freeze({ windowMs: 120000, maxLosses: 3, baseMs: 1000 });
export function rendererReloadPlan(times, now, c = RENDERER_RELOAD) {
  const recent = (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(t) && now - t < c.windowMs).concat(now);
  if (recent.length >= c.maxLosses) return { times: recent, delayMs: null };
  return { times: recent, delayMs: c.baseMs * 2 ** (recent.length - 1) };
}

export function superviseStep(state, event, options = {}) {
  const c = { ...SUPERVISOR_DEFAULTS, ...options };
  const s = state || initialSupervisor();
  if (event?.type === 'ready') return { state: { failures: s.failures, readyAt: event.at }, action: { type: 'none' } };
  if (event?.type === 'requested') {
    const stable = s.readyAt > 0 && event.at - s.readyAt >= c.stableMs;
    return { state: { failures: stable ? 0 : s.failures, readyAt: 0 }, action: { type: 'restart', delayMs: 0, attempt: 0 } };
  }
  if (event?.type !== 'failed') throw new Error(`unknown supervisor event: ${event?.type}`);
  const stable = s.readyAt > 0 && event.at - s.readyAt >= c.stableMs;
  const failures = stable ? 0 : s.failures;
  if (failures >= c.maxFailures) return { state: { failures, readyAt: 0 }, action: { type: 'give-up', failures } };
  return {
    state: { failures: failures + 1, readyAt: 0 },
    action: { type: 'restart', delayMs: restartDelay(failures, c), attempt: failures + 1 },
  };
}

// What to do when a scheduled restart is due. A launch that is still running (e.g. still waiting for the
// server to answer) must not swallow the restart: it is checked again shortly instead of being dropped.
export const RESTART_RECHECK_MS = 250;

export function restartDue({ quitting = false, launching = false, serverAlive = false } = {}) {
  if (quitting) return { type: 'drop', reason: 'quitting' };
  if (launching) return { type: 'wait', delayMs: RESTART_RECHECK_MS };
  if (serverAlive) return { type: 'drop', reason: 'a server is already running' };
  return { type: 'launch' };
}

// What the shell does after it changed a setting the server reads only when it starts (the actions mode):
//   'restart-now'   a server is running: stop it on purpose and start a new one (a 'requested' restart)
//   'after-launch'  a launch is running: its process may have read the old value, restart it once it is ready
//   'next-launch'   no server and no launch (a restart may be scheduled): the next process reads the new value
//   'none'          the app is quitting
export function settingsRestartPlan({ quitting = false, launching = false, serverAlive = false } = {}) {
  if (quitting) return 'none';
  if (launching) return 'after-launch';
  if (serverAlive) return 'restart-now';
  return 'next-launch';
}

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
export function readHubSettings(hubPath, fsImpl = fs) {
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

const tempSuffix = () => `${process.pid}-${randomBytes(6).toString('hex')}`;

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
function writeHubSetting(hubPath, update, { fsImpl = fs, suffix = tempSuffix } = {}) {
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
    fsImpl.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' });
    fsImpl.renameSync(tmp, cur.file);
  } catch (e) {
    try {
      fsImpl.rmSync(tmp, { force: true });
    } catch {
      /* a leftover temporary file is harmless; settings.json is untouched */
    }
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

export function actionsConfirmOptions(S) {
  return {
    type: 'warning',
    title: S.actionsConfirmTitle,
    message: S.actionsConfirmTitle,
    detail: S.actionsConfirmBody,
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

// ---------------------------------------------------------------- a new project (docs/start-flow.md, step 2)

// Two more channels of the same bridge (electron/preload.cjs keeps its own copy of the names; the tests check both):
//   sibersentez:pick-project-folder  no arguments: the shell opens the folder picker, checks the folder and has the server
//                                 remember it as a project (the program's project memory, <hub>\registry\discovered.json)
//   sibersentez:save-project-idea    (projectId, text): the server keeps the project's idea with that memory entry
// Both work whatever the actions mode is: the project memory is the program's own record, it is written anyway.
export const PROJECT_PICK_IPC_CHANNEL = 'sibersentez:pick-project-folder';
export const PROJECT_IDEA_IPC_CHANNEL = 'sibersentez:save-project-idea';

// "What needs you" on the taskbar (docs/attention.md §4): the page says how many sessions wait for the person and the
// same words as its header counter; the shell puts a dot on the taskbar button, the count in the tray's tooltip, and
// flashes the button when the count grows while the window is in the background. Nothing else comes with it.
export const ATTENTION_IPC_CHANNEL = 'sibersentez:attention';
export const ATTENTION_TEXT_MAX = 80;

// Checks a page's attention report: from the main window's top frame on the app origin, count an integer 0..999, text
// a short printable string. Returns { ok, count, text } or { ok: false, reason }.
export function attentionRequest({ count, text, mainWindow = false, frame = null, origin = null } = {}) {
  const sender = bridgeSender({ mainWindow, frame, origin });
  if (!sender.ok) return sender;
  if (!Number.isInteger(count) || count < 0 || count > 999) return { ok: false, reason: 'invalid' };
  if (typeof text !== 'string' || text.length > ATTENTION_TEXT_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(text)) return { ok: false, reason: 'invalid' };
  return { ok: true, count, text: text.trim() };
}

// What the shell does with a new count (pure): the overlay dot on or off, the tray tooltip, and whether to flash the
// taskbar button (the count grew and the window is not focused).
export function attentionPlan({ count, text, previous = 0, focused = true, baseTooltip = 'SiberSentez' }) {
  return {
    overlay: count > 0,
    tooltip: count > 0 && text ? `${baseTooltip} · ${text}` : baseTooltip,
    flash: count > previous && !focused,
  };
}

// The taskbar dot: a size x size BGRA bitmap (nativeImage.createFromBitmap), a coral disc with a thin dark ring so it
// reads on light and dark taskbars; the edge is softened by coverage
export function attentionBadgeBitmap(size = 16) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const cover = Math.max(0, Math.min(1, r + 0.5 - d));
      if (!cover) continue;
      const ring = d > r - 1.5;
      const [R, G, B] = ring ? [0x5a, 0x1e, 0x14] : [0xff, 0x8f, 0x6b];
      const i = (y * size + x) * 4;
      buf[i] = B;
      buf[i + 1] = G;
      buf[i + 2] = R;
      buf[i + 3] = Math.round(cover * 255);
    }
  }
  return buf;
}

// A project id as the server makes them (registry ids, 'x-<folder slug>'); the same rule as server/actions.mjs
export const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// The longest idea text the bridge carries. The server keeps at most 300 characters after it cleaned the text
// (server/fit.mjs normalizeIdea, which reads no more than this many code units in the first place).
export const IDEA_TEXT_MAX = 1200;

// Whether a saveProjectIdea call may reach the server: the bridge's sender rule, a project id and a string of at most
// IDEA_TEXT_MAX characters ('' clears the idea). The text is cleaned by the server, not here.
// Returns { ok: true, projectId, text } or { ok: false, reason: <bridgeSender's> | 'invalid' }.
export function projectIdeaRequest({ projectId, text, mainWindow = false, frame = null, origin = null } = {}) {
  const sender = bridgeSender({ mainWindow, frame, origin });
  if (!sender.ok) return sender;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return { ok: false, reason: 'invalid' };
  if (typeof text !== 'string' || text.length > IDEA_TEXT_MAX) return { ok: false, reason: 'invalid' };
  return { ok: true, projectId, text };
}

// The system folder picker. Windows' picker has "New folder" itself; createDirectory asks for the same on macOS.
export function projectFolderDialogOptions(S) {
  return { title: S.newProjectPickTitle, buttonLabel: S.newProjectPickButton, properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] };
}

// "Add to the library" from a folder (docs/skills-flow.md §5): the page asks for the system folder picker instead of a
// typed path. The answer carries the chosen folder's path: the page shows it in the folder field and sends it to the
// server's library-scan (which checks it again, as it checks a typed path). Nothing is read or copied here.
export const LIBRARY_PICK_IPC_CHANNEL = 'sibersentez:pick-library-folder';
export const LIBRARY_SOURCE_MAX = 260; // the server's limit for a scan source (bad-source past it)

export function libraryFolderDialogOptions(S) {
  return { title: S.libraryPickTitle, buttonLabel: S.libraryPickButton, properties: ['openDirectory', 'dontAddToRecent'] };
}

// What the page gets (pure): { ok: true, path } for a local absolute folder the server would take, else
// { ok: false, reason } ('cancelled', 'too-long', 'invalid', 'error')
export function libraryPickReply(r) {
  if (!r || r.canceled || !Array.isArray(r.filePaths) || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
  const p = r.filePaths[0];
  if (typeof p !== 'string' || !path.win32.isAbsolute(p) || /^[\\/]{2}/.test(p) || /[\u0000-\u001f]/.test(p)) return { ok: false, reason: 'invalid' };
  if (p.length > LIBRARY_SOURCE_MAX) return { ok: false, reason: 'too-long' };
  return { ok: true, path: p };
}

// The system folders a project may not be, from the environment (Windows names; values that are not an absolute local
// path are ignored):
//   trees  %SystemRoot% (C:\Windows): neither it nor anything inside it
//   roots  %ProgramFiles%, %ProgramFiles(x86)%, %ProgramData% and the OneDrive roots (%OneDrive%, %OneDriveConsumer%,
//          %OneDriveCommercial%): not the folder itself (a project folder inside OneDrive is fine)
// The server applies the same list with the same reason ('broad'). Returns { trees: [...], roots: [...] }.
// The same lists as the server's (server/catalog.mjs SYSTEM_TREE_VARS, ONEDRIVE_ROOT_VARS): the Windows and program
// folders are refused with everything inside them, a OneDrive root only itself (a project inside OneDrive is fine)
export const SYSTEM_TREE_VARS = Object.freeze(['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']);
export const SYSTEM_ROOT_VARS = Object.freeze(['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']);

export function systemFolderRules(env = {}) {
  // Windows environment names are case-insensitive: look each one up in any case
  const byName = new Map(Object.keys(env || {}).map((k) => [k.toUpperCase(), env[k]]));
  const read = (names) => {
    const out = [];
    for (const name of names) {
      const v = byName.get(name.toUpperCase());
      if (typeof v !== 'string' || !v.trim()) continue;
      const c = checkLocalDir(v);
      if (c.ok && !out.some((o) => samePath(o, c.path))) out.push(c.path);
    }
    return out;
  };
  return { trees: read(SYSTEM_TREE_VARS), roots: read(SYSTEM_ROOT_VARS) };
}

// Can the picked folder be a project, as the shell sees it (the server checks it again with the catalog's own rules:
// server/catalog.mjs checkNewProjectFolder). rules:
//   homeDir      the user's home folder: neither it nor any folder above it
//   broadDirs    Desktop, Documents, Downloads (as Electron names them, possibly moved to OneDrive) and the system roots
//                (systemFolderRules roots: the OneDrive roots): not themselves
//   systemTrees  %SystemRoot%, %ProgramFiles%, %ProgramFiles(x86)%, %ProgramData% (systemFolderRules trees): neither
//                they nor anything inside them ('broad')
//   hubPath      the hub: neither it, nor anything inside it, nor a folder that holds it
//   programDirs  the program's folders: none of them, nothing inside them, nothing that holds them
//   lstat, realpath  injectable for tests
// Every rule is checked on the path as written and on its real form (a junction on the way into the hub is caught).
// A folder that is itself a link (junction or symbolic link) is refused: the project would be somewhere else.
// Returns { ok: true, path } or { ok: false, reason: 'invalid' | 'network' | 'not-local' | 'drive-root' | 'home' |
// 'broad' | 'hub' | 'program' | 'missing' | 'not-folder' | 'link' }.
export function checkProjectFolder(raw, { homeDir = null, broadDirs = [], systemTrees = [], hubPath = null, programDirs = [], lstat = (p) => fs.lstatSync(p), realpath = fs.realpathSync.native } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) return { ok: false, reason: 'invalid' };
  const v = raw.trim();
  // \\server\share, \\wsl$\..., \\wsl.localhost\..., \\?\ and \\.\ device paths: never touched
  if (/^[\\/]{2}/.test(v)) return { ok: false, reason: 'network' };
  if (IS_WINDOWS ? !/^[a-zA-Z]:[\\/]/.test(v) : !path.isAbsolute(v)) return { ok: false, reason: 'not-local' };
  // A ':' after the drive letter (an alternate data stream), reserved characters, control characters
  if (/[<>:"|?*\u0000-\u001f\u007f-\u009f]/.test(IS_WINDOWS ? v.slice(2) : v)) return { ok: false, reason: 'invalid' };
  const written = path.resolve(v);
  const given = (d) => typeof d === 'string' && d.trim();
  const why = (p) => {
    if (samePath(p, path.parse(p).root)) return 'drive-root';
    if (given(homeDir) && (samePath(p, homeDir) || isInside(homeDir, p))) return 'home';
    if (broadDirs.some((b) => given(b) && samePath(p, b))) return 'broad';
    if (systemTrees.some((t) => given(t) && (samePath(p, t) || isInside(p, t)))) return 'broad';
    // Both ways: a project inside the hub, and a project folder that holds the hub
    if (given(hubPath) && pathsOverlap(p, hubPath)) return 'hub';
    if (programDirs.some((d) => given(d) && pathsOverlap(p, d))) return 'program';
    return null;
  };
  const first = why(written);
  if (first) return { ok: false, reason: first };
  let st;
  try {
    st = lstat(written);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'link' };
  if (!st.isDirectory()) return { ok: false, reason: 'not-folder' };
  let real;
  try {
    real = realpath(written);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (/^[\\/]{2}/.test(real)) return { ok: false, reason: 'network' };
  const canonical = (p) => {
    try {
      return realpath(p);
    } catch {
      return p;
    }
  };
  // The real form of every rule's folder too (the hub or the program folder behind a junction)
  const second = why(real) || (() => {
    const realRules = {
      home: given(homeDir) ? canonical(homeDir) : null,
      hub: given(hubPath) ? canonical(hubPath) : null,
      broad: broadDirs.filter(given).map(canonical),
      trees: systemTrees.filter(given).map(canonical),
      program: programDirs.filter(given).map(canonical),
    };
    if (realRules.home && (samePath(real, realRules.home) || isInside(realRules.home, real))) return 'home';
    if (realRules.broad.some((b) => samePath(real, b))) return 'broad';
    if (realRules.trees.some((t) => samePath(real, t) || isInside(real, t))) return 'broad';
    if (realRules.hub && pathsOverlap(real, realRules.hub)) return 'hub';
    if (realRules.program.some((d) => pathsOverlap(real, d))) return 'program';
    return null;
  })();
  if (second) return { ok: false, reason: second };
  return { ok: true, path: written };
}

// The picker as one flow; main.mjs passes in the Electron parts:
//   showOpenDialog(options)  dialog.showOpenDialog with the main window as parent (modal to it)
//   check(folder)            checkProjectFolder with the shell's rules
//   add(folder)              the server call that remembers the folder ('project-add'); resolves its reply
// Nothing reaches the server unless a folder was chosen and passed the check. Returns the server's reply, or
// { ok: false, reason: 'cancelled' | <check's reason> | 'error' }.
export async function pickProjectFolder({ S, showOpenDialog, check, add }) {
  let r;
  try {
    r = await showOpenDialog(projectFolderDialogOptions(S));
  } catch {
    return { ok: false, reason: 'error' };
  }
  const folder = r && !r.canceled && Array.isArray(r.filePaths) ? r.filePaths[0] : null;
  if (typeof folder !== 'string' || !folder) return { ok: false, reason: 'cancelled' };
  const c = check(folder);
  if (!c?.ok) return { ok: false, reason: c?.reason || 'invalid' };
  try {
    return (await add(c.path)) || { ok: false, reason: 'error' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// What the page gets back from pickProjectFolder and saveProjectIdea: { ok, reason, projectId?, existed?, saved? }.
// Never a path, the idea or any other detail. An answer that says ok without a valid project id is an error.
export function projectReply(result) {
  const r = result && typeof result === 'object' ? result : {};
  const ok = r.ok === true && typeof r.projectId === 'string' && PROJECT_ID_RE.test(r.projectId);
  const reason = typeof r.reason === 'string' && /^[a-z-]{1,32}$/.test(r.reason) ? r.reason : null;
  const reply = { ok, reason: ok ? reason || 'saved' : r.ok === true ? 'error' : reason || 'error' };
  if (ok) {
    reply.projectId = r.projectId;
    if (typeof r.existed === 'boolean') reply.existed = r.existed;
    if (r.saved === false) reply.saved = false;
  }
  return reply;
}

// Requests from the shell to its server process over the process's own message channel (utilityProcess:
// postMessage / process.parentPort; the development fallback: child_process ipc). Only the shell can send on it: the
// page reaches it only through the bridge above, and nothing else can reach a child's message channel.
//   call(target, type, fields)  target: the server handle ({ alive, post(msg) }); resolves the server's reply, or
//                               { ok: false, reason: 'no-server' | 'timeout' }
//   receive(target, msg)        a message from a server process; only a reply to a pending call of that very process
//                               settles it (true), anything else is ignored (false)
//   drop(target)                the process is gone: its pending calls settle with 'no-server'
// Messages: { sibersentez: 'shell-call', id, type, ...fields } and back { sibersentez: 'shell-reply', id, ok, ... }.
export const SERVER_CALL_TIMEOUT_MS = 15000;

export function createServerCalls({ timeoutMs = SERVER_CALL_TIMEOUT_MS } = {}) {
  let seq = 0;
  const pending = new Map(); // id -> { target, resolve, timer }
  const settle = (id, value) => {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(value);
    return true;
  };
  function call(target, type, fields = {}) {
    if (!target || target.alive !== true || typeof target.post !== 'function') return Promise.resolve({ ok: false, reason: 'no-server' });
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, { ok: false, reason: 'timeout' }), timeoutMs);
      timer.unref?.();
      pending.set(id, { target, resolve, timer });
      try {
        target.post({ ...fields, sibersentez: 'shell-call', id, type });
      } catch {
        settle(id, { ok: false, reason: 'no-server' });
      }
    });
  }
  function receive(target, msg) {
    if (!msg || typeof msg !== 'object' || msg.sibersentez !== 'shell-reply' || !Number.isInteger(msg.id)) return false;
    const p = pending.get(msg.id);
    if (!p || p.target !== target) return false;
    return settle(msg.id, msg);
  }
  function drop(target) {
    for (const [id, p] of [...pending]) if (p.target === target) settle(id, { ok: false, reason: 'no-server' });
  }
  return { call, receive, drop, pending: () => pending.size };
}

// Run in the window's page by the shell (webContents.executeJavaScript) when "New project…" is chosen in the tray: the
// page starts its own new-project flow (which asks the shell through the bridge, like the header button) and answers
// true. The script carries no data; anything else (an older page, no bridge, an error) answers false.
export const NEW_PROJECT_SCRIPT = "(() => { try { return window.sibersentezNewProject?.start?.() === true; } catch { return false; } })()";

// How long the shell waits for the page to take "New project…" (a window that is only now loading needs a moment)
export const NEW_PROJECT_HANDOVER_MS = 5000;

// "New project…" in the tray as one flow; main.mjs passes in the Electron parts:
//   windowReady  the window shows the server origin right now (not while the server restarts, not an error page)
//   show()       bring the window up             handOver()  run NEW_PROJECT_SCRIPT in the page; resolves true if taken
//   notify()     a short tray balloon: SiberSentez is getting ready, try again in a few seconds (S.newProjectNotReady*)
// Never silent: a window that cannot take the request yet gets the balloon instead (and is not brought up), a page
// that does not take it within the time limit is logged. Returns 'handed-over' | 'not-taken' | 'not-ready'.
export async function newProjectFromTray({ windowReady = false, show, handOver, notify, log = () => {} }) {
  if (windowReady !== true) {
    log('new project: the window is not ready (server starting or an error page); the tray says so');
    notify();
    return 'not-ready';
  }
  show();
  let took = false;
  try {
    took = (await handOver()) === true;
  } catch {
    took = false;
  }
  if (!took) log('new project: the page did not take the request');
  return took ? 'handed-over' : 'not-taken';
}

// ---------------------------------------------------------------- the shell's own state (its data folder)

// <data folder>\shell.json: { trayHintShown, actionsModeSeen: { hub, mode } }. Not the hub: the user's data stays
// apart from the shell's bookkeeping.
export const SHELL_STATE_FILE = 'shell.json';

// The file as an object; a missing, unreadable or invalid file is {}
export function readShellState(file, fsImpl = fs) {
  try {
    const v = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Sets the keys of patch and keeps every other key. Returns true when saved. Atomic like writeHubActionsSetting: the
// full new text goes to a new temporary file next to shell.json ('wx', never an existing file), which then replaces
// shell.json in a single rename; shell.json itself is never opened for writing, so a crash or a full disk leaves either
// the old or the new text, never a cut one (a cut file would read as {} and bring back the actions warning and the
// tray hint). fsImpl and suffix are injectable for tests.
export function updateShellState(file, patch, { fsImpl = fs, suffix = tempSuffix } = {}) {
  const text = JSON.stringify({ ...readShellState(file, fsImpl), ...patch }) + '\n';
  const tmp = path.join(path.dirname(file), `${path.basename(file)}.${suffix()}.tmp`);
  try {
    fsImpl.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' });
    fsImpl.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fsImpl.rmSync(tmp, { force: true });
    } catch {
      /* a leftover temporary file is harmless; shell.json is untouched */
    }
    return false;
  }
}

// Actions are on, but this shell neither switched them on for this hub nor warned about it yet: settings.json was
// changed outside SiberSentez (by hand or by another program). seen is shell.json's actionsModeSeen, the last mode the
// shell wrote or warned about. The shell warns once and then records the mode as seen.
export function unexpectedLiveMode({ mode, seen, hubPath }) {
  if (normalizeActionsMode(mode) !== 'live') return false;
  const known = seen && seen.mode === 'live' && typeof seen.hub === 'string' && typeof hubPath === 'string' && samePath(seen.hub, hubPath);
  return !known;
}

// What the shell does about the actions mode each time a server becomes ready (the first start, a crash restart, a
// requested restart). The server has just read settings.json, which may have changed while the previous one ran, so:
//   1. refreshTray()  the tray is rebuilt from the stored mode, so its radio items show what the server now uses;
//   2. actions found On that this shell did not switch on (unexpectedLiveMode) are reported: remember(mode) records
//      them in shell.json first, then warn() shows the warning. There is no once-per-run limit: that record is what
//      keeps the same change from being reported again, across restarts and app runs alike.
// QA mode only logs (no dialog, nothing recorded). read() returns the stored mode, seen() shell.json's actionsModeSeen.
// Returns 'warned' | 'logged' | 'none'.
export function checkActionsOnReady({ hubPath, qa = false, read, seen, remember, warn, refreshTray, log = () => {} }) {
  refreshTray();
  const mode = read();
  if (!unexpectedLiveMode({ mode, seen: seen(), hubPath })) return 'none';
  log('actions are on, but not switched on from this tray: settings.json was changed outside SiberSentez');
  if (qa) return 'logged';
  remember(mode);
  warn(mode);
  return 'warned';
}

// ---------------------------------------------------------------- stopping a server process on purpose

// Resolves true when handle.exited settles within ms, false otherwise
function exitedWithin(handle, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    Promise.resolve(handle.exited).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// Stops a server process the shell no longer wants (a requested restart): kill(), wait up to waitMs for its exit,
// then forceKill() and wait again. Resolves 'exited' | 'forced' | 'stuck'; a stuck process stays the caller's to
// stop when the app quits. handle: { alive, exited: Promise, kill(), forceKill() }.
export async function stopServerProcess(handle, { waitMs = 5000 } = {}) {
  if (!handle?.alive) return 'exited';
  try {
    handle.kill();
  } catch {
    /* the force kill below still runs */
  }
  if (await exitedWithin(handle, waitMs)) return 'exited';
  try {
    handle.forceKill();
  } catch {
    /* reported as stuck below */
  }
  return (await exitedWithin(handle, waitMs)) ? 'forced' : 'stuck';
}

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

// The main window's options. A hidden QA run: never shown (show: false), no taskbar button, placed off screen; it still
// paints while hidden (paintWhenInitiallyHidden) and is not throttled in the background, so the page runs its timers
// and capturePage works.
export function windowOptions({ qaHidden = false, preload, icon, devTools = false } = {}) {
  const options = {
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'SiberSentez',
    icon,
    backgroundColor: '#0c0e14',
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
export function guardDialogs(dialog, { hidden = false, log = () => {} } = {}) {
  if (hidden !== true) {
    return {
      showMessageBox: (...args) => dialog.showMessageBox(...args),
      showOpenDialog: (...args) => dialog.showOpenDialog(...args),
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
    showErrorBox: () => {
      log('QA hidden: native error box skipped');
    },
  };
}

// The QA probes' scripts, run in the page with webContents.executeJavaScript. Fixed text, no data from anywhere.
//   BRIDGE   which functions window.sibersentezShell has: "name:type" sorted and joined by ',' ('missing' without it)
//   KIT      skills and agents of the SiberSentez kit in the roster of /api/snapshot: '{"skill":n,"agent":n}'
//   PANEL    whether the actions panel under the header indicator is open: 'open' | 'closed' | 'missing'
//   ACTIONS  setActionsMode(mode) through the bridge, the page's own path; resolves the shell's reply as JSON
export const QA_BRIDGE_PROBE_SCRIPT =
  "(() => { const s = window.sibersentezShell; if (!s) return 'missing'; return Object.keys(s).sort().map((k) => k + ':' + typeof s[k]).join(','); })()";
export const QA_KIT_PROBE_SCRIPT =
  "fetch('/api/snapshot').then((r) => r.json()).then((s) => { const kit = (s.roster || []).filter((i) => (i.sources || []).includes('kit')); return JSON.stringify({ skill: kit.filter((i) => i.kind === 'skill').length, agent: kit.filter((i) => i.kind === 'agent').length }); }, () => 'error')";
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

// ---------------------------------------------------------------- language

// UI language of the shell: the hub's settings.json "language" wins unless it is "auto" (or missing/unsupported);
// otherwise the OS locale decides: tr* → Turkish, anything else → English.
export function pickLanguage({ setting, locale } = {}) {
  const s = typeof setting === 'string' ? setting.trim().toLowerCase().split(/[-_]/)[0] : '';
  if (s && s !== 'auto' && SUPPORTED_LANGUAGES.includes(s)) return s;
  const l = typeof locale === 'string' ? locale.trim().toLowerCase().split(/[-_]/)[0] : '';
  return l === 'tr' ? 'tr' : 'en';
}

// The hub's language when settings.json names a supported one ('en' | 'tr'), else null ("auto", missing, other)
export function explicitLanguage(setting) {
  const s = typeof setting === 'string' ? setting.trim().toLowerCase().split(/[-_]/)[0] : '';
  return SUPPORTED_LANGUAGES.includes(s) ? s : null;
}

// Address the window loads. A language the hub names explicitly goes to the page as ?lang= (the page cannot read
// settings.json); without one the page follows navigator.language (docs/actions-toggle.md §3.6).
export function windowUrl(origin, lang = null) {
  return SUPPORTED_LANGUAGES.includes(lang) ? `${origin}/?lang=${lang}` : `${origin}/`;
}

// Reads "language" from <hub>\settings.json; any problem (missing, unreadable, invalid JSON) means null
export function readHubLanguageSetting(hubPath) {
  if (typeof hubPath !== 'string' || !hubPath) return null;
  try {
    let raw = fs.readFileSync(path.join(hubPath, HUB_SETTINGS_FILE), 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // tolerate a byte order mark
    const value = JSON.parse(raw)?.language;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- logging

// Replaces the user's home folder with '~' in log lines (no personal paths in logs).
// Case-insensitive (Windows); backslash, forward slash and JSON-escaped (C:\\Users\\name) forms are all caught.
export function redactHome(text, homeDir) {
  const s = String(text);
  if (typeof homeDir !== 'string' || homeDir.length < 3) return s;
  const variants = new Set([JSON.stringify(homeDir).slice(1, -1), homeDir, homeDir.replace(/\\/g, '/'), homeDir.replace(/\//g, '\\')]);
  let out = s;
  for (const v of variants) {
    const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, '~');
  }
  return out;
}

// URL as written to the log: scheme and host only (paths and query strings may carry personal data)
export function describeUrl(raw) {
  const u = parseUrl(raw);
  if (!u) return '(invalid url)';
  return u.host ? `${u.protocol}//${u.host}` : u.protocol;
}
