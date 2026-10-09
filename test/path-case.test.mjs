// Review 2026-10 F01: on a case-sensitive file system (Linux) work/App and work/app are two folders, so two projects;
// Windows and macOS (by default) fold case as before. Ids already stored keep working: a project keeps the id it had,
// and a folder that only now shows up next to it under the same name in another case gets an id of its own.
// Run: node --test test/path-case.test.mjs (the two-folder parts need a case-sensitive file system: WSL covers them)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normPath, pathKeyOn, slugify, PROJECT_ID_RE } from '../server/util.mjs';
import { PLATFORM, platformOf } from '../server/platform.mjs';
import { ProjectMemory } from '../server/memory.mjs';
import { Catalog } from '../server/catalog.mjs';
import { initHub } from '../server/hub.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-path-case-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const caseSensitive = (() => {
  const probe = path.join(TMP, 'case-probe');
  fs.writeFileSync(probe, '');
  try {
    return !fs.existsSync(path.join(TMP, 'CASE-PROBE'));
  } finally {
    fs.rmSync(probe);
  }
})();
const TWO_FOLDERS = { skip: !(caseSensitive && !PLATFORM.caseless) && 'needs a case-sensitive file system on Linux' };

test('the path key: as written on Linux, folded on Windows and macOS; normPath is the key of this platform', () => {
  assert.equal(pathKeyOn('/home/u/work/App/', platformOf('linux')), '/home/u/work/App');
  assert.notEqual(pathKeyOn('/home/u/work/App', platformOf('linux')), pathKeyOn('/home/u/work/app', platformOf('linux')));
  assert.equal(pathKeyOn('C:\\Users\\U\\Work\\App\\', platformOf('win32')), 'c:/users/u/work/app');
  assert.equal(pathKeyOn('/Users/u/Work/App', platformOf('darwin')), '/users/u/work/app');
  assert.equal(pathKeyOn('', platformOf('linux')), '');
  assert.equal(normPath('/x/Y'), pathKeyOn('/x/Y', PLATFORM));
  // Used as a map callback (list.map(normPath)) the index never changes the answer
  assert.deepEqual(['/A', '/B'].map(normPath), [pathKeyOn('/A', PLATFORM), pathKeyOn('/B', PLATFORM)]);
});

