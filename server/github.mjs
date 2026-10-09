// Bringing skills and agents from a GitHub repository into the hub library (docs/github-import.md).
//
// One of the two places SiberSentez sends a request to the internet (the other: the optional new-version look,
// server/update.mjs), and only when the person presses "Fetch" (or "Check for update") with actions On. Only https://github.com, https://codeload.github.com and https://api.github.com are ever
// contacted; any other host, a redirect elsewhere, a URL with a user name or password and the ssh forms are refused.
// Public repositories only: a repository that asks for credentials is "not public", no credential is ever asked for.
//
// Download: the tar.gz archive from codeload first, read by the small tar reader below as it streams (Node's own zlib;
// no zip), with every limit checked on the way. Only when that path fails (codeload blocked, offline, a broken
// archive) and git is on this computer: a shallow clone (git.exe found on PATH by absolute path, never in a project
// folder; no window, no prompt, no credential helper, no hooks, no submodules, no LFS, no symlinks), whose folder is
// measured while git runs; past a limit or the time limit the whole process tree is ended. Both land in the hub's
// incoming/ folder, <hub>/incoming/<owner>-<repo>-<name hash>@<commit prefix>/ with a marker <id>.json next to it, and
// are deleted after the import, on "Cancel", or at the latest seven days later (cleanupIncoming, run when the action
// layer starts and before every download).
//
// Provenance: every item imported from GitHub gets a row in <hub>/registry/sources.json (repository, ref, commit,
// path, license, review, hash of the library copy). The roster shows it; "Check for update" reads it.
//
// Pure module apart from the injected network (request) and process (spawn) functions: node built-ins and local
// modules that never import config.mjs (actions.mjs and catalog.mjs import it).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import { spawn as nodeSpawn } from 'node:child_process';
import { lstat, isRealDir, codeError, writeJsonAtomic, scanDir, publicScanItems, normRel, planImport, treeHash, sameHash, measureTree, sizeProblem, listLibrary, withinReal, hasStreamColon, isVendoredDir, LIMITS } from './library.mjs';
import { reviewItem, itemLicense, repoLicense } from './review.mjs';
import { findKitItem } from './kit.mjs';
import { killTree } from './tools.mjs';
import { PLATFORM, isLocalAbsolute } from './platform.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------------------

// A whole download: the compressed archive, the unpacked tree (files, folders as many as a scan walks, bytes, one
// file, path length and depth)
export const REPO_LIMITS = Object.freeze({ maxArchiveBytes: 200 * 1024 * 1024, maxBytes: 500 * 1024 * 1024, maxFiles: 50000, maxDirs: LIMITS.maxDirs, maxEntryBytes: 100 * 1024 * 1024, maxPath: 400, maxDepth: 40, maxMetaBytes: 1024 * 1024 });
// watchMs: how often the git download's folder is measured; killWaitMs: how long an ended process tree is waited for
// before its folder is deleted
const TIMEOUTS = Object.freeze({ cloneMs: 300000, lsRemoteMs: 60000, apiMs: 30000, downloadMs: 300000, watchMs: 1000, killWaitMs: 5000 });
// Failures of the archive path after which git is tried (when it is here): the archive could not be reached or read.
// Not after not-public, ref-not-found, a size limit or an unsafe archive: git would answer the same.
// A broken archive is not among them: a repository could otherwise steer the download to git, whose size is only
// measured once a second (review round 2, advisory)
const TAR_FALLBACK = new Set(['network', 'timeout', 'fetch-failed', 'redirect-refused', 'rate-limited']);
// Downloads older than this are removed (a leftover .tmp- folder after an hour)
const INCOMING_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const TMP_MAX_AGE_MS = 3600 * 1000;
const MAX_REDIRECTS = 3;
export const GITHUB_HOSTS = Object.freeze(['github.com', 'codeload.github.com', 'api.github.com']);
const USER_AGENT = 'SiberSentez';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._/+-]{1,200}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
// A download's id: <owner>-<repo (at most 40 characters)>-<6 hex of the name>@<12 hex of the commit> (fetchIdOf). The
// older form <owner>-<repo>@<7 hex> is still recognized, so its downloads are cleaned up.
export const FETCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,90}@[0-9a-f]{7,40}$/;
const TMP_RE = /^\.tmp-[0-9a-f]{12}$/;
const MAX_URL = 500;
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// ---------------------------------------------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------------------------------------------

const bad = (error) => ({ ok: false, status: 400, error });

// A ref as git accepts it and as a URL can carry it: no '..', no leading '-' or '/', no '//', no trailing '/' or
// '.lock', no '@{'
export function validRef(ref) {
  return typeof ref === 'string' && REF_RE.test(ref) && !ref.includes('..') && !ref.includes('//') && !/^[-/.]/.test(ref) && !/\/$|\.lock$|\.$/.test(ref) && !ref.includes('@{');
}

// The link a person pastes: https://github.com/<owner>/<repo>[.git][/tree/<ref>[/<path>]] (or /blob/<ref>/<file>,
// which means the file's folder). "github.com/<owner>/<repo>" without a scheme and www.github.com are accepted too.
// Refused: other hosts (bad: not-github), a user name or password in the link (url-credentials), the ssh and git forms
// (ssh-url), anything else (bad-url). Returns { ok, owner, repo, ref (null: the default branch), path (a folder of the
// repository or null), name ('owner/repo'), cloneUrl }.
export function parseGitHubUrl(raw) {
  if (typeof raw !== 'string') return bad('bad-url');
  let s = raw.trim();
  if (!s || s.length > MAX_URL || CTRL_RE.test(s) || /\s/.test(s)) return bad('bad-url');
  if (/^(?:ssh|git|git\+ssh|ssh\+git):\/\//i.test(s) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(s)) return bad('ssh-url');
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s)) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && !/^(?:www\.)?github\.com[:/]/i.test(s)) return bad('bad-url');
    s = `https://${s}`;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return bad('bad-url');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return bad('bad-url');
  if (u.username || u.password || /^[^/]*@/.test(s.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, ''))) return bad('url-credentials');
  let host = u.hostname.toLowerCase();
  if (host === 'www.github.com') host = 'github.com';
  if (host !== 'github.com') return bad('not-github');
  if (u.port && u.port !== (u.protocol === 'https:' ? '443' : '80')) return bad('not-github');
  let segs;
  try {
    segs = u.pathname
      .split('/')
      .filter(Boolean)
      .map((x) => decodeURIComponent(x));
  } catch {
    return bad('bad-url');
  }
  if (segs.some((x) => /[\\/]/.test(x) || CTRL_RE.test(x))) return bad('bad-url');
  if (segs.length < 2) return bad('bad-url');
  const owner = segs[0];
  const repo = segs[1].replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || /^\.+$/.test(repo)) return bad('bad-url');
  let ref = null;
  let sub = null;
  if (segs.length > 2) {
    const kind = segs[2];
    if ((kind !== 'tree' && kind !== 'blob') || segs.length < 4) return bad('bad-url');
    ref = segs[3];
    let rest = segs.slice(4);
    if (kind === 'blob') rest = rest.slice(0, -1);
    if (rest.length) {
      sub = normRel(rest.join('/'));
      if (!sub || sub === '.') return bad('bad-url');
    }
    if (!validRef(ref)) return bad('bad-url');
  }
  return { ok: true, owner, repo, ref, path: sub, name: `${owner}/${repo}`, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

// The repository of a provenance row ('owner/repo') as parseGitHubUrl gives it, or null
export function parseRepoName(name, ref = null) {
  if (typeof name !== 'string' || !/^[^/]+\/[^/]+$/.test(name)) return null;
  const p = parseGitHubUrl(`https://github.com/${name}`);
  if (!p.ok) return null;
  if (ref !== null && ref !== undefined && !validRef(ref)) return null;
  return { ...p, ref: ref || null };
}

// Can a request (or a redirect) go to this address: https only, a GitHub host, the default port, no user name
export function allowedUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && GITHUB_HOSTS.includes(u.hostname.toLowerCase()) && (!u.port || u.port === '443') && !u.username && !u.password;
}

