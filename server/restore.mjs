// Restore points (docs/restore.md, docs/direction.md §3.4 "see, try, undo"): before an AI tool starts in a project,
// SiberSentez keeps a copy of the project's files in the hub, and the person can put the project back to it with one
// click. It works with or without git: a point is a plain copy under <hub>/restore/<project key>/<point id>/ with a
// manifest (path, size, time and digest (SHA-256; SHA-1 in older points) of every file). Nothing here follows a link or a junction, reads outside the
// project folder or writes outside it and the hub; folders that tools regenerate (node_modules, .git, build output)
// are left out, and a project over the limits gets no point (the reason says why).
//
// The rule going back never breaks: a file of the project is removed or overwritten only when a point of the present,
// taken for this restore, holds the very same bytes (by digest). Anything else is left as it is and reported.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redact, normPath } from './util.mjs';
import { validJobId, readCurrentJob } from './job-id.mjs';
import { FIRST_DIR } from './launch.mjs';
import { isLocalPath, relKeyFor } from './fsutil.mjs';
import { PLATFORM } from './platform.mjs';
import { hasStreamColon } from './library.mjs';
import { writeFileAtomic } from './atomic.mjs';

const RESTORE_DIR = 'restore';
export const RESTORE_LIMITS = Object.freeze({ files: 3000, bytes: 50 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, depth: 16 });
// Points kept per project (newest first); the point a restore goes back to and the one it takes are never pruned by it
export const RESTORE_KEEP = 5;
// A project over the limits (a game with art, a folder of logs) still gets a point: a lean one, which leaves out the
// files an AI tool does not write (over LEAN.fileBytes, or logs) and says how many. Left out is never touched by going
// back, as a skipped folder: the point of a lean scope is planned and backed up with the same scope.
export const LEAN = Object.freeze({ fileBytes: 2 * 1024 * 1024, skipExt: Object.freeze(new Set(['.log'])), files: 6000, bytes: 150 * 1024 * 1024 });
// The limits a scope scans with: a lean point may hold more small files than a full one
const limitsFor = (scope, limits) => (scope === 'lean' ? { ...limits, files: Math.max(limits.files, LEAN.files), bytes: Math.max(limits.bytes, LEAN.bytes) } : limits);
const RESTORE_SCOPES = Object.freeze(['full', 'lean']);
const OVER = new Set(['too-many-files', 'too-large', 'file-too-large']);
// Folders never copied, at any depth: package caches, version control and virtual environments
const RESTORE_SKIP = Object.freeze(new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', '.godot']));
// A game engine's project inside the folder (a Unity project in a subfolder, as many are): its regenerated folders are
// left out wherever it sits, as RESTORE_SKIP_TOP leaves them out at the top. A folder is a Unity project when it holds
// both Assets and ProjectSettings.
const UNITY_SKIP = Object.freeze(new Set(['library', 'temp', 'logs', 'obj', 'usersettings', 'build', 'builds']));
// Folders never copied at the project's top only: build output, the AI tools' own set-up and Unity's generated
// folders (a folder of the same name deeper down, say assets/out, is the person's content and is kept). The other AI
// tools' folders too (2026-10-07): SiberSentez installs their agents there, and going back must not roll a record's
// copy back to an older text it would then take for the person's own
export const RESTORE_SKIP_TOP = Object.freeze(new Set(['.claude', '.agents', '.gemini', '.qwen', '.opencode', '.codex', 'dist', 'build', 'builds', 'out', 'coverage', 'obj', 'bin', 'target', '.gradle', 'library', 'temp', 'logs', 'usersettings']));
export const POINT_ID_RE = /^R\d{14}[0-9a-f]{4}$/;
const POINT_REASONS = Object.freeze(['ai-start', 'before-restore', 'manual']);
// The longest job text a point keeps as its label
export const LABEL_MAX = 80;
const MANIFEST = 'manifest.json';
const MANIFEST_MAX = 4 * 1024 * 1024;
// Manifest versions (review 2026-10 F02): 1 holds no permissions; 2 holds each file's Unix permissions (mode) on
// Linux and macOS. Both are read: a version 1 point is put back as before, a rewritten file keeping the permissions it
// has. Windows writes version 2 without modes (its files have no such bits).
const MANIFEST_VERSION = 2;
const MANIFEST_VERSIONS = new Set([1, MANIFEST_VERSION]);
// Read, write and run for owner, group and others only: set-user-id, set-group-id and sticky are never kept or set
const MODE_BITS = 0o777;
const validMode = (m) => m === undefined || (Number.isInteger(m) && m >= 0 && m <= MODE_BITS);
const KEEPS_MODES = !PLATFORM.windows;
// The hub's copies are the owner's only (a point holds .env files and keys): folders 0700, files 0600. A copy is
// data, never run from the hub; what it had in the project is in the manifest. A copy shared with an older point (a
// hard link, plan D6) is never chmodded: that would change the older point's file too.
const HUB_DIR_MODE = 0o700;
const HUB_FILE_MODE = 0o600;
const REL_MAX = 400;
// Names Windows keeps for devices, with or without an extension (CON, nul.txt, COM1, ...)
const DEVICE_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
// A file's digest: SHA-256 for every point taken from 2026-10-06 on. It tells changed bytes and a damaged copy apart
// on this computer; it is not a security boundary. Points taken before name their files by SHA-1 and are still read
// and checked (legacyDigest), so no point a person has becomes unusable.
const digestOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const legacyDigest = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const DIGEST_RE = /^[0-9a-f]{64}$/;
const LEGACY_DIGEST_RE = /^[0-9a-f]{40}$/;
const hasDigest = (f) => (typeof f.sha256 === 'string' ? DIGEST_RE.test(f.sha256) : LEGACY_DIGEST_RE.test(f.sha1));
const sameBytes = (buf, f) => (typeof f.sha256 === 'string' ? digestOf(buf) === f.sha256 : legacyDigest(buf) === f.sha1);
const fail = (problem) => ({ ok: false, problem });
const codeOf = (e, fallback) => (typeof e?.code === 'string' && /^[A-Za-z-]{1,40}$/.test(e.code) ? e.code : fallback);
const coded = (code) => Object.assign(new Error(code), { code });

// The folder of a project's points: a digest of its id (an id may hold dots, which Windows strips at a name's end)
export function projectKey(projectId) {
  return crypto.createHash('sha256').update(String(projectId)).digest('hex').slice(0, 24);
}
export function pointsDir(hubDir, projectId) {
  return path.join(hubDir, RESTORE_DIR, projectKey(projectId));
}

// A relative path from a manifest: forward slashes, no empty, '.' or '..' part, no drive, colon, control character or
// device name, no part ending in a dot or a space (Windows would drop it and name another file)
export function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > REL_MAX) return false;
  if (/[\u0000-\u001f\u007f:\\*?"<>|]/.test(rel) || rel.startsWith('/')) return false;
  return rel.split('/').every((part) => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !DEVICE_RE.test(part));
}

// A path in one of the folders a point leaves out (a manifest written by hand could name one)
function skippedRel(rel) {
  const parts = String(rel).toLowerCase().split('/').slice(0, -1);
  return parts.some((p) => RESTORE_SKIP.has(p)) || (parts.length > 0 && RESTORE_SKIP_TOP.has(parts[0]));
}

// The project's files that a point holds (pure apart from reading the disk). Links and junctions are never followed
// (a link is neither copied nor entered), the skipped folders are left out, and names come in byte order. Returns
// { ok: true, files: [{ rel, size, mtimeMs, mode (Linux and macOS) }], bytes } or { ok: false, problem: 'too-many-files' | 'too-large' |
// 'file-too-large' | 'too-deep' | 'folder-missing' }. skip: absolute folders never entered (the hub, when it lies
// inside the project, so a point never copies the points).
export function scanProject(dir, limits = RESTORE_LIMITS, skip = [], scope = 'full') {
  const lean = scope === 'lean';
  const skipped = new Set(skip.filter(Boolean).map((p) => path.resolve(p).toLowerCase()));
  const top = lstat(dir);
  if (!top || !top.isDirectory()) return fail('folder-missing');
  const files = [];
  let bytes = 0;
  let leftOut = 0;
  let leftBytes = 0;
  const walk = (abs, rel, depth) => {
    if (depth > limits.depth) return 'too-deep';
    let list;
    try {
      list = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return null; // an unreadable folder is left out (going back never removes what a point does not hold)
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const names = new Set(list.filter((d) => d.isDirectory()).map((d) => d.name.toLowerCase()));
    const unity = names.has('assets') && names.has('projectsettings');
    for (const d of list) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (!safeRel(childRel)) continue;
      const child = path.join(abs, d.name);
      const st = lstat(child);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        const low = d.name.toLowerCase();
        if (RESTORE_SKIP.has(low) || (depth === 0 && RESTORE_SKIP_TOP.has(low)) || (unity && UNITY_SKIP.has(low)) || skipped.has(path.resolve(child).toLowerCase())) continue;
        const p = walk(child, childRel, depth + 1);
        if (p) return p;
      } else if (st.isFile()) {
        if (lean && (st.size > LEAN.fileBytes || LEAN.skipExt.has(path.extname(d.name).toLowerCase()))) {
          leftOut++;
          leftBytes += st.size;
          continue;
        }
        if (st.size > limits.fileBytes) return 'file-too-large';
        bytes += st.size;
        files.push({ rel: childRel, size: st.size, mtimeMs: Math.floor(st.mtimeMs), ...(KEEPS_MODES ? { mode: st.mode & MODE_BITS } : {}) });
        if (files.length > limits.files) return 'too-many-files';
        if (bytes > limits.bytes) return 'too-large';
      }
    }
    return null;
  };
  const problem = walk(dir, '', 0);
  return problem ? fail(problem) : { ok: true, files, bytes, scope: lean ? 'lean' : 'full', leftOut, leftBytes };
}

