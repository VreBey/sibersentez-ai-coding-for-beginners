// Going back after a job made the project bigger than a point's limits (independent review 2026-10-20, T01): the
// moment going back is needed most. Files too big for a copy of the present are left as they are and named; the rest
// goes back. Over a full point's limits the present is kept as a lean point. server/restore.mjs planRestore,
// applyRestore, projectJobChanges; docs/restore.md §14. Hermetic: a temporary hub and project per test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPoint, listPoints, planRestore, applyRestore, recordJobPoint, projectJobChanges, RESTORE_LIMITS, LEAN } from '../server/restore.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-restore-big-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let n = 0;
function world() {
  const base = path.join(TMP, `w${++n}`);
  const hub = path.join(base, 'hub');
  const dir = path.join(base, 'project');
  fs.mkdirSync(hub, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const write = (rel, text) => {
    const f = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  const read = (rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
  const has = (rel) => fs.existsSync(path.join(dir, ...rel.split('/')));
  return { hub, dir, write, read, has, projectId: 'x-big' };
}
let clock = Date.UTC(2026, 9, 20, 9, 0, 0);
const tick = () => (clock += 1000);
// A file over this size is "too big" here, so the tests write bytes, not megabytes
const SMALL = { ...RESTORE_LIMITS, fileBytes: 100 };
const BIG = 'x'.repeat(200);

test('a job wrote a file too big for a copy and broke another: the broken one goes back, the big one stays and is named', async () => {
  const w = world();
  w.write('a.txt', 'good');
  w.write('grown.txt', 'small');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick, limits: SMALL });
  assert.equal(p.ok, true);
  w.write('a.txt', 'broken by AI');
  w.write('big.bin', BIG);
  w.write('grown.txt', BIG); // in the point, too big now: neither written over nor counted missing
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, limits: SMALL });
  assert.equal(plan.ok, true, plan.problem);
  assert.deepEqual([plan.changed, plan.missing, plan.added, plan.big], [['a.txt'], [], [], ['big.bin', 'grown.txt']]);
  assert.equal(plan.beforeScope, 'full');
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, planId: plan.planId, now: tick, limits: SMALL });
  assert.equal(r.ok, true, r.problem);
  assert.deepEqual(r.failed, []);
  assert.equal(w.read('a.txt'), 'good');
  assert.equal(w.read('big.bin'), BIG, 'left as it is');
  assert.equal(w.read('grown.txt'), BIG, 'left as it is');
  // The point of the present holds what it could, and says what it left out
  const before = listPoints({ hubDir: w.hub, projectId: w.projectId }).find((x) => x.id === r.before);
  assert.equal(before.files, 1);
  assert.equal(before.leftOut, 2);
  // Going back to it brings the job's state back, and still leaves the big files alone
  const again = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: r.before, now: tick, limits: SMALL });
  assert.equal(again.ok, true);
  assert.equal(w.read('a.txt'), 'broken by AI');
  assert.equal(w.read('big.bin'), BIG);
});

test("over a full point's limits the present is kept as a lean point: what a lean point leaves out stays and is named", async () => {
  const w = world();
  w.write('a.txt', 'one');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  w.write('a.txt', 'two');
  w.write('b.txt', 'later');
  w.write('run.log', 'a log');
  const limits = { ...RESTORE_LIMITS, files: 2 };
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, limits });
  assert.equal(plan.ok, true, plan.problem);
  assert.equal(plan.beforeScope, 'lean');
  assert.deepEqual([plan.changed, plan.added, plan.big], [['a.txt'], ['b.txt'], ['run.log']]);
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, planId: plan.planId, now: tick, limits });
  assert.equal(r.ok, true, r.problem);
  assert.equal(w.read('a.txt'), 'one');
  assert.equal(w.has('b.txt'), false);
  assert.equal(w.read('run.log'), 'a log', 'a lean copy leaves logs out, so going back never removes one');
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId }).find((x) => x.id === r.before).scope, 'lean');
});

test("over a lean point's limits too: refused before anything is touched, as before", async () => {
  const w = world();
  w.write('a.txt', 'one');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  w.write('a.txt', 'two');
  for (let i = 0; i <= LEAN.files; i++) w.write(`gen/f${i}.txt`, '');
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id });
  assert.deepEqual(plan, { ok: false, problem: 'too-many-files' });
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, now: tick });
  assert.equal(r.ok, false);
  assert.equal(w.read('a.txt'), 'two');
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId }).length, 1, 'no point taken');
});

test("what the job changed is still told when it made the project bigger than a copy's limits", async () => {
  const w = world();
  w.write('a.txt', 'good');
  const start = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick, reuse: false, limits: SMALL });
  const J = 'J' + '0123456789abcdef'.repeat(2);
  recordJobPoint({ hubDir: w.hub, projectId: w.projectId, jobId: J, point: start, now: tick });
  w.write('a.txt', 'broken by AI');
  w.write('big.bin', BIG);
  const catalog = { hubDir: w.hub, getProject: (id) => (id === w.projectId ? { id, path: w.dir } : null) };
  const r = await projectJobChanges({ catalog, projectId: w.projectId, jobId: J, limits: { ...SMALL, files: 1 } });
  assert.equal(r.body.basis, 'start');
  assert.deepEqual([r.body.changed, r.body.added], [['a.txt'], ['big.bin']]);
});

