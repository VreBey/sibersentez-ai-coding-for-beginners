// @ts-check
// The app's own record of a job's result (docs/internal/evidence-card-plan.md E1; independent review of 0.18.0 §7.1).
// The verdict and the acceptance are what the AI writes into the project (server/team.mjs); this record keeps what the
// app itself saw: the job's whole-job verdict, when REVIEW.md held it, when the app first saw it, a fingerprint of the
// project's files at that moment (restore.mjs treeFingerprint) and how many of them were written after REVIEW.md (so
// before the app looked: the review may not have seen them), and when the app first saw the job accepted.
// GET /api/projects/<id>/job-result then says whether the files are still those the verdict was about.
//
// Kept in the hub next to the restore points (never in the project, where an AI writes): restore/<key>/job-results.json,
// { version: 1, jobs: [record] }, newest first, at most JOB_RESULTS_KEEP, one per Job-ID, written whole and renamed;
// only known fields of known shapes are read back, and a file of another version is not read.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pointsDir, treeFingerprint } from './restore.mjs';
import { validJobId } from './job-id.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { resolveProject } from './install.mjs';
import { isLegacyHub } from './library.mjs';
import { reviewFileTime } from './team.mjs';

export const JOB_RESULTS_FILE = 'job-results.json';
export const JOB_RESULTS_KEEP = 20;
const JOB_RESULTS_VERSION = 1;
const JOB_RESULTS_MAX = 64 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const PROBLEM_RE = /^[a-z][a-z0-9-]{0,40}$/;
// A look that could not finish (the record not written, a file locked) is tried again after this long, not on every poll
export const OBSERVE_RETRY_MS = 60000;

const count = (x) => (Number.isInteger(x) && x >= 0 ? x : 0);
const time = (x) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : null);

// The fingerprint part of a record: { files, bytes, scope, quick, digest (or null), writtenAfterReview, at } or
// { problem, at }
function treeOf(t) {
  if (!t || typeof t !== 'object' || !time(t.at)) return null;
  if (typeof t.problem === 'string') return PROBLEM_RE.test(t.problem) ? { problem: t.problem, at: time(t.at) } : null;
  if (!HEX64.test(t.quick)) return null;
  return { files: count(t.files), bytes: count(t.bytes), scope: t.scope === 'lean' ? 'lean' : 'full', quick: t.quick, digest: HEX64.test(t.digest) ? t.digest : null, writtenAfterReview: count(t.writtenAfterReview), at: time(t.at) };
}

// What the app saw of the job's reviewer agents when it saw the verdict (server/jobReviewers.mjs, plan E4), so a log
// gone from the app's window still shows it: { agents, types, said, saidAt, lastAt, unknownTools, at }
const TYPE_RE = /^[\p{L}\p{N}][\p{L}\p{N} :._-]{0,79}$/u;
const TOOL_RE = /^[a-z][a-z0-9-]{0,20}$/;
function reviewersOf(x) {
  if (!x || typeof x !== 'object' || !time(x.at)) return null;
  const list = (a, re, max) => (Array.isArray(a) ? a.filter((v) => typeof v === 'string' && re.test(v)).slice(0, max) : []);
  const said = x.said === 'APPROVE' || x.said === 'REVISE' ? x.said : null;
  return { agents: count(x.agents), types: list(x.types, TYPE_RE, 3), said, saidAt: said ? time(x.saidAt) : null, lastAt: time(x.lastAt), unknownTools: list(x.unknownTools, TOOL_RE, 8), at: time(x.at) };
}

// One record, only known fields of known shapes (it reaches the page)
export function jobResultRecord(r) {
  if (!r || typeof r !== 'object' || !validJobId(r.jobId)) return null;
  const v = r.verdict;
  const verdict = v && typeof v === 'object' && (v.value === 'APPROVE' || v.value === 'REVISE') && time(v.seenAt) ? { value: v.value, blockers: count(v.blockers), nits: count(v.nits), reviewAt: time(v.reviewAt), seenAt: time(v.seenAt) } : null;
  return { jobId: r.jobId, verdict, tree: verdict ? treeOf(r.tree) : null, reviewers: verdict ? reviewersOf(r.reviewers) : null, acceptedSeenAt: time(r.acceptedSeenAt) };
}

