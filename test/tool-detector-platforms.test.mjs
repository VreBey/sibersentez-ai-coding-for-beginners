// The tool detector with each platform's rules on every computer (server/tools.mjs createToolDetector, plan G2): the
// platform is injected (platformOf), every look at the system is a fake (files, folders, settings, programs) and no
// program starts. What Linux and macOS
// users get is tested on Windows too, and Windows' rules on Linux, where the tests written with Windows' own paths are
// skipped (independent review of 0.18.0 §9: the Linux coverage run). Run: node --test test/tool-detector-platforms.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolDetector, publicTools, searchDirs, detectGit, installKind, defaultIsFile, fileReady } from '../server/tools.mjs';
import { platformOf } from '../server/platform.mjs';
import { findGit } from '../server/github.mjs';
import { pickLaunchDir } from '../server/launch.mjs';
import { readQaShellOptions } from '../electron/qa-window.mjs';

const LINUX = platformOf('linux');
const MAC = platformOf('darwin');
const WIN = platformOf('win32');
const HOME = '/home/u';
const ENV = { HOME, PATH: '/usr/bin:/bin:relative/bin:/home/u/.npm-global/bin' };

// A fake spawn: answer(cmd, args) -> { code, out } | { code: 'hang' } | { error }; every call is recorded
function fakeSpawn(calls, answer) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => (child.killed = true);
    child.pid = 4000 + calls.length;
    const a = answer(cmd, args) || { code: 0, out: '' };
    process.nextTick(() => {
      if (a.error) return child.emit('error', Object.assign(new Error('fake'), { code: a.error }));
      if (a.code === 'hang') return;
      if (a.out && opts.stdio?.[1] === 'pipe') child.stdout.emit('data', a.out);
      child.emit('close', a.code);
    });
    return child;
  };
}

function detector({ files = [], answer = () => null, env = ENV, json = {}, settingsFiles = [], plat = LINUX, ...rest } = {}) {
  const calls = [];
  const fileSet = new Set(files);
  const settings = new Set(settingsFiles);
  const d = createToolDetector({
    env,
    plat,
    spawn: fakeSpawn(calls, answer),
    isFile: (f) => fileSet.has(f),
    exists: (f) => settings.has(f),
    isDir: () => false,
    readDir: () => [],
    readJson: (f) => json[f] ?? null,
    versionTimeoutMs: 200,
    readyTimeoutMs: 200,
    ...rest,
  });
  return { d, calls };
}
const byId = (r, id) => r.tools.find((t) => t.id === id);

test('Linux: a plain executable on PATH is found and asked its version directly, never through cmd.exe; its folder is the working folder', async () => {
  const { d, calls } = detector({
    files: ['/usr/bin/claude', '/usr/bin/node', '/usr/bin/git'],
    answer: (cmd, args) => (args[0] === '--version' ? { code: 0, out: cmd.endsWith('node') ? 'v24.18.0\n' : '2.1.294 (Claude Code)\n' } : { code: 0 }),
  });
  const r = await d.detect();
  const claude = byId(r, 'claude');
  assert.deepEqual([claude.installed, claude.version, claude.via, claude.ready], [true, '2.1.294', 'other', 'yes']);
  assert.deepEqual(claude.chosen, { dir: '/usr/bin', file: '/usr/bin/claude', ext: '', extra: false, via: 'other', version: '2.1.294' });
  assert.deepEqual(r.node, { installed: true, version: '24.18.0' });
  assert.deepEqual(r.git, { installed: true, onPath: true });
  const versionCall = calls.find((c) => c.cmd === '/usr/bin/claude' && c.args[0] === '--version');
  assert.equal(versionCall.opts.cwd, '/usr/bin');
  assert.equal(versionCall.opts.shell, false);
  assert.ok(!calls.some((c) => /cmd\.exe$/i.test(c.cmd)), 'no cmd.exe on Linux');
  // The child's environment: no switch that changes how Node or Electron programs start
  assert.equal(versionCall.opts.env.NO_UPDATE_NOTIFIER, '1');
  assert.ok(!('NODE_OPTIONS' in versionCall.opts.env));
  // Signed in: `claude auth status` by exit code only
  assert.ok(calls.some((c) => c.cmd === '/usr/bin/claude' && c.args.join(' ') === 'auth status'));
  assert.equal(d.stats.detections, 1);
});

