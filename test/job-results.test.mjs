// The app's own record of a job's result (server/jobResults.mjs, restore.mjs treeFingerprint;
// docs/internal/evidence-card-plan.md E1): the verdict and the acceptance as the app first saw them, the files'
// fingerprint then, and whether the files are still those the verdict was about. Run: node --test test/job-results.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { treeFingerprint, pointsDir, createPoint, RESTORE_LIMITS } from '../server/restore.mjs';
import { observeTeam, observeTeamAnswer, listJobResults, writeJobResult, projectJobResult, jobResultRecord, JOB_RESULTS_FILE, JOB_RESULTS_KEEP, OBSERVE_RETRY_MS } from '../server/jobResults.mjs';
import { reviewFileTime } from '../server/team.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-job-results-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const J = 'J' + '0123456789abcdef'.repeat(2);
const K = 'J' + 'fedcba9876543210'.repeat(2);
const PAST = Date.now() - 3600000;

function setup(name) {
  const hub = path.join(ROOT, name, 'hub');
  const dir = path.join(ROOT, name, 'project');
  fs.mkdirSync(hub, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const catalog = { hubDir: hub, getProject: (id) => (id === 'p' ? { id: 'p', path: dir } : null) };
  return { hub, dir, catalog };
}
const touch = (dir, rel, ms) => fs.utimesSync(path.join(dir, rel), ms / 1000, ms / 1000);
// Written an hour ago unless a time is given: before any verdict these tests see
const write = (dir, rel, text, ms = PAST) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
  if (ms !== null) touch(dir, rel, ms);
};
// A /team answer (team.mjs teamSummary) for a job
const team = (jobId, { verdict = 'APPROVE', scope = 'whole', reviewJob = jobId, step = 'finish', accepted = false, blockers = 0, nits = 0, updatedAt = 1 } = {}) => ({
  step,
  plan: { title: 'Menu', approved: true, accepted, jobId },
  review: verdict ? { verdict, blockers, nits, tasks: ['T1'], scope, jobId: reviewJob } : null,
  updatedAt,
});
let clock = Date.now() - 600000;
const now = () => (clock += 1000);
// A moment later than every write so far: files' change times are real (utimes cannot set them back), so the tests
// wait a little between "before" and "after"
const settle = () => new Promise((r) => setTimeout(r, 40));
const moment = async () => {
  await settle();
  const t = Date.now();
  await settle();
  return t;
};

