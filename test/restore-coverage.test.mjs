// What a restore point holds, said where the job is (docs/development-review-2026-10-06.md §4): a full copy, a lean one
// (big files and logs left out) or none, in the job box and the start notice; what a copy never holds in plain sight.
// Run: node --test test/restore-coverage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startPointText, rememberStartPoint, startPointOf, restoreSectionHtml, planHtml } from '../public/js/restore.js';
import { aiStartToast } from '../public/js/views/tools.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the job box sentence: a full copy, a lean one with what it left out, or none', () => {
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    const S = STRINGS[lang];
    assert.equal(startPointText({ id: 'R1', reused: false, scope: 'full', leftOut: 0 }), S.rstStartFull);
    assert.equal(startPointText({ id: 'R1', scope: 'lean', leftOut: 0 }), S.rstStartFull, 'a lean point that left nothing out is a full copy');
    assert.match(startPointText({ id: 'R1', scope: 'lean', leftOut: 12 }), /12/);
    assert.notEqual(startPointText({ id: 'R1', scope: 'lean', leftOut: 12 }), S.rstStartFull);
    assert.equal(startPointText({ problem: 'too-large' }), S.rstStartNone);
    for (const nothing of [null, undefined, 'x', {}, { id: 3 }]) assert.equal(startPointText(nothing), '');
  }
  setLanguage('en');
  // It belongs to the job its start began: the same job shows it, another job of the project (or none) does not
  const J = 'J' + 'e'.repeat(32);
  rememberStartPoint('p1', { id: 'R1', scope: 'full', leftOut: 0 }, J);
  rememberStartPoint('', { id: 'R2' }, J);
  rememberStartPoint('p2', null, J);
  rememberStartPoint('p3', { id: 'R3' });
  assert.equal(startPointOf('p1', J).id, 'R1');
  assert.equal(startPointOf('p1', 'J' + 'f'.repeat(32)), null, 'another job');
  assert.equal(startPointOf('p1'), null, 'no job');
  assert.equal(startPointOf('p2', J), null);
  assert.equal(startPointOf('p3', null), null, 'a start without a job (an idea) is no job\'s point');
});

test('the start notice says a lean copy left something out; a problem is said first; every problem has its reason', () => {
  setLanguage('tr');
  const item = { payload: { projectId: 'p', job: 'x' } };
  const lean = aiStartToast({ ok: true, mode: 'live', terminal: 'dock', restorePoint: { id: 'R1', reused: false, scope: 'lean', leftOut: 7 } }, item);
  assert.equal(lean.tone, 'ok');
  assert.ok(lean.body.includes(STRINGS.tr.aiToastLeanPoint.replace('{count}', '7')));
  const full = aiStartToast({ ok: true, mode: 'live', terminal: 'dock', restorePoint: { id: 'R1', reused: false, scope: 'full', leftOut: 0 } }, item);
  assert.ok(!full.body.includes(STRINGS.tr.aiToastLeanPoint.split('{count}')[0]));
  for (const problem of ['no-hub', 'folder-missing', 'too-large', 'too-many-files']) {
    const w = aiStartToast({ ok: true, mode: 'live', terminal: 'dock', restorePoint: { problem } }, item);
    assert.equal(w.tone, 'warn');
    assert.ok(w.body.includes(STRINGS.tr[`aiNoPoint_${problem}`]), problem);
  }
  // The limits the texts name are the real ones (a lean copy first: 150 MB, 6000 files)
  assert.match(STRINGS.en['aiNoPoint_too-large'], /150 MB/);
  assert.match(STRINGS.en['aiNoPoint_too-many-files'], /6000/);
  assert.match(STRINGS.tr['aiNoPoint_too-large'], /\b150 MB/);
  assert.doesNotMatch(STRINGS.tr['aiNoPoint_too-large'], /(^|[^0-9])50 MB/, 'not the full copy limit any more');
  setLanguage('en');
});

test('the restore section says what a copy never holds in plain sight, not on hover only', () => {
  setLanguage('en');
  const html = restoreSectionHtml({ path: 'C:\\p', exists: true }, { points: [] });
  const never = /<p class="muted small rst-never">([^<]*)<\/p>/.exec(html);
  assert.ok(never, 'its own line');
  assert.ok(never[1].length > 20 && /node_modules/.test(never[1]), 'what a copy never holds, in words');
  assert.ok(!html.includes('title="'), 'no hover-only text');
});