test('Linux: installer folders PATH lacks (~/.local/bin, nvm) are found and named; the page gets no path', async () => {
  const env = { ...ENV, NVM_BIN: '/home/u/.nvm/versions/node/v24.18.0/bin' };
  const { d } = detector({
    env,
    files: ['/home/u/.local/bin/claude', '/home/u/.nvm/versions/node/v24.18.0/bin/codex', '/home/u/.npm-global/bin/copilot'],
    answer: (cmd, args) => (args[0] === '--version' || args[0] === 'version' ? { code: 0, out: '1.2.3' } : { code: 1 }),
  });
  const r = await d.detect();
  const pub = publicTools(r);
  const claude = pub.tools.find((t) => t.id === 'claude');
  assert.deepEqual([claude.installed, claude.via, claude.onPath, claude.pathDir, claude.ready, claude.cmd], [true, 'native', false, 'localBin', 'no', 'claude']);
  const codex = pub.tools.find((t) => t.id === 'codex');
  assert.deepEqual([codex.via, codex.onPath, codex.pathDir], ['npm', false, 'nvm']);
  assert.equal(codex.app, false, 'the Windows app package is looked for on Windows only');
  const copilot = pub.tools.find((t) => t.id === 'copilot');
  assert.deepEqual([copilot.via, copilot.onPath, copilot.ready], ['npm', true, 'unknown'], 'on PATH; no sign-in command');
  assert.doesNotMatch(JSON.stringify(pub), /\/home\/u/);
  assert.equal(pub.node.installed, false);
});

test('Linux: a tool without a sign-in command is read from its settings file in the home folder (presence, never the value)', async () => {
  const { d } = detector({
    env: { ...ENV, NVIDIA_API_KEY: 'nv-secret' },
    files: ['/usr/bin/qwen', '/usr/bin/gemini', '/usr/bin/opencode'],
    json: {
      '/home/u/.qwen/settings.json': { security: { auth: { selectedType: 'openai' } }, modelProviders: { openai: [{ envKey: 'NVIDIA_API_KEY' }] } },
      '/home/u/.gemini/settings.json': { security: { auth: { selectedType: 'oauth-personal' } } },
    },
    settingsFiles: ['/home/u/.gemini/oauth_creds.json'],
    answer: () => ({ code: 0, out: '0.25.0' }),
  });
  const r = await d.detect();
  assert.equal(byId(r, 'qwen').ready, 'yes', 'its provider\'s key variable is set');
  assert.equal(byId(r, 'gemini').ready, 'unknown', 'Google sign-in file without a project: not known');
  assert.equal(byId(r, 'opencode').installed, true);
  assert.doesNotMatch(JSON.stringify(publicTools(r)), /nv-secret/);
});

test('Linux: a generic command name counts only when its folder or its output says the tool; a hung or failing program is unknown', async () => {
  const { d } = detector({
    files: ['/usr/bin/agent', '/home/u/.local/bin/cursor-agent', '/usr/bin/claude'],
    answer: (cmd, args) => {
      if (cmd === '/usr/bin/agent') return { code: 0, out: 'some other agent 9.9' };
      if (cmd.endsWith('cursor-agent') && args[0] === 'status') return { code: 0, out: 'Not logged in' };
      if (cmd.endsWith('cursor-agent')) return { code: 0, out: '2026.10.01-abc' };
      if (cmd === '/usr/bin/claude' && args[0] === 'auth') return { code: 'hang' };
      if (cmd === '/usr/bin/claude') return { error: 'EACCES' };
      return { code: 0 };
    },
  });
  const r = await d.detect();
  const cursor = byId(r, 'cursor');
  assert.deepEqual(cursor.installs.map((i) => i.file), ['/home/u/.local/bin/cursor-agent'], 'the unrelated `agent` is dropped');
  assert.equal(cursor.ready, 'no', '"Not logged in" is not signed in');
  const claude = byId(r, 'claude');
  assert.deepEqual([claude.installed, claude.version, claude.ready], [true, null, 'unknown'], 'no version printed; sign-in check timed out');
});