test('the fingerprint: the restore scan without the team\'s notes; the change time catches a rewrite with its times kept', async () => {
  const { hub, dir } = setup('fp');
  write(dir, 'index.html', '<h1>menu</h1>');
  write(dir, 'src/app.js', 'let a = 1;');
  write(dir, 'node_modules/x/i.js', 'skipped');
  write(dir, '.sibersentez/PLAN.md', '# plan');
  const a = await treeFingerprint(dir, { hubDir: hub });
  assert.deepEqual([a.ok, a.files, a.bytes, a.scope], [true, 2, 23, 'full']);
  assert.match(a.quick, /^[0-9a-f]{64}$/);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  // The team's notes (also .orkestra of older versions) and the skipped folders never change it
  write(dir, '.sibersentez/REVIEW.md', 'VERDICT: {}', null);
  write(dir, '.orkestra/LEDGER.md', '# old', null);
  write(dir, 'node_modules/x/i.js', 'changed', null);
  const b = await treeFingerprint(dir, { hubDir: hub });
  assert.deepEqual([b.quick, b.digest], [a.quick, a.digest]);
  // A rewrite with the same size and write time set back: the change time moved, so quick differs (review Z1), and it
  // counts as written since (its folder does not: no entry was added or removed)
  const t = await moment();
  const st = fs.statSync(path.join(dir, 'src/app.js'));
  fs.writeFileSync(path.join(dir, 'src/app.js'), 'let b = 2;');
  fs.utimesSync(path.join(dir, 'src/app.js'), st.atime, st.mtime);
  const c = await treeFingerprint(dir, { hubDir: hub, after: t });
  assert.notEqual(c.quick, a.quick);
  assert.notEqual(c.digest, a.digest);
  assert.equal(c.writtenSince, 1, 'written after the time given (not necessarily changed)');
  // A file copied in with its old write time, and one deleted: the change time and the folder's time say so
  const t2 = await moment();
  fs.copyFileSync(path.join(dir, 'index.html'), path.join(dir, 'src', 'copy.html'));
  fs.utimesSync(path.join(dir, 'src', 'copy.html'), PAST / 1000, PAST / 1000);
  assert.ok((await treeFingerprint(dir, { hubDir: hub, after: t2 })).writtenSince >= 1, 'a copy keeping its old time');
  fs.rmSync(path.join(dir, 'src', 'copy.html'));
  const t3 = await moment();
  fs.rmSync(path.join(dir, 'src', 'app.js'));
  write(dir, 'src/keep.txt', 'k', null);
  const t4 = await moment();
  fs.rmSync(path.join(dir, 'src', 'keep.txt'));
  write(dir, 'src/other.txt', 'o', PAST);
  assert.ok((await treeFingerprint(dir, { hubDir: hub, after: t4 })).writtenSince >= 1, 'a deletion moves its folder');
  assert.ok(t3 < t4);
  const d = await treeFingerprint(dir, { hubDir: hub, withDigest: false });
  assert.equal('digest' in d, false, 'no file read');
  const e = await treeFingerprint(dir, { hubDir: hub, readFile: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EBUSY' })) });
  assert.equal(e.digest, null, 'a file that cannot be read: no digest, never a wrong "same"');
  assert.deepEqual(await treeFingerprint(path.join(dir, 'missing'), { hubDir: hub }), { ok: false, problem: 'folder-missing' });
  // Over the full limits: the lean scan, as a start's point
  const lean = await treeFingerprint(dir, { hubDir: hub, limits: { ...RESTORE_LIMITS, bytes: 5 } });
  assert.equal(lean.scope, 'lean');
});

test('the record: the plan\'s job\'s whole verdict, once; again when it changes or REVIEW.md is written again; the acceptance once', async () => {
  const { hub, dir } = setup('observe');
  write(dir, 'index.html', 'v1');
  let prints = 0;
  let reviewAt = await moment();
  const fingerprint = async (d, o) => (prints++, treeFingerprint(d, o));
  const obs = (t) => observeTeam({ hubDir: hub, projectId: 'p', dir, team: t, now, fingerprint, reviewTime: () => reviewAt });
  assert.equal((await obs(team(J, { verdict: null, step: 'check' }))).status, 'none', 'no verdict yet');
  assert.equal((await obs(team(J, { scope: 'tasks' }))).status, 'none', 'a task review is not the whole job\'s');
  assert.equal((await obs(team(J, { reviewJob: K }))).status, 'none', 'a verdict of another job');
  assert.equal((await obs({ step: 'plan', plan: { jobId: 'not-a-job' } })).status, 'none');
  const revise = (await obs(team(J, { verdict: 'REVISE', step: 'check', blockers: 2 }))).record;
  assert.deepEqual([revise.verdict.value, revise.verdict.blockers, revise.verdict.reviewAt, revise.tree.files, revise.tree.writtenAfterReview], ['REVISE', 2, reviewAt, 1, 0]);
  assert.equal(prints, 1);
  assert.equal((await obs(team(J, { verdict: 'REVISE', step: 'check', blockers: 2 }))).status, 'none', 'the same verdict again');
  assert.equal(prints, 1, 'no second fingerprint');
  // Round 2 with the same counts: REVIEW.md written again makes it a new verdict
  reviewAt = await moment();
  const round2 = (await obs(team(J, { verdict: 'REVISE', step: 'check', blockers: 2 }))).record;
  assert.ok(round2.verdict.seenAt > revise.verdict.seenAt);
  assert.equal(prints, 2);
  // Fixed: a file written after REVIEW.md, before the app looked, is counted (the review may not have seen it)
  reviewAt = await moment();
  write(dir, 'index.html', 'v2 fixed', null);
  const approve = (await obs(team(J))).record;
  assert.deepEqual([approve.verdict.value, approve.tree.writtenAfterReview], ['APPROVE', 1]);
  assert.equal(approve.acceptedSeenAt, null);
  const done = (await obs(team(J, { step: 'done', accepted: true }))).record;
  assert.ok(done.acceptedSeenAt >= approve.verdict.seenAt);
  assert.equal(done.tree.digest, approve.tree.digest, 'the acceptance keeps the verdict\'s fingerprint');
  assert.equal((await obs(team(J, { step: 'done', accepted: true }))).status, 'none', 'seen once');
  assert.equal(prints, 3);
  // An acceptance line without the done step (the job still waiting) is none
  assert.equal((await obs(team(K, { step: 'finish', accepted: true, verdict: null }))).status, 'none');
  assert.deepEqual(listJobResults({ hubDir: hub, projectId: 'p' }).map((r) => r.jobId), [J]);
});

test('the record keeps the reviewer agents seen with the verdict (answers said before REVIEW.md was written); only known fields', async () => {
  const { hub, dir } = setup('reviewers');
  write(dir, 'index.html', 'v1');
  const reviewAt = await moment();
  const asked = [];
  const reviewers = (jobId, opts) => (asked.push([jobId, opts.before]), { agents: 1, types: ['reviewer', '<b>'], said: 'REVISE', saidAt: reviewAt - 5, lastAt: reviewAt - 5, unknownTools: ['codex'], prompt: 'secret' });
  const obs = (t, r = reviewers) => observeTeam({ hubDir: hub, projectId: 'p', dir, team: t, now, reviewTime: () => reviewAt, reviewers: r });
  const rec = (await obs(team(J))).record;
  assert.deepEqual(asked, [[J, reviewAt]]);
  assert.deepEqual(rec.reviewers, { agents: 1, types: ['reviewer'], said: 'REVISE', saidAt: reviewAt - 5, lastAt: reviewAt - 5, unknownTools: ['codex'], at: rec.verdict.seenAt });
  assert.deepEqual(listJobResults({ hubDir: hub, projectId: 'p' })[0].reviewers, rec.reviewers);
  // The acceptance keeps it; it is asked only with a new verdict
  const done = (await obs(team(J, { step: 'done', accepted: true }))).record;
  assert.deepEqual([asked.length, done.reviewers], [1, rec.reviewers]);
  // No session of the job known, or the log reading failing: nothing kept, the verdict still is
  const { hub: hub2, dir: dir2 } = setup('reviewers-none');
  write(dir2, 'index.html', 'v1');
  for (const r of [() => null, () => { throw new Error('boom'); }]) {
    const none = (await observeTeam({ hubDir: hub2, projectId: 'p', dir: dir2, team: team(K, { verdict: 'REVISE', blockers: asked.length }), now, reviewTime: () => reviewAt, reviewers: r })).record;
    assert.deepEqual([none.verdict.value, none.reviewers], ['REVISE', null]);
    asked.push(0);
  }
  // The log reading ready later (the first scan had not read the agents yet): the next look keeps them, once
  const later = (await observeTeam({ hubDir: hub2, projectId: 'p', dir: dir2, team: team(K, { verdict: 'REVISE', blockers: 2 }), now, reviewTime: () => reviewAt, reviewers })).record;
  assert.deepEqual([later.reviewers?.agents, later.reviewers?.said, asked.at(-1)], [1, 'REVISE', [K, reviewAt]]);
  assert.equal((await observeTeam({ hubDir: hub2, projectId: 'p', dir: dir2, team: team(K, { verdict: 'REVISE', blockers: 2 }), now, reviewTime: () => reviewAt, reviewers })).status, 'none');
  assert.equal(jobResultRecord({ jobId: J, verdict: { value: 'APPROVE', seenAt: 1 }, reviewers: { agents: 1, said: 'MAYBE', at: 1 } }).reviewers.said, null);
  assert.equal(jobResultRecord({ jobId: J, verdict: { value: 'APPROVE', seenAt: 1 }, reviewers: { agents: 1 } }).reviewers, null, 'no time: not read');
});

test('a fingerprint that failed or could not read a file: said in the record, and the unread one is tried again', async () => {
  const { hub, dir } = setup('retry');
  write(dir, 'a.txt', 'x');
  const thrown = await observeTeam({ hubDir: hub, projectId: 'p', dir, team: team(J), now, fingerprint: async () => Promise.reject(new Error('boom')), reviewTime: () => null });
  assert.deepEqual(Object.keys(thrown.record.tree), ['problem', 'at']);
  assert.equal(thrown.record.tree.problem, 'unreadable');
  const { hub: hub2, dir: dir2 } = setup('retry2');
  write(dir2, 'a.txt', 'x');
  let locked = true;
  const fingerprint = (d, o) => treeFingerprint(d, { ...o, readFile: locked ? async () => Promise.reject(new Error('EBUSY')) : fs.promises.readFile });
  const first = await observeTeam({ hubDir: hub2, projectId: 'p', dir: dir2, team: team(J), now, fingerprint, reviewTime: () => null });
  assert.equal(first.record.tree.digest, null);
  locked = false;
  const again = await observeTeam({ hubDir: hub2, projectId: 'p', dir: dir2, team: team(J), now, fingerprint, reviewTime: () => null });
  assert.equal(again.status, 'written');
  assert.match(again.record.tree.digest, /^[0-9a-f]{64}$/);
  assert.equal(again.record.verdict.seenAt, first.record.verdict.seenAt, 'the same verdict, its fingerprint completed');
});

test('one look per project at a time: a second one meanwhile is busy, and the next look catches up', async () => {
  const { hub, dir } = setup('busy');
  write(dir, 'a.txt', 'x');
  let release;
  const slow = (d, o) => new Promise((r) => (release = () => r(treeFingerprint(d, o))));
  const a = observeTeam({ hubDir: hub, projectId: 'p', dir, team: team(J, { verdict: 'REVISE', blockers: 1 }), now, fingerprint: slow, reviewTime: () => null });
  const b = await observeTeam({ hubDir: hub, projectId: 'p', dir, team: team(J), now, reviewTime: () => null });
  assert.equal(b.status, 'busy');
  release();
  assert.equal((await a).record.verdict.value, 'REVISE');
  const c = await observeTeam({ hubDir: hub, projectId: 'p', dir, team: team(J), now, reviewTime: () => null });
  assert.equal(c.record.verdict.value, 'APPROVE', 'compared with the record, the skipped verdict is kept now');
});

test('after a /team answer: no disk work unless there is something to keep and the team\'s files changed; a failed look is tried later', () => {
  const { hub, catalog } = setup('answer');
  const calls = [];
  const memo = new Map();
  let t = 1000;
  let answer = { status: 'written', record: { tree: { quick: 'q', digest: 'd' } } };
  const observe = async (args) => (calls.push(args.team.updatedAt), answer);
  const run = (tm) => observeTeamAnswer({ catalog, projectId: 'p', team: tm, now: () => t, schedule: (fn) => fn(), memo, observe });
  run(team(J, { verdict: null, step: 'check' }));
  assert.equal(calls.length, 0, 'nothing to keep: not even the gate');
  run(team(J, { updatedAt: 5 }));
  assert.equal(calls.length, 1);
  return Promise.resolve().then(() => {
    run(team(J, { updatedAt: 5 }));
    assert.equal(calls.length, 1, 'the same answer again: nothing read');
    run(team(J, { updatedAt: 6 }));
    assert.equal(calls.length, 2, 'a team file changed: looked again');
    answer = { status: 'failed', record: null };
    run(team(J, { updatedAt: 7 }));
    assert.equal(calls.length, 3);
    return Promise.resolve().then(() => {
      run(team(J, { updatedAt: 7 }));
      assert.equal(calls.length, 3, 'a failed look waits');
      t += OBSERVE_RETRY_MS;
      run(team(J, { updatedAt: 7 }));
      assert.equal(calls.length, 4, 'and is tried again later');
      // The gate: a hub of the old layout is never written to
      fs.mkdirSync(path.join(hub, 'kutuphane'), { recursive: true });
      run(team(J, { updatedAt: 8 }));
      assert.equal(calls.length, 4);
    });
  });
});

test('after a /team answer: the log reading getting ready is a reason to look again (the reviewer agents it could not know)', () => {
  const { catalog } = setup('answer-ready');
  const calls = [];
  const memo = new Map();
  const observe = async (args) => (calls.push(args.reviewers?.() ?? 'none'), { status: 'none', record: null });
  const run = (logsReady) => observeTeamAnswer({ catalog, projectId: 'p', team: team(J, { updatedAt: 5 }), now: () => 1000, schedule: (fn) => fn(), memo, observe, reviewers: () => 'asked', logsReady });
  run(false);
  return Promise.resolve().then(() => {
    run(false);
    assert.deepEqual(calls, ['asked'], 'the same answer, still scanning: nothing read');
    run(true);
    assert.deepEqual(calls, ['asked', 'asked'], 'ready now: looked again, with the reviewers to ask');
  });
});

test('the file: newest first, one per job, at most a few; only known fields and this version read back', () => {
  const { hub } = setup('file');
  for (let i = 0; i < JOB_RESULTS_KEEP + 3; i++) {
    const jobId = 'J' + i.toString(16).padStart(32, '0');
    assert.equal(writeJobResult({ hubDir: hub, projectId: 'p', record: { jobId, verdict: { value: 'APPROVE', blockers: 0, nits: 1, seenAt: 1000 + i }, tree: { problem: 'too-large', at: 1000 + i } } }), true);
  }
  const list = listJobResults({ hubDir: hub, projectId: 'p' });
  assert.equal(list.length, JOB_RESULTS_KEEP);
  assert.equal(list[0].jobId, 'J' + (JOB_RESULTS_KEEP + 2).toString(16).padStart(32, '0'));
  assert.deepEqual(list[0].tree, { problem: 'too-large', at: 1000 + JOB_RESULTS_KEEP + 2 });
  assert.equal(jobResultRecord({ jobId: 'x' }), null);
  assert.deepEqual(jobResultRecord({ jobId: J, verdict: { value: 'MAYBE', seenAt: 1 }, tree: { quick: 'x' }, extra: '<b>' }), { jobId: J, verdict: null, tree: null, reviewers: null, acceptedSeenAt: null });
  assert.equal(writeJobResult({ hubDir: hub, projectId: 'p', record: { jobId: 'bad' } }), false);
  const file = path.join(pointsDir(hub, 'p'), JOB_RESULTS_FILE);
  const keep = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, keep.replace('"version":1', '"version":2'));
  assert.deepEqual(listJobResults({ hubDir: hub, projectId: 'p' }), [], 'another version is not read');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(listJobResults({ hubDir: hub, projectId: 'p' }), []);
  fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: [] }) + ' '.repeat(70 * 1024));
  assert.deepEqual(listJobResults({ hubDir: hub, projectId: 'p' }), []);
});

