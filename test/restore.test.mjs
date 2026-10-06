// Restore points (server/restore.mjs, docs/restore.md): the copy, the plan, going back and undoing it. Hermetic: a
// temporary hub and project per test, nothing outside them is read or written.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanProject, createPoint, listPoints, planRestore, applyRestore, safeRel, pointsDir, projectKey, RESTORE_KEEP, RESTORE_LIMITS, POINT_ID_RE, LABEL_MAX } from '../server/restore.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-restore-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
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
  return { base, hub, dir, write, read, has, projectId: 'x-demo-app' };
}
let clock = Date.UTC(2026, 8, 30, 12, 0, 0);
const tick = () => (clock += 1000);

test('safe relative paths: forward slashes inside the project only', () => {
  for (const ok of ['index.html', 'src/app.js', '.sibersentez/PLAN.md', 'a b/c.txt']) assert.equal(safeRel(ok), true, ok);
  for (const bad of ['', '/x', '../x', 'a/../b', 'a/./b', 'C:/x', 'a\\b', 'a//b', 'x.', 'x ', 'a\u0001b', 'a:b', 42, 'x'.repeat(401)]) assert.equal(safeRel(bad), false, String(bad));
  assert.match(projectKey('a..'), /^[0-9a-f]{24}$/, 'a digest: an id ending in dots is a safe folder name');
});

test('scan: files in byte order; regenerated and tool folders and links left out; the limits say why', () => {
  const w = world();
  w.write('index.html', '<p>hi</p>');
  w.write('src/b.js', 'b');
  w.write('src/A.js', 'A');
  for (const skip of ['node_modules/x/i.js', '.git/HEAD', '.claude/skills/s/SKILL.md', 'dist/app.js', 'Library/cache.bin']) w.write(skip, 'x');
  fs.mkdirSync(path.join(w.base, 'outside'));
  fs.writeFileSync(path.join(w.base, 'outside', 'secret.txt'), 'no');
  fs.symlinkSync(path.join(w.base, 'outside'), path.join(w.dir, 'link'), 'junction');
  const s = scanProject(w.dir);
  assert.equal(s.ok, true);
  assert.deepEqual(s.files.map((f) => f.rel), ['index.html', 'src/A.js', 'src/b.js']);
  assert.equal(s.bytes, 11);
  assert.deepEqual(scanProject(w.dir, { ...RESTORE_LIMITS, files: 2 }), { ok: false, problem: 'too-many-files' });
  assert.deepEqual(scanProject(w.dir, { ...RESTORE_LIMITS, bytes: 5 }), { ok: false, problem: 'too-large' });
  assert.deepEqual(scanProject(w.dir, { ...RESTORE_LIMITS, fileBytes: 4 }), { ok: false, problem: 'file-too-large' });
  assert.deepEqual(scanProject(w.dir, { ...RESTORE_LIMITS, depth: 0 }), { ok: false, problem: 'too-deep' });
  assert.deepEqual(scanProject(path.join(w.base, 'nope')), { ok: false, problem: 'folder-missing' });
  // A hub inside the project is never copied into its own points
  const inner = path.join(w.dir, 'hubhere');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'x.txt'), 'x');
  assert.ok(!scanProject(w.dir, RESTORE_LIMITS, [inner]).files.some((f) => f.rel.startsWith('hubhere')));
});

test('a point taken before SHA-256 (its files named by SHA-1) is still planned, checked and put back; a damaged old copy is still caught', async () => {
  const crypto = await import('node:crypto');
  const legacy = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
  const w = world();
  w.write('a.txt', 'one');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, reason: 'ai-start', now: tick });
  const pd = path.join(pointsDir(w.hub, w.projectId), p.id);
  const mf = path.join(pd, 'manifest.json');
  // Rewrite the manifest as an older version wrote it: sha1 per file, no sha256
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.files = m.files.map(({ sha256, ...f }) => ({ ...f, sha1: legacy(fs.readFileSync(path.join(pd, 'files', f.rel))) }));
  fs.writeFileSync(mf, JSON.stringify(m));
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId }).length, 1, 'still listed');
  w.write('a.txt', 'two');
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changed, ['a.txt']);
  const r = applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, planId: plan.planId, now: tick });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(w.dir, 'a.txt'), 'utf8'), 'one');
  // A damaged old copy: caught by its SHA-1, nothing changes
  fs.writeFileSync(path.join(pd, 'files', 'a.txt'), 'xxx');
  w.write('a.txt', 'three');
  const plan2 = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id });
  assert.equal(applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, planId: plan2.planId, now: tick }).problem, 'point-damaged');
  assert.equal(fs.readFileSync(path.join(w.dir, 'a.txt'), 'utf8'), 'three');
  // A file entry with neither digest makes the manifest unreadable (the point is not listed)
  m.files = m.files.map(({ sha1, ...f }) => f);
  fs.writeFileSync(mf, JSON.stringify(m));
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId }).some((x) => x.id === p.id), false);
});

