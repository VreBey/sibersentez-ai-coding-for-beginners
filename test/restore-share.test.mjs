// Plan D6: a new restore point shares the files it has in common with the newest one (hard links) instead of copying
// them again, and the drawer says what the points take on disk. Every file lives in the system temp folder.
// Run: node --test test/restore-share.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RESTORE_KEEP, applyRestore, createPoint, createPointAsync, listPoints, pointsDir, pointsDisk } from '../server/restore.mjs';
import { diskHtml, sizeText } from '../public/js/restore.js';
import { setLanguage } from '../public/js/i18n.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-restore-share-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let n = 0;
let clock = Date.UTC(2026, 9, 9, 10, 0, 0);
const tick = () => (clock += 1000);

function world() {
  const base = path.join(TMP, `w${++n}`);
  const hub = path.join(base, 'hub');
  const dir = path.join(base, 'site');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(hub, { recursive: true });
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'first\n');
  return { hub, dir, projectId: 'site' };
}
const pointFile = (w, id, rel) => path.join(pointsDir(w.hub, w.projectId), id, 'files', ...rel.split('/'));
const fileId = (p) => {
  const st = fs.statSync(p, { bigint: true });
  return `${st.dev}:${st.ino}`;
};
const linksWork = (() => {
  const a = path.join(TMP, 'probe-a');
  fs.writeFileSync(a, 'x');
  try {
    fs.linkSync(a, path.join(TMP, 'probe-b'));
    return fs.statSync(a, { bigint: true }).ino > 0n;
  } catch {
    return false;
  }
})();

test('an unchanged file is the same file in both points; a changed one is a new copy', { skip: !linksWork && 'no hard links here' }, async () => {
  const w = world();
  const p1 = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  fs.writeFileSync(path.join(w.dir, 'src', 'a.js'), 'second\n');
  const p2 = await createPointAsync({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  assert.equal(p2.reused, false);
  assert.equal(fileId(pointFile(w, p1.id, 'big.bin')), fileId(pointFile(w, p2.id, 'big.bin')), 'shared');
  assert.notEqual(fileId(pointFile(w, p1.id, 'src/a.js')), fileId(pointFile(w, p2.id, 'src/a.js')));
  assert.equal(fs.readFileSync(pointFile(w, p2.id, 'src/a.js'), 'utf8'), 'second\n');
  // On disk: the big file once; the copies apart would hold it twice
  const points = listPoints({ hubDir: w.hub, projectId: w.projectId });
  const disk = await pointsDisk({ hubDir: w.hub, projectId: w.projectId, points });
  assert.equal(disk.apart, 2 * (2 * 1024 * 1024 + 6) + 1);
  assert.equal(disk.bytes, 2 * 1024 * 1024 + 6 + 7);
  // Going back to the first point puts its bytes back and leaves the shared copy as it was
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p1.id, now: tick });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(w.dir, 'src', 'a.js'), 'utf8'), 'first\n');
  assert.equal(fs.readFileSync(pointFile(w, p2.id, 'big.bin')).length, 2 * 1024 * 1024);
  // The project's own file is never one of the hub's: writing it leaves every point alone
  fs.writeFileSync(path.join(w.dir, 'big.bin'), 'changed');
  assert.equal(fs.readFileSync(pointFile(w, p1.id, 'big.bin')).length, 2 * 1024 * 1024);
});

test('pruning the oldest point keeps a file the newer ones share', { skip: !linksWork && 'no hard links here' }, async () => {
  const w = world();
  const first = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  for (let i = 0; i < RESTORE_KEEP; i++) {
    fs.writeFileSync(path.join(w.dir, 'src', 'a.js'), `change ${i}\n`);
    createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  }
  const points = listPoints({ hubDir: w.hub, projectId: w.projectId });
  assert.equal(points.length, RESTORE_KEEP);
  assert.ok(!points.some((x) => x.id === first.id), 'the oldest went');
  for (const x of points) assert.equal(fs.readFileSync(pointFile(w, x.id, 'big.bin')).length, 2 * 1024 * 1024);
  const disk = await pointsDisk({ hubDir: w.hub, projectId: w.projectId, points });
  assert.ok(disk.bytes < 2 * 2 * 1024 * 1024, 'about one copy of the big file');
});

test('an older copy that is not what its manifest says is never linked: the new point gets a fresh copy', () => {
  const w = world();
  const p1 = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  fs.writeFileSync(pointFile(w, p1.id, 'big.bin'), 'damaged');
  fs.writeFileSync(path.join(w.dir, 'src', 'a.js'), 'second\n');
  const p2 = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  assert.equal(fs.readFileSync(pointFile(w, p2.id, 'big.bin')).length, 2 * 1024 * 1024);
  assert.equal(fs.readFileSync(pointFile(w, p1.id, 'big.bin'), 'utf8'), 'damaged', 'the damaged one is left as it was');
});

test('an older copy damaged at the same size is never linked either (review D): its bytes decide', async () => {
  const w = world();
  const p1 = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  const big = pointFile(w, p1.id, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 9));
  fs.writeFileSync(path.join(w.dir, 'src', 'a.js'), 'second\n');
  const p2 = await createPointAsync({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  assert.equal(fs.readFileSync(pointFile(w, p2.id, 'big.bin'))[0], 7, 'the project\'s bytes, not the damaged copy');
  if (linksWork) assert.notEqual(fileId(big), fileId(pointFile(w, p2.id, 'big.bin')));
});

test('the restore answer carries what the points take on disk, counted once per set of points', async () => {
  const { projectRestoreWithDisk } = await import('../server/restore.mjs');
  const w = world();
  const catalog = { hubDir: w.hub, getProject: (id) => (id === w.projectId ? { id, path: w.dir } : null) };
  const none = await projectRestoreWithDisk({ catalog, projectId: w.projectId });
  assert.equal(none.body.disk, undefined, 'no point, no line');
  createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  const one = await projectRestoreWithDisk({ catalog, projectId: w.projectId });
  assert.equal(one.status, 200);
  assert.ok(one.body.disk.bytes >= 2 * 1024 * 1024);
  const points = listPoints({ hubDir: w.hub, projectId: w.projectId });
  assert.equal(pointsDisk({ hubDir: w.hub, projectId: w.projectId, points }), pointsDisk({ hubDir: w.hub, projectId: w.projectId, points }), 'one count');
  assert.equal((await projectRestoreWithDisk({ catalog, projectId: 'nope' })).status, 404);
});

test('the drawer line: the size, and what sharing saved when it is at least 1 MB', () => {
  setLanguage('tr');
  try {
    assert.equal(sizeText(512), '1 KB');
    assert.equal(sizeText(5.5 * 1024 * 1024), '5,5 MB');
    assert.equal(sizeText(150 * 1024 * 1024), '150 MB');
    assert.equal(sizeText(-1), '');
    assert.match(diskHtml({ bytes: 3 * 1024 * 1024, apart: 9 * 1024 * 1024 }), /3 MB yer kaplıyor; değişmeyen dosyalar bir kez saklanıyor \(6 MB kazanç\)/);
    assert.match(diskHtml({ bytes: 3 * 1024 * 1024, apart: 3 * 1024 * 1024 }), /3 MB yer kaplıyor\.</);
    assert.equal(diskHtml(null), '', 'an older server: nothing');
    assert.equal(diskHtml({ bytes: 0 }), '');
    assert.equal(diskHtml({ bytes: '<b>' }), '');
  } finally {
    setLanguage('en');
  }
});
