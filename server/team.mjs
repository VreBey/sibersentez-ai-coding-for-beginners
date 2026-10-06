// "Do a job" progress (docs/kit-in-app.md): the kit's team keeps its hand-off files in the project's .sibersentez folder
// (docs/kit-v2.md §3.2). This reads three of them, read-only, and says which of the four steps the job is at
// (Plan → Build → Check → Finish, then done once the result is accepted) with the task counts and the last verdict. Nothing is run or written, no action mode
// is needed; a .sibersentez that is a link, or a file larger than the limit, is not read.
import fs from 'node:fs';
import path from 'node:path';
import { isLocalPath } from './fsutil.mjs';
import { normPath } from './util.mjs';
import { isRealDir, hasStreamColon } from './library.mjs';
import { readSmall } from './suggest.mjs';

export const TEAM_DIR = '.sibersentez';
// A project that has only the folder of the product's old name (renamed 2026-09-30) is read from there
const LEGACY_TEAM_DIR = '.orkestra';
const STATUSES = new Set(['todo', 'doing', 'done', 'blocked']);
const SIZES = new Set(['small', 'medium', 'big']);
const TITLE_MAX = 120;

// A title as the person reads it: control characters out, markdown code and emphasis marks (`x`, **x**) out
const clip = (s) => Array.from(String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/`+|\*\*|__/g, '').trim()).slice(0, TITLE_MAX).join('');

// PLAN.md: its title, its size, whether the person approved it and whether they accepted the result (pure)
export function parsePlan(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const title = /^#\s*Plan:\s*(.+)$/im.exec(text)?.[1];
  const size = /^Size:\s*(small|medium|big)\b/im.exec(text)?.[1]?.toLowerCase();
  return { title: title ? clip(title) : '', size: SIZES.has(size) ? size : null, approved: /^Approved:\s*yes\b/im.test(text), accepted: /^Result:\s*accepted\b/im.test(text) };
}

// TASKS.md: every "## T<n>: title" block with its owner and status (pure). A block without a known status is todo.
export function parseTasks(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const heads = [...text.matchAll(/^##\s+(T\d{1,4})\s*:\s*(.*)$/gim)];
  heads.forEach((m, i) => {
    const block = text.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : text.length);
    const status = /^\s*-\s*status:\s*([a-z]+)/im.exec(block)?.[1]?.toLowerCase();
    const owner = /^\s*-\s*owner:\s*([a-z-]{1,40})/im.exec(block)?.[1]?.toLowerCase() || '';
    out.push({ id: m[1].toUpperCase(), title: clip(m[2]), owner, status: STATUSES.has(status) ? status : 'todo' });
  });
  return out.slice(0, 200);
}

// REVIEW.md: the last VERDICT line (pure). { verdict: 'APPROVE' | 'REVISE', blockers, nits } or null.
export function parseVerdict(text) {
  if (typeof text !== 'string') return null;
  const lines = [...text.matchAll(/^VERDICT:\s*(\{.*\})\s*$/gm)];
  const lastMatch = lines.at(-1);
  const last = lastMatch?.[1];
  if (!last) return null;
  // The tasks the reviews in the file name in their "## Review T1, T2" headings (a "whole job" review names none, so
  // the file as a whole says which job it checked)
  const heads = [...text.slice(0, lastMatch.index).matchAll(/^##\s*Review\b(.*)$/gim)].map((m) => m[1]).join(' ');
  const tasks = [...new Set([...heads.matchAll(/\bT(\d{1,4})\b/gi)].map((m) => `T${m[1]}`))].slice(0, 50);
  try {
    const v = JSON.parse(last);
    if (v?.verdict !== 'APPROVE' && v?.verdict !== 'REVISE') return null;
    return { verdict: v.verdict, blockers: Array.isArray(v.blockers) ? v.blockers.length : 0, nits: Array.isArray(v.nits) ? v.nits.length : 0, tasks };
  } catch {
    return null;
  }
}

// Which step the job is at (pure): none (no team files), plan (no approved plan or no tasks yet), build (tasks left),
// check (all done, no approving verdict yet), finish (all done and approved), done (the person accepted the result)
export function teamStep({ plan, tasks, review }) {
  if (!plan && !tasks.length) return 'none';
  if (!plan?.approved || !tasks.length) return 'plan';
  if (tasks.some((t) => t.status !== 'done')) return 'build';
  review = reviewOf(tasks, review);
  if (review?.verdict !== 'APPROVE' || review.blockers) return 'check';
  // The wrap-up writes "Result: accepted" into PLAN.md once the person said yes to the result
  return plan.accepted ? 'done' : 'finish';
}

// The review, when it is about these tasks (pure). One that names none of them belongs to an earlier job left in
// the folder (the drawer jumped to Finish before the new job was checked): it counts as no review.
export function reviewOf(tasks, review) {
  if (!review?.tasks?.length) return review || null;
  const ids = new Set(tasks.map((t) => t.id));
  return review.tasks.some((id) => ids.has(id)) ? review : null;
}

export function teamSummary({ plan, tasks, review, updatedAt = null, history = [] }) {
  const count = (s) => tasks.filter((t) => t.status === s).length;
  const current = tasks.find((t) => t.status === 'doing') || tasks.find((t) => t.status === 'blocked') || tasks.find((t) => t.status === 'todo') || null;
  return {
    step: teamStep({ plan, tasks, review }),
    plan,
    tasks: { total: tasks.length, todo: count('todo'), doing: count('doing'), done: count('done'), blocked: count('blocked') },
    current: current ? { id: current.id, title: current.title, owner: current.owner, status: current.status } : null,
    review: reviewOf(tasks, review),
    updatedAt,
    history,
  };
}

// Earlier jobs (the team moves a finished job's files to .sibersentez/archive/<date>-<short name>/, kit orchestrate §1):
// newest first, at most HISTORY_MAX, real folders only (never a link), each read like the current job. Competitors
// keep the requests behind a project; here the person sees what was done before. Read only.
export const HISTORY_MAX = 10;
// Any letter (a Turkish job name), digits, dot, dash, underscore and space; never a path separator
const ARCHIVE_NAME_RE = /^[\p{L}\p{N}._ -]{1,100}$/u;
export function jobHistory(folder) {
  const base = path.join(folder, 'archive');
  if (!isRealDir(base)) return [];
  let names;
  try {
    names = fs.readdirSync(base).filter((n) => ARCHIVE_NAME_RE.test(n) && isRealDir(path.join(base, n)));
  } catch {
    return [];
  }
  // Byte order on the date prefix: the newest first
  names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return names.slice(0, HISTORY_MAX).map((n) => {
    const read = (name) => readSmall(path.join(base, n, name));
    const plan = parsePlan(read('PLAN.md'));
    const tasks = parseTasks(read('TASKS.md'));
    const review = parseVerdict(read('REVIEW.md'));
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(n)?.[1] || null;
    const slug = n.replace(/^\d{4}-\d{2}-\d{2}-?/, '').replace(/[-_]+/g, ' ').trim();
    return { title: plan?.title || clip(slug) || n, date, accepted: !!plan?.accepted, verdict: review?.verdict || null, tasks: tasks.length };
  });
}

// The files (the only part that reads the disk). dir: the project folder.
export function teamFacts(dir) {
  let folder = path.join(dir, TEAM_DIR);
  if (!isRealDir(folder)) folder = path.join(dir, LEGACY_TEAM_DIR);
  if (!isRealDir(folder)) return null;
  const read = (name) => readSmall(path.join(folder, name));
  // When the job last changed: the newest of its files (the page offers to go on only with the session that ran then)
  let updatedAt = 0;
  for (const name of ['PLAN.md', 'TASKS.md', 'REVIEW.md', 'LEDGER.md', 'HANDOFF.md']) {
    try {
      updatedAt = Math.max(updatedAt, fs.statSync(path.join(folder, name)).mtimeMs);
    } catch {
      /* not there */
    }
  }
  return { plan: parsePlan(read('PLAN.md')), tasks: parseTasks(read('TASKS.md')), review: parseVerdict(read('REVIEW.md')), updatedAt: updatedAt ? Math.floor(updatedAt) : null, history: jobHistory(folder) };
}

// GET /api/projects/<id>/team
export function projectTeam({ catalog, projectId, facts = teamFacts }) {
  const p = catalog?.getProject?.(projectId) || null;
  if (!p) return { status: 404, body: { error: 'not-a-project' } };
  const none = { project: p.id, step: 'none', plan: null, tasks: { total: 0, todo: 0, doing: 0, done: 0, blocked: 0 }, current: null, review: null };
  const isBroad = (dir) => typeof catalog.isBroad === 'function' && !!catalog.isBroad(normPath(dir));
  if (!p.path || p.broad || p.tmpOnly || !isLocalPath(p.path) || hasStreamColon(p.path) || isBroad(p.path)) return { status: 200, body: none };
  const f = facts(p.path);
  if (!f) return { status: 200, body: none };
  return { status: 200, body: { project: p.id, ...teamSummary(f) } };
}