test('a point: a copy with a manifest in the hub; nothing changed answers the same point; the newest five are kept', () => {
  const w = world();
  w.write('index.html', 'v1');
  w.write('.sibersentez/PLAN.md', 'plan');
  const p1 = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, reason: 'ai-start', now: tick });
  assert.equal(p1.ok, true);
  assert.match(p1.id, POINT_ID_RE);
  assert.equal(p1.reused, false);
  assert.equal(p1.files, 2);
  const pd = path.join(pointsDir(w.hub, w.projectId), p1.id);
  assert.equal(fs.readFileSync(path.join(pd, 'files', 'index.html'), 'utf8'), 'v1');
  const m = JSON.parse(fs.readFileSync(path.join(pd, 'manifest.json'), 'utf8'));
  assert.equal(m.projectId, w.projectId);
  assert.equal(m.reason, 'ai-start');
  assert.match(m.files[0].sha256, /^[0-9a-f]{64}$/, 'a new point names its files by SHA-256');
  assert.equal(m.files[0].sha1, undefined);
  assert.ok(pd.startsWith(w.hub), 'the copy lives in the hub, never in the project');
  // Nothing changed: the same point, no second copy
  const again = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  assert.deepEqual([again.id, again.reused], [p1.id, true]);
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId }).length, 1);
  // Changes make new points; the newest RESTORE_KEEP stay, an interrupted copy is swept
  fs.mkdirSync(path.join(pointsDir(w.hub, w.projectId), 'R20260101000000abcd.tmp-0badc0de'), { recursive: true });
  for (let i = 2; i <= RESTORE_KEEP + 2; i++) {
    w.write('index.html', `v${i}`);
    assert.equal(createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick }).reused, false);
  }
  const list = listPoints({ hubDir: w.hub, projectId: w.projectId });
  assert.equal(list.length, RESTORE_KEEP);
  assert.ok(!list.some((x) => x.id === p1.id), 'the oldest went');
  assert.deepEqual(list.map((x) => x.id), [...list.map((x) => x.id)].sort().reverse(), 'newest first');
  assert.equal(fs.readdirSync(pointsDir(w.hub, w.projectId)).filter((x) => x.includes('.tmp-')).length, 0);
  // Another project's points are its own
  assert.deepEqual(listPoints({ hubDir: w.hub, projectId: 'other' }), []);
  // Over the full limits: a lean point instead (docs/restore.md §7); over a scope asked for: no point, the reason
  const lean = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, limits: { ...RESTORE_LIMITS, files: 1 } });
  assert.deepEqual([lean.ok, lean.scope], [true, 'lean']);
  assert.deepEqual(createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, limits: { ...RESTORE_LIMITS, files: 1 }, scope: 'full' }), { ok: false, problem: 'too-many-files' });
});

test('plan: what changed, what was deleted and what came later; a new time with the same content is no change', () => {
  const w = world();
  w.write('index.html', 'v1');
  w.write('style.css', 'css');
  w.write('keep.txt', 'same');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  w.write('index.html', 'v2 by the AI');
  fs.rmSync(path.join(w.dir, 'style.css'));
  w.write('src/new.js', 'new');
  fs.utimesSync(path.join(w.dir, 'keep.txt'), new Date(), new Date(Date.now() + 5000));
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changed, ['index.html']);
  assert.deepEqual(plan.missing, ['style.css']);
  assert.deepEqual(plan.added, ['src/new.js']);
  assert.equal(plan.point.id, p.id);
  assert.equal(planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: 'R20260101000000beef' }).problem, 'point-missing');
  assert.equal(planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: '../x' }).problem, 'point-missing');
  assert.equal(planRestore({ hubDir: w.hub, projectId: 'other', dir: w.dir, id: p.id }).problem, 'point-missing', 'a point of another project');
});