test('Linux: cached for a while; a refresh right after is throttled; one detection at a time', async () => {
  let t = 0;
  const { d, calls } = detector({ files: ['/usr/bin/node'], answer: () => ({ code: 0, out: 'v24.0.0' }), now: () => t, ttlMs: 1000, minRefreshMs: 100 });
  const [a, b] = await Promise.all([d.detect(), d.detect()]);
  assert.equal(a, b, 'one detection for both');
  const n = calls.length;
  t = 50;
  assert.equal(await d.detect({ refresh: true }), a, 'throttled');
  t = 500;
  assert.equal(await d.detect(), a, 'still fresh');
  assert.equal(calls.length, n);
  await d.detect({ refresh: true });
  assert.ok(calls.length > n, 'a refresh after the throttle asks again');
  assert.equal(d.busy(), false);
  assert.ok(d.cached());
});

test('Linux and macOS folders: relative and Windows-drive folders inside WSL are skipped; the kind of install by its path', () => {
  const dirs = searchDirs({ ...ENV, PATH: '/usr/bin:relative/bin:/mnt/c/Windows/System32:/usr/bin/', WSL_DISTRO_NAME: 'Ubuntu' }, LINUX, () => []);
  assert.deepEqual(dirs.filter((d) => !d.extra).map((d) => d.dir), ['/usr/bin']);
  assert.ok(dirs.some((d) => d.key === 'system' && d.dir === '/usr/local/bin'));
  assert.ok(searchDirs(ENV, MAC, () => []).some((d) => d.key === 'brew' && d.dir === '/opt/homebrew/bin'));
  assert.deepEqual(detectGit([{ dir: '/usr/local/bin', extra: true }], ENV, (f) => f === '/usr/local/bin/git', LINUX), { installed: true, onPath: false });
  assert.equal(installKind('/opt/homebrew/bin/claude', () => false, MAC), 'brew');
  assert.equal(installKind('/usr/local/bin/claude', () => false, MAC), 'brew');
  assert.equal(installKind('/usr/local/bin/claude', () => false, LINUX), 'other');
  assert.equal(installKind('/home/u/.linuxbrew/bin/claude', () => false, LINUX), 'brew');
});

// ---- Windows' rules, on every computer (path.win32 works anywhere)
const WENV = {
  Path: 'C:\\Windows\\System32;C:\\Tools',
  USERPROFILE: 'C:\\Users\\u',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  SystemRoot: 'C:\\Windows',
  NODE_OPTIONS: '--inspect',
};
const CMD = 'C:\\Windows\\System32\\cmd.exe';