function readManifest(pointDir) {
  const file = path.join(pointDir, MANIFEST);
  const st = lstat(file);
  if (!st || !st.isFile() || st.size > MANIFEST_MAX) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!MANIFEST_VERSIONS.has(m?.version) || !POINT_ID_RE.test(m.id) || !Array.isArray(m.files)) return null;
    if (m.scope !== undefined && !RESTORE_SCOPES.includes(m.scope)) return null;
    if (!m.files.every((f) => f && safeRel(f.rel) && Number.isInteger(f.size) && f.size >= 0 && hasDigest(f) && validMode(f.mode))) return null;
    // A file in a folder points leave out is never read back or written: such entries are dropped, not the point.
    // 0.17 leaves out more tools' folders (.gemini, .qwen, .opencode, .codex); a point taken before still names their
    // files and must stay listed and usable (review 2026-10-08: it vanished from the list after the update)
    const files = m.files.filter((f) => !skippedRel(f.rel));
    return files.length === m.files.length ? m : { ...m, files };
  } catch {
    return null;
  }
}

// A project's points, newest first: [{ id, at, reason, files, bytes }] (read from the hub only). Ids are made to
// grow (createPoint), so their byte order is their time order.
export function listPoints({ hubDir, projectId }) {
  const base = pointsDir(hubDir, projectId);
  let names = [];
  try {
    names = fs.readdirSync(base).filter((n) => POINT_ID_RE.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const id of names.sort().reverse()) {
    const pd = path.join(base, id);
    const st = lstat(pd);
    if (!st || !st.isDirectory()) continue;
    const m = readManifest(pd);
    if (!m || m.id !== id || m.projectId !== projectId) continue;
    out.push({ id, at: m.at, reason: POINT_REASONS.includes(m.reason) ? m.reason : 'manual', label: pointLabel(m.label), files: m.files.length, bytes: m.files.reduce((n, f) => n + f.size, 0), scope: m.scope || 'full', leftOut: Number.isInteger(m.leftOut) ? m.leftOut : 0 });
  }
  return out;
}

// What the start of each app job kept (docs/restore.md §8): the job's id, then the point (a new one, the newest one
// again, full or lean) or why none was kept. Kept in the hub next to the points (never in the project, where an AI
// writes), the newest JOB_POINTS_KEEP, so the job box still says it after a reload or in another window.
export const JOB_POINTS_FILE = 'start-points.json';
export const JOB_POINTS_KEEP = 20;
const JOB_POINTS_MAX = 64 * 1024;
const PROBLEM_RE = /^[a-z][a-z0-9-]{0,40}$/;

// One record, only known fields of known shapes (the file is read back into the page)
function jobPointRecord(r) {
  if (!r || typeof r !== 'object' || !validJobId(r.jobId) || !Number.isFinite(r.at)) return null;
  if (typeof r.problem === 'string') return PROBLEM_RE.test(r.problem) ? { jobId: r.jobId, at: r.at, problem: r.problem } : null;
  if (!POINT_ID_RE.test(r.id)) return null;
  const n = (x) => (Number.isInteger(x) && x >= 0 ? x : 0);
  return { jobId: r.jobId, at: r.at, id: r.id, reused: r.reused === true, scope: r.scope === 'lean' ? 'lean' : 'full', leftOut: n(r.leftOut), files: n(r.files), bytes: n(r.bytes) };
}

export function listJobPoints({ hubDir, projectId }) {
  if (!hubDir) return [];
  const file = path.join(pointsDir(hubDir, projectId), JOB_POINTS_FILE);
  const st = lstat(file);
  if (!st || !st.isFile() || st.size > JOB_POINTS_MAX) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (Array.isArray(data?.jobs) ? data.jobs : []).map(jobPointRecord).filter(Boolean).slice(0, JOB_POINTS_KEEP);
  } catch {
    return [];
  }
}