test('still the files of the verdict: same, touched with the same content, changed (with how many written since), unknown and why', async () => {
  const { hub, dir, catalog } = setup('fresh');
  write(dir, 'index.html', 'menu');
  write(dir, 'style.css', 'body{}');
  write(dir, '.sibersentez/PLAN.md', '# plan'); // the team's folder is there before its review
  let reviewAt = await moment();
  const observe = (tm) => observeTeam({ hubDir: hub, projectId: 'p', dir, team: tm, now: () => Date.now(), reviewTime: () => reviewAt });
  await observe(team(J));
  await settle();
  let fullReads = 0;
  const counting = (d, o) => ((o.withDigest !== false && fullReads++), treeFingerprint(d, o));
  const ask = () => projectJobResult({ catalog, projectId: 'p', jobId: J, fingerprint: counting });
  let r = await ask();
  assert.equal(r.status, 200);
  assert.equal(r.body.fresh, 'same');
  assert.equal(r.body.record.verdict.value, 'APPROVE');
  assert.equal(fullReads, 0, 'nothing written: no file read');
  // The team writes its notes after the review: still the same
  write(dir, '.sibersentez/LEDGER.md', '# done', null);
  assert.equal((await ask()).body.fresh, 'same');
  touch(dir, 'index.html', Date.now() + 5000);
  assert.equal((await ask()).body.fresh, 'same-content');
  write(dir, 'index.html', 'menu with prices', null);
  r = await ask();
  assert.deepEqual([r.body.fresh, r.body.writtenSince], ['changed', 1]);
  const reads = fullReads;
  assert.equal((await ask()).body.fresh, 'changed');
  assert.equal(fullReads, reads, 'nothing more written: the answer is kept, no file read again');
  // A file rewritten with its size and write time kept is a change (review Z1)
  write(dir, 'index.html', 'menu', null);
  reviewAt = await moment();
  await observe(team(J, { nits: 1 }));
  await settle();
  assert.equal((await ask()).body.fresh, 'same');
  const st = fs.statSync(path.join(dir, 'style.css'));
  fs.writeFileSync(path.join(dir, 'style.css'), 'body{x');
  fs.utimesSync(path.join(dir, 'style.css'), st.atime, st.mtime);
  assert.equal((await ask()).body.fresh, 'changed');
  fs.rmSync(path.join(dir, 'style.css'));
  r = await ask();
  assert.equal(r.body.fresh, 'changed');
  assert.ok(r.body.writtenSince >= 1, 'a deletion moves the project folder\'s time');
  assert.deepEqual((await projectJobResult({ catalog, projectId: 'p', jobId: K })).body, { project: 'p', jobId: K, record: null, fresh: 'unknown', reason: 'no-record' });
  assert.equal((await projectJobResult({ catalog, projectId: 'p', jobId: 'bad' })).status, 400);
  assert.equal((await projectJobResult({ catalog, projectId: 'other', jobId: J })).status, 404);
});

