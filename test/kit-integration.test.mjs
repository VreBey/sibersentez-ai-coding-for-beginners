// The SiberSentez kit in the app (docs/kit.md §6): where the kit folder is found (source run, installed app next to
// app.asar, SIBERSENTEZ_KIT), kit items as fit candidates (an empty folder, ideas, a project with code), one row per
// name, installing and removing a kit item straight from the kit folder (record source 'kit' with its versions), a
// newer kit copy as an update, and the app without a kit.
// Run: node --test test/kit-integration.test.mjs
// Hermetic: the repository kit is copied into a temporary folder that SIBERSENTEZ_KIT names for this process; a fake hub,
// home and projects under the system temp folder; no real process is started (spawn is injected).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-kit-int-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
// The kit of this process (install.mjs reads it through defaultKitDir, the way config.mjs names KIT_DIR): a copy, so
// a test may change it
const KIT = path.join(ROOT, 'kit');
fs.cpSync(path.join(REPO, 'kit'), KIT, { recursive: true });
process.env.SIBERSENTEZ_KIT = KIT;

const { createActions } = await import('../server/actions.mjs');
const { createHandler } = await import('../server/app.mjs');
const { initHub } = await import('../server/hub.mjs');
const { treeHash, listLibrary } = await import('../server/library.mjs');
const { readInstalls, planInstall, findSourceItem } = await import('../server/install.mjs');
const { createFit, scoreKitItem, kitContext, SCORE } = await import('../server/fit.mjs');
const { resolveKitDir, asarParent, defaultKitDir, readKit } = await import('../server/kit.mjs');
const { fitBadgeCount } = await import('../public/js/views/projects.js');
const PUBLIC_DIR = path.join(REPO, 'public');

const HOME = path.join(ROOT, 'home');
const CLAUDE = path.join(HOME, '.claude');
fs.mkdirSync(CLAUDE, { recursive: true });

const write = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const fm = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const nextAt = (dir) => write(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '15', react: '19' }, devDependencies: { typescript: '5' } }));

let worldN = 0;
// A hub, the kit (kitDir: the copy above unless given) and projects: 'fresh' (an empty folder) and 'next' (a
// Next.js app)
function world({ kitDir = KIT } = {}) {
  const base = path.join(ROOT, `w${++worldN}`);
  const hub = path.join(base, 'hub');
  initHub(hub);
  const projects = [];
  const catalog = { hubDir: hub, homeDir: HOME, claudeDir: CLAUDE, kitDir, roster: new Map(), version: 1, getProject: (id) => projects.find((p) => p.id === id) || null, allProjects: () => projects };
  const project = (id, make = null) => {
    const dir = path.join(base, 'projects', id);
    fs.mkdirSync(dir, { recursive: true });
    if (make) make(dir);
    projects.push({ id, name: id, kind: 'adhoc', path: dir, exists: true, via: ['claude-code'], packages: [] });
    return dir;
  };
  project('fresh');
  project('next', nextAt);
  return { base, hub, lib: path.join(hub, 'library'), catalog, project, dir: (id) => projects.find((p) => p.id === id).path };
}
const byName = (body, name) => body.candidates.find((c) => c.name === name);
const selected = (body) => body.candidates.filter((c) => c.selected).map((c) => c.key);

// ---------------- where the kit is ----------------

test('KIT_DIR: <app>/kit from the source folder; next to the archive in the installed app (<resources>/kit for <resources>/app.asar); SIBERSENTEZ_KIT first; a folder that is not there is no kit', () => {
  const app = path.join(ROOT, 'install', 'SiberSentez');
  const resources = path.join(app, 'resources');
  const asar = path.join(resources, 'app.asar');
  write(asar, 'archive'); // a file, as on disk
  assert.equal(asarParent(asar), resources);
  assert.equal(asarParent(path.join(asar, 'server')), resources, 'a path inside the archive');
  assert.equal(asarParent('C:\\Program Files\\SiberSentez\\resources\\app.asar\\server\\kit.mjs'), 'C:\\Program Files\\SiberSentez\\resources');
  assert.equal(asarParent(path.join(ROOT, 'src')), null);
  assert.equal(asarParent(path.join(ROOT, 'backup.asarx', 'x')), null, 'only a whole .asar segment');
  // Installed app: nothing in the archive, the kit folder beside it (build.extraResources)
  assert.equal(resolveKitDir({ env: {}, appDir: asar }), null, 'no kit shipped: no kit');
  fs.mkdirSync(path.join(resources, 'kit'));
  assert.equal(resolveKitDir({ env: {}, appDir: asar }), path.join(resources, 'kit'));
  // Source run: <app>/kit
  assert.equal(resolveKitDir({ env: {}, appDir: REPO }), path.join(REPO, 'kit'));
  // SIBERSENTEZ_KIT wins; a named folder that is missing is no kit (never a fallback), blank means unset
  assert.equal(resolveKitDir({ env: { SIBERSENTEZ_KIT: KIT }, appDir: asar }), KIT);
  assert.equal(resolveKitDir({ env: { SIBERSENTEZ_KIT: path.join(ROOT, 'missing') }, appDir: REPO }), null);
  assert.equal(resolveKitDir({ env: { SIBERSENTEZ_KIT: '  ' }, appDir: REPO }), path.join(REPO, 'kit'));
  // A file is not a kit folder
  assert.equal(resolveKitDir({ env: { SIBERSENTEZ_KIT: asar }, appDir: REPO }), null);
  // This process: the copy named by SIBERSENTEZ_KIT
  assert.equal(defaultKitDir(), KIT);
});

