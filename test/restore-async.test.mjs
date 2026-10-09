// Going back without holding the server (review A2): the files are put back one at a time while every other request
// keeps moving; a mark says a restore is under way and stays only when it stopped halfway, with its two ways out; an AI
// start and a restore never run in one project at once. Nothing is started, every file lives in the system temp
// folder. Run: node --test test/restore-async.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { initHub } from '../server/hub.mjs';
import { Catalog } from '../server/catalog.mjs';
import { createActions } from '../server/actions.mjs';
import { createHandler } from '../server/app.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';
import { RESTORE_KEEP, RESTORE_MARK, applyRestore, createPoint, listPoints, pointsDir, projectRestore, readRestoreMark } from '../server/restore.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-restore-async-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let n = 0;
let clock = Date.UTC(2026, 9, 9, 9, 0, 0);
const tick = () => (clock += 1000);

// A project of `files` small files, its hub, and a catalog that lists it
function world(files) {
  const base = path.join(TMP, `w${++n}`);
  const hub = path.join(base, 'hub');
  const dir = path.join(base, 'work', 'site');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  initHub(hub);
  for (let i = 0; i < files; i++) {
    fs.mkdirSync(path.join(dir, `d${i % 10}`), { recursive: true });
    fs.writeFileSync(path.join(dir, `d${i % 10}`, `f${i}.txt`), `first ${i}\n`);
  }
  fs.writeFileSync(path.join(hub, 'registry', 'projects.json'), JSON.stringify({ projects: [{ id: 'site', name: 'Site', path: dir }] }));
  return { base, hub, dir, home, projectId: 'site' };
}
const changeAll = (w, files) => {
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(w.dir, `d${i % 10}`, `f${i}.txt`), `second ${i}\n`);
};
const markFile = (w) => path.join(pointsDir(w.hub, w.projectId), RESTORE_MARK);

test('going back: the event loop keeps turning, a mark is there while it runs and gone after; every file is back', async (ctx) => {
  if (process.platform !== 'win32') return ctx.skip('Windows paths');
  const w = world(400);
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  assert.equal(p.ok, true);
  changeAll(w, 400);
  let turns = 0;
  let sawMark = false;
  let done = false;
  const run = applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: p.id, now: tick }).finally(() => (done = true));
  while (!done) {
    await new Promise((r) => setImmediate(r));
    turns++;
    if (fs.existsSync(markFile(w))) sawMark = true;
  }
  const r = await run;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 400);
  assert.deepEqual(r.failed, []);
  assert.ok(turns > 100, `other work ran meanwhile (${turns} turns)`);
  assert.ok(sawMark, 'the mark was there while files were put back');
  assert.equal(fs.existsSync(markFile(w)), false, 'and removed at the end');
  assert.equal(readRestoreMark({ hubDir: w.hub, projectId: w.projectId }), null);
  assert.equal(fs.readFileSync(path.join(w.dir, 'd7', 'f397.txt'), 'utf8'), 'first 397\n');
});

test('a restore that stopped halfway: listed with its two points, both kept by pruning; a broken mark is ignored; the next going back clears it', async (ctx) => {
  if (process.platform !== 'win32') return ctx.skip('Windows paths');
  const w = world(5);
  const to = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  changeAll(w, 5);
  const before = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, reason: 'before-restore', now: tick, reuse: false });
  // What a stop halfway leaves: the mark, written before the first file was touched
  const at = clock;
  fs.writeFileSync(markFile(w), JSON.stringify({ version: 1, to: to.id, before: before.id, at }));
  // More points than are kept: the two the mark names survive
  for (let i = 0; i < RESTORE_KEEP + 2; i++) {
    fs.writeFileSync(path.join(w.dir, 'd0', 'f0.txt'), `edit ${i}\n`);
    assert.equal(createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick }).ok, true);
  }
  const ids = listPoints({ hubDir: w.hub, projectId: w.projectId }).map((x) => x.id);
  assert.ok(ids.includes(to.id) && ids.includes(before.id), 'the way forward and the way back are kept');
  const catalog = { getProject: (id) => (id === w.projectId ? { id } : null), hubDir: w.hub };
  assert.deepEqual(projectRestore({ catalog, projectId: w.projectId }).body.interrupted, { at, to: to.id, before: before.id, toAvailable: true, beforeAvailable: true });

  for (const broken of ['{', JSON.stringify({ version: 2, to: to.id, before: before.id, at: 1 }), JSON.stringify({ version: 1, to: '../x', before: before.id, at: 1 }), JSON.stringify({ version: 1, to: to.id, before: before.id })]) {
    fs.writeFileSync(markFile(w), broken);
    assert.equal(projectRestore({ catalog, projectId: w.projectId }).body.interrupted, null, broken);
  }
  fs.writeFileSync(markFile(w), JSON.stringify({ version: 1, to: to.id, before: before.id, at: clock }));
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: to.id, now: tick });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(projectRestore({ catalog, projectId: w.projectId }).body.interrupted, null, 'a going back that finished clears it');
});