let n = 0;
function world() {
  const base = path.join(TMP, `w${++n}`);
  const home = path.join(base, 'home');
  const hub = path.join(base, 'hub');
  const work = path.join(base, 'work');
  for (const d of [path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'), path.join(home, '.claude'), work]) fs.mkdirSync(d, { recursive: true });
  initHub(hub);
  const catalog = (now = Date.now) => {
    const c = new Catalog({ hubDir: hub, claudeDir: path.join(home, '.claude'), homeDir: home, adapters: [], env: {}, memory: new ProjectMemory({ hubDir: hub, debounceMs: 0, now }) });
    c.load();
    return c;
  };
  const dir = (name) => {
    const d = path.join(work, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const memoryFile = path.join(hub, 'registry', 'discovered.json');
  return { hub, work, catalog, dir, memoryFile };
}
// The id a folder had before this change (and still has when no other folder takes its name in another case)
const legacyId = (c, dir) => c.adhocId(slugify(normPath(dir)).toLowerCase());

test('F01: work/App and work/app are two projects, each opening its own folder, also after a restart', TWO_FOLDERS, () => {
  const w = world();
  const c = w.catalog();
  const upper = w.dir('App');
  const lower = w.dir('app');
  const a = c.addProjectFolder(upper);
  const b = c.addProjectFolder(lower);
  assert.deepEqual([a.ok, a.reason, b.ok, b.reason], [true, 'added', true, 'added'], JSON.stringify([a, b]));
  assert.notEqual(a.projectId, b.projectId);
  assert.match(b.projectId, PROJECT_ID_RE);
  assert.equal(c.getProject(a.projectId).path, upper);
  assert.equal(c.getProject(b.projectId).path, lower);
  assert.equal(a.projectId, legacyId(c, upper), 'the first keeps the id such a folder always had');
  // Each opens its own project again; a folder inside each belongs to it
  assert.deepEqual([c.addProjectFolder(upper).projectId, c.addProjectFolder(lower).projectId], [a.projectId, b.projectId]);
  fs.mkdirSync(path.join(lower, 'src'));
  assert.equal(c.knownProjectFor(path.join(lower, 'src')).id, b.projectId);
  // The memory keeps both folders apart
  const saved = JSON.parse(fs.readFileSync(w.memoryFile, 'utf8')).projects.map((e) => e.path).sort();
  assert.deepEqual(saved, [upper, lower].sort());
  // A new process gives each the same id (not by the order it reads them in)
  const again = w.catalog();
  assert.equal(again.allProjects().find((p) => p.path === upper)?.id, a.projectId);
  assert.equal(again.allProjects().find((p) => p.path === lower)?.id, b.projectId);
});

test('F01: an id already stored keeps working; the folder first seen keeps the plain id whatever the order', TWO_FOLDERS, () => {
  const w = world();
  const upper = w.dir('Site');
  const lower = w.dir('site');
  // An older memory (one record, as the merged one was): its project keeps its id
  fs.writeFileSync(w.memoryFile, JSON.stringify({ version: 1, projects: [{ path: upper, firstSeenAt: '2026-10-01T10:00:00.000Z', lastSeenAt: '2026-10-01T10:00:00.000Z', via: ['sibersentez'] }] }));
  const c = w.catalog();
  const old = c.allProjects().find((p) => p.path === upper);
  assert.equal(old?.id, legacyId(c, upper), 'the stored id resolves to the stored folder');
  const b = c.addProjectFolder(lower);
  assert.deepEqual([b.ok, b.reason], [true, 'added']);
  assert.notEqual(b.projectId, old.id);
  assert.equal(c.getProject(old.id).path, upper);
  // The other way round: the lower-case folder was first seen (byte order says otherwise), it keeps the plain id
  const w2 = world();
  const up2 = w2.dir('Site');
  const low2 = w2.dir('site');
  fs.writeFileSync(w2.memoryFile, JSON.stringify({ version: 1, projects: [
    { path: up2, firstSeenAt: '2026-10-05T10:00:00.000Z', lastSeenAt: '2026-10-05T10:00:00.000Z', via: ['sibersentez'] },
    { path: low2, firstSeenAt: '2026-10-01T10:00:00.000Z', lastSeenAt: '2026-10-01T10:00:00.000Z', via: ['sibersentez'] },
  ] }));
  const c2 = w2.catalog();
  assert.equal(c2.allProjects().find((p) => p.path === low2)?.id, legacyId(c2, low2));
  assert.notEqual(c2.allProjects().find((p) => p.path === up2)?.id, legacyId(c2, up2));
});

test('F01: two folders added in the same millisecond, lower case first, keep their ids after a restart', TWO_FOLDERS, () => {
  const w = world();
  const fixed = () => Date.UTC(2026, 9, 9, 12, 0, 0);
  const c = w.catalog(fixed);
  const lower = w.dir('shop');
  const upper = w.dir('Shop');
  const a = c.addProjectFolder(lower);
  const b = c.addProjectFolder(upper);
  assert.notEqual(a.projectId, b.projectId);
  assert.equal(a.projectId, legacyId(c, lower));
  const again = w.catalog(fixed);
  assert.deepEqual([again.allProjects().find((p) => p.path === lower)?.id, again.allProjects().find((p) => p.path === upper)?.id], [a.projectId, b.projectId]);
});

test('F01: Windows and macOS keep folding case: the same folder in another case is the same project', { skip: !PLATFORM.caseless && 'a caseless platform' }, () => {
  const w = world();
  const c = w.catalog();
  const d = w.dir('Shop');
  const a = c.addProjectFolder(d);
  const b = c.addProjectFolder(path.join(w.work, 'SHOP'));
  assert.deepEqual([b.projectId, b.reason], [a.projectId, 'existing']);
});
