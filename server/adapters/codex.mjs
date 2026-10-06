// Codex source adapter (see adapters/index.mjs; contract docs/adapters-wave1.md).
//   root: CODEX_HOME (ctx.env), else ~/.codex
//   projects: <root>/sessions/YYYY/MM/DD/rollout-*.jsonl and <root>/archived_sessions/**/rollout-*.jsonl. The working
//             folder comes from the FIRST LINE only (SessionMeta: payload.cwd, else a top-level cwd), and at most
//             256 KiB of it is read; no later line is ever parsed. lastSeenAt: the file time.
//   project items: skills <p>/.agents/skills; agents <p>/.codex/agents/*.toml
//   global items: skills ~/.agents/skills and <root>/skills/* except .system (personal), <root>/skills/.system/*
//             (builtin); agents <root>/agents/*.toml (personal); plugins <root>/plugins/cache/<market>/<plugin>/<version>
//             (one version per plugin, the highest in semantic version order, with its skills/)
import fs from 'node:fs';
import path from 'node:path';
import { exists, kindOf, listFiles, safeDirs } from '../fsutil.mjs';
import { BUILTIN, PERSONAL, PROJECT, cleanPath, dedupeProjects, envRoot, listerOf, manifestText, readText, skillItems, toolPluginItems } from './shared.mjs';

// Read limit for the first line of a rollout, and the chunk size: reading stops at the first line break, so at
// most one chunk past it is ever read into memory (and never decoded). The chunk is small (contract §3: 4 KiB).
export const FIRST_LINE_MAX = 256 * 1024;
export const CHUNK = 4 * 1024;
const WALK_DEPTH = 4;
const ROLLOUT = /^rollout-.*\.jsonl$/i;
// The first "cwd": "<JSON string>" in an over-long first line
const CWD_RE = /"cwd"\s*:\s*("(?:[^"\\\r\n]|\\.)*")/;

export const codexHome = (ctx) => envRoot(ctx, 'CODEX_HOME', '.codex');

function cwdOf(o) {
  if (!o || typeof o !== 'object') return null;
  const p = o.payload && typeof o.payload === 'object' ? o.payload.cwd : undefined;
  if (typeof p === 'string' && p) return p;
  return typeof o.cwd === 'string' && o.cwd ? o.cwd : null;
}

// Working folder in the first line of a rollout: { cwd, final }. final is false when the first line is not complete
// yet (a file being written): the file is read again once it grows. A first line longer than FIRST_LINE_MAX: the
// first "cwd" string of the part read (regex + JSON.parse of the string literal), else nothing. { error: true } when
// the file cannot be opened or read (locked, access denied): that is never cached, the file is read again next pass.
export function rolloutCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { error: true };
  }
  try {
    const buf = Buffer.alloc(FIRST_LINE_MAX);
    let len = 0;
    let nl = -1;
    let eof = false;
    while (len < FIRST_LINE_MAX) {
      const n = fs.readSync(fd, buf, len, Math.min(CHUNK, FIRST_LINE_MAX - len), len);
      if (!n) {
        eof = true;
        break;
      }
      nl = buf.subarray(0, len + n).indexOf(0x0a, len);
      len += n;
      if (nl !== -1) break;
    }
    if (nl !== -1 || eof) {
      // Only the bytes before the first line break are decoded
      const line = buf.toString('utf8', 0, nl !== -1 ? nl : len).replace(/\r$/, '');
      try {
        return { cwd: cwdOf(JSON.parse(line)), final: nl !== -1 };
      } catch {
        return { cwd: null, final: nl !== -1 };
      }
    }
    const m = CWD_RE.exec(buf.toString('utf8', 0, len));
    if (!m) return { cwd: null, final: true };
    try {
      const v = JSON.parse(m[1]);
      return { cwd: typeof v === 'string' && v ? v : null, final: true };
    } catch {
      return { cwd: null, final: true };
    }
  } catch {
    return { error: true };
  } finally {
    fs.closeSync(fd);
  }
}

// rollout-*.jsonl files under a folder, at most `depth` levels down; hidden entries skipped
function rolloutFiles(dir, depth, out = []) {
  if (depth < 0) return out;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const kind = kindOf(dir, e);
    if (kind === 'dir') rolloutFiles(path.join(dir, e.name), depth - 1, out);
    else if (kind === 'file' && ROLLOUT.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

// ---------------- agents (.toml) ----------------

// A TOML string value: basic "...", literal '...', or the first line of a multi-line """...""" / '''...'''.
// next() gives the following line (a multi-line string may start on it). null if the value is not a string.
function tomlString(raw, next) {
  const s = raw.trim();
  for (const q of ['"""', "'''"]) {
    if (!s.startsWith(q)) continue;
    let body = s.slice(3);
    if (!body.trim()) body = next() || '';
    const end = body.indexOf(q);
    return (end === -1 ? body : body.slice(0, end)).trim();
  }
  let m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  }
  m = /^'([^']*)'/.exec(s);
  return m ? m[1] : null;
}

// name and description of a Codex agent file (top-level keys only; everything else is ignored)
export function tomlNameDescription(file) {
  const text = readText(file);
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break; // a table starts: the top-level keys are over
    const m = /^\s*(name|description)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m || out[m[1]] !== undefined) continue;
    const v = tomlString(m[2], () => lines[i + 1]);
    if (v !== null) out[m[1]] = v;
  }
  return out;
}