// point: takeStartPoint's answer ({ id, reused, scope, leftOut, files, bytes } or { problem }). Newest first, one record
// per job id (every app start gets a new one). Written whole, then renamed. Never throws:
// the start goes on without it.
export function recordJobPoint({ hubDir, projectId, jobId, point, now = Date.now }) {
  const rec = jobPointRecord({ ...(point || {}), jobId, at: now() });
  if (!hubDir || !rec) return false;
  const base = pointsDir(hubDir, projectId);
  const jobs = [rec, ...listJobPoints({ hubDir, projectId }).filter((r) => r.jobId !== jobId)].slice(0, JOB_POINTS_KEEP);
  const tmp = path.join(base, `.${JOB_POINTS_FILE}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.mkdirSync(base, { recursive: true });
    writeFileAtomic(path.join(base, JOB_POINTS_FILE), JSON.stringify({ version: 1, jobs }), { tmp });
    return true;
  } catch (e) {
    // A file still held after the retries (an antivirus, a read at the same moment): said in the log, the start goes on
    console.error('start record not written:', e?.code || 'error');
    return false;
  }
}

// The current job's start copy (its record, recordJobPoint): kept past RESTORE_KEEP while that job is the project's
// current one (its marker), so a long job, whose resumes take points too, never loses the copy its job box names
// (docs/development-plan-2026-10-07.md F2). One point at most; never throws.
function currentJobPoint(hubDir, projectId, dir) {
  try {
    const cur = readCurrentJob(path.join(dir, FIRST_DIR));
    if (!cur.jobId) return [];
    const rec = listJobPoints({ hubDir, projectId }).find((r) => r.jobId === cur.jobId && r.id);
    return rec ? [rec.id] : [];
  } catch {
    return [];
  }
}

// The same permissions too (review F02: chmod +x alone is a change a point must hold); a point without them (version 1)
// is not the present on Linux and macOS, so the next point is a new one that holds them
const sameFiles = (a, b) => a.length === b.length && a.every((f, i) => f.rel === b[i].rel && f.size === b[i].size && f.mtimeMs === b[i].mtimeMs && f.mode === b[i].mode);
// A file's permissions now against a point's: a point or a look without them (version 1, Windows) compares bytes only
const sameMode = (cur, f) => cur.mode === undefined || f.mode === undefined || cur.mode === f.mode;

const stampOf = (at) => {
  const d = new Date(at);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

// Keep the newest RESTORE_KEEP points; protect: ids never removed here
function prune(base, protect = []) {
  // A restore that stopped halfway keeps both its points: the way forward and the way back (RESTORE_MARK)
  let mark = null;
  try {
    mark = JSON.parse(fs.readFileSync(path.join(base, RESTORE_MARK), 'utf8'));
  } catch {
    mark = null;
  }
  for (const id of [mark?.to, mark?.before]) if (POINT_ID_RE.test(String(id))) protect = [...protect, id];
  let names = [];
  try {
    names = fs.readdirSync(base).sort().reverse();
  } catch {
    return;
  }
  let kept = 0;
  for (const n of names) {
    const p = path.join(base, n);
    if (!POINT_ID_RE.test(n)) {
      // An interrupted copy (<id>.tmp-...) is left over from a crash: removed
      if (/^R\d{14}[0-9a-f]{4}\.tmp-[0-9a-f]{8}$/.test(n)) fs.rmSync(p, { recursive: true, force: true });
      // The same for a start record that was being written (recordJobPoint)
      if (/^\.start-points\.json\.[0-9a-f]{8}\.tmp$/.test(n)) fs.rmSync(p, { force: true });
      // And for a restore mark that was being written
      if (/^\.restore-running\.json\.[0-9a-f]{8}\.tmp$/.test(n)) fs.rmSync(p, { force: true });
      continue;
    }
    if (kept < RESTORE_KEEP || protect.includes(n)) {
      kept++;
      continue;
    }
    fs.rmSync(p, { recursive: true, force: true });
  }
}

// What a new point needs before its copy: the scan, the folder and a growing id; or the answer itself (a problem, or
// the newest point when nothing changed). Shared by createPoint and createPointAsync.
function preparePoint({ hubDir, projectId, dir, now, limits, reuse, scope }) {
  if (!hubDir) return { answer: fail('no-hub') };
  let scan = scanProject(dir, limitsFor(scope, limits), [hubDir], scope === 'lean' ? 'lean' : 'full');
  if (!scan.ok && !scope && OVER.has(scan.problem)) scan = scanProject(dir, limitsFor('lean', limits), [hubDir], 'lean');
  if (!scan.ok) return { answer: scan };
  const base = pointsDir(hubDir, projectId);
  const latest = listPoints({ hubDir, projectId })[0];
  // The newest point may be answered again when nothing changed: the same paths, sizes and times make it a candidate
  // only; its files' bytes decide (review Z1: a file rewritten with its size and time kept is a change). The caller
  // checks them (sameContent, sync or async)
  let candidate = null;
  if (latest && reuse) {
    const m = readManifest(path.join(base, latest.id));
    if (m && (m.scope || 'full') === scan.scope && sameFiles(m.files, scan.files)) candidate = { id: latest.id, files: m.files, answer: { ok: true, id: latest.id, reused: true, files: scan.files.length, bytes: scan.bytes, scope: scan.scope, leftOut: scan.leftOut } };
  }
  const shared = latest ? sharedFrom(path.join(base, latest.id)) : null;
  const at = now();
  let stamp = stampOf(at);
  if (latest && stamp <= latest.id.slice(1, 15)) stamp = stampOf(Date.UTC(+latest.id.slice(1, 5), +latest.id.slice(5, 7) - 1, +latest.id.slice(7, 9), +latest.id.slice(9, 11), +latest.id.slice(11, 13), +latest.id.slice(13, 15)) + 1000);
  const id = `R${stamp}${crypto.randomBytes(2).toString('hex')}`;
  const tmp = path.join(base, `${id}.tmp-${crypto.randomBytes(4).toString('hex')}`);
  return { scan, base, id, tmp, at, candidate, shared };
}

// Files a new point shares with the newest one (plan D6): a file with the same path and digest is linked to that
// point's copy (a hard link) instead of written again, so five points of a project that changed a little take about
// one copy on disk. The older copy is linked only when its bytes are the new file's (review D: a copy damaged at the
// same size would otherwise spread to every newer point); a link that cannot be made (another drive, a file system
// without hard links, an older copy that differs) is a plain copy, as before, written to a new name only ('wx': a
// shared file is never opened for writing). A point's files are only ever read (going back writes the
// project from their bytes, never moves or links them out of the hub), so one file in two points is safe; removing a
// point removes its names, and a file goes when its last point does. Points before 2026-10-06 (SHA-1) share nothing.
function sharedFrom(pointDir) {
  const m = readManifest(pointDir);
  if (!m) return null;
  const byRel = new Map();
  for (const f of m.files) if (typeof f.sha256 === 'string') byRel.set(f.rel, { sha256: f.sha256, size: f.size });
  return byRel.size ? { dir: path.join(pointDir, 'files'), byRel } : null;
}
const sharedSource = (shared, rec) => {
  const old = shared?.byRel.get(rec.rel);
  return old && old.sha256 === rec.sha256 && old.size === rec.size ? path.join(shared.dir, ...rec.rel.split('/')) : null;
};
function linkShared(from, dest, buf) {
  try {
    const st = fs.lstatSync(from);
    if (!st.isFile() || st.size !== buf.length || !fs.readFileSync(from).equals(buf)) return false;
    fs.linkSync(from, dest);
    return true;
  } catch {
    return false;
  }
}
async function linkSharedAsync(from, dest, buf) {
  try {
    const st = await fs.promises.lstat(from);
    if (!st.isFile() || st.size !== buf.length || !(await fs.promises.readFile(from)).equals(buf)) return false;
    await fs.promises.link(from, dest);
    return true;
  } catch {
    return false;
  }
}

// What the project's points take on disk (plan D6): every file once however many points name it (a shared file is
// one file: same volume and file id), next to what the copies would take apart. Points never change once taken, so
// the answer is kept per set of points. A file system without file ids counts every name (no sharing claimed).
// Asynchronous (review D: a big project's five lean points are some 30,000 looks, about a second): the server keeps
// answering meanwhile, and two asks for the same set share one count.
const diskCache = new Map(); // points folder -> { key, disk: Promise }
export function pointsDisk({ hubDir, projectId, points }) {
  const base = pointsDir(hubDir, projectId);
  const key = points.map((x) => x.id).join(',');
  const kept = diskCache.get(base);
  if (kept && kept.key === key) return kept.disk;
  const disk = countDisk(base, points).catch(() => null);
  diskCache.set(base, { key, disk });
  return disk;
}
async function countDisk(base, points) {
  const seen = new Set();
  let bytes = 0;
  let apart = 0;
  for (const x of points) {
    const pd = path.join(base, x.id);
    const m = readManifest(pd);
    if (!m) continue;
    for (const f of m.files) {
      apart += f.size;
      let st = null;
      try {
        st = await fs.promises.lstat(path.join(pd, 'files', ...f.rel.split('/')), { bigint: true });
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const id = st.ino > 0n ? `${st.dev}:${st.ino}` : `${x.id}/${f.rel}`;
      if (seen.has(id)) continue;
      seen.add(id);
      bytes += Number(st.size);
    }
  }
  return { bytes, apart };
}

// Every file of a point holds the same bytes in the project now (its digest); false at the first that does not, or
// cannot be read
function sameContent(dir, files) {
  for (const f of files) {
    try {
      if (!sameBytes(readRel(dir, f.rel), f)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
async function sameContentAsync(dir, files) {
  for (const f of files) {
    try {
      if (!sameBytes(await fs.promises.readFile(path.join(dir, ...f.rel.split('/'))), f)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// label: the job the point was taken for (its first words, one line), so the list says what going back undoes
// Secrets typed into a job (a key, a password) are masked before the label reaches the disk (review 2026-10-02); cut
// on whole characters so an emoji is never split
const pointLabel = (label) => (typeof label === 'string' ? Array.from(redact(label).replace(/\s+/g, ' ').trim()).slice(0, LABEL_MAX).join('') : '');
const manifestOf = ({ scan, id, at }, projectId, reason, files, label) => ({ version: MANIFEST_VERSION, id, projectId, at, reason: POINT_REASONS.includes(reason) ? reason : 'manual', files, ...(pointLabel(label) ? { label: pointLabel(label) } : {}), ...(scan.scope === 'lean' ? { scope: 'lean', leftOut: scan.leftOut } : {}) });
// Read once: the copy and its digest are the same bytes, even if the file changes meanwhile
const copied = (f, buf) => ({ rel: f.rel, size: buf.length, mtimeMs: f.size === buf.length ? f.mtimeMs : 0, sha256: digestOf(buf), ...(f.mode !== undefined ? { mode: f.mode } : {}) });
// The project's points folder: the owner's only, also when an older version made it open to others (a folder, never
// a shared file). On Windows the modes mean nothing and are left alone.
function privateBase(base) {
  if (!KEEPS_MODES) return;
  try {
    fs.chmodSync(base, HUB_DIR_MODE);
  } catch {
    /* the point is still taken; the folder keeps what it had */
  }
}
const pointAnswer = ({ scan, id }, files) => ({ ok: true, id, reused: false, files: files.length, bytes: files.reduce((n, x) => n + x.size, 0), scope: scan.scope, leftOut: scan.leftOut });

// Take a point of the project's files. When nothing changed since the newest point (same paths, sizes and times pick
// it, every file's bytes against its digest decide: review Z1), that point is answered again (reused: true) instead
// of a second copy, unless reuse is false (a restore's point of the
// present is always new). The id grows: a clock that went back, or two points in one second, still sort in the order
// they were taken. Over the full limits a lean point is taken (§7); scope forces one. Returns { ok: true, id, reused,
// files, bytes, scope, leftOut } or { ok: false, problem }.
export function createPoint({ hubDir, projectId, dir, reason = 'manual', now = Date.now, limits = RESTORE_LIMITS, protect = [], reuse = true, scope = null, label = '' }) {
  const p = preparePoint({ hubDir, projectId, dir, now, limits, reuse, scope });
  if (p.answer) return p.answer;
  if (p.candidate && sameContent(dir, p.candidate.files)) return p.candidate.answer;
  const files = [];
  try {
    fs.mkdirSync(path.join(p.tmp, 'files'), { recursive: true, mode: HUB_DIR_MODE });
    privateBase(p.base);
    for (const f of p.scan.files) {
      const buf = fs.readFileSync(path.join(dir, ...f.rel.split('/')));
      const dest = path.join(p.tmp, 'files', ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: HUB_DIR_MODE });
      const rec = copied(f, buf);
      const from = sharedSource(p.shared, rec);
      if (!(from && linkShared(from, dest, buf))) fs.writeFileSync(dest, buf, { flag: 'wx', mode: HUB_FILE_MODE });
      files.push(rec);
    }
    fs.writeFileSync(path.join(p.tmp, MANIFEST), JSON.stringify(manifestOf(p, projectId, reason, files, label)), { mode: HUB_FILE_MODE });
    fs.renameSync(p.tmp, path.join(p.base, p.id));
  } catch {
    fs.rmSync(p.tmp, { recursive: true, force: true });
    return fail('copy-failed');
  }
  prune(p.base, [p.id, ...protect, ...currentJobPoint(hubDir, projectId, dir)]);
  return pointAnswer(p, files);
}

// The same point, copied without holding the server: a big project's first point takes seconds (a Unity game: about
// 3,000 files and 100 MB, 9 s), and the live view and every other request keep moving meanwhile. Used by start-ai
// and by going back (its point of the present); actions.mjs keeps the two from running in one project at once.
export async function createPointAsync({ hubDir, projectId, dir, reason = 'manual', now = Date.now, limits = RESTORE_LIMITS, protect = [], reuse = true, scope = null, label = '' }) {
  const p = preparePoint({ hubDir, projectId, dir, now, limits, reuse, scope });
  if (p.answer) return p.answer;
  if (p.candidate && (await sameContentAsync(dir, p.candidate.files))) return p.candidate.answer;
  const files = [];
  try {
    await fs.promises.mkdir(path.join(p.tmp, 'files'), { recursive: true, mode: HUB_DIR_MODE });
    privateBase(p.base);
    for (const f of p.scan.files) {
      const buf = await fs.promises.readFile(path.join(dir, ...f.rel.split('/')));
      const dest = path.join(p.tmp, 'files', ...f.rel.split('/'));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true, mode: HUB_DIR_MODE });
      const rec = copied(f, buf);
      const from = sharedSource(p.shared, rec);
      if (!(from && (await linkSharedAsync(from, dest, buf)))) await fs.promises.writeFile(dest, buf, { flag: 'wx', mode: HUB_FILE_MODE });
      files.push(rec);
    }
    await fs.promises.writeFile(path.join(p.tmp, MANIFEST), JSON.stringify(manifestOf(p, projectId, reason, files, label)), { mode: HUB_FILE_MODE });
    await fs.promises.rename(p.tmp, path.join(p.base, p.id));
  } catch {
    await fs.promises.rm(p.tmp, { recursive: true, force: true });
    return fail('copy-failed');
  }
  prune(p.base, [p.id, ...protect, ...currentJobPoint(hubDir, projectId, dir)]);
  return pointAnswer(p, files);
}

function readPoint(hubDir, projectId, id) {
  if (!POINT_ID_RE.test(String(id))) return null;
  const pd = path.join(pointsDir(hubDir, projectId), id);
  const st = lstat(pd);
  if (!st || !st.isDirectory()) return null;
  const m = readManifest(pd);
  return m && m.id === id && m.projectId === projectId ? { dir: pd, manifest: m } : null;
}

// The key of a project file in the maps below (review 2026-10 F03): its path as written where the project's file
// system tells README.md and readme.md apart (Linux), lower case where it does not (Windows, macOS by default).
// Asked of the project folder once per plan, restore or comparison (fsutil.mjs caselessAt).
const keyIn = (dir) => relKeyFor(dir);
// A map of a point's files by key, or null when two of them are one file to this file system (a manifest written by
// hand, or a point taken on a case-sensitive drive and gone back to on a caseless one): going back would write one
// over the other, so it is refused (point-ambiguous) rather than half applied
function fileMap(files, key) {
  const out = new Map();
  for (const f of files) {
    if (out.has(key(f.rel))) return null;
    out.set(key(f.rel), f);
  }
  return out;
}
const readRel = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')));

// The digest of a plan: the preview hands it to the page, the apply refuses a plan that differs (plan-changed), so
// going back never does more than the person was shown
function planDigest(plan) {
  return digestOf(JSON.stringify([plan.point?.id, plan.changed, plan.missing, plan.added])).slice(0, 16);
}

// What going back to a point would do (reads only). changed: files that differ now and are put back (the digest
// decides, a new time alone is no change); missing: files deleted since and brought back; added: files that came
// later and are removed. Returns { ok: true, point: { id, at, reason }, changed, missing, added, planId } or
// { ok: false, problem }.
export function planRestore({ hubDir, projectId, dir, id, limits = RESTORE_LIMITS }) {
  const pt = readPoint(hubDir, projectId, id);
  if (!pt) return fail('point-missing');
  // A lean point is compared with the project seen the same way: what it left out is neither added nor removed
  const scope = pt.manifest.scope === 'lean' ? 'lean' : 'full';
  const key = keyIn(dir);
  const inPoint = fileMap(pt.manifest.files, key);
  if (!inPoint) return fail('point-ambiguous');
  const scan = scanProject(dir, limitsFor(scope, limits), [hubDir], scope);
  if (!scan.ok) return scan;
  const now = new Map(scan.files.map((f) => [key(f.rel), f]));
  const changed = [];
  const missing = [];
  for (const f of pt.manifest.files) {
    const cur = now.get(key(f.rel));
    if (!cur) {
      missing.push(f.rel);
      continue;
    }
    // The bytes decide, and the permissions where the point holds them (review F02: chmod -x is a change)
    let same = false;
    try {
      same = cur.rel === f.rel && cur.size === f.size && sameMode(cur, f) && sameBytes(readRel(dir, cur.rel), f);
    } catch {
      same = false;
    }
    if (!same) changed.push(f.rel);
  }
  const added = scan.files.filter((f) => !inPoint.has(key(f.rel))).map((f) => f.rel);
  const { at, reason } = pt.manifest;
  const plan = { ok: true, point: { id, at, reason }, changed, missing, added };
  return { ...plan, planId: planDigest(plan) };
}

// Every folder between the project and the file is a real folder (no link or junction), or not there yet
function safeParents(dir, rel) {
  let cur = dir;
  for (const part of rel.split('/').slice(0, -1)) {
    cur = path.join(cur, part);
    const st = lstat(cur);
    if (!st) return true;
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return true;
}

// The mark of a restore under way (review A2): written once the point of the present is kept and before the first
// file is touched, removed when the last file is done. Left behind only when going back stopped halfway (the app
// closed, the computer went off): the restore list then says so, with the two ways out (finish going back, or return
// to the point kept just before it started). prune never removes the two points it names.
export const RESTORE_MARK = '.restore-running.json';
const markPath = (hubDir, projectId) => path.join(pointsDir(hubDir, projectId), RESTORE_MARK);
export function readRestoreMark({ hubDir, projectId }) {
  if (!hubDir) return null;
  let m;
  try {
    const p = markPath(hubDir, projectId);
    const st = lstat(p);
    if (!st || !st.isFile() || st.size > 4096) return null;
    m = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  if (!m || m.version !== 1 || !POINT_ID_RE.test(String(m.to)) || !POINT_ID_RE.test(String(m.before)) || !Number.isFinite(m.at)) return null;
  return { to: m.to, before: m.before, at: m.at };
}
async function writeRestoreMark(hubDir, projectId, mark) {
  const p = markPath(hubDir, projectId);
  const tmp = `${p}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, ...mark }), { flag: 'wx' });
    await fs.promises.rename(tmp, p);
    return true;
  } catch {
    await fs.promises.rm(tmp, { force: true });
    return false;
  }
}

