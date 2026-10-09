// @ts-check
// What the window may open, request and be granted (plan D8: from helpers.mjs, which re-exports it). Pure, no Electron.
import { ALLOWED_PERMISSIONS, HOST, MAX_URL_LENGTH } from './shell-paths.mjs';

// ---------------------------------------------------------------- navigation, requests, permissions

// The only origin the window may show
export function appOrigin(port) {
  return `http://${HOST}:${port}`;
}

export function parseUrl(raw) {
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
/** @param {{ url?: string, origin?: string | null }} [options] */
export function shellNavigation({ url, origin } = {}) {
  if (!isShellActionsModeUrl(url, origin)) return null;
  return { cancel: true, openExternal: false };
}

// Network filter: the page may only reach its own origin (ws/wss are checked like http/https)
export function requestAllowed(raw, origin) {
  if (typeof raw !== 'string') return false;
  return isAppUrl(raw.replace(/^ws(s?):/i, 'http$1:'), origin);
}

// The session key on the way out (review A1, server/app.mjs sessionKeyAllowed): every request the window sends to its
// own server carries it; a request anywhere else never does. Returns the headers to send (a new object).
export const SESSION_KEY_HEADER = 'X-SiberSentez-Key';
export function withSessionKey(raw, origin, headers, key) {
  const out = { ...(headers || {}) };
  for (const k of Object.keys(out)) if (k.toLowerCase() === SESSION_KEY_HEADER.toLowerCase()) delete out[k];
  if (typeof key === 'string' && key && requestAllowed(raw, origin)) out[SESSION_KEY_HEADER] = key;
  return out;
}

// Permission rule: everything is denied except ALLOWED_PERMISSIONS requested by our own origin. A hidden QA run
// (readQaShellOptions) denies notifications too: a desktop notification would reach the screen of the person at
// this computer, and no window of that run is ever shown.
export function permissionAllowed(permission, requestingUrl, origin, { qaHidden = false } = {}) {
  if (qaHidden === true && permission === 'notifications') return false;
  return ALLOWED_PERMISSIONS.includes(permission) && isAppUrl(requestingUrl, origin);
}
