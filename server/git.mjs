// @ts-check
// Git state of registered projects: branch, changed/untracked file counts, latest commits.
// Truly read-only: with --no-optional-locks, git status does not refresh .git/index and
// does not take index.lock (agents' concurrent commits are not disturbed). Every two minutes, one after another.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { truncate, redact } from './util.mjs';
import { findGit } from './github.mjs';

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
// A project's own .git/config could name a program as its file system monitor (core.fsmonitor), which git status would
// start: a folder received as an archive would run code just by being watched. Every call turns it off.
// log.showSignature off: a signed commit would start the repository's gpg.program.
export const GIT_SAFE_ARGS = Object.freeze(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false']);

// Every call names the repository and its work tree itself: git never looks for one (the project folder as a bare
// repository, a parent folder) and core.worktree of a config cannot move it
export function gitDirArgs(dir) {
  return [`--git-dir=${path.join(dir, '.git')}`, `--work-tree=${dir}`];
}

// Whether git may run in a folder at all (docs/changes.md, "Git safety"). Git starts programs named in the
// repository's own config: a clean filter during status (seen with the installed git), a signature program for a
// signed commit, a text converter, a monitor. The flags above turn two of them off; the others have names of the
// repository's choosing, so a config that names any program-carrying setting, or includes another file, is never
// given to git. The config is read by git's own parser (`git config --file`, which runs nothing): a text pattern
// missed two section headers on one line (review round 1).
const CONFIG_MAX = 64 * 1024;
const UNSAFE_SECTIONS = new Set(['filter', 'include', 'includeif', 'gpg', 'diff']);
const UNSAFE_LAST = new Set(['fsmonitor', 'showsignature', 'program', 'textconv', 'command', 'cmd', 'sshcommand', 'askpass', 'hookspath', 'pager', 'editor', 'external', 'worktreeconfig', 'alternaterefscommand']);

// Pure: whether a config's names (section[.subsection].key, as git lists them) name nothing that can start a program
export function configNamesSafe(names) {
  if (!Array.isArray(names)) return false;
  for (const n of names) {
    const low = String(n).toLowerCase();
    const section = low.split('.')[0];
    const last = low.slice(low.lastIndexOf('.') + 1);
    if (UNSAFE_SECTIONS.has(section) || UNSAFE_LAST.has(last)) return false;
  }
  return true;
}

// The names in one config file, by git's parser (includes not followed); null when git cannot read it, NO_GIT when
// there is no git to ask. Run from the system's temporary folder, so no repository around the working folder is read.
export const NO_GIT = 'no-git';
export function configNames(file, { run = execFile, exe = gitProgram() } = {}) {
  return new Promise((resolve) => {
    if (!exe) return resolve(NO_GIT);
    try {
      run(exe, ['config', '--file', file, '--no-includes', '--list', '--name-only', '-z'], { timeout: 5000, windowsHide: true, maxBuffer: 1 << 20, env: GIT_ENV, cwd: os.tmpdir() }, (err, stdout) => {
        resolve(err ? (err.code === 'ENOENT' ? NO_GIT : null) : String(stdout).split('\0').filter(Boolean));
      });
    } catch {
      resolve(null);
    }
  });
}

// 'safe' | 'unsafe' | 'no-git' for a folder, remembered while its config files keep their time and size (the git
// watcher asks every 30 s; git config runs again only when a config changed)
const checked = new Map(); // dir -> { sig, answer }
function configSig(gitDir) {
  return ['config', 'config.worktree', 'commondir', 'HEAD']
    .map((n) => {
      try {
        const st = fs.lstatSync(path.join(gitDir, n));
        return `${n}:${st.mtimeMs}:${st.size}:${st.isFile() ? 'f' : 'o'}`;
      } catch {
        return `${n}:-`;
      }
    })
    .join('|');
}
export async function repoCheck(dir, { names = configNames } = {}) {
  const gitDir = path.join(dir, '.git');
  const sig = configSig(gitDir);
  const hit = checked.get(dir);
  if (hit && hit.sig === sig && names === configNames) return hit.answer;
  let noGit = false;
  const answer = (await repoConfigSafe(dir, {
    names: async (f) => {
      const r = await names(f);
      if (r === NO_GIT) noGit = true;
      return r;
    },
  }))
    ? 'safe'
    : noGit
      ? 'no-git'
      : 'unsafe';
  if (names === configNames) checked.set(dir, { sig, answer });
  return answer;
}

// A real .git folder that is a whole repository of its own: HEAD, objects and refs in it, no commondir (which would
// make git read another folder's config), its config (and config.worktree when there is one) small, readable and safe
export async function repoConfigSafe(dir, { names = configNames } = {}) {
  try {
    const gitDir = path.join(dir, '.git');
    if (!fs.lstatSync(gitDir).isDirectory()) return false;
    const has = (name, kind) => {
      try {
        const st = fs.lstatSync(path.join(gitDir, name));
        return kind === 'dir' ? st.isDirectory() : st.isFile();
      } catch {
        return false;
      }
    };
    if (!has('HEAD', 'file') || !has('objects', 'dir') || !has('refs', 'dir')) return false;
    try {
      fs.lstatSync(path.join(gitDir, 'commondir'));
      return false;
    } catch {
      /* no commondir: this folder is the repository */
    }
    for (const name of ['config', 'config.worktree']) {
      const file = path.join(gitDir, name);
      let st;
      try {
        st = fs.lstatSync(file);
      } catch {
        if (name === 'config') return false;
        continue;
      }
      if (!st.isFile() || st.size > CONFIG_MAX) return false;
      if (!configNamesSafe(await names(file))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// git.exe by absolute path (review A7): Windows would look for a bare 'git' in the working folder first. Looked up
// again after GIT_FIND_TTL_MS, so a Git installed while the app runs is found; null: no git (every call answers null)
const GIT_FIND_TTL_MS = 5 * 60 * 1000;
let gitFound = { at: -Infinity, exe: null };
export function gitProgram(now = Date.now()) {
  if (now - gitFound.at > GIT_FIND_TTL_MS) gitFound = { at: now, exe: findGit() };
  return gitFound.exe;
}

function git(cwd, args) {
  return new Promise((resolve) => {
    const exe = gitProgram();
    if (!exe) return resolve(null);
    execFile(exe, [...GIT_SAFE_ARGS, ...gitDirArgs(cwd), ...args], { timeout: 20000, windowsHide: true, maxBuffer: 4 << 20, env: GIT_ENV }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

// status output can be megabytes in big repos: lines are counted without buffering it
function statusCounts(cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      // if stderr is not read, a full pipe blocks git: it is discarded
      const exe = gitProgram();
      if (!exe) return resolve(null);
      child = spawn(exe, [...GIT_SAFE_ARGS, ...gitDirArgs(cwd), 'status', '--porcelain=v1', '--ignore-submodules=all'], { windowsHide: true, env: GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    let lines = 0;
    let untracked = 0;
    let col = 0;
    let first = 0;
    const timer = setTimeout(() => child.kill(), 20000);
    child.stdout.on('data', (buf) => {
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b === 10) {
          lines++;
          col = 0;
          continue;
        }
        if (col === 0) first = b;
        else if (col === 1 && first === 63 && b === 63) untracked++; // "??"
        col++;
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { changed: lines - untracked, untracked } : null);
    });
  });
}

export class GitWatcher {
  constructor(catalog, ingest) {
    this.catalog = catalog;
    this.ingest = ingest;
    this.seen = new Map(); // projectId -> Set(hash)
    this.running = false;
  }

  // Each project on its own interval: normally 2 min; big repos whose scan takes over 2 s
  // (e.g. a Unity repo with 65 thousand changes) every 10 min
  start() {
    this.nextAt = new Map();
    this.refreshAll();
    setInterval(() => this.refreshAll(), 30000).unref();
  }

  async refreshAll() {
    if (this.running) return;
    this.running = true;
    try {
      const ids = this.catalog.projects.map((p) => p.id);
      for (const id of ids) {
        const p = this.catalog.getProject(id);
        if (!p?.exists || !p.path || !fs.existsSync(path.join(p.path, '.git'))) continue;
        if ((this.nextAt.get(id) || 0) > Date.now()) continue;
        // A config that could make git start a program: no git here (the drawer says why); no git at all: unreadable
        const check = await repoCheck(p.path);
        if (check !== 'safe') {
          p.git = { ...(check === 'unsafe' ? { unsafe: true } : {}), branch: null, changed: null, untracked: null, commits: [], checkedAt: Date.now() };
          this.nextAt.set(id, Date.now() + 2 * 60000);
          continue;
        }
        const t0 = Date.now();
        await this.refresh(p.id, p.path);
        const took = Date.now() - t0;
        this.nextAt.set(id, Date.now() + (took > 2000 ? 10 * 60000 : 2 * 60000));
      }
    } finally {
      this.running = false;
    }
  }

  async refresh(id, cwd) {
    // symbolic-ref gives the branch name even in repos with no commit (rev-parse fails there)
    const [branch, log, counts] = await Promise.all([
      git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']),
      git(cwd, ['log', '-n', '20', '--date=iso-strict', '--pretty=format:%h%x1f%aI%x1f%s']),
      statusCounts(cwd),
    ]);
    const commits = (log || '')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [h, t, s] = l.split('\x1f');
        return { h, t: Date.parse(t) || 0, s: truncate(redact(s), 140) };
      });
    const info = {
      branch: (branch || '').trim() || null,
      // null = unreadable (timeout, broken repo): the UI shows "unknown", not "clean"
      changed: counts ? counts.changed : null,
      untracked: counts ? counts.untracked : null,
      commits: commits.slice(0, 10),
      checkedAt: Date.now(),
    };
    // The catalog may have been reloaded while waiting: write to the current object
    const cur = this.catalog.getProject(id);
    if (cur) cur.git = info;
    let seen = this.seen.get(id);
    const first = !seen;
    if (!seen) this.seen.set(id, (seen = new Set()));
    for (const c of commits.slice().reverse()) {
      if (seen.has(c.h)) continue;
      seen.add(c.h);
      // On the first round, old commits inside the window also enter the timeline
      if (first || c.t > Date.now() - 3600000) {
        this.ingest.addEvent({ t: c.t, kind: 'commit', projectId: id, actor: 'g:' + id, text: c.s, meta: { hash: c.h } });
      }
    }
    this.ingest.dirty.projects.add(id);
  }
}
