// What changed since a job's start copy (server/restore.mjs projectJobChanges, docs/restore.md §9; the review's
// package 3): this job's changes, not the last 24 hours'; the basis says how far it holds. Run:
// node --test test/job-changes.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPoint, recordJobPoint, projectJobChanges, pointsDir, JOB_CHANGES_MAX } from '../server/restore.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-job-changes-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const J = 'J' + '0123456789abcdef'.repeat(2);
const K = 'J' + 'fedcba9876543210'.repeat(2);
// The copies' clock runs in the past: every file these tests make is born after its job started (as in real use)
let clock = Date.UTC(2020, 0, 1, 9, 0, 0);
const now = () => (clock += 1000);

function setup(name) {
  const hub = path.join(ROOT, name, 'hub');
  const dir = path.join(ROOT, name, 'project');
  fs.mkdirSync(hub, { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const catalog = { hubDir: hub, getProject: (id) => (id === 'p' ? { id: 'p', path: dir } : null) };
  return { hub, dir, catalog };
}
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

test("the job's changes: changed, added and deleted since its start copy; the team's notes counted apart", async () => {
  const { hub, dir, catalog } = setup('a');
  write(dir, 'index.html', '<h1>old</h1>');
  write(dir, 'src/app.js', 'let a = 1;');
  write(dir, 'src/gone.js', 'x');
  write(dir, 'same.txt', 'unchanged');
  const start = createPoint({ hubDir: hub, projectId: 'p', dir, now, reuse: false });
  recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J, point: start, now });
  // The job's work
  write(dir, 'index.html', '<h1>new!</h1>');
  write(dir, 'src/app.js', 'let a = 2;'); // the same size, other bytes
  const later = new Date(Date.now() + 3000);
  fs.utimesSync(path.join(dir, 'src', 'app.js'), later, later); // another change time for sure: its bytes decide
  fs.rmSync(path.join(dir, 'src', 'gone.js'));
  write(dir, 'src/menu.js', 'export {}');
  write(dir, '.sibersentez/PLAN.md', '# Plan');
  const r = await projectJobChanges({ catalog, projectId: 'p', jobId: J });
  assert.equal(r.status, 200);
  assert.equal(r.body.basis, 'start');
  assert.deepEqual([r.body.changed, r.body.added, r.body.deleted], [['index.html', 'src/app.js'], ['src/menu.js'], ['src/gone.js']]);
  assert.equal(r.body.total, 4);
  assert.equal(r.body.notes, 1, 'the plan is a note of the team, not the result');
  assert.equal(r.body.scope, 'full');
  assert.equal(r.body.more, false);
  assert.ok(Number.isFinite(r.body.at));
  // A file touched without a change of its bytes (same size, another time) is not a change
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'same.txt'), t, t);
  assert.ok(!(await projectJobChanges({ catalog, projectId: 'p', jobId: J })).body.changed.includes('same.txt'));
});

test('the basis: no record, no copy, a copy no longer kept, a folder that cannot be read; a bad job id is refused', async () => {
  const { hub, dir, catalog } = setup('b');
  write(dir, 'a.txt', '1');
  assert.equal((await projectJobChanges({ catalog, projectId: 'p', jobId: J })).body.basis, 'no-record');
  recordJobPoint({ hubDir: hub, projectId: 'p', jobId: K, point: { problem: 'too-large' }, now });
  assert.deepEqual((await projectJobChanges({ catalog, projectId: 'p', jobId: K })).body, { project: 'p', jobId: K, basis: 'no-copy', problem: 'too-large' });
  const pt = createPoint({ hubDir: hub, projectId: 'p', dir, now, reuse: false });
  recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J, point: pt, now });
  fs.writeFileSync(path.join(pointsDir(hub, 'p'), pt.id, 'manifest.json'), '{');
  assert.equal((await projectJobChanges({ catalog, projectId: 'p', jobId: J })).body.basis, 'gone');
  assert.equal((await projectJobChanges({ catalog, projectId: 'p', jobId: 'nope' })).status, 400);
  assert.equal((await projectJobChanges({ catalog, projectId: 'other', jobId: J })).status, 404);
  const broad = { hubDir: hub, getProject: () => ({ id: 'p', path: dir, broad: true }) };
  const pt2 = createPoint({ hubDir: hub, projectId: 'p', dir, now, reuse: false });
  recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J, point: pt2, now });
  assert.equal((await projectJobChanges({ catalog: broad, projectId: 'p', jobId: J })).body.basis, 'unreadable');
  assert.equal((await projectJobChanges({ catalog: { getProject: () => ({ id: 'p', path: dir }) }, projectId: 'p', jobId: J })).body.basis, 'no-record', 'no hub');
});

