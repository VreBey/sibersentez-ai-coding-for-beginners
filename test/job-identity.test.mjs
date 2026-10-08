import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePlan, parseTasks, parseVerdict, teamStep, teamFacts, teamSummary } from '../server/team.mjs';
import { jobMessageText } from '../server/launch.mjs';
import { newJobId, jobMessageName, readCurrentJob, writeCurrentJob, markerError } from '../server/job-id.mjs';
import { jobNowText } from '../public/js/views/job.js';
import { jobOf } from '../public/js/hq-live.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';

const A = 'J' + 'a'.repeat(32);
const B = 'J' + 'b'.repeat(32);
const planText = (id) => `# Plan: Example\nJob-ID: ${id}\nApproved: yes\nResult: accepted\n`;
const taskText = (id) => `# Tasks\nJob-ID: ${id}\n## T1: Build\n- status: done\n`;
const reviewText = (id) => `## Review: whole job\nJob-ID: ${id}\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":[]}\n`;
const facts = (p, t, r) => ({ plan: parsePlan(planText(p)), tasks: parseTasks(taskText(t)), review: parseVerdict(reviewText(r)) });

test('the plan, tasks and latest review carry the same explicit job identity', () => {
  const f = facts(A, A, A);
  assert.equal(f.plan.jobId, A);
  assert.equal(f.tasks[0].jobId, A);
  assert.equal(f.review.jobId, A);
  assert.equal(teamStep(f), 'done');
  assert.notEqual(teamStep(facts(B, B, A)), 'done', 'reused T1 does not reuse the old review');
  assert.notEqual(teamStep(facts(B, A, B)), 'done', 'old tasks cannot complete a new plan');
  assert.equal(teamSummary(facts(B, B, A)).review, null, 'old approval is not displayed');
});

test('legacy records are readable but cannot claim verified completion without job identity', () => {
  const f = {
    plan: parsePlan('# Plan: Legacy\nApproved: yes\n'),
    tasks: parseTasks('## T1: Build\n- status: done\n'),
    review: parseVerdict('## Review: whole job\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":[]}\n'),
  };
  assert.equal(f.plan.title, 'Legacy');
  assert.equal(f.plan.legacy, true);
  assert.equal(teamStep(f), 'check');
});

test('a legacy job the person already accepted stays done after the upgrade; a broken Job-ID line or a current marker does not', () => {
  const tasks = parseTasks('## T1: Build\n- status: done\n');
  const accepted = parsePlan('# Plan: Legacy\nApproved: yes\nResult: accepted\n');
  assert.equal(teamStep({ plan: accepted, tasks, review: null }), 'done');
  assert.equal(teamSummary({ plan: accepted, tasks, review: null }).reviewIssue, null);
  const broken = parsePlan('# Plan: Broken\nJob-ID: bad\nApproved: yes\nResult: accepted\n');
  assert.equal(broken.legacy, false);
  assert.equal(teamStep({ plan: broken, tasks, review: null }), 'check');
  assert.equal(teamStep({ plan: accepted, tasks, review: null, currentJob: { present: true, jobId: A } }), 'plan');
});

test('a Job-ID line written with Markdown emphasis, code marks or a list bullet is read as the plain id', () => {
  for (const line of [`**Job-ID:** ${A}`, `Job-ID: \`${A}\``, `- Job-ID: ${A}`, `__Job-ID:__ ${A}`]) {
    assert.equal(parsePlan(`# Plan: X\n${line}\nApproved: yes\n`).jobId, A, line);
    assert.equal(parseVerdict(`## Review: whole job\n${line}\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":[]}\n`).jobId, A, line);
  }
});

test('missing, invalid, duplicate or quoted ids are never inherited by the latest review', () => {
  for (const id of ['', 'bad', `${A}\nJob-ID: ${B}`, `${A}\nJob-ID: ${A}`]) {
    assert.notEqual(teamStep(facts(A, A, id)), 'done', id);
    assert.notEqual(teamStep(facts(id, A, A)), 'done', id);
    assert.notEqual(teamStep(facts(A, id, A)), 'done', id);
  }
  const newer = reviewText(A) + '## Review: whole job\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":[]}\n';
  assert.equal(parseVerdict(newer).jobId, null);
  const quoted = '## Review: whole job\n```\nJob-ID: ' + A + '\n```\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":[]}\n';
  assert.equal(parseVerdict(quoted).jobId, null);
});

