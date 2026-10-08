// Which session may go on with a job (docs/development-plan-2026-10-07.md F1): the Building, its next step and the
// drawer share job.js resumeCandidate; an open tool in SiberSentez's terminal, the job's own tool and the job named
// in a session's first prompt decide before the time window. Run: node --test test/resume.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resumeCandidate, sessionJobId, JOB_SESSION_SLACK_MS } from '../public/js/views/job.js';
import { toolActors } from '../public/js/hq-scene.js';
import { nextStep } from '../public/js/nextStep.js';
import { Ingest } from '../server/ingest.mjs';
import { launchPrompt } from '../server/launch.mjs';
import { jobMessageName } from '../server/job-id.mjs';
import { sessionView } from '../server/views.mjs';

const NOW = 1_800_000_000_000;
const J = 'J' + 'a'.repeat(32);
const K = 'J' + 'b'.repeat(32);
const closed = (id, over = {}) => ({ id, projectId: 'p', lastAt: NOW - 60000, live: null, ...over });
const job = (over = {}) => ({ step: 'build', jobId: J, tool: null, updatedAt: NOW, ...over });

test('F1 reproduced: a recently closed Claude session and an open Codex terminal: no resume, the next step is the open terminal', () => {
  const sessions = [closed('old-claude')];
  const dock = [{ projectId: 'p', tool: 'codex' }];
  const candidate = resumeCandidate({ sessions, projectId: 'p', now: NOW, job: job(), dock });
  assert.equal(candidate, null, 'the old Claude session is not offered');
  const actors = toolActors({ id: 'p', toolSeen: {} }, NOW, dock);
  assert.deepEqual(actors.map((a) => [a.tool, a.state]), [['codex', 'running']]);
  const next = nextStep({ stopped: !!candidate, running: actors.some((a) => a.state === 'running') });
  assert.deepEqual(next, { key: 'running', act: 'show-terminal' });
  // Gemini (or any other AI tool) open the same way: the same answer
  assert.equal(resumeCandidate({ sessions, projectId: 'p', now: NOW, job: job(), dock: [{ projectId: 'p', tool: 'gemini' }] }), null);
});

test("another project's open terminal does not hide this project's stopped session", () => {
  const s = resumeCandidate({ sessions: [closed('old-claude')], projectId: 'p', now: NOW, job: job({ jobId: null }), dock: [{ projectId: 'other', tool: 'codex' }] });
  assert.equal(s?.id, 'old-claude');
});

test('a session that names this job goes on with it; a session that names another job never does', () => {
  assert.equal(sessionJobId({ jobId: J }), J);
  assert.equal(sessionJobId({ jobId: 'J•••' }), null);
  assert.equal(sessionJobId({ firstPrompt: `Please read .sibersentez/job-${J}.md` }), null, 'only the server reads it (before redaction)');
  assert.equal(sessionJobId({}), null);
  // The job's own session, even long after the job's last change (the job file names it)
  const own = closed('own', { jobId: J, lastAt: NOW - 3 * JOB_SESSION_SLACK_MS });
  assert.equal(resumeCandidate({ sessions: [own], projectId: 'p', now: NOW, job: job() })?.id, 'own');
  // A newer session of an earlier job is not this job's, even inside the time window
  const other = closed('other', { jobId: K, lastAt: NOW - 1000 });
  assert.equal(resumeCandidate({ sessions: [other], projectId: 'p', now: NOW, job: job() }), null);
  assert.equal(resumeCandidate({ sessions: [own, other], projectId: 'p', now: NOW, job: job() })?.id, 'own', 'the named one, not the newest');
});

test("a job another tool started never offers a Claude session; the job's own Claude start does", () => {
  const s = closed('claude-by-hand');
  assert.equal(resumeCandidate({ sessions: [s], projectId: 'p', now: NOW, job: job({ tool: 'codex' }) }), null);
  assert.equal(resumeCandidate({ sessions: [s], projectId: 'p', now: NOW, job: job({ tool: 'gemini-cli' }) }), null);
  assert.equal(resumeCandidate({ sessions: [s], projectId: 'p', now: NOW, job: job({ tool: 'claude' }) })?.id, 'claude-by-hand');
});

test('the conservative fallback for a session that names no job: only around the job\'s last change; nothing while one runs; nothing for a finished job', () => {
  const inWindow = closed('hand', { lastAt: NOW - JOB_SESSION_SLACK_MS + 60000 });
  const tooOld = closed('hand', { lastAt: NOW - JOB_SESSION_SLACK_MS - 60000 });
  assert.equal(resumeCandidate({ sessions: [inWindow], projectId: 'p', now: NOW, job: job({ jobId: null }) })?.id, 'hand', 'a job from before job ids');
  assert.equal(resumeCandidate({ sessions: [tooOld], projectId: 'p', now: NOW, job: job({ jobId: null }) }), null);
  const live = { id: 'now', projectId: 'p', lastAt: NOW, live: { status: 'busy' } };
  assert.equal(resumeCandidate({ sessions: [inWindow, live], projectId: 'p', now: NOW, job: job() }), null, 'a session still runs');
  assert.equal(resumeCandidate({ sessions: [inWindow], projectId: 'p', now: NOW, job: job({ step: 'done' }) }), null);
  assert.equal(resumeCandidate({ sessions: [inWindow], projectId: 'p', now: NOW, job: null }), null, 'no job');
  assert.equal(resumeCandidate({ sessions: [], projectId: 'p', now: NOW, job: job() }), null);
});

test('one rule for the Building, its next step and the drawer', () => {
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const ws = read('public/js/views/workshop.js');
  const drawer = read('public/js/views/drawer.js');
  assert.ok(ws.includes('resumeCandidate({ sessions: store.sessions.values(), projectId, job: scene?.job, dock: store.dockRunning?.() || [] })'));
  assert.ok(drawer.includes('resumeCandidate({ sessions: store.sessions.values(), projectId, job: shown, dock: store.dockRunning?.() || [] })'));
  assert.ok(!ws.includes('stoppedSession(') && !drawer.includes('stoppedSession('), 'nobody asks the old, session-only rule directly');
});

test('the server reads the job from the raw first prompt: redaction masks the id in the text, not the session\'s job', () => {
  const catalog = { resolve: () => 'p', getProject: () => null, allProjects: () => [], roster: new Map() };
  // A real id: random hex, letters and digits (what redact takes for a secret)
  const RJ = 'J' + '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
  const ing = new Ingest(catalog);
  ing.cutoff = 0;
  const s = ing.getSession('s-job', null);
  const user = (content) => ({ parentUuid: 'x', isSidechain: false, type: 'user', message: { role: 'user', content }, timestamp: '2026-10-07T10:00:01Z', cwd: 'C:/p' });
  const feed = (ctx, obj) => { const buf = Buffer.from(JSON.stringify(obj)); ing.line(ctx, {}, buf, 0, buf.length); };
  feed(s, user(launchPrompt(jobMessageName(RJ))));
  feed(s, user(`now also read job-${K}.md`));
  assert.equal(s.jobId, RJ, 'the first prompt only');
  assert.ok(!s.firstPrompt.includes(RJ), 'the shown text stays redacted (the id would be lost there)');
  assert.equal(sessionJobId(sessionView(ing, s)), RJ, 'the page gets it');
  const hand = ing.getSession('s-hand', null);
  feed(hand, user('make me a site'));
  assert.equal(sessionJobId(sessionView(ing, hand)), null);
});
