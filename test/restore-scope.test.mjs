// What the copy a job's start takes would hold, shown before the job (server/restore.mjs projectRestoreScope,
// public/js/restore.js scopeHtml, docs/restore.md §12; independent review of 0.18.0 §7.3). Run:
// node --test test/restore-scope.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPoint, projectRestoreScope, pointsDir, RESTORE_LIMITS, SCOPE_BIG } from '../server/restore.mjs';
import { scopeHtml, createScopes, scopeTakesCopy } from '../public/js/restore.js';
import { setLanguage } from '../public/js/i18n.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-restore-scope-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

function setup(name, { hubInside = false } = {}) {
  const dir = path.join(ROOT, name, 'project');
  const hub = hubInside ? path.join(dir, 'hub') : path.join(ROOT, name, 'hub');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(hub, { recursive: true });
  const catalog = { hubDir: hub, getProject: (id) => (id === 'p' ? { id: 'p', path: dir } : null) };
  return { hub, dir, catalog };
}
const write = (dir, rel, data) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), data);
};

test('a full copy: its files and bytes, the folders it leaves out and why; nothing is copied', () => {
  const { hub, dir, catalog } = setup('full', { hubInside: true });
  write(dir, 'index.html', '<h1>hi</h1>');
  write(dir, 'src/app.js', 'let a = 1;');
  write(dir, 'node_modules/x/index.js', 'x');
  write(dir, '.git/HEAD', 'ref');
  write(dir, 'dist/app.js', 'built');
  write(dir, '.claude/settings.json', '{}');
  write(dir, 'src/.venv/lib.py', 'v');
  write(dir, 'hub/registry/projects.json', '[]');
  const r = projectRestoreScope({ catalog, projectId: 'p' });
  assert.equal(r.status, 200);
  const b = r.body;
  assert.deepEqual([b.ok, b.scope, b.files, b.bytes, b.leftOut], [true, 'full', 2, 21, 0]);
  const why = Object.fromEntries(b.skipped.map((d) => [d.name, d.why]));
  assert.deepEqual(why, { '.claude': 'tools', '.git': 'history', dist: 'build', hub: 'hub', node_modules: 'packages', '.venv': 'packages' });
  assert.deepEqual(b.big, []);
  assert.equal(fs.existsSync(pointsDir(hub, 'p')), false, 'a look, not a copy');
});

test('it matches the point a start takes: the same scope, files and bytes, full or lean', () => {
  const { hub, dir, catalog } = setup('same');
  write(dir, 'a.txt', 'aaaa');
  write(dir, 'b/c.txt', 'cc');
  const look = projectRestoreScope({ catalog, projectId: 'p' }).body;
  const point = createPoint({ hubDir: hub, projectId: 'p', dir, reuse: false });
  assert.deepEqual([look.scope, look.files, look.bytes], [point.scope, point.files, point.bytes]);

  // Over the full limits: both go lean, the big file and the log left out alike
  const limits = { ...RESTORE_LIMITS, bytes: 1024 };
  write(dir, 'big.bin', Buffer.alloc(3 * 1024 * 1024));
  write(dir, 'run.log', 'log line');
  const lean = projectRestoreScope({ catalog, projectId: 'p', limits }).body;
  const leanPoint = createPoint({ hubDir: hub, projectId: 'p', dir, reuse: false, limits });
  assert.deepEqual([lean.scope, lean.files, lean.bytes, lean.leftOut], [leanPoint.scope, leanPoint.files, leanPoint.bytes, leanPoint.leftOut]);
  assert.deepEqual([lean.scope, lean.leftOut], ['lean', 2]);
});

