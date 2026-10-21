// What restore points take on disk, and the points of projects no longer listed (independent review 2026-10-20, T05):
// the hub's total, the folders of unlisted projects, their removal on a yes (restore-clean), and no copy started on a
// drive that is almost full. server/restore.mjs hubPointsDisk, removeOrphanPoints, createPoint (disk-full);
// public/js/views/settings.js diskRowHtml. Hermetic: a temporary hub and projects.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPoint, createPointAsync, hubPointsDisk, removeOrphanPoints, pointsDir, listPoints, RESTORE_MARK, FREE_MARGIN } from '../server/restore.mjs';
import { createValidators } from '../server/actionInput.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-restore-disk-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let clock = Date.UTC(2026, 9, 20, 9, 0, 0);
const tick = () => (clock += 1000);
// The orphans' rule wants their newest point a week old (ORPHAN_MIN_AGE_MS): looked at eight days on
const later = () => clock + 8 * 24 * 3600 * 1000;
const hub = path.join(TMP, 'hub');
fs.mkdirSync(hub, { recursive: true });
function project(name, files) {
  const dir = path.join(TMP, name);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test("the hub's total counts a file shared by two points once; a project no longer listed is named, a listed one never", async () => {
  const keep = project('keep', { 'a.txt': 'x'.repeat(1000) });
  const gone = project('gone', { 'b.txt': 'y'.repeat(3000) });
  createPoint({ hubDir: hub, projectId: 'x-keep', dir: keep, now: tick });
  fs.writeFileSync(path.join(keep, 'c.txt'), 'new');
  createPoint({ hubDir: hub, projectId: 'x-keep', dir: keep, now: tick });
  createPoint({ hubDir: hub, projectId: 'x-gone', dir: gone, now: tick });
  const listed = new Set(['x-keep']);
  const isListed = (id) => listed.has(id);
  const d = await hubPointsDisk({ hubDir: hub, isListed, now: later });
  assert.equal(d.projects, 2);
  assert.equal(d.bytes, 1000 + 3 + 3000, 'a.txt is in both points of x-keep, linked: counted once');
  assert.equal(d.orphans.length, 1);
  assert.deepEqual({ ...d.orphans[0], newest: typeof d.orphans[0].newest }, { key: path.basename(pointsDir(hub, 'x-gone')), projectId: 'x-gone', points: 1, bytes: 3000, newest: 'number' });
  // A restore cut off halfway keeps its folder, listed or not
  fs.writeFileSync(path.join(pointsDir(hub, 'x-gone'), RESTORE_MARK), '{}');
  assert.equal((await hubPointsDisk({ hubDir: hub, isListed, now: later })).orphans.length, 0);
  fs.rmSync(path.join(pointsDir(hub, 'x-gone'), RESTORE_MARK));
  // No hub: nothing
  assert.deepEqual(await hubPointsDisk({ hubDir: null, isListed }), { bytes: 0, projects: 0, orphans: [] });
});

test('removing: only folders still of no listed project go; a project listed again meanwhile keeps its points', () => {
  const back = project('back', { 'd.txt': 'z' });
  createPoint({ hubDir: hub, projectId: 'x-back', dir: back, now: tick });
  const goneKey = path.basename(pointsDir(hub, 'x-gone'));
  const backKey = path.basename(pointsDir(hub, 'x-back'));
  const keepKey = path.basename(pointsDir(hub, 'x-keep'));
  // x-back was unlisted when the person looked, and is listed again now
  const listed = new Set(['x-keep', 'x-back']);
  const r = removeOrphanPoints({ hubDir: hub, keys: [goneKey, backKey, keepKey, 'f'.repeat(24)], isListed: (id) => listed.has(id), now: later });
  assert.deepEqual(r, { removed: [goneKey], kept: [backKey, keepKey, 'f'.repeat(24)] });
  assert.equal(fs.existsSync(pointsDir(hub, 'x-gone')), false);
  assert.equal(listPoints({ hubDir: hub, projectId: 'x-back' }).length, 1);
  assert.equal(listPoints({ hubDir: hub, projectId: 'x-keep' }).length, 2);
});

test('the action takes 1 to 200 distinct folder keys, nothing else', () => {
  const v = createValidators({ catalog: { getProject: () => null }, hubDir: hub, homeDir: TMP, claudeDir: path.join(TMP, '.claude'), appCwd: TMP });
  const check = v.validate;
  const k = 'a'.repeat(24);
  for (const [body, code] of [
    [{ action: 'restore-clean' }, 'missing-field'],
    [{ action: 'restore-clean', keys: [] }, 'bad-keys'],
    [{ action: 'restore-clean', keys: ['../x'] }, 'bad-keys'],
    [{ action: 'restore-clean', keys: [k, k] }, 'bad-keys'],
    [{ action: 'restore-clean', keys: Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(24, '0')) }, 'bad-keys'],
    [{ action: 'restore-clean', keys: [k], projectId: 'x' }, 'unexpected-field'],
  ]) assert.equal(check(body).body?.error, code, JSON.stringify(body).slice(0, 80));
  const ok = check({ action: 'restore-clean', keys: [k] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ctx.cleanKeys, [k]);
});

test('no copy is started on a drive that is almost full (disk-full); a drive that cannot be asked is not checked', async () => {
  const dir = project('full', { 'e.txt': 'e'.repeat(5000) });
  const almost = () => FREE_MARGIN + 9000;
  assert.deepEqual(createPoint({ hubDir: hub, projectId: 'x-full', dir, now: tick, freeBytes: almost }), { ok: false, problem: 'disk-full' });
  assert.deepEqual(await createPointAsync({ hubDir: hub, projectId: 'x-full', dir, now: tick, freeBytes: almost }), { ok: false, problem: 'disk-full' });
  assert.equal(listPoints({ hubDir: hub, projectId: 'x-full' }).length, 0);
  assert.equal(createPoint({ hubDir: hub, projectId: 'x-full', dir, now: tick, freeBytes: () => FREE_MARGIN + 10000 }).ok, true, 'twice the copy and the margin: room');
  fs.writeFileSync(path.join(dir, 'e.txt'), 'changed');
  assert.equal(createPoint({ hubDir: hub, projectId: 'x-full', dir, now: tick, freeBytes: () => null }).ok, true);
});

test('Settings: the total, the unlisted projects and their removal asked once; live only', async () => {
  const { diskRowHtml } = await import('../public/js/views/settings.js');
  const { setLanguage, STRINGS } = await import('../public/js/i18n.js');
  const { esc } = await import('../public/js/format.js');
  const data = { bytes: 5 * 1024 * 1024, projects: 3, orphans: [{ key: 'a'.repeat(24), projectId: 'x-old-site', points: 2, bytes: 2 * 1024 * 1024 }] };
  for (const L of ['en', 'tr']) {
    setLanguage(L);
    const S = STRINGS[L];
    assert.ok(diskRowHtml(null).includes(esc(S.setDiskLoading)));
    assert.ok(diskRowHtml({ state: 'failed' }).includes(esc(S.setDiskFailed)));
    const live = diskRowHtml({ state: 'ready', data, step: null }, 'live');
    assert.match(live, /x-old-site/);
    assert.match(live, /data-set-act="disk-clean"/);
    assert.doesNotMatch(live, /disk-yes/, 'asked first');
    const ask = diskRowHtml({ state: 'ready', data, step: 'ask' }, 'live');
    assert.match(ask, /data-set-act="disk-yes"/);
    assert.ok(ask.includes(esc(S.setDiskAsk.replace('{count}', '1'))));
    const dry = diskRowHtml({ state: 'ready', data, step: null }, 'dry');
    assert.doesNotMatch(dry, /disk-clean/);
    assert.ok(dry.includes(esc(S.setDiskLive)));
    assert.ok(diskRowHtml({ state: 'ready', data: { ...data, orphans: [], unsure: true, why: 'memory-set-aside' } }, 'live').includes(esc(S.setDiskUnsureMemory)));
    assert.ok(diskRowHtml({ state: 'ready', data: { ...data, orphans: [], unsure: true, why: 'busy' } }, 'live').includes(esc(S.setDiskUnsure)));
    assert.doesNotMatch(diskRowHtml({ state: 'ready', data: { ...data, orphans: [] }, step: null }, 'live'), /disk-clean/, 'nothing to remove: no button');
  }
  setLanguage('en');
});

// Review of the fix (2026-10-20): a manifest that names another project must never make a listed project's folder look
// like an orphan's; nor a folder with points of two projects
test("a folder is an orphan only when its key is its points' project's: a manifest naming another project, or two, keeps it", async () => {
  const dir = project('listed', { 'f.txt': 'f' });
  const p = createPoint({ hubDir: hub, projectId: 'x-listed', dir, now: tick });
  const q = createPoint({ hubDir: hub, projectId: 'x-listed', dir: project('listed', { 'g.txt': 'g' }), now: tick });
  const base = pointsDir(hub, 'x-listed');
  const key = path.basename(base);
  const isListed = (id) => id === 'x-listed';
  const rewrite = (id, projectId) => {
    const file = path.join(base, id, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), projectId }));
  };
  // Both points name a project that is not listed, in the listed project's folder
  rewrite(p.id, 'ghost');
  rewrite(q.id, 'ghost');
  assert.ok(!(await hubPointsDisk({ hubDir: hub, isListed, now: later })).orphans.some((o) => o.key === key), 'the key is not ghost\'s');
  assert.deepEqual(removeOrphanPoints({ hubDir: hub, keys: [key], isListed, now: later }), { removed: [], kept: [key] });
  // Two projects in one folder
  rewrite(q.id, 'x-listed');
  assert.deepEqual(removeOrphanPoints({ hubDir: hub, keys: [key], isListed: () => false, now: later }), { removed: [], kept: [key] });
  assert.ok(fs.existsSync(base));
});

