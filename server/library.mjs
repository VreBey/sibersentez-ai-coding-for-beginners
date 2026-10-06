// Hub library (docs/skills-flow.md §2). The library folders are the source of truth:
//   <hub>/library/<category>/skills/<folder>/SKILL.md   (a skill: the whole folder)
//   <hub>/library/<category>/agents/<file>.md            (an agent: one file)
// This module lists the library, scans a user folder for skills and agents to import (library-scan), plans and
// copies an import (library-import) and rewrites the generated library/catalog.json.
//
// Links: nothing here follows a junction or a symbolic link. Every walk reads the type of the entry itself (lstat,
// Dirent), and a link is skipped; a link where a folder is expected is refused as a reparse point.
//
// Pure module: node built-ins, util.mjs and hub.mjs only (never config.mjs), so actions.mjs can import it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normPath, readFrontmatter, truncate } from './util.mjs';
import { libraryFile, registryFile, readLibrary } from './hub.mjs';

export const CATEGORIES = Object.freeze(['web', 'mobile', 'desktop', 'game', 'data', 'ai', 'devops', 'testing', 'security', 'design', 'docs', 'general']);
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
// One item (a skill folder or an agent file): maxBytes, maxFiles (links and other special entries are counted apart
// against the same number), maxItemDirs folders, entries at most maxItemDepth levels below the item.
// A scan of a source folder: maxDepth levels, maxDirs folders, maxCandidates items.
export const LIMITS = Object.freeze({ maxBytes: 20 * 1024 * 1024, maxFiles: 500, maxItemDirs: 500, maxItemDepth: 16, maxDepth: 6, maxDirs: 20000, maxCandidates: 500 });
export const MAX_REL_PATH = 300;
// What treeHash returns for a tree over the limits: never equal to a real hash (see sameHash)
export const OVER_LIMIT = 'over-limit';
const HASH_RE = /^[0-9a-f]{64}$/;
// Staging leftovers of placeCopy: .sibersentez-tmp-<tag> and .sibersentez-old-<tag>, tag = 12 hex digits
export const LEFTOVER_RE = /^\.sibersentez-(?:tmp|old)-[0-9a-f]{12}$/;
const DESC_MAX = 400;
// Vendored folders: version control and package caches. A scan never enters them (they hold no skills and can be
// huge), and an import never copies them into the library, at any depth of an item (docs/github-import.md §4): the
// review reads exactly what is copied, and says that these folders were left out (review.mjs vendored-folder).
export const VENDORED_DIRS = Object.freeze(['.git', 'node_modules']);
export const isVendoredDir = (name) => VENDORED_DIRS.includes(String(name).toLowerCase());
// Windows device names (COM and LPT with a superscript digit too): a file or folder with such a name cannot be
// created safely
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

export function codeError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

export function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// A junction or a symbolic link (Node reports both as symbolic links on Windows)
export function isLink(p) {
  const s = lstat(p);
  return !!s && s.isSymbolicLink();
}

// A real folder: a link to a folder is not one
export function isRealDir(p) {
  const s = lstat(p);
  return !!s && s.isDirectory();
}

function isRealFile(p) {
  const s = lstat(p);
  return !!s && s.isFile();
}

function dirents(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Byte order of the names: the same on every machine and in every locale
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Real path from the file system (junctions, links, 8.3 short names and alternate data stream forms resolved)
export function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}
const realpath = realPath;

// A user-supplied path with a ':' after the drive letter. 'C:\x::$INDEX_ALLOCATION' (an alternate data stream of
// the folder) opens the folder itself while every name comparison sees another path, so such a path is refused.
export function hasStreamColon(p) {
  return typeof p === 'string' && p.indexOf(':', 2) !== -1;
}

// A drive root: 'C:', 'C:\', 'c:/'
export function isDriveRoot(p) {
  return typeof p === 'string' && /^[A-Za-z]:[\\/]?$/.test(p);
}

// Two tree hashes that name the same content: both real SHA-256 values (OVER_LIMIT, null or a hand-edited record
// value never match)
export function sameHash(a, b) {
  return typeof a === 'string' && HASH_RE.test(a) && a === b;
}

// Is `p` the folder `root` or inside it (case-insensitive, as Windows names paths)
export function within(p, root) {
  const a = normPath(p);
  const b = normPath(root);
  return !!a && !!b && (a === b || a.startsWith(b + '/'));
}

// The same test on the real paths too (a folder reached through a junction elsewhere)
export function withinReal(p, root) {
  if (within(p, root)) return true;
  const a = realpath(p);
  const b = realpath(root);
  return !!a && !!b && within(a, b);
}