test('the job prompt passes its identity to the plan, tasks and every review section', () => {
  const text = jobMessageText('Add a page', A);
  assert.ok(text.includes(`Job-ID: ${A}`));
  for (const file of ['PLAN.md', 'TASKS.md', 'REVIEW.md']) assert.ok(text.includes(file), file);
});

test('a stale approval explains the need for a fresh check in both UI languages', () => {
  const summary = teamSummary(facts(B, B, A));
  assert.equal(summary.step, 'check');
  assert.equal(summary.reviewIssue, 'job-identity');
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    assert.equal(jobNowText(summary), STRINGS[lang].jobNowIdentity);
    assert.equal(jobNowText(jobOf(summary)), STRINGS[lang].jobNowIdentity, 'the building keeps the same explanation');
    assert.ok(STRINGS[lang].jobNowIdentity.length > 0);
  }
  setLanguage('en');
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-job-id-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

test('the marker is atomic and rejects links, unknown contents and write failures', () => {
  const folder = path.join(ROOT, 'marker');
  fs.mkdirSync(folder);
  assert.deepEqual(readCurrentJob(folder), { present: false, jobId: null });
  assert.equal(writeCurrentJob(folder, A).ok, true);
  const brokenFs = { ...fs, renameSync: () => { throw new Error('locked'); } };
  assert.equal(writeCurrentJob(folder, B, brokenFs).ok, false);
  assert.equal(readCurrentJob(folder).jobId, A);
  assert.deepEqual(fs.readdirSync(folder), ['current-job.json']);
  assert.equal(writeCurrentJob(folder, B).ok, true);
  assert.equal(readCurrentJob(folder).jobId, B);
  assert.equal(writeCurrentJob(folder, '../escape').ok, false);
  assert.throws(() => jobMessageName('../escape'));
  assert.notEqual(newJobId(), newJobId());
  const linked = path.join(ROOT, 'linked');
  fs.symlinkSync(folder, linked, 'junction');
  assert.equal(writeCurrentJob(linked, A).ok, false);
  assert.equal(readCurrentJob(folder).jobId, B);
  // An unknown small plain file is set aside (kept as .bak-<random>, never deleted) and the new job starts
  fs.writeFileSync(path.join(folder, 'current-job.json'), 'user notes');
  assert.equal(readCurrentJob(folder).problem, 'unknown');
  assert.equal(markerError(readCurrentJob(folder)), null);
  assert.equal(writeCurrentJob(folder, A).ok, true);
  assert.equal(readCurrentJob(folder).jobId, A);
  const kept = fs.readdirSync(folder).filter((n) => /^current-job\.json\.bak-[0-9a-f]{8}$/.test(n));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(folder, kept[0]), 'utf8'), 'user notes');
  // A marker from a newer format is unknown too, set aside the same way
  fs.writeFileSync(path.join(folder, 'current-job.json'), JSON.stringify({ version: 2, jobId: B }));
  assert.equal(writeCurrentJob(folder, B).ok, true);
  assert.equal(readCurrentJob(folder).jobId, B);
});

