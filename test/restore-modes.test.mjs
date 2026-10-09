// Review 2026-10 F02 and F03 (server/restore.mjs): a point keeps a file's Unix permissions (a script stays runnable, a
// private file stays private, in the project and in the hub), and on a case-sensitive file system (Linux) README.md
// and readme.md are two files to the plan. Hermetic: a temporary hub and project per test.
// Run: node --test test/restore-modes.test.mjs (the Unix parts run on Linux and macOS; WSL covers them from Windows)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPoint, listPoints, planRestore, applyRestore, pointsDir } from '../server/restore.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-restore-modes-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const unix = process.platform !== 'win32';
// The file system of the temporary folder: does it tell a.txt and A.txt apart?
const caseSensitive = (() => {
  const probe = path.join(TMP, 'case-probe');
  fs.writeFileSync(probe, '');
  try {
    return !fs.existsSync(path.join(TMP, 'CASE-PROBE'));
  } finally {
    fs.rmSync(probe);
  }
})();
let n = 0;
function world() {
  const base = path.join(TMP, `w${++n}`);
  const hub = path.join(base, 'hub');
  const dir = path.join(base, 'project');
  fs.mkdirSync(hub, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = (rel) => path.join(dir, ...rel.split('/'));
  const write = (rel, text, mode) => {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), text);
    if (mode !== undefined) fs.chmodSync(file(rel), mode);
  };
  const modeOf = (p) => fs.statSync(p).mode & 0o777;
  const manifestFile = (id) => path.join(pointsDir(hub, 'x-demo-app'), id, 'manifest.json');
  const editManifest = (id, fn) => {
    const m = JSON.parse(fs.readFileSync(manifestFile(id), 'utf8'));
    fs.writeFileSync(manifestFile(id), JSON.stringify(fn(m) || m));
  };
  return { hub, dir, file, write, modeOf, manifestFile, editManifest, projectId: 'x-demo-app' };
}
let clock = Date.UTC(2026, 9, 9, 12, 0, 0);
const tick = () => (clock += 1000);
const point = (w) => createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
const plan = (w, id) => planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id });
const restore = (w, id) => applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id, now: tick });

test('F02: a runnable script and a private file come back with their permissions; deleted or rewritten', { skip: !unix && 'Unix permissions only' }, async () => {
  const w = world();
  w.write('run.sh', '#!/bin/sh\necho hi\n', 0o755);
  w.write('.env', 'KEY=1\n', 0o600);
  w.write('index.html', 'v1', 0o644);
  const p = point(w);
  assert.equal(p.ok, true);
  fs.rmSync(w.file('run.sh'));
  fs.rmSync(w.file('.env'));
  w.write('index.html', 'v2');
  const r = await restore(w, p.id);
  assert.deepEqual([r.ok, r.restored, r.failed], [true, 3, []]);
  assert.equal(w.modeOf(w.file('run.sh')), 0o755, 'the script can still be run');
  assert.equal(w.modeOf(w.file('.env')), 0o600, 'the private file stays private');
  assert.equal(w.modeOf(w.file('index.html')), 0o644);
  // A file rewritten with other permissions: going back puts its bytes and its permissions back
  w.write('run.sh', 'changed', 0o644);
  assert.deepEqual((await restore(w, p.id)).failed, []);
  assert.equal(w.modeOf(w.file('run.sh')), 0o755);
  // Only the permissions changed (chmod -x): that is a change the plan names, and going back undoes it
  fs.chmodSync(w.file('run.sh'), 0o644);
  assert.deepEqual(plan(w, p.id).changed, ['run.sh']);
  await restore(w, p.id);
  assert.equal(w.modeOf(w.file('run.sh')), 0o755);
  // A point is not answered again when only permissions changed: the new point holds the new ones
  fs.chmodSync(w.file('run.sh'), 0o700);
  const p2 = point(w);
  assert.equal(p2.reused, false);
  fs.chmodSync(w.file('run.sh'), 0o644);
  await restore(w, p2.id);
  assert.equal(w.modeOf(w.file('run.sh')), 0o700);
});