// Item name: the contract pattern, plus two Windows rules (a trailing dot is dropped by Windows, device names
// cannot be files)
export function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !name.endsWith('.') && !RESERVED_RE.test(name);
}

const itemKey = (kind, name) => `${kind}:${name}`.toLowerCase();

// JSON written to a temporary file next to the target, then renamed over it: a reader never sees half a file
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Hub layout
// ---------------------------------------------------------------------------------------------------------------

// A hub in the old layout (registry/projeler.json, kutuphane/) is read but never written (contract §2.4)
export function isLegacyHub(hubDir) {
  if (typeof hubDir !== 'string' || !hubDir) return false;
  const reg = registryFile(hubDir);
  const lib = libraryFile(hubDir);
  if (reg && /projeler\.json$/i.test(reg) && isRealFile(reg)) return true;
  if (lib && /katalog\.json$/i.test(lib) && isRealFile(lib)) return true;
  return lstat(path.join(hubDir, 'kutuphane')) !== null && !isRealDir(path.join(hubDir, 'library'));
}

// Library items found in the folders: [{ kind, name, category, description, path, rel }]. The first item of a
// kind and name wins (categories in byte order); hidden folders and links are skipped.
// frontmatter(file): reader (the catalog passes its cached one, so unchanged files are not read again)
export function listLibrary(hubDir, { frontmatter = readFrontmatter } = {}) {
  if (typeof hubDir !== 'string' || !hubDir) return [];
  return listItemsIn(path.join(hubDir, 'library'), 'library', { frontmatter });
}

// Items of a folder in the library layout (<root>/<category>/skills/<folder>/SKILL.md, <root>/<category>/agents/
// <file>.md): the hub library, and the SiberSentez kit (server/kit.mjs), which ships in the same layout. rel starts
// with relRoot ('library/web/skills/x', 'kit/starters/skills/x').
export function listItemsIn(root, relRoot, { frontmatter = readFrontmatter } = {}) {
  const out = [];
  if (typeof root !== 'string' || !root || !isRealDir(root)) return out;
  const seen = new Set();
  const add = (it) => {
    const k = itemKey(it.kind, it.name);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(it);
  };
  for (const c of dirents(root).filter((d) => d.isDirectory() && !d.name.startsWith('.')).sort(byName)) {
    const cat = c.name;
    const skillsDir = path.join(root, cat, 'skills');
    if (isRealDir(skillsDir)) {
      for (const s of dirents(skillsDir).filter((d) => d.isDirectory() && !d.name.startsWith('.')).sort(byName)) {
        const dir = path.join(skillsDir, s.name);
        const md = path.join(dir, 'SKILL.md');
        if (!isRealFile(md)) continue;
        const meta = frontmatter(md) || {};
        add({ kind: 'skill', name: pickName(meta.name, s.name), category: cat, description: truncate(meta.description, DESC_MAX), path: dir, rel: `${relRoot}/${cat}/skills/${s.name}` });
      }
    }
    const agentsDir = path.join(root, cat, 'agents');
    if (isRealDir(agentsDir)) {
      for (const f of dirents(agentsDir).filter((d) => d.isFile() && /\.md$/i.test(d.name) && !/^readme\.md$/i.test(d.name)).sort(byName)) {
        const file = path.join(agentsDir, f.name);
        const meta = frontmatter(file) || {};
        add({ kind: 'agent', name: pickName(meta.name, f.name.replace(/\.md$/i, '')), category: cat, description: truncate(meta.description, DESC_MAX), path: file, rel: `${relRoot}/${cat}/agents/${f.name}` });
      }
    }
  }
  return out;
}

function pickName(fmName, fallback) {
  const n = typeof fmName === 'string' ? fmName.trim() : '';
  return n || fallback;
}

// Everything the roster lists as library items: the folders first, then catalog.json rows without a folder (a
// hand-made catalog keeps working; such rows cannot be installed). A legacy hub is read as before: catalog only.
export function libraryItems(hubDir, opts = {}) {
  if (typeof hubDir !== 'string' || !hubDir) return [];
  const listed = isLegacyHub(hubDir) ? [] : listLibrary(hubDir, opts);
  const keys = new Set(listed.map((it) => itemKey(it.kind, it.name)));
  const extra = readLibrary(hubDir).items.filter((o) => !keys.has(itemKey(o.kind, o.name)));
  return [...listed, ...extra.map((o) => ({ ...o, path: null, rel: null }))];
}

// Library item of a kind and name (case-insensitive, as the folder names on Windows); null when missing
export function findLibraryItem(list, kind, name) {
  const k = itemKey(kind, name);
  return (list || []).find((it) => it.path && itemKey(it.kind, it.name) === k) || null;
}