test('written, renamed or deleted after REVIEW.md, before the app looked; or REVIEW.md\'s time unknown: never "same"', async () => {
  const { hub, dir, catalog } = setup('gap');
  write(dir, 'src/app.js', 'reviewed');
  write(dir, 'src/test.js', 'reviewed');
  write(dir, '.sibersentez/REVIEW.md', 'VERDICT', null);
  const reviewAt = reviewFileTime(dir);
  assert.ok(reviewAt > 0);
  await settle();
  // After the review the AI deletes a failing test; the app looks later
  fs.rmSync(path.join(dir, 'src', 'test.js'));
  const rec = (await observeTeam({ hubDir: hub, projectId: 'p', dir, team: team(J), now: () => Date.now() })).record;
  assert.equal(rec.verdict.reviewAt, reviewAt);
  assert.ok(rec.tree.writtenAfterReview >= 1, 'the deletion moved its folder');
  const r = (await projectJobResult({ catalog, projectId: 'p', jobId: J })).body;
  assert.deepEqual([r.fresh, r.reason], ['unknown', 'written-before-seen']);
  // The only file of a folder deleted (review round 3): the emptied folder still counts
  const one = setup('gap-one');
  write(one.dir, 'src/app.js', 'reviewed');
  write(one.dir, 'test/menu.test.js', 'reviewed');
  write(one.dir, 'index.html', 'reviewed');
  write(one.dir, '.sibersentez/REVIEW.md', 'VERDICT', null);
  await settle();
  fs.rmSync(path.join(one.dir, 'test', 'menu.test.js'));
  const oneRec = (await observeTeam({ hubDir: one.hub, projectId: 'p', dir: one.dir, team: team(J), now: () => Date.now() })).record;
  assert.equal(oneRec.tree.files, 2);
  assert.ok(oneRec.tree.writtenAfterReview >= 1, 'the emptied test folder');
  assert.equal((await projectJobResult({ catalog: one.catalog, projectId: 'p', jobId: J })).body.reason, 'written-before-seen');
  // REVIEW.md gone before the app looked: the gap cannot be measured
  const { hub: hub2, dir: dir2, catalog: catalog2 } = setup('gap2');
  write(dir2, 'a.txt', 'x');
  await observeTeam({ hubDir: hub2, projectId: 'p', dir: dir2, team: team(J), now: () => Date.now() });
  assert.deepEqual([(await projectJobResult({ catalog: catalog2, projectId: 'p', jobId: J })).body.fresh, (await projectJobResult({ catalog: catalog2, projectId: 'p', jobId: J })).body.reason], ['unknown', 'no-review-time']);
});

