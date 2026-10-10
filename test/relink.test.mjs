// @ts-check
// A moved project linked to its new folder (docs/internal/project-relink-plan.md; server/relinks.mjs, catalog.mjs
// applyLinks, usage.mjs setJoins, actions.mjs project-relink): the kept project keeps its id and history, the new
// folder's own project is not listed, its sessions and hours join the kept one; undoing gives the folder back as its own
// project, and the hours joined so far stay with the kept project (never counted twice).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { initHub } from '../server/hub.mjs';
import { Catalog } from '../server/catalog.mjs';
import { ProjectMemory } from '../server/memory.mjs';
import { readRelinks, readJoins, writeRelinks, setRelink, removeRelink, relinkOf, joinOf, planRelink, RELINKS_FILE } from '../server/relinks.mjs';
import { UsageLedger, HOUR } from '../server/usage.mjs';
import { createActions } from '../server/actions.mjs';
import { createHandler } from '../server/app.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-relink-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

// A hub, a home, an old folder (gone) and a new one, both remembered as unregistered projects
function world({ registered = false } = {}) {
  const base = path.join(ROOT, `w${++n}`);
  const home = path.join(base, 'home');
  const hub = path.join(home, 'SiberSentez');
  initHub(hub);
  const oldDir = path.join(base, 'work', 'menu');
  const newDir = path.join(base, 'disk2', 'menu');
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(newDir, 'index.html'), '<title>menu</title>');
  if (registered) fs.writeFileSync(path.join(hub, 'registry', 'projects.json'), JSON.stringify({ projects: [{ id: 'menu', name: 'Menu', path: oldDir }] }));
  const memory = new ProjectMemory({ hubDir: hub, debounceMs: 0 });
  if (!registered) memory.record(oldDir, { via: 'claude-code', lastSeenAt: 1 });
  memory.record(newDir, { via: 'claude-code', lastSeenAt: 2 });
  memory.flush();
  const catalog = new Catalog({ hubDir: hub, claudeDir: path.join(home, '.claude'), homeDir: home, adapters: [], env: {}, memory });
  catalog.load();
  const byPath = (dir) => catalog.allProjects().find((p) => p.path === dir) || null;
  return { base, home, hub, oldDir, newDir, catalog, byPath };
}

test('the link file: known fields only, a project linked once (its newest link), written whole', () => {
  const w = world();
  const link = { id: 'x-menu', path: w.newDir, oldPath: w.oldDir, from: 'x-other', at: 5 };
  assert.deepEqual(relinkOf(link), link);
  assert.equal(relinkOf({ ...link, id: '<b>' }), null);
  assert.equal(relinkOf({ ...link, path: 'relative/folder' }), null, 'a local absolute folder only');
  assert.equal(relinkOf({ ...link, from: 'x-menu' }).from, null, 'never from itself');
  assert.equal(writeRelinks(w.hub, [link, { ...link, path: w.oldDir, at: 6 }, { bad: 1 }]), true);
  assert.deepEqual(readRelinks(w.hub).map((l) => [l.id, l.at]), [['x-menu', 6]], 'the newest link of a project');
  // Undone: the link goes, the hours joined so far stay with the kept project (a join until then)
  assert.deepEqual(removeRelink(w.hub, 'x-menu', 99), []);
  assert.deepEqual(readJoins(w.hub), [{ from: 'x-other', to: 'x-menu', until: 99 }]);
  assert.equal(removeRelink(w.hub, 'x-menu', 100), null, 'nothing to undo');
  assert.equal(joinOf({ from: 'a', to: 'a', until: 1 }), null);
  // Linked again from the same folder: the link joins all of its hours, the old join is not needed
  assert.ok(setRelink(w.hub, 'x-menu', link));
  assert.deepEqual(readJoins(w.hub), []);
  assert.equal(setRelink(w.hub, 'y', { ...link, id: 'y', oldPath: 'relative' }), null, 'a link that is not one is not "written"');
  assert.deepEqual(readRelinks(w.hub).map((l) => l.id), ['x-menu']);
  fs.writeFileSync(path.join(w.hub, 'registry', RELINKS_FILE), '{broken');
  assert.deepEqual(readRelinks(w.hub), []);
  assert.deepEqual(readRelinks(null), []);
});