test('the start answer carries what the point holds; the job box shows it with a way to the points', () => {
  const actions = read('server/actions.mjs');
  assert.ok(actions.includes("scope: p.scope === 'lean' ? 'lean' : 'full', leftOut: Number.isInteger(p.leftOut) ? p.leftOut : 0, files: p.files, bytes: p.bytes"));
  assert.ok(actions.includes("if (!hubDir || !isDir(hubDir)) return { problem: 'no-hub' };"), 'no copy without a hub is said, not silent');
  const menu = read('public/js/contextmenu.js');
  assert.ok(menu.includes('restorePoint: r.restorePoint || null, jobId: r.jobId || null'));
  const ws = read('public/js/views/workshop.js');
  assert.ok(ws.includes('startPointText(startPointOf(scene.project.id, job.jobId))'));
  assert.ok(read('public/js/hq-live.js').includes('jobId: d.plan?.jobId || null'));
  assert.ok(actions.includes("if (isLegacyHub(hubDir)) return { problem: 'legacy-hub' };"));
  for (const lang of ['en', 'tr']) assert.ok(STRINGS[lang]['aiNoPoint_legacy-hub'] && STRINGS[lang].wsNoToolTab, lang);
  assert.ok(ws.includes("button('pointOpen', () => dispatch('open-restore'))"));
  for (const lang of ['en', 'tr']) for (const k of ['wsPointOpen']) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
});

test('what a job start kept, in the hub: newest first, one per job, at most twenty, only known fields read back', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { recordJobPoint, listJobPoints, pointsDir, JOB_POINTS_FILE, JOB_POINTS_KEEP } = await import('../server/restore.mjs');
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-jobpoints-'));
  try {
    const J = (n) => 'J' + n.toString(16).padStart(32, '0');
    let clock = 1000;
    const now = () => (clock += 1000);
    assert.equal(recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J(1), point: { id: 'R20261006120000abcd', reused: false, scope: 'lean', leftOut: 3, files: 10, bytes: 99, extra: 'x' }, now }), true);
    assert.equal(recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J(2), point: { problem: 'too-large' }, now }), true);
    assert.deepEqual(listJobPoints({ hubDir: hub, projectId: 'p' }).map((r) => [r.jobId, r.id || r.problem]), [[J(2), 'too-large'], [J(1), 'R20261006120000abcd']]);
    assert.deepEqual(Object.keys(listJobPoints({ hubDir: hub, projectId: 'p' })[1]).sort(), ['at', 'bytes', 'files', 'id', 'jobId', 'leftOut', 'reused', 'scope'], 'nothing else');
    // The same job again replaces its record, and comes first
    recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J(1), point: { id: 'R20261006130000abcd', reused: true, scope: 'full' }, now });
    assert.deepEqual(listJobPoints({ hubDir: hub, projectId: 'p' }).map((r) => r.jobId), [J(1), J(2)]);
    for (let i = 3; i < 30; i++) recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J(i), point: { problem: 'copy-failed' }, now });
    assert.equal(listJobPoints({ hubDir: hub, projectId: 'p' }).length, JOB_POINTS_KEEP);
    // Refused: a bad job id, a bad point, a problem code that is not one, no hub
    assert.equal(recordJobPoint({ hubDir: hub, projectId: 'p', jobId: 'nope', point: { problem: 'x' }, now }), false);
    assert.equal(recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J(99), point: { id: '../x' }, now }), false);
    assert.equal(recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J(99), point: { problem: 'Bad Code!' }, now }), false);
    assert.equal(recordJobPoint({ hubDir: null, projectId: 'p', jobId: J(99), point: { problem: 'x' }, now }), false);
    // A damaged or foreign file reads as nothing, never as data
    const file = path.join(pointsDir(hub, 'p'), JOB_POINTS_FILE);
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(listJobPoints({ hubDir: hub, projectId: 'p' }), []);
    fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: [{ jobId: J(5), at: 1, id: 'R20261006120000abcd', note: '<script>' }, { jobId: '<b>', at: 1, problem: 'x' }] }));
    assert.deepEqual(listJobPoints({ hubDir: hub, projectId: 'p' }).map((r) => r.jobId), [J(5)]);
    assert.equal(listJobPoints({ hubDir: hub, projectId: 'p' })[0].note, undefined);
    assert.deepEqual(listJobPoints({ hubDir: hub, projectId: 'other' }), []);
    // Too big to be a record file: nothing
    fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: [{ jobId: J(6), at: 1, problem: 'x' }], pad: 'x'.repeat(70 * 1024) }));
    assert.deepEqual(listJobPoints({ hubDir: hub, projectId: 'p' }), []);
    // The prune of old points (more than RESTORE_KEEP taken) leaves it alone and clears a half-written one
    recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J(7), point: { problem: 'copy-failed' }, now });
    const leftover = path.join(pointsDir(hub, 'p'), `.${JOB_POINTS_FILE}.0123abcd.tmp`);
    fs.writeFileSync(leftover, '{');
    const { createPoint, RESTORE_KEEP } = await import('../server/restore.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-jobpoints-project-'));
    try {
      for (let i = 0; i <= RESTORE_KEEP + 1; i++) {
        fs.writeFileSync(path.join(dir, 'a.txt'), `v${i}`);
        assert.ok(createPoint({ hubDir: hub, projectId: 'p', dir, now, reuse: false }).ok);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(listJobPoints({ hubDir: hub, projectId: 'p' }).map((r) => r.jobId), [J(7)], 'the record stays');
    assert.ok(!fs.existsSync(leftover), 'a half-written record is cleared');
  } finally {
    fs.rmSync(hub, { recursive: true, force: true });
  }
});

