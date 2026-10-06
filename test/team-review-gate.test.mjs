// Review evidence must cover the whole job before the UI offers its result for acceptance.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVerdict, teamStep, projectTeam } from '../server/team.mjs';

const jobId = 'J' + 'a'.repeat(32);
const plan = { approved: true, accepted: false, jobId };
const tasks = [{ id: 'T1', status: 'done', jobId }, { id: 'T2', status: 'done', jobId }];
const verdict = (value = 'APPROVE', blockers = []) => `Job-ID: ${jobId}\nVERDICT: ${JSON.stringify({ verdict: value, blockers, nits: [] })}\n`;
const step = (text, currentTasks = tasks, currentPlan = plan) => teamStep({ plan: currentPlan, tasks: currentTasks, review: parseVerdict(text) });
const whole = '## Review: whole job\n';

test('task approvals never substitute for the whole-job review, even for one task', () => {
  assert.equal(step('## Review T1\n' + verdict()), 'check');
  assert.equal(step('## Review T1\n' + verdict(), tasks.slice(0, 1)), 'check');
  assert.equal(step('## Review T1, T2\n' + verdict()), 'check');
  assert.equal(step('## Review T1\n' + verdict() + '## Review T2\n' + verdict()), 'check');
  assert.equal(step(verdict()), 'check', 'legacy unscoped approvals cannot finish a job');
  assert.equal(step('## Review: unknown scope\n' + verdict()), 'check');
});

test('an approval for another task cannot hide an earlier blocker or accept the result', () => {
  const text = '## Review T1\n' + verdict('REVISE', ['broken']) + '## Review T2\n' + verdict();
  assert.equal(step(text), 'check');
  assert.equal(step(text, tasks, { ...plan, accepted: true }), 'check');
  assert.deepEqual(parseVerdict(text).tasks, ['T2'], 'the last verdict describes its own task section');
});

test('a valid whole-job review passes; a later task review requires a new whole-job pass', () => {
  const reviewed = '## Review T1, T2\n' + verdict() + whole + '## Findings\nNone\n## Acceptance\nAll met\n## Checks run\nTests passed\n' + verdict();
  assert.equal(step(reviewed), 'finish');
  assert.equal(step(reviewed, tasks, { ...plan, accepted: true }), 'done');
  assert.equal(step(whole + verdict()), 'finish', 'an explicit standalone whole-job review is supported');
  assert.equal(step('## Review of the whole job\r\n' + verdict().replace(/\n/g, '\r\n')), 'finish');
  assert.equal(step(reviewed + '## Review T2\n' + verdict()), 'check');
  assert.equal(step(reviewed + '  ## Review T2\n  ' + verdict()), 'check', 'valid Markdown indentation preserves scope');
  assert.equal(step(reviewed + whole + verdict('REVISE', ['fix this'])), 'check');
  assert.equal(step(reviewed + whole + verdict('APPROVE', ['still broken'])), 'check');
  assert.equal(step(reviewed, [{ id: 'T3', status: 'done', jobId }]), 'check', 'unrelated old review');
  assert.equal(step(reviewed, [...tasks, { id: 'T3', status: 'done', jobId }]), 'check', 'partial overlap is insufficient');
});

test('an incomplete new review or final verdict invalidates the previous approval', () => {
  const approved = whole + verdict();
  for (const tail of [
    'VERDICT:', 'VERDICT: not-json', 'VERDICT: {', 'VERDICT: null', 'VERDICT: []',
    'VERDICT: {"verdict":"APPROVE"}',
    'VERDICT: {"verdict":"APPROVE","blockers":1,"nits":[]}',
    'VERDICT: {"verdict":"APPROVE","blockers":null,"nits":[]}',
    'VERDICT: {"verdict":"APPROVE","blockers":[],"nits":{}}',
    'VERDICT: {"verdict":"MAYBE","blockers":[],"nits":[]}',
    whole, '## Review T2\nWriting the next review',
  ]) {
    assert.equal(step(approved + tail), 'check', tail);
    assert.equal(parseVerdict(approved + tail), null, tail);
  }
});

test('quoted Markdown examples do not count as review evidence', () => {
  for (const fence of ['```', '~~~~']) {
    const example = `${fence}markdown\n${whole}${verdict()}${fence}\n`;
    assert.equal(step(example), 'check');
    assert.equal(step(whole + verdict('REVISE', ['broken']) + example), 'check');
    assert.equal(step(example + whole + verdict()), 'finish');
  }
  assert.equal(step('    ' + whole + '    ' + verdict()), 'check', 'indented code is not an approval');
});

test('whole-job task coverage includes jobs with more than fifty tasks', () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ id: `T${i + 1}`, status: 'done', jobId }));
  const reviewed = many.map((t) => `## Review ${t.id}\n${verdict()}`).join('') + whole + verdict();
  assert.equal(step(reviewed, many), 'finish');
  assert.equal(step(reviewed, [...many, { id: 'T71', status: 'done', jobId }]), 'check');
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-review-gate-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('the project endpoint reads changing review files without retaining a stale approval', () => {
  const dir = path.join(ROOT, 'project');
  const team = path.join(dir, '.sibersentez');
  fs.mkdirSync(team, { recursive: true });
  fs.writeFileSync(path.join(team, 'PLAN.md'), `# Plan: Example\nJob-ID: ${jobId}\nApproved: yes\nResult: accepted\n`);
  fs.writeFileSync(path.join(team, 'TASKS.md'), `# Tasks\nJob-ID: ${jobId}\n## T1: First\n- status: done\n## T2: Second\n- status: done\n`);
  const reviewPath = path.join(team, 'REVIEW.md');
  const catalog = { getProject: () => ({ id: 'p', path: dir }), isBroad: () => false };
  const read = () => projectTeam({ catalog, projectId: 'p' }).body;
  fs.writeFileSync(reviewPath, '## Review T1, T2\n' + verdict());
  assert.equal(read().step, 'check');
  fs.appendFileSync(reviewPath, whole + verdict());
  assert.equal(read().step, 'done');
  fs.appendFileSync(reviewPath, whole + 'VERDICT: {');
  assert.equal(read().step, 'check');
  assert.equal(read().review, null);
});