test('cut off before the first file (or after the last): its way out has nothing to change and still clears the mark; another point does not', async (ctx) => {
  if (process.platform !== 'win32') return ctx.skip('Windows paths');
  const w = world(3);
  const to = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  changeAll(w, 3);
  const before = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, reason: 'before-restore', now: tick, reuse: false });
  const other = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick, reuse: false });
  const mark = JSON.stringify({ version: 1, to: to.id, before: before.id, at: clock });
  // The project is exactly "before" (no file was touched): going back to another point that is the same changes
  // nothing, and says nothing about the cut restore
  fs.writeFileSync(markFile(w), mark);
  assert.equal((await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: other.id, now: tick })).restored, 0);
  assert.ok(readRestoreMark({ hubDir: w.hub, projectId: w.projectId }), 'a point the mark does not name leaves it');
  const r = await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: before.id, now: tick });
  assert.deepEqual(r, { ok: true, before: null, restored: 0, removed: 0, failed: [] });
  assert.equal(readRestoreMark({ hubDir: w.hub, projectId: w.projectId }), null, 'returning to before it: over');
  // Cut after the last file: the project already is "to"
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(w.dir, `d${i % 10}`, `f${i}.txt`), `first ${i}\n`);
  fs.writeFileSync(markFile(w), mark);
  assert.equal((await applyRestore({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, id: to.id, now: tick })).restored, 0);
  assert.equal(readRestoreMark({ hubDir: w.hub, projectId: w.projectId }), null, 'finishing it: over');
});

// The real actions behind the real handler, as the journey test drives them
async function serve(w) {
  const cmdExe = path.join(w.base, 'system32', 'cmd.exe');
  const toolFile = path.join(w.base, 'tools', 'claude.exe');
  for (const f of [cmdExe, toolFile]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
  }
  const detector = {
    detect: async () => ({
      at: 5,
      tools: [{ id: 'claude', name: 'Claude Code', installed: true, chosen: { file: toolFile, ext: '.exe', extra: false }, installs: [{ file: toolFile, via: 'native', version: '2.1.284' }], via: 'native', version: '2.1.284', ready: 'yes', app: false }],
      node: { installed: true, version: '24.18.0' },
    }),
  };
  const app = path.join(w.base, 'program');
  fs.mkdirSync(app, { recursive: true });
  const catalog = new Catalog({ hubDir: w.hub, claudeDir: path.join(w.home, '.claude'), homeDir: w.home, adapters: [], env: {} });
  catalog.load();
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const spawn = () => {
    throw new Error('nothing is started');
  };
  const actions = createActions({ catalog, ingest: { sessions: new Map(), scan: { done: true } }, mode: 'live', hubDir: w.hub, port, workDir: app, cmdExe, powershellExe: cmdExe, spawn, homeDir: w.home, claudeDir: path.join(w.home, '.claude'), now: () => (clock += 5000), log: () => {}, ai: { tools: detector, env: { USERPROFILE: w.home, LOCALAPPDATA: path.join(w.home, 'AppData', 'Local') } } });
  server.on('request', createHandler({ ingest: { sessions: new Map(), scan: { done: true } }, catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, actions, tools: detector }));
  const headers = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-SiberSentez-Token': actions.token };
  const post = (body) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/action', method: 'POST', agent: false, headers }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  return { post, close: () => new Promise((r) => server.close(r)) };
}
// Polls every few milliseconds for up to 30 s
const until = async (cond, what) => {
  for (const end = Date.now() + 30000; Date.now() < end; ) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 3));
  }
  assert.fail(`never: ${what}`);
};