test('the job box asks the server once for a job it did not start, a few times at most, and keeps its own answer', async () => {
  const { askJobPoint, startPointsVersion } = await import('../public/js/restore.js');
  const J = 'J' + 'a'.repeat(32);
  let calls = 0;
  let clock = 0;
  const now = () => clock;
  const fetchFn = async () => (calls++, { points: [{ id: 'R20261006120000abcd' }], jobs: [{ jobId: 'J' + 'b'.repeat(32), id: 'R0' }, { jobId: J, id: 'R20261006120000abcd', scope: 'lean', leftOut: 2 }] });
  const v = startPointsVersion();
  assert.equal(await askJobPoint('q1', J, { fetchFn, now }), true);
  assert.equal(startPointOf('q1', J).id, 'R20261006120000abcd', 'its own record, not another job\'s');
  assert.ok(startPointsVersion() > v, 'the job box draws again');
  assert.equal(askJobPoint('q1', J, { fetchFn, now }), null, 'known and its list fresh: not asked again');
  assert.equal(calls, 1);
  assert.equal(startPointOf('q1', J).available, true);
  // No record (a job started outside the app): asked again after 30 s, four times at most
  const none = async () => (calls++, { points: [], jobs: [] });
  const K = 'J' + 'c'.repeat(32);
  calls = 0;
  for (let i = 0; i < 10; i++) {
    await askJobPoint('q2', K, { fetchFn: none, now });
    await askJobPoint('q2', K, { fetchFn: none, now });
    clock += 31000;
  }
  assert.equal(calls, 4);
  assert.equal(startPointOf('q2', K), null);
  // A failed answer is no record and no error
  assert.equal(await askJobPoint('q3', K, { fetchFn: async () => { throw new Error('offline'); }, now }), false);
  // This page's own start answer stays when the server's arrives later
  const L = 'J' + 'd'.repeat(32);
  let release;
  const slow = () => new Promise((r) => (release = () => r({ points: [], jobs: [{ jobId: L, id: 'R20261006120000ffff' }] })));
  const pending = askJobPoint('q4', L, { fetchFn: slow, now });
  rememberStartPoint('q4', { id: 'R20261006130000aaaa', scope: 'full' }, L);
  release();
  await pending;
  assert.equal(startPointOf('q4', L).id, 'R20261006130000aaaa');
  assert.equal(startPointOf('q4', L).available, false, 'the list that came with it does not hold it');
  for (const bad of [['', J], ['q5', ''], ['q5', null]]) assert.equal(askJobPoint(...bad, { fetchFn, now }), null);
});

test('wiring of the start record: the job box asks for it, a failed copy is recorded too, the job id goes in', () => {
  const ws = read('public/js/views/workshop.js');
  assert.ok(ws.includes("if (mode === 'live' && scene.project.id && scene.job?.jobId) askJobPoint(scene.project.id, scene.job.jobId);"), 'asked on every frame (it asks only when there is something to learn)');
  assert.ok(ws.includes('errKey(), startPointsVersion()]);'), 'drawn again when a record arrives');
  const actions = read('server/actions.mjs');
  assert.ok(actions.includes("point = { problem: 'copy-failed' };"), 'a copy that failed is a record too');
  assert.ok(actions.includes('if (jobId && r?.ok) recordJobPoint({ hubDir, projectId: r.project.id, jobId, point, now });'), 'under the project of the points');
  assert.ok(actions.includes("await takeStartPoint(ctx.pointProjectId, ctx.job || '', jobId)"));
});

