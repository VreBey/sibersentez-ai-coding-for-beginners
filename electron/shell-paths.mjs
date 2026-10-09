// @ts-check
// The shell's ports, folders and hub path (plan D8: from helpers.mjs, which re-exports it). Pure, no Electron.
import fs from 'node:fs';
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
export const MAX_URL_LENGTH = 4096;
export const IS_WINDOWS = process.platform === 'win32';

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
/** @param {any} raw @param {{ homeDir?: string | null }} [options] */
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