const encodeRef = (ref) =>
  String(ref)
    .split('/')
    .map((x) => encodeURIComponent(x))
    .join('/');

// The readable head of a download's id: <owner>-<repo (at most 40 characters)>-<6 hex>. The 6 hex digits are the
// SHA-256 of 'owner/repo' (lower case: GitHub names ignore letter case, and so do Windows folders), so a-b/c and a/b-c,
// or two names that differ after 40 characters, never share a folder.
function fetchIdHead(owner, repo) {
  const tag = crypto.createHash('sha256').update(`${owner}/${repo}`.toLowerCase()).digest('hex').slice(0, 6);
  return `${owner}-${String(repo).slice(0, 40)}-${tag}`;
}

// The id of a download: <head>@<12 hex digits of the commit>
export function fetchIdOf(owner, repo, commit) {
  return `${fetchIdHead(owner, repo)}@${String(commit).slice(0, 12).toLowerCase()}`;
}

// ---------------------------------------------------------------------------------------------------------------
// git: found by absolute path, run without a window, a prompt or a credential helper
// ---------------------------------------------------------------------------------------------------------------

function realFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const envValue = (env, name) => {
  const k = Object.keys(env || {}).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? env[k] : undefined;
};

// git.exe by absolute path: the absolute folders of PATH in order (a relative entry such as '.' is skipped, so git
// is never looked up in the working folder or a project), then the usual install folders. null: no git.
export function findGit({ env = process.env, isFile = realFile, plat = PLATFORM } = {}) {
  // Linux and macOS: the absolute folders of PATH, then the system's own (git is a system package there)
  if (!plat.windows) {
    const posix = [...String(envValue(env, 'PATH') || '').split(':').map((d) => d.trim()).filter((d) => isLocalAbsolute(d, plat) && !CTRL_RE.test(d)), '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
    for (const d of posix) {
      const exe = plat.path.join(d, 'git');
      if (isFile(exe)) return exe;
    }
    return null;
  }
  const dirs = [];
  for (const d of String(envValue(env, 'PATH') || '').split(';')) {
    const x = d.trim().replace(/^"|"$/g, '');
    if (/^[A-Za-z]:[\\/]/.test(x) && !hasStreamColon(x) && !CTRL_RE.test(x)) dirs.push(x);
  }
  for (const v of ['ProgramW6432', 'ProgramFiles']) {
    const base = envValue(env, v);
    if (typeof base === 'string' && /^[A-Za-z]:[\\/]/.test(base)) dirs.push(path.win32.join(base, 'Git', 'cmd'));
  }
  const local = envValue(env, 'LOCALAPPDATA');
  if (typeof local === 'string' && /^[A-Za-z]:[\\/]/.test(local)) dirs.push(path.win32.join(local, 'Programs', 'Git', 'cmd'));
  for (const d of dirs) {
    const exe = path.win32.join(d, 'git.exe');
    if (isFile(exe)) return exe;
  }
  return null;
}

// Settings given on every git command line (they win over the user's and the system's git settings): no credential
// helper and no askpass program (a repository that wants a password fails instead of asking), no symlinks, no line
// ending conversion, no file system monitor, hooks from a folder that does not exist, https only, no redirect, no
// submodules, no LFS download, objects checked.
export function gitConfigArgs(hooksPath) {
  return [
    ['credential.helper', ''],
    ['core.askPass', ''],
    ['core.symlinks', 'false'],
    ['core.autocrlf', 'false'],
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', hooksPath],
    ['core.longpaths', 'true'],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ['http.followRedirects', 'false'],
    ['submodule.recurse', 'false'],
    ['filter.lfs.smudge', ''],
    ['filter.lfs.process', ''],
    ['filter.lfs.required', 'false'],
    ['transfer.fsckObjects', 'true'],
    ['advice.detachedHead', 'false'],
  ].flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

// The environment of a git process: the parent's without any GIT_*, GCM_* or SSH_ASKPASS value, plus: no terminal
// prompt, no interactive credential manager, no askpass program, no LFS download, only https, no repository discovery
// above the incoming folder (ceiling)
export function gitEnv(base = process.env, ceiling = '') {
  const out = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (/^(?:GIT_|GCM_)/i.test(k) || /^SSH_ASKPASS$/i.test(k)) continue;
    out[k] = v;
  }
  return Object.assign(out, {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CEILING_DIRECTORIES: ceiling,
  });
}

// The spawn options of every git process: no window, no shell, no input, output read through pipes
export function gitSpawnOptions({ cwd, env }) {
  return { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] };
}

// The argument list of a shallow clone (pure). ref: a branch or a tag, or null for the default branch.
export function cloneArgs({ url, ref = null, dest, hooksPath }) {
  return [...gitConfigArgs(hooksPath), 'clone', '--depth', '1', '--single-branch', '--no-tags', '--no-recurse-submodules', '--template=', ...(ref ? ['--branch', ref] : []), '--', url, dest];
}

