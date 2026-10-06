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
import { redact } from './util.mjs';
import { validJobId } from './job-id.mjs';

export const RESTORE_DIR = 'restore';
export const RESTORE_LIMITS = Object.freeze({ files: 3000, bytes: 50 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, depth: 16 });
// Points kept per project (newest first); the point a restore goes back to and the one it takes are never pruned by it
export const RESTORE_KEEP = 5;
// A project over the limits (a game with art, a folder of logs) still gets a point: a lean one, which leaves out the
// files an AI tool does not write (over LEAN.fileBytes, or logs) and says how many. Left out is never touched by going
// back, as a skipped folder: the point of a lean scope is planned and backed up with the same scope.
export const LEAN = Object.freeze({ fileBytes: 2 * 1024 * 1024, skipExt: Object.freeze(new Set(['.log'])), files: 6000, bytes: 150 * 1024 * 1024 });
// The limits a scope scans with: a lean point may hold more small files than a full one
export const limitsFor = (scope, limits) => (scope === 'lean' ? { ...limits, files: Math.max(limits.files, LEAN.files), bytes: Math.max(limits.bytes, LEAN.bytes) } : limits);
export const RESTORE_SCOPES = Object.freeze(['full', 'lean']);
const OVER = new Set(['too-many-files', 'too-large', 'file-too-large']);
// Folders never copied, at any depth: package caches, version control and virtual environments
export const RESTORE_SKIP = Object.freeze(new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', '.godot']));
// A game engine's project inside the folder (a Unity project in a subfolder, as many are): its regenerated folders are
// left out wherever it sits, as RESTORE_SKIP_TOP leaves them out at the top. A folder is a Unity project when it holds
// both Assets and ProjectSettings.
export const UNITY_SKIP = Object.freeze(new Set(['library', 'temp', 'logs', 'obj', 'usersettings', 'build', 'builds']));
// Folders never copied at the project's top only: build output, the AI tools' own set-up and Unity's generated
// folders (a folder of the same name deeper down, say assets/out, is the person's content and is kept)
export const RESTORE_SKIP_TOP = Object.freeze(new Set(['.claude', '.agents', 'dist', 'build', 'builds', 'out', 'coverage', 'obj', 'bin', 'target', '.gradle', 'library', 'temp', 'logs', 'usersettings']));
export const POINT_ID_RE = /^R\d{14}[0-9a-f]{4}$/;
export const POINT_REASONS = Object.freeze(['ai-start', 'before-restore', 'manual']);
// The longest job text a point keeps as its label
export const LABEL_MAX = 80;
const MANIFEST = 'manifest.json';
const MANIFEST_MAX = 4 * 1024 * 1024;
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
export function skippedRel(rel) {
  const parts = String(rel).toLowerCase().split('/').slice(0, -1);
  return parts.some((p) => RESTORE_SKIP.has(p)) || (parts.length > 0 && RESTORE_SKIP_TOP.has(parts[0]));
}

// The project's files that a point holds (pure apart from reading the disk). Links and junctions are never followed
// (a link is neither copied nor entered), the skipped folders are left out, and names come in byte order. Returns
// { ok: true, files: [{ rel, size, mtimeMs }], bytes } or { ok: false, problem: 'too-many-files' | 'too-large' |
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
        files.push({ rel: childRel, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
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
    if (m?.version !== 1 || !POINT_ID_RE.test(m.id) || !Array.isArray(m.files)) return null;
    if (m.scope !== undefined && !RESTORE_SCOPES.includes(m.scope)) return null;
    if (!m.files.every((f) => f && safeRel(f.rel) && !skippedRel(f.rel) && Number.isInteger(f.size) && f.size >= 0 && hasDigest(f))) return null;
    return m;
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
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs }), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, path.join(base, JOB_POINTS_FILE));
    return true;
  } catch (e) {
    // A file held just now (an antivirus, a read at the same moment): said in the log, the start goes on
    console.error('start record not written:', e?.code || 'error');
    fs.rmSync(tmp, { force: true });
    return false;
  }
}

const sameFiles = (a, b) => a.length === b.length && a.every((f, i) => f.rel === b[i].rel && f.size === b[i].size && f.mtimeMs === b[i].mtimeMs);

