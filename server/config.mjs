// App settings (contract §3). Precedence: environment variable -> <app>\sibersentez.json -> default.
//   SIBERSENTEZ_PORT    | port    | 4545
//   SIBERSENTEZ_DAYS    | days    | 14 (how many days of logs are scanned)
//   SIBERSENTEZ_HUB     | hub     | %USERPROFILE%\SiberSentez only if it exists, else null (registry and library empty)
//   SIBERSENTEZ_ACTIONS | actions | then <hub>\settings.json "actions", then off (docs/actions-toggle.md §3.2;
//                    |         | environment: dry|1, files: off|dry|live; see actions.mjs)
//   SIBERSENTEZ_INSTANCE | -      | none: when set, every response carries X-SiberSentez-Instance (the desktop shell checks it)
//   SIBERSENTEZ_KIT     | -       | the SiberSentez kit folder (KIT_DIR below; tests name another one)
// Resolving settings never creates the hub folder (hub.mjs builds the skeleton, called by the desktop shell) and
// never writes settings.json: in the installed app only the shell's tray menu changes the actions mode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActionMode } from './actions.mjs';
import { readActionsSetting } from './hub.mjs';
import { resolveKitDir } from './kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const APP_DIR = path.resolve(here, '..');
export const CONFIG_FILE = 'sibersentez.json';
// The product's old name (renamed 2026-09-30): its config file and its environment variables are still read
export const LEGACY_CONFIG_FILE = 'orkestra.json';
const LEGACY_ENV_PREFIX = 'ORKESTRA_';

// Every ORKESTRA_* variable the new name does not set becomes SIBERSENTEZ_* (in place; the process, its server and its
// tests read the new names only). Returns how many were taken over.
export function adoptLegacyEnv(env) {
  let n = 0;
  for (const k of Object.keys(env || {})) {
    if (!k.toUpperCase().startsWith(LEGACY_ENV_PREFIX)) continue;
    const next = 'SIBERSENTEZ_' + k.slice(LEGACY_ENV_PREFIX.length);
    if (env[next] === undefined) {
      env[next] = env[k];
      n++;
    }
  }
  return n;
}

// The config file of the app folder: the new name, else the old one
function configPath(appDir) {
  const next = path.join(appDir, CONFIG_FILE);
  if (fs.existsSync(next)) return next;
  const legacy = path.join(appDir, LEGACY_CONFIG_FILE);
  return fs.existsSync(legacy) ? legacy : next;
}
export const DEFAULT_PORT = 4545;
export const DEFAULT_DAYS = 14;
export const DEFAULT_HUB_NAME = 'SiberSentez';

function isDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const INSTANCE_RE = /^[A-Za-z0-9._-]{1,128}$/;
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// Only numbers and numeric strings count (true or [] must not turn into 1 or 0 through Number())
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v.trim());
  return NaN;
}
const toPort = (v) => {
  const n = toNumber(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
};
const toDays = (v) => {
  const n = toNumber(v);
  return Number.isFinite(n) && n > 0 && n <= 3650 ? n : null;
};

// sibersentez.json: missing -> empty settings, silently. Present but unreadable or not a JSON object -> empty
// settings plus one log line; the server never crashes on it. The line carries no path (paths hold the user name).
function readConfigFile(file, log) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') log(`${CONFIG_FILE} unreadable (${e?.code || 'error'}); using defaults`);
    return {};
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
  } catch {
    /* one line below */
  }
  log(`${CONFIG_FILE} is invalid (not a JSON object); using defaults`);
  return {};
}