test('going back: files put back, deleted ones brought back, later ones removed with their empty folders; the present is kept first, so the restore can be undone', () => {
  const w = world();
  w.write('index.html', 'v1');
  w.write('style.css', 'css');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, reason: 'ai-start', now: tick });
  w.write('index.html', 'v2');
  fs.rmSync(path.join(w.dir, 'style.css'));
  w.write('src/deep/new.js', 'new');
  w.write('notes.md', 'mine');
  const r = applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, now: tick });
  assert.equal(r.ok, true);
  assert.deepEqual([r.restored, r.removed, r.failed], [2, 2, []]);
  assert.equal(w.read('index.html'), 'v1');
  assert.equal(w.read('style.css'), 'css');
  assert.equal(w.has('src/deep/new.js'), false);
  assert.equal(w.has('src'), false, 'folders left empty go too');
  assert.equal(w.has('notes.md'), false);
  // The present before the restore is a point of its own
  const list = listPoints({ hubDir: w.hub, projectId: w.projectId });
  assert.equal(list[0].id, r.before);
  assert.equal(list[0].reason, 'before-restore');
  // Undo: back to that point
  const undo = applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: r.before, now: tick });
  assert.equal(undo.ok, true);
  assert.equal(w.read('index.html'), 'v2');
  assert.equal(w.read('src/deep/new.js'), 'new');
  assert.equal(w.read('notes.md'), 'mine');
  assert.equal(w.has('style.css'), false);
  // Nothing to do: nothing written, no point taken
  const count = listPoints({ hubDir: w.hub, projectId: w.projectId }).length;
  assert.deepEqual(applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: r.before, now: tick }), { ok: true, before: null, restored: 0, removed: 0, failed: [] });
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId }).length, count);
});

test('going back never writes through a link, never trusts a damaged copy, and changes nothing when the present cannot be kept', () => {
  const w = world();
  w.write('web/index.html', 'v1');
  w.write('a.txt', 'a1');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  // The folder became a junction to somewhere else: the file behind it is not written
  fs.rmSync(path.join(w.dir, 'web'), { recursive: true });
  const elsewhere = path.join(w.base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(w.dir, 'web'), 'junction');
  w.write('a.txt', 'a2');
  w.write('later.txt', 'later');
  const r = applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, now: tick });
  assert.equal(r.ok, true);
  assert.deepEqual(r.failed.map((f) => `${f.rel}:${f.error}`), ['web/index.html:link-in-path']);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing written behind the junction');
  assert.equal(w.read('a.txt'), 'a1');
  // A damaged copy in the point: checked before anything is touched, so nothing changes at all
  w.write('a.txt', 'a3');
  w.write('later2.txt', 'keep me');
  const pts = listPoints({ hubDir: w.hub, projectId: w.projectId }).length;
  fs.writeFileSync(path.join(pointsDir(w.hub, w.projectId), p.id, 'files', 'a.txt'), 'tampered');
  assert.deepEqual(applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, now: tick }), { ok: false, problem: 'point-damaged' });
  assert.equal(w.read('a.txt'), 'a3');
  assert.equal(w.read('later2.txt'), 'keep me', 'nothing removed either');
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId }).length, pts, 'no point taken');
  // The present cannot be kept (over the limits): nothing changes
  const w2 = world();
  w2.write('a.txt', 'one');
  const p2 = createPoint({ hubDir: w2.hub, projectId: w2.projectId, dir: w2.dir, now: tick });
  w2.write('a.txt', 'two');
  w2.write('b.txt', 'later');
  const refused = applyRestore({ hubDir: w2.hub, projectId: w2.projectId, dir: w2.dir, id: p2.id, now: tick, limits: { ...RESTORE_LIMITS, files: 1 } });
  assert.equal(refused.ok, false);
  assert.equal(w2.read('a.txt'), 'two');
  assert.equal(w2.read('b.txt'), 'later');
});

