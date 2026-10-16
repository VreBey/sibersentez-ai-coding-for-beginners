// A folder the scan cannot read (independent review of 0.19.0, N01): a point taken while a folder was unreadable keeps
// it as a boundary, and going back never removes a file under it as "added later"; a folder unreadable now leaves the
// point's files in it alone. The access error is put into one folder only (fs.readdirSync / fs.lstatSync answer
// EACCES for that path, the real call for every other), so the test is the same on every system. Run:
// node --test test/restore-unread.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanProject, createPoint, createPointAsync, listPoints, planRestore, applyRestore, projectRestoreScope, treeFingerprint, projectJobChanges, recordJobPoint, pointsDir } from '../server/restore.mjs';
import { planHtml, scopeHtml } from '../public/js/restore.js';
import { setLanguage } from '../public/js/i18n.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-restore-unread-'));
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
  const catalog = { hubDir: hub, getProject: (id) => (id === 'p' ? { id: 'p', path: dir } : null) };
  return { hub, dir, write, read, catalog, projectId: 'p' };
}
let clock = Date.UTC(2026, 9, 16, 12, 0, 0);
const now = () => (clock += 1000);
const J = 'J' + '0123456789abcdef'.repeat(2);

// While fn runs, the given absolute paths answer EACCES: folders to readdirSync, entries to lstatSync
async function blocked({ dirs = [], entries = [] }, fn) {
  const realReaddir = fs.readdirSync;
  const realLstat = fs.lstatSync;
  const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  const hit = (list, p) => list.some((x) => path.resolve(x) === path.resolve(String(p)));
  fs.readdirSync = /** @type {any} */ (function (p, ...rest) {
    if (hit(dirs, p)) throw eacces();
    return realReaddir.call(this, p, ...rest);
  });
  fs.lstatSync = /** @type {any} */ (function (p, ...rest) {
    if (hit(entries, p)) throw eacces();
    return realLstat.call(this, p, ...rest);
  });
  try {
    return await fn();
  } finally {
    fs.readdirSync = realReaddir;
    fs.lstatSync = realLstat;
  }
}

test('scan: an unreadable folder or entry is said (unread), never taken for an empty one; the project folder itself is a problem', async () => {
  const w = world();
  w.write('index.txt', 'index');
  w.write('source/important.txt', 'original work');
  w.write('a.txt', 'a');
  const scan = await blocked({ dirs: [path.join(w.dir, 'source')], entries: [path.join(w.dir, 'a.txt')] }, () => scanProject(w.dir));
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.files.map((f) => f.rel), ['index.txt']);
  assert.deepEqual(scan.unread, ['a.txt', 'source']);
  assert.deepEqual(scanProject(w.dir).unread, [], 'readable: nothing unread');
  const root = await blocked({ dirs: [w.dir] }, () => scanProject(w.dir));
  assert.deepEqual(root, { ok: false, problem: 'folder-unreadable' }, 'the project folder unreadable: no empty project');
});

test('going back never removes a file a point could not read; the plan says which folders it leaves alone (N01, sync)', async () => {
  const w = world();
  w.write('index.txt', 'index');
  w.write('source/important.txt', 'original work');
  const pt = await blocked({ dirs: [path.join(w.dir, 'source')] }, () => createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now }));
  assert.equal(pt.ok, true);
  assert.equal(pt.files, 1);
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId })[0].unread, 1, 'the list says the point has a gap');
  // The folder readable again, the person changes the index
  w.write('index.txt', 'index, edited');
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: pt.id });
  assert.equal(plan.ok, true);
  assert.deepEqual([plan.changed, plan.missing, plan.added, plan.unread], [['index.txt'], [], [], ['source']]);
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: pt.id, planId: plan.planId, now });
  assert.deepEqual([r.ok, r.restored, r.removed, r.failed], [true, 1, 0, []]);
  assert.equal(w.read('source/important.txt'), 'original work', 'the file the point never saw is still there');
  assert.equal(w.read('index.txt'), 'index');
});

