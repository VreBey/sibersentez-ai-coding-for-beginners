// @ts-check
// Shared helpers: JSON reading, path normalisation, secret masking, incremental line reading.
import fs from 'node:fs';
import { open } from 'node:fs/promises';

// A project's id in the registry: a letter or digit, then letters, digits, dots, underscores and dashes, at most 100
// characters. One rule for the server, its routes and the desktop shell (plan D9; it was written out thirteen times)
export const PROJECT_ID_SRC = '[A-Za-z0-9][A-Za-z0-9._-]{0,99}';
export const PROJECT_ID_RE = new RegExp(`^${PROJECT_ID_SRC}$`);

export function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// For comparison: lower case, forward slashes instead of backslashes, no trailing slash
export function normPath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Claude Code's naming of folders under ~/.claude/projects: every non-letter/digit character becomes '-'
export function slugify(p) {
  return String(p || '').replace(/[^A-Za-z0-9]/g, '-');
}

export function truncate(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Mask common key formats in text that goes on screen
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // 11-digit Turkish national ID number (T.C. kimlik)
  /\b[1-9]\d{10}\b/g,
];
// Letters and digits mixed, one 24+ character piece: most keys/tokens (UUID parts stay short).
// A name split by underscores whose every part is short (project_s01_netcode_evidence) is an identifier.
const LONG_MIXED = /\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{24,}\b/g;
const isIdentifier = (w) => w.includes('_') && w.split('_').every((part) => part.length < 12);
// "name = value" / "name: value" / "name": "value": the value of a field whose name suggests a secret is masked, the name stays.
// A separator is required (: or =); so plain sentences like "Token limit" are not broken. Words like "compass=",
// "bypass:" must not be taken for passw(or)d. A quoted value is masked whole even if it contains spaces.
const SECRET_ASSIGN = /\b([A-Za-z_]*(?:api[_-]?key|token|secret|passw(?:or)?d|pwd|credential)[A-Za-z_]*)(['"]?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s'",;]+)/gi;
// "Bearer xyz", "Authorization: Basic xyz": an authorisation value separated by a space
const BEARER = /\b(bearer|authorization:?(?:\s+(?:bearer|basic|digest|token))?)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
// https://user:password@host -> the password is masked
const URL_CRED = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
// All callers cut the result to a few hundred characters at most; very long text (a pasted
// log) is cut first so that it does not needlessly tax the regular expressions.
const REDACT_MAX = 4000;
export function redact(s) {
  if (!s) return s;
  let out = String(s)
    .slice(0, REDACT_MAX)
    .replace(SECRET_ASSIGN, (_m, name, sep) => `${name}${sep}•••`)
    .replace(BEARER, (_m, name, sep) => `${name}${sep}•••`)
    .replace(URL_CRED, '$1•••@');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '•••');
  return out.replace(LONG_MIXED, (w) => (isIdentifier(w) ? w : '•••'));
}

export function toMs(ts) {
  if (!ts) return 0;
  const n = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(n) ? n : 0;
}

const NL = 10;

// Reads the file from byte `start` to the end, calls onLine(buf, a, b) for every complete line.
// An incomplete last line is not processed; the return value is the byte where the next read starts.
export async function readLinesFrom(file, start, onLine) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    // Claude Code logs only append. If the file got shorter it was rewritten: reading from the start
    // would count the counters twice, so it jumps to the end and only what is appended later is read.
    if (size < start) return size;
    if (size === start) return start;
    const chunkSize = 4 << 20;
    const buf = Buffer.allocUnsafe(chunkSize);
    let pos = start;
    let carry = null;
    let consumed = start;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(chunkSize, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let a = 0;
      let nl = data.indexOf(NL, a);
      while (nl !== -1) {
        if (nl > a) onLine(data, a, nl);
        a = nl + 1;
        nl = data.indexOf(NL, a);
      }
      carry = a < data.length ? Buffer.from(data.subarray(a)) : null;
      consumed = pos - (carry ? carry.length : 0);
    }
    return consumed;
  } finally {
    await fh.close();
  }
}

// Reads name and description (single line or block) from YAML frontmatter
export function readFrontmatter(file) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(6000);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    fs.closeSync(fd);
    text = b.toString('utf8', 0, n);
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return {};
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '---') break;
    const m = /^(name|description|model|tools):\s*(.*)$/.exec(l);
    if (!m) continue;
    let v = m[2].trim();
    if (v === '' || /^[|>][-+]?$/.test(v)) {
      const parts = [];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) parts.push(lines[j].trim());
      v = parts.join(' ');
    }
    out[m[1]] = v.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
  }
  return out;
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