test('an unregistered project linked to its new folder keeps its id; the new folder\'s own project leaves; undo gives both back', () => {
  const w = world();
  const old = w.byPath(w.oldDir);
  const own = w.byPath(w.newDir);
  assert.ok(old && own && old.id !== own.id);
  assert.equal(old.exists, false, 'the old folder is gone');
  const plan = planRelink({ catalog: w.catalog, projectId: old.id, from: own.id });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.deepEqual([plan.kept.id, plan.kept.oldPath, plan.folder.toLowerCase(), plan.from], [old.id, w.oldDir, w.newDir.toLowerCase(), own.id]);
  setRelink(w.hub, old.id, { id: old.id, path: plan.folder, oldPath: plan.kept.oldPath, from: plan.from, at: 10 });
  w.catalog.load();
  const kept = w.catalog.getProject(old.id);
  assert.deepEqual([kept.path.toLowerCase(), kept.exists, !!kept.linked], [w.newDir.toLowerCase(), true, true]);
  assert.equal(w.catalog.getProject(own.id), null, 'the new folder\'s own project is not listed');
  assert.equal(w.catalog.allProjects().filter((p) => p.name === 'menu').length, 1, 'one project');
  assert.equal(w.catalog.resolve(path.join(w.newDir, 'src'), null), old.id, 'sessions in the new folder');
  assert.equal(w.catalog.resolve(w.oldDir, null), old.id, 'old sessions still');
  assert.equal(w.catalog.knownProjectFor(w.newDir)?.id, old.id);
  // Undo: both as they were
  removeRelink(w.hub, old.id, 20);
  w.catalog.load();
  assert.equal(w.catalog.getProject(old.id).path, w.oldDir);
  assert.equal(w.catalog.getProject(old.id).exists, false);
  assert.ok(w.catalog.allProjects().some((p) => p.path.toLowerCase() === w.newDir.toLowerCase() && p.id !== old.id), 'the new folder is its own project again');
});

test('a registered project linked to a folder that was not listed: its registry is never written', () => {
  const w = world({ registered: true });
  fs.rmSync(path.join(w.hub, 'registry', 'discovered.json'), { force: true });
  const reg = fs.readFileSync(path.join(w.hub, 'registry', 'projects.json'), 'utf8');
  const before = w.catalog.getProject('menu');
  assert.equal(before.exists, false);
  const picked = path.join(w.base, 'disk3', 'menu');
  fs.mkdirSync(picked, { recursive: true });
  const plan = planRelink({ catalog: w.catalog, projectId: 'menu', folder: picked });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.joining, null, 'no project of its own there');
  setRelink(w.hub, 'menu', { id: 'menu', path: plan.folder, oldPath: plan.kept.oldPath, from: null, at: 1 });
  w.catalog.load();
  assert.deepEqual([w.catalog.getProject('menu').path, w.catalog.getProject('menu').exists], [plan.folder, true]);
  assert.equal(fs.readFileSync(path.join(w.hub, 'registry', 'projects.json'), 'utf8'), reg, 'the registry as it was');
});