test('the same with the copy taken without holding the server (createPointAsync), and a folder deeper down', async () => {
  const w = world();
  w.write('index.txt', 'index');
  w.write('src/deep/important.txt', 'original work');
  w.write('src/app.js', 'app');
  const pt = await blocked({ dirs: [path.join(w.dir, 'src', 'deep')] }, () => createPointAsync({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now }));
  assert.deepEqual([pt.ok, pt.files], [true, 2]);
  w.write('src/new.js', 'really new');
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: pt.id });
  assert.deepEqual([plan.added, plan.unread], [['src/new.js'], ['src/deep']], 'a file really new is still removed');
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: pt.id, now });
  assert.deepEqual([r.ok, r.removed], [true, 1]);
  assert.equal(w.read('src/deep/important.txt'), 'original work');
  assert.equal(fs.existsSync(path.join(w.dir, 'src', 'new.js')), false);
});

test('a folder unreadable now: the point\'s files in it are neither missing nor written over', async () => {
  const w = world();
  w.write('index.txt', 'index');
  w.write('source/important.txt', 'original work');
  const pt = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now });
  w.write('source/important.txt', 'newer work');
  w.write('index.txt', 'index, edited');
  const source = path.join(w.dir, 'source');
  await blocked({ dirs: [source] }, async () => {
    const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: pt.id });
    assert.deepEqual([plan.changed, plan.missing, plan.added, plan.unread], [['index.txt'], [], [], ['source']]);
    const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: pt.id, now });
    assert.deepEqual([r.ok, r.restored, r.removed], [true, 1, 0]);
  });
  assert.equal(w.read('source/important.txt'), 'newer work', 'what could not be looked at is left as it is');
});

test('a point with a gap is not answered again once the folder can be read: a new, whole copy is taken', async () => {
  const w = world();
  w.write('index.txt', 'index');
  w.write('source/important.txt', 'original work');
  const first = await blocked({ dirs: [path.join(w.dir, 'source')] }, () => createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now }));
  const again = await blocked({ dirs: [path.join(w.dir, 'source')] }, () => createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now }));
  assert.deepEqual([again.reused, again.id], [true, first.id], 'the same gap: the same point');
  const whole = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now });
  assert.deepEqual([whole.reused, whole.files], [false, 2]);
});

test('a manifest naming an unsafe or odd gap is not read (a point written by hand)', () => {
  const w = world();
  w.write('index.txt', 'index');
  const pt = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now });
  const file = path.join(pointsDir(w.hub, w.projectId), pt.id, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(m.version, 2, 'no gap: the version every app reads');
  for (const unread of [['../x'], 'source', [42], [], undefined, Array.from({ length: 201 }, (_, i) => `d${i}`)]) {
    fs.writeFileSync(file, JSON.stringify({ ...m, version: 3, unread }));
    assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId }).length, 0, String(JSON.stringify(unread)).slice(0, 40));
  }
  fs.writeFileSync(file, JSON.stringify({ ...m, unread: ['source'] }));
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId }).length, 0, 'gaps in a version 2 manifest: not read');
  fs.writeFileSync(file, JSON.stringify({ ...m, version: 3, unread: ['source'] }));
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId })[0].unread, 1);
});

test('a point with gaps is written as version 3, so an app that would remove the files under them does not read it', async () => {
  const w = world();
  w.write('index.txt', 'index');
  w.write('source/important.txt', 'original work');
  const pt = await blocked({ dirs: [path.join(w.dir, 'source')] }, () => createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now }));
  const m = JSON.parse(fs.readFileSync(path.join(pointsDir(w.hub, w.projectId), pt.id, 'manifest.json'), 'utf8'));
  assert.deepEqual([m.version, m.unread], [3, ['source']]);
});

test('an entry that could not be looked at (lstat) is kept through the plan and going back', async () => {
  const w = world();
  w.write('index.txt', 'index');
  w.write('notes.txt', 'original notes');
  const pt = await blocked({ entries: [path.join(w.dir, 'notes.txt')] }, () => createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now }));
  w.write('index.txt', 'index, edited');
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: pt.id });
  assert.deepEqual([plan.changed, plan.added, plan.unread], [['index.txt'], [], ['notes.txt']]);
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: pt.id, now });
  assert.deepEqual([r.ok, r.removed], [true, 0]);
  assert.equal(w.read('notes.txt'), 'original notes');
});