// Pre-release review (2026-10-21): an unreadable registry or project memory, or logs still being read, made listed
// projects look gone, and one yes removed their points; and a project in use this week must never be offered
test('"no longer listed" is trusted only from a list read whole, and only for a project not used for a week', async () => {
  const { Catalog } = await import('../server/catalog.mjs');
  const { initHub } = await import('../server/hub.mjs');
  const { listingTrusted, orphanKeys } = await import('../server/restore.mjs');
  const h = path.join(TMP, 'hub-sure');
  initHub(h);
  const home = path.join(TMP, 'home-sure');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const cat = () => new Catalog({ hubDir: h, claudeDir: path.join(home, '.claude'), homeDir: home, adapters: [], env: {} });
  assert.equal(cat().listingSure(), true, 'a new hub: nothing missing');
  // The registry being written (or broken): not trusted
  const reg = path.join(h, 'registry', 'projects.json');
  const good = fs.readFileSync(reg, 'utf8');
  fs.writeFileSync(reg, '{"version":1,"projects":[{"id":"my-ga');
  assert.equal(cat().listingSure(), false);
  assert.equal(listingTrusted({ catalog: cat() }), false);
  // Round 2: half-written when the list was loaded, whole again now: the list is still the half one, until it loads
  const c = cat();
  c.load();
  assert.equal(c.listingSure(), false);
  fs.writeFileSync(reg, good);
  assert.equal(c.listingSure(), false, 'the loaded list came from the broken file');
  c.load();
  assert.equal(c.listingSure(), true, 'loaded again from the whole file');
  // The project memory broken at start (set aside and rebuilt): not trusted, also on the next starts, while the broken
  // copy (and the projects only it named) is still set aside
  const memFile = path.join(h, 'registry', 'discovered.json');
  fs.writeFileSync(memFile, 'not json');
  assert.equal(cat().listingSure(), false);
  assert.ok(fs.existsSync(`${memFile}.broken`));
  assert.equal(cat().listingSure(), false, 'the next start: the set-aside copy is still there');
  assert.equal(cat().listingDoubt(), 'memory-set-aside', 'a reason that lasts: Settings says it plainly');
  fs.rmSync(`${memFile}.broken`);
  assert.equal(cat().listingSure(), true);
  // The logs still being read
  assert.equal(listingTrusted({ catalog: cat(), ingest: { scan: { state: 'loading' } } }), false);
  assert.equal(listingTrusted({ catalog: cat(), ingest: { scan: { state: 'ready' } } }), true);
  // A point of this week is never an orphan's, whatever the list says
  const dir = project('fresh', { 'h.txt': 'h' });
  createPoint({ hubDir: h, projectId: 'x-fresh', dir });
  assert.equal(orphanKeys({ hubDir: h, isListed: () => false }).size, 0);
  assert.equal(orphanKeys({ hubDir: h, isListed: () => false, now: () => Date.now() + 8 * 24 * 3600 * 1000 }).size, 1);
  // The action and the route ask the same question first
  const actions = fs.readFileSync(new URL('../server/actions.mjs', import.meta.url), 'utf8');
  assert.match(actions, /if \(!listingTrusted\(\{ catalog, ingest \}\)\) return failed\(409, 'catalog-unsure'/);
  const app = fs.readFileSync(new URL('../server/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /const sure = listingTrusted\(\{ catalog, ingest \}\);/);
});
