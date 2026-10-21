// The person's known folders are never projects (independent review of 0.20.0): Desktop, Documents, Downloads,
// Pictures, Music and Videos, under their English names and where the system really keeps them (Windows moves them
// into OneDrive, Linux names them in the person's language). server/platform.mjs knownFolders, the catalog's isBroad
// and the desktop shell's buildServerEnv.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platformOf, knownFolders, parseUserDirs, KNOWN_FOLDER_NAMES } from '../server/platform.mjs';
import { Catalog } from '../server/catalog.mjs';
import { normPath, slugify } from '../server/util.mjs';
import { buildServerEnv } from '../electron/server-process.mjs';

const WIN = platformOf('win32');
const LINUX = platformOf('linux');

test('Windows: the English names, and the folders the shell names (moved into OneDrive); never the home, a root or a relative path', () => {
  const home = 'C:\\Users\\a';
  const env = { sibersentez_known_dirs: 'C:\\Users\\a\\OneDrive\\Masaüstü;C:\\Users\\a\\OneDrive\\Belgeler;c:\\users\\a\\desktop;C:\\Users\\a;C:\\;relative\\x;' };
  assert.deepEqual(knownFolders(env, home, WIN), [
    ...KNOWN_FOLDER_NAMES.map((d) => `${home}\\${d}`),
    'C:\\Users\\a\\OneDrive\\Masaüstü',
    'C:\\Users\\a\\OneDrive\\Belgeler',
  ]);
  assert.deepEqual(knownFolders({}, '', WIN), [], 'no home, no list given: nothing');
});

test('Linux: user-dirs.dirs names them in the person\'s language; $HOME itself means not used, other entries are not known folders', () => {
  const home = '/home/a';
  const text = [
    '# This file is written by xdg-user-dirs-update',
    'XDG_DESKTOP_DIR="$HOME/Masaüstü"',
    'XDG_DOCUMENTS_DIR="$HOME/Belgeler/"',
    'XDG_DOWNLOAD_DIR="/data/indirilenler"',
    'XDG_MUSIC_DIR="$HOME"',
    'XDG_TEMPLATES_DIR="$HOME/Şablonlar"',
    'XDG_PICTURES_DIR="relative/x"',
    'garbage',
  ].join('\n');
  assert.deepEqual(parseUserDirs(text, home), ['/home/a/Masaüstü', '/home/a/Belgeler', '/data/indirilenler']);
  const read = [];
  const readFile = (file) => {
    read.push(file);
    return text;
  };
  const list = knownFolders({ XDG_CONFIG_HOME: '/cfg' }, home, LINUX, { readFile });
  assert.deepEqual(read, ['/cfg/user-dirs.dirs'], 'the file under $XDG_CONFIG_HOME');
  assert.ok(list.includes('/home/a/Masaüstü') && list.includes('/data/indirilenler') && list.includes('/home/a/Desktop'));
  knownFolders({}, home, LINUX, { readFile: (file) => (read.push(file), text) });
  assert.equal(read.at(-1), '/home/a/.config/user-dirs.dirs', 'else ~/.config');
  const missing = knownFolders({}, home, LINUX, { readFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); } });
  assert.deepEqual(missing, KNOWN_FOLDER_NAMES.map((d) => `${home}/${d}`), 'no file: the English names');
  assert.deepEqual(knownFolders({}, 'C:\\Users\\a', WIN, { readFile: () => text }).length, KNOWN_FOLDER_NAMES.length, 'Windows never reads it');
});