// Agent files <dir>/*.toml. Their name and description are cached by file time and size (ctx.fileMeta): an unchanged
// file is not reopened on the next pass; an unreadable one is not cached.
export function tomlAgentItems(dir, ctx, extra) {
  const out = [];
  const meta = (file) => (typeof ctx?.fileMeta === 'function' ? ctx.fileMeta(file, 'codex-toml', tomlNameDescription) : tomlNameDescription(file));
  for (const f of listFiles(dir, listerOf(ctx))) {
    if (!/\.toml$/i.test(f) || f.length <= 5) continue;
    const file = path.join(dir, f);
    const m = meta(file) || {};
    out.push({ kind: 'agent', name: m.name || f.slice(0, -5), path: file, description: m.description || '', ...extra });
  }
  return out;
}

// ---------------- plugins ----------------

// Semantic version order of two version folder names (> 0 when a is higher): numeric parts compare as numbers, a
// pre-release (1.0.0-beta) is lower than its release (1.0.0) and pre-release identifiers compare as in semver
// (numeric ones as numbers and below alphanumeric ones; a longer set wins when the shared part is equal); build
// metadata (+...) is ignored. A name that is not a version is lower than every version; two such names compare as text.
const VERSION = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
export function compareVersions(a, b) {
  const ma = VERSION.exec(a);
  const mb = VERSION.exec(b);
  if (!ma || !mb) return ma ? 1 : mb ? -1 : a.localeCompare(b, 'en', { numeric: true });
  const na = ma[1].split('.').map(Number);
  const nb = mb[1].split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] || 0) - (nb[i] || 0);
    if (d) return d;
  }
  if (!ma[2] || !mb[2]) return (ma[2] ? -1 : 0) + (mb[2] ? 1 : 0);
  const pa = ma[2].split('.');
  const pb = mb[2].split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const da = /^\d+$/.test(pa[i]);
    const db = /^\d+$/.test(pb[i]);
    if (da && db) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d) return d;
    } else if (da !== db) return da ? -1 : 1;
    else if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// The version folder of a cached plugin: the highest version; "latest" (a link) only when it is the only one
function pluginVersion(dir, ls) {
  const all = safeDirs(dir, ls);
  const versions = all.filter((d) => d !== 'latest').sort((a, b) => compareVersions(b, a));
  if (versions.length) return path.join(dir, versions[0]);
  return all.includes('latest') ? path.join(dir, 'latest') : null;
}

export const codex = {
  id: 'codex',
  name: 'Codex',

  detect(ctx) {
    return exists(codexHome(ctx));
  },

  findProjects(ctx) {
    const root = codexHome(ctx);
    const cache = ctx.cache.rollouts || (ctx.cache.rollouts = new Map());
    const gen = (ctx.cache.gen = (ctx.cache.gen || 0) + 1);
    const out = [];
    for (const sub of ['sessions', 'archived_sessions']) {
      for (const file of rolloutFiles(path.join(root, sub), WALK_DEPTH)) {
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        // A rollout's folder never changes: cached by path. A first line without a folder is read again only when
        // the file grew while its first line was incomplete. A failed read (file locked) is not cached.
        let hit = cache.get(file);
        if (!hit || (!hit.final && hit.size !== st.size)) {
          const r = rolloutCwd(file);
          if (r.error) {
            cache.delete(file);
            continue;
          }
          hit = { cwd: cleanPath(r.cwd), final: r.final, size: st.size };
          cache.set(file, hit);
        }
        hit.gen = gen;
        if (hit.cwd) out.push({ path: hit.cwd, lastSeenAt: st.mtimeMs });
      }
    }
    // Rollouts that disappeared drop out of the cache
    for (const [f, e] of cache) if (e.gen !== gen) cache.delete(f);
    return dedupeProjects(out);
  },

  findItems(projectPath, ctx) {
    return [
      ...skillItems(path.join(projectPath, '.agents', 'skills'), ctx, PROJECT),
      ...tomlAgentItems(path.join(projectPath, '.codex', 'agents'), ctx, PROJECT),
    ];
  },

  findGlobalItems(ctx) {
    const root = codexHome(ctx);
    const ls = listerOf(ctx);
    const out = [
      ...skillItems(path.join(ctx.homeDir, '.agents', 'skills'), ctx, PERSONAL),
      ...skillItems(path.join(root, 'skills'), ctx, PERSONAL, { skip: ['.system'] }),
      ...skillItems(path.join(root, 'skills', '.system'), ctx, BUILTIN),
      ...tomlAgentItems(path.join(root, 'agents'), ctx, PERSONAL),
    ];
    const cache = path.join(root, 'plugins', 'cache');
    for (const market of safeDirs(cache, ls)) {
      for (const plugin of safeDirs(path.join(cache, market), ls)) {
        const dir = pluginVersion(path.join(cache, market, plugin), ls);
        if (!dir) continue;
        const description = manifestText(path.join(dir, '.codex-plugin', 'plugin.json'), 'description');
        out.push(...toolPluginItems(dir, plugin, 'codex', ctx, { description }));
      }
    }
    return out;
  },
};