// ls-remote of one ref (pure): its branch, its tag and the commit the tag points to; HEAD without a ref
export function lsRemoteArgs({ url, ref = null, hooksPath }) {
  return [...gitConfigArgs(hooksPath), 'ls-remote', '--', url, ...(ref ? [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`] : ['HEAD'])];
}

// The commit an ls-remote answer names: the commit a tag points to, else the branch, the tag, HEAD; null when none
export function parseLsRemote(text, ref = null) {
  const rows = String(text || '')
    .split(/\r?\n/)
    .map((l) => /^([0-9a-f]{40})\t(\S+)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => ({ sha: m[1], name: m[2] }));
  const pick = (name) => rows.find((r) => r.name === name)?.sha || null;
  if (!ref) return pick('HEAD');
  return pick(`refs/tags/${ref}^{}`) || pick(`refs/heads/${ref}`) || pick(`refs/tags/${ref}`);
}

// What a failed git command means, from its error output: not-public (a password was asked for, or the repository
// does not exist), ref-not-found, network, or git-failed
export function gitFailure(stderr) {
  const s = String(stderr || '');
  if (/terminal prompts disabled|could not read (?:Username|Password)|Authentication failed|Repository not found|HTTP (?:401|403|404)|returned error: (?:401|403|404)|not found/i.test(s)) {
    if (/Remote branch .* not found|couldn't find remote ref|not found in upstream/i.test(s)) return 'ref-not-found';
    return 'not-public';
  }
  if (/Remote branch .* not found|couldn't find remote ref/i.test(s)) return 'ref-not-found';
  if (/Could not resolve host|Failed to connect|Connection (?:timed out|refused|reset)|Operation timed out|unable to access|SSL|TLS|proxy/i.test(s)) return 'network';
  return 'git-failed';
}

// Runs git and collects its output (at most 64 KB of each stream). Rejects with timeout, git-missing, or the code the
// watch returned. kill(child): ends git with every process it started (git-remote-https, index-pack). watch: { everyMs,
// check } calls check() while git runs; a code it returns stops git the same way as the time limit. After a stop the
// promise settles once git has closed (its files can be deleted then), at the latest after killWaitMs.
function runGit(spawn, exe, args, opts, timeoutMs, { kill = (c) => c?.kill(), watch = null, killWaitMs = TIMEOUTS.killWaitMs } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, opts);
    } catch (e) {
      return reject(codeError(e?.code === 'ENOENT' ? 'git-missing' : 'git-failed'));
    }
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    let done = false;
    let closed = false;
    let stopped = null;
    let timer = null;
    let watcher = null;
    let waitTimer = null;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watcher);
      clearTimeout(waitTimer);
      fn();
    };
    const stop = (code) => {
      if (done || stopped) return;
      stopped = code;
      clearTimeout(timer);
      clearInterval(watcher);
      try {
        kill(child);
      } catch {
        /* already gone */
      }
      if (closed) return finish(() => reject(codeError(code)));
      waitTimer = setTimeout(() => finish(() => reject(codeError(code))), killWaitMs);
    };
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    if (watch) {
      watcher = setInterval(() => {
        let code = null;
        try {
          code = watch.check();
        } catch {
          /* measured again next time */
        }
        if (code) stop(code);
      }, watch.everyMs);
    }
    child.stdout?.on('data', (c) => {
      if (outLen < 65536) out.push(c);
      outLen += c.length;
    });
    child.stderr?.on('data', (c) => {
      if (errLen < 65536) err.push(c);
      errLen += c.length;
    });
    child.on('error', (e) => finish(() => reject(codeError(stopped || (e?.code === 'ENOENT' ? 'git-missing' : 'git-failed')))));
    child.on('close', (code) => {
      closed = true;
      if (stopped) return finish(() => reject(codeError(stopped)));
      finish(() => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Tar reader (a GitHub archive: ustar with pax headers)
// ---------------------------------------------------------------------------------------------------------------

// Windows device names (COM and LPT with a superscript digit ¹ ² ³ too) and characters a file name cannot hold
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/i;
const BAD_CHARS_RE = /[<>:"|?*\u0000-\u001f]/;

// An archive path, first part stripped (GitHub puts everything under <repo>-<commit>/): the relative '/' path to write,
// null to skip the entry (the top folder itself, a name Windows cannot hold, too long or too deep). Throws
// tar-unsafe-path for an absolute path, a drive letter or a '..' part (a crafted archive).
export function tarEntryPath(raw, { strip = 1, limits = REPO_LIMITS } = {}) {
  const s = String(raw || '').replace(/\\/g, '/');
  if (/^\//.test(s) || /^[A-Za-z]:/.test(s) || /^\/\//.test(s)) throw codeError('tar-unsafe-path');
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..')) throw codeError('tar-unsafe-path');
  const rest = parts.slice(strip);
  if (!rest.length) return null;
  if (rest.some((x) => BAD_CHARS_RE.test(x) || RESERVED_RE.test(x) || /[. ]$/.test(x))) return null;
  const rel = rest.join('/');
  if (rel.length > limits.maxPath || rest.length > limits.maxDepth) return null;
  return rel;
}

const TYPE_FILE = new Set(['0', '\0', '7']);

// A commit's time as an ISO string (pure): seconds since 1970, between 2005 (git's first year) and a day after nowMs;
// anything else is null
export function commitTime(seconds, nowMs = Date.now()) {
  if (!Number.isFinite(seconds) || seconds < 1104537600 || seconds * 1000 > nowMs + 86400000) return null;
  return new Date(Math.floor(seconds) * 1000).toISOString();
}

function octal(buf, off, len) {
  if (buf[off] & 0x80) return Infinity; // base-256: larger than any limit here
  const s = buf.toString('latin1', off, off + len).replace(/\0.*$/, '').trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) return NaN;
  return parseInt(s, 8);
}

function cstr(buf, off, len) {
  const b = buf.subarray(off, off + len);
  const z = b.indexOf(0);
  return (z === -1 ? b : b.subarray(0, z)).toString('utf8');
}

// pax records: "<len> <key>=<value>\n"
export function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(buf.toString('latin1', i, sp), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > buf.length) throw codeError('tar-corrupt');
    const rec = buf.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

// A tar reader that writes into dest (a new, empty folder) as the bytes arrive. write(chunk) takes the unpacked
// archive; end() checks it ended cleanly and returns { files, dirs, bytes, skipped, commit } (commit: the pax global
// header's comment, which git archive sets to the commit id). Every file is created new ('wx'): a second entry with the
// same name (a case-only difference on Windows) is skipped. Links, devices and other special entries are skipped.
// dirs: every folder the archive made, the ones made on the way to a file included (at most L.maxDirs).
// Errors (thrown with a code): tar-corrupt, tar-unsafe-path, too-large, too-many-files.
export function createTarExtractor(dest, { limits = REPO_LIMITS, strip = 1 } = {}) {
  const L = limits === REPO_LIMITS ? REPO_LIMITS : { ...REPO_LIMITS, ...limits };
  const root = path.resolve(dest);
  // mtime: the newest entry time in seconds (git archive stamps every entry with the commit's time)
  const st = { files: 0, dirs: 0, bytes: 0, skipped: 0, commit: null, mtime: null };

  // Makes a folder and the missing ones above it, each counted against maxDirs (too-many-files past it). Other errors
  // (a file where a folder should be) are thrown as they are: the entry is skipped.
  function makeDir(abs) {
    const made = fs.mkdirSync(abs, { recursive: true });
    if (!made) return;
    // Node answers the first folder it made, on Windows in the long form (\\?\C:\...)
    const first = path.resolve(String(made).replace(/^\\\\\?\\(?!UNC\\)/, ''));
    const rel = path.relative(first, abs);
    st.dirs += rel ? rel.split(path.sep).length + 1 : 1;
    if (st.dirs > L.maxDirs) throw codeError('too-many-files');
  }
  const limitError = (e) => e?.code === 'too-many-files';
  let buf = Buffer.alloc(0);
  let entry = null; // { kind: 'file'|'meta'|'skip', left, pad, fd?, meta?: Buffer[], metaKind }
  let paxNext = {};
  let longName = null;
  let zeros = 0;
  let ended = false;

  const inside = (rel) => {
    const abs = path.resolve(root, ...rel.split('/'));
    if (!abs.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw codeError('tar-unsafe-path');
    return abs;
  };

  function header(h) {
    if (h.every((b) => b === 0)) {
      zeros++;
      return;
    }
    if (zeros) throw codeError('tar-corrupt'); // data after the end marker
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    const want = octal(h, 148, 8);
    if (!Number.isFinite(want) || want !== sum) throw codeError('tar-corrupt');
    const mt = octal(h, 136, 12);
    if (Number.isFinite(mt) && mt > (st.mtime || 0)) st.mtime = mt;
    const type = String.fromCharCode(h[156]);
    let size = octal(h, 124, 12);
    if (Number.isNaN(size)) throw codeError('tar-corrupt');
    const magic = h.toString('latin1', 257, 262);
    const prefix = magic === 'ustar' ? cstr(h, 345, 155) : '';
    let name = cstr(h, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const pad = (512 - (Number.isFinite(size) ? size % 512 : 0)) % 512;
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      if (size > L.maxMetaBytes) throw codeError('tar-corrupt');
      entry = { kind: 'meta', metaKind: type, left: size, pad, meta: [] };
      return;
    }
    if (paxNext.path) name = paxNext.path;
    else if (longName !== null) name = longName;
    if (paxNext.size !== undefined) {
      // A plain decimal number only ('1e3', ' 10', '0x0a' are not sizes), within the safe integer range
      const n = /^[0-9]{1,16}$/.test(paxNext.size) ? Number(paxNext.size) : NaN;
      if (!Number.isSafeInteger(n) || n < 0) throw codeError('tar-corrupt');
      size = n;
    }
    paxNext = {};
    longName = null;
    const padded = (512 - (size % 512)) % 512;
    if (TYPE_FILE.has(type)) {
      if (size > L.maxEntryBytes) throw codeError('too-large');
      const rel = tarEntryPath(name, { strip, limits: L });
      if (rel === null) {
        st.skipped++;
        entry = { kind: 'skip', left: size, pad: padded };
        return;
      }
      if (++st.files > L.maxFiles) throw codeError('too-many-files');
      const abs = inside(rel);
      let fd = null;
      try {
        makeDir(path.dirname(abs));
        fd = fs.openSync(abs, 'wx');
      } catch (e) {
        if (limitError(e)) throw e;
        st.skipped++;
        st.files--;
      }
      entry = { kind: fd === null ? 'skip' : 'file', left: size, pad: padded, fd };
      if (fd !== null && size === 0) closeEntry();
      return;
    }
    if (type === '5') {
      const rel = tarEntryPath(name, { strip, limits: L });
      if (rel !== null) {
        const abs = inside(rel);
        try {
          makeDir(abs);
        } catch (e) {
          if (limitError(e)) throw e;
          st.skipped++;
        }
      }
      entry = { kind: 'skip', left: size, pad: padded };
      return;
    }
    // Hard and symbolic links, devices, FIFOs, sparse files and anything else: the path is still checked, the entry
    // is skipped
    tarEntryPath(name, { strip, limits: L });
    st.skipped++;
    entry = { kind: 'skip', left: Number.isFinite(size) ? size : 0, pad: padded };
  }

  function closeEntry() {
    if (entry?.fd !== undefined && entry.fd !== null) {
      try {
        fs.closeSync(entry.fd);
      } catch {
        /* closed */
      }
      entry.fd = null;
    }
  }

  function finishMeta() {
    const data = Buffer.concat(entry.meta);
    if (entry.metaKind === 'x') paxNext = parsePax(data);
    else if (entry.metaKind === 'g') {
      const g = parsePax(data);
      if (typeof g.comment === 'string' && FULL_SHA_RE.test(g.comment.trim())) st.commit = g.comment.trim();
    } else if (entry.metaKind === 'L') longName = data.toString('utf8').replace(/\0+$/, '');
  }

  function write(chunk) {
    if (ended) throw codeError('tar-corrupt');
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (!entry) {
        if (buf.length < 512) return;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        header(h);
        continue;
      }
      if (entry.left > 0) {
        if (!buf.length) return;
        const n = Math.min(entry.left, buf.length);
        const part = buf.subarray(0, n);
        buf = buf.subarray(n);
        entry.left -= n;
        if (entry.kind === 'file') {
          st.bytes += n;
          if (st.bytes > L.maxBytes) {
            closeEntry();
            throw codeError('too-large');
          }
          fs.writeSync(entry.fd, part);
        } else if (entry.kind === 'meta') entry.meta.push(Buffer.from(part));
        if (entry.left > 0) return;
      }
      if (entry.kind === 'file') closeEntry();
      if (entry.kind === 'meta' && !entry.done) {
        entry.done = true;
        finishMeta();
      }
      if (entry.pad > 0) {
        if (!buf.length) return;
        const n = Math.min(entry.pad, buf.length);
        buf = buf.subarray(n);
        entry.pad -= n;
        if (entry.pad > 0) return;
      }
      entry = null;
    }
  }

  function end() {
    ended = true;
    closeEntry();
    // A clean archive ends between entries with at least one zero block; anything else was cut off
    if (entry || !zeros) throw codeError('tar-corrupt');
    return { ...st };
  }

  function abort() {
    ended = true;
    closeEntry();
  }

  return { write, end, abort, stats: st };
}

// Unpacks a gzip-compressed tar stream into dest (created, must not exist). maxCompressed: bytes read from the
// stream at most. Resolves to the extractor's end() result; rejects with a code (the partial folder is the caller's to
// delete).
export function extractTarGz(input, dest, { limits = REPO_LIMITS, timeoutMs = TIMEOUTS.downloadMs } = {}) {
  const L = limits === REPO_LIMITS ? REPO_LIMITS : { ...REPO_LIMITS, ...limits };
  return new Promise((resolve, reject) => {
    let settled = false;
    let tar;
    try {
      fs.mkdirSync(dest);
      tar = createTarExtractor(dest, { limits: L });
    } catch (e) {
      return reject(codeError(e?.code === 'EEXIST' ? 'exists' : 'fetch-failed'));
    }
    const gunzip = zlib.createGunzip();
    let compressed = 0;
    let unpacked = 0;
    const fail = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tar.abort();
      try {
        input.destroy?.();
      } catch {
        /* gone */
      }
      gunzip.destroy();
      reject(codeError(code));
    };
    const timer = setTimeout(() => fail('timeout'), timeoutMs);
    input.on('data', (c) => {
      compressed += c.length;
      if (compressed > L.maxArchiveBytes) fail('too-large');
    });
    input.on('error', () => fail('network'));
    gunzip.on('data', (c) => {
      if (settled) return;
      unpacked += c.length;
      // The archive's own blocks (headers, padding) come on top of the file bytes
      if (unpacked > L.maxBytes + 64 * 1024 * 1024) return fail('too-large');
      try {
        tar.write(c);
      } catch (e) {
        fail(typeof e?.code === 'string' ? e.code : 'tar-corrupt');
      }
    });
    gunzip.on('error', () => fail('tar-corrupt'));
    gunzip.on('end', () => {
      if (settled) return;
      try {
        const r = tar.end();
        settled = true;
        clearTimeout(timer);
        resolve(r);
      } catch (e) {
        fail(typeof e?.code === 'string' ? e.code : 'tar-corrupt');
      }
    });
    input.pipe(gunzip);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// HTTPS (GitHub hosts only)
// ---------------------------------------------------------------------------------------------------------------

// One request, no redirect followed: resolves { status, headers, stream }
function defaultRequest(url, { headers = {}, timeoutMs = TIMEOUTS.apiMs } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res }));
    req.on('timeout', () => req.destroy(codeError('timeout')));
    req.on('error', (e) => reject(e?.code === 'timeout' ? e : codeError('network')));
  });
}

// Reads a small answer body (at most max bytes)
function readSmall(stream, max = 4096) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    stream.on('data', (c) => {
      n += c.length;
      if (n <= max) parts.push(c);
      else {
        stream.destroy?.();
        reject(codeError('fetch-failed'));
      }
    });
    stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    stream.on('error', () => reject(codeError('network')));
  });
}

const drain = (res) => {
  try {
    res?.stream?.resume?.();
  } catch {
    /* gone */
  }
};

// ---------------------------------------------------------------------------------------------------------------
// The download service
// ---------------------------------------------------------------------------------------------------------------

// hubDir: the hub. spawn and request are injected (tests never start git or reach the network). gitExe: the git
// program (undefined: found with findGit; null: no git, the archive is used). env: the environment git is started
// with (its GIT_* values are dropped) and PATH is read from.
export function createGitHub({ hubDir, spawn = nodeSpawn, request = defaultRequest, env = process.env, gitExe, now = Date.now, limits = REPO_LIMITS, timeouts = TIMEOUTS } = {}) {
  const L = limits === REPO_LIMITS ? REPO_LIMITS : { ...REPO_LIMITS, ...limits };
  const T = timeouts === TIMEOUTS ? TIMEOUTS : { ...TIMEOUTS, ...timeouts };
  const root = () => path.join(hubDir, 'incoming');
  let gitFound;
  const git = () => {
    if (gitExe !== undefined) return gitExe;
    if (gitFound === undefined) gitFound = findGit({ env });
    return gitFound;
  };

  // The incoming folder, made when missing; refused when it (or the hub) is a link
  function ensureRoot() {
    const r = root();
    const st = lstat(r);
    if (st && !st.isDirectory()) throw codeError('reparse-point');
    if (!st) fs.mkdirSync(r, { recursive: true });
    if (!isRealDir(r)) throw codeError('reparse-point');
    return r;
  }

  // How a repository is downloaded: always the archive first ('tar'). fallbackOf: 'git' when git is here and the ref is
  // not a commit id (a shallow clone takes a branch or a tag), else null
  const methodOf = () => 'tar';
  const fallbackOf = (parsed) => (git() && !FULL_SHA_RE.test(parsed.ref || '') ? 'git' : null);

  // What a fetch would do, without any request (the Preview mode): repository, ref, folder, method, the fallback,
  // hosts, target
  function plan(parsed) {
    const fallback = fallbackOf(parsed);
    return { repo: parsed.name, ref: parsed.ref, path: parsed.path, method: methodOf(parsed), fallback, hosts: ['api.github.com', 'codeload.github.com', ...(fallback ? ['github.com'] : [])], target: `incoming/${fetchIdHead(parsed.owner, parsed.repo)}@\u2026` };
  }

  async function gitRun(args, timeoutMs, extra = {}) {
    const cwd = ensureRoot();
    const e = gitEnv(env, path.dirname(cwd));
    return runGit(spawn, git(), args, gitSpawnOptions({ cwd, env: e }), timeoutMs, { kill: (c) => killTree(spawn, c, { env }), killWaitMs: T.killWaitMs, ...extra });
  }
  const hooksPath = () => path.join(root(), '.sibersentez-no-hooks');

  // The whole-download limits as measureTree and sizeProblem take them; a code the page knows for each problem
  const treeLimits = { maxBytes: L.maxBytes, maxFiles: L.maxFiles, maxItemDirs: L.maxDirs, maxItemDepth: L.maxDepth };
  const treeProblem = (dir) => {
    const problem = sizeProblem(measureTree(dir, treeLimits), treeLimits);
    return problem ? (problem === 'too-many-folders' || problem === 'too-deep' ? 'too-many-files' : problem) : null;
  };

  // The fallback: a shallow clone. Its folder (git's own .git included: what is on the disk) is measured every watchMs
  // while git runs; past a limit, or past the time limit, the whole process tree is ended and the caller deletes the
  // folder. No partial clone (--filter=blob:limit): git would fetch the missing objects later, past every limit.
  async function viaGit(parsed, dest) {
    const r = await gitRun(cloneArgs({ url: parsed.cloneUrl, ref: parsed.ref, dest, hooksPath: hooksPath() }), T.cloneMs, { watch: { everyMs: T.watchMs, check: () => treeProblem(dest) } });
    if (r.code !== 0) throw codeError(gitFailure(r.stderr));
    const rev = await gitRun([...gitConfigArgs(hooksPath()), '-C', dest, 'rev-parse', 'HEAD'], T.lsRemoteMs);
    const commit = rev.stdout.trim().toLowerCase();
    if (rev.code !== 0 || !FULL_SHA_RE.test(commit)) throw codeError('git-failed');
    // The commit's time, for "last updated" (not needed: a failure leaves it unknown)
    const when = await gitRun([...gitConfigArgs(hooksPath()), '-C', dest, 'show', '-s', '--format=%ct', 'HEAD'], T.lsRemoteMs);
    const committedAt = when.code === 0 ? commitTime(Number(String(when.stdout || '').trim()), now()) : null;
    // The download is a tree of files: git's own folder goes
    fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    const problem = treeProblem(dest);
    if (problem) throw codeError(problem);
    return { commit, method: 'git', committedAt };
  }

  // The commit a ref names, from the API (Accept: application/vnd.github.sha answers the id alone)
  async function apiCommit(parsed) {
    const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${encodeRef(parsed.ref || 'HEAD')}`;
    const res = await open(url, { Accept: 'application/vnd.github.sha' }, T.apiMs);
    if (res.status === 200) {
      const sha = (await readSmall(res.stream, 200)).trim().toLowerCase();
      if (!FULL_SHA_RE.test(sha)) throw codeError('fetch-failed');
      return sha;
    }
    drain(res);
    if (res.status === 404) throw codeError('not-public');
    if (res.status === 422) throw codeError('ref-not-found');
    if (res.status === 403 || res.status === 429) throw codeError('rate-limited');
    throw codeError('fetch-failed');
  }

  // A GET that follows at most MAX_REDIRECTS redirects, each to a GitHub host only
  async function open(url, headers, timeoutMs) {
    let cur = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!allowedUrl(cur)) throw codeError(hop ? 'redirect-refused' : 'not-github');
      let res;
      try {
        res = await request(cur, { headers: { 'User-Agent': USER_AGENT, ...headers }, timeoutMs });
      } catch (e) {
        throw codeError(e?.code === 'timeout' ? 'timeout' : 'network');
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers?.location;
        drain(res);
        if (typeof loc !== 'string' || !loc) throw codeError('fetch-failed');
        try {
          cur = new URL(loc, cur).href;
        } catch {
          throw codeError('redirect-refused');
        }
        continue;
      }
      return res;
    }
    throw codeError('redirect-refused');
  }

  async function viaTar(parsed, dest) {
    let sha = FULL_SHA_RE.test(parsed.ref || '') ? parsed.ref.toLowerCase() : null;
    if (!sha) {
      try {
        sha = await apiCommit(parsed);
      } catch (e) {
        // Without the API (its hourly limit) the archive of the ref itself is read; its header names the commit
        if (e.code !== 'rate-limited') throw e;
      }
    }
    const res = await open(`https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${encodeRef(sha || parsed.ref || 'HEAD')}`, {}, T.downloadMs);
    if (res.status !== 200) {
      drain(res);
      throw codeError(res.status === 404 ? (sha || !parsed.ref ? 'not-public' : 'ref-not-found') : 'fetch-failed');
    }
    const out = await extractTarGz(res.stream, dest, { limits: L, timeoutMs: T.downloadMs });
    const commit = sha || out.commit;
    if (!commit || !FULL_SHA_RE.test(commit)) throw codeError('fetch-failed');
    // The unpacked tree is measured again, by the same rules as a git download
    const problem = treeProblem(dest);
    if (problem) throw codeError(problem);
    return { commit, method: 'tar', committedAt: commitTime(out.mtime, now()) };
  }

  // The latest commit of a repository's ref (HEAD: the default branch), read with git ls-remote or the API; a ref that
  // is a commit id is its own answer
  async function latestCommit(parsed) {
    if (FULL_SHA_RE.test(parsed.ref || '')) return parsed.ref.toLowerCase();
    if (git()) {
      const r = await gitRun(lsRemoteArgs({ url: parsed.cloneUrl, ref: parsed.ref, hooksPath: hooksPath() }), T.lsRemoteMs);
      if (r.code !== 0) throw codeError(gitFailure(r.stderr));
      const sha = parseLsRemote(r.stdout, parsed.ref);
      if (!sha) throw codeError(parsed.ref ? 'ref-not-found' : 'not-public');
      return sha;
    }
    return apiCommit(parsed);
  }

  // Deletes a partial download; a folder that cannot be deleted now (a file still held) is left: cleanupIncoming takes
  // a stale .tmp- folder an hour later. Never throws, so the failure being handled keeps its own code.
  const dropTmp = (tmp) => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* swept later */
    }
  };

  // A download of the repository into incoming/<id>/ (live mode only): the archive, and git only when the archive path
  // fails (TAR_FALLBACK) and git is here. known: a commit already known to be the ref's latest (the update check): an
  // earlier download of that commit is used again. Resolves { id, dir, commit, method, reused }; rejects with a code,
  // leaving nothing behind (or a .tmp- folder that could not be deleted yet).
  async function fetchRepo(parsed, { known = null } = {}) {
    const r = ensureRoot();
    cleanupIncoming(hubDir, { now: now() });
    if (known) {
      const id = fetchIdOf(parsed.owner, parsed.repo, known);
      const hit = dirOf(id);
      if (hit && hit.marker.commit === known && hit.marker.repo === parsed.name) return { id, dir: hit.dir, commit: known, method: hit.marker.method, committedAt: commitTime(Date.parse(hit.marker.committedAt) / 1000, now()), reused: true };
    }
    const tmp = path.join(r, `.tmp-${crypto.randomBytes(6).toString('hex')}`);
    try {
      let got;
      try {
        got = await viaTar(parsed, tmp);
      } catch (e) {
        if (!fallbackOf(parsed) || !TAR_FALLBACK.has(e?.code)) throw e;
        dropTmp(tmp);
        try {
          got = await viaGit(parsed, tmp);
        } catch (g) {
          // A git that cannot run says nothing about the repository: the archive's failure is the answer
          throw g?.code === 'git-failed' || g?.code === 'git-missing' ? e : g;
        }
      }
      const id = fetchIdOf(parsed.owner, parsed.repo, got.commit);
      const dir = path.join(r, id);
      removeDownload(r, id);
      fs.renameSync(tmp, dir);
      const committedAt = got.committedAt || null;
      writeJsonAtomic(path.join(r, `${id}.json`), { sibersentez: 'incoming', version: 1, id, repo: parsed.name, ref: parsed.ref, commit: got.commit, method: got.method, committedAt, fetchedAt: new Date(now()).toISOString() });
      return { id, dir, commit: got.commit, method: got.method, committedAt, reused: false };
    } catch (e) {
      dropTmp(tmp);
      throw typeof e?.code === 'string' && /^[a-z][a-z-]*$/.test(e.code) ? e : codeError('fetch-failed');
    }
  }

  // An existing download by id: { dir, marker } or null (malformed id, missing, a link, no valid marker)
  function dirOf(id) {
    if (typeof id !== 'string' || !FETCH_ID_RE.test(id)) return null;
    const dir = path.join(root(), id);
    if (!isRealDir(dir) || !isRealDir(root())) return null;
    const marker = readMarker(path.join(root(), `${id}.json`));
    if (!marker || marker.id !== id) return null;
    return { dir, marker };
  }

  // Deletes a download and its marker (live mode). Returns true when there was one.
  function discard(id) {
    if (typeof id !== 'string' || !FETCH_ID_RE.test(id) || !isRealDir(root())) return false;
    return removeDownload(root(), id);
  }

  return { plan, methodOf, fetch: fetchRepo, latestCommit, dirOf, discard, git, root };
}