test('a lean copy names its largest left-out files first, at most a few', () => {
  const { dir, catalog } = setup('lean');
  write(dir, 'small.txt', 'x');
  for (let i = 1; i <= SCOPE_BIG + 2; i++) write(dir, `media/m${i}.bin`, Buffer.alloc(2 * 1024 * 1024 + i * 1000));
  write(dir, 'logs-here/app.log', 'tiny log');
  const b = projectRestoreScope({ catalog, projectId: 'p', limits: { ...RESTORE_LIMITS, bytes: 1024 } }).body;
  assert.deepEqual([b.ok, b.scope, b.files, b.leftOut], [true, 'lean', 1, SCOPE_BIG + 3]);
  assert.equal(b.big.length, SCOPE_BIG);
  assert.equal(b.big[0].rel, `media/m${SCOPE_BIG + 2}.bin`, 'the largest first');
  assert.ok(b.big.every((x, i, a) => i === 0 || a[i - 1].size >= x.size));
  assert.ok(b.leftBytes > SCOPE_BIG * 2 * 1024 * 1024);
});

test('no copy possible, not listed, no hub, a broad folder: said, never a scan of the wrong place', () => {
  const { dir, catalog } = setup('big');
  for (let i = 0; i < 6; i++) write(dir, `f${i}.txt`, 'x');
  // Over the full limit of files only: a lean copy (its own limit is LEAN.files), as a start's point
  const over = projectRestoreScope({ catalog, projectId: 'p', limits: { ...RESTORE_LIMITS, files: 2 } }).body;
  assert.deepEqual([over.ok, over.scope, over.files], [true, 'lean', 6]);
  const deep = path.join(dir, ...Array.from({ length: RESTORE_LIMITS.depth + 2 }, (_, i) => `d${i}`));
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'x.txt'), 'x');
  assert.deepEqual(projectRestoreScope({ catalog, projectId: 'p' }).body, { project: 'p', ok: false, problem: 'too-deep' });
  assert.equal(projectRestoreScope({ catalog, projectId: 'other' }).status, 404);
  assert.deepEqual(projectRestoreScope({ catalog: { ...catalog, hubDir: null }, projectId: 'p' }).body, { project: 'p', ok: false, problem: 'no-hub' });
  // The gate a start's point passes (takeStartPoint): a hub folder that is not there, a hub of the old layout, the
  // refusals of resolveProject
  assert.deepEqual(projectRestoreScope({ catalog: { ...catalog, hubDir: path.join(ROOT, 'big', 'no-such-hub') }, projectId: 'p' }).body, { project: 'p', ok: false, problem: 'no-hub' });
  const broad = { ...catalog, isBroad: () => true };
  assert.deepEqual(projectRestoreScope({ catalog: broad, projectId: 'p' }).body, { project: 'p', ok: false, problem: 'broad-folder' });
  const old = path.join(ROOT, 'big', 'old-hub');
  fs.mkdirSync(path.join(old, 'kutuphane'), { recursive: true });
  assert.deepEqual(projectRestoreScope({ catalog: { ...catalog, hubDir: old }, projectId: 'p' }).body, { project: 'p', ok: false, problem: 'legacy-hub' });
  const gone = { ...catalog, getProject: (id) => (id === 'p' ? { id: 'p', path: path.join(ROOT, 'big', 'not-there') } : null) };
  assert.deepEqual(projectRestoreScope({ catalog: gone, projectId: 'p' }).body, { project: 'p', ok: false, problem: 'folder-missing' });
});

test('a Unity project in a subfolder: its generated folders count as build; the folder list says how many more', () => {
  const { dir, catalog } = setup('unity');
  write(dir, 'game/Assets/a.cs', 'x');
  write(dir, 'game/ProjectSettings/p.asset', 'x');
  write(dir, 'game/Library/cache.bin', 'x');
  const b = projectRestoreScope({ catalog, projectId: 'p' }).body;
  assert.deepEqual(b.skipped.find((d) => d.name === 'Library'), { name: 'Library', why: 'build' });
  assert.equal(b.moreDirs, 0);
  // One entry a folder name; cut at 12 only when there are more
  const many = setup('many');
  for (const n of ['node_modules', '.git', 'dist', 'build', 'out', 'bin', 'obj', 'target', 'coverage', '.next', '.nuxt', '.turbo', '.venv', '__pycache__']) write(many.dir, `${n}/x`, 'x');
  const m = projectRestoreScope({ catalog: many.catalog, projectId: 'p' }).body;
  assert.deepEqual([m.skipped.length, m.moreDirs], [12, 2]);
});