// The mark goes; held by Windows for a moment, it is tried again by the next going back (the work itself is done)
async function clearRestoreMark(hubDir, projectId) {
  try {
    await fs.promises.rm(markPath(hubDir, projectId), { force: true, maxRetries: 3, retryDelay: 50 });
  } catch (e) {
    console.error('restore mark not removed:', e?.code || 'error');
  }
}

const readRelAsync = (dir, rel) => fs.promises.readFile(path.join(dir, ...rel.split('/')));
// backedUp, without holding the server
async function backedUpAsync(dir, rel, kept, key) {
  const file = path.join(dir, ...rel.split('/'));
  const st = lstat(file);
  if (!st) return true;
  if (!st.isFile()) return false;
  const want = kept.get(key(rel));
  if (!want) return false;
  try {
    return want.rel === rel && sameBytes(await fs.promises.readFile(file), want);
  } catch {
    return false;
  }
}

// Go back to a point. In order: every copy the restore writes is read and checked against its digest first (a damaged
// point changes nothing: point-damaged); a point of the present is taken, always new (if it cannot be, nothing
// changes: backup-failed); the restore's mark is written (if it cannot be, nothing changes: backup-failed); files that
// came later are removed, then changed and missing files are written (removing first lets a file take the place of a
// folder and the other way round); the mark is removed. A file is removed or overwritten only when the point of the
// present holds its current bytes (else not-backed-up), never through a link, and each write goes to a temporary file
// renamed into place. Asynchronous and one file at a time (review A2): the server keeps answering meanwhile, and only
// one file is held in memory (each copy is read again and checked again when it is written). The caller keeps an AI
// start out of the project until it is done (actions.mjs restoring). planId (optional): the preview's digest; a plan
// that changed since is refused (plan-changed). Returns { ok: true, before, restored, removed, failed: [{ rel, error }] }
// or { ok: false, problem }.
export async function applyRestore({ hubDir, projectId, dir, id, planId = null, now = Date.now, limits = RESTORE_LIMITS }) {
  const plan = planRestore({ hubDir, projectId, dir, id, limits });
  if (!plan.ok) return plan;
  if (planId && planId !== plan.planId) return fail('plan-changed');
  if (!plan.changed.length && !plan.missing.length && !plan.added.length) {
    // Nothing to change: the project already is this point. A restore cut off halfway that named it (its way forward or
    // its way back) is over then (review A2: the mark stayed for good when a cut came before the first file or after the
    // last one)
    const mark = readRestoreMark({ hubDir, projectId });
    if (mark && (mark.to === id || mark.before === id)) await clearRestoreMark(hubDir, projectId);
    return { ok: true, before: null, restored: 0, removed: 0, failed: [] };
  }
  const pt = readPoint(hubDir, projectId, id);
  const byRel = new Map(pt.manifest.files.map((f) => [f.rel, f]));
  const fromPoint = path.join(pt.dir, 'files');
  const writes = [...plan.changed, ...plan.missing];
  for (const rel of writes) {
    try {
      if (!sameBytes(await readRelAsync(fromPoint, rel), byRel.get(rel))) return fail('point-damaged');
    } catch {
      return fail('point-damaged');
    }
  }
  const before = await createPointAsync({ hubDir, projectId, dir, reason: 'before-restore', now, limits, protect: [id], reuse: false, scope: pt.manifest.scope === 'lean' ? 'lean' : 'full' });
  if (!before.ok) return fail('backup-failed');
  if (!(await writeRestoreMark(hubDir, projectId, { to: id, before: before.id, at: now() }))) return fail('backup-failed');
  const key = keyIn(dir);
  // The present's point, by the same key (two names that are one file here cannot both be in it; if a hand-made one
  // did, nothing would count as backed up, so nothing would be touched)
  const kept = fileMap(readPoint(hubDir, projectId, before.id)?.manifest.files || [], key) || new Map();
  const failed = [];
  let removed = 0;
  const emptied = new Set();
  for (const rel of plan.added) {
    try {
      if (!safeParents(dir, rel)) throw coded('link-in-path');
      const file = path.join(dir, ...rel.split('/'));
      const st = lstat(file);
      if (!st) continue;
      if (!st.isFile()) throw coded('not-a-file');
      if (!(await backedUpAsync(dir, rel, kept, key))) throw coded('not-backed-up');
      await fs.promises.rm(file);
      removed++;
      const parts = rel.split('/');
      for (let i = parts.length - 1; i > 0; i--) emptied.add(parts.slice(0, i).join('/'));
    } catch (e) {
      failed.push({ rel, error: codeOf(e, 'remove-failed') });
    }
  }
  // Deepest first; a folder that still holds anything stays (rmdir refuses it)
  for (const rel of [...emptied].sort((a, b) => b.split('/').length - a.split('/').length)) {
    const d = path.join(dir, ...rel.split('/'));
    const st = lstat(d);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) continue;
    try {
      await fs.promises.rmdir(d);
    } catch {
      /* not empty */
    }
  }
  let restored = 0;
  for (const rel of writes) {
    const dest = path.join(dir, ...rel.split('/'));
    const tmp = `${dest}.sibersentez-${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      // Checked again: the point was read before the present was kept, and only its digest is trusted
      const buf = await readRelAsync(fromPoint, rel);
      if (!sameBytes(buf, byRel.get(rel))) throw coded('point-damaged');
      if (!safeParents(dir, rel)) throw coded('link-in-path');
      const st = lstat(dest);
      if (st && !st.isFile()) throw coded('not-a-file');
      if (!(await backedUpAsync(dir, rel, kept, key))) throw coded('not-backed-up');
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      // Review F02: the permissions the point holds (a script runnable again, a .env private again); a point without
      // them (version 1) leaves a rewritten file the ones it has. The new file is the owner's only until it has them
      // (a private file is never readable by others on the way), and has them before it takes the name. Only the
      // project's file is changed, never a copy in the hub.
      const mode = KEEPS_MODES ? (byRel.get(rel).mode ?? (st ? st.mode & MODE_BITS : undefined)) : undefined;
      await fs.promises.writeFile(tmp, buf, { flag: 'wx', ...(mode !== undefined ? { mode: HUB_FILE_MODE } : {}) });
      if (mode !== undefined) await fs.promises.chmod(tmp, mode);
      await fs.promises.rename(tmp, dest);
      restored++;
    } catch (e) {
      await fs.promises.rm(tmp, { force: true });
      failed.push({ rel, error: codeOf(e, 'write-failed') });
    }
  }
  await clearRestoreMark(hubDir, projectId);
  return { ok: true, before: before.id, restored, removed, failed };
}

// GET /api/projects/<id>/restore (read-only, no action mode needed): the project's points, newest first, and what the
// recent jobs' starts kept. Only the
// hub is read; a project that is not listed answers 404.
export function projectRestore({ catalog, projectId }) {
  const p = catalog?.getProject?.(projectId) || null;
  if (!p) return { status: 404, body: { error: 'not-a-project' } };
  const hubDir = catalog.hubDir || null;
  const points = hubDir ? listPoints({ hubDir, projectId }) : [];
  // jobs: what each recent app job's start kept (recordJobPoint), so the job box says it after a reload too, and
  // whether that copy is still there now (available: among the points above); a record is history, not a promise
  const there = new Set(points.map((x) => x.id));
  const jobs = listJobPoints({ hubDir, projectId }).map((r) => (r.id ? { ...r, available: there.has(r.id) } : r));
  // interrupted: going back stopped halfway (RESTORE_MARK); each of its two points says whether it is still there
  const mark = readRestoreMark({ hubDir, projectId });
  const interrupted = mark ? { at: mark.at, to: mark.to, before: mark.before, toAvailable: there.has(mark.to), beforeAvailable: there.has(mark.before) } : null;
  return { status: 200, body: { project: projectId, points, keep: RESTORE_KEEP, jobs, interrupted } };
}

// The same answer with disk: what the points take on disk, shared files once, and what they would take apart (plan
// D6); counted without holding the server (GET /api/projects/<id>/restore)
export async function projectRestoreWithDisk({ catalog, projectId }) {
  const r = projectRestore({ catalog, projectId });
  const hubDir = catalog?.hubDir || null;
  if (r.status !== 200 || !hubDir || !r.body.points.length) return r;
  return { ...r, body: { ...r.body, disk: await pointsDisk({ hubDir, projectId, points: r.body.points }) } };
}

// GET /api/projects/<id>/job-changes?job=<Job-ID> (read-only, no action mode needed; docs/restore.md §9): what changed
// in the project since that job's start copy, so a result shows this job's changes and not the last 24 hours'. The
// basis says how far it holds:
//   start      compared with the job's start copy (files the person changed meanwhile are in it too: no file is
//              attributed to the AI for certain); a lean copy left big files and logs out (leftOut), never listed
//   no-record  the job has no start record (started outside the app, or before records were kept)
//   no-copy    no copy could be made at the start (problem)
//   gone       the copy is no longer kept (or its manifest cannot be read)
//   unreadable the project could not be read the way the copy was taken (problem)
// The team's own notes (.sibersentez/: plan, tasks, review) are counted apart (notes), not listed as the result.
// A file of the same size is read and its digest decides (the size and time only pick what to read, review Z1); a
// file that cannot be read now is unknown, never unchanged. Async: a file deleted after the look reads as unknown, and
// a restore running meanwhile can mix the answer (kept 10 s): both rare, both on the side of saying less.
export const JOB_CHANGES_MAX = 200;
// One comparison per project and job is kept JOB_CHANGES_TTL_MS: every open drawer asks again every 20 s, and a big
// project's comparison reads files (the review measured about 0.4 s on 821 files). A request while one runs waits
// for that one.
const JOB_CHANGES_TTL_MS = 10000;
export function createJobChangesCache({ ttl = JOB_CHANGES_TTL_MS, now = Date.now, run = projectJobChanges } = {}) {
  const cache = new Map();
  return (args) => {
    const k = `${args.projectId}|${args.jobId}`;
    const e = cache.get(k);
    if (e && (e.pending || now() - e.at < ttl)) return e.promise;
    const entry = { at: now(), pending: true, promise: null };
    entry.promise = Promise.resolve()
      .then(() => run(args))
      .then((answer) => {
        // Only answers worth keeping are kept (a refused request is answered again at once)
        if (answer.status === 200) Object.assign(entry, { at: now(), pending: false });
        else if (cache.get(k) === entry) cache.delete(k);
        return answer;
      }, (err) => {
        if (cache.get(k) === entry) cache.delete(k);
        throw err;
      });
    cache.delete(k);
    if (cache.size >= 64) cache.delete(cache.keys().next().value);
    cache.set(k, entry);
    return entry.promise;
  };
}
// The bytes of a project file against a copy's digest: true (the same), false (changed) or null (cannot be read now)
async function bytesMatch(dir, f, readFile = fs.promises.readFile) {
  try {
    return sameBytes(await readFile(path.join(dir, ...f.rel.split('/'))), f);
  } catch {
    return null;
  }
}
// A file of the copy this look did not find: deleted; still there with the same bytes (a folder this look skips
// now): unchanged; else changed (grown past the copy's limits), or unknown when it cannot be read
async function stillThere(dir, f) {
  const st = lstat(path.join(dir, ...f.rel.split('/')));
  if (!st || !st.isFile()) return 'deleted';
  if (st.size !== f.size) return 'changed';
  const same = await bytesMatch(dir, f);
  return same === true ? null : same === false ? 'changed' : 'unknown';
}
// Made before at (with a second's slack); unknown when the file system keeps no birth time
function bornBefore(dir, rel, at) {
  const st = lstat(path.join(dir, ...rel.split('/')));
  return !!st && Number.isFinite(at) && st.birthtimeMs > 0 && st.birthtimeMs < at - 1000;
}
// readFile: how a file's bytes are read (a test makes one unreadable)
export async function projectJobChanges({ catalog, projectId, jobId, limits = RESTORE_LIMITS, max = JOB_CHANGES_MAX, readFile = fs.promises.readFile }) {
  const p = catalog?.getProject?.(projectId) || null;
  if (!p) return { status: 404, body: { error: 'not-a-project' } };
  if (!validJobId(jobId)) return { status: 400, body: { error: 'bad-job' } };
  const hubDir = catalog.hubDir || null;
  const body = { project: projectId, jobId };
  const rec = hubDir ? listJobPoints({ hubDir, projectId }).find((r) => r.jobId === jobId) : null;
  if (!rec) return { status: 200, body: { ...body, basis: 'no-record' } };
  if (rec.problem) return { status: 200, body: { ...body, basis: 'no-copy', problem: rec.problem } };
  const pt = readPoint(hubDir, projectId, rec.id);
  if (!pt) return { status: 200, body: { ...body, basis: 'gone' } };
  const dir = typeof p.path === 'string' ? p.path : '';
  const broad = typeof catalog.isBroad === 'function' && !!catalog.isBroad(normPath(dir));
  if (!dir || p.broad || p.tmpOnly || broad || !isLocalPath(dir) || hasStreamColon(dir)) return { status: 200, body: { ...body, basis: 'unreadable', problem: 'folder' } };
  const scope = pt.manifest.scope === 'lean' ? 'lean' : 'full';
  const scan = scanProject(dir, limitsFor(scope, limits), [hubDir], scope);
  if (!scan.ok) return { status: 200, body: { ...body, basis: 'unreadable', problem: scan.problem } };
  const isNote = (rel) => rel.toLowerCase().startsWith(`${FIRST_DIR}/`);
  const leftOut = Number.isInteger(pt.manifest.leftOut) ? pt.manifest.leftOut : 0;
  const key = keyIn(dir);
  const now = new Map(scan.files.map((f) => [key(f.rel), f]));
  const inCopy = new Set();
  const changed = [];
  const deleted = [];
  // Files whose bytes could not be read now (locked, no access): neither changed nor unchanged, said apart
  const unknown = [];
  let notes = 0;
  // The same size is no proof of the same content, nor is the same time (review Z1): a file of the same size is
  // read and its digest decides. Read without holding the server (one file after the other)
  for (const f of pt.manifest.files) {
    inCopy.add(key(f.rel));
    const cur = now.get(key(f.rel));
    let kind = null;
    // Not in this look at the project: gone, or still there but now past what a copy of this scope takes (a lean
    // copy's size limits): that file changed, it was not deleted
    if (!cur) kind = await stillThere(dir, f);
    else if (cur.rel !== f.rel || cur.size !== f.size) kind = 'changed';
    else {
      const same = await bytesMatch(dir, f, readFile);
      kind = same === true ? null : same === false ? 'changed' : 'unknown';
    }
    if (!kind) continue;
    if (isNote(f.rel)) notes++;
    else (kind === 'deleted' ? deleted : kind === 'unknown' ? unknown : changed).push(f.rel);
  }
  const added = [];
  for (const f of scan.files) {
    if (inCopy.has(key(f.rel))) continue;
    if (isNote(f.rel)) notes++;
    // A lean copy that left files out: one not in it but made before the job started was left out then, changed since
    // (a copy that left nothing out: a file not in it is new)
    // (the job's own start: its record's time; a reused copy may be days older)
    else if (leftOut > 0 && bornBefore(dir, f.rel, rec.at)) changed.push(f.rel);
    else added.push(f.rel);
  }
  // The counts are the whole lists' (the names shown are cut at max)
  const counts = { changed: changed.length, added: added.length, deleted: deleted.length, unknown: unknown.length };
  const total = counts.changed + counts.added + counts.deleted;
  const cut = (list) => list.sort().slice(0, max);
  return {
    status: 200,
    body: { ...body, basis: 'start', at: pt.manifest.at, scope, leftOut, changed: cut(changed), added: cut(added), deleted: cut(deleted), unknown: cut(unknown), counts, total, more: [changed, added, deleted, unknown].some((l) => l.length > max), notes },
  };
}