test('the preview refuses what it should, with a reason', () => {
  const w = world();
  const old = w.byPath(w.oldDir);
  const own = w.byPath(w.newDir);
  assert.equal(planRelink({ catalog: w.catalog, projectId: own.id, folder: w.oldDir }).problem, 'not-moved', 'its folder is still there');
  assert.equal(planRelink({ catalog: w.catalog, projectId: 'nope', folder: w.newDir }).problem, 'not-a-project');
  assert.equal(planRelink({ catalog: w.catalog, projectId: old.id, folder: w.home }).problem, 'home');
  assert.equal(planRelink({ catalog: w.catalog, projectId: old.id, folder: path.join(w.base, 'nowhere') }).problem, 'missing');
  assert.equal(planRelink({ catalog: w.catalog, projectId: old.id, folder: path.join(w.hub, 'library') }).problem, 'hub');
  assert.equal(planRelink({ catalog: w.catalog, projectId: old.id, from: old.id }).problem, 'another-project');
  assert.equal(planRelink({ catalog: w.catalog, projectId: old.id, from: own.id, counts: (id) => ({ points: id === own.id ? 2 : 0, jobs: 0 }) }).problem, 'new-folder-has-points', 'its restore points would not follow');
  // Picking the new folder by hand finds its own project all the same
  assert.equal(planRelink({ catalog: w.catalog, projectId: old.id, folder: w.newDir }).from, own.id);
  assert.match(planRelink({ catalog: w.catalog, projectId: old.id, from: own.id }).planId, /^[0-9a-f]{16}$/);
  // Linked already: undo that first (a second link would drop the first folder's sessions and hours)
  setRelink(w.hub, old.id, { id: old.id, path: w.newDir, oldPath: w.oldDir, from: own.id, at: 1 });
  w.catalog.load();
  const third = path.join(w.base, 'disk3', 'menu');
  fs.mkdirSync(third, { recursive: true });
  assert.equal(planRelink({ catalog: w.catalog, projectId: old.id, folder: third }).problem, 'already-linked');
});

test('folders inside folders: a folder inside another project, or holding one, is refused; a project of its own inside a linked folder stays its own', () => {
  const w = world();
  const old = w.byPath(w.oldDir);
  // A folder holding a project of its own (backend): the link would take its sessions over
  const shop = path.join(w.base, 'disk4', 'shop');
  const backend = path.join(shop, 'backend');
  fs.mkdirSync(backend, { recursive: true });
  w.catalog.memory.record(backend, { via: 'claude-code', lastSeenAt: 3 });
  w.catalog.memory.flush();
  w.catalog.load();
  const inner = w.byPath(backend);
  assert.ok(inner, 'listed');
  assert.equal(planRelink({ catalog: w.catalog, projectId: old.id, folder: shop }).problem, 'holds-projects');
  // A folder inside another unregistered project's folder: that project's hours are not this folder's
  const sub = path.join(backend, 'docs');
  fs.mkdirSync(sub);
  assert.equal(planRelink({ catalog: w.catalog, projectId: old.id, folder: sub }).problem, 'another-project');
  // A link written anyway (an older file): the project inside keeps its own sessions, by the longest match
  setRelink(w.hub, old.id, { id: old.id, path: shop, oldPath: w.oldDir, from: null, at: 1 });
  w.catalog.load();
  assert.equal(w.catalog.resolve(path.join(backend, 'src'), null), inner.id);
  assert.equal(w.catalog.knownProjectFor(backend)?.id, inner.id);
  assert.equal(w.catalog.resolve(path.join(shop, 'src'), null), old.id);
});

test('the ledger books the new folder\'s own hours under the kept project: added up, the records follow, once', () => {
  const l = new UsageLedger({ now: () => 10 * HOUR, log: () => {}, debounceMs: 0 });
  const use = (key, pid, t, out) => l.add({ key, t, projectId: pid, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: out } });
  use('a', 'old', 9 * HOUR + 1, 100);
  use('b', 'new', 9 * HOUR + 2, 50);
  use('c', 'new', 8 * HOUR + 1, 7);
  const outOf = (pid) => [...l.cells(0, 20)].filter(([, p]) => p === pid).reduce((s, [, , mm]) => s + [...mm.values()].reduce((x, c) => x + c[4], 0), 0);
  assert.deepEqual([outOf('old'), outOf('new')], [100, 57]);
  assert.equal(l.joinProject('new', 'old'), true);
  assert.deepEqual([outOf('old'), outOf('new')], [157, 0]);
  assert.equal(l.joinProject('new', 'old'), false, 'nothing left the second time');
  // A message counted before the link grows later: its record follows the cell it went into
  use('b', 'new', 9 * HOUR + 2, 80);
  assert.deepEqual([outOf('old'), outOf('new')], [187, 0]);
});

