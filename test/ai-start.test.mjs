// "Start with AI" (docs/ai-start.md): tool detection (server/tools.mjs), the launcher and the first message
// (server/launch.mjs), the start-ai action and GET /api/tools over HTTP, and the page's parts (public/js/views/tools.js,
// the drawer section, the context menu, the start card). Run: node --test test/ai-start.test.mjs
// No test starts a real program: every spawn is a fake. Files are written only under a temp folder.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { searchDirs, findInstalls, installKind, parseVersion, runArgv, createToolDetector, publicTools, TOOLS, TOOL_IDS } from '../server/tools.mjs';
import {
  launchPrompt,
  toolArgs,
  firstMessageText,
  jobMessageText,
  batchPath,
  launcherText,
  pickLaunchDir,
  buildAiArgv,
  buildAiFallbackArgv,
  planFirstMessage,
  writeFirstMessage,
  cleanupLaunchers,
  FIRST_NAMES,
  GITIGNORE_TEXT,
  PROMPT_SAFE_RE,
  SAFE_LAUNCH_RE,
  LAUNCHER_NAME_RE,
} from '../server/launch.mjs';
import { createActions } from '../server/actions.mjs';
import { JOB_ID_RE, jobMessageName, readCurrentJob } from '../server/job-id.mjs';
import { projectTeam } from '../server/team.mjs';
import { createHandler } from '../server/app.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';
import { actionBody } from '../public/js/actions.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';
import { menuModel, resultToast, errorText } from '../public/js/contextmenu.js';
import { startNextHtml } from '../public/js/views/drawer.js';
import { startCardHtml } from '../public/js/views/projects.js';
import {
  aiStartMenuItems,
  aiStartToast,
  aiStartSectionHtml,
  toolsPanelHtml,
  normalizeTools,
  loadTools,
  needTools,
  onToolsChange,
  toolsState,
  setIdeaPref,
  ideaPref,
  installedTools,
  TOOL_INFO,
  _resetToolsForTest,
} from '../public/js/views/tools.js';

// ---------------- the test world ----------------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-ai-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const mkdir = (...parts) => {
  const d = path.join(ROOT, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const touch = (file, text = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

// Every file and folder below a folder (relative paths, sorted)
function listTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(dir, '');
  return out.sort();
}

const S_A = '11111111-aaaa-4aaa-8aaa-111111111111';
// An idea full of characters a shell or Windows Terminal treats specially, and Turkish letters
const IDEA = 'Unity ile 2D oyun; "kahraman" %PATH% & | < > ! ^ şğüöçı';

// Fake detector spawn: stdout gets `out`, then close with `code`; never closes when code is 'hang'
function fakeToolSpawn(calls, answer) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => (child.killed = true);
    const a = answer(cmd, args, opts) || { code: 0, out: '' };
    if (a.code !== 'hang') {
      process.nextTick(() => {
        if (a.out && opts.stdio?.[1] === 'pipe') child.stdout.emit('data', a.out);
        child.emit('close', a.code);
      });
    }
    return child;
  };
}

// Fake launch spawn (like test/actions.test.mjs): 'spawn' or an error code per call
function launchSpawn(calls, fail = () => null) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    const code = fail(cmd, args, opts);
    process.nextTick(() => (code ? child.emit('error', Object.assign(new Error('fake'), { code })) : child.emit('spawn')));
    return child;
  };
}