// Pure settings resolution from the given environment, app folder and home folder (tests stay off the real machine).
// Returns { appDir, homeDir, claudeDir, port, days, hub, hubSource, actions }.
//   hub: absolute path of an existing hub folder, or null. An explicit path (environment or file) that does not
//   exist also yields null; there is no fallback to the default (a misconfiguration must not be hidden), one log line.
export function resolveConfig({ env = {}, appDir = APP_DIR, homeDir = os.homedir(), log = () => {} } = {}) {
  const file = readConfigFile(configPath(appDir), log);

  const pick = (envKey, fileKey, parse, fallback) => {
    if (!blank(env[envKey])) {
      const v = parse(env[envKey]);
      if (v !== null) return v;
      log(`${envKey} is invalid; trying the next source`);
    }
    if (!blank(file[fileKey])) {
      const v = parse(file[fileKey]);
      if (v !== null) return v;
      log(`${CONFIG_FILE}: ${fileKey} is invalid; using the default`);
    }
    return fallback;
  };
  const port = pick('SIBERSENTEZ_PORT', 'port', toPort, DEFAULT_PORT);
  const days = pick('SIBERSENTEZ_DAYS', 'days', toDays, DEFAULT_DAYS);

  let hubSource;
  let hubPath;
  if (!blank(env.SIBERSENTEZ_HUB)) {
    hubSource = 'env';
    hubPath = path.resolve(String(env.SIBERSENTEZ_HUB).trim());
  } else if (typeof file.hub === 'string' && file.hub.trim()) {
    hubSource = 'file';
    hubPath = path.resolve(appDir, file.hub.trim());
  } else {
    hubSource = 'default';
    hubPath = path.join(homeDir, DEFAULT_HUB_NAME);
  }
  const hub = isDir(hubPath) ? hubPath : null;
  if (!hub && hubSource !== 'default') log(`hub folder not found (${hubSource === 'env' ? 'SIBERSENTEZ_HUB' : `${CONFIG_FILE}: hub`}); registry and library treated as empty`);

  // Instance tag (environment only): a header-safe token, anything else is ignored with one log line
  let instance = null;
  if (!blank(env.SIBERSENTEZ_INSTANCE)) {
    const v = String(env.SIBERSENTEZ_INSTANCE).trim();
    if (INSTANCE_RE.test(v)) instance = v;
    else log('SIBERSENTEZ_INSTANCE is invalid (allowed: letters, digits, . _ -, at most 128); no instance header');
  }

  const actions = actionModeFrom({ env, file, hub, log });

  return { appDir, homeDir, claudeDir: path.join(homeDir, '.claude'), port, days, hub, hubSource: hub ? hubSource : null, actions, instance };
}

// Actions: the first source that holds a value decides, and an unknown value there means off (it never falls through
// to a lower source that might switch actions on): environment (dry|1) > sibersentez.json (off|dry|live) >
// <hub>\settings.json (off|dry|live, written by the desktop shell) > off. Without a hub folder: off.
function actionModeFrom({ env, file, hub, log }) {
  if (!blank(env.SIBERSENTEZ_ACTIONS)) return readActionMode(env);
  if (!blank(file.actions)) {
    const v = typeof file.actions === 'string' ? file.actions.trim().toLowerCase() : '';
    return v === 'dry' || v === 'live' ? v : 'off';
  }
  const s = readActionsSetting(hub);
  if (s.problem) log(`${s.problem}; actions off`);
  return s.mode;
}

// The actions mode as the same sources say it now (docs/actions-toggle.md §3.5): the desktop shell asks the running
// server to read it again after it saved a new mode, instead of restarting it. The hub folder stays the one the server
// started with.
export function resolveActionModeNow({ env = {}, appDir = APP_DIR, hub = null, log = () => {} } = {}) {
  return actionModeFrom({ env, file: readConfigFile(configPath(appDir), log), hub, log });
}

adoptLegacyEnv(process.env);
export const CONFIG = resolveConfig({ env: process.env, appDir: APP_DIR, homeDir: os.homedir(), log: (line) => console.warn(line) });

export const PUBLIC_DIR = path.join(APP_DIR, 'public');
export const HUB_DIR = CONFIG.hub;
// The SiberSentez kit (docs/kit.md, server/kit.mjs), read-only: SIBERSENTEZ_KIT; else, when the app folder is inside an
// archive (the installed app: <resources>\app.asar), the kit folder next to the archive (<resources>\kit, shipped by
// build.extraResources); else <app>\kit. null when that folder does not exist (no kit, nothing breaks).
export const KIT_DIR = resolveKitDir({ env: process.env, appDir: APP_DIR });
export const ACTIONS = CONFIG.actions;
export const INSTANCE = CONFIG.instance;
export const HOME_DIR = CONFIG.homeDir;
export const CLAUDE_DIR = CONFIG.claudeDir;
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

export const HOST = '127.0.0.1';
export const PORT = CONFIG.port;
export const WINDOW_DAYS = CONFIG.days;

// Limits on the number of events kept in memory
export const MAX_EVENTS = 4000;
export const MAX_TICKS = 20000;
export const SNAPSHOT_TICKS = 8000;

// Agent state: counted as "quiet" after this long since the last write
export const AGENT_STALE_MS = 10 * 60 * 1000;
