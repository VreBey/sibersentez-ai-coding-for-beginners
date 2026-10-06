// "Do a job" progress (server/team.mjs, docs/kit-in-app.md): the team's hand-off files read-only, the step of the job
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePlan, parseTasks, parseVerdict, reviewOf, teamStep, teamSummary, teamFacts, projectTeam } from '../server/team.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-team-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const PLAN = '# Plan: Sign-in page\n\nSize: small\nGoal: users sign in\n\n## Approval\nApproved: yes\nDate: 2026-09-30\n';
const TASKS = [
  '# Tasks',
  '',
  '## T1: Write a failing test for sign-in',
  '- owner: tester',
  '- files: test/signin.test.js',
  '- status: done',
  '',
  '## T2: Implement sign-in',
  '- owner: builder',
  '- files: src/signin.js',
  '- status: doing',
  '',
  '## T3: Odd status',
  '- owner: builder',
  '- status: someday',
  '',
].join('\n');

test('plan: title, size and approval; an unapproved or empty plan', () => {
  assert.deepEqual(parsePlan(PLAN), { title: 'Sign-in page', size: 'small', approved: true, accepted: false });
  assert.deepEqual(parsePlan('# Plan: x\nApproved: no\n'), { title: 'x', size: null, approved: false, accepted: false });
  // The wrap-up's "Result: accepted"; markdown marks leave the title (the drawer showed `index.html` with its backticks)
  assert.deepEqual(parsePlan('# Plan: The `index.html` **list**\nApproved: yes\nResult: accepted\n'), { title: 'The index.html list', size: null, approved: true, accepted: true });
  assert.equal(parsePlan('# Plan: x\nApproved: yes\nResult: open\n').accepted, false);
  assert.equal(parseTasks('## T1: Write `index.html`\n- status: doing\n')[0].title, 'Write index.html');
  assert.equal(parsePlan(''), null);
  assert.equal(parsePlan(null), null);
});

test('tasks: id, title, owner and status per block; an unknown status counts as todo', () => {
  assert.deepEqual(parseTasks(TASKS), [
    { id: 'T1', title: 'Write a failing test for sign-in', owner: 'tester', status: 'done' },
    { id: 'T2', title: 'Implement sign-in', owner: 'builder', status: 'doing' },
    { id: 'T3', title: 'Odd status', owner: 'builder', status: 'todo' },
  ]);
  assert.deepEqual(parseTasks('no tasks here'), []);
  assert.equal(parseTasks(`## T1: ${'x'.repeat(500)}\n- status: todo`)[0].title.length, 120, 'a long title is cut');
});

test('verdict: the last VERDICT line wins; broken JSON or an unknown verdict is none', () => {
  const two = 'first\nVERDICT: {"verdict":"REVISE","blockers":[{"file":"a"}],"nits":[]}\nfixed\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":["x"]}\n';
  assert.deepEqual(parseVerdict(two), { verdict: 'APPROVE', blockers: 0, nits: 1, tasks: [] });
  // The tasks the review headings of the file name (up to the last verdict)
  const headed = '## Review T1\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":[]}\n## Review T2, t3 (round 2)\nVERDICT: {"verdict":"REVISE","blockers":[{}],"nits":[]}\n';
  assert.deepEqual(parseVerdict(headed), { verdict: 'REVISE', blockers: 1, nits: 0, tasks: ['T1', 'T2', 'T3'] });
  assert.deepEqual(parseVerdict('## Review of the whole job\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":[]}').tasks, []);
  // The real file of the first job: a task review, then a whole-job review last; it still says it checked T1
  const firstJob = '## Review T1\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":["a"]}\n## Review: whole job\nVERDICT: {"verdict":"APPROVE","blockers":[],"nits":["a","b"]}\n';
  assert.deepEqual(parseVerdict(firstJob), { verdict: 'APPROVE', blockers: 0, nits: 2, tasks: ['T1'] });
  assert.equal(teamStep({ plan: { title: 'x', approved: true }, tasks: [{ id: 'T2', status: 'done' }], review: parseVerdict(firstJob) }), 'check');
  assert.equal(parseVerdict('VERDICT: {not json}'), null);
  assert.equal(parseVerdict('VERDICT: {"verdict":"MAYBE"}'), null);
  assert.equal(parseVerdict('no verdict'), null);
});

