// @ts-check
// "What changed" (docs/changes.md): the files an AI tool created or changed in a project, newest first. A git
// repository answers from `git status` (new, changed, deleted, renamed; read-only, no lock, no file system monitor);
// a folder without git from the files' change times of the last 24 hours. Read-only: nothing is written or run in the
// project apart from that git status, and no action mode is needed. Paths are relative to the project folder.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isLocalPath } from './fsutil.mjs';
import { normPath } from './util.mjs';
import { hasStreamColon } from './library.mjs';
import { signalRoot } from './suggest.mjs';
import { GIT_SAFE_ARGS, gitDirArgs, repoCheck, gitProgram } from './git.mjs';

export const MAX_FILES = 30;
export const RECENT_MS = 24 * 3600 * 1000;
// Folders never walked: packages, builds, caches, virtual environments, engines' generated folders
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'bin', 'obj', 'library', 'temp', 'logs', 'venv', '__pycache__', 'coverage', 'vendor', 'packages', 'intermediate', 'binaries', 'deriveddatacache', 'saved']);
const WALK_BUDGET = 5000; // entries looked at, at most
const WALK_DEPTH = 6;
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };

// git status --porcelain=v1 -z entries -> [{ path, kind }] (pure). XY: the index and work tree letters; a rename or
// copy is followed by its old path, which is skipped.
export function parsePorcelain(text, max = MAX_FILES) {
  const parts = String(text || '').split('\0');
  const files = [];
  let more = false;
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const p = e.slice(3);
    if (/[RC]/.test(xy)) i++;
    const kind = xy === '??' ? 'new' : /D/.test(xy) ? 'deleted' : /[RC]/.test(xy) ? 'renamed' : /A/.test(xy) ? 'new' : 'changed';
    if (files.length >= max) {
      more = true;
      break;
    }
    // Shown with the platform's own separator (git writes /)
    files.push({ path: p.split('/').join(path.sep), kind });
  }
  return { files, more };
}