test('F2 reproduced: a job start copy pushed out by newer points is no longer promised; the current job keeps its own', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { createPoint, recordJobPoint, projectRestore, pointsDir, RESTORE_KEEP } = await import('../server/restore.mjs');
  const { writeCurrentJob } = await import('../server/job-id.mjs');
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-f2-hub-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-f2-project-'));
  const catalog = { hubDir: hub, getProject: (id) => (id === 'p' ? { id } : null) };
  let clock = Date.UTC(2026, 9, 7, 9, 0, 0);
  const now = () => (clock += 1000);
  const J = 'J' + 'a'.repeat(32);
  const K = 'J' + 'b'.repeat(32);
  try {
    // The job's start copy, then RESTORE_KEEP newer points (resumes, going back) while the job is NOT the current one
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v0');
    const start = createPoint({ hubDir: hub, projectId: 'p', dir, now, reuse: false });
    recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J, point: start, now });
    for (let i = 1; i <= RESTORE_KEEP; i++) {
      fs.writeFileSync(path.join(dir, 'a.txt'), `v${i}`);
      createPoint({ hubDir: hub, projectId: 'p', dir, now, reuse: false });
    }
    let body = projectRestore({ catalog, projectId: 'p' }).body;
    assert.ok(!body.points.some((x) => x.id === start.id), 'pushed out');
    const rec = body.jobs.find((r) => r.jobId === J);
    assert.equal(rec.available, false, 'the record says it is gone');
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      assert.equal(startPointText(rec), STRINGS[lang].rstStartGone, 'no return is promised');
      assert.notEqual(startPointText(rec), STRINGS[lang].rstStartFull);
    }
    setLanguage('en');
    // The current job (its marker) keeps its start copy past RESTORE_KEEP: one point more at most
    fs.mkdirSync(path.join(dir, '.sibersentez'));
    assert.ok(writeCurrentJob(path.join(dir, '.sibersentez'), K).ok);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'k0');
    const kStart = createPoint({ hubDir: hub, projectId: 'p', dir, now, reuse: false });
    recordJobPoint({ hubDir: hub, projectId: 'p', jobId: K, point: kStart, now });
    for (let i = 1; i <= RESTORE_KEEP + 2; i++) {
      fs.writeFileSync(path.join(dir, 'a.txt'), `k${i}`);
      createPoint({ hubDir: hub, projectId: 'p', dir, now, reuse: false });
    }
    body = projectRestore({ catalog, projectId: 'p' }).body;
    assert.equal(body.jobs.find((r) => r.jobId === K).available, true, 'still there for its job');
    assert.equal(body.points.length, RESTORE_KEEP + 1, 'one more at most');
    assert.equal(startPointText(body.jobs.find((r) => r.jobId === K)), STRINGS.en.rstStartFull);
    // Damaged: a manifest that cannot be read takes the point out of the list, and with it the promise
    fs.writeFileSync(path.join(pointsDir(hub, 'p'), kStart.id, 'manifest.json'), '{');
    assert.equal(projectRestore({ catalog, projectId: 'p' }).body.jobs.find((r) => r.jobId === K).available, false);
  } finally {
    fs.rmSync(hub, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the same open page: after newer points the job box stops promising, at once after a start or going back', async () => {
  const { askJobPoint, notePoints, pointsChanged, startPointsVersion, POINTS_FRESH_MS } = await import('../public/js/restore.js');
  const J = 'J' + 'e'.repeat(31) + 'f';
  rememberStartPoint('r1', { id: 'R20261007100000aaaa', scope: 'full', leftOut: 0 }, J);
  notePoints('r1', { points: [{ id: 'R20261007100000aaaa' }] }, 0);
  assert.equal(startPointText(startPointOf('r1', J)), STRINGS.en.rstStartFull);
  // The drawer (or this page's check) lists the points again: the copy is gone
  const v = startPointsVersion();
  notePoints('r1', { points: [{ id: 'R20261007110000bbbb' }] }, 1);
  assert.ok(startPointsVersion() > v, 'the box draws again');
  assert.equal(startPointText(startPointOf('r1', J)), STRINGS.en.rstStartGone);
  // While the list is fresh nothing is asked; once old, the box's own check asks again
  let calls = 0;
  const fetchFn = async () => (calls++, { points: [{ id: 'R20261007100000aaaa' }], jobs: [] });
  assert.equal(askJobPoint('r1', J, { fetchFn, now: () => 2 }), null);
  await askJobPoint('r1', J, { fetchFn, now: () => 2 + POINTS_FRESH_MS });
  assert.equal(calls, 1);
  assert.equal(startPointOf('r1', J).available, true);
  // A start or going back forgets the list: the next frame asks at once
  pointsChanged('r1');
  assert.equal(startPointOf('r1', J).available, undefined, 'not known until asked');
  await askJobPoint('r1', J, { fetchFn, now: () => 3 + POINTS_FRESH_MS });
  assert.equal(calls, 2);
  assert.ok(read('public/js/main.js').includes('pointsChanged(e.detail?.projectId);'), 'a start forgets the list');
  assert.ok(read('public/js/restore.js').includes('cache.delete(projectId);\n      pointsChanged(projectId);'), 'going back too');
  for (const lang of ['en', 'tr']) assert.ok(STRINGS[lang].rstStartGone, lang);
  // A list that cannot be read (a restarting server, no network) is not asked for on every frame: again after 30 s
  pointsChanged('r1');
  let failed = 0;
  const down = async () => {
    failed++;
    throw new Error('offline');
  };
  const t0 = 10 * POINTS_FRESH_MS;
  for (let i = 0; i < 20; i++) await askJobPoint('r1', J, { fetchFn: down, now: () => t0 + i });
  assert.equal(failed, 1, 'one ask in 20 frames');
  await askJobPoint('r1', J, { fetchFn: down, now: () => t0 + POINTS_FRESH_MS });
  assert.equal(failed, 2, 'again after 30 s');
});