const stampOf = (at) => {
  const d = new Date(at);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

// Keep the newest RESTORE_KEEP points; protect: ids never removed here
function prune(base, protect = []) {
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
  if (latest && reuse) {
    const m = readManifest(path.join(base, latest.id));
    if (m && (m.scope || 'full') === scan.scope && sameFiles(m.files, scan.files)) return { answer: { ok: true, id: latest.id, reused: true, files: scan.files.length, bytes: scan.bytes, scope: scan.scope, leftOut: scan.leftOut } };
  }
  const at = now();
  let stamp = stampOf(at);
  if (latest && stamp <= latest.id.slice(1, 15)) stamp = stampOf(Date.UTC(+latest.id.slice(1, 5), +latest.id.slice(5, 7) - 1, +latest.id.slice(7, 9), +latest.id.slice(9, 11), +latest.id.slice(11, 13), +latest.id.slice(13, 15)) + 1000);
  const id = `R${stamp}${crypto.randomBytes(2).toString('hex')}`;
  const tmp = path.join(base, `${id}.tmp-${crypto.randomBytes(4).toString('hex')}`);
  return { scan, base, id, tmp, at };
}

// label: the job the point was taken for (its first words, one line), so the list says what going back undoes
// Secrets typed into a job (a key, a password) are masked before the label reaches the disk (review 2026-10-02); cut
// on whole characters so an emoji is never split
const pointLabel = (label) => (typeof label === 'string' ? Array.from(redact(label).replace(/\s+/g, ' ').trim()).slice(0, LABEL_MAX).join('') : '');
const manifestOf = ({ scan, id, at }, projectId, reason, files, label) => ({ version: 1, id, projectId, at, reason: POINT_REASONS.includes(reason) ? reason : 'manual', files, ...(pointLabel(label) ? { label: pointLabel(label) } : {}), ...(scan.scope === 'lean' ? { scope: 'lean', leftOut: scan.leftOut } : {}) });
// Read once: the copy and its digest are the same bytes, even if the file changes meanwhile
const copied = (f, buf) => ({ rel: f.rel, size: buf.length, mtimeMs: f.size === buf.length ? f.mtimeMs : 0, sha256: digestOf(buf) });
const pointAnswer = ({ scan, id }, files) => ({ ok: true, id, reused: false, files: files.length, bytes: files.reduce((n, x) => n + x.size, 0), scope: scan.scope, leftOut: scan.leftOut });

// Take a point of the project's files. When nothing changed since the newest point (same paths, sizes and times),
// that point is answered again (reused: true) instead of a second copy, unless reuse is false (a restore's point of the
// present is always new). The id grows: a clock that went back, or two points in one second, still sort in the order
// they were taken. Over the full limits a lean point is taken (§7); scope forces one. Returns { ok: true, id, reused,
// files, bytes, scope, leftOut } or { ok: false, problem }.
export function createPoint({ hubDir, projectId, dir, reason = 'manual', now = Date.now, limits = RESTORE_LIMITS, protect = [], reuse = true, scope = null, label = '' }) {
  const p = preparePoint({ hubDir, projectId, dir, now, limits, reuse, scope });
  if (p.answer) return p.answer;
  const files = [];
  try {
    fs.mkdirSync(path.join(p.tmp, 'files'), { recursive: true });
    for (const f of p.scan.files) {
      const buf = fs.readFileSync(path.join(dir, ...f.rel.split('/')));
      const dest = path.join(p.tmp, 'files', ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      files.push(copied(f, buf));
    }
    fs.writeFileSync(path.join(p.tmp, MANIFEST), JSON.stringify(manifestOf(p, projectId, reason, files, label)));
    fs.renameSync(p.tmp, path.join(p.base, p.id));
  } catch {
    fs.rmSync(p.tmp, { recursive: true, force: true });
    return fail('copy-failed');
  }
  prune(p.base, [p.id, ...protect]);
  return pointAnswer(p, files);
}

// The same point, copied without holding the server: a big project's first point takes seconds (a Unity game: about
// 3,000 files and 100 MB, 9 s), and the live view and every other request keep moving meanwhile. Used by start-ai;
// going back stays synchronous (it must not interleave with another write).
export async function createPointAsync({ hubDir, projectId, dir, reason = 'manual', now = Date.now, limits = RESTORE_LIMITS, protect = [], reuse = true, scope = null, label = '' }) {
  const p = preparePoint({ hubDir, projectId, dir, now, limits, reuse, scope });
  if (p.answer) return p.answer;
  const files = [];
  try {
    await fs.promises.mkdir(path.join(p.tmp, 'files'), { recursive: true });
    for (const f of p.scan.files) {
      const buf = await fs.promises.readFile(path.join(dir, ...f.rel.split('/')));
      const dest = path.join(p.tmp, 'files', ...f.rel.split('/'));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, buf);
      files.push(copied(f, buf));
    }
    await fs.promises.writeFile(path.join(p.tmp, MANIFEST), JSON.stringify(manifestOf(p, projectId, reason, files, label)));
    await fs.promises.rename(p.tmp, path.join(p.base, p.id));
  } catch {
    await fs.promises.rm(p.tmp, { recursive: true, force: true });
    return fail('copy-failed');
  }
  prune(p.base, [p.id, ...protect]);
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

const key = (rel) => rel.toLowerCase(); // Windows names ignore case
const readRel = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')));

// The digest of a plan: the preview hands it to the page, the apply refuses a plan that differs (plan-changed), so
// going back never does more than the person was shown
export function planDigest(plan) {
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
  const scan = scanProject(dir, limitsFor(scope, limits), [hubDir], scope);
  if (!scan.ok) return scan;
  const now = new Map(scan.files.map((f) => [key(f.rel), f]));
  const inPoint = new Set();
  const changed = [];
  const missing = [];
  for (const f of pt.manifest.files) {
    inPoint.add(key(f.rel));
    const cur = now.get(key(f.rel));
    if (!cur) {
      missing.push(f.rel);
      continue;
    }
    let same = false;
    try {
      same = cur.rel === f.rel && cur.size === f.size && sameBytes(readRel(dir, cur.rel), f);
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

// The file as it is now is held by the point of the present (same bytes), or it is not there: only then may it be
// removed or overwritten
function backedUp(dir, rel, kept) {
  const file = path.join(dir, ...rel.split('/'));
  const st = lstat(file);
  if (!st) return true;
  if (!st.isFile()) return false;
  const want = kept.get(key(rel));
  if (!want) return false;
  try {
    return want.rel === rel && sameBytes(fs.readFileSync(file), want);
  } catch {
    return false;
  }
}

// Go back to a point. In order: every copy the restore writes is read and checked against its digest first (a damaged
// point changes nothing: point-damaged); a point of the present is taken, always new (if it cannot be, nothing
// changes: backup-failed); files that came later are removed, then changed and missing files are written (removing
// first lets a file take the place of a folder and the other way round). A file is removed or overwritten only when
// the point of the present holds its current bytes (else not-backed-up), never through a link, and each write goes
// to a temporary file renamed into place. planId (optional): the preview's digest; a plan that changed since is
// refused (plan-changed). Returns { ok: true, before, restored, removed, failed: [{ rel, error }] } or
// { ok: false, problem }.
export function applyRestore({ hubDir, projectId, dir, id, planId = null, now = Date.now, limits = RESTORE_LIMITS }) {
  const plan = planRestore({ hubDir, projectId, dir, id, limits });
  if (!plan.ok) return plan;
  if (planId && planId !== plan.planId) return fail('plan-changed');
  if (!plan.changed.length && !plan.missing.length && !plan.added.length) return { ok: true, before: null, restored: 0, removed: 0, failed: [] };
  const pt = readPoint(hubDir, projectId, id);
  const byRel = new Map(pt.manifest.files.map((f) => [f.rel, f]));
  const writes = [];
  for (const rel of [...plan.changed, ...plan.missing]) {
    let buf;
    try {
      buf = readRel(path.join(pt.dir, 'files'), rel);
    } catch {
      return fail('point-damaged');
    }
    if (!sameBytes(buf, byRel.get(rel))) return fail('point-damaged');
    writes.push({ rel, buf });
  }
  const before = createPoint({ hubDir, projectId, dir, reason: 'before-restore', now, limits, protect: [id], reuse: false, scope: pt.manifest.scope === 'lean' ? 'lean' : 'full' });
  if (!before.ok) return fail('backup-failed');
  const kept = new Map((readPoint(hubDir, projectId, before.id)?.manifest.files || []).map((f) => [key(f.rel), f]));
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
      if (!backedUp(dir, rel, kept)) throw coded('not-backed-up');
      fs.rmSync(file);
      removed++;
      const parts = rel.split('/');
      for (let i = parts.length - 1; i > 0; i--) emptied.add(parts.slice(0, i).join('/'));
    } catch (e) {
      failed.push({ rel, error: codeOf(e, 'remove-failed') });
    }
  }
  // Deepest first; a folder that still holds anything stays (rmdirSync refuses it)
  for (const rel of [...emptied].sort((a, b) => b.split('/').length - a.split('/').length)) {
    const d = path.join(dir, ...rel.split('/'));
    const st = lstat(d);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) continue;
    try {
      fs.rmdirSync(d);
    } catch {
      /* not empty */
    }
  }
  let restored = 0;
  for (const { rel, buf } of writes) {
    const dest = path.join(dir, ...rel.split('/'));
    const tmp = `${dest}.sibersentez-${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      if (!safeParents(dir, rel)) throw coded('link-in-path');
      const st = lstat(dest);
      if (st && !st.isFile()) throw coded('not-a-file');
      if (!backedUp(dir, rel, kept)) throw coded('not-backed-up');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(tmp, buf, { flag: 'wx' });
      fs.renameSync(tmp, dest);
      restored++;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      failed.push({ rel, error: codeOf(e, 'write-failed') });
    }
  }
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
  // jobs: what each recent app job's start kept (recordJobPoint), so the job box says it after a reload too
  return { status: 200, body: { project: projectId, points, keep: RESTORE_KEEP, jobs: listJobPoints({ hubDir, projectId }) } };
}
