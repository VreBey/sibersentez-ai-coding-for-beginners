// Embedded terminals (docs/embedded-terminal.md): the manager over a fake pty, the quit question, the preload's
// window.sibersentezTerminal, the server's terminal-target (the terminal action's checks, live only) and the shell's wiring.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createTerminals, createChunkBuffer, createOutputBatcher, termOpenRequest, terminalEnv, terminalProgram, confirmQuitWithTerminals, avoidForkOnKill, taskkillTree, TERMINAL_IPC, MAX_TERMINALS, MAX_BUFFER, MAX_WRITE, QUIT_CONFIRM_OK, ENDED_SUFFIX, TOOL_CHECK_MS } from '../electron/terminals.mjs';
import { createActions } from '../server/actions.mjs';
import { rendererReloadPlan } from '../electron/helpers.mjs';
import { createProjectChannel } from '../server/memory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-term-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function fakePty() {
  const calls = [];
  const ptys = [];
  const spawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const p = { written: [], sizes: [], killed: false, data: null, exit: null };
    p.onData = (cb) => (p.data = cb);
    p.onExit = (cb) => (p.exit = cb);
    p.write = (s) => p.written.push(s);
    p.resize = (c, r) => p.sizes.push([c, r]);
    p.kill = () => (p.killed = true);
    ptys.push(p);
    return p;
  };
  return { spawn, calls, ptys };
}