test('the line under Start: the count and size, what it leaves out folded with the reasons, escaped', () => {
  setLanguage('tr');
  assert.equal(scopeHtml(null), '');
  // No copy possible, whatever the reason: said before the job, and Start's line promises no restore point
  assert.ok(scopeHtml({ ok: false, problem: 'no-hub' }).includes('Bu işten önce kopya alınamaz'));
  assert.ok(scopeHtml({ ok: false, problem: 'legacy-hub' }).includes('job-scope warn'));
  assert.deepEqual([scopeTakesCopy(null), scopeTakesCopy({ ok: true }), scopeTakesCopy({ ok: false, problem: 'too-deep' })], [true, true, false]);
  assert.equal(scopeHtml({ problem: 'odd' }), '', 'neither yes nor no: nothing');
  assert.equal(scopeHtml({ ok: true, scope: 'full', files: 0, bytes: 0 }), '<p class="small muted job-scope">İş başlarken önce projenin kopyası alınır (henüz dosyası yok); ona geri dönebilirsin.</p>', 'an empty project: no "1 KB"');
  assert.ok(scopeHtml({ ok: true, scope: 'full', files: 1, bytes: 10 }).includes('tek dosyanın'));
  const tooBig = scopeHtml({ ok: false, problem: 'too-many-files' });
  assert.ok(tooBig.includes('job-scope warn') && tooBig.includes('6.000'), tooBig);
  assert.ok(scopeHtml({ ok: false, problem: 'file-too-large' }).includes('150 MB'));
  const plain = scopeHtml({ ok: true, scope: 'full', files: 12, bytes: 2048, leftOut: 0, skipped: [], big: [] });
  assert.equal(plain, '<p class="small muted job-scope">İş başlarken önce 12 dosyanın (2 KB) kopyası alınır; ona geri dönebilirsin.</p>');
  const folded = scopeHtml({ ok: true, scope: 'lean', files: 40, bytes: 3 * 1024 * 1024, leftOut: 7, leftBytes: 30 * 1024 * 1024, skipped: [{ name: 'node_modules', why: 'packages' }, { name: '.git', why: 'history' }, { name: '<b>', why: 'build' }, { name: 'odd', why: 'nope' }], big: [{ rel: 'media/intro.mp4', size: 9 * 1024 * 1024 }] });
  assert.ok(folded.startsWith('<details class="job-scope">'), 'closed by default');
  assert.ok(folded.includes('7 büyük dosya ve günlük kopyaya girmez'));
  assert.ok(folded.includes('Kopyaya girmeyenler'));
  assert.ok(folded.includes('sürüm geçmişi: git saklar') && folded.includes('paketler ve önbellekler'));
  // No promise that a left-out folder comes back (review: build/ and bin/ often hold files of the person's own)
  assert.ok(folded.includes('derleme ve üretilmiş klasörler') && !/yeniden oluşur|geri getirir/.test(folded));
  assert.ok(folded.includes('en güvenli yer git'));
  assert.ok(scopeHtml({ ok: true, scope: 'full', files: 2, bytes: 2, skipped: [{ name: '.git', why: 'history' }], moreDirs: 3 }).includes('ve 3 klasör daha'));
  assert.ok(folded.includes('&lt;b&gt;') && !folded.includes('<b>'), 'names are escaped');
  assert.ok(!folded.includes('odd'), 'an unknown reason is not shown');
  assert.ok(folded.indexOf('.git') < folded.indexOf('node_modules'), 'history first, then packages');
  assert.ok(folded.includes('media/intro.mp4') && folded.includes('ve 6 dosya daha'));
  assert.ok(folded.includes('Geri dönüş, kopyaya girmeyenleri asla değiştirmez'));
  assert.ok(scopeHtml({ ok: true, scope: 'full', files: 1, bytes: 1, skipped: [{ name: '.git', why: 'history' }] }, { open: true }).startsWith('<details class="job-scope" open>'));
  setLanguage('en');
  assert.ok(scopeHtml({ ok: true, scope: 'full', files: 3, bytes: 10 }).includes('a copy of 3 files'));
  assert.ok(scopeHtml({ ok: true, scope: 'full', files: 1, bytes: 10 }).includes('a copy of its one file'), 'never "1 files"');
});