// ---------------- the drawer section (public/js/restore.js) ----------------
test('drawer section: the points with plain reasons; off disables going back; the plan asks once in live, only shows in preview; the result says how to undo', async () => {
  const { restoreSectionHtml, createRestore } = await import('../public/js/restore.js');
  const { setLanguage, STRINGS } = await import('../public/js/i18n.js');
  const { esc } = await import('../public/js/format.js');
  setLanguage('tr');
  const S = STRINGS.tr;
  const P = { id: 'p', path: 'C:\p' };
  assert.equal(restoreSectionHtml({ id: 'x' }, null), '', 'no folder: no section');
  assert.equal(restoreSectionHtml({ ...P, broad: true }, { points: [] }), '');
  assert.ok(restoreSectionHtml(P, null).includes(esc(S.rstLoading)));
  assert.ok(restoreSectionHtml(P, { points: [] }).includes(esc(S.rstNone)));
  const data = { points: [{ id: 'R20260930120000abcd', at: Date.now() - 60000, reason: 'before-restore', files: 3 }, { id: 'R20260930110000beef', at: Date.now() - 3600000, reason: 'ai-start', files: 2 }] };
  const live = restoreSectionHtml(P, data, { mode: 'live' });
  assert.ok(live.includes(esc(S['rstReason_before-restore'])) && live.includes(esc(S['rstReason_ai-start'])));
  assert.match(live, /data-rst-act="preview" data-rst-id="R20260930110000beef" data-fk="rst:R20260930110000beef">Buna geri dön</);
  assert.match(restoreSectionHtml(P, data, { mode: 'off' }), /data-rst-id="R20260930110000beef"[^>]*aria-disabled="true"/);
  assert.ok(restoreSectionHtml(P, data, { mode: 'off' }).includes(esc(S.rstWhyOff)));
  const plan = { counts: { changed: 1, missing: 0, added: 12 }, changed: ['index.html'], missing: [], added: Array.from({ length: 12 }, (_, i) => `f${i}.js`) };
  const ask = restoreSectionHtml(P, data, { mode: 'live', ui: { step: 'confirm', pointId: 'R20260930110000beef', plan } });
  assert.match(ask, /data-rst-act="yes" data-fk="rst:yes">Evet, geri dön</);
  assert.ok(ask.includes(esc(S.rstChanged.replace('{count}', '1'))) && ask.includes(esc(S.rstAdded.replace('{count}', '12'))));
  assert.ok(!ask.includes(esc(S.rstMissing.replace('{count}', '0'))), 'an empty list is not shown');
  assert.ok(ask.includes(esc(S.rstMore.replace('{count}', '4'))), 'eight names, then how many more');
  assert.match(ask, /class="rst-row on"/);
  const dry = restoreSectionHtml(P, data, { mode: 'dry', ui: { step: 'confirm', pointId: 'R20260930110000beef', plan } });
  assert.doesNotMatch(dry, /data-rst-act="yes"/, 'preview: the plan only');
  assert.ok(dry.includes(esc(S.rstDryNote)));
  const same = restoreSectionHtml(P, data, { mode: 'live', ui: { step: 'confirm', pointId: 'R20260930110000beef', plan: { counts: { changed: 0, missing: 0, added: 0 } } } });
  assert.ok(same.includes(esc(S.rstNothing)) && !same.includes('data-rst-act="yes"'));
  assert.match(restoreSectionHtml(P, data, { mode: 'live', ui: { step: 'busy', pointId: 'R20260930110000beef' } }), /data-rst-act="preview"[^>]* disabled/);
  const done = restoreSectionHtml(P, data, { mode: 'live', ui: { step: 'done', result: { restored: 1, removed: 12, failed: [] } } });
  assert.ok(done.includes(esc(S.rstDone.replace('{restored}', '1').replace('{removed}', '12'))) && done.includes(esc(S.rstUndo)));
  // The cache asks once per ttl; refresh asks at once
  let calls = 0;
  const r = createRestore({ fetchJson: async () => (calls++, data), now: () => 0 });
  r.get('p');
  r.get('p');
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(calls, 1);
  r.refresh('p');
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(calls, 2);
  r.setUi('p', { step: 'bogus' });
  assert.deepEqual(r.ui('p'), {});
  for (const k of Object.keys(STRINGS.en).filter((x) => x.startsWith('rst'))) assert.ok(STRINGS.tr[k], `tr ${k}`);
  setLanguage('en');
});

