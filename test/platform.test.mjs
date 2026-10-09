// Plan G1: what differs between Windows, Linux and macOS lives in server/platform.mjs, and the AI tool look-up asks it.
// Each platform is asked for by name, so every test runs on any computer. Run: node --test test/platform.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { platformOf, isLocalAbsolute, homeOf, installerDirs, appDataDir, terminalShell, fileManager, samePathOn, envOf } from '../server/platform.mjs';
import { searchDirs, findInstalls, installKind, runArgv, fileReady, envFlags as envFlagsOf } from '../server/tools.mjs';

const WIN = platformOf('win32');
const LINUX = platformOf('linux');
const MAC = platformOf('darwin');

test('three platforms; an unknown one is treated as Linux', () => {
  assert.deepEqual([WIN.id, LINUX.id, MAC.id, platformOf('freebsd').id], ['win32', 'linux', 'darwin', 'linux']);
  assert.deepEqual([WIN.listSep, LINUX.listSep], [';', ':']);
  assert.deepEqual([WIN.caseless, LINUX.caseless, MAC.caseless], [true, false, true]);
  assert.deepEqual(WIN.runnable, ['.exe', '.bat', '.cmd']);
  assert.deepEqual(LINUX.runnable, ['']);
  assert.equal(envOf({ Path: 'x' }, 'PATH'), 'x', 'any letter case');
});

test('a local absolute path: a drive letter on Windows, one slash elsewhere', () => {
  assert.equal(isLocalAbsolute('C:\\Users\\a', WIN), true);
  assert.equal(isLocalAbsolute('\\\\server\\share', WIN), false);
  assert.equal(isLocalAbsolute('/home/a', WIN), false);
  assert.equal(isLocalAbsolute('/home/a', LINUX), true);
  assert.equal(isLocalAbsolute('//server/share', LINUX), false);
  assert.equal(isLocalAbsolute('home/a', LINUX), false);
  assert.equal(isLocalAbsolute('C:\\Users', MAC), false);
});