describe('manager', () => {
  test('open: the fixed program in the given folder, the size, an id; output to the window and into the buffer', () => {
    const f = fakePty();
    const sent = [];
    const m = createTerminals({ spawn: f.spawn, send: (...a) => sent.push(a), env: { PATH: 'p', ELECTRON_RUN_AS_NODE: '1', SIBERSENTEZ_PORT: '1', NODE_OPTIONS: '--x', Other: 'o' }, now: () => 5 });
    const r = m.open({ dir: 'C:\\p', title: 'Project', projectId: 'p1', cols: 120, rows: 40 });
    assert.deepEqual(r, { ok: true, id: 't1', title: 'Project', projectId: 'p1', ai: false, tool: null, jobId: null });
    const call = f.calls[0];
    assert.equal(call.file, terminalProgram().file);
    assert.match(call.file, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.deepEqual(call.args, ['-NoLogo']);
    assert.equal(call.opts.cwd, 'C:\\p');
    assert.deepEqual([call.opts.cols, call.opts.rows], [120, 40]);
    assert.deepEqual(Object.keys(call.opts.env).sort(), ['COLORTERM', 'Other', 'PATH'], 'no ELECTRON_*, SIBERSENTEZ_* or NODE_OPTIONS');
    f.ptys[0].data('hello');
    assert.deepEqual(sent.at(-1), [TERMINAL_IPC.data, 't1', 'hello']);
    assert.deepEqual(m.list(), [{ id: 't1', title: 'Project', projectId: 'p1', startedAt: 5, buffer: 'hello', ai: false, tool: null, jobId: null, toolEnded: false }]);
    f.ptys[0].data('x'.repeat(MAX_BUFFER));
    assert.equal(m.list()[0].buffer.length, MAX_BUFFER, 'the buffer keeps the newest part');
  });

  test('lifecycle: an AI start keeps its tool and job; opening, exiting and closing tell the server; a plain shell carries neither', () => {
    const f = fakePty();
    const changes = [];
    const m = createTerminals({ spawn: f.spawn, onChange: (ended) => changes.push({ ended, running: m.sessions().map((x) => x.id) }), now: () => 7 });
    const job = 'J' + 'c'.repeat(32);
    const launch = { file: String.raw`C:\Windows\System32\cmd.exe`, args: ['/d', '/c', 'x.cmd'] };
    const a = m.open({ dir: String.raw`C:\p`, title: 'Codex', projectId: 'p1', launch, tool: 'codex', jobId: job });
    assert.equal(a.tool, 'codex');
    assert.deepEqual(m.sessions(), [{ id: 't1', projectId: 'p1', ai: true, tool: 'codex', jobId: job, startedAt: 7, running: true }]);
    assert.deepEqual(changes.at(-1), { ended: null, running: ['t1'] });
    // A plain shell never carries a tool or a job, whatever is passed; an unknown id shape is dropped
    const b = m.open({ dir: String.raw`C:\p`, title: 'Shell', projectId: 'p1', tool: 'codex', jobId: job });
    assert.deepEqual([b.ai, b.tool, m.sessions()[1].jobId], [false, null, null]);
    const c = m.open({ dir: String.raw`C:\p`, title: 'Odd', projectId: 'p1', launch, tool: '../x', jobId: 'bad' });
    assert.deepEqual([c.tool, m.sessions()[2].jobId], [null, null]);
    f.ptys[0].exit({ exitCode: 3 });
    assert.deepEqual(changes.at(-1), { ended: { id: 't1', projectId: 'p1', tool: 'codex', jobId: job, ai: true, exitCode: 3 }, running: ['t2', 't3'] });
    m.close('t2');
    assert.deepEqual(changes.at(-1).ended, { id: 't2', projectId: 'p1', tool: null, jobId: null, ai: false, exitCode: null });
    // A failing listener never breaks a terminal
    const n = createTerminals({ spawn: fakePty().spawn, onChange: () => { throw new Error('x'); } });
    assert.equal(n.open({ dir: String.raw`C:\p`, title: 'T' }).ok, true);
  });

  test('write, resize, close only for a known id and within limits; exit tells the window once', () => {
    const f = fakePty();
    const sent = [];
    const m = createTerminals({ spawn: f.spawn, send: (...a) => sent.push(a) });
    m.open({ dir: 'C:\\p' });
    assert.equal(m.write('t1', 'dir\r'), true);
    assert.equal(m.write('t2', 'x'), false, 'unknown id');
    assert.equal(m.write('t1', ''), false);
    assert.equal(m.write('t1', 'x'.repeat(MAX_WRITE + 1)), false);
    assert.equal(m.write('t1', { toString: () => 'x' }), false);
    assert.equal(m.write('../t1', 'x'), false);
    assert.deepEqual(f.ptys[0].written, ['dir\r']);
    assert.equal(m.resize('t1', 80, 24), true);
    for (const [c, r] of [[1, 24], [80, 1], [501, 24], [80, 201], [80.5, 24], ['80', 24]]) assert.equal(m.resize('t1', c, r), false, `${c}x${r}`);
    assert.deepEqual(f.ptys[0].sizes, [[80, 24]]);
    f.ptys[0].exit({ exitCode: 3 });
    assert.deepEqual(sent.at(-1), [TERMINAL_IPC.exit, 't1', 3]);
    assert.equal(m.count(), 0);
    f.ptys[0].exit({ exitCode: 3 });
    assert.equal(sent.filter((s) => s[0] === TERMINAL_IPC.exit).length, 1, 'once');
    m.open({ dir: 'C:\\p' });
    assert.equal(m.close('t2'), true);
    assert.equal(f.ptys[1].killed, true);
    assert.equal(m.close('t2'), false);
  });

  test('at most eight; a spawn that throws is refused; no folder, no terminal; closeAll', () => {
    const f = fakePty();
    const m = createTerminals({ spawn: f.spawn });
    for (let i = 0; i < MAX_TERMINALS; i++) assert.equal(m.open({ dir: 'C:\\p' }).ok, true);
    assert.deepEqual(m.open({ dir: 'C:\\p' }), { ok: false, reason: 'too-many' });
    m.closeAll();
    assert.equal(m.count(), 0);
    assert.ok(f.ptys.every((p) => p.killed));
    assert.deepEqual(createTerminals({ spawn: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }).open({ dir: 'C:\\p' }), { ok: false, reason: 'spawn-failed' });
    assert.deepEqual(m.open({ dir: '' }), { ok: false, reason: 'no-folder' });
  });

  test('what the page may ask to open: one project id or one session id, nothing else', () => {
    assert.deepEqual(termOpenRequest({ projectId: 'alpha' }), { ok: true, target: { projectId: 'alpha' } });
    assert.deepEqual(termOpenRequest({ sessionId: '11111111-2222-3333-4444-555555555555' }), { ok: true, target: { sessionId: '11111111-2222-3333-4444-555555555555' } });
    for (const bad of [null, [], {}, { projectId: 'a', sessionId: '11111111-2222-3333-4444-555555555555' }, { projectId: '../x' }, { projectId: 'a', dir: 'C:\\' }, { sessionId: 'x' }, { projectId: 1 }]) {
      assert.equal(termOpenRequest(bad).ok, false, JSON.stringify(bad));
    }
    assert.deepEqual(terminalEnv({ a: 'b', n: 1 }), { a: 'b', COLORTERM: 'truecolor' });
    // SiberSentez started from inside a Claude Code session: the dock's Claude Code must not take itself for its child
    // (it stopped saving transcripts); the person's own settings stay, GIT_EDITOR only when the session set it
    const inherited = terminalEnv({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_PID: '9', AI_AGENT: 'claude-code', GIT_EDITOR: 'true', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe', ANTHROPIC_API_KEY: 'k', Path: 'C:\\x' });
    assert.deepEqual(inherited, { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe', ANTHROPIC_API_KEY: 'k', Path: 'C:\\x', COLORTERM: 'truecolor' });
    assert.equal(terminalEnv({ GIT_EDITOR: 'true' }).GIT_EDITOR, 'true');
    assert.equal(terminalEnv({ CLAUDECODE: '1', GIT_EDITOR: 'code --wait' }).GIT_EDITOR, 'code --wait');
    // A start-ai in the dock: its one-time id alone
    const L = 'L' + 'a'.repeat(24);
    assert.deepEqual(termOpenRequest({ launchId: L }), { ok: true, target: { launchId: L } });
    for (const bad of [{ launchId: 'L123' }, { launchId: L, projectId: 'a' }, { launchId: L.toUpperCase() }]) assert.equal(termOpenRequest(bad).ok, false, JSON.stringify(bad));
    // The setup terminal (installing an AI tool): exactly { setup: true }
    assert.deepEqual(termOpenRequest({ setup: true }), { ok: true, target: { setup: true } });
    for (const bad of [{ setup: 1 }, { setup: 'true' }, { setup: true, projectId: 'a' }, { setup: false }]) assert.equal(termOpenRequest(bad).ok, false, JSON.stringify(bad));
  });

  test('a start-ai terminal runs the program the server answered, else the fixed shell', () => {
    const f = fakePty();
    const m = createTerminals({ spawn: f.spawn });
    assert.equal(m.open({ dir: 'C:\\p', launch: { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/v:off', '/k', 'x.cmd'] } }).ai, true, 'the page knows an AI runs in it');
    assert.deepEqual([f.calls[0].file, ...f.calls[0].args], ['C:\\Windows\\System32\\cmd.exe', '/d', '/v:off', '/k', 'x.cmd']);
    assert.equal(m.open({ dir: 'C:\\p', launch: { file: 'x', args: [1] } }).ai, false);
    assert.equal(f.calls[1].file, terminalProgram().file, 'a malformed program falls back to the shell');
  });

  test('quitting with terminals asks; Cancel, a failing dialog and nothing running decide as expected; QA never asks', async () => {
    const S = { termQuitYes: 'Y', termQuitNo: 'N', termQuitTitle: 'T', termQuitMessage: '{count} running', termQuitDetail: 'D' };
    let asked = null;
    const box = (r) => async (...a) => ((asked = a.at(-1)), r);
    assert.equal(await confirmQuitWithTerminals({ count: 0, S, showMessageBox: box({ response: 1 }) }), true);
    assert.equal(asked, null, 'nothing running: no question');
    assert.equal(await confirmQuitWithTerminals({ count: 2, S, showMessageBox: box({ response: QUIT_CONFIRM_OK }) }), true);
    assert.equal(asked.message, '2 running');
    assert.equal(asked.defaultId, 1, 'Cancel is the default');
    assert.equal(await confirmQuitWithTerminals({ count: 2, S, showMessageBox: box({ response: 1 }) }), false);
    assert.equal(await confirmQuitWithTerminals({ count: 2, S, showMessageBox: async () => { throw new Error('x'); } }), false);
    asked = null;
    assert.equal(await confirmQuitWithTerminals({ count: 2, S, qa: true, showMessageBox: box({ response: 1 }) }), true);
    assert.equal(asked, null);
  });
});

describe('preload: window.sibersentezTerminal', () => {
  function loadPreload() {
    const invokes = [];
    const sends = [];
    const listens = [];
    const exposed = {};
    const ipcRenderer = { invoke: (...a) => (invokes.push(a), Promise.resolve({ ok: true })), send: (...a) => sends.push(a), on: (...a) => listens.push(a) };
    vm.runInNewContext(read('electron', 'preload.cjs'), { require: (m) => (m === 'electron' ? { contextBridge: { exposeInMainWorld: (k, v) => (exposed[k] = v) }, ipcRenderer } : null) });
    // The preload runs in its own realm: compare as JSON
    const j = (x) => JSON.parse(JSON.stringify(x));
    return { api: exposed.sibersentezTerminal, invokes, sends, listens, j };
  }

  test('seven functions; the same channel names as the shell', () => {
    const p = loadPreload();
    assert.deepEqual(Object.keys(p.api), ['open', 'write', 'resize', 'close', 'list', 'onData', 'onExit', 'onToolEnd']);
    const code = read('electron', 'preload.cjs');
    for (const [k, v] of Object.entries(TERMINAL_IPC)) assert.ok(code.includes(`${k}: '${v}'`), k);
  });

  test('ids, keystrokes and sizes only; anything else never reaches the shell', async () => {
    const p = loadPreload();
    await p.api.open({ projectId: 'alpha', dir: 'C:\\evil' }, 100, 30);
    assert.deepEqual(p.j(p.invokes.at(-1)), [TERMINAL_IPC.open, { projectId: 'alpha' }, 100, 30], 'only the id is passed on');
    await p.api.open({ projectId: 'alpha' }, 9999, 'x');
    assert.deepEqual(p.j(p.invokes.at(-1)), [TERMINAL_IPC.open, { projectId: 'alpha' }, null, null]);
    const before = p.invokes.length;
    for (const bad of [null, 'alpha', { projectId: '../x' }, { sessionId: 'nope' }]) assert.equal((await p.api.open(bad)).ok, false);
    assert.equal(await p.api.close('../t1'), false);
    assert.equal(p.invokes.length, before);
    p.api.write('t1', 'ls\r');
    p.api.write('t1', 5);
    p.api.write('x1', 'a');
    p.api.write('t1', 'x'.repeat(MAX_WRITE + 1));
    p.api.resize('t1', 80, 24);
    p.api.resize('t1', 80, 999);
    assert.deepEqual(p.j(p.sends), [[TERMINAL_IPC.write, 't1', 'ls\r'], [TERMINAL_IPC.resize, 't1', 80, 24]]);
    const got = [];
    p.api.onData((id, text) => got.push([id, text]));
    p.api.onData('not a function');
    assert.equal(p.listens.length, 1);
    p.listens[0][1]({ sender: 'the event object' }, 't1', 'out');
    assert.deepEqual(p.j(got), [['t1', 'out']], 'the page never gets the event object');
  });
});

describe('server: terminal-target', () => {
  const dir = path.join(TMP, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const catalog = {
    roster: new Map(),
    getProject: (id) => ({ alpha: { id: 'alpha', name: 'Alpha', kind: 'registered', path: dir }, home: { id: 'home', name: 'Home', kind: 'adhoc', path: TMP, broad: true }, gone: { id: 'gone', name: 'Gone', kind: 'registered', path: path.join(TMP, 'nope') } })[id] || null,
  };
  const make = (mode) => createActions({ catalog, ingest: { sessions: new Map() }, fit: { invalidate() {} }, mode, port: 1, workDir: TMP, log: () => {} });

  test('only in On; the terminal action\'s checks decide; the answer carries the folder and the title', () => {
    assert.deepEqual(make('off').terminalTarget({ projectId: 'alpha' }), { ok: false, reason: 'off' });
    assert.deepEqual(make('dry').terminalTarget({ projectId: 'alpha' }), { ok: false, reason: 'preview' });
    const live = make('live');
    assert.deepEqual(live.terminalTarget({ projectId: 'alpha' }), { ok: true, dir, title: 'Alpha', projectId: 'alpha' });
    assert.deepEqual(live.terminalTarget({ projectId: 'home' }), { ok: false, reason: 'refused', status: 409 }, 'a broad folder');
    assert.deepEqual(live.terminalTarget({ projectId: 'gone' }), { ok: false, reason: 'refused', status: 404 });
    assert.deepEqual(live.terminalTarget({ projectId: 'nobody' }), { ok: false, reason: 'refused', status: 404 });
    assert.equal(live.terminalTarget({ projectId: 'alpha', dir: 'C:\\' }).dir, dir, 'extra fields are not read');
    assert.equal(live.terminalTarget({}).ok, false);
  });

  test('the setup terminal: only { setup: true }, only in On, a plain shell of the home folder with no program', () => {
    const withHome = (mode, home) => createActions({ catalog, ingest: { sessions: new Map() }, fit: { invalidate() {} }, mode, port: 1, workDir: TMP, log: () => {}, ai: { env: { USERPROFILE: home } } });
    assert.deepEqual(withHome('live', TMP).terminalTarget({ setup: true }), { ok: true, dir: TMP, title: 'Setup', projectId: null });
    assert.equal(withHome('live', TMP).terminalTarget({ setup: true }).program, undefined, 'no program: a plain shell');
    assert.deepEqual(withHome('off', TMP).terminalTarget({ setup: true }), { ok: false, reason: 'off' });
    assert.deepEqual(withHome('dry', TMP).terminalTarget({ setup: true }), { ok: false, reason: 'preview' });
    for (const bad of [{ setup: 1 }, { setup: 'yes' }, { setup: true, projectId: 'alpha' }]) assert.equal(withHome('live', TMP).terminalTarget(bad).ok, false, JSON.stringify(bad));
    assert.equal(withHome('live', path.join(TMP, 'no-such-home')).terminalTarget({ setup: true }).ok, false, 'a home folder that is not there');
    assert.equal(withHome('live', '\\\\server\\share').terminalTarget({ setup: true }).ok, false, 'not a local drive');
  });

  test('the setup terminal through every layer: the page → the preload → the shell\'s check → the channel → the server (each layer passed alone, together they dropped { setup }: found by using the app 2026-10-08)', async () => {
    const invokes = [];
    const exposed = {};
    vm.runInNewContext(read('electron', 'preload.cjs'), { require: (m) => (m === 'electron' ? { contextBridge: { exposeInMainWorld: (k, v) => (exposed[k] = v) }, ipcRenderer: { invoke: (...a) => (invokes.push(a), Promise.resolve({ ok: true })), send() {}, on() {} } } : null) });
    await exposed.sibersentezTerminal.open({ setup: true }, 80, 24);
    const sent = JSON.parse(JSON.stringify(invokes.at(-1)[1]));
    assert.deepEqual(sent, { setup: true }, 'the preload passes it on');
    for (const bad of [{ setup: 1 }, { setup: true, dir: 'C:\\' }]) assert.equal((await exposed.sibersentezTerminal.open(bad)).ok, false, JSON.stringify(bad));
    const shell = termOpenRequest(sent);
    assert.equal(shell.ok, true);
    const through = (mode) => {
      const actions = createActions({ catalog, ingest: { sessions: new Map() }, fit: { invalidate() {} }, mode, port: 1, workDir: TMP, log: () => {}, ai: { env: { USERPROFILE: TMP } } });
      const ch = createProjectChannel({ catalog: {}, terminalTarget: actions.terminalTarget });
      // As the shell's server call sends it: the target's fields next to the message's own
      return ch.handle({ ...shell.target, sibersentez: 'shell-call', id: 1, type: 'terminal-target' });
    };
    assert.deepEqual([through('live').ok, through('live').dir, through('live').title], [true, TMP, 'Setup'], 'On: the home folder');
    assert.deepEqual([through('off').ok, through('off').reason], [false, 'off'], 'Off: said as Off (the page tells to turn actions On), not "this folder cannot take a terminal"');
    assert.equal(through('dry').reason, 'preview');
  });

  test('the channel passes only the ids and answers the folder to the shell', () => {
    const seen = [];
    const ch = createProjectChannel({ catalog: {}, terminalTarget: (req) => (seen.push(req), { ok: true, dir: 'C:\\p', title: 'P', projectId: 'p' }) });
    const r = ch.handle({ sibersentez: 'shell-call', id: 3, type: 'terminal-target', projectId: 'p', dir: 'C:\\evil', cmd: 'x' });
    assert.deepEqual(seen, [{ projectId: 'p', sessionId: undefined }]);
    assert.deepEqual(r, { sibersentez: 'shell-reply', id: 3, ok: true, reason: 'saved', projectId: 'p', dir: 'C:\\p', title: 'P' });
  });
});

test('a lost renderer reloads after 1 then 2 s; the third loss in two minutes stops; older losses are forgotten', () => {
  const T = 1_760_000_000_000;
  let p = rendererReloadPlan([], T);
  assert.equal(p.delayMs, 1000);
  p = rendererReloadPlan(p.times, T + 5000);
  assert.equal(p.delayMs, 2000);
  p = rendererReloadPlan(p.times, T + 9000);
  assert.equal(p.delayMs, null, 'stops: a page that crashes on load does not restart forever');
  assert.equal(rendererReloadPlan([T, T + 5000], T + 200000).delayMs, 1000, 'two minutes later it starts over');
  const main = read('electron', 'main.mjs');
  assert.ok(main.includes('clearTimeout(state.rendererReload);'), 'one pending reload');
  assert.ok(main.includes('if (win.webContents.isCrashed()) {'), 'coming back to the window tries once more');
});

test('closing a terminal never forks node-pty\'s process list agent (it would start SiberSentez.exe): taskkill /T of the shell instead', async () => {
  const killed = [];
  const agent = { _innerPid: 4321, _getConsoleProcessList: () => assert.fail('the fork must not run') };
  const pty = avoidForkOnKill({ _agent: agent }, (pid) => killed.push(pid));
  assert.deepEqual(await pty._agent._getConsoleProcessList(), [], 'nothing left for node-pty to kill one by one');
  assert.deepEqual(killed, [4321]);
  const plain = {};
  assert.equal(avoidForkOnKill(plain, () => assert.fail()), plain, 'a pty without the agent is left as it is');
  const calls = [];
  taskkillTree((file, args, opts) => (calls.push([file, args, opts]), { on() {} }), 99, 'D:\\Win');
  assert.deepEqual(calls[0].slice(0, 2), ['D:\\Win\\System32\\taskkill.exe', ['/T', '/F', '/PID', '99']]);
  assert.deepEqual([calls[0][2].windowsHide, calls[0][2].shell], [true, false]);
  taskkillTree((file) => (calls.push([file]), { on() {} }), 1, '%x%');
  assert.equal(calls[1][0], 'C:\\Windows\\System32\\taskkill.exe', 'an odd SystemRoot falls back');
  assert.ok(read('electron', 'main.mjs').includes('avoidForkOnKill(loadPty().spawn('), 'every terminal gets it');
});

test('wiring: every terminal handler checks the sender; the pty loads on first use; quitting asks', () => {
  const src = read('electron', 'main.mjs');
  for (const line of [
    'ipcMain.handle(TERMINAL_IPC.open, onTermOpen);',
    'ipcMain.handle(TERMINAL_IPC.list, (event) => (termSenderOk(event) ? terminals.list() : []));',
    'ipcMain.handle(TERMINAL_IPC.close, (event, id) => termSenderOk(event) && terminals.close(id));',
    'ipcMain.on(TERMINAL_IPC.write, (event, id, data) => termSenderOk(event) && terminals.write(id, data));',
    'ipcMain.on(TERMINAL_IPC.resize, (event, id, cols, rows) => termSenderOk(event) && terminals.resize(id, cols, rows));',
    'const termSenderOk = (event) => bridgeSender(senderFacts(event)).ok;',
    "const target = await serverCalls.call(state.server, 'terminal-target', r.target);",
    "{ label: S.trayQuit, click: () => quitWithTerminalsConfirmed('tray: Quit') },",
  ]) assert.ok(src.includes(line), line);
  const open = src.slice(src.indexOf('async function onTermOpen('), src.indexOf('\n}\n', src.indexOf('async function onTermOpen(')));
  assert.ok(open.indexOf('termSenderOk(event)') < open.indexOf('termOpenRequest(req)'), 'the sender first');
  assert.equal((src.match(/\('node-pty'\)/g) || []).length, 1, 'node-pty in one place');
  assert.ok(/function loadPty\(\) \{\n\s+if \(!ptyModule\)/.test(src), 'loaded on first use');
  assert.ok(src.includes('terminals.closeAll();'), 'quitting closes them');
  const index = read('server', 'index.mjs');
  assert.ok(index.includes('terminalTarget: (req) => actions.terminalTarget(req),'));
});

test('menus: with the dock, "Resume" continues a closed Claude Code session there (start-ai with resume) and Windows Terminal is the second item; a full dock or none: as before', async () => {
  const { menuModel, setDockOpener } = await import('../public/js/contextmenu.js');
  const dir = path.join(TMP, 'menu-resume');
  fs.mkdirSync(dir, { recursive: true });
  const sid = '11111111-2222-4333-8444-555555555555';
  const d = { projects: new Map([['alpha', { id: 'alpha', name: 'Alpha', kind: 'registered', path: dir }]]), sessions: new Map([[sid, { id: sid, projectId: 'alpha', cwd: dir, lastAt: 1, live: null }]]), agents: new Map() };
  const pick = (m, id) => m.find((x) => x.id === id);
  try {
    let full = false;
    setDockOpener(() => ({ ok: true }), () => full);
    const m = menuModel({ type: 'session', id: sid }, d, 'live');
    assert.deepEqual([pick(m, 'resume').action, pick(m, 'resume').payload], ['start-ai', { sessionId: sid, tool: 'claude', resume: true }]);
    assert.deepEqual([pick(m, 'resume-outside').action, pick(m, 'resume-outside').payload], ['resume', { sessionId: sid }]);
    full = true;
    const m2 = menuModel({ type: 'session', id: sid }, d, 'live');
    assert.equal(pick(m2, 'resume').action, 'resume', 'a full dock: Windows Terminal');
    assert.equal(pick(m2, 'resume-outside'), undefined);
    setDockOpener(null);
    assert.equal(pick(menuModel({ type: 'session', id: sid }, d, 'live'), 'resume').action, 'resume', 'no dock: as before');
  } finally {
    setDockOpener(null);
  }
});

test('menus: with the dock, "Open terminal" opens there and Windows Terminal is the second item; without it, as before', async () => {
  const { menuModel, setDockOpener, runMenuItem } = await import('../public/js/contextmenu.js');
  const dir = path.join(TMP, 'menu-proj');
  fs.mkdirSync(dir, { recursive: true });
  const d = { projects: new Map([['alpha', { id: 'alpha', name: 'Alpha', kind: 'registered', path: dir }]]), sessions: new Map(), agents: new Map() };
  const ids = (m) => m.filter((x) => !x.sep && !x.header).map((x) => x.id);
  try {
    setDockOpener(null);
    assert.ok(ids(menuModel({ type: 'project', id: 'alpha' }, d, 'live')).includes('terminal'));
    assert.ok(!ids(menuModel({ type: 'project', id: 'alpha' }, d, 'live')).includes('terminal-dock'), 'a plain browser: no dock item');
    const opened = [];
    setDockOpener((target) => (opened.push(target), { ok: true }));
    const m = menuModel({ type: 'project', id: 'alpha' }, d, 'live');
    const list = ids(m);
    assert.equal(list.indexOf('terminal-dock') + 1, list.indexOf('terminal'), 'the dock first, Windows Terminal right after');
    const dock = m.find((x) => x.id === 'terminal-dock');
    assert.equal(dock.action, undefined, 'the dock item never goes to the server as an action');
    await runMenuItem(dock, {});
    assert.deepEqual(opened, [{ projectId: 'alpha' }]);
    const main = read('public', 'js', 'main.js');
    assert.ok(main.includes('if (termDock.available) setDockOpener((target) => termDock.open(target), () => termDock.count() >= 8);'), 'a full dock sends start-ai to Windows Terminal');
    assert.ok(main.includes("const qaDock = QA && ['demo', 'ask', 'err', 'shell'].includes(params.get('dock')) && !globalThis.sibersentezTerminal;") && main.includes('if (qaDock) setTimeout('), 'the QA dock opens by itself only with its stand-in');
  } finally {
    setDockOpener(null);
  }
});

describe('output flow control', () => {
  // A fake clock with timers, so batching is tested without waiting
  function fakeClock() {
    let t = 1000;
    const timers = [];
    return {
      now: () => t,
      setTimer: (fn, ms) => {
        const h = { fn, at: t + ms };
        timers.push(h);
        return h;
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h);
        if (i >= 0) timers.splice(i, 1);
      },
      advance(ms) {
        t += ms;
        for (const h of timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
          timers.splice(timers.indexOf(h), 1);
          h.fn();
        }
      },
      get timers() {
        return timers.length;
      },
    };
  }

  test('chunk buffer keeps the newest max characters without copying per push', () => {
    const b = createChunkBuffer(10);
    b.push('abcd');
    b.push('efgh');
    assert.equal(b.toString(), 'abcdefgh');
    b.push('ijkl'); // 12 > 10: the oldest chunk goes whole only when it fits out, else it is cut
    assert.equal(b.toString(), 'cdefghijkl');
    assert.equal(b.length, 10);
    b.push('x'.repeat(25));
    assert.equal(b.toString(), 'x'.repeat(10));
    assert.equal(b.chunks, 1);
    b.push('');
    assert.equal(b.length, 10);
    const c = createChunkBuffer(5);
    for (let i = 0; i < 100; i++) c.push('ab');
    assert.equal(c.length, 5);
    assert.ok(c.chunks <= 4, 'old chunks are dropped, not kept');
  });

  test('batcher: first output at once, the next ones within the window joined into one message', () => {
    const clk = fakeClock();
    const out = [];
    const b = createOutputBatcher({ send: (s) => out.push(s), now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, windowMs: 32 });
    b.push('a');
    assert.deepEqual(out, ['a']);
    clk.advance(5);
    b.push('b');
    clk.advance(5);
    b.push('c');
    assert.deepEqual(out, ['a'], 'still waiting for the window');
    assert.equal(b.pending, 2);
    clk.advance(21); // 31 ms since the first send
    assert.deepEqual(out, ['a']);
    clk.advance(1);
    assert.deepEqual(out, ['a', 'bc']);
    clk.advance(100);
    b.push('d');
    assert.deepEqual(out, ['a', 'bc', 'd'], 'a quiet window: instant again');
    assert.equal(clk.timers, 0);
  });

  test('batcher: a pile over the high-water mark goes out now, pauses the pty, resumes after the window', () => {
    const clk = fakeClock();
    const out = [];
    const ev = [];
    const b = createOutputBatcher({ send: (s) => out.push(s.length), pause: () => ev.push('pause'), resume: () => ev.push('resume'), now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, windowMs: 32, highWater: 100 });
    b.push('x'.repeat(60));
    b.push('y'.repeat(60)); // first went at once; 60 waiting
    assert.deepEqual(out, [60]);
    b.push('z'.repeat(60)); // 120 >= 100
    assert.deepEqual(out, [60, 120]);
    assert.deepEqual(ev, ['pause']);
    assert.equal(b.paused, true);
    b.push('w'.repeat(200)); // data already read before the pause took effect: pause is not repeated
    assert.deepEqual(ev, ['pause']);
    clk.advance(40);
    assert.deepEqual(ev, ['pause', 'resume']);
    assert.equal(b.paused, false);
    assert.equal(b.pending, 0);
  });

  test('batcher: flush sends what waits, cancel drops it and its timer', () => {
    const clk = fakeClock();
    const out = [];
    const b = createOutputBatcher({ send: (s) => out.push(s), now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
    b.push('a');
    b.push('b');
    b.flush();
    assert.deepEqual(out, ['a', 'b']);
    assert.equal(clk.timers, 0);
    b.push('c');
    b.push('d');
    b.cancel();
    clk.advance(1000);
    assert.deepEqual(out, ['a', 'b']);
    assert.equal(clk.timers, 0);
  });

  test('manager: output is joined per window, exit flushes it first, close drops it, list keeps the whole buffer', () => {
    const clk = fakeClock();
    const f = fakePty();
    const sent = [];
    const m = createTerminals({ spawn: f.spawn, send: (...a) => sent.push(a), clock: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
    m.open({ dir: 'C:\p', title: 'P' });
    f.ptys[0].pause = () => sent.push(['pause']);
    f.ptys[0].resume = () => sent.push(['resume']);
    f.ptys[0].data('a');
    f.ptys[0].data('b');
    f.ptys[0].data('c');
    assert.deepEqual(sent, [[TERMINAL_IPC.data, 't1', 'a']]);
    assert.equal(m.list()[0].buffer, 'abc', 'the buffer has it all at once');
    clk.advance(40);
    assert.deepEqual(sent.at(-1), [TERMINAL_IPC.data, 't1', 'bc']);
    f.ptys[0].data('d');
    f.ptys[0].data('e');
    f.ptys[0].exit({ exitCode: 3 });
    assert.deepEqual(sent.slice(-2), [[TERMINAL_IPC.data, 't1', 'de'], [TERMINAL_IPC.exit, 't1', 3]]);

    m.open({ dir: 'C:\p', title: 'Q' });
    const n = sent.length;
    f.ptys[1].data('1');
    f.ptys[1].data('2');
    m.close('t2');
    f.ptys[1].data('3'); // late output of a closed terminal
    clk.advance(1000);
    assert.deepEqual(sent.slice(n), [[TERMINAL_IPC.data, 't2', '1'], [TERMINAL_IPC.exit, 't2', null]]);
  });

  test('manager: a flood pauses the pty (when it can) and keeps the buffer within MAX_BUFFER', () => {
    const clk = fakeClock();
    const f = fakePty();
    const sent = [];
    const m = createTerminals({ spawn: f.spawn, send: (...a) => sent.push(a), clock: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, highWater: 1000 });
    m.open({ dir: 'C:\p', title: 'P' });
    const ev = [];
    f.ptys[0].pause = () => ev.push('pause');
    f.ptys[0].resume = () => ev.push('resume');
    f.ptys[0].data('a');
    f.ptys[0].data('x'.repeat(2000));
    assert.deepEqual(ev, ['pause']);
    clk.advance(40);
    assert.deepEqual(ev, ['pause', 'resume']);
    for (let i = 0; i < 20; i++) f.ptys[0].data('y'.repeat(MAX_BUFFER / 4));
    assert.equal(m.list()[0].buffer.length, MAX_BUFFER);
    // a pty without pause/resume is left unthrottled, without an error
    m.open({ dir: 'C:\p', title: 'Q' });
    assert.doesNotThrow(() => f.ptys[1].data('z'.repeat(5000)));
  });
});

describe('the tool ended, the shell stays', () => {
  test("an AI tab is checked for its launcher's mark: then it no longer runs (server and window told), the check stops", () => {
    const f = fakePty();
    const sent = [];
    const changes = [];
    const marks = new Set();
    const timers = [];
    const m = createTerminals({
      spawn: f.spawn,
      send: (...a) => sent.push(a),
      onChange: (ended) => changes.push(ended),
      exists: (p) => marks.has(p),
      every: (fn, ms) => (timers.push({ fn, ms, stopped: false }), timers.at(-1)),
      stopEvery: (t) => (t.stopped = true),
    });
    const launcher = path.win32.join(String.raw`C:\hub\launch`, 'abcdef012345.cmd');
    m.open({ dir: String.raw`C:\p`, projectId: 'p1', launch: { file: String.raw`C:\Windows\System32\cmd.exe`, args: ['/d', '/v:off', '/k', launcher] }, tool: 'codex' });
    // A relative launcher (the fallback way) is found from the folder it starts in
    m.open({ dir: String.raw`C:\hub\launch`, projectId: 'p2', launch: { file: String.raw`C:\Windows\System32\cmd.exe`, args: ['/d', '/v:off', '/k', String.raw`.\bbbbbbbbbbbb.cmd`] }, tool: 'gemini' });
    m.open({ dir: String.raw`C:\p`, projectId: 'p1' }); // a plain shell: nothing to wait for
    assert.equal(timers.length, 1, 'one check for every tab');
    assert.equal(timers[0].ms, TOOL_CHECK_MS);
    timers[0].fn();
    assert.deepEqual(m.sessions().map((x) => x.running), [true, true, true], 'no mark yet');
    const before = changes.length;
    marks.add(launcher + ENDED_SUFFIX);
    timers[0].fn();
    assert.deepEqual(m.sessions().map((x) => [x.id, x.running]), [['t1', false], ['t2', true], ['t3', true]]);
    assert.deepEqual(sent.filter((x) => x[0] === TERMINAL_IPC.toolEnd), [[TERMINAL_IPC.toolEnd, 't1']]);
    assert.equal(changes.length, before + 1, 'the server is told');
    assert.equal(m.list().find((x) => x.id === 't1').toolEnded, true, 'a reloaded page knows it too');
    assert.equal(timers[0].stopped, false, 't2 still waits');
    timers[0].fn();
    assert.equal(sent.filter((x) => x[0] === TERMINAL_IPC.toolEnd).length, 1, 'said once');
    marks.add(String.raw`C:\hub\launch\bbbbbbbbbbbb.cmd` + ENDED_SUFFIX);
    timers[0].fn();
    assert.equal(m.sessions().find((x) => x.id === 't2').running, false);
    assert.equal(timers[0].stopped, true, 'nothing waits: the check stops');
    // The shell itself still runs: the tab stays, output still goes to the window
    f.ptys[0].data('prompt>');
    assert.deepEqual(sent.at(-1), [TERMINAL_IPC.data, 't1', 'prompt>']);
    assert.ok(m.sessions().some((x) => x.id === 't1'));
  });

  test('the mark the launcher leaves is the one the shell looks for', async () => {
    const { ENDED_SUFFIX: serverSuffix, ENDED_PATH_LINE, ENDED_MARK_LINE } = await import('../server/launch.mjs');
    assert.equal(serverSuffix, ENDED_SUFFIX);
    assert.ok(ENDED_PATH_LINE.includes('%~f0' + ENDED_SUFFIX));
    assert.ok(ENDED_MARK_LINE.includes('%SIBERSENTEZ_ENDED%'));
  });

  test('the server: a tab whose tool ended no longer locks going back; an older shell that says nothing still does', async () => {
    const a = createActions({ catalog: { getProject: () => null, projects: [], allProjects: () => [] }, mode: 'off' });
    a.terminalState({ sessions: [{ id: 't1', projectId: 'p', ai: true, tool: 'codex', running: false }, { id: 't2', projectId: 'q', ai: true, tool: 'codex' }] });
    assert.deepEqual(a.dockSessions().map((x) => [x.id, x.running]), [['t1', false], ['t2', true]]);
    const src = fs.readFileSync(new URL('../server/actions.mjs', import.meta.url), 'utf8');
    assert.ok(src.includes('dockRunning.some((x) => x.ai && x.running && x.projectId === projectId)'), 'the restore guard counts running tools only');
  });
});