// git status of a repository, at most `max` entries read (git is stopped after them); null when git cannot answer
// exe: git by absolute path (git.mjs gitProgram); none: null at once
export function gitStatus(dir, { max = MAX_FILES, run = spawn, timeoutMs = 10000, exe = gitProgram() } = {}) {
  return new Promise((resolve) => {
    let child;
    if (!exe) return resolve(null);
    try {
      child = run(exe, [...GIT_SAFE_ARGS, ...gitDirArgs(dir), 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], { windowsHide: true, env: GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    let text = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => (child.kill(), finish(null)), timeoutMs);
    child.stdout.on('data', (buf) => {
      text += buf.toString('utf8');
      // Enough entries (a rename takes two): stop reading, the rest only says "more"
      if ((text.match(/\0/g) || []).length > max * 2 + 2) {
        child.kill();
        finish(parsePorcelain(text, max));
      }
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? parsePorcelain(text, max) : null));
  });
}

// Files changed in the last 24 hours in a folder without git, newest first. Links are never followed; hidden folders
// and SKIP_DIRS are not walked; at most WALK_BUDGET entries, WALK_DEPTH levels.
function readEntry(d) {
  try {
    return d.readSync();
  } catch {
    return null;
  }
}

export function recentFiles(dir, { now = Date.now(), since = RECENT_MS, max = MAX_FILES } = {}) {
  const found = [];
  let budget = WALK_BUDGET;
  const queue = [[dir, '', 0]];
  while (queue.length && budget > 0) {
    const [abs, rel, depth] = queue.shift();
    // Entry by entry, so one huge folder costs no more than the budget (review round 1)
    let d;
    try {
      d = fs.opendirSync(abs);
    } catch {
      continue;
    }
    for (let e = readEntry(d); e; e = readEntry(d)) {
      if (--budget <= 0) break;
      const name = e.name;
      const r = rel ? `${rel}${path.sep}${name}` : name;
      if (e.isDirectory()) {
        if (depth + 1 < WALK_DEPTH && !name.startsWith('.') && !SKIP_DIRS.has(name.toLowerCase())) queue.push([path.join(abs, name), r, depth + 1]);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try {
        st = fs.lstatSync(path.join(abs, name));
      } catch {
        continue;
      }
      if (now - st.mtimeMs <= since && st.mtimeMs <= now + 60000) found.push({ path: r, kind: 'changed', t: Math.round(st.mtimeMs) });
    }
    try {
      d.closeSync();
    } catch {
      /* already closed */
    }
  }
  found.sort((a, b) => b.t - a.t);
  return { files: found.slice(0, max), more: found.length > max };
}

// GET /api/projects/<id>/changes -> { status, body }. body: { project, via: 'git' | 'time' | null, files: [{ path,
// kind: 'new' | 'changed' | 'deleted' | 'renamed', t? }], more, gitSkipped? }. via null: no folder that may be read;
// gitSkipped: a repository whose config git was not given (repoConfigSafe), answered by the time walk.
export async function projectChanges({ catalog, projectId, status = gitStatus, recent = recentFiles, safe = async (d) => (await repoCheck(d)) === 'safe', now = Date.now() }) {
  const p = catalog?.getProject?.(projectId) || null;
  if (!p) return { status: 404, body: { error: 'not-a-project' } };
  const body = { project: p.id, via: null, files: [], more: false };
  const isBroad = (d) => typeof catalog.isBroad === 'function' && !!catalog.isBroad(normPath(d));
  if (!p.path || p.broad || p.tmpOnly || !isLocalPath(p.path) || hasStreamColon(p.path) || isBroad(p.path)) return { status: 200, body };
  const dir = signalRoot(p.path, { broad: isBroad });
  if (!dir) return { status: 200, body };
  let git = null;
  let gitSkipped = false;
  try {
    if (fs.lstatSync(path.join(dir, '.git'))) {
      // A config that could make git start a program: the time walk instead (docs/changes.md, "Git safety")
      if (await safe(dir)) git = await status(dir);
      else gitSkipped = true;
    }
  } catch {
    git = null;
  }
  if (git) {
    // The change time of each listed file puts the newest first (a deleted file has none and goes last)
    const files = git.files.map((f) => {
      try {
        return { ...f, t: Math.round(fs.lstatSync(path.join(dir, f.path)).mtimeMs) };
      } catch {
        return f;
      }
    });
    files.sort((a, b) => (b.t || 0) - (a.t || 0));
    return { status: 200, body: { ...body, via: 'git', files, more: git.more } };
  }
  const r = recent(dir, { now });
  return { status: 200, body: { ...body, via: 'time', files: r.files, more: r.more, ...(gitSkipped ? { gitSkipped: true } : {}) } };
}

// A short cache over projectChanges (docs/internal/backlog.md "Long-running load"): every open drawer asked git status every
// 20 s, and two windows or a quick reopen asked it twice. One answer per project is kept for ttl ms and a request
// while one runs waits for that one.
export const CHANGES_TTL_MS = 10000;
export function createChangesCache({ ttl = CHANGES_TTL_MS, now = Date.now, run = projectChanges } = {}) {
  const cache = new Map();
  return {
    get({ catalog, projectId }) {
      const e = cache.get(projectId);
      if (e && (e.pending || now() - e.at < ttl)) return e.promise;
      const entry = { at: now(), pending: true, promise: null };
      entry.promise = Promise.resolve()
        .then(() => run({ catalog, projectId }))
        .then(
          (r) => {
            entry.pending = false;
            entry.at = now();
            // An error answer is not kept: the next request tries again
            if (r?.status !== 200) cache.delete(projectId);
            return r;
          },
          (err) => {
            cache.delete(projectId);
            throw err;
          },
        );
      cache.set(projectId, entry);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      return entry.promise;
    },
    size: () => cache.size,
  };
}
