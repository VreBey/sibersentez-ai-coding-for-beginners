// File system helpers shared by the catalog and the source adapters. Every function swallows file system errors
// and returns an empty result: a missing or unreadable folder never takes the app down.
import fs from 'node:fs';
import path from 'node:path';
import { normPath } from './util.mjs';

export function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

// A local drive-letter path ("C:\x", "c:/x"). UNC paths (\\server\share, \\wsl$, \\wsl.localhost) and device paths
// (\\?\, \\.\) are not: checking them can block on an offline share or wake a WSL distribution (contract §3).
export function isLocalPath(p) {
  return typeof p === 'string' && /^[A-Za-z]:[\\/]/.test(p);
}

// exists() for a local drive-letter path only; any other path is never checked and counts as missing
// A folder that holds nothing but AI tools' own setup (seen 2026-10-01: a project moved to another drive left its old
// folder with only .claude in it, and a job was started there): true when it has at least one entry and every entry is
// one of these. A .git folder or any other file makes it a project.
export const TOOL_ONLY_NAMES = Object.freeze(new Set(['.claude', '.agents', '.codex', '.cursor', '.gemini', '.qwen', '.opencode', '.sibersentez', '.vscode', '.idea', 'claude.md', 'agents.md', 'gemini.md', '.mcp.json', 'desktop.ini', 'thumbs.db']));
export function toolsOnly(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return names.length > 0 && names.every((n) => TOOL_ONLY_NAMES.has(n.toLowerCase()));
}

export function localExists(p) {
  return isLocalPath(p) && exists(p);
}

// Drive letter upper-cased ("c:\x" -> "C:\x")
export function upperDrive(p) {
  return String(p).replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
}

// A link (symlink, or a Windows junction) is neither a file nor a folder in its Dirent: its target decides
export function kindOf(dir, d) {
  if (d.isDirectory()) return 'dir';
  if (d.isFile()) return 'file';
  if (!d.isSymbolicLink()) return null;
  try {
    const st = fs.statSync(path.join(dir, d.name));
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
  } catch {
    return null; // broken link
  }
}

// Entries of a folder: [{ name, kind }], kind 'dir', 'file' or null (a broken link, a device); [] when the folder
// cannot be listed
export function readEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, kind: kindOf(dir, d) }));
  } catch {
    return [];
  }
}

// Folder listings without a cache (the default of every helper below)
export const PLAIN_LISTER = Object.freeze({ entries: readEntries });

// Folder listings for one pass: every folder is listed once, however many adapters read it (.agents/skills is read
// by five tools, .claude/skills by three). The catalog makes a new one at the start of every pass, so a change on
// disk is seen on the next pass. Folders are keyed case-insensitively, as Windows names them.
export class DirLister {
  constructor() {
    this.map = new Map();
  }

  entries(dir) {
    const k = normPath(dir);
    let list = this.map.get(k);
    if (!list) {
      list = readEntries(dir);
      this.map.set(k, list);
    }
    return list;
  }
}

// Sub folder names (linked ones included). Hidden folders (.git, .in_use, ...) are left out unless asked for.
// ls: a folder lister (PLAIN_LISTER or a DirLister of the current pass).
export function listDirs(dir, { hidden = false, ls = PLAIN_LISTER } = {}) {
  return ls.entries(dir)
    .filter((e) => e.kind === 'dir' && (hidden || !e.name.startsWith('.')))
    .map((e) => e.name);
}

// Visible sub folders (the common case)
export function safeDirs(dir, ls = PLAIN_LISTER) {
  return listDirs(dir, { ls });
}

// Visible file names in a folder (linked files included); hidden files are left out
export function listFiles(dir, ls = PLAIN_LISTER) {
  return ls.entries(dir)
    .filter((e) => e.kind === 'file' && !e.name.startsWith('.'))
    .map((e) => e.name);
}

// Does a folder hold at least one entry (readdir only, nothing is opened)
export function hasEntries(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// Modification time in ms, 0 when the path cannot be read
export function mtimeOf(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// Folders holding a SKILL.md: directly under root, otherwise one level deeper (at most `depth` levels)
export function skillDirs(root, depth, ls = PLAIN_LISTER, out = []) {
  for (const d of safeDirs(root, ls)) {
    const dir = path.join(root, d);
    if (exists(path.join(dir, 'SKILL.md'))) out.push(dir);
    else if (depth > 1) skillDirs(dir, depth - 1, ls, out);
  }
  return out;
}

// agents/**/*.md: at most 2 sublevels per folder; README files and hidden folders excluded. Linked folders
// and files are followed; a folder reached twice (a link loop, or two links to one target) is read once.
export function walkMd(root, ls = PLAIN_LISTER) {
  const out = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    for (const e of ls.entries(dir)) {
      if (e.name.startsWith('.')) continue;
      const f = path.join(dir, e.name);
      if (e.kind === 'dir') walk(f, depth + 1);
      else if (e.kind === 'file' && e.name.endsWith('.md') && !/^readme\.md$/i.test(e.name)) out.push(f);
    }
  };
  walk(root, 0);
  return out;
}

// Exact on-disk spelling of an existing local folder, or null (missing, ambiguous, not a local drive-letter path).
// Tools may store a path lower-cased (Gemini CLI). realpath gives the spelling at once when it names the same path.
// When it names another path (a junction or a link on the way) the path is walked name by name from the drive root
// instead, never following the link to its target. JavaScript lower-casing cannot be undone for every letter ('İ'
// becomes 'i' plus U+0307, which Windows does not match with 'İ'), so a part realpath cannot find is walked too:
// each level takes the single sub folder whose lower-cased name equals the given one; none or several give null.
// readDirs(dir) lists sub folder names (can be memoized by the caller).
export function folderSpelling(p, readDirs = (d) => listDirs(d, { hidden: true })) {
  if (!isLocalPath(p)) return null;
  let base = p;
  let rest = [];
  for (;;) {
    let real = null;
    try {
      real = fs.realpathSync.native(base);
    } catch {
      real = null;
    }
    if (real) {
      if (normPath(real) === normPath(base)) base = real;
      else {
        // A link on the way: walk the whole path from the drive root
        base = `${p[0].toUpperCase()}:\\`;
        rest = p.slice(3).split(/[\\/]+/).filter(Boolean);
      }
      break;
    }
    const parent = path.dirname(base);
    if (parent === base) return null;
    rest.unshift(path.basename(base));
    base = parent;
  }
  let cur = base;
  for (const part of rest) {
    const want = part.toLowerCase();
    const hits = readDirs(cur).filter((n) => n.toLowerCase() === want);
    if (hits.length !== 1) return null;
    cur = path.join(cur, hits[0]);
  }
  return upperDrive(cur);
}

// A lower-cased spelling: nothing after the drive letter has an upper-case form (Gemini CLI stores paths this way,
// so such a spelling tells nothing about the real one)
export function isLowerCased(p) {
  const tail = String(p).slice(2);
  return tail === tail.toLowerCase();
}
