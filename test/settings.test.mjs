// Settings resolution and hub layout tests (contract §2, §3, §6A, §9). Run: node --test test/settings.test.mjs
// Every test builds its own folders under the system temp folder; the real home folder and hub are never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveConfig, DEFAULT_PORT, DEFAULT_DAYS } from '../server/config.mjs';
import { initHub, HUB_SKELETON, registryFile, libraryFile, normalizeRegistry, normalizeLibrary, readRegistry, readLibrary } from '../server/hub.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-config-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
// A fresh, empty world: an app folder (where sibersentez.json lives) and a home folder
function world() {
  const base = path.join(ROOT, `d${++n}`);
  const appDir = path.join(base, 'app');
  const homeDir = path.join(base, 'home');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const logs = [];
  const mk = (...parts) => {
    const d = path.join(base, ...parts);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const writeConfig = (v) => fs.writeFileSync(path.join(appDir, 'sibersentez.json'), typeof v === 'string' ? v : JSON.stringify(v));
  const resolve = (env = {}) => resolveConfig({ env, appDir, homeDir, log: (l) => logs.push(l) });
  return { base, appDir, homeDir, logs, mk, writeConfig, resolve };
}
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// ---------------- defaults ----------------
test('defaults: port 4545, 14 days, actions off; without ~/SiberSentez the hub is null and nothing is logged', () => {
  const w = world();
  const c = w.resolve();
  assert.equal(c.port, 4545);
  assert.equal(DEFAULT_PORT, 4545);
  assert.equal(c.days, 14);
  assert.equal(DEFAULT_DAYS, 14);
  assert.equal(c.actions, 'off');
  assert.equal(c.hub, null);
  assert.equal(c.hubSource, null);
  assert.equal(c.claudeDir, path.join(w.homeDir, '.claude'));
  assert.deepEqual(w.logs, [], 'no sibersentez.json and no default hub: silent');
  assert.equal(fs.existsSync(path.join(w.homeDir, 'SiberSentez')), false, 'resolving settings never creates the hub');
});

test('default hub: %USERPROFILE%\\SiberSentez is used only if it exists', () => {
  const w = world();
  const hub = w.mk('home', 'SiberSentez');
  const c = w.resolve();
  assert.equal(c.hub, hub);
  assert.equal(c.hubSource, 'default');
  // A file with that name is not a folder
  const w2 = world();
  fs.writeFileSync(path.join(w2.homeDir, 'SiberSentez'), 'file');
  assert.equal(w2.resolve().hub, null);
});

test('no "hub = parent of the app folder" assumption', () => {
  const w = world();
  // Even a legacy-looking hub next to the app folder is ignored
  w.mk('registry');
  w.mk('library');
  w.mk('kutuphane');
  assert.equal(w.resolve().hub, null);
});

// ---------------- precedence ----------------
test('precedence: environment > sibersentez.json > default (port, days, hub, actions)', () => {
  const w = world();
  const hubFile = w.mk('file-hub');
  const hubEnv = w.mk('env-hub');
  w.mk('home', 'SiberSentez');
  w.writeConfig({ port: 5001, days: 7, hub: hubFile, actions: 'dry' });

  const fromFile = w.resolve();
  assert.equal(fromFile.port, 5001);
  assert.equal(fromFile.days, 7);
  assert.equal(fromFile.hub, hubFile);
  assert.equal(fromFile.hubSource, 'file');
  assert.equal(fromFile.actions, 'dry');

  const fromEnv = w.resolve({ SIBERSENTEZ_PORT: '6002', SIBERSENTEZ_DAYS: '3', SIBERSENTEZ_HUB: hubEnv, SIBERSENTEZ_ACTIONS: '1' });
  assert.equal(fromEnv.port, 6002);
  assert.equal(fromEnv.days, 3);
  assert.equal(fromEnv.hub, hubEnv);
  assert.equal(fromEnv.hubSource, 'env');
  assert.equal(fromEnv.actions, 'live');

  // An environment "off" beats the file's "dry"
  assert.equal(w.resolve({ SIBERSENTEZ_ACTIONS: '0' }).actions, 'off');
  // A blank environment value counts as not set: the file applies
  const blank = w.resolve({ SIBERSENTEZ_PORT: '', SIBERSENTEZ_HUB: '  ', SIBERSENTEZ_ACTIONS: '' });
  assert.equal(blank.port, 5001);
  assert.equal(blank.hub, hubFile);
  assert.equal(blank.actions, 'dry');
  // Keys missing from the file: defaults
  w.writeConfig({});
  const def = w.resolve();
  assert.equal(def.port, 4545);
  assert.equal(def.days, 14);
  assert.equal(def.hub, path.join(w.homeDir, 'SiberSentez'));
  assert.equal(def.actions, 'off');
});

test('sibersentez.json: a relative hub path resolves against the app folder; actions only off|dry|live', () => {
  const w = world();
  const hub = w.mk('app', 'data', 'hub');
  w.writeConfig({ hub: 'data\\hub', actions: 'live' });
  const c = w.resolve();
  assert.equal(c.hub, hub);
  assert.equal(c.actions, 'live');
  for (const bad of ['yes', 'true', '1', 'LIVE ', true, 1]) {
    w.writeConfig({ actions: bad });
    const v = w.resolve().actions;
    assert.equal(v, typeof bad === 'string' && bad.trim().toLowerCase() === 'live' ? 'live' : 'off', JSON.stringify(bad));
  }
});

test('invalid values fall through to the next source and log one line each', () => {
  const w = world();
  w.writeConfig({ port: 70000, days: -2 });
  const c = w.resolve({ SIBERSENTEZ_PORT: 'abc', SIBERSENTEZ_DAYS: '0' });
  assert.equal(c.port, 4545);
  assert.equal(c.days, 14);
  assert.equal(w.logs.length, 4);
  // true or [] must not become port 1 or 5 days through Number()
  w.writeConfig({ port: true, days: [5] });
  assert.equal(w.resolve().port, 4545);
  assert.equal(w.resolve().days, 14);
});

// ---------------- missing hub ----------------
test('an explicit hub that does not exist yields null: no fallback to the default, one log line without the path', () => {
  const w = world();
  w.mk('home', 'SiberSentez'); // the default exists, but the environment asks for another folder
  const missing = path.join(w.base, 'missing-hub');
  const c = w.resolve({ SIBERSENTEZ_HUB: missing });
  assert.equal(c.hub, null);
  assert.equal(c.hubSource, null);
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /SIBERSENTEZ_HUB/);
  assert.ok(!w.logs[0].includes(w.base), 'no path in the log line');
  // Same for a path from the file
  const w2 = world();
  w2.writeConfig({ hub: path.join(w2.base, 'nope') });
  assert.equal(w2.resolve().hub, null);
  assert.equal(w2.logs.length, 1);
  assert.equal(fs.existsSync(path.join(w2.base, 'nope')), false, 'resolving settings never creates the hub');
});