test('audit round 1: the same size and time with other bytes is seen and kept; a file and a folder can swap; the plan the person saw is the plan applied; the point gone back to survives pruning; device names are refused', () => {
  const w = world();
  w.write('same.txt', 'AAAA');
  w.write('docs', 'a file named docs');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, reason: 'ai-start', now: tick });
  // Same size, same time, other bytes (a tool that keeps times): the plan sees it by its sha1
  const file = path.join(w.dir, 'same.txt');
  const { mtime } = fs.statSync(file);
  fs.writeFileSync(file, 'BBBB');
  fs.utimesSync(file, mtime, mtime);
  // docs was a file and is now a folder
  fs.rmSync(path.join(w.dir, 'docs'));
  w.write('docs/new.md', 'new');
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id });
  assert.deepEqual([plan.changed, plan.missing, plan.added], [['same.txt'], ['docs'], ['docs/new.md']]);
  assert.match(plan.planId, /^[0-9a-f]{16}$/);
  // The plan changed after the preview: refused, nothing touched
  w.write('extra.txt', 'x');
  assert.deepEqual(applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, planId: plan.planId, now: tick }), { ok: false, problem: 'plan-changed' });
  assert.equal(w.read('same.txt'), 'BBBB');
  fs.rmSync(path.join(w.dir, 'extra.txt'));
  const r = applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, planId: plan.planId, now: tick });
  assert.deepEqual([r.ok, r.restored, r.removed, r.failed], [true, 2, 1, []]);
  assert.equal(w.read('same.txt'), 'AAAA');
  assert.equal(w.read('docs'), 'a file named docs', 'the folder went first, the file took its place');
  // The bytes that were overwritten are in the point of the present (always a new copy, never a reused one)
  const undo = applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: r.before, now: tick });
  assert.equal(undo.ok, true);
  assert.equal(w.read('same.txt'), 'BBBB');
  assert.equal(w.read('docs/new.md'), 'new');
  // Many points later, going back to the oldest still works: it is protected while its restore runs
  for (let i = 0; i < 7; i++) {
    w.write('same.txt', `v${i}`);
    createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  }
  const list = listPoints({ hubDir: w.hub, projectId: w.projectId });
  const oldest = list.at(-1).id;
  w.write('same.txt', 'last');
  const back = applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: oldest, now: tick });
  assert.equal(back.ok, true);
  assert.ok(listPoints({ hubDir: w.hub, projectId: w.projectId }).some((x) => x.id === oldest), 'the point gone back to is kept');
  // Ids grow even when the clock goes back
  const early = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, reuse: false, now: () => Date.UTC(2020, 0, 1) });
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId })[0].id, early.id);
  // Windows device names and build folders at the top are never a path of a point
  for (const bad of ['CON', 'nul.txt', 'a/aux.js', 'COM1']) assert.equal(safeRel(bad), false, bad);
  const w2 = world();
  w2.write('out/app.js', 'build');
  w2.write('assets/out/pic.txt', 'mine');
  assert.deepEqual(scanProject(w2.dir).files.map((f) => f.rel), ['assets/out/pic.txt'], 'build output at the top only; the same name deeper is kept');
});

test('a project over the limits gets a lean point: big files and logs left out and counted, never touched by going back; the present is kept the same way', async () => {
  const { LEAN } = await import('../server/restore.mjs');
  const w = world();
  w.write('Assets/Player.cs', 'class Player {}');
  w.write('Assets/Menu.uss', '.menu {}');
  w.write('build.log', 'log line\n');
  const big = Buffer.alloc(LEAN.fileBytes + 10, 7);
  fs.writeFileSync(path.join(w.dir, 'Assets', 'model.fbx'), big);
  const limits = { ...RESTORE_LIMITS, bytes: LEAN.fileBytes };
  assert.equal(scanProject(w.dir, limits).problem, 'too-large', 'over the limit as it is');
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, reason: 'ai-start', now: tick, limits });
  assert.equal(p.ok, true);
  assert.deepEqual([p.scope, p.leftOut, p.files], ['lean', 2, 2], 'the code is kept, the model and the log are counted');
  const listed = listPoints({ hubDir: w.hub, projectId: w.projectId })[0];
  assert.deepEqual([listed.scope, listed.leftOut], ['lean', 2]);
  // Nothing changed: the same lean point
  assert.equal(createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick, limits }).reused, true);
  // The AI changes the code, rewrites the model and the log, adds a file
  w.write('Assets/Player.cs', 'class Player { broken }');
  fs.writeFileSync(path.join(w.dir, 'Assets', 'model.fbx'), Buffer.alloc(LEAN.fileBytes + 20, 9));
  w.write('build.log', 'another run\n');
  w.write('Assets/Enemy.cs', 'class Enemy {}');
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, limits });
  assert.deepEqual([plan.changed, plan.missing, plan.added], [['Assets/Player.cs'], [], ['Assets/Enemy.cs']], 'left out: neither changed nor added');
  const r = applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, planId: plan.planId, now: tick, limits });
  assert.equal(r.ok, true);
  assert.deepEqual([r.restored, r.removed, r.failed], [1, 1, []]);
  assert.equal(w.read('Assets/Player.cs'), 'class Player {}');
  assert.equal(w.has('Assets/Enemy.cs'), false);
  assert.equal(fs.statSync(path.join(w.dir, 'Assets', 'model.fbx')).size, LEAN.fileBytes + 20, 'the model is the AI\'s, untouched');
  assert.equal(w.read('build.log'), 'another run\n', 'the log untouched');
  const before = listPoints({ hubDir: w.hub, projectId: w.projectId }).find((x) => x.id === r.before);
  assert.equal(before.scope, 'lean', 'the present was kept the same way, so the restore can be undone');
  // A project within the limits keeps a full point
  const small = world();
  small.write('index.html', '<p>hi</p>');
  small.write('debug.log', 'x');
  const full = createPoint({ hubDir: small.hub, projectId: small.projectId, dir: small.dir, now: tick });
  assert.deepEqual([full.scope, full.leftOut, full.files], ['full', 0, 2]);
});

