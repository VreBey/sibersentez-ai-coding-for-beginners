// @ts-check
// Pure helpers for the SiberSentez desktop shell. They never import Electron: the main process (main.mjs) only
// wires them to Electron events, and test/electron.test.mjs exercises their behaviour with plain Node.
// Covered: free port lookup, folder validation, hub path, navigation/request/permission policy (with the retired
// shell path), server environment, readiness probe, the restart supervisor and stopping a server on purpose, the
// actions-mode switch, its menus, the in-app panel's IPC request and the confirmation for On (docs/actions-toggle.md),
// the new-project bridge (folder picker, folder rules, the idea, calls to the server process; docs/start-flow.md),
// the shell's own state file, QA options, UI language and log redaction.
// Since plan D8 the sections live in their own modules, each re-exported here: main.mjs and the tests import from
// this file as before. Here: the UI language and log redaction.
export * from './shell-paths.mjs';
export * from './shell-policy.mjs';
export * from './server-process.mjs';
export * from './actions-mode.mjs';
export * from './new-project.mjs';
export * from './shell-state.mjs';
export * from './qa-window.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { HUB_SETTINGS_FILE, SUPPORTED_LANGUAGES } from './shell-paths.mjs';
import { parseUrl } from './shell-policy.mjs';

// ---------------------------------------------------------------- language

// UI language of the shell: the hub's settings.json "language" wins unless it is "auto" (or missing/unsupported);
// otherwise the OS locale decides: tr* → Turkish, anything else → English.
/** @param {{ setting?: string | null, locale?: string | null }} [options] */
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