// ---------------- broken sibersentez.json ----------------
test('broken sibersentez.json: defaults without crashing, exactly one log line; a valid file with a BOM is read', () => {
  for (const raw of ['{broken', '[1, 2]', 'null', '"text"', '']) {
    const w = world();
    w.writeConfig(raw);
    let c;
    assert.doesNotThrow(() => (c = w.resolve()), raw);
    assert.equal(c.port, 4545, raw);
    assert.equal(c.days, 14, raw);
    assert.equal(c.hub, null, raw);
    assert.equal(c.actions, 'off', raw);
    assert.equal(w.logs.length, 1, `one line: ${JSON.stringify(raw)}`);
    assert.match(w.logs[0], /sibersentez\.json/);
  }
  // An unreadable sibersentez.json (a folder)
  const d = world();
  fs.mkdirSync(path.join(d.appDir, 'sibersentez.json'));
  assert.equal(d.resolve().port, 4545);
  assert.equal(d.logs.length, 1);
  // The environment still applies
  const e = world();
  e.writeConfig('{broken');
  assert.equal(e.resolve({ SIBERSENTEZ_PORT: '4999' }).port, 4999);
  // UTF-8 BOM
  const b = world();
  b.writeConfig(String.fromCharCode(0xfeff) + '{"port": 4600}');
  assert.equal(b.resolve().port, 4600);
  assert.deepEqual(b.logs, []);
});