// Rewrites library/catalog.json from the folders (plus the rows that have no folder). Never on a legacy hub.
export function writeCatalog(hubDir, now = Date.now) {
  if (isLegacyHub(hubDir)) throw codeError('legacy-hub');
  const items = libraryItems(hubDir).map(({ name, kind, category, description }) => ({ name, kind, category, description }));
  writeJsonAtomic(path.join(hubDir, 'library', 'catalog.json'), { updated: new Date(now()).toISOString(), count: items.length, items });
  return items.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Trees: hash, size, copy (links are never followed)
// ---------------------------------------------------------------------------------------------------------------

// The item limits with defaults for the keys a caller left out
const itemLimits = (limits) => (limits === LIMITS ? LIMITS : { ...LIMITS, ...limits });

// Thrown inside a hash walk when the tree grew over the limits after it was measured
const OVER = Symbol('over-limit');

// SHA-256 over a tree: relative paths ('/' separated, byte order) and file contents. A single file hashes its
// contents only, so an agent keeps its hash under another file name. links: 'mark' counts a link (or another
// special entry) as an entry of its own, 'skip' leaves it out (what a copy produces). vendored: 'keep' reads every
// folder, 'skip' leaves the vendored folders out (what an import copies). null when missing.
// The tree is measured first: a tree over the limits is never read and gives OVER_LIMIT (contract §3.8).
export function treeHash(p, { links = 'mark', limits = LIMITS, vendored = 'keep' } = {}) {
  const L = itemLimits(limits);
  const st = lstat(p);
  if (!st) return null;
  const skipVendored = vendored === 'skip';
  if (sizeProblem(measureTree(p, L, { vendored }), L)) return OVER_LIMIT;
  const h = crypto.createHash('sha256');
  if (st.isSymbolicLink()) h.update('link\n');
  else if (st.isFile()) {
    h.update('file\n');
    h.update(fs.readFileSync(p));
  } else if (st.isDirectory()) {
    h.update('dir\n');
    try {
      hashDir(h, p, '', links === 'mark', { files: 0, bytes: 0, links: 0, dirs: 0, depth: 0 }, 1, L, skipVendored);
    } catch (e) {
      if (e === OVER) return OVER_LIMIT;
      throw e;
    }
  } else h.update('other\n');
  return h.digest('hex');
}

// count: running totals, checked against the limits again (the tree may change between measuring and hashing)
function hashDir(h, dir, rel, mark, count, depth, L, skipVendored) {
  for (const d of dirents(dir).sort(byName)) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (skipVendored && d.isDirectory() && isVendoredDir(d.name)) continue;
    count.depth = Math.max(count.depth, depth);
    if (d.isSymbolicLink()) {
      count.links++;
      if (mark) h.update(`L ${r}\n`);
    } else if (d.isDirectory()) {
      count.dirs++;
      if (sizeProblem(count, L)) throw OVER;
      h.update(`D ${r}\n`);
      hashDir(h, path.join(dir, d.name), r, mark, count, depth + 1, L, skipVendored);
    } else if (d.isFile()) {
      const file = path.join(dir, d.name);
      count.files++;
      count.bytes += lstat(file)?.size || 0;
      if (sizeProblem(count, L)) throw OVER;
      const buf = fs.readFileSync(file);
      h.update(`F ${r} ${buf.length}\n`);
      h.update(buf);
    } else {
      count.links++;
      if (mark) h.update(`O ${r}\n`);
    }
    if (sizeProblem(count, L)) throw OVER;
  }
}

// Files, bytes, links (and other special entries, counted apart), folders and the deepest level of a tree (entries
// right under the item are level 1). The folder is read entry by entry and counting stops as soon as a limit is
// passed, so a tree over the limits is never read whole (the caller only needs to know it is over).
// vendored: 'skip' leaves the vendored folders out (neither counted nor entered), as an import copies the tree.
export function measureTree(p, limits = LIMITS, { vendored = 'keep' } = {}) {
  const L = itemLimits(limits);
  const skipVendored = vendored === 'skip';
  const out = { files: 0, bytes: 0, links: 0, dirs: 0, depth: 0 };
  const st = lstat(p);
  if (!st) return out;
  if (st.isSymbolicLink()) {
    out.links = 1;
    return out;
  }
  if (st.isFile()) return { ...out, files: 1, bytes: st.size };
  if (!st.isDirectory()) return out;
  const over = () => sizeProblem(out, L) !== null;
  const walk = (dir, depth) => {
    let handle;
    try {
      handle = fs.opendirSync(dir);
    } catch {
      return;
    }
    try {
      for (let d = handle.readSync(); d !== null; d = handle.readSync()) {
        if (skipVendored && d.isDirectory() && isVendoredDir(d.name)) continue;
        out.depth = Math.max(out.depth, depth);
        if (d.isSymbolicLink()) out.links++;
        else if (d.isDirectory()) {
          out.dirs++;
          if (!over()) walk(path.join(dir, d.name), depth + 1);
        } else if (d.isFile()) {
          out.files++;
          out.bytes += lstat(path.join(dir, d.name))?.size || 0;
        } else out.links++;
        if (over()) return;
      }
    } catch {
      /* a folder that cannot be read further counts as read so far */
    } finally {
      try {
        handle.closeSync();
      } catch {
        /* already closed */
      }
    }
  };
  walk(p, 1);
  return out;
}

