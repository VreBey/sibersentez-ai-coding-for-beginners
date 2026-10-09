// @ts-check
// "Get ready to publish" (plan E1): before a project goes online, what in it should not. Read-only, no account, no
// network: the project's files are read, nothing is changed, nothing is sent anywhere. The page shows what was found
// and then writes the steps for the AI (GitHub Pages) into the job box; the person presses Start.
//
// What is looked for, and how sure it is:
//   key          danger   an API key or a private key block (the same shapes as the skill review, review.mjs)
//   env-file     danger   a .env file (its variables are usually secrets); .env.example and the like are fine
//   key-file     danger   a private key file (.pem, .key, .p12, .pfx, id_rsa, id_ed25519; a .pub is fine)
//   password     warn     a password, token or secret written into the code as a value ("password": "…")
//   tc-id        warn     a Turkish identity number (eleven digits whose check digits hold)
//   phone        info     a Turkish mobile number
//   email        info     an e-mail address (often meant to be public: a contact address)
// A finding names the file, the line and a masked sample (never the value itself). At most PUBLISH_LIMITS.findings;
// the walk stops at the file and size limits and says so.
import fs from 'node:fs';
import path from 'node:path';
import { SECRET_RE } from './review.mjs';
import { isLocalPath } from './fsutil.mjs';
import { hasStreamColon } from './library.mjs';
import { normPath } from './util.mjs';