// ======================================================================= detection (server/tools.mjs)
describe('detection: finding the tools', () => {
  test('search folders: PATH in order, each once (letter case, trailing backslash, quotes), no network or relative folder; the installers\' folders after', () => {
    const env = {
      Path: 'C:\\A;c:\\a\\;"C:\\B";\\\\server\\share;relative\\bin;;C:\\Users\\u\\AppData\\Roaming\\npm',
      USERPROFILE: 'C:\\Users\\u',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    };
    const d = searchDirs(env);
    assert.deepEqual(
      d.map((x) => [x.dir, x.extra]),
      [
        ['C:\\A', false],
        ['C:\\B', false],
        ['C:\\Users\\u\\AppData\\Roaming\\npm', false],
        ['C:\\Users\\u\\.local\\bin', true],
        ['C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links', true],
        ['C:\\Users\\u\\scoop\\shims', true],
      ],
    );
    assert.deepEqual(searchDirs({}), [], 'no PATH, no home: nothing');
  });

  test('installs: one per folder in folder order; .exe before .bat and .cmd; .ps1 and extensionless files are never taken; Cursor\'s own name first', () => {
    const files = new Set(['C:\\A\\claude', 'C:\\A\\claude.ps1', 'C:\\B\\claude.cmd', 'C:\\B\\claude.exe', 'C:\\C\\claude.cmd', 'C:\\D\\agent.exe', 'C:\\D\\cursor-agent.exe']);
    const dirs = ['C:\\A', 'C:\\B', 'C:\\C', 'C:\\D'].map((dir) => ({ dir, extra: dir === 'C:\\C' }));
    const isFile = (f) => files.has(f);
    assert.deepEqual(findInstalls(['claude'], dirs, isFile), [
      { dir: 'C:\\B', file: 'C:\\B\\claude.exe', ext: '.exe', extra: false },
      { dir: 'C:\\C', file: 'C:\\C\\claude.cmd', ext: '.cmd', extra: true },
    ]);
    assert.equal(findInstalls(['cursor-agent', 'agent'], dirs, isFile)[0].file, 'C:\\D\\cursor-agent.exe');
    assert.deepEqual(findInstalls(['codex'], dirs, isFile), []);
  });

  test('install kind from the path alone: native, npm, winget, scoop, store, other', () => {
    assert.equal(installKind('C:\\Users\\u\\.local\\bin\\claude.exe'), 'native');
    assert.equal(installKind('C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'), 'npm');
    assert.equal(installKind('C:\\nvm\\v20\\gemini.cmd', (d) => d === 'C:\\nvm\\v20'), 'npm', 'a shim next to node_modules');
    assert.equal(installKind('C:\\tools\\gemini.cmd'), 'other');
    assert.equal(installKind('C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe'), 'winget');
    assert.equal(installKind('C:\\Users\\u\\scoop\\shims\\opencode.exe'), 'scoop');
    assert.equal(installKind('C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\copilot.exe'), 'store');
  });

  test('version: the first dotted number; a .cmd runs through cmd.exe with fixed arguments, never a path cmd would expand', () => {
    assert.equal(parseVersion('2.1.284 (Claude Code)'), '2.1.284');
    assert.equal(parseVersion('v24.18.0\n'), '24.18.0');
    assert.equal(parseVersion('codex-cli 0.41.0-alpha.3'), '0.41.0-alpha.3');
    assert.equal(parseVersion('no version here'), null);
    assert.deepEqual(runArgv('C:\\x\\claude.exe', '.exe', ['--version'], 'C:\\W\\cmd.exe'), { cmd: 'C:\\x\\claude.exe', args: ['--version'], verbatim: false });
    assert.deepEqual(runArgv('C:\\Users\\A B\\npm\\gemini.cmd', '.cmd', ['--version'], 'C:\\W\\cmd.exe'), { cmd: 'C:\\W\\cmd.exe', args: ['/d', '/v:off', '/s', '/c', '""C:\\Users\\A B\\npm\\gemini.cmd" --version"'], verbatim: true });
    assert.equal(runArgv('C:\\a%PATH%\\gemini.cmd', '.cmd', ['--version'], 'C:\\W\\cmd.exe'), null, '% would be expanded inside the quotes');
    assert.equal(runArgv('C:\\a"b\\gemini.cmd', '.cmd', ['--version'], 'C:\\W\\cmd.exe'), null);
  });

  // A small fake computer: Claude Code twice (native and an older npm shim), Gemini as npm, Node, the Codex app
  function fakeComputer({ authCode = 0, hang = null } = {}) {
    const files = new Set(['C:\\Users\\u\\.local\\bin\\claude.exe', 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Users\\u\\AppData\\Roaming\\npm\\gemini.cmd', 'C:\\Program Files\\nodejs\\node.exe']);
    const env = { PATH: 'C:\\Users\\u\\.local\\bin;C:\\Users\\u\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs', USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ELECTRON_RUN_AS_NODE: '1' };
    const calls = [];
    const spawn = fakeToolSpawn(calls, (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      if (hang && line.includes(hang)) return { code: 'hang' };
      if (line.includes('auth status')) return { code: authCode, out: '{"email":"someone@example.com"}' };
      if (line.includes('claude.exe')) return { code: 0, out: '2.1.284 (Claude Code)\n' };
      if (line.includes('claude.cmd')) return { code: 0, out: '2.1.193 (Claude Code)\n' };
      if (line.includes('gemini.cmd')) return { code: 0, out: '0.52.0\n' };
      if (line.includes('node.exe')) return { code: 0, out: 'v24.18.0\n' };
      return { code: 1, out: '' };
    });
    const readDir = (d) => (d === 'C:\\Users\\u\\AppData\\Local\\Packages' ? ['OpenAI.Codex_2p2nqsd0c76g0', 'Other.App_1'] : []);
    return { env, spawn, calls, isFile: (f) => files.has(f), isDir: () => false, readDir, cmdExe: 'C:\\Windows\\System32\\cmd.exe' };
  }

  test('detector: several installs are counted and each gets a version; the first on PATH is used; hidden windows, no shell, no input, the tool\'s own folder as working directory', async () => {
    const c = fakeComputer();
    let clock = 1000;
    const d = createToolDetector({ ...c, now: () => clock });
    const r = await d.detect();
    const claude = r.tools.find((x) => x.id === 'claude');
    assert.equal(claude.installed, true);
    assert.equal(claude.installs.length, 2);
    assert.deepEqual(claude.installs.map((i) => [i.via, i.version]), [['native', '2.1.284'], ['npm', '2.1.193']]);
    assert.equal(claude.chosen.file, 'C:\\Users\\u\\.local\\bin\\claude.exe');
    assert.equal(claude.ready, 'yes');
    const gemini = r.tools.find((x) => x.id === 'gemini');
    assert.deepEqual([gemini.installed, gemini.via, gemini.version, gemini.ready], [true, 'npm', '0.52.0', 'unknown'], 'Gemini has no sign-in command: unknown');
    const codex = r.tools.find((x) => x.id === 'codex');
    assert.deepEqual([codex.installed, codex.app], [false, true], 'the desktop app is there, the command-line tool is not');
    assert.deepEqual(r.node, { installed: true, version: '24.18.0' });
    for (const call of c.calls) {
      assert.equal(call.opts.windowsHide, true, 'no window');
      assert.equal(call.opts.shell, false);
      assert.equal(call.opts.stdio[0], 'ignore', 'no input');
      assert.equal(call.opts.stdio[2], 'ignore', 'error output never read');
      assert.equal(call.opts.env.ELECTRON_RUN_AS_NODE, undefined);
      const file = call.cmd.endsWith('cmd.exe') ? /""(.+?)"/.exec(call.args.at(-1))[1] : call.cmd;
      assert.equal(call.opts.cwd, path.win32.dirname(file), 'the tool\'s own folder');
    }
    // The .cmd shims ran through cmd.exe, verbatim; nothing for tools that were not found
    assert.ok(c.calls.some((x) => x.cmd === 'C:\\Windows\\System32\\cmd.exe' && x.opts.windowsVerbatimArguments === true));
    assert.ok(!c.calls.some((x) => /codex|copilot|qwen|opencode|agent/.test([x.cmd, ...x.args].join(' '))));
  });

  test('sign-in: exit code only (its output, which holds the e-mail, is not even read); 1 -> no, a hang -> unknown after the time limit', async () => {
    const yes = fakeComputer();
    await createToolDetector(yes).detect();
    const auth = yes.calls.filter((x) => x.args.join(' ').includes('auth status'));
    assert.equal(auth.length, 1);
    assert.equal(auth[0].opts.stdio[1], 'ignore', 'standard output not captured');
    const no = fakeComputer({ authCode: 1 });
    assert.equal((await createToolDetector(no).detect()).tools.find((x) => x.id === 'claude').ready, 'no');
    const hang = fakeComputer({ hang: 'auth status' });
    const t0 = Date.now();
    const r = await createToolDetector({ ...hang, readyTimeoutMs: 60, versionTimeoutMs: 60 }).detect();
    assert.equal(r.tools.find((x) => x.id === 'claude').ready, 'unknown');
    assert.ok(Date.now() - t0 < 2000, 'the time limit ends the wait');
  });

  test('Cursor CLI under the generic name `agent`: kept only when its folder or its version output says Cursor; cursor-agent always', async () => {
    const detectWith = async (files, outs) => {
      const env = { PATH: 'C:\\Tools;C:\\Users\\u\\AppData\\Local\\cursor-agent;C:\\Other', USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
      const spawn = fakeToolSpawn([], (cmd, args) => {
        const line = [cmd, ...args].join(' ');
        for (const [file, out] of Object.entries(outs)) if (line.includes(file)) return { code: 0, out };
        return { code: 1, out: '' };
      });
      const set = new Set(files);
      const r = await createToolDetector({ env, spawn, isFile: (f) => set.has(f), isDir: () => false, readDir: () => [], cmdExe: 'C:\\Windows\\System32\\cmd.exe' }).detect();
      return r.tools.find((x) => x.id === 'cursor');
    };
    // Another program named agent comes first on PATH: not Cursor; the one in Cursor's folder is
    let c = await detectWith(['C:\\Tools\\agent.exe', 'C:\\Users\\u\\AppData\\Local\\cursor-agent\\agent.exe'], { 'C:\\Tools\\agent.exe': 'agent 3.1.0\n', 'cursor-agent\\agent.exe': '2025.09.18-7ae6800\n' });
    assert.deepEqual(c.installs.map((i) => i.file), ['C:\\Users\\u\\AppData\\Local\\cursor-agent\\agent.exe']);
    // Only the other program: Cursor CLI is not installed
    c = await detectWith(['C:\\Tools\\agent.exe'], { 'C:\\Tools\\agent.exe': 'agent 3.1.0\n' });
    assert.equal(c.installed, false);
    // A generic name whose output names Cursor counts, wherever it is
    c = await detectWith(['C:\\Other\\agent.exe'], { 'C:\\Other\\agent.exe': 'Cursor Agent 1.4.0\n' });
    assert.equal(c.installed, true);
    // Cursor's own command name needs no proof
    c = await detectWith(['C:\\Tools\\cursor-agent.exe'], { 'cursor-agent.exe': '1.0.0\n' });
    assert.deepEqual([c.installed, c.installs[0].said], [true, undefined], 'nothing it printed is kept');
  });

  test('time limit: a version check that never ends gives no version, the detection still answers', async () => {
    const c = fakeComputer({ hang: 'gemini.cmd' });
    const r = await createToolDetector({ ...c, versionTimeoutMs: 50 }).detect();
    const g = r.tools.find((x) => x.id === 'gemini');
    assert.deepEqual([g.installed, g.version], [true, null]);
  });

  test('cache: five minutes; one detection at a time; "check again" is throttled to once in 10 s', async () => {
    const c = fakeComputer();
    let clock = 0;
    const d = createToolDetector({ ...c, now: () => clock });
    const [a, b] = await Promise.all([d.detect(), d.detect()]);
    assert.equal(a, b, 'the same run');
    assert.equal(d.stats.detections, 1);
    const n = c.calls.length;
    clock += 60 * 1000;
    await d.detect();
    assert.equal(c.calls.length, n, 'cached');
    await d.detect({ refresh: true });
    assert.equal(d.stats.detections, 2, 'refresh after 10 s runs again');
    clock += 3000;
    await d.detect({ refresh: true });
    assert.equal(d.stats.detections, 2, 'refresh within 10 s: the last answer');
    clock += 5 * 60 * 1000 + 1;
    await d.detect();
    assert.equal(d.stats.detections, 3, 'stale after five minutes');
  });

  test('what the page gets: known words only, never a path, a user name or any tool output', async () => {
    const c = fakeComputer();
    const r = await createToolDetector(c).detect();
    const pub = publicTools(r);
    const text = JSON.stringify(pub);
    assert.doesNotMatch(text, /\\|:\/|Users|\.exe|\.cmd|@|email/i);
    assert.deepEqual(Object.keys(pub.tools[0]).sort(), ['app', 'id', 'installed', 'installs', 'name', 'onPath', 'others', 'pathDir', 'ready', 'version', 'via']);
    assert.deepEqual(pub.tools.map((x) => x.id), TOOL_IDS);
    const claude = pub.tools[0];
    assert.deepEqual([claude.installs, claude.others], [2, [{ via: 'npm', version: '2.1.193' }]]);
    // A hostile record is cleaned: a version or kind that is not a known word does not pass
    const bad = publicTools({ tools: [{ id: 'claude', name: 'Claude Code', installed: true, version: 'C:\\Users\\x', via: 'C:\\evil', ready: 'maybe', installs: [{}], chosen: { file: 'C:\\Users\\x\\claude.exe' } }] });
    assert.deepEqual([bad.tools[0].version, bad.tools[0].via, bad.tools[0].ready], [null, 'other', 'unknown']);
  });
});

// ======================================================================= launcher and first message (server/launch.mjs)
describe('launcher and first message', () => {
  test('the prompt is fixed ASCII: no user text, no character a shell or Windows Terminal reads specially; only SiberSentez\'s file names', () => {
    for (const name of FIRST_NAMES) {
      const p = launchPrompt(name);
      assert.match(p, PROMPT_SAFE_RE);
      assert.doesNotMatch(p, /[;"%^&|<>!`\u0080-\uffff]/);
      assert.ok(p.includes(`.sibersentez/${name}`));
    }
    assert.equal(launchPrompt('ilk-mesaj.md'), "Please read .sibersentez/ilk-mesaj.md and follow it. Reply in the user's language.");
    for (const bad of ['x.md', '../a.md', 'ilk-mesaj.md; calc', '']) assert.throws(() => launchPrompt(bad), bad);
  });

  test('interactive start per tool: the prompt as argument or after -i / --prompt; no prompt, no argument; never a one-shot mode', () => {
    const p = launchPrompt('ilk-mesaj.md');
    const args = Object.fromEntries(TOOLS.map((x) => [x.id, toolArgs(x, p)]));
    assert.deepEqual(args, { claude: [p], codex: [p], gemini: ['-i', p], copilot: ['-i', p], cursor: [p], qwen: [p], opencode: ['--prompt', p] });
    for (const x of TOOLS) {
      assert.deepEqual(toolArgs(x, null), []);
      assert.ok(!toolArgs(x, p).some((a) => ['-p', 'exec', '--print', '--yolo', '--dangerously-skip-permissions'].includes(a)), x.id);
    }
  });

  test('paths in the launcher: %VAR% for the start (longest match), the rest plain ASCII; % " ! and non-ASCII letters are refused', () => {
    const env = { USERPROFILE: 'C:\\Users\\Şükrü Yılmaz', LOCALAPPDATA: 'C:\\Users\\Şükrü Yılmaz\\AppData\\Local', APPDATA: 'C:\\Users\\Şükrü Yılmaz\\AppData\\Roaming' };
    assert.deepEqual(batchPath('C:\\Users\\Şükrü Yılmaz\\.local\\bin\\claude.exe', env), { ok: true, expr: '%USERPROFILE%\\.local\\bin\\claude.exe' });
    assert.deepEqual(batchPath('c:\\users\\şükrü yılmaz\\appdata\\roaming\\npm\\gemini.cmd', env), { ok: true, expr: '%APPDATA%\\npm\\gemini.cmd' });
    assert.deepEqual(batchPath('D:\\Work\\my app (2)', env), { ok: true, expr: 'D:\\Work\\my app (2)' });
    for (const p of ['D:\\Oyun Çalışması', 'C:\\Users\\Şükrü Yılmaz\\Masaüstü\\x', 'D:\\a%PATH%', 'D:\\a!b', 'D:\\a"b', 'D:\\a^b', 'D:\\a&b', 'relative\\x', '\\\\server\\share']) assert.equal(batchPath(p, env).ok, false, p);
    assert.equal(batchPath('C:\\Users\\Şükrü Yılmazz\\x', env).ok, false, 'a longer name is not the same folder');
  });

  test('launcher text: ASCII, every line starts with @, the prompt quoted, .cmd through call; relative mode changes to the folder first', () => {
    const env = { USERPROFILE: 'C:\\Users\\Şükrü', APPDATA: 'C:\\Users\\Şükrü\\AppData\\Roaming' };
    const p = launchPrompt('ilk-mesaj.md');
    const a = launcherText({ toolName: 'Claude Code', file: 'C:\\Users\\Şükrü\\.local\\bin\\claude.exe', ext: '.exe', args: [p], env });
    assert.equal(a.ok, true);
    assert.equal(a.text.split('\r\n')[2], `@"%USERPROFILE%\\.local\\bin\\claude.exe" "${p}"`);
    assert.match(a.text, /^[\x20-\x7e\r\n]*$/);
    assert.ok(a.text.split('\r\n').filter(Boolean).every((l) => l.startsWith('@')));
    assert.doesNotMatch(a.text, /Şükrü|echo off/);
    const g = launcherText({ toolName: 'Gemini CLI', file: 'C:\\Users\\Şükrü\\AppData\\Roaming\\npm\\gemini.cmd', ext: '.cmd', args: ['-i', p], cdDir: 'C:\\Users\\Şükrü\\Desktop\\game', env });
    assert.deepEqual(g.text.split('\r\n').slice(2, 4), ['@cd /d "%USERPROFILE%\\Desktop\\game" || exit /b 1', `@call "%APPDATA%\\npm\\gemini.cmd" -i "${p}"`]);
    const none = launcherText({ toolName: 'Claude Code', file: 'C:\\t\\claude.exe', ext: '.exe', args: [], env });
    assert.equal(none.text.split('\r\n')[2], '@"C:\\t\\claude.exe"');
    // cmd looks a bare program name up in the working folder (the project) before PATH: an npm shim calls a bare
    // `node`, so a node.exe / node.bat / node.cmd in an untrusted project would run. The first line switches that off.
    for (const x of [a, g, none]) assert.equal(x.text.split('\r\n')[0], '@set NoDefaultCurrentDirectoryInExePath=1');
    assert.deepEqual(launcherText({ toolName: 'x', file: 'D:\\Araçlar\\claude.exe', ext: '.exe', args: [], env }), { ok: false, error: 'tool-path-unsafe' });
    assert.deepEqual(launcherText({ toolName: 'x', file: 'C:\\t\\claude.exe', ext: '.exe', args: [], cdDir: 'D:\\Oyun Çalışması', env }), { ok: false, error: 'folder-path-unsafe' });
    assert.equal(launcherText({ toolName: 'x', file: 'C:\\t\\claude.exe', ext: '.exe', args: ['a" & calc'], env }).ok, false, 'an argument that is not the fixed prompt');
  });

  test('launcher folder: a path wt can take as it is -> absolute; a space or a non-ASCII letter -> relative (wt -d that folder); ; " -> never', () => {
    const unsafe = (d) => /[;"]/.test(d);
    assert.deepEqual(pickLaunchDir(['C:\\Users\\u\\SiberSentez\\launch', 'C:\\Users\\u\\AppData\\Local\\SiberSentez\\launch'], unsafe), { ok: true, mode: 'absolute', dir: 'C:\\Users\\u\\SiberSentez\\launch' });
    assert.deepEqual(pickLaunchDir(['C:\\Users\\A B\\SiberSentez\\launch', 'D:\\ork\\launch'], unsafe), { ok: true, mode: 'absolute', dir: 'D:\\ork\\launch' }, 'the second candidate is safe');
    assert.deepEqual(pickLaunchDir(['C:\\Users\\Şükrü Y\\SiberSentez\\launch', 'C:\\Users\\Şükrü Y\\AppData\\Local\\SiberSentez\\launch'], unsafe), { ok: true, mode: 'relative', dir: 'C:\\Users\\Şükrü Y\\SiberSentez\\launch' });
    assert.deepEqual(pickLaunchDir(['C:\\a;b\\launch', 'C:\\c"d\\launch'], unsafe), { ok: false });
    assert.deepEqual(pickLaunchDir([], unsafe), { ok: false });
    for (const p of ['C:\\Users\\u\\SiberSentez\\launch', 'C:\\PROGRA~1\\x_y.z-1']) assert.match(p, SAFE_LAUNCH_RE);
    for (const p of ['C:\\Users\\A B\\x', 'C:\\Users\\Ş\\x', 'C:\\a&b', 'C:\\a%b', 'C:\\a(b)', '\\\\srv\\x']) assert.doesNotMatch(p, SAFE_LAUNCH_RE);
  });

  test('command lines: wt gets only cmd.exe and the launcher (never the tool, the prompt or the idea); the fallback likewise through start', () => {
    const base = { dir: 'D:\\Work\\my game', launchDir: 'C:\\Users\\u\\SiberSentez\\launch', launcher: 'abcdef012345.cmd', title: 'My game', cmdExe: 'C:\\Windows\\System32\\cmd.exe' };
    assert.deepEqual(buildAiArgv({ ...base, mode: 'absolute' }), ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', 'D:\\Work\\my game', '--title', 'My game', '--suppressApplicationTitle', 'C:\\Windows\\System32\\cmd.exe', '/d', '/v:off', '/k', 'C:\\Users\\u\\SiberSentez\\launch\\abcdef012345.cmd']);
    assert.deepEqual(buildAiArgv({ ...base, mode: 'relative' }).slice(4), ['-d', 'C:\\Users\\u\\SiberSentez\\launch', '--title', 'My game', '--suppressApplicationTitle', 'C:\\Windows\\System32\\cmd.exe', '/d', '/v:off', '/k', '.\\abcdef012345.cmd']);
    assert.deepEqual(buildAiFallbackArgv({ ...base, mode: 'absolute' }), ['C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'start', '', 'C:\\Windows\\System32\\cmd.exe', '/d', '/v:off', '/k', 'C:\\Users\\u\\SiberSentez\\launch\\abcdef012345.cmd']);
    assert.equal(buildAiFallbackArgv({ ...base, mode: 'relative' }).at(-1), '.\\abcdef012345.cmd');
    assert.match('abcdef012345.cmd', LAUNCHER_NAME_RE);
  });

  test('first message: UTF-8 with the idea quoted and plain steps (one question at a time, PLAN.md, idea-to-plan)', () => {
    const text = firstMessageText('Unity ile 2D oyun\nikinci satır');
    assert.ok(text.includes('> Unity ile 2D oyun\n> ikinci satır'));
    for (const w of ['one question at a time', 'numbered choices', 'recommend', 'Do not write or change code before', 'PLAN.md', 'idea-to-plan', 'language my idea is written in']) assert.ok(text.includes(w), w);
  });

  test("\"Do a job\" first message: the job quoted, the kit's team flow (orchestrate), two decisions, starter lines only with a yes", () => {
    const text = jobMessageText('Giriş sayfası ekle\nşifre sıfırlama da olsun');
    assert.ok(text.includes('> Giriş sayfası ekle\n> şifre sıfırlama da olsun'));
    for (const w of ['orchestrate skill', 'Plan, Build, Check and Finish', 'approve the plan before any code', 'approve the result', 'agent-rules', 'Add them only after I say yes', 'language the job is written in']) assert.ok(text.includes(w), w);
  });

  test('writing the first message: created with .sibersentez/.gitignore; the same text is left alone; another text is never overwritten (next name); a file or a junction in place of .sibersentez blocks', () => {
    const dir = mkdir('fm', 'one');
    const text = firstMessageText('idea one');
    assert.deepEqual(planFirstMessage(dir, text), { ok: true, folder: 'create', file: 'ilk-mesaj.md', op: 'create', gitignore: 'create' });
    assert.deepEqual(listTree(dir), [], 'planning writes nothing');
    assert.deepEqual(writeFirstMessage(dir, text), { ok: true, folder: 'create', file: 'ilk-mesaj.md', op: 'create', gitignore: 'create' });
    assert.equal(fs.readFileSync(path.join(dir, '.sibersentez', 'ilk-mesaj.md'), 'utf8'), text);
    assert.equal(fs.readFileSync(path.join(dir, '.sibersentez', '.gitignore'), 'utf8'), GITIGNORE_TEXT);
    const before = fs.statSync(path.join(dir, '.sibersentez', 'ilk-mesaj.md')).mtimeMs;
    assert.deepEqual(writeFirstMessage(dir, text), { ok: true, folder: 'keep', file: 'ilk-mesaj.md', op: 'same', gitignore: 'keep' });
    assert.equal(fs.statSync(path.join(dir, '.sibersentez', 'ilk-mesaj.md')).mtimeMs, before, 'the same text: untouched');
    // The person edited the file: a new idea goes next to it
    fs.writeFileSync(path.join(dir, '.sibersentez', 'ilk-mesaj.md'), 'my own notes');
    fs.writeFileSync(path.join(dir, '.sibersentez', '.gitignore'), 'custom\n');
    const two = firstMessageText('idea two');
    assert.deepEqual(planFirstMessage(dir, two), { ok: true, folder: 'keep', file: 'ilk-mesaj-2.md', op: 'create', gitignore: 'keep' });
    assert.deepEqual(writeFirstMessage(dir, two), { ok: true, folder: 'keep', file: 'ilk-mesaj-2.md', op: 'create', gitignore: 'keep' });
    assert.equal(fs.readFileSync(path.join(dir, '.sibersentez', 'ilk-mesaj.md'), 'utf8'), 'my own notes');
    assert.equal(fs.readFileSync(path.join(dir, '.sibersentez', '.gitignore'), 'utf8'), 'custom\n', 'the person\'s .gitignore stays');
    assert.equal(writeFirstMessage(dir, two).op, 'same', 'the same idea again finds its file');
    // Every name taken by other texts
    const full = mkdir('fm', 'full', '.sibersentez');
    for (const n of FIRST_NAMES) fs.writeFileSync(path.join(full, n), `other ${n}`);
    assert.deepEqual(writeFirstMessage(path.dirname(full), text), { ok: false, error: 'first-message-busy' });
    // .sibersentez is a file
    const file = mkdir('fm', 'file');
    touch(path.join(file, '.sibersentez'), 'x');
    assert.deepEqual(planFirstMessage(file, text), { ok: false, error: 'first-message-blocked' });
    assert.deepEqual(writeFirstMessage(file, text), { ok: false, error: 'first-message-blocked' });
  });

  test('writing the first message: never through a junction or a link', { skip: process.platform !== 'win32' && 'Windows junctions' }, () => {
    const dir = mkdir('fm', 'junction');
    const elsewhere = mkdir('fm', 'elsewhere');
    fs.symlinkSync(elsewhere, path.join(dir, '.sibersentez'), 'junction');
    assert.deepEqual(writeFirstMessage(dir, firstMessageText('x')), { ok: false, error: 'first-message-blocked' });
    assert.deepEqual(listTree(elsewhere), [], 'nothing written through the junction');
  });

  test('old launchers: only SiberSentez\'s names older than 24 hours are removed', () => {
    const dir = mkdir('launch-clean');
    const old = touch(path.join(dir, 'aaaaaaaaaaaa.cmd'), '@rem');
    const fresh = touch(path.join(dir, 'bbbbbbbbbbbb.cmd'), '@rem');
    const other = touch(path.join(dir, 'keep-me.cmd'), '@rem');
    const now = Date.now();
    fs.utimesSync(old, new Date(now - 25 * 3600 * 1000), new Date(now - 25 * 3600 * 1000));
    fs.utimesSync(other, new Date(now - 25 * 3600 * 1000), new Date(now - 25 * 3600 * 1000));
    assert.equal(cleanupLaunchers(dir, { now }), 1);
    assert.deepEqual(listTree(dir), ['bbbbbbbbbbbb.cmd', 'keep-me.cmd']);
    assert.ok(fs.existsSync(fresh));
    assert.equal(cleanupLaunchers(path.join(dir, 'missing')), 0);
  });
});

// ======================================================================= start-ai and GET /api/tools over HTTP
const HUB = mkdir('hub');
const WORK = mkdir('app');
const CMD = touch(path.join(ROOT, 'system32', 'cmd.exe'));
const TOOL_FILE = touch(path.join(ROOT, 'tools', 'claude.exe'));
const GEMINI_FILE = touch(path.join(ROOT, 'tools', 'npm', 'gemini.cmd'));
const DIR_IDEA = mkdir('projects', 'idea');
const DIR_PLAIN = mkdir('projects', 'plain');
const DIR_SEMI = mkdir('projects', 'semi;colon');
const DIR_HOME = mkdir('home');
const DIR_TR = mkdir('projects', 'oyun çalışması');
const AI_ENV = { USERPROFILE: ROOT, LOCALAPPDATA: path.join(ROOT, 'local') };

function catalog() {
  const projects = [
    { id: 'idea', name: 'Idea game', kind: 'registered', path: DIR_IDEA, idea: IDEA },
    { id: 'plain', name: 'Plain', kind: 'registered', path: DIR_PLAIN },
    { id: 'semi', name: 'Semi', kind: 'registered', path: DIR_SEMI },
    { id: 'x-home', name: 'Home', kind: 'adhoc', path: DIR_HOME, broad: true },
    { id: 'turkish', name: 'Oyun', kind: 'registered', path: DIR_TR, idea: 'oyun' },
  ];
  return { roster: new Map(), getProject: (id) => projects.find((p) => p.id === id) || null, allProjects: () => projects };
}
// S_LIVE: an open session (resume refuses it)
const S_LIVE = '0f0e0d0c-0b0a-4908-8706-050403020100';
const ingest = () => ({ sessions: new Map([[S_A, { id: S_A, cwd: DIR_IDEA, projectId: 'idea', live: null }], [S_LIVE, { id: S_LIVE, cwd: DIR_IDEA, projectId: 'idea', live: { status: 'busy' } }]]) });

// A detector stand-in: Claude Code (native, signed in) and Gemini (npm); detect() counts calls
function fakeDetector({ claude = true } = {}) {
  const d = {
    calls: [],
    detect: async (o = {}) => {
      d.calls.push(o);
      return {
        at: 5,
        tools: [
          { id: 'claude', name: 'Claude Code', installed: claude, chosen: claude ? { file: TOOL_FILE, ext: '.exe', extra: false } : null, installs: claude ? [{ file: TOOL_FILE, via: 'native', version: '2.1.284' }] : [], via: claude ? 'native' : null, version: claude ? '2.1.284' : null, ready: 'yes', app: false },
          { id: 'gemini', name: 'Gemini CLI', installed: true, chosen: { file: GEMINI_FILE, ext: '.cmd', extra: false }, installs: [{ file: GEMINI_FILE, via: 'npm', version: '0.52.0' }], via: 'npm', version: '0.52.0', ready: 'unknown', app: false },
          { id: 'codex', name: 'Codex CLI', installed: false, chosen: null, installs: [], via: null, version: null, ready: 'unknown', app: true },
        ],
        node: { installed: true, version: '24.18.0' },
      };
    },
  };
  return d;
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function startServer({ mode = 'dry', hubDir = HUB, detector = fakeDetector(), fail = () => null, launchDirs, env = AI_ENV, withActions = true } = {}) {
  const spawnCalls = [];
  const logs = [];
  let clock = Date.UTC(2026, 8, 29, 12, 0, 0);
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const actions = withActions
    ? createActions({ catalog: catalog(), ingest: ingest(), mode, port, hubDir, workDir: WORK, cmdExe: CMD, powershellExe: CMD, spawn: launchSpawn(spawnCalls, fail), now: () => clock, log: (l) => logs.push(l), ai: { tools: detector, env, ...(launchDirs ? { launchDirs } : {}) } })
    : null;
  server.on('request', createHandler({ ingest: ingest(), catalog: catalog(), clients: new Set(), port, publicDir: PUBLIC_DIR, actions, tools: detector }));
  const headers = { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-SiberSentez-Token': actions?.token || '' };
  return {
    port,
    actions,
    spawnCalls,
    logs,
    detector,
    tick: (ms) => (clock += ms),
    post: (body) => request(port, { method: 'POST', path: '/api/action', body, headers }),
    get: (p, h = { 'Sec-Fetch-Site': 'same-origin' }) => request(port, { path: p, headers: h }),
    close: () => new Promise((r) => server.close(r)),
  };
}

const ideaPieces = IDEA.split(/\s+/).filter((w) => w.length > 1);

describe('GET /api/tools', () => {
  test('read-only in every mode (Off included); no path, user name or e-mail; ?refresh=1 asks again; another site is refused', async () => {
    const env = await startServer({ withActions: false });
    try {
      const r = await env.get('/api/tools');
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.deepEqual(r.json.tools.map((x) => [x.id, x.installed, x.via, x.version, x.ready]), [
        ['claude', true, 'native', '2.1.284', 'yes'],
        ['gemini', true, 'npm', '0.52.0', 'unknown'],
        ['codex', false, null, null, 'unknown'],
      ]);
      assert.equal(r.json.tools[2].app, true);
      assert.doesNotMatch(r.text, /\\\\|[A-Za-z]:\\|ork-ai-|\.exe|\.cmd|@/, 'no path, no file name, no e-mail');
      assert.deepEqual(env.detector.calls.at(-1), { refresh: false });
      await env.get('/api/tools?refresh=1');
      assert.deepEqual(env.detector.calls.at(-1), { refresh: true });
      const cross = await env.get('/api/tools', { 'Sec-Fetch-Site': 'cross-site' });
      assert.equal(cross.status, 403);
      assert.equal(env.spawnCalls.length, 0);
    } finally {
      await env.close();
    }
  });

  test('a failing detection answers 500 detection-failed', async () => {
    const env = await startServer({ withActions: false, detector: { detect: async () => Promise.reject(new Error('boom C:\\Users\\x')) } });
    try {
      const r = await env.get('/api/tools');
      assert.deepEqual([r.status, r.json], [500, { ok: false, error: 'detection-failed' }]);
    } finally {
      await env.close();
    }
  });
});

describe('start-ai action', () => {
  test('resume: a closed Claude Code session continues through the same launcher (claude --resume <id>), no first message; only Claude, only a session, never an open one or with an idea', async () => {
    const env = await startServer({ mode: 'dry' });
    try {
      const r = await env.post({ action: 'start-ai', sessionId: S_A, tool: 'claude', resume: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.ok(r.json.launcher.text.includes(`claude.exe" --resume "${S_A}"`), r.json.launcher.text);
      assert.ok(!r.json.launcher.text.includes('ilk-mesaj'), 'no first message');
      assert.equal(r.json.firstMessage, null);
      const no = async (body, status, error) => {
        const x = await env.post({ action: 'start-ai', ...body });
        assert.deepEqual([x.status, x.json?.error], [status, error], JSON.stringify(body));
      };
      await no({ sessionId: S_A, tool: 'gemini', resume: true }, 400, 'resume-claude-only');
      await no({ projectId: 'idea', tool: 'claude', resume: true }, 400, 'bad-field');
      await no({ sessionId: S_A, tool: 'claude', resume: true, withIdea: true }, 400, 'bad-field');
      await no({ sessionId: S_A, tool: 'claude', resume: 'yes' }, 400, 'bad-field');
      await no({ sessionId: S_LIVE, tool: 'claude', resume: true }, 409, 'session-live');
      // "Do a job": a job never goes with an idea or a resume, and an empty one is refused
      await no({ projectId: 'idea', tool: 'claude', job: 'x', withIdea: true }, 400, 'bad-field');
      await no({ sessionId: S_A, tool: 'claude', job: 'x', resume: true }, 400, 'bad-field');
      await no({ projectId: 'idea', tool: 'claude', job: '   ' }, 400, 'bad-field');
      await no({ projectId: 'idea', tool: 'claude', job: 7 }, 400, 'bad-field');
      // A job: the first message is planned (preview: nothing written) and the tool is told to read it
      const j = await env.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', job: 'Giriş sayfası ekle' });
      assert.equal(j.status, 200, JSON.stringify(j.json));
      assert.match(j.json.jobId, JOB_ID_RE);
      assert.deepEqual(j.json.firstMessage, { file: `.sibersentez/${jobMessageName(j.json.jobId)}`, op: 'create', gitignore: 'create' });
      assert.ok(j.json.launcher.text.includes(`"${launchPrompt(jobMessageName(j.json.jobId))}"`));
      assert.equal(env.spawnCalls.length, 0);
    } finally {
      await env.close();
    }
  });

  test('preview: the plan only (argv, fallback, launcher text, the file it would write); nothing written, nothing started', async () => {
    const env = await startServer({ mode: 'dry' });
    const before = [listTree(DIR_IDEA), listTree(HUB)];
    try {
      const r = await env.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', withIdea: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.mode, 'dry');
      const launcher = path.join(HUB, 'launch', r.json.argv.at(-1).split('\\').pop());
      assert.deepEqual(r.json.argv.slice(0, 9), ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', DIR_IDEA, '--title', 'Idea game', '--suppressApplicationTitle']);
      assert.deepEqual(r.json.argv.slice(9), [CMD, '/d', '/v:off', '/k', launcher]);
      assert.match(path.basename(launcher), LAUNCHER_NAME_RE);
      assert.deepEqual(r.json.fallbackArgv, [CMD, '/d', '/c', 'start', '', CMD, '/d', '/v:off', '/k', launcher]);
      assert.equal(r.json.launcher.mode, 'absolute');
      assert.ok(r.json.launcher.text.includes(`"${launchPrompt('ilk-mesaj.md')}"`));
      assert.ok(r.json.launcher.text.includes('"%USERPROFILE%\\tools\\claude.exe"'), 'the tool by full path, through %USERPROFILE%');
      assert.deepEqual(r.json.firstMessage, { file: '.sibersentez/ilk-mesaj.md', op: 'create', gitignore: 'create' });
      assert.deepEqual(r.json.result, { executed: false, written: [] });
      assert.deepEqual([listTree(DIR_IDEA), listTree(HUB)], before, 'nothing written');
      assert.equal(env.spawnCalls.length, 0, 'nothing started');
    } finally {
      await env.close();
    }
  });

  test('in the dock: the launcher is written, nothing starts; a one-time id the shell redeems once, within two minutes', async () => {
    const env = await startServer({ mode: 'live' });
    try {
      const r = await env.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', withIdea: true, inDock: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.terminal, 'dock');
      assert.match(r.json.launchId, /^L[0-9a-f]{24}$/);
      assert.equal(env.spawnCalls.length, 0, 'nothing started by the server');
      assert.equal(r.json.result.executed, true);
      const launcher = r.json.argv.at(-1);
      const t1 = env.actions.terminalTarget({ launchId: r.json.launchId });
      assert.equal(t1.ok, true);
      assert.deepEqual([t1.program.file, ...t1.program.args], r.json.argv, 'the Command Prompt running the launcher');
      assert.deepEqual(t1.program.args.slice(0, 3), ['/d', '/v:off', '/k']);
      assert.equal(t1.projectId, 'idea');
      assert.deepEqual(env.actions.terminalTarget({ launchId: r.json.launchId }), { ok: false, reason: 'refused', status: 404 }, 'once');
      // Unredeemed: gone after two minutes, with its launcher file
      env.tick(4000); // past the repeat guard
      const r2 = await env.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', withIdea: false, inDock: true });
      assert.equal(r2.status, 200, JSON.stringify(r2.json));
      const file2 = path.isAbsolute(r2.json.argv.at(-1)) ? r2.json.argv.at(-1) : path.join(HUB, 'launch', r2.json.argv.at(-1).replace(/^\.\\/, ''));
      assert.ok(fs.existsSync(file2), 'the launcher waits');
      env.tick(121000);
      assert.equal(env.actions.terminalTarget({ launchId: r2.json.launchId }).ok, false, 'expired');
      assert.ok(!fs.existsSync(file2), 'and its launcher is removed');
      assert.equal(typeof launcher, 'string');
      assert.equal((await env.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', inDock: 'yes' })).status, 400, 'inDock is a boolean');
    } finally {
      await env.close();
    }
  });

  test('a preview asked before the mode turned On stays a preview (the mode is taken when the request is accepted)', async () => {
    // The detection is awaited; the mode changes while it runs (docs/actions-toggle.md §3.5)
    let release;
    const gate = new Promise((r) => (release = r));
    let asked;
    const detecting = new Promise((r) => (asked = r));
    const real = fakeDetector();
    const slow = Object.create(real);
    slow.detect = async (o) => {
      asked();
      await gate;
      return real.detect(o);
    };
    const env = await startServer({ mode: 'dry', detector: slow });
    const before = [listTree(DIR_IDEA), listTree(HUB)];
    try {
      const pending = env.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', withIdea: true });
      await detecting;
      assert.deepEqual(env.actions.setMode('live'), { changed: true, mode: 'live' });
      release();
      const r = await pending;
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.mode, 'dry');
      assert.deepEqual(r.json.result, { executed: false, written: [] });
      assert.deepEqual([listTree(DIR_IDEA), listTree(HUB)], before, 'nothing written');
      assert.equal(env.spawnCalls.length, 0, 'nothing started');
    } finally {
      await env.close();
    }
  });

  test('no user text on any command line or in the launcher: the idea (with ; " % & | < > ! and Turkish letters) never leaves the first-message file', async () => {
    const env = await startServer({ mode: 'live' });
    try {
      const r = await env.post({ action: 'start-ai', projectId: 'idea', tool: 'gemini', withIdea: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const call = env.spawnCalls[0];
      const launcher = fs.readFileSync(call.args.at(-1), 'ascii');
      for (const piece of ideaPieces) {
        assert.ok(!call.args.some((a) => a.includes(piece)), `argv holds "${piece}"`);
        assert.ok(!launcher.includes(piece), `launcher holds "${piece}"`);
      }
      assert.match(launcher, /^[\x20-\x7e\r\n]*$/, 'ASCII only');
      assert.ok(!call.args.slice(1).some((a) => /[;"\u0000-\u001f]/.test(a)), 'no separator or quote for Windows Terminal');
      assert.ok(fs.readFileSync(path.join(DIR_IDEA, '.sibersentez', 'ilk-mesaj.md'), 'utf8').includes(IDEA), 'the idea is in the file (UTF-8)');
      assert.ok(launcher.includes(`@call "%USERPROFILE%\\tools\\npm\\gemini.cmd" -i "${launchPrompt('ilk-mesaj.md')}"`));
      // The npm shim runs in the project folder: cmd must not look its bare `node` up there first
      assert.ok(launcher.startsWith('@set NoDefaultCurrentDirectoryInExePath=1\r\n'), 'the written launcher starts with the guard');
    } finally {
      await env.close();
      fs.rmSync(path.join(DIR_IDEA, '.sibersentez'), { recursive: true, force: true });
    }
  });

  test('live: writes .sibersentez/ilk-mesaj.md and .sibersentez/.gitignore (the only files in the project), the launcher in the hub, then starts Windows Terminal from the app folder', async () => {
    const hub = mkdir('hub-live');
    const env = await startServer({ mode: 'live', hubDir: hub });
    try {
      const r = await env.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', withIdea: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(r.json.result, { executed: true, written: ['.sibersentez/', '.sibersentez/.gitignore', '.sibersentez/ilk-mesaj.md'] });
      assert.equal(r.json.terminal, 'wt');
      assert.deepEqual(listTree(DIR_IDEA), ['.sibersentez', '.sibersentez/.gitignore', '.sibersentez/ilk-mesaj.md']);
      assert.equal(env.spawnCalls.length, 1);
      const { cmd, args, opts } = env.spawnCalls[0];
      assert.equal(cmd, 'wt.exe');
      assert.deepEqual([opts.shell, opts.detached, opts.stdio, opts.cwd], [false, true, 'ignore', WORK]);
      const launchers = fs.readdirSync(path.join(hub, 'launch'));
      assert.equal(launchers.length, 1);
      assert.equal(args.at(-1), path.join(hub, 'launch', launchers[0]));
      // The hub gets the launcher and a restore point of the project (docs/restore.md), nothing else
      assert.deepEqual(listTree(hub).filter((x) => !x.startsWith('restore')), ['launch', `launch/${launchers[0]}`], 'the hub gets the launcher and the point');
      assert.match(r.json.restorePoint.id, /^R\d{14}[0-9a-f]{4}$/);
      assert.equal(r.json.restorePoint.reused, false);
      assert.ok(listTree(hub).some((x) => x.endsWith(`/${r.json.restorePoint.id}/manifest.json`)), 'the point is in the hub');
      // The same idea again: the file is there with this text, nothing new is written in the project
      env.tick(5000);
      const again = await env.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', withIdea: true });
      assert.equal(again.status, 200);
      assert.deepEqual(again.json.firstMessage, { file: '.sibersentez/ilk-mesaj.md', op: 'same', gitignore: 'keep' });
      assert.deepEqual(again.json.result.written, []);
      // The person changed the file: the next start never overwrites it and names the new file in the prompt
      fs.writeFileSync(path.join(DIR_IDEA, '.sibersentez', 'ilk-mesaj.md'), 'edited by me');
      env.tick(5000);
      const third = await env.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', withIdea: true });
      assert.deepEqual(third.json.firstMessage, { file: '.sibersentez/ilk-mesaj-2.md', op: 'create', gitignore: 'keep' });
      assert.equal(fs.readFileSync(path.join(DIR_IDEA, '.sibersentez', 'ilk-mesaj.md'), 'utf8'), 'edited by me');
      assert.ok(fs.readFileSync(env.spawnCalls.at(-1).args.at(-1), 'ascii').includes('.sibersentez/ilk-mesaj-2.md'));
    } finally {
      await env.close();
      fs.rmSync(path.join(DIR_IDEA, '.sibersentez'), { recursive: true, force: true });
    }
  });

  test('without the idea (withIdea false or absent, or a project without one): no prompt, nothing written in the project', async () => {
    const env = await startServer({ mode: 'live' });
    try {
      for (const [body, label] of [
        [{ action: 'start-ai', projectId: 'idea', tool: 'claude', withIdea: false }, 'false'],
        [{ action: 'start-ai', projectId: 'idea', tool: 'gemini' }, 'absent'],
        [{ action: 'start-ai', projectId: 'plain', tool: 'claude', withIdea: true }, 'no idea'],
      ]) {
        env.tick(5000);
        const r = await env.post(body);
        assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.json)}`);
        assert.equal(r.json.firstMessage, null, label);
        const text = fs.readFileSync(env.spawnCalls.at(-1).args.at(-1), 'ascii');
        assert.doesNotMatch(text, /Please read/, label);
      }
      assert.deepEqual(listTree(DIR_IDEA), []);
      assert.deepEqual(listTree(DIR_PLAIN), []);
    } finally {
      await env.close();
    }
  });

  test('refusals: a tool that is not installed or unknown, other fields, a bad withIdea, a broad or unsafe folder, the same start twice in 3 s; nothing starts, nothing is written', async () => {
    const hub = mkdir('hub-refusals');
    const env = await startServer({ mode: 'live', hubDir: hub, detector: fakeDetector({ claude: false }) });
    try {
      const cases = [
        [{ action: 'start-ai', projectId: 'idea', tool: 'claude', withIdea: true }, 409, 'tool-missing'],
        [{ action: 'start-ai', projectId: 'idea', tool: 'codex' }, 409, 'tool-missing'],
        [{ action: 'start-ai', projectId: 'idea', tool: 'calc' }, 400, 'bad-tool'],
        [{ action: 'start-ai', projectId: 'idea', tool: 'claude"; calc' }, 400, 'bad-tool'],
        [{ action: 'start-ai', projectId: 'idea' }, 400, 'missing-field'],
        [{ action: 'start-ai', projectId: 'idea', tool: 'gemini', withIdea: 'yes' }, 400, 'bad-field'],
        [{ action: 'start-ai', projectId: 'idea', tool: 'gemini', prompt: 'rm -rf' }, 400, 'unexpected-field'],
        [{ action: 'start-ai', projectId: 'idea', tool: 'gemini', idea: 'x' }, 400, 'unexpected-field'],
        [{ action: 'start-ai', tool: 'gemini' }, 400, null],
        [{ action: 'start-ai', projectId: 'x-home', tool: 'gemini' }, 409, null],
        [{ action: 'start-ai', projectId: 'semi', tool: 'gemini' }, 409, null],
        [{ action: 'start-ai', projectId: 'nope', tool: 'gemini' }, 404, null],
      ];
      for (const [body, status, error] of cases) {
        env.tick(5000);
        const r = await env.post(body);
        assert.equal(r.status, status, JSON.stringify(body));
        if (error) assert.equal(r.json.error, error, JSON.stringify(body));
      }
      assert.equal(env.spawnCalls.length, 0);
      assert.deepEqual(listTree(DIR_IDEA), []);
      assert.deepEqual(listTree(hub), [], 'no launcher either');
      // Rate limit: the same tool on the same project within 3 s
      env.tick(5000);
      assert.equal((await env.post({ action: 'start-ai', projectId: 'plain', tool: 'gemini' })).status, 200);
      assert.equal((await env.post({ action: 'start-ai', projectId: 'plain', tool: 'gemini' })).status, 429);
      assert.equal((await env.post({ action: 'start-ai', projectId: 'plain', tool: 'terminal' })).status, 400, 'not a tool');
    } finally {
      await env.close();
    }
  });

  test('a session starts in its own folder with its project\'s idea', async () => {
    const env = await startServer({ mode: 'dry' });
    try {
      const r = await env.post({ action: 'start-ai', sessionId: S_A, tool: 'claude', withIdea: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.argv[5], DIR_IDEA);
      assert.equal(r.json.firstMessage.file, '.sibersentez/ilk-mesaj.md');
    } finally {
      await env.close();
    }
  });

  test('SiberSentez\'s folder with a space: relative mode (wt -d the launcher folder, the launcher changes to the project folder); ; in every candidate -> 409 launch-path-unsafe', async () => {
    const spaced = mkdir('hub with space');
    const env = await startServer({ mode: 'live', hubDir: spaced, env: { USERPROFILE: ROOT } });
    try {
      const r = await env.post({ action: 'start-ai', projectId: 'plain', tool: 'claude' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const { args, opts } = env.spawnCalls[0];
      assert.deepEqual(args.slice(3, 5), ['-d', path.join(spaced, 'launch')]);
      assert.ok(args.at(-1).startsWith('.\\'), 'the launcher as .\\<name> (found even with NoDefaultCurrentDirectoryInExePath)');
      assert.match(args.at(-1).slice(2), LAUNCHER_NAME_RE, 'the launcher by its own name');
      assert.equal(opts.cwd, WORK, 'wt itself still starts from the app folder');
      const text = fs.readFileSync(path.join(spaced, 'launch', args.at(-1)), 'ascii');
      assert.ok(text.includes('@cd /d "%USERPROFILE%\\projects\\plain" || exit /b 1'));
    } finally {
      await env.close();
    }
    const semi = mkdir('hub;semi');
    const bad = await startServer({ mode: 'live', hubDir: semi, env: {} });
    try {
      const r = await bad.post({ action: 'start-ai', projectId: 'plain', tool: 'claude' });
      assert.deepEqual([r.status, r.json.error], [409, 'launch-path-unsafe']);
      assert.equal(bad.spawnCalls.length, 0);
    } finally {
      await bad.close();
    }
    // Relative mode needs the project folder in plain ASCII inside the launcher
    const tr = await startServer({ mode: 'dry', hubDir: spaced, env: {} });
    try {
      const r = await tr.post({ action: 'start-ai', projectId: 'turkish', tool: 'claude' });
      assert.deepEqual([r.status, r.json.error], [409, 'folder-path-unsafe']);
    } finally {
      await tr.close();
    }
  });

  test('in SiberSentez\'s terminal a project folder with Turkish letters starts even in relative mode: the console opens in the project, cmd gets the launcher by its full path, no cd line; a launcher path cmd would expand stays on the old way', async () => {
    const spaced = mkdir('hub with space');
    const env = await startServer({ mode: 'live', hubDir: spaced, env: { USERPROFILE: ROOT } });
    try {
      const r = await env.post({ action: 'start-ai', projectId: 'turkish', tool: 'claude', inDock: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.terminal, 'dock');
      const t1 = env.actions.terminalTarget({ launchId: r.json.launchId });
      assert.equal(t1.ok, true);
      assert.equal(t1.dir, DIR_TR, 'the console starts in the project folder itself');
      assert.deepEqual(t1.program.args.slice(0, 3), ['/d', '/v:off', '/k']);
      const file = t1.program.args[3];
      assert.ok(path.isAbsolute(file) && file.startsWith(path.join(spaced, 'launch')), 'the launcher by its full path');
      assert.match(path.basename(file), LAUNCHER_NAME_RE);
      const text = fs.readFileSync(file, 'ascii');
      assert.ok(!text.includes('@cd /d'), 'no cd line: nothing has to be ASCII');
      assert.ok(/^[\x20-\x7e\r\n]*$/.test(text), 'the launcher stays ASCII');
    } finally {
      await env.close();
    }
    // A launcher folder with % (cmd would expand it on its command line): the old way, which needs ASCII
    const pct = mkdir('hub 100%');
    const old = await startServer({ mode: 'live', hubDir: pct, env: {} });
    try {
      const r = await old.post({ action: 'start-ai', projectId: 'turkish', tool: 'claude', inDock: true });
      assert.deepEqual([r.status, r.json.error], [409, 'folder-path-unsafe']);
    } finally {
      await old.close();
    }
  });

  test('no Windows Terminal: a Command Prompt window through start, in the project folder; nothing works -> 501 and the launcher is removed', async () => {
    const env = await startServer({ mode: 'live', fail: (cmd) => (cmd === 'wt.exe' ? 'ENOENT' : null) });
    try {
      const r = await env.post({ action: 'start-ai', projectId: 'plain', tool: 'claude' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual([r.json.terminal, r.json.fallbackReason], ['cmd', 'terminal-missing']);
      const fb = env.spawnCalls[1];
      assert.deepEqual(fb.args.slice(0, 8), ['/d', '/c', 'start', '', CMD, '/d', '/v:off', '/k']);
      assert.equal(fb.cmd, CMD);
      assert.equal(fb.opts.cwd, DIR_PLAIN);
      assert.equal(fb.opts.shell, false);
    } finally {
      await env.close();
    }
    const none = await startServer({ mode: 'live', hubDir: mkdir('hub-none'), fail: () => 'ENOENT' });
    try {
      const r = await none.post({ action: 'start-ai', projectId: 'plain', tool: 'claude' });
      assert.deepEqual([r.status, r.json.error], [501, 'no-terminal']);
      assert.deepEqual(fs.readdirSync(path.join(ROOT, 'hub-none', 'launch')), [], 'the launcher is removed');
    } finally {
      await none.close();
    }
  });

  test('off: the action does not exist (404); the log names the project id only', async () => {
    const off = await startServer({ mode: 'off' });
    try {
      const r = await off.post({ action: 'start-ai', projectId: 'idea', tool: 'claude' });
      assert.equal(r.status, 404);
    } finally {
      await off.close();
    }
    const env = await startServer({ mode: 'dry' });
    try {
      await env.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', withIdea: true });
      assert.equal(env.logs.length, 1);
      assert.match(env.logs[0], /^\[action\] \S+ start-ai idea 200 dry$/);
    } finally {
      await env.close();
    }
  });
});

// ======================================================================= the page
function inLanguages(fn) {
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      fn(lang, STRINGS[lang]);
    }
  } finally {
    setLanguage('en');
  }
}

const TOOLS_ANSWER = {
  ok: true,
  at: 1000,
  tools: [
    { id: 'claude', name: 'Claude Code', installed: true, version: '2.1.284', via: 'native', ready: 'yes', installs: 2, others: [{ via: 'npm', version: '2.1.193' }], onPath: true, app: false },
    { id: 'codex', name: 'Codex CLI', installed: false, version: null, via: null, ready: 'unknown', installs: 0, others: [], onPath: false, app: true },
    { id: 'gemini', name: 'Gemini CLI', installed: true, version: '0.52.0', via: 'npm', ready: 'unknown', installs: 1, others: [], onPath: true, app: false },
    { id: 'evil', name: '<img>', installed: true },
  ],
  node: { installed: true, version: '24.18.0' },
};
const answerFetch = (body = TOOLS_ANSWER, status = 200) => {
  const f = async (url) => {
    f.urls.push(url);
    return { ok: status === 200, status, json: async () => body };
  };
  f.urls = [];
  return f;
};

async function readyTools(body = TOOLS_ANSWER) {
  _resetToolsForTest({ fetch: answerFetch(body) });
  await loadTools();
  return toolsState();
}

describe('page: tools state', () => {
  test('never asked while the page loads; needTools asks only once switched on; the answer is kept to known tools and words', async () => {
    const f = answerFetch();
    _resetToolsForTest({ fetch: f });
    needTools();
    assert.equal(f.urls.length, 0, 'off until the drawer switched requests on');
    _resetToolsForTest({ fetch: f, autoLoad: true });
    needTools();
    assert.equal(toolsState().status, 'loading');
    await loadTools();
    assert.deepEqual(f.urls, ['/api/tools']);
    const st = toolsState();
    assert.equal(st.status, 'ready');
    assert.deepEqual(st.tools.map((x) => x.id), ['claude', 'codex', 'gemini'], 'unknown ids dropped, fixed order');
    assert.deepEqual(installedTools(st).map((x) => x.id), ['claude', 'gemini']);
    needTools(st.at + 1000);
    assert.equal(f.urls.length, 1, 'fresh: not asked again');
    await loadTools({ refresh: true });
    assert.deepEqual(f.urls.at(-1), '/api/tools?refresh=1');
    assert.deepEqual(normalizeTools({ tools: [{ id: 'claude', installed: true, version: 'C:\\x', via: 'hack' }] }).tools[0].version, null);
    _resetToolsForTest({ fetch: answerFetch({}, 500) });
    await loadTools();
    assert.equal(toolsState().status, 'error');
  });

  test('a listener that asks again on every change (the Today checklist) gets the running request: a five-minute-old answer never loops', async () => {
    // 0.7.2 on the owner's machine: setState ran before the request was kept, so the checklist's needTools started
    // another loadTools inside the first one, without end, once the answer was five minutes old
    const f = answerFetch();
    _resetToolsForTest({ fetch: f, autoLoad: true });
    await loadTools();
    let clock = toolsState().gotAt + 6 * 60 * 1000;
    let heard = 0;
    const errors = [];
    const origError = console.error;
    console.error = (e) => errors.push(e);
    try {
      onToolsChange(() => {
        heard++;
        needTools(clock);
      });
      needTools(clock);
      assert.equal(toolsState().checking, true, 'the new request is on');
      clock = Date.now();
      await loadTools();
      needTools(clock + 1000);
    } finally {
      console.error = origError;
    }
    assert.deepEqual(errors, [], 'no stack overflow caught by setState');
    assert.equal(f.urls.length, 2, 'one new request');
    assert.equal(heard, 2, 'checking, then the answer');
    _resetToolsForTest();
  });

  test('a failed refresh of a ready answer waits 30 s, whatever the status', async () => {
    let fail = false;
    const f = async (url) => {
      f.urls.push(url);
      return fail ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => TOOLS_ANSWER };
    };
    f.urls = [];
    _resetToolsForTest({ fetch: f, autoLoad: true });
    await loadTools();
    fail = true;
    const stale = toolsState().gotAt + 6 * 60 * 1000;
    needTools(stale);
    await loadTools();
    assert.equal(toolsState().status, 'ready', 'the old answer is kept');
    assert.equal(f.urls.length, 2);
    needTools(Date.now() + 1000);
    needTools(Date.now() + 5000);
    assert.equal(f.urls.length, 2, 'not asked again within 30 s');
    needTools(Date.now() + 31000);
    await loadTools();
    assert.equal(f.urls.length, 3, 'asked again after 30 s');
    _resetToolsForTest();
  });
});

describe('page: context menu', () => {
  const data = () => ({
    projects: new Map([
      ['idea', { id: 'idea', name: 'Idea game', kind: 'registered', path: 'D:\\w\\idea', exists: true, idea: 'a game' }],
      ['plain', { id: 'plain', name: 'Plain', kind: 'registered', path: 'D:\\w\\plain', exists: true }],
      ['home', { id: 'home', name: 'Home', kind: 'adhoc', path: 'C:\\Users\\x', exists: true, broad: true }],
    ]),
    sessions: new Map([[S_A, { id: S_A, projectId: 'idea', title: 'x', lastAt: 1, cwd: 'D:\\w\\idea', live: null }]]),
    agents: new Map(),
    roster: [],
  });
  const ids = (m) => m.filter((x) => !x.header && !x.sep).map((x) => x.id);

  test('the page keeps inDock and job in the request (dropping inDock sent every start to Windows Terminal; found by driving the app)', () => {
    assert.deepEqual(actionBody({ action: 'start-ai', projectId: 'idea', tool: 'claude', inDock: true, job: 'x' }), { action: 'start-ai', projectId: 'idea', tool: 'claude', job: 'x', inDock: true });
    assert.equal(actionBody({ action: 'start-ai', projectId: 'idea', tool: 'claude', inDock: 'yes' }).inDock, undefined, 'only true');
  });

  test('idle: no AI item (the menu asks when it opens); loading: one item that opens the drawer at "Then: start with AI"', () => {
    _resetToolsForTest();
    assert.deepEqual(ids(menuModel({ type: 'project', id: 'idea' }, data(), 'live')), ['terminal', 'resume', 'explorer', 'vscode', 'skills', 'copy-path', 'hide', 'open']);
    _resetToolsForTest({ fetch: () => new Promise(() => {}) });
    loadTools();
    const m = menuModel({ type: 'project', id: 'idea' }, data(), 'live');
    assert.deepEqual(ids(m).slice(0, 2), ['start-ai', 'terminal']);
    assert.deepEqual(m.find((x) => x.id === 'start-ai').open, { type: 'project', id: 'idea', section: 'terminal' });
  });

  test('ready: one item per installed tool before "Open terminal"; they send start-ai with ids, the tool and the idea choice only', async () => {
    await readyTools();
    inLanguages((lang, S) => {
      const m = menuModel({ type: 'project', id: 'idea' }, data(), 'live');
      assert.deepEqual(ids(m).slice(0, 3), ['start-ai:claude', 'start-ai:gemini', 'terminal'], lang);
      const c = m.find((x) => x.id === 'start-ai:claude');
      assert.equal(c.label, S.aiStartWith.replace('{tool}', 'Claude Code'));
      assert.equal(c.hint, S.aiMenuHintIdea);
      assert.deepEqual(c.payload, { projectId: 'idea', tool: 'claude', withIdea: true });
      assert.deepEqual(actionBody({ action: c.action, ...c.payload }), { action: 'start-ai', ...c.payload });
      const g = menuModel({ type: 'project', id: 'plain' }, data(), 'dry').find((x) => x.id === 'start-ai:gemini');
      assert.deepEqual(g.payload, { projectId: 'plain', tool: 'gemini', withIdea: false }, 'no idea: withIdea false');
      assert.equal(g.hint, S.aiMenuHintLogin, 'sign-in unknown: it asks the first time');
      const s = menuModel({ type: 'session', id: S_A }, data(), 'live');
      assert.deepEqual(ids(s).slice(0, 4), ['resume', 'start-ai:claude', 'start-ai:gemini', 'terminal']);
      assert.deepEqual(s.find((x) => x.id === 'start-ai:claude').payload, { sessionId: S_A, tool: 'claude', withIdea: true });
    });
    setIdeaPref('idea', false);
    assert.equal(ideaPref('idea'), false);
    assert.equal(menuModel({ type: 'project', id: 'idea' }, data(), 'live').find((x) => x.id === 'start-ai:claude').payload.withIdea, false, 'the choice switched off');
    for (const mode of ['off']) assert.deepEqual(ids(menuModel({ type: 'project', id: 'idea' }, data(), mode)), ['copy-path', 'hide', 'open']);
    assert.ok(!ids(menuModel({ type: 'project', id: 'home' }, data(), 'live')).some((x) => x.startsWith('start-ai')), 'broad folder');
  });

  test('ready but nothing installed: one item that opens the drawer (where "Install an AI tool" is)', async () => {
    await readyTools({ ...TOOLS_ANSWER, tools: [{ id: 'codex', installed: false }] });
    const it = aiStartMenuItems({ projectId: 'plain' }, { projectId: 'plain' });
    assert.equal(it.length, 1);
    assert.deepEqual([it[0].id, it[0].action, it[0].hint], ['start-ai', undefined, STRINGS.en.aiMenuNoneHint]);
    assert.deepEqual(aiStartMenuItems({ sessionId: S_A }, { projectId: null }), [], 'no project to open');
  });

  test('notices: preview, opened (with the first-message file and the Command Prompt fallback), errors by code with what was written', () => {
    const item = { action: 'start-ai', toolName: 'Claude Code', name: 'Idea game', payload: { tool: 'claude' } };
    inLanguages((lang, S) => {
      const dry = resultToast('x', { ok: true, mode: 'dry', action: 'start-ai', tool: 'claude', argv: ['wt.exe', '-w', 'sibersentez'], firstMessage: { file: '.sibersentez/ilk-mesaj.md', op: 'create' } }, item);
      assert.equal(dry.tone, 'dry');
      assert.equal(dry.title, S.aiToastDryTitle.replace('{tool}', 'Claude Code'));
      assert.equal(dry.code, 'wt.exe -w sibersentez');
      const ok = resultToast('x', { ok: true, mode: 'live', action: 'start-ai', tool: 'claude', terminal: 'cmd', firstMessage: { file: '.sibersentez/ilk-mesaj.md', op: 'create' } }, item);
      assert.equal(ok.title, S.aiToastOpened.replace('{tool}', 'Claude Code').replace('{name}', 'Idea game'));
      assert.ok(ok.body.includes(S.aiToastFirstCreate.replace('{file}', '.sibersentez/ilk-mesaj.md')));
      assert.ok(ok.body.includes(S.aiToastFallback));
      const err = resultToast('x', { ok: false, status: 409, error: 'tool-missing', action: 'start-ai' }, item);
      assert.deepEqual([err.tone, err.body], ['err', S['aiErr_tool-missing']]);
      const w = aiStartToast({ ok: false, status: 500, error: 'launch-failed', written: ['.sibersentez/ilk-mesaj.md'] }, item, errorText);
      assert.ok(w.body.includes('.sibersentez/ilk-mesaj.md'));
      const general = aiStartToast({ ok: false, status: 404, error: 'project-not-found' }, item, errorText);
      assert.equal(general.body, STRINGS[lang]['err_project-not-found'], 'a validation text of the terminal checks');
    });
  });

  test('every error code the server can answer has a text in both languages', () => {
    const src = fs.readFileSync(new URL('../server/actions.mjs', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('function validateAiStart'), src.indexOf('async function execute('));
    const launch = fs.readFileSync(new URL('../server/launch.mjs', import.meta.url), 'utf8');
    // Codes: fail(<status>, '<code>' ...), reject(<status>, '<code>') and error: '<code>' in the helpers
    const text = `${block}\n${launch}`;
    const codes = new Set([...text.matchAll(/(?:fail|reject)\(\d+, '([a-z-]+)'|error: '([a-z-]+)'/g)].map((m) => m[1] || m[2]));
    const malformed = ['unexpected-field', 'missing-field', 'bad-field'];
    const own = [...codes].filter((c) => !malformed.includes(c));
    assert.ok(own.length >= 11, own.join(','));
    for (const c of own) {
      for (const lang of ['en', 'tr']) {
        const has = STRINGS[lang][`aiErr_${c}`] || STRINGS[lang][`termErr_${c}`];
        assert.ok(has, `${lang}: ${c}`);
      }
    }
    for (const c of malformed) assert.equal(aiStartToast({ ok: false, status: 400, error: c }, null, errorText).body, STRINGS.en.skErr_malformed);
  });
});

describe('page: drawer section, tools panel, start card', () => {
  const p = { id: 'x-game', name: 'Game', path: 'C:\\w\\game', exists: true, kind: 'adhoc', idea: 'a 2D game' };

  test('"Then: start with AI": one button per tool (the menu\'s start-ai items), the idea choice when the project has an idea, sign-in notes, the plain terminal', async () => {
    const st = await readyTools();
    inLanguages((lang, S) => {
      const h = aiStartSectionHtml(p, { mode: 'live', tools: st, withIdea: true });
      assert.ok(h.includes('data-menu-act="start-ai:claude" data-menu-type="project" data-menu-id="x-game"'));
      assert.ok(h.includes('data-menu-act="start-ai:gemini"'));
      assert.ok(!h.includes('start-ai:codex'), 'not installed: no button');
      assert.ok(h.includes('data-menu-act="terminal" data-menu-type="project" data-menu-id="x-game"'));
      assert.ok(h.includes(S.aiPlainTerminal) && h.includes(S.aiStartTitle));
      assert.match(h, /<input type="checkbox" data-ai-idea="x-game" data-fk="ai:idea" checked>/);
      assert.ok(h.includes(S.aiLoginNote.replace('{tool}', 'Gemini CLI')), `${lang}: Gemini asks to sign in`);
      assert.ok(!h.includes(S.aiLoginNote.replace('{tool}', 'Claude Code')), 'Claude Code is signed in');
      assert.doesNotMatch(h, /aria-disabled/);
      assert.doesNotMatch(aiStartSectionHtml(p, { mode: 'live', tools: st, withIdea: false }), /data-ai-idea="x-game"[^>]*checked/);
      assert.doesNotMatch(aiStartSectionHtml({ ...p, idea: null }, { mode: 'live', tools: st }), /data-ai-idea/, 'no idea: no choice');
      const off = aiStartSectionHtml(p, { mode: 'off', tools: st });
      assert.equal((off.match(/aria-disabled="true"/g) || []).length, 3, 'off: every start button disabled');
    });
  });

  test('looking, failed, or nothing installed: said plainly; "Install an AI tool" opens the tools panel', async () => {
    _resetToolsForTest();
    inLanguages((lang, S) => {
      assert.ok(startNextHtml(p, null, 'live').includes(S.aiLoading), lang);
    });
    const none = await readyTools({ ...TOOLS_ANSWER, tools: [{ id: 'claude', installed: false }] });
    inLanguages((lang, S) => {
      const h = aiStartSectionHtml(p, { mode: 'live', tools: none });
      assert.ok(h.includes(S.aiNone));
      assert.ok(h.includes(`data-ai-act="tools" data-fk="ai:install"`));
      assert.ok(h.includes(S.aiInstallOne));
      assert.ok(!h.includes('data-ai-idea'));
    });
    _resetToolsForTest({ fetch: answerFetch({}, 500) });
    await loadTools();
    assert.ok(aiStartSectionHtml(p, { mode: 'live', tools: toolsState() }).includes(STRINGS.en.aiLoadFailed));
  });

  test('tools panel: installed first with version, kind and sign-in; several installs warned; the rest with the official commands, a copy button, the account and Node.js', async () => {
    const st = await readyTools();
    inLanguages((lang, S) => {
      const h = toolsPanelHtml(st, 2000);
      const order = [...h.matchAll(/data-ai-tool="([a-z]+)"/g)].map((m) => m[1]);
      assert.deepEqual(order, ['claude', 'gemini', 'codex', 'copilot', 'cursor', 'qwen', 'opencode']);
      assert.ok(h.includes(S.aiMulti.replace('{count}', '2').replace('{first}', `${S.aiVia_native} 2.1.284`).replace('{others}', `${S.aiVia_npm} 2.1.193`)), lang);
      assert.ok(h.includes(S.aiCodexApp));
      for (const id of ['codex', 'copilot', 'cursor', 'qwen', 'opencode']) {
        for (const c of TOOL_INFO[id].install) assert.ok(h.includes(c.cmd.replace(/'/g, '&#39;').replace(/"/g, '&quot;')), `${id}: ${c.cmd}`);
        assert.ok(h.includes(S[`aiAcct_${id}`].replace(/'/g, '&#39;')), id);
      }
      assert.ok(!/data-ai-tool="claude"[^]*?irm https:\/\/claude\.ai/.test(h.split('data-ai-tool="gemini"')[0]), 'an installed tool shows no install command');
      const cards = h.slice(h.indexOf('class="ai-cards"'), h.indexOf('class="sc-err"'));
      assert.equal((cards.match(/data-ai-copy/g) || []).length, 7, 'a copy button per install command');
      assert.ok(h.includes(S.aiNeedsNode.replace('{state}', S.aiNodeHave.replace('{version}', 'Node.js 24.18.0'))));
      assert.ok(h.includes(S.aiFirstRun));
      assert.ok(h.includes('https://code.claude.com/docs/en/setup') === false, 'Claude Code is installed: no install guide link');
      assert.ok(h.includes('rel="noopener noreferrer"'));
    });
    assert.ok(toolsPanelHtml({ status: 'loading', tools: [] }).includes(STRINGS.en.aiLoading));
  });

  test('start card: step 3 is "Pick an AI tool; SiberSentez starts it with your idea" and the card opens the tools panel', () => {
    inLanguages((lang, S) => {
      const h = startCardHtml();
      assert.ok(h.includes(S.aiStartCardStep3), lang);
      assert.ok(!h.includes(S.startCardStep3), 'the old third step is gone');
      assert.ok(h.includes('data-start-act="tools"') && h.includes(S.aiStartCardTools));
    });
    assert.equal(STRINGS.tr.aiStartCardStep3, 'Yapay zekâ aracını seç, SiberSentez fikrinle başlatsın');
  });
});

test('the start notice warns first when no restore point could be taken, and stays until closed', async () => {
  const { aiStartToast } = await import('../public/js/views/tools.js');
  const { STRINGS } = await import('../public/js/i18n.js');
  const item = { toolName: 'Claude Code', name: 'Notlar', payload: { projectId: 'p1', tool: 'claude' } };
  const ok = aiStartToast({ ok: true, mode: 'live', terminal: 'dock', restorePoint: { id: 'R1', reused: false } }, item);
  assert.equal(ok.tone, 'ok');
  assert.doesNotMatch(ok.body, /restore point/i);
  for (const problem of ['too-large', 'file-too-large', 'too-many-files', 'too-deep', 'copy-failed']) {
    const w = aiStartToast({ ok: true, mode: 'live', terminal: 'dock', restorePoint: { problem } }, item);
    assert.equal(w.tone, 'warn', problem);
    const why = STRINGS.en[`aiNoPoint_${problem}`] || STRINGS.en.aiNoPoint_other;
    assert.ok(w.body.startsWith(STRINGS.en.aiToastNoPoint.replace('{why}', why)), problem);
  }
  for (const k of ['aiToastNoPoint', 'aiNoPoint_too-large', 'aiNoPoint_file-too-large', 'aiNoPoint_too-many-files', 'aiNoPoint_too-deep', 'aiNoPoint_other']) assert.ok(STRINGS.tr[k], `tr ${k}`);
  const toasts = fs.readFileSync(new URL('../public/js/toasts.js', import.meta.url), 'utf8');
  assert.match(toasts, /sticky: tone === 'err' \|\| tone === 'warn'/);
});

test('notices show above the terminal dock that a start opens (they were hidden behind it)', () => {
  const css = ['app.css', 'terminal-dock.css', 'studio-pro.css', 'polish.css'].map((f) => fs.readFileSync(new URL(`../public/css/${f}`, import.meta.url), 'utf8')).join('\n');
  // The highest z-index of the rules whose selector is exactly sel
  const z = (sel) =>
    Math.max(
      ...css
        .split('}')
        .map((rule) => rule.split('{'))
        .filter(([selector, body]) => body && selector.replace(/\/\*[^]*?\*\//g, '').split(',').some((s) => s.trim() === sel))
        .map(([, body]) => Number((/z-index:\s*(\d+)/.exec(body) || [])[1]))
        .filter(Number.isFinite),
    );
  assert.ok(z('.toasts') > z('.term-dock'), `toasts ${z('.toasts')} > dock ${z('.term-dock')}`);
  assert.ok(z('.toasts') < z('.palette-wrap'), 'under the command palette');
});

test('a job starts Claude Code in plan mode (it asks the person to approve its plan itself); other tools and resumes as before', async () => {
  const { jobArgs } = await import('../server/launch.mjs');
  const claude = TOOLS.find((x) => x.id === 'claude');
  const gemini = TOOLS.find((x) => x.id === 'gemini');
  assert.deepEqual(jobArgs(claude), ['--permission-mode', 'plan']);
  assert.deepEqual(jobArgs(gemini), []);
  assert.ok(!jobArgs(claude).some((a) => /bypass|dangerously|dontAsk/i.test(a)), 'never a mode that skips the person');
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' };
  const lt = launcherText({ toolName: 'Claude Code', file: 'C:\\t\\claude.exe', ext: '.exe', args: [...jobArgs(claude), 'Read the job file'], env });
  assert.ok(lt.ok, 'the launcher takes the flag');
  assert.match(lt.text, /claude\.exe" --permission-mode "plan" "Read the job file"/);
  const actions = fs.readFileSync(new URL('../server/actions.mjs', import.meta.url), 'utf8');
  assert.ok(actions.includes("args: ctx.resume ? ['--resume', ctx.sessionId] : [...(ctx.job ? jobArgs(tool) : []), ...toolArgs(tool, file ? launchPrompt(file) : null)]"), 'only a job, never a resume');
});

test('live jobs get unique persistent ids; more than nine jobs work; preview and resume preserve identity', async () => {
  const live = await startServer({ mode: 'live' });
  const dry = await startServer({ mode: 'dry' });
  const folder = path.join(DIR_IDEA, '.sibersentez');
  try {
    const ids = new Set();
    let latest;
    for (let i = 0; i < 11; i++) {
      live.tick(5000);
      const r = await live.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', job: 'Add a page' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      latest = r.json.jobId;
      assert.match(latest, JOB_ID_RE);
      assert.ok(!ids.has(latest));
      ids.add(latest);
      assert.equal(readCurrentJob(folder).jobId, latest);
      assert.ok(fs.readFileSync(path.join(DIR_IDEA, r.json.firstMessage.file), 'utf8').includes(`Job-ID: ${latest}`));
      assert.ok(r.json.result.written.includes('.sibersentez/current-job.json'));
      assert.equal(projectTeam({ catalog: catalog(), projectId: 'idea' }).body.step, 'plan');
    }
    const before = listTree(DIR_IDEA);
    const preview = await dry.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', job: 'New preview' });
    assert.equal(preview.status, 200);
    assert.deepEqual(listTree(DIR_IDEA), before);
    assert.equal(readCurrentJob(folder).jobId, latest);
    live.tick(5000);
    const resumed = await live.post({ action: 'start-ai', sessionId: S_A, tool: 'claude', resume: true });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.json.jobId, undefined);
    assert.equal(readCurrentJob(folder).jobId, latest);
    assert.deepEqual(listTree(DIR_IDEA), before);
    const marker = path.join(folder, 'current-job.json');
    fs.writeFileSync(marker, 'user notes');
    live.tick(5000);
    const started = live.spawnCalls.length;
    const blocked = await live.post({ action: 'start-ai', projectId: 'idea', tool: 'claude', job: 'Another job' });
    assert.equal(blocked.status, 409);
    assert.equal(live.spawnCalls.length, started);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'user notes');
  } finally {
    await live.close();
    await dry.close();
  }
});