// The first limit a measured tree passes, as a code: too-many-files, too-large, too-many-folders, too-deep; or null
export function sizeProblem(m, limits = LIMITS) {
  const L = itemLimits(limits);
  if (m.files > L.maxFiles || (m.links || 0) > L.maxFiles) return 'too-many-files';
  if (m.bytes > L.maxBytes) return 'too-large';
  if ((m.dirs || 0) > L.maxItemDirs) return 'too-many-folders';
  if ((m.depth || 0) > L.maxItemDepth) return 'too-deep';
  return null;
}

// Copies a file or a folder to a NEW destination. Links (and other special entries) are skipped, never followed.
// vendored: 'skip' leaves the vendored folders (.git, node_modules) out at any depth (an import into the library).
// The source is measured before anything is copied, and the limits are checked again while copying. Throws with a
// code: reparse-point, not-found, too-many-files, too-large, too-many-folders, too-deep.
export function copyTree(src, dest, limits = LIMITS, { vendored = 'keep' } = {}) {
  const L = itemLimits(limits);
  const st = lstat(src);
  if (!st) throw codeError('not-found');
  if (st.isSymbolicLink()) throw codeError('reparse-point');
  if (!st.isFile() && !st.isDirectory()) throw codeError('not-found');
  const problem = sizeProblem(measureTree(src, L, { vendored }), L);
  if (problem) throw codeError(problem);
  const count = { files: 0, bytes: 0, links: 0, dirs: 0, depth: 0, skipped: 0, vendored: 0 };
  if (st.isFile()) {
    copyOne(src, dest, count, L);
    return count;
  }
  fs.mkdirSync(dest);
  copyDir(src, dest, count, L, 1, vendored === 'skip');
  return count;
}

function copyDir(src, dest, count, L, depth, skipVendored) {
  for (const d of fs.readdirSync(src, { withFileTypes: true }).sort(byName)) {
    const s = path.join(src, d.name);
    const t = path.join(dest, d.name);
    if (skipVendored && d.isDirectory() && isVendoredDir(d.name)) {
      count.vendored++;
      continue;
    }
    count.depth = Math.max(count.depth, depth);
    if (d.isSymbolicLink() || !(d.isDirectory() || d.isFile())) {
      count.skipped++;
      count.links++;
    } else if (d.isDirectory()) {
      count.dirs++;
      overCheck(count, L);
      fs.mkdirSync(t);
      copyDir(s, t, count, L, depth + 1, skipVendored);
    } else copyOne(s, t, count, L);
    overCheck(count, L);
  }
}

function overCheck(count, L) {
  const problem = sizeProblem(count, L);
  if (problem) throw codeError(problem);
}

function copyOne(s, t, count, L) {
  count.files++;
  count.bytes += fs.lstatSync(s).size;
  overCheck(count, L);
  fs.copyFileSync(s, t, fs.constants.COPYFILE_EXCL);
}

const rmTree = (p) => fs.rmSync(p, { recursive: true, force: true });