test('the drawer names the files going back leaves alone because they are too big, in both languages', async () => {
  const { planHtml } = await import('../public/js/restore.js');
  const { setLanguage, STRINGS } = await import('../public/js/i18n.js');
  const { esc } = await import('../public/js/format.js');
  for (const L of ['en', 'tr']) {
    setLanguage(L);
    const html = planHtml({ changed: ['a.txt'], missing: [], added: [], unread: [], big: ['big.bin'], counts: { changed: 1, missing: 0, added: 0, unread: 0, big: 3 } });
    assert.ok(html.includes(esc(STRINGS[L].rstBig.replace('{count}', '3'))), L);
    assert.match(html, /big\.bin/);
  }
  setLanguage('en');
});

// Independent review 2026-10-20, T07: Linux allows names a point cannot hold; they are said, never silently unkept
test('a name a point cannot hold (Linux) is listed as left alone; going back never removes it', async (ctx) => {
  if (process.platform === 'win32') return ctx.skip('Windows cannot make such a name');
  const w = world();
  w.write('a.txt', 'good');
  w.write('notes: draft.md', 'mine');
  w.write('what?/x.txt', 'mine too');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  assert.equal(p.ok, true);
  const listed = listPoints({ hubDir: w.hub, projectId: w.projectId })[0];
  assert.equal(listed.files, 1);
  assert.equal(listed.unread, 2);
  w.write('a.txt', 'broken');
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id });
  assert.deepEqual([plan.changed, plan.added, plan.unread], [['a.txt'], [], ['notes: draft.md', 'what?']]);
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, planId: plan.planId, now: tick });
  assert.equal(r.ok, true);
  assert.equal(w.read('notes: draft.md'), 'mine');
  assert.equal(w.read('what?/x.txt'), 'mine too');
});

// Review of the fix (2026-10-20): a name no manifest can keep as a boundary (a path over REL_MAX, a control character,
// a backslash) must never make the manifest unreadable; such a name is skipped as before, the point stays listed
test('a name too long (or odd) even for a boundary is skipped; the point stays listed and usable', async () => {
  const w = world();
  w.write('a.txt', 'good');
  const deep = Array.from({ length: 5 }, (_, i) => `${i}${'d'.repeat(99)}`).join('/');
  w.write(`${deep}/x.txt`, 'deep');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  assert.equal(p.ok, true, p.problem);
  const listed = listPoints({ hubDir: w.hub, projectId: w.projectId });
  assert.deepEqual(listed.map((x) => x.id), [p.id], 'listed');
  w.write('a.txt', 'broken');
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id });
  assert.equal(plan.ok, true, plan.problem);
  assert.deepEqual(plan.changed, ['a.txt']);
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, planId: plan.planId, now: tick });
  assert.equal(r.ok, true);
  assert.equal(w.read('a.txt'), 'good');
  assert.equal(w.read(`${deep}/x.txt`), 'deep', 'never touched');
});

test('a name with a control character or a backslash (Linux) is skipped, never a boundary that breaks the manifest', async (ctx) => {
  if (process.platform === 'win32') return ctx.skip('Windows cannot make such a name');
  const w = world();
  w.write('a.txt', 'good');
  w.write('Icon\r', '');
  w.write('back\\slash.txt', 'x');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  assert.equal(p.ok, true);
  const listed = listPoints({ hubDir: w.hub, projectId: w.projectId });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].unread, 0, 'not kept as boundaries');
});

// Review of the fix (2026-10-20): a lean point's small file that grew past LEAN.fileBytes is out of a lean look; it
// was shown as missing ("brought back") and then failed. It is left alone and named with the big ones
test('a lean point: a file that grew past what a lean look takes is named as left alone, never "brought back"', async () => {
  const w = world();
  w.write('a.txt', 'small');
  w.write('b.txt', 'b1');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick, scope: 'lean' });
  assert.equal(p.scope, 'lean');
  w.write('a.txt', 'x'.repeat(LEAN.fileBytes + 1));
  w.write('b.txt', 'b2');
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id });
  assert.deepEqual([plan.changed, plan.missing, plan.big], [['b.txt'], [], ['a.txt']]);
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, planId: plan.planId, now: tick });
  assert.deepEqual(r.failed, []);
  assert.equal(w.read('b.txt'), 'b1');
  assert.equal(fs.statSync(path.join(w.dir, 'a.txt')).size, LEAN.fileBytes + 1, 'left as it is');
});

test('going back on a drive too full for the copy of the present: disk-full, nothing changed', async () => {
  const { FREE_MARGIN } = await import('../server/restore.mjs');
  const w = world();
  w.write('a.txt', 'good');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  w.write('a.txt', 'broken');
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, now: tick, freeBytes: () => FREE_MARGIN });
  assert.deepEqual(r, { ok: false, problem: 'disk-full' });
  assert.equal(w.read('a.txt'), 'broken');
});