test('a long list is cut, said by more; nothing is written anywhere', async () => {
  const { hub, dir, catalog } = setup('c');
  write(dir, 'keep.txt', 'k');
  const pt = createPoint({ hubDir: hub, projectId: 'p', dir, now, reuse: false });
  recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J, point: pt, now });
  for (let i = 0; i < 5; i++) write(dir, `new/f${i}.txt`, String(i));
  const listBefore = JSON.stringify(fs.readdirSync(pointsDir(hub, 'p')).sort());
  const r = await projectJobChanges({ catalog, projectId: 'p', jobId: J, max: 3 });
  assert.equal(r.body.added.length, 3);
  assert.equal(r.body.total, 5);
  assert.equal(r.body.more, true);
  assert.equal(JSON.stringify(fs.readdirSync(pointsDir(hub, 'p')).sort()), listBefore, 'no point taken, none removed');
  assert.ok(JOB_CHANGES_MAX >= 100);
});

test('the route: GET /api/projects/<id>/job-changes?job=<id>, read-only like the other project reads', () => {
  const app = fs.readFileSync(new URL('../server/app.mjs', import.meta.url), 'utf8');
  assert.ok(app.includes("jobChangesCache({ catalog, projectId: m[1], jobId: url.searchParams.get('job') || '' }).then(") && app.includes('const jobChangesCache = createJobChangesCache();'));
});

test('a lean copy: a file that grew past its limit changed (never "deleted"); one that shrank under it changed (never "new")', async () => {
  const { hub, dir, catalog } = setup('d');
  write(dir, 'data.bin', 'x'.repeat(100));
  write(dir, 'big.bin', 'y'.repeat(3 * 1024 * 1024)); // over the lean limit: left out of the copy
  write(dir, 'keep.txt', 'k');
  // Made a moment before the job's start (its birth time is what tells a left-out file from a new one)
  await new Promise((r) => setTimeout(r, 1300));
  const pt = createPoint({ hubDir: hub, projectId: 'p', dir, reuse: false, scope: 'lean' });
  assert.equal(pt.scope, 'lean');
  recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J, point: pt });
  write(dir, 'data.bin', 'x'.repeat(3 * 1024 * 1024)); // grew past the limit
  write(dir, 'big.bin', 'small now'); // shrank under it
  write(dir, 'fresh.txt', 'new'); // really new
  const r = (await projectJobChanges({ catalog, projectId: 'p', jobId: J })).body;
  assert.equal(r.scope, 'lean');
  assert.deepEqual(r.deleted, [], 'the grown file is still there');
  assert.deepEqual(r.changed, ['big.bin', 'data.bin']);
  assert.deepEqual(r.added, ['fresh.txt']);
});

