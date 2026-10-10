// @ts-check
// The support bundle (docs/internal/support-bundle-plan.md): the parts only the shell can read for Settings → Help →
// Support bundle. They are the hub's settings.json, masked, and the last lines of main.log and server.log, masked. The
// page shows them before anything leaves the computer; nothing is sent anywhere. Pure apart from reading those files;
// no Electron (tests run it with plain Node).
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../server/util.mjs';
import { redactHome } from './helpers.mjs';
import { bridgeSender } from './actions-mode.mjs';

// Two more channels of the bridge (electron/preload.cjs keeps its own copy of the names and the limit)
export const SUPPORT_PARTS_IPC_CHANNEL = 'sibersentez:support-parts';
export const SUPPORT_SAVE_IPC_CHANNEL = 'sibersentez:support-save';
export const SUPPORT_TEXT_MAX = 256 * 1024;
export const SUPPORT_LOGS = ['main', 'server'];
export const SUPPORT_LOG_LINES = 300;
export const SUPPORT_LOG_BYTES = 64 * 1024;
const LINE_MAX = 500;

// The default hub stays: it tells whether the hub is the usual one, and it names no person or project. Only the folder
// itself: at the end of the line, before the logs' " · " separator, or before a closing quote or bracket that ends a word
const KEPT_HUB = /~([\\/])SiberSentez[\\/]?(?=$|\s+$|\s·|["')\]](?=\s|$|[)\]]))/gi;
const HUB_MARK = '\u0001hub$1\u0001';
// Where a folder path starts, after the home folder became '~': a drive (C:\ or C:/), a network path (\\host\share),
// the home folder, or an absolute path under the usual Unix roots (/run/media holds Linux's removable drives). A URL's
// path is not one (the character before is ':' or '/'), except a file:// address, which is a path.
const PATH_START = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|~[\\/]|(?:(?<![\w:/.~-])|(?<=file:\/\/))\/(?:home|Users|root|run|data|private|mnt|media|tmp|var|opt|srv|Volumes)\/)/g;
// An e-mail address can name a person: masked as well. Its last label is letters, so a package@version stays
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g;

// Folder names hold spaces, brackets, apostrophes ("New folder (2)", "Ann's Homework", "[Acme]"), so a path is never
// cut by a guess at where its name ends. A quoted path (Node's error messages quote them) runs on to its closing quote,
// one followed by a space, a bracket, a comma, a colon or the end of the line; any other runs on to the end of the line,
// or to the logs' own " · " separator. What follows a path on its line may go with it; no part of the path stays.
function maskPaths(s) {
  let out = '';
  let from = 0;
  PATH_START.lastIndex = 0;
  for (let m = PATH_START.exec(s); m; m = PATH_START.exec(s)) {
    const start = m.index;
    const q = start > 0 && (s[start - 1] === "'" || s[start - 1] === '"') ? s[start - 1] : null;
    let end = s.length;
    if (q) {
      const close = new RegExp(`${q}(?=[\\s),:;\\]]|$)`, 'g');
      close.lastIndex = start;
      const c = close.exec(s);
      if (c) end = c.index;
    } else {
      const sep = s.indexOf(' · ', start);
      if (sep >= 0) end = sep;
    }
    out += `${s.slice(from, start)}<path>`;
    from = end;
    PATH_START.lastIndex = end;
  }
  return out + s.slice(from);
}

// One log line as the bundle shows it: secrets masked, the home folder '~', every other folder path '<path>', e-mail
// addresses '<email>', cut short
export function maskLine(line, homeDir) {
  let s = String(line ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ');
  if (s.length > LINE_MAX) s = `${s.slice(0, LINE_MAX)} …(cut)`;
  s = redactHome(redact(s), homeDir).replace(EMAIL_RE, '<email>');
  s = maskPaths(s.replace(KEPT_HUB, HUB_MARK));
  return s.replace(/\u0001hub([\\/])\u0001/g, '~$1SiberSentez');
}

// The last lines of a file: at most maxBytes read from its end, a first line cut by that start dropped. Returns
// { lines, cut } (cut: older lines were left out) or null when the file is not there.
export function tailLines(file, { maxLines = SUPPORT_LOG_LINES, maxBytes = SUPPORT_LOG_BYTES } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
      if (!n) break;
      read += n;
    }
    let lines = buf.subarray(0, read).toString('utf8').split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    let cut = false;
    if (start > 0) {
      lines.shift();
      cut = true;
    }
    if (lines.length > maxLines) {
      lines = lines.slice(-maxLines);
      cut = true;
    }
    return { lines, cut };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The hub's settings.json as the bundle shows it: a known key keeps a short plain value, any other key is listed
// without its value. Returns text (English, like the logs).
const KNOWN_SETTINGS = ['version', 'language', 'actions', 'theme'];
const PLAIN_VALUE = /^[\w.-]{1,20}$/;
const PLAIN_KEY = /^[A-Za-z][\w-]{0,40}$/;
export function maskSettings(hubDir) {
  if (!hubDir) return '(no hub folder)';
  let raw;
  try {
    raw = fs.readFileSync(path.join(hubDir, 'settings.json'), 'utf8');
  } catch {
    return '(settings.json is not there)';
  }
  let obj;
  try {
    obj = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return '(settings.json is not valid JSON)';
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '(settings.json is not an object)';
  const out = [];
  let odd = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (!PLAIN_KEY.test(k)) {
      odd++;
      continue;
    }
    const plain = (typeof v === 'string' && PLAIN_VALUE.test(v)) || typeof v === 'boolean' || Number.isFinite(v);
    out.push(KNOWN_SETTINGS.includes(k) && plain ? `${k}: ${v}` : `${k}: (set, value hidden)`);
  }
  if (odd) out.push(`(${odd} other key${odd === 1 ? '' : 's'}, names hidden)`);
  return out.length ? out.join('\n') : '(empty)';
}

// What supportParts() answers: { ok, settings, logs: [{ name, lines, cut, missing }] }. No path from the page is used.
export function supportParts({ logDir, hubDir, homeDir }) {
  const logs = SUPPORT_LOGS.map((name) => {
    const t = logDir ? tailLines(path.join(logDir, `${name}.log`)) : null;
    if (!t) return { name: `${name}.log`, lines: [], cut: false, missing: true };
    return { name: `${name}.log`, lines: t.lines.map((l) => maskLine(l, homeDir)), cut: t.cut, missing: false };
  });
  return { ok: true, settings: maskSettings(hubDir), logs };
}

// A save request from the page: the main window's top frame on the app origin, text of 1..SUPPORT_TEXT_MAX characters.
// Returns { ok, text } or { ok: false, reason }.
export function supportSaveRequest({ text = undefined, mainWindow = false, frame = null, origin = null } = {}) {
  const sender = bridgeSender({ mainWindow, frame, origin });
  if (!sender.ok) return sender;
  if (typeof text !== 'string' || !text.length || text.length > SUPPORT_TEXT_MAX) return { ok: false, reason: 'invalid' };
  return { ok: true, text };
}

// The file name the Save dialog offers: SiberSentez-support-YYYY-MM-DD.txt (the local date)
export function supportFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `SiberSentez-support-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.txt`;
}