test('step: none, plan, build, check, finish', () => {
  const tasks = (...s) => s.map((status, i) => ({ id: `T${i + 1}`, title: '', owner: 'builder', status }));
  const ok = { title: 'x', size: 'small', approved: true };
  assert.equal(teamStep({ plan: null, tasks: [], review: null }), 'none');
  assert.equal(teamStep({ plan: { ...ok, approved: false }, tasks: tasks('todo'), review: null }), 'plan');
  assert.equal(teamStep({ plan: ok, tasks: [], review: null }), 'plan');
  assert.equal(teamStep({ plan: ok, tasks: tasks('done', 'todo'), review: null }), 'build');
  assert.equal(teamStep({ plan: ok, tasks: tasks('done', 'blocked'), review: null }), 'build');
  assert.equal(teamStep({ plan: ok, tasks: tasks('done', 'done'), review: null }), 'check');
  assert.equal(teamStep({ plan: ok, tasks: tasks('done'), review: { verdict: 'REVISE', blockers: 1, nits: 0 } }), 'check');
  assert.equal(teamStep({ plan: ok, tasks: tasks('done'), review: { verdict: 'APPROVE', blockers: 0, nits: 2 } }), 'finish');
  // A second job (T2) with the first job's review (T1) still in the folder: not checked yet (the drawer showed Finish)
  const second = [{ id: 'T2', title: '', owner: 'builder', status: 'done' }];
  const old = { verdict: 'APPROVE', blockers: 0, nits: 4, tasks: ['T1'] };
  assert.equal(teamStep({ plan: ok, tasks: second, review: old }), 'check');
  assert.equal(teamSummary({ plan: ok, tasks: second, review: old }).review, null);
  assert.equal(teamStep({ plan: ok, tasks: second, review: { ...old, tasks: ['T1', 'T2'] } }), 'finish');
  assert.equal(reviewOf(second, { ...old, tasks: [] }).nits, 4, 'a review naming no task counts');
  assert.equal(teamStep({ plan: { ...ok, accepted: true }, tasks: tasks('done'), review: { verdict: 'APPROVE', blockers: 0, nits: 2 } }), 'done');
  // Accepted but a REVISE came after: the check comes first
  assert.equal(teamStep({ plan: { ...ok, accepted: true }, tasks: tasks('done'), review: { verdict: 'REVISE', blockers: 1, nits: 0 } }), 'check');
  const s = teamSummary({ plan: ok, tasks: tasks('done', 'todo', 'doing'), review: null });
  assert.deepEqual([s.step, s.tasks, s.current.id], ['build', { total: 3, todo: 1, doing: 1, done: 1, blocked: 0 }, 'T3'], 'the task being done comes first');
});

test('files: read from .sibersentez only; no folder, a link in its place or a too big file reads as nothing', () => {
  const dir = path.join(ROOT, 'p1');
  fs.mkdirSync(path.join(dir, '.sibersentez'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.sibersentez', 'PLAN.md'), PLAN);
  fs.writeFileSync(path.join(dir, '.sibersentez', 'TASKS.md'), TASKS);
  fs.writeFileSync(path.join(dir, '.sibersentez', 'REVIEW.md'), 'VERDICT: {"verdict":"REVISE","blockers":[],"nits":[]}\n');
  const f = teamFacts(dir);
  assert.deepEqual([f.plan.approved, f.tasks.length, f.review.verdict], [true, 3, 'REVISE']);
  assert.equal(teamFacts(path.join(ROOT, 'none')), null, 'no .sibersentez');
  const linked = path.join(ROOT, 'p2');
  fs.mkdirSync(linked);
  fs.symlinkSync(path.join(dir, '.sibersentez'), path.join(linked, '.sibersentez'), 'junction');
  assert.equal(teamFacts(linked), null, 'a junction is never followed');
  const big = path.join(ROOT, 'p3');
  fs.mkdirSync(path.join(big, '.sibersentez'), { recursive: true });
  fs.writeFileSync(path.join(big, '.sibersentez', 'TASKS.md'), `## T1: x\n- status: done\n${'y'.repeat(300 * 1024)}`);
  assert.deepEqual(teamFacts(big).tasks, [], 'a file over the size limit is not read');
});

test('route body: unknown project 404; a broad or temp folder and a folder without team files say none; a project with files its step', () => {
  const dir = path.join(ROOT, 'p1');
  const projects = { a: { id: 'a', path: dir }, b: { id: 'b', path: path.join(ROOT, 'empty'), tmpOnly: true }, c: { id: 'c', path: path.join(ROOT, 'none') } };
  const catalog = { getProject: (id) => projects[id] || null, isBroad: () => false };
  assert.equal(projectTeam({ catalog, projectId: 'zz' }).status, 404);
  assert.equal(projectTeam({ catalog, projectId: 'b' }).body.step, 'none');
  assert.equal(projectTeam({ catalog, projectId: 'c' }).body.step, 'none');
  const r = projectTeam({ catalog, projectId: 'a' });
  assert.deepEqual([r.status, r.body.step, r.body.current.id, r.body.review.verdict], [200, 'build', 'T2', 'REVISE']);
});