test('package: the kit ships beside the archive (build.extraResources kit -> kit), never inside it; the test script runs the kit tests', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  // The kit, then the licence text and the third-party notices (they go with every copy: the GPL asks for its
  // text with the program, and each component brings its own notice)
  assert.deepEqual(pkg.build.extraResources, [{ from: 'kit', to: 'kit' }, { from: 'LICENSE', to: 'LICENSE.txt' }, { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' }]);
  assert.ok(!pkg.build.files.some((f) => f.startsWith('kit')), 'not in app.asar');
  // The script runs every test file (test/*.test.mjs), the kit's among them
  assert.equal(pkg.scripts.test, 'node --test "test/*.test.mjs"');
  for (const f of ['test/kit.test.mjs', 'test/kit-integration.test.mjs']) assert.ok(fs.existsSync(path.join(REPO, f)), f);
});

// ---------------- kit items in the fit ----------------

test('empty folder, no idea: the kit offers idea-to-plan and project-setup (strong, selected, from the kit); nothing else is selected', () => {
  const w = world();
  const body = createFit({ catalog: w.catalog }).get('fresh').body;
  assert.deepEqual(body.project.tags, []);
  assert.deepEqual(selected(body), ['skill:idea-to-plan', 'skill:project-setup']);
  for (const name of ['idea-to-plan', 'project-setup']) {
    const c = byName(body, name);
    assert.equal(c.confidence, 'high', name);
    assert.deepEqual(c.sources, ['kit'], name);
    assert.deepEqual(c.alsoIn, [], name);
    assert.equal(c.stage, 'start', name);
    assert.deepEqual(c.reasons, ['empty-folder'], name);
    assert.equal(c.installable, true, name);
  }
  assert.equal(byName(body, 'task-breakdown').confidence, 'low', 'the next step, not the first one');
  assert.ok(body.candidates.filter((c) => c.score > 0).every((c) => ['idea-to-plan', 'project-setup'].includes(c.name)), 'nothing else fits an empty folder without an idea');
  assert.ok(!JSON.stringify(body).includes(KIT), 'no kit path in the reply');
  assert.ok(body.candidates.every((c) => !Object.keys(c).some((k) => k.startsWith('_'))));
});

test('empty folder + "Unity ile 2D platform oyunu": game-prototype-unity strong and selected; the web, mobile, desktop and bot starters are left out (the idea names the tool)', () => {
  const w = world();
  const body = createFit({ catalog: w.catalog }).get('fresh', { idea: 'Unity ile 2D platform oyunu' }).body;
  const game = byName(body, 'game-prototype-unity');
  assert.equal(game.confidence, 'high');
  assert.ok(game.selected);
  assert.equal(game.reasons[0], 'idea:unity');
  assert.ok(game.reasons.includes('idea-word:platform oyunu'), game.reasons.join());
  for (const name of ['web-app-starter', 'mobile-app-starter', 'desktop-app-starter', 'python-bot-starter']) {
    assert.equal(byName(body, name), undefined, name);
    assert.ok(body.excluded.sample.some((x) => x.name === name), `${name} excluded by the conflict rule`);
  }
  assert.deepEqual(selected(body), ['skill:game-prototype-unity', 'skill:idea-to-plan', 'skill:project-setup']);
  assert.equal(body.candidates[0].name, 'game-prototype-unity');
});

test('empty folder + ideas without a tool: the keywords pick the starter (Telegram botu -> python-bot-starter; a website, an online store, a phone app, a tray program, a release)', () => {
  const w = world();
  const fit = createFit({ catalog: w.catalog });
  const top = (idea) => fit.get('fresh', { idea }).body.candidates.filter((c) => !['idea-to-plan', 'project-setup'].includes(c.name))[0];
  const bot = fit.get('fresh', { idea: 'Telegram botu' }).body;
  assert.equal(byName(bot, 'python-bot-starter').confidence, 'high');
  assert.ok(byName(bot, 'python-bot-starter').selected);
  assert.deepEqual(byName(bot, 'python-bot-starter').reasons, ['idea-word:botu', 'idea-word:Telegram']);
  for (const [idea, name, confidence] of [
    ['Telegram botu', 'python-bot-starter', 'high'],
    ["Telegram'da her sabah hava durumunu gönderen bir bot yapmak istiyorum", 'python-bot-starter', 'high'],
    ['Kuaför salonum için müşterilerin randevu alabileceği bir web sitesi', 'web-app-starter', 'high'],
    ['Ürünlerimi satacağım bir online mağaza açmak istiyorum', 'web-app-starter', 'high'],
    ['Android ve iPhone için yemek tarifi uygulaması', 'mobile-app-starter', 'high'],
    ['Telefonda çalışan bir alışveriş listesi uygulaması', 'mobile-app-starter', 'medium'],
    ['Bilgisayarımda çalışan, sistem tepsisinde duran küçük bir not programı', 'desktop-app-starter', 'high'],
    ['Oyunum açılırken çöküyor, hata veriyor', 'debug-helper', 'high'],
    ['Yeni sürümü yayınlamak istiyorum', 'release-prep', 'high'],
    ['Next.js ile online mağaza', 'web-app-starter', 'high'],
  ]) {
    const c = top(idea);
    assert.equal(c?.name, name, idea);
    assert.equal(c.confidence, confidence, idea);
  }
  // A stated tool still rules: a Python bot idea keeps the web starter out
  const py = fit.get('fresh', { idea: 'Python ile Telegram botu' }).body;
  assert.equal(byName(py, 'web-app-starter'), undefined);
  assert.equal(byName(py, 'python-bot-starter').reasons[0], 'idea:python');
});

test('wave 2 starters: a Godot project and a Unity project each keep to their own engine; ideas without a tool reach the new starters and skills', () => {
  const w = world();
  w.project('godot', (d) => write(path.join(d, 'project.godot')));
  w.project('unity', (d) => write(path.join(d, 'Assets', 'a.unity')));
  const fit = createFit({ catalog: w.catalog });
  // A Godot project: the Unity starter is out, the Godot one is listed but never selected by itself
  const g = fit.get('godot').body;
  assert.equal(byName(g, 'game-prototype-unity'), undefined);
  assert.ok(g.excluded.sample.some((x) => x.name === 'game-prototype-unity'));
  assert.equal(byName(g, 'game-prototype-godot').selected, false);
  assert.deepEqual(selected(g), []);
  // A Unity project: the other way round
  const u = fit.get('unity').body;
  assert.equal(byName(u, 'game-prototype-godot'), undefined);
  assert.ok(byName(u, 'game-prototype-unity'));
  // An idea that names the engine keeps the conflict rule both ways
  const godotIdea = fit.get('fresh', { idea: 'Godot ile 2D platform oyunu' }).body;
  assert.equal(byName(godotIdea, 'game-prototype-godot').confidence, 'high');
  assert.ok(byName(godotIdea, 'game-prototype-godot').selected);
  assert.equal(byName(godotIdea, 'game-prototype-unity'), undefined);
  assert.deepEqual(selected(godotIdea), ['skill:game-prototype-godot', 'skill:idea-to-plan', 'skill:project-setup']);
  const unityIdea = fit.get('fresh', { idea: 'Unity ile 2D platform oyunu' }).body;
  assert.equal(byName(unityIdea, 'game-prototype-godot'), undefined, 'the Godot starter is out of a Unity idea');
  // Ideas without a tool name: the first item that is not the empty-folder offer
  const top = (idea) => fit.get('fresh', { idea }).body.candidates.filter((c) => !['idea-to-plan', 'project-setup'].includes(c.name))[0];
  for (const [idea, name] of [
    ['CSV dosyamdaki satış verisini analiz etmek istiyorum', 'data-analysis-starter'],
    ['Chrome için tarayıcı eklentisi geliştirmek', 'browser-extension-starter'],
    ['Betiğimi komut satırı aracına çevirmek istiyorum', 'cli-tool-starter'],
    ['Uygulamama yapay zekâ modeli bağlamak istiyorum', 'llm-app-basics'],
    ['Kullanıcılar kayıt olup giriş yapabilsin', 'auth-flow'],
    ['Uygulamamı Docker konteynerine koymak istiyorum', 'docker-basics'],
  ]) assert.equal(top(idea)?.name, name, idea);
  assert.equal(byName(fit.get('fresh', { idea: 'Chrome için tarayıcı eklentisi geliştirmek' }).body, 'browser-extension-starter').confidence, 'high');
  // The new items are real kit rows: installable, from the kit
  const db = byName(fit.get('fresh', { idea: 'Veritabanı tasarlamak, tabloları ve ilişkileri çizmek istiyorum' }).body, 'database-schema');
  assert.deepEqual(db.sources, ['kit']);
  assert.equal(db.installable, true);
  assert.equal(db.stage, 'build');
});

test('a project with code (Next.js): web-app-starter is never selected by itself (weak without an idea, at most "may help" when the idea asks for it); build and ship items still are', () => {
  const w = world();
  const fit = createFit({ catalog: w.catalog });
  const plain = fit.get('next').body;
  const web = byName(plain, 'web-app-starter');
  assert.equal(web.confidence, 'low', 'a starter is no news in a project that runs');
  assert.equal(web.selected, false);
  assert.ok(web.score >= 2 * SCORE.stack, 'it still shares the stack');
  assert.deepEqual(selected(plain), []);
  assert.equal(byName(plain, 'idea-to-plan').score, 0, 'no empty-folder offer where there are files');
  const site = fit.get('next', { idea: 'Kuaför salonum için randevu alınan bir web sitesi' }).body;
  assert.equal(byName(site, 'web-app-starter').confidence, 'medium');
  assert.equal(byName(site, 'web-app-starter').selected, false);
  const release = fit.get('next', { idea: 'Yeni sürümü yayınlamak istiyorum' }).body;
  assert.ok(byName(release, 'release-prep').selected, 'a ship item for a project with code');
  const debug = fit.get('next', { idea: 'Sayfa açılırken çöküyor, hata veriyor' }).body;
  assert.ok(byName(debug, 'debug-helper').selected);
  // The rule itself
  const kit = readKit(KIT).items.find((it) => it.name === 'project-setup');
  const prof = { tags: new Map([['nextjs', 'package.json']]), stacks: new Set(['nextjs']), primary: new Set(['nextjs']), topics: new Set() };
  assert.equal(scoreKitItem(kit, prof, kitContext(prof, 'yeni proje kurulumu', [])).confidence, 'medium');
  assert.equal(scoreKitItem(kit, prof, kitContext(prof)).confidence, 'low');
});

test('one row per name: library > kit > project copy; the others in alsoIn; the chosen place is what gets installed', () => {
  const w = world();
  // The user's own tester agent in the library, a debug-helper in another project, and the kit's copies of both
  write(path.join(w.lib, 'testing', 'agents', 'tester.md'), fm('tester', 'My own tester for Next.js apps'));
  w.project('other', (d) => {
    nextAt(d);
    write(path.join(d, '.claude', 'skills', 'debug-helper', 'SKILL.md'), fm('debug-helper', 'Project copy'));
    write(path.join(d, '.claude', 'agents', 'tester.md'), fm('tester', 'Another tester'));
  });
  const fit = createFit({ catalog: w.catalog });
  const body = fit.get('next').body;
  const tester = body.candidates.filter((c) => c.name === 'tester');
  assert.equal(tester.length, 1);
  assert.deepEqual(tester[0].sources, ['library']);
  assert.deepEqual(tester[0].alsoIn, ['kit', 'project:other']);
  assert.equal(tester[0].description, 'My own tester for Next.js apps', "the user's copy comes first");
  assert.ok(!('stage' in tester[0]), 'a library row carries no kit fields');
  const debug = body.candidates.filter((c) => c.name === 'debug-helper');
  assert.equal(debug.length, 1);
  assert.deepEqual(debug[0].sources, ['kit']);
  assert.deepEqual(debug[0].alsoIn, ['project:other']);
  assert.equal(debug[0].stage, 'build');
  // The install plan takes the chosen place: the library copy, the kit copy
  const plan = planInstall({ project: { id: 'next' }, dir: w.dir('next'), items: [{ kind: 'agent', name: 'tester' }, { kind: 'skill', name: 'debug-helper' }], targets: ['claude'], library: listLibrary(w.hub), installs: [] });
  assert.equal(plan[0]._src, path.join(w.lib, 'testing', 'agents', 'tester.md'));
  assert.equal(plan[0]._kit, null);
  assert.equal(plan[1]._src, path.join(KIT, 'quality', 'skills', 'debug-helper'));
  assert.deepEqual(plan[1]._kit, { kitVersion: '0.6.1', itemVersion: '0.1.2' });
  assert.equal(findSourceItem([], 'skill', 'no-such-item'), null);
  assert.equal(findSourceItem([], 'skill', 'debug-helper', null), null, 'no kit given: library only');
  assert.equal(findSourceItem([], 'skill', 'debug-helper').origin, 'kit', 'the kit of this process by default');
});

test('a saved idea (project.idea) counts when no ?idea is given: empty folder + "Unity ile oyun" -> the badge counts game-prototype-unity and the automatic selection takes it; an explicit empty ?idea= is the fit without an idea; the idea used is the cache key', () => {
  const w = world();
  const p = w.catalog.getProject('fresh');
  p.idea = 'Unity ile oyun';
  const fit = createFit({ catalog: w.catalog });
  const saved = fit.get('fresh').body;
  const game = byName(saved, 'game-prototype-unity');
  assert.equal(game?.confidence, 'high');
  assert.ok(game.selected);
  assert.equal(game.reasons[0], 'idea:unity');
  assert.deepEqual(selected(saved), ['skill:game-prototype-unity', 'skill:idea-to-plan', 'skill:project-setup']);
  assert.ok(saved.project.idea.tags.some((g) => g.id === 'unity'), 'the fit shows the tags of the saved idea');
  // An explicit empty idea: no idea at all (the drawer's empty box)
  const none = fit.get('fresh', { idea: '' }).body;
  assert.deepEqual(selected(none), ['skill:idea-to-plan', 'skill:project-setup']);
  assert.equal(none.project.idea, undefined);
  assert.ok(fitBadgeCount(saved) > 0);
  assert.equal(fitBadgeCount(saved), fitBadgeCount(none) + 1, 'the badge counts the Unity starter too');
  // The saved idea and the same text typed share one cache entry; a changed saved idea is a new key
  assert.equal(fit.fitOf('fresh').fit, fit.fitOf('fresh', { idea: 'Unity ile oyun' }).fit);
  p.idea = 'Telegram botu';
  assert.ok(byName(fit.get('fresh').body, 'python-bot-starter').selected, 'the new saved idea, not the cached old one');
  assert.equal(byName(fit.get('fresh').body, 'game-prototype-unity')?.selected ?? false, false);
  delete p.idea;
  assert.deepEqual(selected(fit.get('fresh').body), ['skill:idea-to-plan', 'skill:project-setup'], 'no saved idea: the plain fit');
  // Another project's saved idea changes nothing here
  const next = w.catalog.getProject('next');
  next.idea = 'Unity ile oyun';
  assert.deepEqual(selected(fit.get('fresh').body), ['skill:idea-to-plan', 'skill:project-setup']);
});

test('over HTTP: GET .../fit without ?idea (the badge) and skills-apply without keys (the automatic selection) use the saved idea; ?idea= (empty) does not', async () => {
  const w = world();
  w.catalog.getProject('fresh').idea = 'Unity ile oyun';
  const env = await startServer(w, { mode: 'dry' });
  try {
    const badge = await env.getPath('/api/projects/fresh/fit');
    assert.equal(badge.status, 200);
    assert.ok(selected(badge.json).includes('skill:game-prototype-unity'));
    const plain = await env.getPath('/api/projects/fresh/fit?idea=');
    assert.equal(plain.status, 200);
    assert.ok(!selected(plain.json).includes('skill:game-prototype-unity'));
    assert.equal(fitBadgeCount(badge.json), fitBadgeCount(plain.json) + 1);
    const r = await env.post({ action: 'skills-apply', projectId: 'fresh' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.selection, 'auto');
    assert.ok(ops(r.json.plan).includes('copy:skill:game-prototype-unity@claude:new'), ops(r.json.plan).join());
  } finally {
    await env.close();
  }
});

// ---------------- install and remove from the kit ----------------

function fakeSpawn(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => child.emit('spawn'));
    return child;
  };
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: `127.0.0.1:${port}` };
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`no answer: ${method} ${p}`)));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function startServer(w, { mode = 'live' } = {}) {
  let changes = 0;
  let clock = Date.UTC(2026, 8, 29, 10, 0, 0, 0);
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const workDir = path.join(w.base, 'app');
  fs.mkdirSync(workDir, { recursive: true });
  const fit = createFit({ catalog: w.catalog });
  const actions = createActions({ catalog: w.catalog, ingest: { sessions: new Map() }, mode, port, hubDir: w.hub, workDir, homeDir: HOME, claudeDir: CLAUDE, spawn: fakeSpawn([]), now: () => clock, log: () => {}, onChange: () => changes++, fit });
  server.on('request', createHandler({ ingest: { sessions: new Map() }, catalog: w.catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, actions, fit }));
  const headers = { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-SiberSentez-Token': actions.token || '' };
  return {
    fit,
    changes: () => changes,
    tick: (ms = 3000) => (clock += ms),
    post: (body) => request(port, { method: 'POST', path: '/api/action', body, headers }),
    getFit: (id, idea) => request(port, { path: `/api/projects/${id}/fit${idea ? `?idea=${encodeURIComponent(idea)}` : ''}`, headers: { 'Sec-Fetch-Site': 'same-origin' } }),
    getPath: (p) => request(port, { path: p, headers: { 'Sec-Fetch-Site': 'same-origin' } }),
    close: () => new Promise((r) => server.close(r)),
  };
}

const ops = (plan) => plan.map((e) => `${e.op}:${e.kind}:${e.name}${e.target ? '@' + e.target : ''}:${e.reason}`);
function snapshotTree(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(root, p)}|${e.isDirectory() ? 'd' : st.size}|${st.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

test('skills-apply preview: the kit items the empty folder offers are planned as copies from the kit (no import into the library); nothing is written', async () => {
  const w = world();
  const env = await startServer(w, { mode: 'dry' });
  const before = snapshotTree(w.base);
  const kitBefore = snapshotTree(KIT);
  try {
    const f = await env.getFit('fresh');
    assert.deepEqual(f.json.candidates.filter((c) => c.selected).map((c) => c.key), ['skill:idea-to-plan', 'skill:project-setup']);
    const r = await env.post({ action: 'skills-apply', projectId: 'fresh', keys: ['skill:idea-to-plan', 'skill:project-setup', 'agent:planner'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.applied, false);
    assert.equal(r.json.reason, 'preview-mode');
    assert.deepEqual(ops(r.json.plan), ['copy:skill:idea-to-plan@claude:new', 'copy:skill:project-setup@claude:new', 'copy:agent:planner@claude:new']);
    assert.ok(!r.json.plan.some((e) => e.op === 'import'), 'a kit item never goes through the library');
    assert.equal(env.changes(), 0);
  } finally {
    await env.close();
  }
  assert.deepEqual(snapshotTree(w.base).filter((l) => !l.startsWith('app')), before.filter((l) => !l.startsWith('app')), 'preview wrote nothing');
  assert.deepEqual(snapshotTree(KIT), kitBefore, 'the kit is only read');
});

test('skills-apply live: kit items are copied straight from the kit (with their license notice); the record says source kit, the kit and item versions and the kit path; the copy hashes like the kit folder; skills-remove takes them away', async () => {
  const w = world();
  const env = await startServer(w);
  const fresh = w.dir('fresh');
  const kitBefore = snapshotTree(KIT);
  try {
    const r = await env.post({ action: 'skills-apply', projectId: 'fresh', keys: ['skill:idea-to-plan', 'agent:planner'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.applied, true);
    assert.deepEqual(r.json.result, { executed: true, imported: 0, copied: 2, updated: 0, catalogError: false });
    const skillDir = path.join(fresh, '.claude', 'skills', 'idea-to-plan');
    const agentFile = path.join(fresh, '.claude', 'agents', 'planner.md');
    assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(skillDir, 'LICENSE.md')), 'the notice travels with the skill');
    assert.match(fs.readFileSync(agentFile, 'utf8'), /^---\n# SiberSentez Kit agent\.\n# Copyright \(c\)/, 'the agent carries its notice comment');
    assert.deepEqual(fs.readdirSync(path.join(fresh, '.claude', 'agents')), ['planner.md'], 'nothing else in the agents folder');
    assert.ok(!fs.existsSync(path.join(w.lib, 'planning')), 'nothing was put into the library');
    const rec = readInstalls(w.hub).installs;
    assert.deepEqual(
      rec.map((x) => [x.kind, x.name, x.source, x.kitVersion, x.itemVersion, x.kitPath]).sort(),
      [
        ['agent', 'planner', 'kit', '0.6.1', '0.2.3', 'planning/agents/planner.md'],
        ['skill', 'idea-to-plan', 'kit', '0.6.1', '0.2.0', 'planning/skills/idea-to-plan'],
      ],
    );
    const skillRec = rec.find((x) => x.name === 'idea-to-plan');
    assert.equal(skillRec.hash, treeHash(skillDir));
    assert.equal(skillRec.hash, treeHash(path.join(KIT, 'planning', 'skills', 'idea-to-plan')), 'an unchanged copy of the kit folder');
    assert.equal(rec.find((x) => x.name === 'planner').hash, treeHash(path.join(KIT, 'planning', 'agents', 'planner.md')));
    assert.equal(env.changes(), 1);
    // The fit follows: installed, not selected any more
    const f = await env.getFit('fresh');
    assert.equal(f.json.candidates.find((c) => c.name === 'idea-to-plan').installed, true);
    assert.deepEqual(f.json.candidates.filter((c) => c.selected).map((c) => c.key), ['skill:project-setup']);
    // Installing again: up to date
    env.tick();
    const again = await env.post({ action: 'skills-install', projectId: 'fresh', items: [{ kind: 'skill', name: 'idea-to-plan' }] });
    assert.deepEqual(ops(again.json.plan), ['skip:skill:idea-to-plan@claude:up-to-date']);
    // Remove: only what the record lists, unchanged
    env.tick();
    const rm = await env.post({ action: 'skills-remove', projectId: 'fresh', items: [{ kind: 'skill', name: 'idea-to-plan' }, { kind: 'agent', name: 'planner' }] });
    assert.equal(rm.status, 200, JSON.stringify(rm.json));
    assert.deepEqual(ops(rm.json.plan), ['remove:skill:idea-to-plan@claude:unchanged', 'remove:agent:planner@claude:unchanged']);
    assert.ok(!fs.existsSync(skillDir));
    assert.ok(!fs.existsSync(agentFile));
    assert.deepEqual(readInstalls(w.hub).installs, []);
  } finally {
    await env.close();
  }
  assert.deepEqual(snapshotTree(KIT), kitBefore, 'the kit is only read');
});

test('skills-trial ("Try"): kit items are copied from the kit into the trial folder (with their license notice); nothing is installed into the project or put into the library; an item in neither is skipped', async () => {
  const dry = await startServer(world(), { mode: 'dry' });
  try {
    const r = await dry.post({ action: 'skills-trial', projectId: 'fresh', items: [{ kind: 'skill', name: 'idea-to-plan' }, { kind: 'agent', name: 'planner' }, { kind: 'skill', name: 'no-such-item' }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(ops(r.json.plan), ['copy:skill:idea-to-plan:trial', 'copy:agent:planner:trial', 'skip:skill:no-such-item:not-in-library']);
    assert.equal(r.json.result.executed, false);
  } finally {
    await dry.close();
  }
  const w = world();
  const env = await startServer(w);
  const kitBefore = snapshotTree(KIT);
  try {
    const r = await env.post({ action: 'skills-trial', projectId: 'fresh', items: [{ kind: 'skill', name: 'idea-to-plan' }, { kind: 'agent', name: 'planner' }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.result.executed, true);
    const trial = r.json.result.trialDir;
    assert.ok(trial.startsWith(path.join(w.hub, 'trials') + path.sep), 'under the hub');
    assert.ok(fs.existsSync(path.join(trial, 'skills', 'idea-to-plan', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(trial, 'skills', 'idea-to-plan', 'LICENSE.md')), 'the notice travels with the skill');
    assert.equal(treeHash(path.join(trial, 'skills', 'idea-to-plan')), treeHash(path.join(KIT, 'planning', 'skills', 'idea-to-plan')));
    assert.match(fs.readFileSync(path.join(trial, 'agents', 'planner.md'), 'utf8'), /^---\n# SiberSentez Kit agent\.\n# Copyright \(c\)/);
    assert.deepEqual(fs.readdirSync(w.dir('fresh')), [], 'nothing installed into the project');
    assert.ok(!fs.existsSync(path.join(w.lib, 'planning')), 'nothing put into the library');
    assert.deepEqual(readInstalls(w.hub).installs, []);
  } finally {
    await env.close();
  }
  assert.deepEqual(snapshotTree(KIT), kitBefore, 'the kit is only read');
});

test('a newer kit copy: an installed, unchanged kit item is updated (kit-changed) and the record keeps the new versions; a copy the user changed is never overwritten', async () => {
  const kit2 = path.join(ROOT, 'kit-v2');
  fs.cpSync(KIT, kit2, { recursive: true });
  const w = world({ kitDir: kit2 });
  const env = await startServer(w);
  const fresh = w.dir('fresh');
  try {
    // Installed from the kit of this process (install.mjs), then that kit changes (a new app version)
    let r = await env.post({ action: 'skills-install', projectId: 'fresh', items: [{ kind: 'skill', name: 'task-breakdown' }, { kind: 'skill', name: 'test-first' }] });
    assert.deepEqual(ops(r.json.plan), ['copy:skill:task-breakdown@claude:new', 'copy:skill:test-first@claude:new']);
    const md = path.join(KIT, 'planning', 'skills', 'task-breakdown', 'SKILL.md');
    const md2 = path.join(KIT, 'quality', 'skills', 'test-first', 'SKILL.md');
    const old = fs.readFileSync(md, 'utf8');
    const old2 = fs.readFileSync(md2, 'utf8');
    try {
      // Whatever version the skill has now (it moves with the kit)
      fs.writeFileSync(md, old.replace(/version: "[0-9.]+"/, 'version: "0.2.0"') + '\nOne more line.\n');
      fs.writeFileSync(md2, old2 + '\nNewer.\n');
      // The user changed their test-first copy
      fs.appendFileSync(path.join(fresh, '.claude', 'skills', 'test-first', 'SKILL.md'), '\nmine\n');
      env.tick();
      r = await env.post({ action: 'skills-install', projectId: 'fresh', items: [{ kind: 'skill', name: 'task-breakdown' }, { kind: 'skill', name: 'test-first' }] });
      assert.deepEqual(ops(r.json.plan), ['update:skill:task-breakdown@claude:kit-changed', 'skip:skill:test-first@claude:modified']);
      const rec = readInstalls(w.hub).installs.find((x) => x.name === 'task-breakdown');
      assert.equal(rec.itemVersion, '0.2.0');
      assert.equal(rec.source, 'kit');
      assert.match(fs.readFileSync(path.join(fresh, '.claude', 'skills', 'task-breakdown', 'SKILL.md'), 'utf8'), /One more line/);
      assert.match(fs.readFileSync(path.join(fresh, '.claude', 'skills', 'test-first', 'SKILL.md'), 'utf8'), /mine/, 'the user change stays');
    } finally {
      fs.writeFileSync(md, old);
      fs.writeFileSync(md2, old2);
    }
  } finally {
    await env.close();
  }
});

test('a library item with the name of a kit item is installed from the library (the user comes first); the record names the library copy', async () => {
  const w = world();
  write(path.join(w.lib, 'planning', 'skills', 'idea-to-plan', 'SKILL.md'), fm('idea-to-plan', 'My own planning interview'));
  const env = await startServer(w);
  try {
    const f = await env.getFit('fresh');
    const c = f.json.candidates.find((x) => x.name === 'idea-to-plan');
    assert.deepEqual(c.sources, ['library']);
    assert.deepEqual(c.alsoIn, ['kit']);
    const r = await env.post({ action: 'skills-apply', projectId: 'fresh', keys: ['skill:idea-to-plan'] });
    assert.deepEqual(ops(r.json.plan), ['copy:skill:idea-to-plan@claude:new']);
    const rec = readInstalls(w.hub).installs[0];
    assert.equal(rec.source, 'library/planning/skills/idea-to-plan');
    assert.ok(!('kitVersion' in rec));
    assert.equal(fs.readFileSync(path.join(w.dir('fresh'), '.claude', 'skills', 'idea-to-plan', 'SKILL.md'), 'utf8'), fm('idea-to-plan', 'My own planning interview'));
  } finally {
    await env.close();
  }
});

// ---------------- without a kit ----------------

test('no kit: the fit is what it was before (an empty folder proposes nothing; no kit source anywhere); a kit folder that disappears is read as empty', () => {
  const w = world({ kitDir: null });
  write(path.join(w.lib, 'docs', 'skills', 'writing', 'SKILL.md'), fm('writing', 'Technical writing'));
  const fit = createFit({ catalog: w.catalog });
  const plain = fit.get('fresh').body;
  assert.deepEqual(selected(plain), []);
  assert.deepEqual(plain.candidates.map((c) => c.key), ['skill:writing']);
  assert.ok(plain.candidates.every((c) => !c.sources.includes('kit') && !c.alsoIn.includes('kit') && !('stage' in c)));
  const idea = fit.get('fresh', { idea: 'Unity ile 2D platform oyunu' }).body;
  assert.deepEqual(selected(idea), []);
  // A catalog without kitDir (older callers) has no kit either
  const { kitDir, ...noKit } = w.catalog;
  assert.equal(kitDir, null);
  assert.deepEqual(createFit({ catalog: noKit }).get('fresh').body.candidates.map((c) => c.key), ['skill:writing']);
  // A kit folder removed while the app runs: the next fit has no kit items
  const gone = path.join(ROOT, 'kit-gone');
  fs.cpSync(KIT, gone, { recursive: true });
  const w2 = world({ kitDir: gone });
  const fit2 = createFit({ catalog: w2.catalog });
  assert.ok(fit2.get('fresh').body.candidates.some((c) => c.sources.includes('kit')));
  fs.rmSync(gone, { recursive: true, force: true });
  assert.ok(!fit2.get('fresh').body.candidates.some((c) => c.sources.includes('kit')), 'the kit signature changed: computed again, without the kit');
});

test('empty folder + a language with no framework ("Python ile API"): the starter built on a framework of that language is not left out', () => {
  const w = world();
  const fit = createFit({ catalog: w.catalog });
  for (const idea of ['Python ile bir REST API yapmak istiyorum', 'Python ile API']) {
    const body = fit.get('fresh', { idea }).body;
    const api = byName(body, 'api-service-starter');
    assert.ok(api && api.selected, idea);
    assert.equal(body.candidates[0].name, 'api-service-starter', idea);
  }
  // One starter selected: the API one; the bot starter stays in the list, not selected
  const both = fit.get('fresh', { idea: 'Python ile API' }).body;
  assert.equal(byName(both, 'python-bot-starter')?.selected, false);
  // A framework named keeps the conflict rule: FastAPI is not a bot
  assert.equal(byName(fit.get('fresh', { idea: 'FastAPI ile API' }).body, 'python-bot-starter'), undefined);
});