test('a project no fingerprint can be taken for: the record says why, freshness is unknown with that reason', async () => {
  const { hub, dir, catalog } = setup('deep');
  write(dir, 'a/b/c.txt', 'deep');
  const fingerprint = (d, o) => treeFingerprint(d, { ...o, limits: { ...RESTORE_LIMITS, depth: 0 } });
  const rec = (await observeTeam({ hubDir: hub, projectId: 'p', dir, team: team(J), now, fingerprint, reviewTime: () => null })).record;
  assert.equal(rec.tree.problem, 'too-deep');
  assert.deepEqual([(await projectJobResult({ catalog, projectId: 'p', jobId: J })).body.fresh, (await projectJobResult({ catalog, projectId: 'p', jobId: J })).body.reason], ['unknown', 'too-deep']);
});

test('pruning the restore points keeps the record and removes a record left half-written', () => {
  const { hub, dir } = setup('prune');
  write(dir, 'a.txt', 'x');
  assert.equal(writeJobResult({ hubDir: hub, projectId: 'p', record: { jobId: J, verdict: { value: 'APPROVE', seenAt: 1 }, tree: { problem: 'too-large', at: 1 } } }), true);
  const base = pointsDir(hub, 'p');
  fs.writeFileSync(path.join(base, `.${JOB_RESULTS_FILE}.0123abcd.tmp`), '{');
  assert.equal(createPoint({ hubDir: hub, projectId: 'p', dir, reuse: false }).ok, true);
  assert.equal(fs.existsSync(path.join(base, `.${JOB_RESULTS_FILE}.0123abcd.tmp`)), false);
  assert.equal(listJobResults({ hubDir: hub, projectId: 'p' }).length, 1);
});