test('the job box shows it only when the start takes a copy', async () => {
  const { jobSectionHtml } = await import('../public/js/views/job.js');
  const tools = { status: 'ready', tools: [{ id: 'claude', name: 'Claude Code', installed: true }] };
  const p = { id: 'p', path: 'C:/p' };
  const backup = '<p class="small muted job-scope">SCOPE</p>';
  assert.ok(jobSectionHtml(p, null, { mode: 'live', tools, backup }).includes('SCOPE'), 'actions On');
  assert.ok(jobSectionHtml(p, null, { mode: 'off', turnOn: true, tools, backup }).includes('SCOPE'), 'Off with the one-step turn on');
  assert.ok(!jobSectionHtml(p, null, { mode: 'dry', tools, backup }).includes('SCOPE'), 'preview: no copy is taken');
  assert.ok(!jobSectionHtml(p, null, { mode: 'off', tools, backup }).includes('SCOPE'), 'Off without a way to turn on');
  assert.ok(!jobSectionHtml(p, null, { mode: 'live', tools, backup, offline: true }).includes('SCOPE'), 'the server is gone');
  assert.ok(!jobSectionHtml(p, null, { mode: 'off', turnOn: true, asking: true, tools, backup }).includes('SCOPE'), 'the turn-on question is on screen');
  setLanguage('en');
  assert.match(jobSectionHtml(p, null, { mode: 'live', tools }), /a restore point is taken/);
  assert.doesNotMatch(jobSectionHtml(p, null, { mode: 'live', tools, noCopy: true }), /restore point/, 'no copy possible: no promise of one');
});

test('answers are kept a while per project; forget asks again', async () => {
  let clock = 0;
  const asked = [];
  const arrived = [];
  const scopes = createScopes({ fetchJson: async (id) => (asked.push(id), { ok: true, files: asked.length }), onData: (id) => arrived.push(id), now: () => clock, ttl: 1000 });
  assert.equal(scopes.get('a'), null);
  assert.equal(scopes.get('a'), null, 'one request while one is on its way');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([asked, arrived, scopes.get('a')?.files], [['a'], ['a'], 1]);
  clock = 500;
  assert.equal(scopes.get('a').files, 1, 'still fresh');
  scopes.forget('a');
  assert.equal(scopes.get('a'), null);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(scopes.get('a').files, 2);
  assert.equal(scopes.get(''), null);
});

test('an answer asked for before forget is dropped; a failed look is asked again soon', async () => {
  let clock = 0;
  let release = (_v) => {};
  const calls = [];
  const answer = () => {
    calls.push(1);
    if (calls.length === 1) return new Promise((r) => (release = r));
    if (calls.length === 3) return Promise.reject(new Error('gone'));
    return Promise.resolve({ ok: true, files: calls.length });
  };
  const scopes = createScopes({ fetchJson: answer, now: () => clock, ttl: 60000, failTtl: 5000 });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  scopes.get('a');
  await tick();
  scopes.forget('a'); // a start took a copy while the first look was on its way
  scopes.get('a');
  await tick();
  assert.equal(scopes.get('a').files, 2);
  release({ ok: true, files: 99 }); // the old look answers last
  await tick();
  assert.equal(scopes.get('a').files, 2, 'the old answer did not come back');
  clock = 61000;
  scopes.get('a'); // the third look fails
  await tick();
  assert.equal(scopes.get('a').files, 2, 'the last answer is kept meanwhile');
  clock = 65000;
  scopes.get('a');
  await tick();
  assert.equal(calls.length, 3, 'not yet');
  clock = 67000;
  scopes.get('a');
  await tick();
  assert.equal(calls.length, 4, 'asked again soon after a failure');
});