test('Windows: an npm shim runs through cmd.exe from its own folder, an .exe directly; the kind of install and the app package', async () => {
  const { d, calls } = detector({
    plat: WIN,
    env: WENV,
    cmdExe: CMD,
    files: ['C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd', 'C:\\Tools\\claude.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Users\\u\\scoop\\shims\\node.exe'],
    readDir: (dir) => (dir === 'C:\\Users\\u\\AppData\\Local\\Packages' ? ['OpenAI.Codex_2p2nqsd0c76g0'] : []),
    answer: (cmd, args) => (cmd === CMD ? { code: 0, out: 'codex-cli 0.160.0' } : args[0] === '--version' ? { code: 0, out: cmd.endsWith('node.exe') ? 'v24.1.0' : '2.1.294' } : { code: 0 }),
  });
  const r = await d.detect();
  const codex = byId(r, 'codex');
  assert.deepEqual([codex.via, codex.version, codex.app, codex.chosen.extra], ['npm', '0.160.0', true, true]);
  const shim = calls.find((c) => c.cmd === CMD && c.args.at(-1).includes('codex.cmd'));
  assert.deepEqual(shim.args.slice(0, 4), ['/d', '/v:off', '/s', '/c']);
  assert.equal(shim.opts.windowsVerbatimArguments, true);
  assert.equal(shim.opts.cwd, 'C:\\Users\\u\\AppData\\Roaming\\npm');
  // cmd never looks a bare name up in the working folder; Node's start switches are dropped
  assert.equal(shim.opts.env.NoDefaultCurrentDirectoryInExePath, '1');
  assert.ok(!('NODE_OPTIONS' in shim.opts.env));
  const claude = byId(r, 'claude');
  assert.deepEqual([claude.via, claude.chosen.extra, claude.ready], ['native', false, 'yes']);
  assert.deepEqual(r.git, { installed: true, onPath: false }, 'Git for Windows in Program Files, off PATH');
  assert.deepEqual(r.node, { installed: true, version: '24.1.0' });
  const pub = publicTools(r);
  assert.equal(pub.tools.find((t) => t.id === 'codex').pathDir, 'npm');
  assert.doesNotMatch(JSON.stringify(pub), /Users|\\\\/);
});