test('an undone link keeps the hours it joined; a restart counts them once; later hours are the folder\'s own', () => {
  const w = world();
  const run = (now, joins) => {
    const l = new UsageLedger({ hubDir: w.hub, now: () => now, log: () => {}, debounceMs: 0 });
    l.setJoins(joins);
    return l;
  };
  const use = (l, key, pid, t, out) => l.add({ key, t, projectId: pid, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: out } });
  const outOf = (l, pid) => [...l.cells(0, 1e9)].filter(([, p]) => p === pid).reduce((s, [, , mm]) => s + [...mm.values()].reduce((x, c) => x + c[4], 0), 0);
  const T = 1000 * HOUR;
  // Before the link: two projects
  let l = run(T + 1, []);
  use(l, 'a', 'old', T - 2 * HOUR, 100);
  use(l, 'b', 'new', T - HOUR, 50);
  l.flush();
  // Linked (a restart reads the logs again; the new folder's sessions resolve to the kept project)
  l = run(T + 2 * HOUR, [{ from: 'new', to: 'old', until: null }]);
  use(l, 'a', 'old', T - 2 * HOUR, 100);
  use(l, 'b', 'old', T - HOUR, 50);
  assert.deepEqual([outOf(l, 'old'), outOf(l, 'new')], [150, 0]);
  l.flush();
  // Undone at T + 3h, then a restart: the logs book b under the folder's own id again; the join keeps it with old
  const until = T + 3 * HOUR;
  l = run(T + 5 * HOUR, [{ from: 'new', to: 'old', until }]);
  use(l, 'a', 'old', T - 2 * HOUR, 100);
  use(l, 'b', 'new', T - HOUR, 50);
  use(l, 'c', 'new', T + 4 * HOUR, 9);
  assert.deepEqual([outOf(l, 'old'), outOf(l, 'new')], [150, 9], 'counted once; the folder\'s hours after the undo are its own');
  l.flush();
  l = run(T + 6 * HOUR, [{ from: 'new', to: 'old', until }]);
  assert.deepEqual([outOf(l, 'old'), outOf(l, 'new')], [150, 9], 'and so in the file');
});

test('joining keeps each side as the merged view counts it: an hour whose logs are gone for one project loses nothing', () => {
  const w = world();
  const H = 500 * HOUR;
  const use = (l, key, pid, out) => l.add({ key, t: H + 1, projectId: pid, model: 'm', usage: { input_tokens: 1, output_tokens: out } });
  let l = new UsageLedger({ hubDir: w.hub, now: () => H + HOUR, log: () => {}, debounceMs: 0 });
  for (const k of ['o1', 'o2', 'o3']) use(l, k, 'old', 100);
  use(l, 'n1', 'new', 10);
  l.flush();
  // The next run: old's logs are gone (the file's hour wins), new's logs have one more message (the logs win)
  l = new UsageLedger({ hubDir: w.hub, now: () => H + 2 * HOUR, log: () => {}, debounceMs: 0 });
  use(l, 'n1', 'new', 10);
  use(l, 'n2', 'new', 10);
  assert.equal(l.joinProject('new', 'old'), true);
  const [[, pid, mm]] = [...l.cells(0, 1e9)];
  assert.deepEqual([pid, mm.get('m')[4], mm.get('m')[5]], ['old', 320, 5], '300 + 20 output, 3 + 2 messages');
});