export function listJobResults({ hubDir, projectId }) {
  if (!hubDir) return [];
  const file = path.join(pointsDir(hubDir, projectId), JOB_RESULTS_FILE);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > JOB_RESULTS_MAX) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.version !== JOB_RESULTS_VERSION) return [];
    return (Array.isArray(data.jobs) ? data.jobs : []).map(jobResultRecord).filter(Boolean).slice(0, JOB_RESULTS_KEEP);
  } catch {
    return [];
  }
}

// Writes the record (newest first, the job's older record replaced). Never throws: false when it could not be written.
export function writeJobResult({ hubDir, projectId, record }) {
  const rec = jobResultRecord(record);
  if (!hubDir || !rec) return false;
  const base = pointsDir(hubDir, projectId);
  const jobs = [rec, ...listJobResults({ hubDir, projectId }).filter((r) => r.jobId !== rec.jobId)].slice(0, JOB_RESULTS_KEEP);
  const tmp = path.join(base, `.${JOB_RESULTS_FILE}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.mkdirSync(base, { recursive: true });
    writeFileAtomic(path.join(base, JOB_RESULTS_FILE), JSON.stringify({ version: JOB_RESULTS_VERSION, jobs }), { tmp });
    return true;
  } catch (e) {
    console.error('job result not written:', e?.code || 'error');
    return false;
  }
}

// The whole-job verdict of the plan's job in a /team answer, or null (a task review, another job's, none)
const wholeVerdict = (team) => {
  const jobId = team?.plan?.jobId;
  const r = team?.review;
  return validJobId(jobId) && r && r.jobId === jobId && r.scope === 'whole' && (r.verdict === 'APPROVE' || r.verdict === 'REVISE') ? r : null;
};
const isAccepted = (team) => validJobId(team?.plan?.jobId) && team.step === 'done' && team.plan.accepted === true;

// What the app sees in a /team answer (team.mjs teamSummary): the plan's job's whole-job verdict, kept with the files'
// fingerprint then; again when it changes (another value or count, or REVIEW.md written again: a new round with the same
// counts), and once more when a file could not be read the first time; the acceptance, once. Async (the fingerprint
// reads every file); one look per project at a time, a second one meanwhile is skipped (the next poll catches up: the
// comparison is with the record, not with the poll). Returns { status: 'none' | 'written' | 'failed' | 'busy', record }.
const busy = new Set();
// reviewers(jobId, { before }): what the app's log reading saw of the job's reviewer agents (ingest.jobReviewers), null
// when it knows no session of the job
export async function observeTeam({ hubDir, projectId, dir, team, now = Date.now, fingerprint = treeFingerprint, reviewTime = reviewFileTime, reviewers = (_jobId, _opts) => null }) {
  const jobId = team?.plan?.jobId;
  if (!hubDir || !dir || !validJobId(jobId)) return { status: 'none', record: null };
  if (busy.has(projectId)) return { status: 'busy', record: null };
  const whole = wholeVerdict(team);
  const old = listJobResults({ hubDir, projectId }).find((r) => r.jobId === jobId) || null;
  const reviewAt = whole ? reviewTime(dir) : null;
  const newVerdict = !!whole && (!old?.verdict || old.verdict.value !== whole.verdict || old.verdict.blockers !== count(whole.blockers) || old.verdict.nits !== count(whole.nits) || (reviewAt !== null && old.verdict.reviewAt !== reviewAt));
  const retryTree = !!whole && !newVerdict && !!old?.tree && 'quick' in old.tree && !old.tree.digest;
  const newAccept = isAccepted(team) && !old?.acceptedSeenAt;
  // The reviewer agents not known when the verdict was seen (the app's log reading still starting): kept on a later look
  let reviewersNow = null;
  if (whole && !newVerdict && old?.verdict && !old.reviewers) {
    try {
      reviewersNow = reviewers(jobId, { before: old.verdict.reviewAt });
    } catch {}
  }
  if (!newVerdict && !retryTree && !newAccept && !reviewersNow) return { status: 'none', record: old };
  busy.add(projectId);
  try {
    const record = { jobId, verdict: old?.verdict || null, tree: old?.tree || null, reviewers: old?.reviewers || null, acceptedSeenAt: old?.acceptedSeenAt || null };
    if ((newVerdict || retryTree) && whole) {
      const at = now();
      if (newVerdict) {
        record.verdict = { value: whole.verdict, blockers: count(whole.blockers), nits: count(whole.nits), reviewAt, seenAt: at };
        // Kept as seen with this verdict (an answer said after REVIEW.md was written belongs to a later round)
        let seen = null;
        try {
          seen = reviewers(jobId, { before: reviewAt });
        } catch {}
        record.reviewers = seen ? { ...seen, at } : null;
      }
      const since = record.verdict?.reviewAt ?? null;
      let fp;
      try {
        fp = /** @type {any} */ (await fingerprint(dir, { hubDir, after: since }));
      } catch {
        fp = { ok: false, problem: 'unreadable' };
      }
      record.tree = fp.ok ? { files: fp.files, bytes: fp.bytes, scope: fp.scope, quick: fp.quick, digest: fp.digest ?? null, writtenAfterReview: since === null ? 0 : fp.writtenSince, at } : { problem: fp.problem, at };
    }
    if (newAccept) record.acceptedSeenAt = now();
    if (reviewersNow) record.reviewers = { ...reviewersNow, at: now() };
    if (!writeJobResult({ hubDir, projectId, record })) return { status: 'failed', record: old };
    return { status: 'written', record: jobResultRecord(record) };
  } finally {
    busy.delete(projectId);
  }
}

// The gate the app's other project writers pass (install.mjs resolveProject, the hub there and of the new layout)
function projectDir({ catalog, projectId, homeDir, claudeDir }) {
  const hubDir = catalog?.hubDir || null;
  if (!hubDir || isLegacyHub(hubDir)) return null;
  try {
    if (!fs.statSync(hubDir).isDirectory()) return null;
  } catch {
    return null;
  }
  const r = resolveProject({ catalog, projectId, hubDir, homeDir, claudeDir });
  return r.ok ? { dir: r.dir, hubDir } : null;
}

// After a /team answer (server/app.mjs; the drawer and the building ask every 8 s per project). Nothing touches the disk
// unless the answer holds something to keep (the plan's job's whole verdict, or its acceptance) and the team's files
// changed since the last look (team.updatedAt is in the signature), or a look is due again after a failure. The look
// itself starts after the answer is sent (schedule). Never throws.
const looks = new Map(); // projectId -> { sig, retryAt }
// logsReady: the app's log reading has finished its first scan (in the signature, so the record gets the reviewer agents
// it could not know before)
export function observeTeamAnswer({ catalog, projectId, team, homeDir = null, claudeDir = null, now = Date.now, schedule = setImmediate, memo = looks, observe = observeTeam, reviewers = undefined, logsReady = true }) {
  const whole = wholeVerdict(team);
  if (!whole && !isAccepted(team)) return;
  const sig = [catalog?.hubDir, team.plan.jobId, whole?.verdict, whole?.blockers, whole?.nits, team.step, team.updatedAt, logsReady].join('|');
  const last = memo.get(projectId);
  if (last && last.sig === sig && !(last.retryAt && now() >= last.retryAt)) return;
  memo.set(projectId, { sig, retryAt: now() + OBSERVE_RETRY_MS });
  schedule(() => {
    const g = projectDir({ catalog, projectId, homeDir, claudeDir });
    if (!g) return;
    observe({ hubDir: g.hubDir, projectId, dir: g.dir, team, ...(reviewers ? { reviewers } : {}) }).then(
      (r) => {
        // A newer answer took over meanwhile: its own look decides
        if (memo.get(projectId)?.sig !== sig) return;
        // Done when nothing is left to retry: written (with every file read), or nothing new
        const unread = r.record?.tree && 'quick' in r.record.tree && !r.record.tree.digest;
        if (r.status === 'none' || (r.status === 'written' && !unread)) memo.set(projectId, { sig, retryAt: null });
        // Another look of the project was running: the next poll looks again
        else if (r.status === 'busy') memo.delete(projectId);
      },
      (e) => console.error('job result observation failed:', e?.code || 'error'),
    );
  });
}

// GET /api/projects/<id>/job-result?job=<Job-ID> (read-only, no action mode): the app's record of the job and whether
// the files a restore point would hold (restore.mjs treeFingerprint: skipped folders, a lean scan's big files and logs
// are not compared) are still those its verdict was about:
//   same          paths, sizes, write and change times as then: nothing was written (no file is read)
//   same-content  files were written since, their content is the same
//   changed       the content differs; writtenSince: files and folders written since the verdict was seen (written,
//                 not necessarily changed; restore.mjs treeFingerprint)
//   unknown       with reason: no-record, written-before-seen (files or folders were written after REVIEW.md, before
//                 the app looked: whether the review saw them is not known), no-review-time (REVIEW.md could not be
//                 looked at then, so that gap cannot be measured), unreadable (a file could not be read, then or now),
//                 folder (the project refused now) or the scan's problem (a project over the limits)
// REVIEW.md's write time stands for the moment of the review: a REVIEW.md saved again without a new review moves it.
// A "changed" or "same-content" answer is kept with the quick fingerprint it was found with, so while nothing more is
// written no file is read again (the page asks every 15 s while the result card shows).
export const JOB_RESULT_TTL_MS = 15000;
const lastFull = new Map(); // `${projectId}|${jobId}|${tree.at}` -> { quick, answer }
export async function projectJobResult({ catalog, projectId, jobId, homeDir = null, claudeDir = null, fingerprint = treeFingerprint }) {
  if (!catalog?.getProject?.(projectId)) return { status: 404, body: { error: 'not-a-project' } };
  if (!validJobId(jobId)) return { status: 400, body: { error: 'bad-job' } };
  const body = { project: projectId, jobId };
  const hubDir = catalog.hubDir || null;
  const record = hubDir ? listJobResults({ hubDir, projectId }).find((r) => r.jobId === jobId) || null : null;
  const unknown = (reason, more = {}) => ({ status: 200, body: { ...body, record, fresh: 'unknown', reason, ...more } });
  const tree = record?.tree;
  if (!record || !tree) return unknown('no-record');
  if (!('quick' in tree)) return unknown(tree.problem);
  if (tree.writtenAfterReview > 0) return unknown('written-before-seen', { writtenAfterReview: tree.writtenAfterReview });
  if (!record.verdict?.reviewAt) return unknown('no-review-time');
  if (!tree.digest) return unknown('unreadable');
  const g = projectDir({ catalog, projectId, homeDir, claudeDir });
  if (!g) return unknown('folder');
  const quick = /** @type {any} */ (await fingerprint(g.dir, { hubDir, after: tree.at, withDigest: false }));
  if (!quick.ok) return unknown(quick.problem);
  if (quick.quick === tree.quick) return { status: 200, body: { ...body, record, fresh: 'same' } };
  const key = `${projectId}|${jobId}|${tree.at}`;
  const kept = lastFull.get(key);
  if (kept && kept.quick === quick.quick) return { status: 200, body: { ...body, record, ...kept.answer } };
  const full = /** @type {any} */ (await fingerprint(g.dir, { hubDir, after: tree.at }));
  if (!full.ok) return unknown(full.problem);
  if (!full.digest) return unknown('unreadable');
  const answer = full.digest !== tree.digest ? { fresh: 'changed', writtenSince: full.writtenSince } : { fresh: 'same-content' };
  lastFull.delete(key);
  if (lastFull.size >= 64) lastFull.delete(lastFull.keys().next().value);
  lastFull.set(key, { quick: full.quick, answer });
  return { status: 200, body: { ...body, record, ...answer } };
}