test('the catalog: a desktop moved into OneDrive is broad, so a session opened there makes no project; a project inside it still does', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-known-'));
  try {
    const home = path.join(root, 'home');
    const claude = path.join(home, '.claude');
    const desk = path.join(home, 'OneDrive', 'Masaüstü');
    const site = path.join(desk, 'site');
    fs.mkdirSync(site, { recursive: true });
    // One Claude Code session opened on the desktop itself, one in a folder on it
    for (const cwd of [desk, site]) {
      const file = path.join(claude, 'projects', slugify(cwd), 's.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ type: 'attachment', cwd, sessionId: 's' })}\n`);
    }
    const env = { SIBERSENTEZ_KNOWN_DIRS: desk };
    const c = new Catalog({ env, hubDir: null, claudeDir: claude, homeDir: home });
    assert.equal(c.isBroad(normPath(desk)), true);
    assert.equal(c.isBroad(normPath(site)), false);
    c.load();
    assert.deepEqual(c.allProjects().map((p) => normPath(p.path)), [normPath(site)]);
    // Without the shell's list the same desktop was a project: the case this closes
    const before = new Catalog({ env: {}, hubDir: null, claudeDir: claude, homeDir: home });
    before.load();
    assert.ok(before.allProjects().some((p) => normPath(p.path) === normPath(desk)), 'precondition: unknown, it was one');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a desktop that was a project before: one of the "Other folders" now, actions refused by name, its restore points left in the hub', async () => {
  const { resolveProject } = await import('../server/install.mjs');
  const { pointsDir } = await import('../server/restore.mjs');
  const { STRINGS } = await import('../public/js/i18n.js');
  const { isOtherFolder } = await import('../public/js/attention.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-known-'));
  try {
    const home = path.join(root, 'home');
    const hub = path.join(root, 'hub');
    const desk = path.join(home, 'OneDrive', 'Masaüstü');
    fs.mkdirSync(desk, { recursive: true });
    const env = { SIBERSENTEZ_KNOWN_DIRS: desk };
    const before = new Catalog({ env: {}, hubDir: null, claudeDir: path.join(home, '.claude'), homeDir: home });
    const was = before.adhocFor(desk);
    assert.equal(was.broad, false, 'precondition: unknown, it was a project');
    // A restore point it got then, in the hub
    const keep = path.join(pointsDir(hub, was.id), 'point-1');
    fs.mkdirSync(keep, { recursive: true });
    fs.writeFileSync(path.join(keep, 'manifest.json'), '{}');
    const c = new Catalog({ env, hubDir: null, claudeDir: path.join(home, '.claude'), homeDir: home });
    // A session there now: the same folder, as a broad one
    const now = c.adhocFor(desk);
    assert.equal(now.id, was.id, 'the same id: its hub folder is the same');
    assert.equal(now.broad, true);
    assert.equal(c.placeOf(now), 'broad');
    assert.equal(isOtherFolder({ ...now, place: c.placeOf(now) }), true, 'listed under "Other folders"');
    assert.deepEqual(resolveProject({ catalog: c, projectId: now.id, homeDir: home }), { ok: false, status: 409, error: 'broad-folder' });
    assert.ok(fs.existsSync(path.join(keep, 'manifest.json')), 'its restore point is untouched');
    // What the person reads: the group's line and the refusal name these folders and say the points stay
    for (const L of ['en', 'tr']) {
      assert.match(STRINGS[L].foldersOtherHint, /OneDrive/);
      assert.match(STRINGS[L].foldersOtherHint, L === 'en' ? /stay in the hub/ : /merkez klasörde durur/);
      assert.match(STRINGS[L]['err_broad-folder'], /OneDrive/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Independent review 2026-10-20, T03: C:\Users and C:\Users\Public were taken for projects and passed the write gate
test("a folder that holds the home folder, and Windows' shared profiles, are broad: never projects, never written", async () => {
  const { resolveProject, isBroadFolder } = await import('../server/install.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-known-'));
  try {
    const users = path.join(root, 'Users');
    const home = path.join(users, 'a');
    const pub = path.join(users, 'Public');
    const other = path.join(users, 'b', 'site');
    for (const d of [home, pub, other]) fs.mkdirSync(d, { recursive: true });
    const c = new Catalog({ env: {}, hubDir: null, claudeDir: path.join(home, '.claude'), homeDir: home });
    assert.equal(c.isBroad(normPath(users)), true, 'it holds the home folder');
    assert.equal(c.isBroad(normPath(root)), true);
    assert.equal(c.isProjectFolder(users), false);
    assert.equal(isBroadFolder(users, home), true, 'the write gate says so on its own too');
    assert.equal(c.isBroad(normPath(other)), false, "a folder inside another account's home is not broad by this rule");
    const p = c.adhocFor(users);
    assert.deepEqual(resolveProject({ catalog: c, projectId: p.id, homeDir: home }), { ok: false, status: 409, error: 'broad-folder' });
    assert.equal(c.isBroad(normPath(pub)), process.platform === 'win32', 'Public: a Windows profile every account shares');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the shell hands the server the known folders it names; a list set by the user never reaches it', () => {
  const sep = path.delimiter;
  const desk = path.resolve('/x/OneDrive/Desk');
  const docs = path.resolve('/x/Docs');
  // A folder whose name holds the path delimiter (Windows: "OneDrive - Firma; A.Ş.") is passed whole, as JSON
  const odd = path.resolve(`/x/OneDrive - Firma${sep} A.Ş./Desk`);
  const env = buildServerEnv({ PATH: 'p', sibersentez_known_dirs: path.resolve('/forged') }, { port: 1, hubPath: path.resolve('/hub'), instance: 'i', knownDirs: [desk, 'relative', odd, docs, null] });
  assert.deepEqual(JSON.parse(env.SIBERSENTEZ_KNOWN_DIRS), [desk, odd, docs]);
  // and the server reads it back whole
  const home = path.resolve('/x/home');
  const read = knownFolders(env, home);
  for (const d of [desk, odd, docs]) assert.ok(read.includes(d), d);
  assert.ok(!Object.keys(env).some((k) => k !== 'SIBERSENTEZ_KNOWN_DIRS' && k.toUpperCase() === 'SIBERSENTEZ_KNOWN_DIRS'), 'the forged one is gone');
  const none = buildServerEnv({ SIBERSENTEZ_KNOWN_DIRS: path.resolve('/forged') }, { port: 1, hubPath: null, instance: 'i' });
  assert.equal(none.SIBERSENTEZ_KNOWN_DIRS, undefined);
});