test('while a project is being put back, an AI start in it is refused (restore-running); after, it starts', async (ctx) => {
  if (process.platform !== 'win32') return ctx.skip('Windows paths');
  const w = world(600);
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  changeAll(w, 600);
  const s = await serve(w);
  try {
    const back = s.post({ action: 'restore-apply', projectId: w.projectId, pointId: p.id });
    await until(() => fs.existsSync(markFile(w)), 'the restore under way');
    const start = await s.post({ action: 'start-ai', projectId: w.projectId, tool: 'claude', job: 'Bir sayfa yap', inDock: true });
    assert.deepEqual([start.status, start.json.error], [409, 'restore-running']);
    const done = await back;
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.result.restored, 600);
    const again = await s.post({ action: 'start-ai', projectId: w.projectId, tool: 'claude', job: 'Bir sayfa yap', inDock: true });
    assert.equal(again.status, 200, JSON.stringify(again.json));
  } finally {
    await s.close();
  }
});

test('while an AI start takes its copy of a project, going back in it is refused (ai-working)', async (ctx) => {
  if (process.platform !== 'win32') return ctx.skip('Windows paths');
  const w = world(600);
  const p = createPoint({ hubDir: w.hub, projectId: w.projectId, dir: w.dir, now: tick });
  changeAll(w, 600);
  const s = await serve(w);
  try {
    const start = s.post({ action: 'start-ai', projectId: w.projectId, tool: 'claude', job: 'Bir sayfa yap', inDock: true });
    const base = pointsDir(w.hub, w.projectId);
    await until(() => fs.readdirSync(base).some((x) => x.includes('.tmp-')), 'the start copy under way');
    const back = await s.post({ action: 'restore-apply', projectId: w.projectId, pointId: p.id });
    assert.deepEqual([back.status, back.json.error], [409, 'ai-working']);
    assert.equal((await start).status, 200);
  } finally {
    await s.close();
  }
});

test('the drawer says a restore stopped halfway, first, with its two ways out; a gone point offers no button; off disables both', async () => {
  const { setLanguage } = await import('../public/js/i18n.js');
  const { restoreSectionHtml } = await import('../public/js/restore.js');
  const to = 'R20261009090001aaaa';
  const before = 'R20261009090002bbbb';
  const points = [{ id: before, at: 2, reason: 'before-restore', files: 5 }, { id: to, at: 1, reason: 'ai-start', files: 5 }];
  const p = { id: 'site', path: 'C:\\work\\site' };
  setLanguage('tr');
  try {
    const h = restoreSectionHtml(p, { points, interrupted: { at: Date.UTC(2026, 9, 9, 9, 0, 0), to, before, toAvailable: true, beforeAvailable: true } }, { mode: 'live' });
    assert.ok(h.includes('Geri dönüş yarıda kesildi'), 'said in plain words');
    assert.ok(h.indexOf('rst-cut') < h.indexOf('rst-list'), 'before the list');
    assert.ok(h.includes(`data-rst-id="${to}" data-fk="rst:cut-to">Tamamlamayı gözden geçir`));
    assert.ok(h.includes(`data-rst-id="${before}" data-fk="rst:cut-before">Önceki hâle dönmeyi gözden geçir`));
    const gone = restoreSectionHtml(p, { points: points.slice(0, 1), interrupted: { at: 1, to, before, toAvailable: false, beforeAvailable: true } }, { mode: 'live' });
    assert.ok(!gone.includes('rst:cut-to') && gone.includes('rst:cut-before'));
    const off = restoreSectionHtml(p, { points, interrupted: { at: 1, to, before, toAvailable: true, beforeAvailable: true } }, { mode: 'off' });
    assert.equal((off.match(/data-fk="rst:cut-[a-z]+" aria-disabled="true"/g) || []).length, 2);
    assert.ok(!restoreSectionHtml(p, { points, interrupted: null }, { mode: 'live' }).includes('rst-cut'), 'nothing when nothing stopped');
  } finally {
    setLanguage('en');
  }
});