// ---------------------------------------------------------------------------------------------------------------
// The incoming folder: markers, removal, cleanup
// ---------------------------------------------------------------------------------------------------------------

export function readMarker(file) {
  const st = lstat(file);
  if (!st || !st.isFile() || st.size > 64 * 1024) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!m || m.sibersentez !== 'incoming' || m.version !== 1 || typeof m.id !== 'string' || !FETCH_ID_RE.test(m.id)) return null;
    if (typeof m.commit !== 'string' || !FULL_SHA_RE.test(m.commit) || typeof m.repo !== 'string') return null;
    return m;
  } catch {
    return null;
  }
}

// Removes incoming/<id>/ and incoming/<id>.json; a link with that name is left alone. true when something went.
function removeDownload(r, id) {
  let removed = false;
  for (const p of [path.join(r, id), path.join(r, `${id}.json`)]) {
    const st = lstat(p);
    if (!st || st.isSymbolicLink()) continue;
    fs.rmSync(p, { recursive: true, force: true });
    removed = true;
  }
  return removed;
}

// Removes downloads older than maxAgeMs (by the marker's fetchedAt, else the folder's modification time) and
// leftover .tmp- folders older than TMP_MAX_AGE_MS, directly under <hub>/incoming. Only entries named like ours, only
// real folders and files; links and anything else are left alone. Never on a missing hub. Returns { removed, kept }.
export function cleanupIncoming(hubDir, { now = Date.now(), maxAgeMs = INCOMING_MAX_AGE_MS } = {}) {
  const out = { removed: 0, kept: 0 };
  if (typeof hubDir !== 'string' || !hubDir) return out;
  const r = path.join(hubDir, 'incoming');
  if (!isRealDir(r)) return out;
  let ents = [];
  try {
    ents = fs.readdirSync(r, { withFileTypes: true });
  } catch {
    return out;
  }
  const gone = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      out.removed++;
    } catch {
      out.kept++;
    }
  };
  for (const d of ents) {
    const p = path.join(r, d.name);
    const st = lstat(p);
    if (!st || st.isSymbolicLink()) {
      out.kept++;
      continue;
    }
    if (TMP_RE.test(d.name) && st.isDirectory()) {
      if (now - st.mtimeMs > TMP_MAX_AGE_MS) gone(p);
      else out.kept++;
      continue;
    }
    const id = d.name.endsWith('.json') ? d.name.slice(0, -5) : d.name;
    if (!FETCH_ID_RE.test(id)) {
      out.kept++;
      continue;
    }
    const marker = readMarker(path.join(r, `${id}.json`));
    const at = marker ? Date.parse(marker.fetchedAt) : NaN;
    const age = now - (Number.isFinite(at) ? at : st.mtimeMs);
    if (age > maxAgeMs) gone(p);
    else out.kept++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// What a download holds: items with their review, license, fit and status
// ---------------------------------------------------------------------------------------------------------------

// Pre-selected in the result table: safe (ok, not caution), new in the library, no problem, and a good or very good
// fit for at least one project
export function defaultSelected(it) {
  return !!it && it.review?.level === 'ok' && it.status === 'new' && !(it.problems || []).length && Array.isArray(it.fits) && it.fits.length > 0;
}

// Can the person tick it at all: no problem, not the same as the library copy, not a danger
export function selectable(it) {
  return !!it && it.review?.level !== 'danger' && !(it.problems || []).length && it.status !== 'same';
}

// The items of a download. repoDir: the download; sub: a folder of it the link named (or null). library: the hub
// library (listLibrary). kit: the SiberSentez kit (kit.mjs readKit). roster: the catalog's roster (items other projects
// hold). projectsFor(items): the fit service's projectsFor. Returns { ok, items, truncated, license, counts } or
// { ok: false, status, error }.
export function describeDownload({ hubDir, repoDir, sub = null, library = null, kit = null, roster = null, projectsFor = () => [], limits = LIMITS }) {
  const scanRoot = sub ? path.join(repoDir, ...sub.split('/')) : repoDir;
  if (!isRealDir(scanRoot) || !withinReal(scanRoot, repoDir)) return { ok: false, status: 404, error: 'path-not-found' };
  const lib = library || listLibrary(hubDir);
  const scan = scanDir(scanRoot, { hubDir, library: lib, limits });
  const repoLic = repoLicense(repoDir);
  const pub = publicScanItems(scan.items);
  const items = scan.items.map((it, i) => {
    const rel = sub ? (it.path === '.' ? sub : `${sub}/${it.path}`) : it.path;
    const review = reviewItem(it._abs);
    const license = itemLicense(it._abs, repoLic);
    const k = kit ? findKitItem(kit, it.kind, it.name) : null;
    const kitStatus = k ? (!it.problems.length && sameHash(treeHash(it._abs, { links: 'skip', limits, vendored: 'skip' }), treeHash(k.path, { links: 'skip', limits, vendored: 'skip' })) ? 'same' : 'different') : null;
    const key = `${it.kind}:${it.name}`.toLowerCase();
    const r = roster instanceof Map ? roster.get(key) : null;
    const inProjects = r && (r.sources || [r.source]).includes('project') ? [...(r.installedIn || [])] : [];
    return { ...pub[i], path: rel, review: { level: review.level, reasons: review.reasons }, license, kit: kitStatus, inProjects };
  });
  const fits = projectsFor(items.map(({ kind, name, description, category }) => ({ kind, name, description, category })));
  for (let i = 0; i < items.length; i++) {
    items[i].fits = Array.isArray(fits[i]) ? fits[i] : [];
    items[i].selectable = selectable(items[i]);
    items[i].selected = defaultSelected(items[i]);
  }
  const counts = { total: items.length, ok: 0, caution: 0, danger: 0, fitting: 0, selected: 0 };
  for (const it of items) {
    counts[it.review.level]++;
    if (it.fits.length) counts.fitting++;
    if (it.selected) counts.selected++;
  }
  return { ok: true, items, truncated: scan.truncated, license: repoLic, counts };
}

// The import plan of picks from a download (github-import): each pick is scanned by itself (a skill folder, or the
// agents folder of an agent file), then planned by library.mjs planImport with the same rules as a local import; an
// item whose review is a danger is never imported (skip: review-danger). Returns planImport's result; copy and update
// entries carry _review and _license.
export function planDownloadImport({ hubDir, repoDir, picks, limits = LIMITS }) {
  const library = listLibrary(hubDir);
  const repoLic = repoLicense(repoDir);
  const items = [];
  for (const pick of picks) {
    const rel = normRel(pick.path);
    if (!rel) continue;
    const abs = rel === '.' ? repoDir : path.join(repoDir, ...rel.split('/'));
    const st = lstat(abs);
    if (!st || st.isSymbolicLink() || !withinReal(abs, repoDir)) continue;
    let scan = null;
    let want = null;
    if (st.isDirectory()) {
      scan = scanDir(abs, { hubDir, library, limits });
      want = '.';
    } else if (st.isFile() && /\.md$/i.test(abs) && path.basename(path.dirname(abs)).toLowerCase() === 'agents') {
      scan = scanDir(path.dirname(abs), { hubDir, library, limits });
      want = path.basename(abs);
    }
    const it = scan?.items.find((x) => x.path === want);
    if (it) items.push({ ...it, path: rel });
  }
  const p = planImport({ hubDir, picks, limits, scan: { ok: true, source: repoDir, items, truncated: false } });
  if (!p.ok) return p;
  for (const e of p.plan) {
    if ((e.op !== 'copy' && e.op !== 'update') || !e._src) continue;
    const review = reviewItem(e._src);
    e._review = review;
    e._license = itemLicense(e._src, repoLic);
    if (review.level === 'danger') {
      e.op = 'skip';
      e.reason = 'review-danger';
    }
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Provenance: <hub>/registry/sources.json
// ---------------------------------------------------------------------------------------------------------------

function sourcesFile(hubDir) {
  return path.join(hubDir, 'registry', 'sources.json');
}

const validRow = (r) => !!r && typeof r === 'object' && (r.kind === 'skill' || r.kind === 'agent') && typeof r.name === 'string' && r.name && r.source && typeof r.source === 'object' && r.source.type === 'github' && typeof r.source.repo === 'string';
const rowKey = (kind, name) => `${kind}:${name}`.toLowerCase();

// { ok, rows (every row as read), sources (the usable ones) }; a missing file is empty, a broken one ok: false (a
// writer then refuses, so a broken file is never replaced by a shorter one)
export function readSources(hubDir) {
  const none = (ok) => ({ ok, rows: [], sources: [] });
  if (typeof hubDir !== 'string' || !hubDir) return none(true);
  let text;
  try {
    text = fs.readFileSync(sourcesFile(hubDir), 'utf8');
  } catch (e) {
    return none(e?.code === 'ENOENT');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return none(false);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.sources)) return none(false);
  return { ok: true, rows: data.sources.slice(), sources: data.sources.filter(validRow) };
}

// The provenance row of a library item, or null
export function findSource(list, kind, name) {
  const k = rowKey(kind, name);
  return (list || []).find((r) => validRow(r) && rowKey(r.kind, r.name) === k) || null;
}

// Adds or replaces rows by kind and name (rows it cannot use are kept); removes the rows of `forget` ([{ kind, name
// }]). Written atomically. Throws with record-broken when the file cannot be read.
export function updateSources(hubDir, { add = [], forget = [] } = {}) {
  const cur = readSources(hubDir);
  if (!cur.ok) throw codeError('record-broken');
  let rows = cur.rows;
  const drop = new Set([...forget, ...add].map((x) => rowKey(x.kind, x.name)));
  rows = rows.filter((r) => !(validRow(r) && drop.has(rowKey(r.kind, r.name))));
  rows.push(...add);
  if (!add.length && rows.length === cur.rows.length) return false;
  writeJsonAtomic(sourcesFile(hubDir), { version: 1, sources: rows });
  return true;
}

// The row of an item imported from a download: where it came from, its license and review, the hash of the library
// copy (so an update check can tell a copy changed by hand)
export function sourceRow({ entry, marker, hash, now = Date.now }) {
  const lic = entry._license || { spdx: null, family: 'none' };
  return {
    kind: entry.kind,
    name: entry.name,
    category: entry.category,
    hash,
    importedAt: new Date(now()).toISOString(),
    source: {
      type: 'github',
      repo: marker.repo,
      ref: marker.ref ?? null,
      commit: marker.commit,
      path: entry.from,
      license: { spdx: lic.spdx ?? null, family: lic.family || 'none' },
      fetchedAt: marker.fetchedAt,
      review: { level: entry._review?.level || 'ok', reasons: (entry._review?.reasons || []).map((r) => r.code) },
    },
  };
}

// What the roster shows of a provenance row (no path, no hash): { type, repo, ref, commit (7 hex digits), license
// (an SPDX id or null), family, importedAt (only when the row has a real date) }
export function originOf(row) {
  if (!validRow(row)) return null;
  const s = row.source;
  const commit = typeof s.commit === 'string' && FULL_SHA_RE.test(s.commit) ? s.commit.slice(0, 7) : null;
  const spdx = typeof s.license?.spdx === 'string' ? s.license.spdx.slice(0, 40) : null;
  const origin = { type: 'github', repo: String(s.repo).slice(0, 142), ref: typeof s.ref === 'string' ? s.ref.slice(0, 200) : null, commit, license: spdx, family: typeof s.license?.family === 'string' ? s.license.family : 'none' };
  // When the item was brought (the drawer shows its day); only a real date, as an ISO text
  const at = typeof row.importedAt === 'string' ? Date.parse(row.importedAt) : NaN;
  if (Number.isFinite(at)) origin.importedAt = new Date(at).toISOString();
  return origin;
}

// ---------------------------------------------------------------------------------------------------------------
// Update check: what changed between the library copy and a newer download of its repository
// ---------------------------------------------------------------------------------------------------------------

// Files of an item (a folder, or one file) with their SHA-256: Map(rel -> hash). Links are skipped, and so are the
// vendored folders (.git, node_modules): an import never copies them, so they are no change to apply.
function fileHashes(p, limit = 2000) {
  const out = new Map();
  const st = lstat(p);
  if (!st || st.isSymbolicLink()) return out;
  const hashFile = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if (st.isFile()) {
    out.set(path.basename(p), hashFile(p));
    return out;
  }
  const walk = (dir, rel) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (out.size >= limit) return;
      const abs = path.join(dir, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (!isVendoredDir(d.name)) walk(abs, r);
      }
      else if (d.isFile()) out.set(r, hashFile(abs));
    }
  };
  walk(p, '');
  return out;
}

// The files that differ: [{ file, change: added|removed|modified }] in byte order. An agent file is compared by
// content whatever its name.
export function diffItems(libPath, newPath) {
  const a = fileHashes(libPath);
  const b = fileHashes(newPath);
  const single = lstat(libPath)?.isFile() && lstat(newPath)?.isFile();
  if (single) {
    const [x] = a.values();
    const [y] = b.values();
    return x === y ? [] : [{ file: path.basename(newPath), change: 'modified' }];
  }
  const out = [];
  for (const [f, h] of b) {
    if (!a.has(f)) out.push({ file: f, change: 'added' });
    else if (a.get(f) !== h) out.push({ file: f, change: 'modified' });
  }
  for (const f of a.keys()) if (!b.has(f)) out.push({ file: f, change: 'removed' });
  return out.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
}