test('Windows: a program past its time limit is ended with its whole tree (taskkill by absolute path), and counts as unknown', async () => {
  const { d, calls } = detector({
    plat: WIN,
    env: WENV,
    cmdExe: CMD,
    files: ['C:\\Tools\\claude.exe'],
    answer: (cmd, args) => (/taskkill/i.test(cmd) ? { code: 0 } : args[0] === 'auth' ? { code: 'hang' } : { code: 0, out: '2.1.294' }),
  });
  const claude = byId(await d.detect(), 'claude');
  assert.equal(claude.ready, 'unknown');
  const kill = calls.find((c) => /taskkill\.exe$/i.test(c.cmd));
  assert.ok(kill, 'taskkill ran');
  assert.equal(kill.cmd, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(kill.args.slice(0, 3), ['/T', '/F', '/PID']);
});

test('Windows: settings files under the user profile; folders and kinds by Windows rules', () => {
  const read = { 'C:\\Users\\u\\.qwen\\settings.json': { security: { auth: { selectedType: 'qwen-oauth' } } } };
  assert.equal(fileReady('qwen', { env: WENV, readJson: (f) => read[f] ?? null, isFile: (f) => f === 'C:\\Users\\u\\.qwen\\oauth_creds.json', plat: WIN }), 'yes');
  assert.equal(fileReady('qwen', { env: WENV, readJson: (f) => read[f] ?? null, isFile: () => false, plat: WIN }), 'no');
  assert.equal(fileReady('gemini', { env: { ...WENV, GEMINI_API_KEY: 'k' }, readJson: () => null, isFile: () => false, plat: WIN }), 'yes');
  assert.equal(fileReady('opencode', { env: {}, plat: WIN }), 'unknown', 'no home folder');
  const dirs = searchDirs({ ...WENV, Path: 'C:\\Tools;relative;\\\\server\\share;C:\\Tools\\' }, WIN, () => []);
  assert.deepEqual(dirs.filter((x) => !x.extra).map((x) => x.dir), ['C:\\Tools']);
  assert.deepEqual(dirs.filter((x) => x.extra).map((x) => x.key), ['localBin', 'npm', 'winget', 'scoop']);
  assert.equal(installKind('C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\x.exe', () => false, WIN), 'winget');
  assert.equal(installKind('C:\\Users\\u\\scoop\\shims\\x.exe', () => false, WIN), 'scoop');
  assert.equal(installKind('C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\x.exe', () => false, WIN), 'store');
  assert.equal(installKind('D:\\tools\\x.cmd', (d) => d === 'D:\\tools', WIN), 'npm', 'a shim beside node_modules');
  assert.equal(installKind('D:\\tools\\x.cmd', () => false, WIN), 'other');
  assert.equal(installKind('D:\\tools\\x', () => false, WIN), 'other');
});

test('Windows: git for a GitHub import by absolute path (PATH\'s drive folders, then Git for Windows); the launch folder', () => {
  const env = { PATH: '.;relative;C:\\Tools;"C:\\Quoted Dir"', ProgramW6432: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  assert.equal(findGit({ env, isFile: (f) => f === 'C:\\Quoted Dir\\git.exe', plat: WIN }), 'C:\\Quoted Dir\\git.exe');
  assert.equal(findGit({ env, isFile: (f) => f === 'C:\\Program Files\\Git\\cmd\\git.exe', plat: WIN }), 'C:\\Program Files\\Git\\cmd\\git.exe');
  assert.equal(findGit({ env, isFile: (f) => f === 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe', plat: WIN }), 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe');
  assert.equal(findGit({ env, isFile: (f) => f === 'relative\\git.exe', plat: WIN }), null, 'never a relative folder');
  assert.equal(findGit({ env: { PATH: '/usr/bin' }, isFile: (f) => f === '/usr/bin/git', plat: LINUX }), '/usr/bin/git');
  const unsafe = (d) => /[&|]/.test(d);
  assert.deepEqual(pickLaunchDir(['/home/u', 'C:\\Users\\u\\proj'], unsafe, WIN), { ok: true, mode: 'absolute', dir: 'C:\\Users\\u\\proj' });
  assert.deepEqual(pickLaunchDir(['C:\\Users\\u\\Oyun çalışması'], unsafe, WIN), { ok: true, mode: 'relative', dir: 'C:\\Users\\u\\Oyun çalışması' }, 'a name cmd cannot take on its line: started from that folder');
  assert.deepEqual(pickLaunchDir(['C:\\a&b'], unsafe, WIN), { ok: false });
  assert.deepEqual(pickLaunchDir(['relative', '/home/u/proj'], unsafe, LINUX), { ok: true, mode: 'absolute', dir: '/home/u/proj' });
});

test('the QA shell options: a project folder only for a hidden run, and only a local absolute one', () => {
  const qa = { enabled: true };
  const here = os.tmpdir();
  assert.deepEqual(readQaShellOptions({ env: { SIBERSENTEZ_QA_HIDDEN: '1', SIBERSENTEZ_QA_PROBES: '1', SIBERSENTEZ_QA_PROJECT_DIR: here }, qa }), { hidden: true, probes: true, projectDir: path.resolve(here), rejected: null });
  assert.match(readQaShellOptions({ env: { SIBERSENTEZ_QA_PROJECT_DIR: here }, qa }).rejected, /needs SIBERSENTEZ_QA_HIDDEN=1/);
  assert.match(readQaShellOptions({ env: { SIBERSENTEZ_QA_HIDDEN: '1', SIBERSENTEZ_QA_PROJECT_DIR: 'relative/dir' }, qa }).rejected, /^SIBERSENTEZ_QA_PROJECT_DIR: /);
  assert.deepEqual(readQaShellOptions({ env: { SIBERSENTEZ_QA_HIDDEN: '1' } }), { hidden: false, probes: false, projectDir: null, rejected: null }, 'not a QA run');
});

test('a command file on this computer: a plain file only (and on Linux and macOS an executable one)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-isfile-'));
  try {
    const f = path.join(dir, 'tool');
    fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o644 });
    assert.equal(defaultIsFile(path.join(dir, 'missing')), false);
    assert.equal(defaultIsFile(dir), false, 'a folder');
    if (process.platform === 'win32') assert.equal(defaultIsFile(f), true);
    else {
      assert.equal(defaultIsFile(f), false, 'not executable');
      fs.chmodSync(f, 0o755);
      assert.equal(defaultIsFile(f), true);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
