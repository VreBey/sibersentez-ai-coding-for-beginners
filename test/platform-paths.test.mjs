// Plan G1: folder rules per platform (server/platform.mjs): normalizing, the root, the system's own folders, where
// desktop programs keep their settings, and the alternate-data-stream rule that is Windows' only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { platformOf, normalizeDir, isFsRoot, isSystemFolder, configRoot } from '../server/platform.mjs';
import { hasStreamColon, isDriveRoot } from '../server/library.mjs';

const WIN = platformOf('win32');
const LINUX = platformOf('linux');
const MAC = platformOf('darwin');

test('a folder normalized without its trailing separator; the root keeps its own', () => {
  assert.equal(normalizeDir('C:\\a\\b\\', WIN), 'C:\\a\\b');
  assert.equal(normalizeDir('C:\\', WIN), 'C:\\');
  assert.equal(normalizeDir('/home/a/./b//', LINUX), '/home/a/b');
  assert.equal(normalizeDir('/', LINUX), '/');
});

test('the root of a file system', () => {
  assert.deepEqual(['C:', 'C:\\', 'c:/', 'C:\\x'].map((p) => isFsRoot(p, WIN)), [true, true, true, false]);
  assert.deepEqual(['/', '//', '/home', 'C:\\'].map((p) => isFsRoot(p, LINUX)), [true, true, false, false]);
  assert.equal(isDriveRoot('/', LINUX), true);
  assert.equal(isDriveRoot('C:\\', WIN), true);
});

test('the system\'s own folders are never projects; a server\'s or a person\'s folders can be', () => {
  for (const n of ['/', '/usr', '/home', '/tmp', '/usr/bin', '/etc/nginx', '/lib/x86_64-linux-gnu', '/system']) assert.equal(isSystemFolder(n, LINUX), true, n);
  for (const n of ['/srv/site', '/opt/app', '/var/www', '/home/a/project', '/tmp/x', '/usr/local/src/x']) assert.equal(isSystemFolder(n, LINUX), false, n);
  assert.equal(isSystemFolder('c:/windows/system32', WIN), true);
  assert.equal(isSystemFolder('/usr', WIN), false, 'Windows as before');
});