export const PUBLISH_LIMITS = Object.freeze({ files: 4000, fileBytes: 1024 * 1024, findings: 40, depth: 12 });
export const PUBLISH_KINDS = Object.freeze(['key', 'env-file', 'key-file', 'password', 'tc-id', 'phone', 'email']);
export const PUBLISH_LEVEL = Object.freeze({ key: 'danger', 'env-file': 'danger', 'key-file': 'danger', password: 'warn', 'tc-id': 'warn', phone: 'info', email: 'info' });
// Never published with a site (version control, packages) or SiberSentez's own notes
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.sibersentez']);
const ENV_FILE_RE = /^\.env(?:\..+)?$/i;
const ENV_SAMPLE_RE = /^\.env\.(?:example|sample|template|dist|defaults)$/i;
const KEY_FILE_RE = /\.(?:pem|key|p12|pfx)$|^id_(?:rsa|dsa|ecdsa|ed25519)$/i;
const PASSWORD_RE = /\b(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i;
// A placeholder is the whole value (review E1: "Password2024!" or a token starting with x was taken for one); a
// template or an environment read anywhere in it is never a written secret
const PLACEHOLDER_RE = /^(?:x+|\*+|\.+|changeme\d*|change[_-]?me\d*|example|placeholder|dummy|todo|secret|password|your[_-]?[a-z_-]*(?:here|key|token|secret|password))$/i;
const TEMPLATE_RE = /\$\{|\{\{|<[^>]*>|process\.env|import\.meta\.env/i;
// Digits only, never inside a word, a hash or a code (a letter on either side ends it)
const TC_RE = /(?<![0-9A-Za-z_])[1-9][0-9]{10}(?![0-9A-Za-z_])/g;
const PHONE_RE = /(?<![0-9])(?:\+90|0)\s?5[0-9]{2}\s?[0-9]{3}\s?[0-9]{2}\s?[0-9]{2}(?![0-9])/;
// Bounded and anchored at its start (review E1: an unbounded one backtracked for seconds on a long line)
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/;
const EMAIL_FINE_RE = /@(?:example\.(?:com|org|net)|users\.noreply\.github\.com|localhost)$|^(?:no-?reply|donotreply)@|@\d+x\.(?:png|jpe?g|gif|webp|svg|avif)$/i;
// A minified line (a bundle, a one-line JSON): only the keys' shapes are looked for, in pieces of this size
const LONG_LINE = 4000;
const PIECE = 4000;

// A Turkish identity number's own check: the tenth and eleventh digits follow from the first nine
export function validTcId(s) {
  if (!/^[1-9][0-9]{10}$/.test(s)) return false;
  const d = [...s].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8];
  const even = d[1] + d[3] + d[5] + d[7];
  if ((((odd * 7 - even) % 10) + 10) % 10 !== d[9]) return false;
  return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}

// A masked sample: its first characters and its length, never the value
export const mask = (v) => {
  const s = String(v);
  return s.length <= 4 ? '••••' : `${s.slice(0, Math.min(4, Math.floor(s.length / 4)))}… (${s.length})`;
};

// The findings of one file's text (pure). rel: the path shown
export function scanText(rel, text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    const n = i + 1;
    // What a build puts online is often one long line (Vite writes VITE_* keys into the bundle): its keys are looked
    // for in overlapping pieces, the other shapes only in source-like lines (review E1)
    if (line.length > LONG_LINE) {
      for (let at = 0; at < line.length; at += PIECE - 200) {
        const key = SECRET_RE.exec(line.slice(at, at + PIECE));
        if (key) {
          out.push({ kind: 'key', file: rel, line: n, sample: mask(key[0]) });
          break;
        }
      }
      return;
    }
    const key = SECRET_RE.exec(line);
    if (key) out.push({ kind: 'key', file: rel, line: n, sample: mask(key[0]) });
    const pw = PASSWORD_RE.exec(line);
    if (pw && !key && !PLACEHOLDER_RE.test(pw[1]) && !TEMPLATE_RE.test(pw[1])) out.push({ kind: 'password', file: rel, line: n, sample: mask(pw[1]) });
    for (const m of line.matchAll(TC_RE)) {
      if (validTcId(m[0])) {
        out.push({ kind: 'tc-id', file: rel, line: n, sample: mask(m[0]) });
        break;
      }
    }
    const ph = PHONE_RE.exec(line);
    if (ph) out.push({ kind: 'phone', file: rel, line: n, sample: mask(ph[0].replace(/\s/g, '')) });
    const em = line.includes('@') ? EMAIL_RE.exec(line) : null;
    if (em && !EMAIL_FINE_RE.test(em[0])) out.push({ kind: 'email', file: rel, line: n, sample: mask(em[0]) });
  });
  return out;
}

// A file's own name may be the finding (pure)
export function nameFinding(rel) {
  const base = rel.split('/').pop() || '';
  if (ENV_FILE_RE.test(base) && !ENV_SAMPLE_RE.test(base)) return { kind: 'env-file', file: rel, line: 0, sample: '' };
  if (KEY_FILE_RE.test(base)) return { kind: 'key-file', file: rel, line: 0, sample: '' };
  return null;
}

const looksBinary = (buf) => buf.subarray(0, 8192).includes(0);

// The walk (asynchronous: the server keeps answering). Links are never followed. Returns { ok: true, files,
// truncated, findings: [{ kind, level, file, line, sample }] } with the most serious first.
export async function publishCheck(dir, { limits = PUBLISH_LIMITS } = {}) {
  // At most limits.findings kept per level while walking (review E1: a long list of addresses grew without end); the
  // rest only counted
  const kept = { danger: [], warn: [], info: [] };
  let total = 0;
  const keep = (list) => {
    for (const x of list) {
      total++;
      const level = PUBLISH_LEVEL[x.kind];
      if (kept[level].length < limits.findings) kept[level].push({ ...x, level });
    }
  };
  let files = 0;
  let truncated = false;
  const queue = [['', 0]];
  while (queue.length) {
    const [rel, depth] = /** @type {[string, number]} */ (queue.shift());
    let entries;
    try {
      entries = await fs.promises.readdir(rel ? path.join(dir, ...rel.split('/')) : dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase()) && depth + 1 <= limits.depth) queue.push([r, depth + 1]);
        continue;
      }
      if (!e.isFile()) continue;
      if (++files > limits.files) {
        truncated = true;
        break;
      }
      const byName = nameFinding(r);
      if (byName) keep([byName]);
      let buf;
      try {
        const abs = path.join(dir, ...r.split('/'));
        const st = await fs.promises.lstat(abs);
        if (!st.isFile() || st.size > limits.fileBytes) continue;
        buf = await fs.promises.readFile(abs);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      keep(scanText(r, buf.toString('utf8')));
      // A turn for every other request between files
      if (files % 50 === 0) await new Promise((ok) => setImmediate(ok));
    }
    if (truncated) break;
  }
  const byPlace = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
  const all = [...kept.danger.sort(byPlace), ...kept.warn.sort(byPlace), ...kept.info.sort(byPlace)].slice(0, limits.findings);
  return { ok: true, files: Math.min(files, limits.files), truncated, findings: all, more: Math.max(0, total - all.length) };
}

// GET /api/projects/<id>/publish-check: a listed project's own local folder only, with the guards of the other project
// routes (review E1: a registered project at the home folder would walk all of it). Two asks for one folder share one
// walk.
const running = new Map(); // folder -> Promise
export async function projectPublishCheck({ catalog, projectId, limits = PUBLISH_LIMITS }) {
  const p = catalog?.getProject?.(projectId) || null;
  if (!p) return { status: 404, body: { error: 'not-a-project' } };
  if (!p.path || p.exists === false || p.tmpOnly || !isLocalPath(p.path) || hasStreamColon(p.path)) return { status: 404, body: { error: 'folder-missing' } };
  if (p.broad || (typeof catalog.isBroad === 'function' && catalog.isBroad(normPath(p.path)))) return { status: 409, body: { error: 'broad-folder' } };
  try {
    if (!(await fs.promises.stat(p.path)).isDirectory()) return { status: 404, body: { error: 'folder-missing' } };
  } catch {
    return { status: 404, body: { error: 'folder-missing' } };
  }
  let walk = running.get(p.path);
  if (!walk) {
    walk = publishCheck(p.path, { limits }).finally(() => running.delete(p.path));
    running.set(p.path, walk);
  }
  return { status: 200, body: { project: projectId, ...(await walk) } };
}