// Puts a copy of `src` at `dest` through a hidden staging copy in `stageDir` (contract §3.7: the tool folder above
// skills/ and agents/, or the library root, so no tool ever loads a staging copy as an item): copied first, then
// renamed into place. With replace the current destination is moved aside into stageDir and deleted only after the
// new copy is in place; expectHash (optional) must still match the current destination, otherwise nothing changes
// (it was modified meanwhile). Once the new copy is in place, failing to delete the old one is not an error: it is
// left as .sibersentez-old-<tag> and swept at the next server start. removeTree: how a staging copy is deleted (tests
// make it fail). vendored: see copyTree. Returns { leftover } (true: the old copy is still there).
export function placeCopy(src, dest, { replace = false, expectHash = null, limits = LIMITS, stageDir, removeTree = rmTree, vendored = 'keep' } = {}) {
  if (typeof stageDir !== 'string' || !stageDir) throw codeError('internal');
  const quietRemove = (p) => {
    try {
      removeTree(p);
    } catch {
      /* a leftover is swept at the next server start */
    }
  };
  const tag = crypto.randomBytes(6).toString('hex');
  const tmp = path.join(stageDir, `.sibersentez-tmp-${tag}`);
  try {
    copyTree(src, tmp, limits, { vendored });
  } catch (e) {
    quietRemove(tmp);
    throw e;
  }
  const cur = lstat(dest);
  if (!cur) {
    try {
      fs.renameSync(tmp, dest);
    } catch (e) {
      quietRemove(tmp);
      throw e;
    }
    return { leftover: false };
  }
  if (!replace || cur.isSymbolicLink() || (expectHash !== null && !sameHash(treeHash(dest, { limits }), expectHash))) {
    quietRemove(tmp);
    throw codeError(!replace ? 'exists' : cur.isSymbolicLink() ? 'reparse-point' : 'modified');
  }
  const old = path.join(stageDir, `.sibersentez-old-${tag}`);
  try {
    fs.renameSync(dest, old);
  } catch (e) {
    quietRemove(tmp);
    throw e;
  }
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      fs.renameSync(old, dest);
    } catch {
      /* the old copy stays in the staging folder under its hidden name and is swept later */
    }
    quietRemove(tmp);
    throw e;
  }
  quietRemove(old);
  return { leftover: lstat(old) !== null };
}

// Removes staging leftovers (LEFTOVER_RE) directly inside `dir`: only entries with exactly that name that are a
// real folder or a real file. A link with that name is left alone, and a folder is deleted without following the
// links inside it. Returns { removed, kept }.
export function sweepStaging(dir) {
  const out = { removed: 0, kept: 0 };
  if (!isRealDir(dir)) return out;
  for (const d of dirents(dir)) {
    if (!LEFTOVER_RE.test(d.name)) continue;
    const p = path.join(dir, d.name);
    const st = lstat(p);
    if (!st || st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) {
      out.kept++;
      continue;
    }
    try {
      rmTree(p);
      out.removed++;
    } catch {
      out.kept++;
    }
  }
  return out;
}