test('something deleted while the scan runs is gone, not a gap; too many gaps is no point', async () => {
  const w = world();
  w.write('index.txt', 'index');
  w.write('tmp/x.txt', 'x');
  w.write('swap.tmp', 'x');
  const enoent = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  const realReaddir = fs.readdirSync;
  const realLstat = fs.lstatSync;
  fs.readdirSync = /** @type {any} */ (function (p, ...rest) {
    if (path.resolve(String(p)) === path.join(w.dir, 'tmp')) throw enoent();
    return realReaddir.call(this, p, ...rest);
  });
  fs.lstatSync = /** @type {any} */ (function (p, ...rest) {
    if (path.resolve(String(p)) === path.join(w.dir, 'swap.tmp')) throw enoent();
    return realLstat.call(this, p, ...rest);
  });
  let scan;
  try {
    scan = scanProject(w.dir);
  } finally {
    fs.readdirSync = realReaddir;
    fs.lstatSync = realLstat;
  }
  assert.deepEqual([scan.ok, scan.files.map((f) => f.rel), scan.unread], [true, ['index.txt'], []]);
  const many = world();
  for (let i = 0; i <= 200; i++) many.write(`d${String(i).padStart(3, '0')}/x.txt`, 'x');
  const dirs = Array.from({ length: 201 }, (_, i) => path.join(many.dir, `d${String(i).padStart(3, '0')}`));
  const over = await blocked({ dirs }, () => scanProject(many.dir));
  assert.deepEqual(over, { ok: false, problem: 'folder-unreadable' });
  const at = await blocked({ dirs: dirs.slice(0, 200) }, () => scanProject(many.dir));
  assert.deepEqual([at.ok, at.unread.length], [true, 200], 'up to the limit: a point with its gaps');
});

test('a gap is matched by the project\'s own name keys (a file system that ignores letter case)', async () => {
  const w = world();
  // Only where the file system ignores letter case (Windows, macOS by default)
  if (!fs.existsSync(w.dir.toUpperCase())) return;
  w.write('index.txt', 'index');
  w.write('Source/important.txt', 'original work');
  const pt = await blocked({ dirs: [path.join(w.dir, 'Source')] }, () => createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now }));
  fs.renameSync(path.join(w.dir, 'Source'), path.join(w.dir, 'source'));
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: pt.id });
  assert.deepEqual([plan.added, plan.unread], [[], ['Source']]);
});

test('the scope preview and the fingerprint say an unreadable folder; a start copy\'s changes count its files unknown', async () => {
  const w = world();
  w.write('index.txt', 'index');
  w.write('source/important.txt', 'original work');
  const source = path.join(w.dir, 'source');
  const scope = await blocked({ dirs: [source] }, () => projectRestoreScope({ catalog: w.catalog, projectId: 'p' }));
  assert.deepEqual([scope.body.ok, scope.body.files, scope.body.unread, scope.body.moreUnread], [true, 1, ['source'], 0]);
  assert.deepEqual(projectRestoreScope({ catalog: w.catalog, projectId: 'p' }).body.unread, []);
  const fp = await blocked({ dirs: [source] }, () => treeFingerprint(w.dir, { hubDir: w.hub }));
  assert.deepEqual(fp, { ok: false, problem: 'unreadable' }, 'a fingerprint never claims a folder it could not read');
  // The job's start copy had the gap; the folder's files are not the job's additions
  const pt = await blocked({ dirs: [source] }, () => createPoint({ hubDir: w.hub, projectId: 'p', dir: w.dir, now }));
  assert.equal(recordJobPoint({ hubDir: w.hub, projectId: 'p', jobId: J, point: pt, now }), true);
  const changes = await projectJobChanges({ catalog: w.catalog, projectId: 'p', jobId: J });
  assert.deepEqual([changes.body.added, changes.body.unknown], [[], ['source/important.txt']]);
});

test('the page: the plan names the folders going back leaves alone; the scope preview warns about them', () => {
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    const plan = planHtml({ counts: { changed: 1, missing: 0, added: 0 }, changed: ['index.txt'], missing: [], added: [], unread: ['source'], notes: { changed: 0, missing: 0, added: 0 } });
    assert.match(plan, /rst-unread/);
    assert.match(plan, /<code[^>]*>source<\/code>/);
    const only = planHtml({ counts: { changed: 0, missing: 0, added: 0 }, changed: [], missing: [], added: [], unread: ['source'] });
    assert.match(only, /rst-unread/, 'said even when nothing else would change');
    const scope = scopeHtml({ ok: true, scope: 'full', files: 1, bytes: 5, leftOut: 0, skipped: [], unread: ['source'], moreUnread: 2 });
    assert.match(scope, /job-scope-unread/);
    assert.match(scope, /<details class="job-scope" open>/, 'a gap opens the fold: it is a warning');
    assert.match(scope, /<code[^>]*>source<\/code>/);
  }
  setLanguage('en');
});