test('the action: the preview writes nothing in live mode; the link only with the preview\'s planId; unlink keeps the hours joined', async () => {
  const w = world();
  const old = w.byPath(w.oldDir);
  const own = w.byPath(w.newDir);
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = /** @type {any} */ (server.address()).port;
  let changes = 0;
  let clock = 1000;
  const workDir = path.join(w.base, 'app');
  fs.mkdirSync(workDir, { recursive: true });
  const actions = createActions({ catalog: w.catalog, ingest: { sessions: new Map(), projectSessions: new Map([[own.id, new Set(['s1', 's2'])]]) }, mode: 'live', port, hubDir: w.hub, workDir, homeDir: w.home, claudeDir: path.join(w.home, '.claude'), spawn: () => { throw new Error('nothing starts'); }, now: () => (clock += 5000), log: () => {}, onChange: () => (changes++, w.catalog.load()) });
  server.on('request', createHandler({ ingest: { sessions: new Map() }, catalog: w.catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, actions }));
  const post = (body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/action', method: 'POST', agent: false, headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-SiberSentez-Token': actions.token } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data || 'null') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  try {
    const both = await post({ action: 'project-relink', projectId: old.id, folder: w.newDir, from: own.id });
    assert.deepEqual([both.status, both.json.error], [400, 'folder-or-from']);
    const look = await post({ action: 'project-relink', projectId: old.id, from: own.id, plan: true });
    assert.equal(look.status, 200, JSON.stringify(look.json));
    assert.deepEqual([look.json.result.executed, look.json.joining.sessions, changes, readRelinks(w.hub).length], [false, 2, 0, 0], 'a preview, nothing written');
    const stale = await post({ action: 'project-relink', projectId: old.id, from: own.id, planId: '0123456789abcdef' });
    assert.deepEqual([stale.status, stale.json.error, changes], [409, 'plan-changed', 0]);
    const bare = await post({ action: 'project-relink', projectId: old.id, from: own.id });
    assert.deepEqual([bare.json.error, changes], ['plan-changed', 0], 'never without the preview');
    const r = await post({ action: 'project-relink', projectId: old.id, from: own.id, planId: look.json.planId });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.result.executed, changes], [true, 1]);
    assert.equal(w.catalog.getProject(old.id).path.toLowerCase(), w.newDir.toLowerCase());
    const again = await post({ action: 'project-relink', projectId: own.id, folder: w.oldDir });
    assert.equal(again.status, 404, 'the new folder\'s own project is no project any more');
    const ask = await post({ action: 'project-unlink', projectId: old.id, plan: true });
    assert.deepEqual([ask.json.result.executed, readRelinks(w.hub).length], [false, 1]);
    const un = await post({ action: 'project-unlink', projectId: old.id });
    assert.deepEqual([un.status, un.json.result.executed], [200, true]);
    assert.equal(w.catalog.getProject(old.id).linked, undefined);
    assert.deepEqual(w.catalog.ledgerJoins().map((j) => [j.from, j.to]), [[own.id, old.id]], 'the joined hours stay with it');
    assert.deepEqual((await post({ action: 'project-unlink', projectId: old.id })).json.error, 'not-linked');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------- the page ----------------
