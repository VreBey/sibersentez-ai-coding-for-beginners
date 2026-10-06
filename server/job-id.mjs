// App-issued identities bind a launched job to its plan, tasks and review. No user paths enter an id.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const JOB_ID_RE = /^J[0-9a-f]{32}$/;
export const CURRENT_JOB_FILE = 'current-job.json';
export const newJobId = () => `J${crypto.randomBytes(16).toString('hex')}`;
export const validJobId = (id) => typeof id === 'string' && JOB_ID_RE.test(id);
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
export function readCurrentJob(folder, xfs = fs) {
  const file = path.join(folder, CURRENT_JOB_FILE);
  try {
    const st = xfs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) return { present: true, jobId: null };
    const data = JSON.parse(xfs.readFileSync(file, 'utf8'));
    return { present: true, jobId: data?.version === 1 && validJobId(data.jobId) ? data.jobId : null };
  } catch (e) {
    return { present: e?.code !== 'ENOENT', jobId: null };
  }
}

// Replace only the app's own valid marker, atomically. Links/directories/unknown contents are never overwritten.
export function writeCurrentJob(folder, jobId, xfs = fs) {
  if (!validJobId(jobId)) return { ok: false, error: 'first-message-blocked' };
  const realFolder = () => {
    try { const st = xfs.lstatSync(folder); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
  };
  if (!realFolder()) return { ok: false, error: 'first-message-blocked' };
  const before = readCurrentJob(folder, xfs);
  if (before.present && !before.jobId) return { ok: false, error: 'first-message-blocked' };
  const temp = path.join(folder, `.current-${jobId}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  let created = false;
  try {
    xfs.writeFileSync(temp, JSON.stringify({ version: 1, jobId }) + '\n', { encoding: 'utf8', flag: 'wx' });
    created = true;
    const current = readCurrentJob(folder, xfs);
    if (!realFolder() || (current.present && !current.jobId)) return { ok: false, error: 'first-message-blocked' };
    xfs.renameSync(temp, path.join(folder, CURRENT_JOB_FILE));
    return { ok: true };
  } catch {
    return { ok: false, error: 'first-message-failed' };
  } finally {
    if (created && realFolder()) { try { xfs.unlinkSync(temp); } catch { /* renamed or already removed */ } }
  }
}