test('an answer asked for before a start took its new point does not call that copy gone', async () => {
  const { askJobPoint, pointsChanged, POINTS_FRESH_MS } = await import('../public/js/restore.js');
  const J = 'J' + 'c'.repeat(31) + 'd';
  rememberStartPoint('s1', { id: 'R20261007100000aaaa', scope: 'full' }, J);
  let release;
  const slow = () => new Promise((r) => (release = () => r({ points: [{ id: 'R20261007100000aaaa' }], jobs: [] })));
  const pending = askJobPoint('s1', J, { fetchFn: slow, now: () => 0 });
  // Meanwhile a new start of the same job took a new point (its answer names it); the old list does not hold it
  pointsChanged('s1');
  rememberStartPoint('s1', { id: 'R20261007120000bbbb', scope: 'full' }, J);
  release();
  await pending;
  assert.notEqual(startPointOf('s1', J).available, false, 'the old answer is dropped');
  // The next frame asks for the list of now
  let calls = 0;
  await askJobPoint('s1', J, { fetchFn: async () => (calls++, { points: [{ id: 'R20261007120000bbbb' }], jobs: [] }), now: () => 1 });
  assert.equal(calls, 1);
  assert.equal(startPointOf('s1', J).available, true);
  assert.ok(POINTS_FRESH_MS > 0);
});

test('going back names the project\'s own files and folds the team\'s notes (seen when using the app: style.css among eleven notes)', () => {
  setLanguage('tr');
  const S = STRINGS.tr;
  const plan = { counts: { changed: 3, missing: 0, added: 2 }, notes: { changed: 2, missing: 0, added: 2 }, changed: ['style.css', '.sibersentez/PLAN.md', '.sibersentez/TASKS.md'], missing: [], added: ['.sibersentez/archive/x/PLAN.md', '.sibersentez/job-J1.md'] };
  const h = planHtml(plan);
  assert.ok(h.includes(S.rstChanged.replace('{count}', '1')) && h.includes('style.css'), 'one file of the project goes back');
  assert.ok(!h.includes(S.rstAdded.replace('{count}', '2')) && !h.includes(S.rstAdded.replace('{count}', '0')), 'no list of the project\'s added files: only notes came');
  assert.ok(h.includes('<details class="rst-notes">') && h.includes(S.rstNotes.replace('{count}', '4')), 'the notes folded, counted');
  assert.ok(h.indexOf('style.css') < h.indexOf('.sibersentez/PLAN.md'), 'the project first');
  const only = planHtml({ counts: { changed: 1, missing: 0, added: 0 }, notes: { changed: 1, missing: 0, added: 0 }, changed: ['.sibersentez/PLAN.md'], missing: [], added: [] });
  assert.ok(only.includes(S.rstOnlyNotes), 'only notes: said so');
  const old = planHtml({ counts: { changed: 2, missing: 0, added: 0 }, changed: ['style.css', '.sibersentez/PLAN.md'], missing: [], added: [] });
  assert.ok(old.includes(S.rstChanged.replace('{count}', '2')) && old.includes('.sibersentez/PLAN.md') && !old.includes('rst-notes'), 'an older server: every file as before');
  setLanguage('en');
});