test('a game engine project in a subfolder: its regenerated folders are left out wherever it sits; top-level builds too', () => {
  const w = world();
  w.write('Game/Assets/Player.cs', 'class Player {}');
  w.write('Game/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.3');
  for (const regen of ['Game/Library/cache.bin', 'Game/Temp/x.tmp', 'Game/Logs/a.txt', 'Game/obj/b.dll', 'Game/UserSettings/c.asset', 'Game/Builds/game.exe', 'builds/windows-dev/game.exe', 'tool/.godot/cache.bin']) w.write(regen, 'x');
  w.write('notes/Library/kept.md', 'a folder named Library outside a Unity project is the person\'s');
  const scan = scanProject(w.dir);
  assert.deepEqual(scan.files.map((f) => f.rel), ['Game/Assets/Player.cs', 'Game/ProjectSettings/ProjectVersion.txt', 'notes/Library/kept.md']);
});

test('the copy without holding the server (start-ai): the same point as the synchronous one; the event loop keeps turning', async () => {
  const { createPointAsync } = await import('../server/restore.mjs');
  const w = world();
  for (let i = 0; i < 40; i++) w.write(`src/f${i}.js`, `export const n = ${i};`);
  let turns = 0;
  const timer = setInterval(() => turns++, 0);
  const p = await createPointAsync({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, reason: 'ai-start', now: tick });
  clearInterval(timer);
  assert.deepEqual([p.ok, p.reused, p.files, p.scope], [true, false, 40, 'full']);
  assert.ok(turns > 0, 'other work ran during the copy');
  assert.equal(listPoints({ hubDir: w.hub, projectId: w.projectId })[0].id, p.id);
  // Nothing changed: the synchronous one answers the same point
  assert.equal(createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick }).reused, true);
  w.write('src/f0.js', 'changed');
  const plan = planRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id });
  assert.deepEqual(plan.changed, ['src/f0.js'], 'the async copy is a real point to go back to');
  // No hub: the reason, no throw
  assert.deepEqual(await createPointAsync({ hubDir: null, projectId: w.projectId, dir: w.dir }), { ok: false, problem: 'no-hub' });
});

// 2026-10-02: a point taken for a job keeps the job's first words, so the list says what going back undoes
test('a point keeps the job it was taken for: one line, at most LABEL_MAX characters; the page says "before <job>"', async () => {
  const w = world();
  w.write('index.html', 'v1');
  createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, reason: 'ai-start', now: tick, label: 'Menü sayfası\n  ekle' });
  w.write('index.html', 'v2');
  createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, reason: 'ai-start', now: tick, label: 'x'.repeat(200) });
  w.write('index.html', 'v3');
  createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, reason: 'ai-start', now: tick });
  const [none, long, first] = listPoints({ hubDir: w.hub, projectId: w.projectId });
  assert.equal(first.label, 'Menü sayfası ekle');
  assert.equal(long.label.length, LABEL_MAX);
  assert.equal(none.label, '', 'no job, no label');
  const { restoreSectionHtml } = await import('../public/js/restore.js');
  const { setLanguage, STRINGS } = await import('../public/js/i18n.js');
  setLanguage('tr');
  const h = restoreSectionHtml({ id: 'p', path: w.dir }, { points: [first, none] }, { mode: 'live' });
  setLanguage('en');
  assert.ok(h.includes('“Menü sayfası ekle” işinden önce') && h.includes(STRINGS.tr.rstReason_ai_start ?? STRINGS.tr['rstReason_ai-start']));
  assert.ok(fs.readFileSync(new URL('../server/actions.mjs', import.meta.url), 'utf8').includes("await takeStartPoint(ctx.pointProjectId, ctx.job || '', jobId)"), 'start-ai names the job');
});