test('where desktop programs keep their settings', () => {
  assert.equal(configRoot({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a', WIN), 'C:\\Users\\a\\AppData\\Roaming');
  assert.equal(configRoot({}, 'C:\\Users\\a', WIN), 'C:\\Users\\a\\AppData\\Roaming');
  assert.equal(configRoot({}, '/home/a', LINUX), '/home/a/.config');
  assert.equal(configRoot({ XDG_CONFIG_HOME: '/cfg' }, '/home/a', LINUX), '/cfg');
  assert.equal(configRoot({}, '/Users/a', MAC), '/Users/a/Library/Application Support');
});

test('a colon is a stream on Windows only', () => {
  assert.equal(hasStreamColon('C:\\a\\b:stream', WIN), true);
  assert.equal(hasStreamColon('C:\\a\\b', WIN), false);
  assert.equal(hasStreamColon('/home/a/x:y', LINUX), false);
});

test('git by its full path on Linux: PATH\'s absolute folders, then the system\'s; never a relative folder', async () => {
  const { findGit } = await import('../server/github.mjs');
  const files = new Set(['/usr/bin/git', '/home/a/bin/git']);
  assert.equal(findGit({ env: { PATH: '.:/home/a/bin:/usr/bin' }, isFile: (p) => files.has(p), plat: LINUX }), '/home/a/bin/git');
  assert.equal(findGit({ env: { PATH: 'relative' }, isFile: (p) => p === '/usr/bin/git', plat: LINUX }), '/usr/bin/git');
  assert.equal(findGit({ env: {}, isFile: () => false, plat: LINUX }), null);
});

test('Claude Code\'s folder names on Linux start at the root: "-home-a-My-App" is /home/a/My App', async () => {
  const { resolveSlug } = await import('../server/adapters/claude-code.mjs');
  const tree = { '/': ['home', 'etc'], '/home': ['a'], '/home/a': ['My App', 'other'], '/home/a/My App': [] };
  const readDirs = (d) => tree[d] || [];
  assert.equal(resolveSlug('-home-a-My-App', readDirs, LINUX), '/home/a/My App');
  assert.equal(resolveSlug('-home-a-missing', readDirs, LINUX), null);
  assert.equal(resolveSlug('C--x', readDirs, LINUX), null, 'a Windows name is not a Linux one');
});

test('temp folders and the places programs keep their own files, per platform', async () => {
  const { tempFolders, programDataFolders } = await import('../server/platform.mjs');
  assert.deepEqual(tempFolders({ TMPDIR: '/var/folders/x/T' }, '/home/a', LINUX), ['/tmp', '/var/tmp', '/var/folders/x/T']);
  assert.deepEqual(tempFolders({ TEMP: 'C:\\T', TMP: 'relative' }, 'C:\\Users\\a', WIN), ['C:\\Users\\a\\AppData\\Local\\Temp', 'C:\\T']);
  assert.deepEqual(programDataFolders('/home/a', LINUX), ['/home/a/.local', '/home/a/.cache', '/home/a/.config', '/home/a/.var', '/home/a/snap']);
  assert.ok(programDataFolders('/Users/a', MAC).includes('/Users/a/Library'));
  assert.deepEqual(programDataFolders('C:\\Users\\a', WIN), ['C:\\Users\\a\\AppData']);
  assert.deepEqual(programDataFolders('', LINUX), []);
});

test('the catalog on Linux: a folder in /tmp is a temporary one; ~/.config and ~/.local never become projects', { skip: process.platform === 'win32' && 'the computer\'s own rules (Linux and macOS)' }, async () => {
  const { Catalog } = await import('../server/catalog.mjs');
  const c = new Catalog({ hubDir: '/home/a/SiberSentez', claudeDir: '/home/a/.claude', homeDir: '/home/a', adapters: [], env: {} });
  const adhoc = (p) => ({ kind: 'adhoc', path: p });
  assert.equal(c.placeOf(adhoc('/tmp/clone-x')), 'temp');
  assert.equal(c.placeOf(adhoc('/home/a/work/site')), null);
  assert.equal(c.isBroad('/home/a/.config/code/user'), true);
  assert.equal(c.isBroad('/home/a/.local/share/x'), true);
  assert.equal(c.isBroad('/home/a/work/site'), false);
  assert.equal(c.isBroad('/tmp'), true, 'the temp folder itself');
});

test('the catalog on Linux: a hidden folder in the home folder (~/.npm, ~/.cargo) and below it is the programs\' own', { skip: process.platform === 'win32' && 'the computer\'s own rules (Linux and macOS)' }, async () => {
  const { Catalog } = await import('../server/catalog.mjs');
  const c = new Catalog({ hubDir: '/home/a/SiberSentez', claudeDir: '/home/a/.claude', homeDir: '/home/a', adapters: [], env: {} });
  for (const n of ['/home/a/.npm', '/home/a/.npm/_cacache', '/home/a/.cargo/registry']) assert.equal(c.isBroad(n), true, n);
  for (const n of ['/home/a/work/.hidden-inside-project', '/home/a/code']) assert.equal(c.isBroad(n), false, n);
});

test('review G: an unknown top folder (a container\'s /app) can be a project; /etc/nginx and /usr/lib/x never', () => {
  for (const n of ['/app', '/workspace', '/data/site', '/usr/local/src/x']) assert.equal(isSystemFolder(n, LINUX), false, n);
  for (const n of ['/etc/nginx', '/usr/lib/x', '/usr/share/doc/x', '/opt', '/var']) assert.equal(isSystemFolder(n, LINUX), true, n);
});

test('the catalog on Linux: ~/.dotfiles and ~/.config/nvim stay possible projects only where they are not program folders', { skip: process.platform === 'win32' && 'the computer\'s own rules (Linux and macOS)' }, async () => {
  const { Catalog } = await import('../server/catalog.mjs');
  const c = new Catalog({ hubDir: '/home/a/SiberSentez', claudeDir: '/home/a/.claude', homeDir: '/home/a', adapters: [], env: {} });
  assert.equal(c.isBroad('/home/a/.dotfiles'), false, 'a hidden folder of the person\'s own');
  assert.equal(c.isBroad('/etc/nginx'), true, 'a system folder from a tool record');
  assert.equal(c.isBroad('/app'), false);
});

test('review G round 2: removable drives under /run/media and a container\'s /usr/src can hold projects', () => {
  for (const n of ['/run/media/a/usb/site', '/usr/src/app']) assert.equal(isSystemFolder(n, LINUX), false, n);
  for (const n of ['/run/user/1000', '/usr/share/x']) assert.equal(isSystemFolder(n, LINUX), true, n);
});

test('review G round 2: on Linux a command is an executable file; a plain file or a broken link is not', { skip: process.platform === 'win32' && 'the computer\'s own file rights' }, async () => {
  const { defaultIsFile } = await import('../server/tools.mjs');
  const fsm = await import('node:fs');
  const os = await import('node:os');
  const p = await import('node:path');
  const d = fsm.mkdtempSync(p.join(os.tmpdir(), 'ss-cmd-'));
  try {
    fsm.writeFileSync(p.join(d, 'run'), '#!/bin/sh\n', { mode: 0o755 });
    fsm.writeFileSync(p.join(d, 'plain'), 'x', { mode: 0o644 });
    fsm.symlinkSync(p.join(d, 'gone'), p.join(d, 'broken'));
    fsm.symlinkSync(p.join(d, 'run'), p.join(d, 'link'));
    assert.deepEqual(['run', 'plain', 'broken', 'link'].map((n) => defaultIsFile(p.join(d, n))), [true, false, false, true]);
  } finally {
    fsm.rmSync(d, { recursive: true, force: true });
  }
});