test('the home folder, the installers\' folders and the app\'s own folder per platform', () => {
  const winEnv = { USERPROFILE: 'C:\\Users\\a', APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
  assert.deepEqual(installerDirs(winEnv, WIN).map((x) => x.key), ['localBin', 'npm', 'winget', 'scoop']);
  assert.equal(appDataDir(winEnv, WIN), 'C:\\Users\\a\\AppData\\Local\\SiberSentez');
  const nix = { HOME: '/home/a' };
  assert.equal(homeOf(nix, LINUX), '/home/a');
  assert.equal(homeOf({ HOME: 'relative' }, LINUX), '');
  assert.deepEqual(installerDirs(nix, LINUX), [{ dir: '/home/a/.local/bin', key: 'localBin' }, { dir: '/home/a/.npm-global/bin', key: 'npm' }, { dir: '/usr/local/bin', key: 'system' }, { dir: '/home/a/.bun/bin', key: 'own' }, { dir: '/home/a/.volta/bin', key: 'own' }, { dir: '/home/a/.opencode/bin', key: 'own' }]);
  // nvm's Node.js (the wizard's way; its PATH is in the shell's profile only): its newest versions first, three at most
  const nvm = installerDirs(nix, LINUX, (d) => (d === '/home/a/.nvm/versions/node' ? ['v20.1.0', 'v24.18.0', 'v22.3.1', 'v18.0.0', 'notes'] : []));
  assert.deepEqual(nvm.filter((x) => x.dir.includes('.nvm')).map((x) => x.dir), ['/home/a/.nvm/versions/node/v24.18.0/bin', '/home/a/.nvm/versions/node/v22.3.1/bin', '/home/a/.nvm/versions/node/v20.1.0/bin']);
  assert.ok(installerDirs({ ...nix, NVM_BIN: '/opt/n/bin' }, LINUX).some((x) => x.dir === '/opt/n/bin'));
  assert.deepEqual(installerDirs({ HOME: '/Users/a' }, MAC).map((x) => x.dir).slice(0, 4), ['/Users/a/.local/bin', '/Users/a/.npm-global/bin', '/opt/homebrew/bin', '/usr/local/bin']);
  assert.equal(appDataDir(nix, LINUX), '/home/a/.local/share/SiberSentez');
  assert.equal(appDataDir({ ...nix, XDG_DATA_HOME: '/data' }, LINUX), '/data/SiberSentez');
  assert.equal(appDataDir({ HOME: '/Users/a' }, MAC), '/Users/a/Library/Application Support/SiberSentez');
  assert.equal(appDataDir({}, LINUX), '');
});

test('the terminal\'s shell and the file manager per platform', () => {
  assert.deepEqual(terminalShell({ SystemRoot: 'C:\\Windows' }, WIN), { file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'] });
  assert.deepEqual(terminalShell({ SHELL: '/usr/bin/zsh' }, LINUX), { file: '/usr/bin/zsh', args: ['-l'] });
  assert.deepEqual(terminalShell({ SHELL: '/opt/evil' }, LINUX), { file: '/bin/bash', args: ['-l'] }, 'an unknown program is never the shell');
  assert.deepEqual(terminalShell({}, LINUX, () => false), { file: '/bin/sh', args: [] });
  assert.equal(fileManager({ SystemRoot: 'C:\\Windows' }, WIN), 'C:\\Windows\\explorer.exe');
  assert.equal(fileManager({}, LINUX), '/usr/bin/xdg-open');
  assert.equal(fileManager({}, MAC), '/usr/bin/open');
  assert.equal(samePathOn('/a/B/', '/a/b', LINUX), false);
  assert.equal(samePathOn('/a/B/', '/a/b', MAC), true);
  assert.equal(samePathOn('C:\\A\\', 'c:\\a', WIN), true);
});

test('the AI tool look-up on Linux: PATH split by ":", a plain executable, the installers\' folders after PATH', () => {
  const env = { HOME: '/home/a', PATH: '/usr/bin:/home/a/.local/bin:relative:/usr/bin/' };
  const dirs = searchDirs(env, LINUX, () => []);
  assert.deepEqual(dirs.map((d) => [d.dir, d.extra]).slice(0, 4), [['/usr/bin', false], ['/home/a/.local/bin', false], ['/home/a/.npm-global/bin', true], ['/usr/local/bin', true]]);
  const files = new Set(['/home/a/.local/bin/claude', '/home/a/.npm-global/bin/codex']);
  const found = findInstalls(['claude', 'codex'], dirs, (f) => files.has(f), LINUX);
  assert.deepEqual(found.map((x) => [x.file, x.ext]), [['/home/a/.local/bin/claude', ''], ['/home/a/.npm-global/bin/codex', '']]);
  assert.equal(installKind('/home/a/.local/bin/claude', undefined, LINUX), 'native');
  assert.equal(installKind('/home/a/.npm-global/bin/codex', undefined, LINUX), 'npm');
  assert.equal(installKind('/opt/homebrew/bin/gemini', undefined, MAC), 'brew');
  assert.equal(installKind('/usr/bin/claude', undefined, LINUX), 'other');
  assert.deepEqual(runArgv('/home/a/.local/bin/claude', '', ['--version'], '/bin/no-cmd'), { cmd: '/home/a/.local/bin/claude', args: ['--version'], verbatim: false });
  assert.equal(new Set(searchDirs({ HOME: '/home/a', PATH: '/A:/a' }, LINUX, () => []).map((d) => d.dir)).size, 8, 'letter case counts on Linux: /A and /a, then the six installer folders');
});

test('Windows answers as before (the same folders, in the same order)', () => {
  const env = { USERPROFILE: 'C:\\Users\\a', APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', PATH: 'C:\\Windows\\System32;c:\\windows\\system32\\;\\\\srv\\x' };
  assert.deepEqual(searchDirs(env, WIN).map((d) => d.dir), ['C:\\Windows\\System32', 'C:\\Users\\a\\.local\\bin', 'C:\\Users\\a\\AppData\\Roaming\\npm', 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links', 'C:\\Users\\a\\scoop\\shims']);
});

test('a tool\'s own settings files in the Linux home folder', () => {
  const files = { '/home/a/.qwen/settings.json': { security: { auth: { selectedType: 'qwen-oauth' } } } };
  const ready = fileReady('qwen', { env: { HOME: '/home/a' }, readJson: (p) => files[p] || null, isFile: (p) => p === '/home/a/.qwen/oauth_creds.json', plat: LINUX });
  assert.equal(ready, 'yes');
  assert.equal(fileReady('qwen', { env: {}, readJson: () => null, isFile: () => false, plat: LINUX }), 'unknown', 'no home folder');
});

test('inside WSL, Windows\' own PATH folders (/mnt/c/...) are never searched for tools; a plain Linux keeps /mnt', () => {
  const wsl = { HOME: '/home/a', PATH: '/usr/bin:/mnt/c/Users/a/AppData/Roaming/npm:/mnt/d/tools', WSL_DISTRO_NAME: 'Ubuntu' };
  assert.deepEqual(searchDirs(wsl, LINUX).filter((d) => !d.extra).map((d) => d.dir), ['/usr/bin']);
  const plain = { HOME: '/home/a', PATH: '/usr/bin:/mnt/d/tools' };
  assert.deepEqual(searchDirs(plain, LINUX).filter((d) => !d.extra).map((d) => d.dir), ['/usr/bin', '/mnt/d/tools']);
});

test('review G: the environment flags and Gemini\'s and OpenCode\'s settings files on Linux', () => {
  assert.deepEqual(envFlagsOf({ anthropic_api_key: 'x' }), { anthropicKey: true }, 'presence only, any letter case');
  assert.deepEqual(envFlagsOf({ ANTHROPIC_API_KEY: '  ' }), { anthropicKey: false });
  const files = { '/home/a/.gemini/settings.json': { security: { auth: { selectedType: 'gemini-api-key' } } }, '/home/a/.local/share/opencode/auth.json': { anthropic: { type: 'api' } } };
  const read = (p) => files[p] || null;
  assert.equal(fileReady('gemini', { env: { HOME: '/home/a', GEMINI_API_KEY: 'k' }, readJson: read, isFile: () => false, plat: LINUX }), 'yes');
  assert.equal(fileReady('gemini', { env: { HOME: '/home/a' }, readJson: read, isFile: () => false, plat: LINUX }), 'unknown');
  assert.equal(fileReady('opencode', { env: { HOME: '/home/a' }, readJson: read, isFile: () => false, plat: LINUX }), 'yes');
  assert.equal(fileReady('opencode', { env: { HOME: '/home/a', XDG_DATA_HOME: '/x' }, readJson: read, isFile: () => false, plat: LINUX }), 'no');
});