// Staging folders of the hub library: library/ itself (where an import stages now) and every category's skills/
// and agents/ folder (where an older version staged). Real folders only; never on a legacy hub.
export function libraryStageDirs(hubDir) {
  if (typeof hubDir !== 'string' || !hubDir || isLegacyHub(hubDir)) return [];
  const root = path.join(hubDir, 'library');
  if (!isRealDir(root)) return [];
  const out = [root];
  for (const c of dirents(root).filter((d) => d.isDirectory() && !d.name.startsWith('.')).sort(byName)) {
    for (const g of ['skills', 'agents']) {
      const dir = path.join(root, c.name, g);
      if (isRealDir(dir)) out.push(dir);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Category proposal (deterministic keyword table, English and Turkish)
// ---------------------------------------------------------------------------------------------------------------

export const CATEGORY_KEYWORDS = Object.freeze([
  ['game', ['game', 'games', 'gameplay', 'unity', 'unreal', 'godot', 'shader', 'sprite', 'level design', 'oyun', 'oyuncu']],
  ['mobile', ['mobile', 'ios', 'android', 'expo', 'react native', 'flutter', 'swiftui', 'kotlin', 'mobil']],
  ['desktop', ['desktop', 'electron', 'tauri', 'wpf', 'winforms', 'masaüstü', 'masaustu']],
  ['web', ['web', 'website', 'react', 'nextjs', 'next js', 'vue', 'svelte', 'angular', 'html', 'css', 'frontend', 'front end', 'tailwind', 'browser', 'seo', 'arayüz', 'arayuz']],
  ['data', ['data', 'sql', 'database', 'postgres', 'mysql', 'sqlite', 'pandas', 'analytics', 'etl', 'csv', 'spreadsheet', 'veri', 'veritabanı', 'veritabani']],
  ['ai', ['ai', 'llm', 'machine learning', 'ml', 'prompt', 'prompts', 'rag', 'embedding', 'embeddings', 'openai', 'anthropic', 'claude api', 'yapay zeka', 'yapay zekâ']],
  ['devops', ['devops', 'docker', 'kubernetes', 'k8s', 'ci', 'cd', 'deploy', 'deployment', 'pipeline', 'terraform', 'github actions', 'infrastructure', 'dağıtım', 'dagitim', 'altyapı']],
  ['testing', ['test', 'tests', 'testing', 'qa', 'e2e', 'unit test', 'jest', 'vitest', 'playwright', 'cypress', 'coverage']],
  ['security', ['security', 'secure', 'vulnerability', 'vulnerabilities', 'owasp', 'encryption', 'pentest', 'threat model', 'güvenlik', 'guvenlik']],
  ['design', ['design', 'ui', 'ux', 'figma', 'typography', 'color', 'colors', 'layout', 'accessibility', 'a11y', 'tasarım', 'tasarim']],
  ['docs', ['docs', 'documentation', 'readme', 'markdown', 'writing', 'changelog', 'technical writing', 'belge', 'belgeler', 'dokümantasyon', 'dokumantasyon']],
]);

// Lower-cased words separated by single spaces, padded: ' react native app '
export function normText(s) {
  return ` ${String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9çğıöşüâîû]+/g, ' ')
    .trim()} `;
}

// Is the keyword (one word or a phrase) in the normalized text as whole words
export function hasKeyword(text, kw) {
  const k = normText(kw).trim();
  return !!k && text.includes(` ${k} `);
}

// { category, reason }: name hits weigh 3, description hits 1; the highest total wins, a tie goes to the table
// order; no hit: 'general'. reason: { keyword, field } of the strongest hit, or null.
export function proposeCategory(name, description) {
  const n = normText(name);
  const d = normText(description);
  let best = null;
  for (const [category, words] of CATEGORY_KEYWORDS) {
    let score = 0;
    let nameHit = null;
    let descHit = null;
    for (const kw of words) {
      if (hasKeyword(n, kw)) {
        score += 3;
        nameHit = nameHit || kw;
      } else if (hasKeyword(d, kw)) {
        score += 1;
        descHit = descHit || kw;
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { category, score, reason: nameHit ? { keyword: nameHit, field: 'name' } : { keyword: descHit, field: 'description' } };
  }
  return best ? { category: best.category, reason: best.reason } : { category: 'general', reason: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Import: scan a folder, plan, copy
// ---------------------------------------------------------------------------------------------------------------

const fail = (status, error) => ({ ok: false, status, error });

// The folder a scan may read: an absolute local folder with a drive letter (no UNC or device path, no ':' after the
// drive letter), not a drive root, not the home folder itself, not the hub or inside it, not a link, existing. The
// root, home and hub rules are checked on the given path and again on the real path, so an 8.3 short name, a
// trailing dot or an alternate data stream form of a refused folder is refused too (contract §2.3).
export function checkSource(raw, { hubDir = null, homeDir = null } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 260 || CTRL_RE.test(raw)) return fail(400, 'bad-source');
  const s = raw.trim();
  if (!/^[A-Za-z]:[\\/]/.test(s) || hasStreamColon(s)) return fail(400, 'bad-source');
  let dir = path.win32.normalize(s);
  if (dir.length > 3) dir = dir.replace(/[\\/]+$/, '');
  if (isDriveRoot(dir)) return fail(409, 'source-is-root');
  if (homeDir && normPath(dir) === normPath(homeDir)) return fail(409, 'source-is-home');
  const st = lstat(dir);
  if (!st) return fail(404, 'source-missing');
  if (st.isSymbolicLink()) return fail(409, 'reparse-point');
  if (!st.isDirectory()) return fail(404, 'source-missing');
  const real = realPath(dir);
  if (!real) return fail(404, 'source-missing');
  if (!/^[A-Za-z]:[\\/]/.test(real) || hasStreamColon(real)) return fail(400, 'bad-source');
  if (isDriveRoot(real)) return fail(409, 'source-is-root');
  if (homeDir && normPath(real) === normPath(realPath(homeDir) || homeDir)) return fail(409, 'source-is-home');
  if (hubDir && (withinReal(dir, hubDir) || within(real, realPath(hubDir) || hubDir))) return fail(409, 'source-in-hub');
  return { ok: true, dir };
}

// library-scan. Reads SKILL.md and agent frontmatter and file sizes only. Returns { ok, source, items, truncated }:
// items [{ path (relative to the source, '/' separated; '.' is the source itself), kind, name, description, size,
// files, links, category, categoryReason, status: new|same|conflict, problems: [bad-name|too-large|too-many-files|
// duplicate], libraryCategory }]
export function scanSource(raw, { hubDir = null, homeDir = null, library = null, limits = LIMITS, frontmatter = readFrontmatter } = {}) {
  const c = checkSource(raw, { hubDir, homeDir });
  if (!c.ok) return c;
  return scanDir(c.dir, { hubDir, library, limits, frontmatter });
}

// The walk of scanSource over a folder the caller already checked: a user folder that passed checkSource, or a
// download of the GitHub import (server/github.mjs), which lives in the hub's incoming/ folder and so can never pass
// the "not inside the hub" rule. The same result shape as scanSource; nothing is followed or written.
export function scanDir(dir, { hubDir = null, library = null, limits = LIMITS, frontmatter = readFrontmatter } = {}) {
  const c = { dir };
  const lib = library || listLibrary(hubDir);
  const found = [];
  let dirs = 0;
  let truncated = false;
  const add = (it) => {
    if (found.length >= limits.maxCandidates) {
      truncated = true;
      return;
    }
    found.push(it);
  };
  const walk = (dir, depth, rel) => {
    if (truncated) return;
    if (++dirs > limits.maxDirs) {
      truncated = true;
      return;
    }
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
    } catch {
      return;
    }
    // A folder with SKILL.md is one skill: its sub folders belong to it
    if (ents.some((d) => d.isFile() && d.name === 'SKILL.md')) {
      const meta = frontmatter(path.join(dir, 'SKILL.md')) || {};
      add({ abs: dir, rel: rel || '.', kind: 'skill', name: pickName(meta.name, path.basename(dir)), description: truncate(meta.description, DESC_MAX) });
      return;
    }
    if (path.basename(dir).toLowerCase() === 'agents') {
      for (const f of ents) {
        if (!f.isFile() || !/\.md$/i.test(f.name) || /^readme\.md$/i.test(f.name)) continue;
        const file = path.join(dir, f.name);
        const meta = frontmatter(file) || {};
        add({ abs: file, rel: rel ? `${rel}/${f.name}` : f.name, kind: 'agent', name: pickName(meta.name, f.name.replace(/\.md$/i, '')), description: truncate(meta.description, DESC_MAX) });
      }
    }
    if (depth >= limits.maxDepth) return;
    for (const d of ents) {
      if (!d.isDirectory() || isVendoredDir(d.name)) continue;
      walk(path.join(dir, d.name), depth + 1, rel ? `${rel}/${d.name}` : d.name);
    }
  };
  walk(c.dir, 0, '');

  const seen = new Set();
  const items = found.map((f) => {
    // Measured and compared as the import copies it: without the vendored folders
    const m = measureTree(f.abs, limits, { vendored: 'skip' });
    const problems = [];
    if (!validName(f.name)) problems.push('bad-name');
    const size = sizeProblem(m, limits);
    if (size) problems.push(size);
    const key = itemKey(f.kind, f.name);
    if (seen.has(key)) problems.push('duplicate');
    seen.add(key);
    const existing = findLibraryItem(lib, f.kind, f.name);
    let status = 'new';
    if (existing) {
      // Both trees are measured before either is hashed (contract §2.3, §3.8); a tree over the limits is a conflict
      const libSize = sizeProblem(measureTree(existing.path, limits), limits);
      status = !size && !libSize && sameHash(treeHash(f.abs, { links: 'skip', limits, vendored: 'skip' }), treeHash(existing.path, { links: 'skip', limits, vendored: 'skip' })) ? 'same' : 'conflict';
    }
    const proposal = existing ? { category: existing.category, reason: { library: existing.category } } : proposeCategory(f.name, f.description);
    return {
      path: f.rel,
      kind: f.kind,
      name: f.name,
      description: f.description,
      size: m.bytes,
      files: m.files,
      links: m.links,
      category: proposal.category,
      categoryReason: proposal.reason,
      status,
      problems,
      libraryCategory: existing ? existing.category : null,
      _abs: f.abs,
      _existing: existing,
    };
  });
  return { ok: true, source: c.dir, items, truncated };
}

// Public copy of scan items (internal fields dropped)
export function publicScanItems(items) {
  return items.map(({ _abs, _existing, ...rest }) => rest);
}

// Relative path from a scan result: '/' or '\' separated, no drive, no leading separator, no '.' or '..' part
// (except the single '.' for the source itself). Returns the '/' form or null.
export function normRel(p) {
  if (typeof p !== 'string' || !p || p.length > MAX_REL_PATH || CTRL_RE.test(p)) return null;
  if (p === '.') return '.';
  if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split(/[\\/]/);
  if (parts.some((x) => !x || x === '.' || x === '..')) return null;
  return parts.join('/');
}

// A category the import may write to: a known one, or a folder the user already made under library/
export function validCategory(cat, hubDir) {
  if (typeof cat !== 'string' || !CATEGORY_RE.test(cat)) return false;
  return CATEGORIES.includes(cat) || isRealDir(path.join(hubDir, 'library', cat));
}

// library-import plan. picks: [{ path, category, replace? }] (already shape-checked). The source is scanned again, so
// every pick is checked by the same rules as the scan. Returns { ok, plan } or { ok: false, status, error }.
// Plan entries: { op: copy|update|skip, kind, name, category, from, path?, reason } plus internal _src, _expect.
// scan: a scan result made by the caller (scanDir of a GitHub download, docs/github-import.md) in place of scanning
// `source` again; its items carry the same fields (_abs, _existing).
export function planImport({ hubDir, homeDir = null, source, picks, limits = LIMITS, scan: given = null }) {
  const scan = given || scanSource(source, { hubDir, homeDir, limits });
  if (!scan.ok) return scan;
  const byRel = new Map(scan.items.map((it) => [it.path, it]));
  const libRoot = path.join(hubDir, 'library');
  const plan = [];
  const taken = new Set();
  for (const pick of picks) {
    const rel = normRel(pick.path);
    const cand = rel ? byRel.get(rel) : null;
    if (!cand) {
      plan.push({ op: 'skip', kind: 'unknown', name: String(pick.path || '').slice(0, 80), from: String(pick.path || '').slice(0, MAX_REL_PATH), reason: 'not-found' });
      continue;
    }
    const e = { op: 'skip', kind: cand.kind, name: cand.name, category: pick.category, from: cand.path, reason: '' };
    plan.push(e);
    const key = itemKey(cand.kind, cand.name);
    if (cand.problems.length) e.reason = cand.problems[0];
    else if (taken.has(key)) e.reason = 'duplicate';
    else if (!validCategory(pick.category, hubDir)) e.reason = 'bad-category';
    else if (cand.status === 'same') e.reason = 'same';
    else if (cand.status === 'conflict' && pick.replace !== true) e.reason = 'conflict';
    if (e.reason) continue;
    taken.add(key);
    let dest;
    if (cand.status === 'conflict') {
      // Replaced in place: the item keeps its library category. The current library copy is measured before it is
      // hashed; one over the limits is not replaced (its size problem is the reason)
      dest = cand._existing.path;
      e.category = cand._existing.category;
      const libSize = sizeProblem(measureTree(dest, limits), limits);
      if (libSize) {
        e.path = dest;
        e.reason = libSize;
        continue;
      }
      e.op = 'update';
      e.reason = 'replace';
      e._expect = treeHash(dest, { limits });
    } else {
      dest = path.join(libRoot, pick.category, cand.kind === 'skill' ? 'skills' : 'agents', cand.kind === 'skill' ? cand.name : `${cand.name}.md`);
      e.op = 'copy';
      e.reason = 'new';
      e._expect = null;
    }
    e.path = dest;
    e._src = cand._abs;
    const guard = importGuard(hubDir, dest);
    if (guard) {
      e.op = 'skip';
      e.reason = guard;
    } else if (e.op === 'copy' && lstat(dest)) {
      e.op = 'skip';
      e.reason = 'exists';
    }
  }
  return { ok: true, plan, source: scan.source };
}

// Destination rules inside the hub library: stays inside library/, and no folder on the way is a link
function importGuard(hubDir, dest) {
  const libRoot = path.resolve(hubDir, 'library');
  const d = path.resolve(dest);
  if (!d.toLowerCase().startsWith(libRoot.toLowerCase() + path.sep)) return 'outside-library';
  let cur = path.dirname(d);
  for (;;) {
    if (isLink(cur)) return 'reparse-point';
    if (cur.toLowerCase() === libRoot.toLowerCase() || path.dirname(cur) === cur) break;
    cur = path.dirname(cur);
  }
  return null;
}

// Runs the copy and update entries of an import plan (live mode). A failing entry turns into a skip with its code;
// the others still run. The vendored folders (.git, node_modules) are never copied into the library (the review of a
// GitHub item reads the same set). removeTree: see placeCopy. Returns { copied, updated }.
export function executeImport({ hubDir, plan, limits = LIMITS, removeTree = rmTree }) {
  let copied = 0;
  let updated = 0;
  for (const e of plan) {
    if (e.op !== 'copy' && e.op !== 'update') continue;
    try {
      const guard = importGuard(hubDir, e.path);
      if (guard) throw codeError(guard);
      fs.mkdirSync(path.dirname(e.path), { recursive: true });
      const again = importGuard(hubDir, e.path);
      if (again) throw codeError(again);
      // Staged in library/ itself, outside every category (a category folder can be a --plugin-dir package)
      placeCopy(e._src, e.path, { replace: e.op === 'update', expectHash: e.op === 'update' ? e._expect : null, limits, stageDir: path.join(hubDir, 'library'), removeTree, vendored: 'skip' });
      if (e.op === 'copy') copied++;
      else updated++;
    } catch (err) {
      e.op = 'skip';
      e.reason = typeof err?.code === 'string' && /^[a-z-]+$/.test(err.code) ? err.code : 'error';
    }
  }
  return { copied, updated };
}

// Plan entries as sent to the browser: internal fields (starting with '_') dropped
export function publicPlan(plan) {
  return plan.map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_'))));
}