// ---------------- module-level wiring ----------------
test('config.mjs exports are resolved from the environment (separate process; HUB_DIR is null without a hub)', () => {
  const w = world();
  const hub = w.mk('hub');
  const script = "import('./server/config.mjs').then((c) => process.stdout.write(JSON.stringify({ port: c.PORT, days: c.WINDOW_DAYS, hub: c.HUB_DIR, actions: c.ACTIONS, instance: c.INSTANCE })))";
  const run = (env) => JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: REPO, env: { ...process.env, SIBERSENTEZ_ACTIONS: '', SIBERSENTEZ_INSTANCE: '', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.deepEqual(run({ SIBERSENTEZ_PORT: '4999', SIBERSENTEZ_DAYS: '5', SIBERSENTEZ_HUB: hub, SIBERSENTEZ_ACTIONS: 'dry', SIBERSENTEZ_INSTANCE: 'tag-1' }), { port: 4999, days: 5, hub, actions: 'dry', instance: 'tag-1' });
  assert.equal(run({ SIBERSENTEZ_HUB: path.join(w.base, 'nope') }).hub, null);
});

test('the server never creates the hub by itself: index.mjs, config.mjs and catalog.mjs do not use initHub', () => {
  for (const f of ['server/index.mjs', 'server/config.mjs', 'server/catalog.mjs']) {
    // Comments may mention it; code must not import or call it
    const code = fs
      .readFileSync(path.join(REPO, f), 'utf8')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    assert.ok(!/\binitHub\b/.test(code), f);
  }
});

// ---------------- initHub ----------------
test('initHub: builds the English skeleton of contract §9 in an empty folder and returns what it created', () => {
  const w = world();
  const hub = path.join(w.base, 'new', 'SiberSentez'); // parent folders do not exist either
  const created = initHub(hub);
  assert.deepEqual(created, ['settings.json', 'registry/projects.json', 'library/catalog.json', 'library/README.md']);
  assert.deepEqual(Object.keys(HUB_SKELETON), created);
  const read = (rel) => fs.readFileSync(path.join(hub, ...rel.split('/')), 'utf8');
  assert.deepEqual(JSON.parse(read('settings.json')), { version: 1, language: 'auto' });
  assert.deepEqual(JSON.parse(read('registry/projects.json')), { projects: [] });
  assert.deepEqual(JSON.parse(read('library/catalog.json')), { updated: null, count: 0, items: [] });
  const readme = read('library/README.md');
  assert.match(readme, /library/i);
  assert.ok(readme.length < 1500, 'short explanation');
  for (const rel of created) assert.notEqual(read(rel).charCodeAt(0), 0xfeff, `${rel} is UTF-8 without BOM`);
  // The created hub works with settings resolution and the readers right away
  assert.equal(w.resolve({ SIBERSENTEZ_HUB: hub }).hub, hub);
  assert.equal(registryFile(hub), path.join(hub, 'registry', 'projects.json'));
  assert.equal(libraryFile(hub), path.join(hub, 'library', 'catalog.json'));
  assert.deepEqual(readRegistry(hub), { format: 'english', projects: [] });
  assert.deepEqual(readLibrary(hub), { format: 'english', items: [] });
});

test('initHub: a second call never overwrites a file; it only creates what is missing', () => {
  const w = world();
  const hub = path.join(w.base, 'SiberSentez');
  initHub(hub);
  const reg = path.join(hub, 'registry', 'projects.json');
  const mine = '{"projects": [{"id": "mine", "name": "My project"}]}';
  fs.writeFileSync(reg, mine);
  const readme = path.join(hub, 'library', 'README.md');
  fs.writeFileSync(readme, 'my own note');
  fs.rmSync(path.join(hub, 'settings.json'));
  const second = initHub(hub);
  assert.deepEqual(second, ['settings.json'], 'only the deleted file is created again');
  assert.equal(fs.readFileSync(reg, 'utf8'), mine, 'an edited registry is kept');
  assert.equal(fs.readFileSync(readme, 'utf8'), 'my own note');
  assert.deepEqual(initHub(hub), [], 'third call: nothing to create');
  // A legacy hub keeps its data untouched and gets no English registry next to it
  const old = path.join(w.base, 'legacy');
  write(path.join(old, 'registry', 'projeler.json'), '{"projeler": [{"id": "e"}]}');
  initHub(old);
  assert.equal(fs.readFileSync(path.join(old, 'registry', 'projeler.json'), 'utf8'), '{"projeler": [{"id": "e"}]}');
  assert.equal(fs.existsSync(path.join(old, 'registry', 'projects.json')), false);
});

test('initHub: throws a clear error with a code when a folder cannot be created; an empty path is rejected', () => {
  const w = world();
  const file = path.join(w.base, 'file');
  fs.writeFileSync(file, 'x');
  const code = (fn) => {
    try {
      fn();
    } catch (e) {
      assert.match(e.message, /hub/);
      return e.code;
    }
    return 'no error';
  };
  assert.equal(code(() => initHub(file)), 'HUB_MKDIR_FAILED');
  assert.equal(code(() => initHub(path.join(file, 'sub'))), 'HUB_MKDIR_FAILED');
  // A file sits where a skeleton subfolder should be
  const hub = w.mk('half');
  fs.writeFileSync(path.join(hub, 'registry'), 'not a folder');
  assert.equal(code(() => initHub(hub)), 'HUB_MKDIR_FAILED');
  assert.equal(code(() => initHub('')), 'HUB_PATH_MISSING');
  assert.equal(code(() => initHub(undefined)), 'HUB_PATH_MISSING');
});

// ---------------- reading: English first, legacy adapter ----------------
test('registry path: registry/projects.json, else legacy registry/projeler.json; null without a hub', () => {
  const w = world();
  const hub = w.mk('hub');
  const en = path.join(hub, 'registry', 'projects.json');
  const legacy = path.join(hub, 'registry', 'projeler.json');
  assert.equal(registryFile(hub), en, 'neither exists: the English path');
  write(legacy, '{"projeler": []}');
  assert.equal(registryFile(hub), legacy, 'only the legacy file: legacy');
  write(en, '{"projects": []}');
  assert.equal(registryFile(hub), en, 'both: English first');
  assert.equal(registryFile(null), null);
});

test('library path: library/catalog.json, else legacy kutuphane/katalog.json; null without a hub', () => {
  const w = world();
  const hub = w.mk('hub');
  const en = path.join(hub, 'library', 'catalog.json');
  const legacy = path.join(hub, 'kutuphane', 'katalog.json');
  assert.equal(libraryFile(hub), en);
  write(legacy, '{"ogeler": []}');
  assert.equal(libraryFile(hub), legacy);
  write(en, '{"items": []}');
  assert.equal(libraryFile(hub), en);
  assert.equal(libraryFile(null), null);
});

test('registry adapter: English keys and legacy keys map to the same project shape', () => {
  const P = 'C:\\work\\alpha';
  const en = normalizeRegistry({ projects: [{ id: 'alpha', name: 'Alpha', path: P, description: 'd', packages: ['web'], status: 'active', phase: 'p1', stack: ['Node'], rules: ['r'] }] });
  const legacy = normalizeRegistry({ projeler: [{ id: 'alpha', ad: 'Alpha', yol: `${P} (note)`, aciklama: 'd', paketler: ['web'], durum: 'active', faz: 'p1', stack: ['Node'], dogrulanma_kurallari: ['r'] }] });
  assert.equal(en.format, 'english');
  assert.equal(legacy.format, 'legacy');
  const shape = (p) => ({ id: p.id, name: p.name, path: p.path, description: p.description, packages: p.packages, status: p.status, phase: p.phase, stack: p.stack, rules: p.rules });
  assert.deepEqual(shape(en.projects[0]), shape(legacy.projects[0]));
  assert.deepEqual(shape(en.projects[0]), { id: 'alpha', name: 'Alpha', path: P, description: 'd', packages: ['web'], status: 'active', phase: 'p1', stack: ['Node'], rules: ['r'] });
  // Legacy extras: old path and memory folder names keep matching Claude Code project folders
  const x = normalizeRegistry({ projeler: [{ id: 'b', yol: 'C:\\b', yol_eski: 'C:\\old\\b', build_yolu: 'D:\\build\\b', hafiza_proje: 'C--b' }] }).projects[0];
  assert.deepEqual(x.extraPaths, ['C:\\old\\b']);
  assert.equal(x.build, 'D:\\build\\b');
  assert.deepEqual(x.memorySlugs, ['c--b']);
  assert.equal(x.name, 'b', 'name falls back to the id');
  // Broken rows and files
  const broken = normalizeRegistry({ projects: [null, 'x', { name: 'no id' }, { id: 'ok' }, { id: 'ok' }] });
  assert.deepEqual(broken.projects.map((p) => p.id), ['ok'], 'rows without an id and duplicates are skipped');
  for (const raw of [null, undefined, [], 'text', { projects: 'no' }]) assert.deepEqual(normalizeRegistry(raw).projects, [], JSON.stringify(raw));
});

test('library adapter: English keys and legacy keys map to the same item shape; unknown kinds are skipped', () => {
  const en = normalizeLibrary({ updated: null, count: 2, items: [{ name: 'ui-kit', kind: 'skill', category: 'web', description: 'UI', source: 'github' }, { name: 'designer', kind: 'agent', category: 'design', description: 'D' }] });
  const legacy = normalizeLibrary({ ogeler: [{ ad: 'ui-kit', tur: 'skill', kategori: 'web', aciklama: 'UI' }, { ad: 'designer', tur: 'agent', kategori: 'design', aciklama: 'D' }] });
  assert.equal(en.format, 'english');
  assert.equal(legacy.format, 'legacy');
  assert.deepEqual(en.items, legacy.items);
  assert.deepEqual(en.items[0], { name: 'ui-kit', kind: 'skill', category: 'web', description: 'UI' });
  const mixed = normalizeLibrary({ items: [{ name: 'p', kind: 'plugin' }, { kind: 'skill' }, null, { name: 's', kind: 'skill' }] });
  assert.deepEqual(mixed.items.map((i) => i.name), ['s']);
  for (const raw of [null, {}, { items: 'no' }, '{broken']) assert.deepEqual(normalizeLibrary(raw).items, [], JSON.stringify(raw));
});

test('readers pick English files over legacy files in the same hub, and read a legacy-only hub', () => {
  const w = world();
  const hub = w.mk('hub');
  write(path.join(hub, 'registry', 'projeler.json'), JSON.stringify({ projeler: [{ id: 'old', ad: 'Old', yol: 'C:\\old' }] }));
  write(path.join(hub, 'kutuphane', 'katalog.json'), JSON.stringify({ ogeler: [{ ad: 'old-skill', tur: 'skill', kategori: 'x' }] }));
  assert.deepEqual(readRegistry(hub).projects.map((p) => p.id), ['old']);
  assert.deepEqual(readLibrary(hub).items.map((i) => i.name), ['old-skill']);
  write(path.join(hub, 'registry', 'projects.json'), JSON.stringify({ projects: [{ id: 'new', name: 'New', path: 'C:\\new' }] }));
  write(path.join(hub, 'library', 'catalog.json'), JSON.stringify({ items: [{ name: 'new-skill', kind: 'skill', category: 'y' }] }));
  assert.deepEqual(readRegistry(hub).projects.map((p) => p.id), ['new']);
  assert.deepEqual(readLibrary(hub).items.map((i) => i.name), ['new-skill']);
  // An unusable English file (broken) does not hide legacy data
  write(path.join(hub, 'library', 'catalog.json'), '{broken');
  assert.deepEqual(readLibrary(hub).items.map((i) => i.name), ['old-skill']);
  // Without legacy data a broken file reads as empty, no crash
  const lone = w.mk('lone-hub');
  write(path.join(lone, 'library', 'catalog.json'), '{broken');
  assert.deepEqual(readLibrary(lone), { format: 'empty', items: [] });
  assert.deepEqual(readRegistry(null), { format: 'empty', projects: [] });
});

test('initHub on a legacy hub creates no English twins; the readers still return the legacy data', () => {
  const w = world();
  const old = w.mk('legacy');
  const reg = JSON.stringify({ projeler: [{ id: 'kept', ad: 'Kept', yol: 'C:\\kept' }] });
  const lib = JSON.stringify({ ogeler: [{ ad: 'kept-skill', tur: 'skill', kategori: 'web' }] });
  write(path.join(old, 'registry', 'projeler.json'), reg);
  write(path.join(old, 'kutuphane', 'katalog.json'), lib);
  const created = initHub(old);
  assert.deepEqual(created, ['settings.json'], 'only the file without a legacy counterpart');
  assert.equal(fs.existsSync(path.join(old, 'registry', 'projects.json')), false);
  assert.equal(fs.existsSync(path.join(old, 'library')), false, 'no library folder next to kutuphane');
  assert.deepEqual(readRegistry(old).projects.map((p) => p.id), ['kept']);
  assert.deepEqual(readLibrary(old).items.map((i) => i.name), ['kept-skill']);
  assert.equal(fs.readFileSync(path.join(old, 'registry', 'projeler.json'), 'utf8'), reg);
  assert.equal(fs.readFileSync(path.join(old, 'kutuphane', 'katalog.json'), 'utf8'), lib);
  // Only one of the two legacy files: only its twin is skipped
  const half = w.mk('half-legacy');
  write(path.join(half, 'registry', 'projeler.json'), reg);
  assert.deepEqual(initHub(half), ['settings.json', 'library/catalog.json', 'library/README.md']);
});

test('readers: an empty English skeleton (written earlier next to a legacy hub) never hides legacy data', () => {
  const w = world();
  const hub = w.mk('hub');
  write(path.join(hub, 'registry', 'projeler.json'), JSON.stringify({ projeler: [{ id: 'old', ad: 'Old', yol: 'C:\\old' }] }));
  write(path.join(hub, 'kutuphane', 'katalog.json'), JSON.stringify({ ogeler: [{ ad: 'old-skill', tur: 'skill', kategori: 'x' }] }));
  write(path.join(hub, 'registry', 'projects.json'), JSON.stringify({ projects: [] }));
  write(path.join(hub, 'library', 'catalog.json'), JSON.stringify({ updated: null, count: 0, items: [] }));
  assert.equal(registryFile(hub), path.join(hub, 'registry', 'projeler.json'));
  assert.equal(libraryFile(hub), path.join(hub, 'kutuphane', 'katalog.json'));
  assert.deepEqual(readRegistry(hub).projects.map((p) => p.id), ['old']);
  assert.deepEqual(readLibrary(hub).items.map((i) => i.name), ['old-skill']);
  // As soon as the English files hold rows they win
  write(path.join(hub, 'registry', 'projects.json'), JSON.stringify({ projects: [{ id: 'new', name: 'New', path: 'C:\\new' }] }));
  write(path.join(hub, 'library', 'catalog.json'), JSON.stringify({ items: [{ name: 'new-skill', kind: 'skill', category: 'y' }] }));
  assert.deepEqual(readRegistry(hub).projects.map((p) => p.id), ['new']);
  assert.deepEqual(readLibrary(hub).items.map((i) => i.name), ['new-skill']);
  // Both empty: the English file is used
  const both = w.mk('both-empty');
  write(path.join(both, 'registry', 'projects.json'), JSON.stringify({ projects: [] }));
  write(path.join(both, 'registry', 'projeler.json'), JSON.stringify({ projeler: [] }));
  assert.equal(registryFile(both), path.join(both, 'registry', 'projects.json'));
});

// ---------------- instance tag ----------------
test('SIBERSENTEZ_INSTANCE: a header-safe value is kept, anything else is ignored with one log line; environment only', () => {
  const w = world();
  assert.equal(w.resolve().instance, null);
  assert.equal(w.resolve({ SIBERSENTEZ_INSTANCE: ' 4f2a9c-run_1.x ' }).instance, '4f2a9c-run_1.x');
  assert.deepEqual(w.logs, []);
  for (const bad of ['a b', 'x\r\nSet-Cookie: y', 'ç', 'a'.repeat(129)]) {
    const w2 = world();
    assert.equal(w2.resolve({ SIBERSENTEZ_INSTANCE: bad }).instance, null, JSON.stringify(bad));
    assert.equal(w2.logs.length, 1);
    assert.match(w2.logs[0], /SIBERSENTEZ_INSTANCE/);
  }
  const w3 = world();
  w3.writeConfig({ instance: 'from-file' });
  assert.equal(w3.resolve().instance, null, 'sibersentez.json cannot set it');
});