test('F02: the copies in the hub are the owner\'s only; a shared (hard-linked) copy is never changed in place', { skip: !unix && 'Unix permissions only' }, () => {
  const w = world();
  w.write('.env', 'KEY=1\n', 0o600);
  w.write('run.sh', 'echo', 0o755);
  const p = point(w);
  const pd = path.join(pointsDir(w.hub, w.projectId), p.id);
  assert.equal(w.modeOf(pointsDir(w.hub, w.projectId)), 0o700, 'the project\'s points folder');
  assert.equal(w.modeOf(pd), 0o700, 'the point folder');
  assert.equal(w.modeOf(path.join(pd, 'files')), 0o700);
  assert.equal(w.modeOf(path.join(pd, 'files', '.env')), 0o600, 'the copy of a private file is not readable by others');
  assert.equal(w.modeOf(path.join(pd, 'files', 'run.sh')), 0o600, 'a copy is data, never run from the hub');
  assert.equal(w.modeOf(path.join(pd, 'manifest.json')), 0o600);
  // An older point's copy that a newer point links to keeps its own permissions (another point's file)
  const old = path.join(pd, 'files', 'run.sh');
  fs.chmodSync(old, 0o640);
  w.write('other.txt', 'new');
  const p2 = point(w);
  const shared = path.join(pointsDir(w.hub, w.projectId), p2.id, 'files', 'run.sh');
  if (fs.statSync(shared).ino === fs.statSync(old).ino) assert.equal(w.modeOf(old), 0o640, 'the shared copy is not chmodded');
});

test('F02: a point taken before permissions were kept (manifest version 1) is still listed and put back; a rewritten file keeps its present permissions', async () => {
  const w = world();
  w.write('run.sh', 'v1', unix ? 0o755 : undefined);
  const p = point(w);
  w.editManifest(p.id, (m) => ({ ...m, version: 1, files: m.files.map(({ mode, ...f }) => f) }));
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId })[0].id, p.id);
  w.write('run.sh', 'v2');
  if (unix) fs.chmodSync(w.file('run.sh'), 0o750);
  const r = await restore(w, p.id);
  assert.deepEqual([r.ok, r.failed], [true, []]);
  assert.equal(fs.readFileSync(w.file('run.sh'), 'utf8'), 'v1');
  if (unix) assert.equal(w.modeOf(w.file('run.sh')), 0o750, 'no permissions in the point: the file\'s own stay');
  // A version this app does not know, or permissions that are not permissions, make no point
  w.editManifest(p.id, (m) => ({ ...m, version: 3 }));
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId }).some((x) => x.id === p.id), false);
  w.editManifest(p.id, (m) => ({ ...m, version: 2, files: m.files.map((f) => ({ ...f, mode: 0o4755 })) }));
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId }).some((x) => x.id === p.id), false, 'a set-user-id bit is never put back');
});

test('F03: on a case-sensitive file system a README.md made after a point of readme.md is named and removed; readme.md stays', { skip: !caseSensitive && 'a case-insensitive file system holds one of the two' }, async () => {
  const w = world();
  w.write('readme.md', 'lower');
  w.write('src/App.js', 'app');
  const p = point(w);
  w.write('README.md', 'upper');
  w.write('src/app.js', 'other');
  const pl = plan(w, p.id);
  assert.deepEqual([pl.changed, pl.missing, pl.added], [[], [], ['README.md', 'src/app.js']]);
  const r = await restore(w, p.id);
  assert.deepEqual([r.ok, r.removed, r.restored, r.failed], [true, 2, 0, []]);
  assert.deepEqual(fs.readdirSync(w.dir).sort(), ['readme.md', 'src']);
  assert.equal(fs.readFileSync(w.file('readme.md'), 'utf8'), 'lower');
  assert.deepEqual(fs.readdirSync(w.file('src')), ['App.js']);
  // Both names in one point: both are put back, neither stands for the other
  w.write('README.md', 'upper');
  const both = point(w);
  fs.rmSync(w.file('README.md'));
  fs.rmSync(w.file('readme.md'));
  const r2 = await restore(w, both.id);
  assert.deepEqual([r2.restored, r2.failed], [2, []]);
  assert.deepEqual([fs.readFileSync(w.file('readme.md'), 'utf8'), fs.readFileSync(w.file('README.md'), 'utf8')], ['lower', 'upper']);
});

test('F03: a manifest naming one file twice (as this file system sees names) is refused, never half applied', async () => {
  const w = world();
  w.write('index.html', 'v1');
  const p = point(w);
  w.write('index.html', 'v2');
  const variant = caseSensitive ? 'index.html' : 'INDEX.html';
  w.editManifest(p.id, (m) => ({ ...m, files: [...m.files, { ...m.files[0], rel: variant }] }));
  assert.equal(plan(w, p.id).problem, 'point-ambiguous');
  const r = await restore(w, p.id);
  assert.deepEqual([r.ok, r.problem], [false, 'point-ambiguous']);
  assert.equal(fs.readFileSync(w.file('index.html'), 'utf8'), 'v2', 'nothing changed');
});