test('the page: the folders with its name, a preview of what joins and stays, Link only in live mode; a linked project and its undo', async () => {
  const { relinkCandidates, relinkOfferHtml, relinkedHtml, relinkErrorText } = await import('../public/js/relink.js');
  const { setLanguage } = await import('../public/js/i18n.js');
  setLanguage('en');
  const moved = { id: 'x-menu', name: 'Menu', path: String.raw`C:\work\menu`, exists: false, kind: 'adhoc' };
  const projects = [
    moved,
    { id: 'x-menu-2', name: 'menu', path: String.raw`D:\disk2\menu`, exists: true, kind: 'adhoc' },
    { id: 'reg', name: 'Menu', path: String.raw`D:\reg\menu`, exists: true, kind: 'registered' },
    { id: 'left', name: 'Menu', path: String.raw`D:\left\menu`, exists: true, kind: 'adhoc', toolsOnly: true },
    { id: 'other', name: 'Shop', path: String.raw`D:\shop`, exists: true, kind: 'adhoc' },
  ];
  assert.deepEqual(relinkCandidates(projects, moved).map((x) => x.id), ['x-menu-2'], 'same name, unregistered, there, not left behind');
  const offer = relinkOfferHtml(moved, relinkCandidates(projects, moved), {}, 'live');
  assert.match(offer, /Moved\? Link it to its new folder/);
  assert.match(offer, /data-rl-act="preview" data-rl-from="x-menu-2"/);
  assert.match(relinkOfferHtml(moved, [], {}, 'live'), /No listed folder has its name/);
  const off = relinkOfferHtml(moved, relinkCandidates(projects, moved), {}, 'off');
  assert.ok(off.includes(String.raw`D:\disk2\menu`) && !off.includes('data-rl-act') && off.includes('Turn actions on to link it.'), 'actions off: named, nothing to press');
  assert.match(relinkOfferHtml(moved, relinkCandidates(projects, moved), {}, 'dry'), /data-rl-act="preview"/, 'Preview mode: the preview');
  assert.match(relinkOfferHtml(moved, [], { step: 'done' }, 'live'), /role="status">Menu is linked to its new folder./);
  assert.equal(relinkOfferHtml({ ...moved, exists: true }, [], {}, 'live'), '', 'its folder is there');
  const plan = { planId: '0123456789abcdef', kept: { id: 'x-menu', sessions: 12, points: 3, jobs: 2 }, folder: String.raw`D:\disk2\menu`, joining: { id: 'x-menu-2', sessions: 1 } };
  const confirm = relinkOfferHtml(moved, [], { step: 'confirm', from: 'x-menu-2', plan }, 'live');
  assert.match(confirm, /Link Menu to this folder\?/);
  assert.match(confirm, /12 sessions, 3 restore points, 2 job results/);
  assert.match(confirm, /The folder’s 1 session joins it\./);
  assert.match(confirm, /install them again here/);
  assert.match(confirm, /the hours already counted for that folder stay with this project/);
  assert.match(confirm, /data-rl-act="yes"/);
  assert.doesNotMatch(relinkOfferHtml(moved, [], { step: 'confirm', plan }, 'dry'), /data-rl-act="yes"/, 'Preview: nothing is linked');
  assert.doesNotMatch(relinkOfferHtml(moved, [{ ...projects[1], path: '<img>' }], {}, 'live'), /<img/, 'paths are text');
  const linked = { ...moved, exists: true, linked: { at: Date.UTC(2026, 9, 10, 9), oldPath: String.raw`C:\work\menu` } };
  assert.equal(relinkOfferHtml(linked, [], {}, 'live'), '');
  const note = relinkedHtml(linked, 'live');
  assert.ok(note.includes(String.raw`its folder before: C:\work\menu.`) && note.includes('data-rl-act="unlink"') && note.includes('data-fk="rl:head"'), note);
  assert.doesNotMatch(relinkedHtml(linked, 'off'), /data-rl-act/);
  const asked = relinkedHtml(linked, 'live', { step: 'unlink' });
  assert.ok(asked.includes('Undo the link?') && asked.includes('The hours already counted for it stay with this project') && asked.includes('data-rl-act="unlink-yes"') && asked.includes('data-rl-act="unlink-no"'), 'a question first, which says what does not come back');
  assert.equal(relinkErrorText({ error: 'new-folder-has-points' }), 'That folder has restore points or job results of its own; they would not follow, so it is not linked.');
  assert.match(relinkErrorText({ error: 'drive-root' }), /A whole drive cannot be a project/, 'the new-project folder rules\' words');
  assert.equal(relinkErrorText({ error: 'odd' }, () => 'fallback'), 'fallback');
  setLanguage('tr');
  try {
    assert.match(relinkOfferHtml(moved, [], { step: 'confirm', plan }, 'live'), /Menu bu klasöre bağlansın mı\?.*Geçmişi onunla kalır: 12 oturum, 3 geri dönüş noktası, 2 iş sonucu\./s);
  } finally {
    setLanguage('en');
  }
});