test('the counts are the whole lists, the names are cut; the sentence says the counts', async () => {
  const { hub, dir, catalog } = setup('e');
  write(dir, 'keep.txt', 'k');
  const pt = createPoint({ hubDir: hub, projectId: 'p', dir, now, reuse: false });
  recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J, point: pt, now });
  for (let i = 0; i < 7; i++) write(dir, `new/f${i}.txt`, String(i));
  const body = (await projectJobChanges({ catalog, projectId: 'p', jobId: J, max: 3 })).body;
  assert.equal(body.added.length, 3);
  assert.deepEqual(body.counts, { changed: 0, added: 7, deleted: 0, unknown: 0 });
  const { jobResultHtml } = await import('../public/js/jobResult.js');
  const { setLanguage, STRINGS } = await import('../public/js/i18n.js');
  setLanguage('en');
  const html = jobResultHtml({ team: { step: 'finish', plan: { title: 'x', jobId: J }, review: null }, changes: body });
  assert.ok(html.includes(STRINGS.en.jrChanges.replace('{changed}', 0).replace('{added}', 7).replace('{deleted}', 0)), '7 new, not 3');
  // Only the team's notes changed: one sentence that does not contradict "nothing changed"
  const notesOnly = jobResultHtml({ team: { step: 'finish', plan: { title: 'x', jobId: J } }, changes: { ...body, changed: [], added: [], deleted: [], counts: { changed: 0, added: 0, deleted: 0 }, total: 0, notes: 2 } });
  assert.ok(notesOnly.includes(STRINGS.en.jrNotesOnly.replace(/’/g, '&#39;').replace(/'/g, '&#39;')) || notesOnly.includes('Only the team'));
  assert.ok(!notesOnly.includes('changed too'));
});

test('the server keeps one comparison per project and job for a few seconds; a refused one is not kept; a request meanwhile waits', async () => {
  const { createJobChangesCache } = await import('../server/restore.mjs');
  let runs = 0;
  let clock = 0;
  const cache = createJobChangesCache({ ttl: 1000, now: () => clock, run: async ({ jobId }) => (runs++, jobId === 'bad' ? { status: 400, body: {} } : { status: 200, body: { runs } }) });
  const [a, b] = await Promise.all([cache({ projectId: 'p', jobId: J }), cache({ projectId: 'p', jobId: J })]);
  assert.equal(runs, 1, 'one comparison for both');
  assert.equal(a, b);
  await cache({ projectId: 'p', jobId: J });
  assert.equal(runs, 1);
  await cache({ projectId: 'p', jobId: K });
  assert.equal(runs, 2, 'another job is its own');
  clock = 2000;
  await cache({ projectId: 'p', jobId: J });
  assert.equal(runs, 3, 'again after ttl');
  await cache({ projectId: 'p', jobId: 'bad' });
  await cache({ projectId: 'p', jobId: 'bad' });
  assert.equal(runs, 5);
  const failing = createJobChangesCache({ run: async () => { throw new Error('x'); } });
  await assert.rejects(failing({ projectId: 'p', jobId: J }));
  await assert.rejects(failing({ projectId: 'p', jobId: J }), 'a failure is not kept');
});

test('Z1 reproduced: the same size and the same time are no proof of the same content (the result and the start copy)', async () => {
  const { hub, dir, catalog } = setup('z1');
  write(dir, 'price.txt', 'price=100');
  const fixed = new Date('2026-10-01T10:00:00Z');
  fs.utimesSync(path.join(dir, 'price.txt'), fixed, fixed);
  const start = createPoint({ hubDir: hub, projectId: 'p', dir, now, reuse: false });
  recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J, point: start, now });
  // Rewritten with the same length, its time kept (a tool that keeps times)
  write(dir, 'price.txt', 'price=900');
  fs.utimesSync(path.join(dir, 'price.txt'), fixed, fixed);
  const r = (await projectJobChanges({ catalog, projectId: 'p', jobId: J })).body;
  assert.deepEqual(r.changed, ['price.txt'], 'the result sees the change');
  // The next start does not answer the old copy again: its bytes differ
  const next = createPoint({ hubDir: hub, projectId: 'p', dir, now });
  assert.equal(next.reused, false);
  assert.notEqual(next.id, start.id);
  const copy = fs.readFileSync(path.join(pointsDir(hub, 'p'), next.id, 'files', 'price.txt'), 'utf8');
  assert.equal(copy, 'price=900', 'the new copy holds what the project holds now');
  // The same for the start's own (async) way
  const { createPointAsync } = await import('../server/restore.mjs');
  write(dir, 'price.txt', 'price=500');
  fs.utimesSync(path.join(dir, 'price.txt'), fixed, fixed);
  const third = await createPointAsync({ hubDir: hub, projectId: 'p', dir, now });
  assert.equal(third.reused, false);
  // Nothing changed at all: the newest copy is answered again, as before
  const again = await createPointAsync({ hubDir: hub, projectId: 'p', dir, now });
  assert.equal(again.reused, true);
  assert.equal(again.id, third.id);
});

test('a file that cannot be read is unknown, never unchanged; the page never says "nothing changed" then', async () => {
  const { hub, dir, catalog } = setup('unread');
  write(dir, 'a.txt', 'one');
  write(dir, 'b.txt', 'two');
  const pt = createPoint({ hubDir: hub, projectId: 'p', dir, now, reuse: false });
  recordJobPoint({ hubDir: hub, projectId: 'p', jobId: J, point: pt, now });
  // b.txt held by another program now: its bytes cannot be read
  const readFile = async (file) => {
    if (file.endsWith('b.txt')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return fs.promises.readFile(file);
  };
  const body = (await projectJobChanges({ catalog, projectId: 'p', jobId: J, readFile })).body;
  assert.deepEqual([body.changed, body.unknown, body.total], [[], ['b.txt'], 0]);
  assert.equal(body.counts.unknown, 1);
  const { jobResultHtml } = await import('../public/js/jobResult.js');
  const { setLanguage, STRINGS } = await import('../public/js/i18n.js');
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    const html = jobResultHtml({ team: { step: 'finish', plan: { title: 'x', jobId: J } }, changes: body });
    const plain = html.replace(/&#39;/g, "'");
    assert.ok(!plain.includes(STRINGS[lang].jrNoChanges), `${lang}: never "nothing changed"`);
    assert.ok(plain.includes(STRINGS[lang].jrNoChangesRead), lang);
    assert.ok(plain.includes(STRINGS[lang].jrUnknown.replace('{count}', 1)), lang);
  }
  setLanguage('en');
});
