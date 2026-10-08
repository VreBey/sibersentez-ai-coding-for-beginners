// A moved project's old folder (seen 2026-10-01: a job was started in C:\Users\...\Desktop\arena game, which held
// only .claude, while the game lived on D:). The folder is told apart, the real project is offered, and "Go on" never
// resumes a session that did not run the job.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolsOnly } from '../server/fsutil.mjs';
import { teamFacts } from '../server/team.mjs';
import { stoppedSession, realTwin, toolsOnlyHtml, JOB_SESSION_SLACK_MS } from '../public/js/views/job.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-toolsonly-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const dir = (name, entries) => {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  for (const e of entries) {
    if (e.endsWith('/')) fs.mkdirSync(path.join(d, e), { recursive: true });
    else fs.writeFileSync(path.join(d, e), 'x');
  }
  return d;
};

test('a folder with nothing but AI tools\' setup is told apart; a .git folder or any other file makes it a project; empty is not', () => {
  assert.equal(toolsOnly(dir('old', ['.claude/', '.agents/', '.sibersentez/', 'CLAUDE.md'])), true);
  assert.equal(toolsOnly(dir('repo', ['.claude/', '.git/'])), false, 'a repository');
  assert.equal(toolsOnly(dir('game', ['.claude/', 'Assets/'])), false);
  assert.equal(toolsOnly(dir('notes', ['.claude/', 'notes.txt'])), false);
  assert.equal(toolsOnly(dir('empty', [])), false, 'an empty folder says nothing about a move');
  assert.equal(toolsOnly(path.join(TMP, 'missing')), false);
});

test('the job knows when it last changed (the newest of its files)', () => {
  const d = dir('job', ['.sibersentez/']);
  fs.writeFileSync(path.join(d, '.sibersentez', 'PLAN.md'), '# Plan: x\n\nApproved: yes\n');
  const old = Date.now() - 3600000;
  fs.utimesSync(path.join(d, '.sibersentez', 'PLAN.md'), old / 1000, old / 1000);
  fs.writeFileSync(path.join(d, '.sibersentez', 'HANDOFF.md'), 'next');
  const f = teamFacts(d);
  assert.ok(Math.abs(f.updatedAt - Date.now()) < 60000, 'the handoff written just now');
});

test('"Go on where it stopped" only with a session that ran when the job last changed; the real project with the same name is found', () => {
  const now = Date.now();
  const s = (id, lastAt) => ({ id, projectId: 'd', lastAt, live: null });
  const jobAt = now - 60000;
  assert.equal(stoppedSession([s('old', now - 14 * 3600000)], 'd', now, jobAt), null, 'the project\'s session of yesterday morning did not run this job');
  assert.equal(stoppedSession([s('run', jobAt - JOB_SESSION_SLACK_MS / 2)], 'd', now, jobAt).id, 'run');
  assert.equal(stoppedSession([s('any', now - 14 * 3600000)], 'd', now).id, 'any', 'without a time, as before');

  const projects = [
    { id: 'desk', name: 'arena game', path: 'C:\\Users\\u\\Desktop\\arena game', exists: true, toolsOnly: true },
    { id: 'd', name: 'Arena Game', path: 'D:\\Work\\arena game', exists: true, toolsOnly: false },
    { id: 'gone', name: 'arena game', path: 'E:\\x', exists: false },
  ];
  assert.equal(realTwin(projects, projects[0]).id, 'd', 'same name, real files, the folder is there');
  const html = toolsOnlyHtml(projects[0], realTwin(projects, projects[0]));
  assert.match(html, /data-job-act="open-twin" data-job-twin="d"/);
  assert.match(html, /D:\\Work\\arena game/);
  assert.equal(toolsOnlyHtml(projects[1], null), '', 'a real project says nothing');
});

test('wiring: the drawer, the cards, the Building and its job box', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const drawer = read('public/js/views/drawer.js');
  for (const s of ['${toolsOnlyHtml(p, realTwin(store.projects.values(), p))}', "act === 'open-twin'", 'p.toolsOnly && !toolsOnlyAsked.has(p.id)', 'updatedAt: d.updatedAt ?? null']) assert.ok(drawer.includes(s), s);
  assert.ok(read('public/js/views/projects.js').includes("p.toolsOnly ? t('jobToolsOnlyTag')"));
  const ws = read('public/js/views/workshop.js');
  assert.ok(ws.includes('(list.find((x) => !x.p.toolsOnly) || list[0])?.p'), 'never picked by itself');
  assert.ok(ws.includes('resumeCandidate({ sessions: store.sessions.values(), projectId, job: scene?.job,'), "the job's own time and identity decide");
  assert.ok(read('public/js/main.js').includes('if (p.toolsOnly) {'), 'the job box opens the drawer instead');
  assert.ok(read('server/views.mjs').includes('toolsOnly: !!p.toolsOnly,'));
});