test('one folder id joins one project: a folder whose earlier hours stayed with another project is refused; a link without one keeps the hours on undo', async () => {
  const { normPath, slugify } = await import('../server/util.mjs');
  const w = world();
  const old = w.byPath(w.oldDir);
  const own = w.byPath(w.newDir);
  setRelink(w.hub, old.id, { id: old.id, path: w.newDir, oldPath: w.oldDir, from: own.id, at: 1 });
  removeRelink(w.hub, old.id, 50);
  // Another moved project with the same name
  const old2 = path.join(w.base, 'work2', 'menu');
  w.catalog.memory.record(old2, { via: 'claude-code', lastSeenAt: 4 });
  w.catalog.memory.flush();
  w.catalog.load();
  const k2 = w.byPath(old2);
  assert.ok(k2 && k2.id !== old.id && k2.exists === false);
  assert.equal(planRelink({ catalog: w.catalog, projectId: k2.id, from: own.id }).problem, 'folder-joined', 'its earlier hours stayed with the first project');
  assert.equal(planRelink({ catalog: w.catalog, projectId: old.id, from: own.id }).ok, true, 'the first project may link it again');
  // A link written without the folder's id (the folder was not listed): the undo joins the id the folder takes again
  const n = normPath(w.newDir);
  assert.equal(w.catalog.adhocIdFor(n, slugify(n).toLowerCase()), own.id, 'the id is made from the folder, as the catalog makes it');
  setRelink(w.hub, k2.id, { id: k2.id, path: path.join(w.base, 'disk9', 'menu'), oldPath: old2, from: null, at: 2 });
  removeRelink(w.hub, k2.id, 60, { folderId: 'x-disk9-menu' });
  assert.deepEqual(readJoins(w.hub).map((j) => [j.from, j.to, j.until]), [[own.id, old.id, 50], ['x-disk9-menu', k2.id, 60]], 'the other join is kept');
});

test('folder-joined holds while the folder is not listed again yet: the id it would take is looked up', () => {
  const w = world();
  const old = w.byPath(w.oldDir);
  const own = w.byPath(w.newDir);
  const old2 = path.join(w.base, 'work2', 'menu');
  w.catalog.memory.record(old2, { via: 'claude-code', lastSeenAt: 4 });
  w.catalog.memory.flush();
  w.catalog.load();
  const k2 = w.byPath(old2);
  // The join of an undone link to the first project, and the folder's own project not in the list for the moment
  writeRelinks(w.hub, [], [{ from: own.id, to: old.id, until: 50 }]);
  w.catalog.load();
  w.catalog.adhoc.delete([...w.catalog.adhoc.entries()].find(([, p]) => p.id === own.id)[0]);
  assert.equal(w.catalog.knownProjectFor(w.newDir), null, 'not listed');
  assert.equal(planRelink({ catalog: w.catalog, projectId: k2.id, folder: w.newDir }).problem, 'folder-joined');
});

test('a link file that is there but cannot be read is said once in the log, and nothing applies', (t) => {
  const w = world();
  const errors = [];
  t.mock.method(console, 'error', (m) => errors.push(String(m)));
  fs.writeFileSync(path.join(w.hub, 'registry', RELINKS_FILE), '{ broken');
  assert.deepEqual(readRelinks(w.hub), []);
  assert.deepEqual(readJoins(w.hub), []);
  assert.equal(errors.length, 1, 'once for the same file');
  assert.match(errors[0], /project links \(relinks\.json\) not read/);
  fs.rmSync(path.join(w.hub, 'registry', RELINKS_FILE));
  assert.deepEqual(readRelinks(w.hub), [], 'a missing file is not a problem');
  assert.equal(errors.length, 1);
});
