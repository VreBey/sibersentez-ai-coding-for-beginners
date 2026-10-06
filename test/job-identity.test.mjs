import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePlan, parseTasks, parseVerdict, teamStep, teamFacts, teamSummary } from '../server/team.mjs';
import { jobMessageText } from '../server/launch.mjs';
import { newJobId, jobMessageName, readCurrentJob, writeCurrentJob } from '../server/job-id.mjs';
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
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

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
  fs.writeFileSync(path.join(folder, 'current-job.json'), 'user notes');
  assert.equal(writeCurrentJob(folder, A).ok, false);
  assert.equal(fs.readFileSync(path.join(folder, 'current-job.json'), 'utf8'), 'user notes');
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
