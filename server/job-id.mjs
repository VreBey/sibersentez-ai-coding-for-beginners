// App-issued identities bind a launched job to its plan, tasks and review. No user paths enter an id.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const JOB_ID_RE = /^J[0-9a-f]{32}$/;
export const CURRENT_JOB_FILE = 'current-job.json';
export const newJobId = () => `J${crypto.randomBytes(16).toString('hex')}`;
export const validJobId = (id) => typeof id === 'string' && JOB_ID_RE.test(id);
// The AI tool an app job was started with (a tool id of server/tools.mjs), kept in the marker: a Claude session is
// never offered to continue a job another tool started (docs/development-plan-2026-10-07.md F1)
const TOOL_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const jobMessageName = (id) => {
  if (!validJobId(id)) throw new Error('invalid job id');
  return `job-${id}.md`;
};

// The value of a "Job-ID:" metadata line, or null when the line is not one. Models often write metadata as
// **Job-ID:** J…, `J…` or as a list item; the marks are not part of the id.
export function jobIdLine(line) {
  const m = /^ {0,3}(?:[-*+][ \t]+)?(?:\*\*|__)?Job-ID:(?:\*\*|__)?[ \t]*(.*)$/i.exec(line);
  return m ? m[1].replace(/`+|\*\*|__/g, '').trim() : null;
}

// Ignore fenced examples. Metadata is before the first level-two heading in plans and task lists.
export function documentJobId(text) {
  let fence = null;
  const ids = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    if (/^ {0,3}#{2,6}[ \t]/.test(line)) break;
    const id = jobIdLine(line);
    if (id !== null) ids.push(id);
  }
  return ids.length === 1 && validJobId(ids[0]) ? ids[0] : null;
}

// A missing marker is legacy data. A present but unreadable/invalid marker must never fall back to old files.
// problem (when present without a usable id): 'not-file' (a link, a folder, too large: never touched), 'busy' (the
// file could not be read just now, e.g. EBUSY/EPERM on Windows: try again), 'unknown' (a small plain file whose
// contents are not the app's marker: set aside and replaced by the next job, setAsideCurrentJob).
const MARKER_MAX = 4096;
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EAGAIN']);
export function readCurrentJob(folder, xfs = fs) {
  const file = path.join(folder, CURRENT_JOB_FILE);
  let st;
  try {
    st = xfs.lstatSync(file);
  } catch (e) {
    if (e?.code === 'ENOENT') return { present: false, jobId: null };
    // Only a passing lock is worth another try; anything else (ENOTDIR, ELOOP, a lasting EACCES) is not a marker
    return { present: true, jobId: null, problem: BUSY_CODES.has(e?.code) ? 'busy' : 'not-file' };
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size > MARKER_MAX) return { present: true, jobId: null, problem: 'not-file' };
  let raw;
  try {
    raw = xfs.readFileSync(file, 'utf8');
  } catch {
    return { present: true, jobId: null, problem: 'busy' };
  }
  try {
    const data = JSON.parse(raw);
    if (data?.version === 1 && validJobId(data.jobId)) return { present: true, jobId: data.jobId, ...(TOOL_RE.test(data.tool || '') ? { tool: data.tool } : {}) };
  } catch { /* not JSON: unknown below */ }
  return { present: true, jobId: null, problem: 'unknown' };
}

// Moves an unknown marker (a small plain file only) to current-job.json.bak-<random> so a new job can start; the
// contents are kept for the person, never deleted. Returns true when the marker is out of the way.
export function setAsideCurrentJob(folder, xfs = fs) {
  if (readCurrentJob(folder, xfs).problem !== 'unknown') return false;
  try {
    xfs.renameSync(path.join(folder, CURRENT_JOB_FILE), path.join(folder, `${CURRENT_JOB_FILE}.bak-${crypto.randomBytes(4).toString('hex')}`));
    return !readCurrentJob(folder, xfs).present;
  } catch {
    return false;
  }
}

// The error a start reports for a marker that is present but unusable (null when it is fine or can be set aside)
export function markerError(current) {
  if (!current?.present || current.jobId || current.problem === 'unknown') return null;
  return current.problem === 'busy' ? 'job-marker-busy' : 'job-marker-unknown';
}

// Replace only the app's own valid marker, atomically. Links/directories/unknown contents are never overwritten.
// tool: the AI tool the job starts with (kept when it is a tool id; a job written outside the app has none)
export function writeCurrentJob(folder, jobId, xfs = fs, { tool = null } = {}) {
  if (!validJobId(jobId)) return { ok: false, error: 'first-message-blocked' };
  const realFolder = () => {
    try { const st = xfs.lstatSync(folder); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
  };
  if (!realFolder()) return { ok: false, error: 'first-message-blocked' };
  const before = readCurrentJob(folder, xfs);
  if (before.present && !before.jobId) {
    const err = markerError(before);
    if (err) return { ok: false, error: err };
    // It could not be moved just now (a lock on Windows, or another program wrote it meanwhile): try again
    if (!setAsideCurrentJob(folder, xfs)) return { ok: false, error: 'job-marker-busy' };
  }
  const temp = path.join(folder, `.current-${jobId}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  let created = false;
  try {
    xfs.writeFileSync(temp, JSON.stringify({ version: 1, jobId, ...(TOOL_RE.test(tool || '') ? { tool } : {}) }) + '\n', { encoding: 'utf8', flag: 'wx' });
    created = true;
    const current = readCurrentJob(folder, xfs);
    if (!realFolder()) return { ok: false, error: 'first-message-blocked' };
    if (current.present && !current.jobId) return { ok: false, error: markerError(current) || 'job-marker-unknown' };
    xfs.renameSync(temp, path.join(folder, CURRENT_JOB_FILE));
    return { ok: true };
  } catch {
    return { ok: false, error: 'first-message-failed' };
  } finally {
    if (created && realFolder()) { try { xfs.unlinkSync(temp); } catch { /* renamed or already removed */ } }
  }
}

// The job as the person wrote it, from the job's own message (<project>/.sibersentez/job-<id>.md, launch.mjs
// jobMessageText: the quoted lines under "## The job"): its first line, at most 120 characters, or null. A session the
// app started for a job is then named by the job, not by the tool's title for "read .sibersentez/job-J….md" (seen when
// using the app, 2026-10-08: "Job J764b5cd98f2fd06dfaf205c587fb8833 görevi"). Only a real small file is read.
const JOB_TEXT_MAX_BYTES = 64 * 1024;
export function readJobText(projectDir, jobId, xfs = fs) {
  if (typeof projectDir !== 'string' || !projectDir || !validJobId(jobId)) return null;
  const file = path.join(projectDir, '.sibersentez', jobMessageName(jobId));
  try {
    const st = xfs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > JOB_TEXT_MAX_BYTES) return null;
    const lines = xfs.readFileSync(file, 'utf8').split(/\r?\n/);
    const from = lines.findIndex((l) => /^##\s+The job\s*$/.test(l));
    if (from < 0) return null;
    for (const l of lines.slice(from + 1)) {
      if (/^##\s/.test(l)) break;
      const text = /^>\s?(.*)$/.exec(l)?.[1]?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) return Array.from(text).slice(0, 120).join('');
    }
  } catch {
    /* not there, or not readable now */
  }
  return null;
}