test('a marker that is a folder, a link or a large file is never touched and gets its own reason; a read failure says try again', () => {
  const folder = path.join(ROOT, 'marker-odd');
  fs.mkdirSync(path.join(folder, 'current-job.json'), { recursive: true });
  assert.equal(readCurrentJob(folder).problem, 'not-file');
  assert.deepEqual(writeCurrentJob(folder, A), { ok: false, error: 'job-marker-unknown' });
  assert.ok(fs.statSync(path.join(folder, 'current-job.json')).isDirectory());
  const big = path.join(ROOT, 'marker-big');
  fs.mkdirSync(big);
  fs.writeFileSync(path.join(big, 'current-job.json'), 'x'.repeat(5000));
  assert.deepEqual(writeCurrentJob(big, A), { ok: false, error: 'job-marker-unknown' });
  assert.equal(fs.readFileSync(path.join(big, 'current-job.json'), 'utf8').length, 5000);
  const busyFs = { ...fs, lstatSync: (p, o) => (String(p).endsWith('current-job.json') ? (() => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; })() : fs.lstatSync(p, o)) };
  assert.deepEqual(readCurrentJob(big, busyFs), { present: true, jobId: null, problem: 'busy' });
  assert.equal(markerError(readCurrentJob(big, busyFs)), 'job-marker-busy');
  // A lasting failure (not a lock) is not worth another try
  const deniedFs = { ...fs, lstatSync: (p, o) => (String(p).endsWith('current-job.json') ? (() => { const e = new Error('loop'); e.code = 'ELOOP'; throw e; })() : fs.lstatSync(p, o)) };
  assert.equal(readCurrentJob(big, deniedFs).problem, 'not-file');
  assert.equal(markerError(readCurrentJob(big, deniedFs)), 'job-marker-unknown');
  // An unknown marker that cannot be moved just now (locked) asks to try again and is left as it was
  const locked = path.join(ROOT, 'marker-locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'current-job.json'), 'notes');
  const lockedFs = { ...fs, renameSync: () => { const e = new Error('locked'); e.code = 'EBUSY'; throw e; } };
  assert.deepEqual(writeCurrentJob(locked, A, lockedFs), { ok: false, error: 'job-marker-busy' });
  assert.equal(fs.readFileSync(path.join(locked, 'current-job.json'), 'utf8'), 'notes');
  for (const lang of ['en', 'tr']) for (const code of ['job-marker-unknown', 'job-marker-busy']) assert.ok(STRINGS[lang][`aiErr_${code}`], `${lang} ${code}`);
});

test('a new active job hides the old completed plan immediately and survives rereading', () => {
  const dir = path.join(ROOT, 'project');
  const team = path.join(dir, '.sibersentez');
  fs.mkdirSync(team, { recursive: true });
  fs.writeFileSync(path.join(team, 'PLAN.md'), planText(A));
  fs.writeFileSync(path.join(team, 'TASKS.md'), taskText(A));
  fs.writeFileSync(path.join(team, 'REVIEW.md'), reviewText(A));
  fs.writeFileSync(path.join(team, 'current-job.json'), JSON.stringify({ version: 1, jobId: B }));
  for (let i = 0; i < 2; i++) {
    const summary = teamSummary(teamFacts(dir));
    assert.equal(summary.step, 'plan');
    assert.equal(summary.plan, null);
    assert.equal(summary.review, null);
    assert.equal(summary.tasks.total, 0);
  }
  fs.writeFileSync(path.join(team, 'PLAN.md'), planText(B));
  fs.writeFileSync(path.join(team, 'TASKS.md'), taskText(B));
  assert.equal(teamSummary(teamFacts(dir)).step, 'check');
  fs.writeFileSync(path.join(team, 'REVIEW.md'), reviewText(B));
  assert.equal(teamSummary(teamFacts(dir)).step, 'done');
  fs.writeFileSync(path.join(team, 'current-job.json'), '{');
  assert.equal(teamSummary(teamFacts(dir)).step, 'plan', 'corrupt marker cannot revive old completion');
});

test('the marker keeps the tool the job started with; the team answer and the Building carry it for this job only', () => {
  const folder = path.join(ROOT, 'marker-tool');
  fs.mkdirSync(folder);
  assert.equal(writeCurrentJob(folder, A, fs, { tool: 'codex' }).ok, true);
  assert.deepEqual(readCurrentJob(folder), { present: true, jobId: A, tool: 'codex' });
  assert.equal(writeCurrentJob(folder, B, fs, { tool: 'Bad Tool!' }).ok, true);
  assert.deepEqual(readCurrentJob(folder), { present: true, jobId: B }, 'not a tool id: left out');
  assert.equal(writeCurrentJob(folder, A).ok, true);
  assert.deepEqual(readCurrentJob(folder), { present: true, jobId: A }, 'a marker without a tool (written outside the app) still reads');
  const plan = parsePlan(`# Plan: x\nJob-ID: ${A}\n\n## Tasks\n`);
  assert.equal(teamSummary({ plan, tasks: [], review: null, currentJob: { present: true, jobId: A, tool: 'gemini-cli' } }).tool, 'gemini-cli');
  assert.equal(teamSummary({ plan, tasks: [], review: null, currentJob: { present: true, jobId: B, tool: 'gemini-cli' } }).tool, null, "another job's marker: not this plan's tool");
  assert.equal(jobOf({ step: 'build', plan: { jobId: A }, tool: 'codex' }).tool, 'codex');
});
