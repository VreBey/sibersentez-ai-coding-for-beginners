// "New project" (docs/start-flow.md, step 2): choose or create a folder -> write the idea -> install -> open a terminal.
// Covered: the preload's two new functions, who may call them (the bridge's sender rule), the shell's folder rules and
// picker flow, its calls to the server process, what the page gets back (never a path); the server's side (the
// project memory with the idea, the catalog's folder rules, adding a folder, the message channel, a forked server end
// to end); the page's pure parts (the flow behind the button, the start card, the stored idea, "Then: open a
// terminal"). No window, dialog, terminal or Explorer is ever opened: Electron's parts are fakes; the real server runs
// forked with a fake home and a temporary hub. Temporary files go to the system temp folder.
// Run: node --test test/new-project.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  IDEA_TEXT_MAX as SHELL_IDEA_TEXT_MAX,
  NEW_PROJECT_SCRIPT,
  PROJECT_ID_RE,
  PROJECT_IDEA_IPC_CHANNEL,
  PROJECT_PICK_IPC_CHANNEL,
  ACTIONS_IPC_CHANNEL,
  appOrigin,
  bridgeSender,
  buildServerEnv,
  checkProjectFolder,
  createServerCalls,
  panelRequest,
  pickProjectFolder,
  projectFolderDialogOptions,
  projectIdeaRequest,
  projectReply,
  waitForServer,
} from '../electron/helpers.mjs';
import { STRINGS as SHELL_STRINGS, getStrings } from '../electron/strings.mjs';
import { ProjectMemory, createProjectChannel, shellChangeHandler, IDEA_TEXT_MAX, IDEA_MAX, SIBERSENTEZ_VIA } from '../server/memory.mjs';
import { Catalog, SYSTEM_TREE_VARS, ONEDRIVE_ROOT_VARS } from '../server/catalog.mjs';
import { initHub } from '../server/hub.mjs';
import { projectView } from '../server/views.mjs';
import { Ingest } from '../server/ingest.mjs';
import { projectBridge, newProjectOutcome, createNewProjectFlow, qaProjectBridge, startCardVisible, startCardHtml, ownProjects, START_CARD_MAX } from '../public/js/views/projects.js';
import { adoptHubIdea, startNextHtml, cleanIdea } from '../public/js/views/drawer.js';
import { STRINGS, setLanguage, t } from '../public/js/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-new-project-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const textOf = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
// A function's body in a source file (up to its closing brace at the start of a line)
const bodyOf = (src, name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, `end of function ${name}`);
  return src.slice(start, end);
};

const ORIGIN = appOrigin(47712);
const FROM_PAGE = { mainWindow: true, frame: { top: true, url: `${ORIGIN}/?lang=tr` }, origin: ORIGIN };

let n = 0;
// A fresh world: home (with Desktop, Documents, Downloads, AppData, .claude), hub, program folder, work folder
function world() {
  const base = path.join(TMP, `w${++n}`);
  const home = path.join(base, 'home');
  const w = {
    base,
    home,
    claude: path.join(home, '.claude'),
    hub: path.join(base, 'hub'),
    app: path.join(base, 'program'),
    work: path.join(base, 'work'),
  };
  for (const d of [path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'), path.join(home, 'AppData', 'Local', 'x'), w.claude, w.app, w.work]) fs.mkdirSync(d, { recursive: true });
  initHub(w.hub);
  w.dir = (...p) => {
    const d = path.join(w.work, ...p);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  w.rules = () => ({ homeDir: home, broadDirs: ['Desktop', 'Documents', 'Downloads'].map((d) => path.join(home, d)), hubPath: w.hub, programDirs: [w.app] });
  w.catalog = () => {
    const c = new Catalog({ hubDir: w.hub, claudeDir: w.claude, homeDir: home, adapters: [], env: {}, memory: new ProjectMemory({ hubDir: w.hub, debounceMs: 0 }) });
    c.load();
    return c;
  };
  return w;
}
const junction = (target, link) => fs.symlinkSync(target, link, 'junction');

// ------------------------------------------------------------------ the preload
describe('preload: pickProjectFolder and saveProjectIdea', () => {
  function loadPreload() {
    const code = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');
    const exposed = {};
    const invokes = [];
    const ipcRenderer = new Proxy(
      { invoke: (...args) => (invokes.push(args), Promise.resolve({ ok: true, projectId: 'x-new', reason: 'added' })) },
      {
        get(target, key) {
          if (key in target) return target[key];
          throw new Error(`the preload used ipcRenderer.${String(key)}`);
        },
      },
    );
    vm.runInNewContext(code, { require: (m) => (m === 'electron' ? { contextBridge: { exposeInMainWorld: (k, api) => (exposed[k] = api) }, ipcRenderer } : null) });
    return { api: exposed.sibersentezShell, invokes };
  }

  test('pickProjectFolder invokes its channel with no argument at all; the page gets the answer as it is', async () => {
    const p = loadPreload();
    assert.deepEqual(await p.api.pickProjectFolder('C:\\ignored', { path: 'x' }), { ok: true, projectId: 'x-new', reason: 'added' });
    assert.deepEqual(p.invokes, [[PROJECT_PICK_IPC_CHANNEL]], 'whatever the page passes, no folder travels from the page');
  });

  test('saveProjectIdea passes a project id and the text; anything else is refused in the preload and never reaches the shell', async () => {
    const p = loadPreload();
    await p.api.saveProjectIdea('x-game', 'Unity ile 2D platform oyunu');
    await p.api.saveProjectIdea('my-shop', '');
    assert.deepEqual(p.invokes, [
      [PROJECT_IDEA_IPC_CHANNEL, 'x-game', 'Unity ile 2D platform oyunu'],
      [PROJECT_IDEA_IPC_CHANNEL, 'my-shop', ''],
    ]);
    const bad = [
      [1, 'x'],
      [null, 'x'],
      ['', 'x'],
      ['-x', 'x'],
      ['a/b', 'x'],
      ['a'.repeat(101), 'x'],
      ['x-game', 42],
      ['x-game', null],
      ['x-game', { toString: () => 'x' }],
      ['x-game', 'x'.repeat(IDEA_TEXT_MAX + 1)],
    ];
    for (const [id, text] of bad) assert.deepEqual({ ...(await p.api.saveProjectIdea(id, text)) }, { ok: false, reason: 'invalid' }, `${String(id).slice(0, 20)} / ${String(text).slice(0, 20)}`);
    assert.equal(p.invokes.length, 2);
  });

  test("the preload's names and rules are the shell's", () => {
    // window.sibersentezShell's part (the terminal bridge listens and sends by design: test/terminal.test.mjs)
    const all = textOf('electron', 'preload.cjs');
    const code = all.slice(0, all.indexOf("contextBridge.exposeInMainWorld('sibersentezTerminal'")) + all.slice(all.indexOf("contextBridge.exposeInMainWorld('sibersentezShell'"));
    assert.ok(code.includes(`const PICK_CHANNEL = '${PROJECT_PICK_IPC_CHANNEL}';`));
    assert.ok(code.includes(`const IDEA_CHANNEL = '${PROJECT_IDEA_IPC_CHANNEL}';`));
    assert.ok(code.includes(`const PROJECT_ID = ${PROJECT_ID_RE.source.replace(/^/, '/')}/;`), 'the same project id rule');
    assert.ok(code.includes(`const IDEA_MAX = ${SHELL_IDEA_TEXT_MAX};`));
    assert.equal(SHELL_IDEA_TEXT_MAX, IDEA_TEXT_MAX, 'the shell and the server read the same length');
    assert.equal(IDEA_TEXT_MAX, IDEA_MAX * 4);
    assert.deepEqual(new Set([ACTIONS_IPC_CHANNEL, PROJECT_PICK_IPC_CHANNEL, PROJECT_IDEA_IPC_CHANNEL]).size, 3);
    assert.doesNotMatch(code, /ipcRenderer\.(on|once|send|sendSync|sendToHost|postMessage|addListener)\b/, 'no listener, no send');
  });
});

// ------------------------------------------------------------------ who may call
describe('shell: who may use the bridge', () => {
  test('the main window, its top frame, the server origin: accepted; setActionsMode keeps the same rule', () => {
    assert.deepEqual(bridgeSender(FROM_PAGE), { ok: true });
    assert.deepEqual(panelRequest({ ...FROM_PAGE, mode: 'dry' }), { ok: true, mode: 'dry' });
    assert.deepEqual(projectIdeaRequest({ ...FROM_PAGE, projectId: 'x-a', text: 'idea' }), { ok: true, projectId: 'x-a', text: 'idea' });
  });

  test('another window, a subframe, a gone frame, another origin, no ready server: refused, before the arguments are looked at', () => {
    const cases = [
      [{ ...FROM_PAGE, mainWindow: false }, 'not-main-window'],
      [{ ...FROM_PAGE, mainWindow: 'true' }, 'not-main-window'],
      [{ ...FROM_PAGE, frame: { top: false, url: `${ORIGIN}/` } }, 'not-top-frame'],
      [{ ...FROM_PAGE, frame: null }, 'not-top-frame'],
      [{ ...FROM_PAGE, frame: { top: true, url: 'http://127.0.0.1:4545/' } }, 'not-app-origin'],
      [{ ...FROM_PAGE, frame: { top: true, url: 'chrome-error://chromewebdata/' } }, 'not-app-origin'],
      [{ ...FROM_PAGE, origin: null }, 'not-app-origin'],
    ];
    for (const [facts, reason] of cases) {
      assert.deepEqual(bridgeSender(facts), { ok: false, reason }, JSON.stringify(facts));
      assert.deepEqual(projectIdeaRequest({ ...facts, projectId: 'bad id', text: 42 }), { ok: false, reason }, 'the sender first');
      assert.deepEqual(panelRequest({ ...facts, mode: 'live' }), { ok: false, reason }, 'setActionsMode: the same rule');
    }
  });

  test('saveProjectIdea: a project id and a string of at most IDEA_TEXT_MAX characters', () => {
    for (const [projectId, text] of [
      ['x-a', 'x'.repeat(SHELL_IDEA_TEXT_MAX + 1)],
      ['x-a', 1],
      ['x-a', undefined],
      ['../x', 'idea'],
      ['', 'idea'],
      [null, 'idea'],
    ]) {
      assert.deepEqual(projectIdeaRequest({ ...FROM_PAGE, projectId, text }), { ok: false, reason: 'invalid' });
    }
    assert.equal(projectIdeaRequest({ ...FROM_PAGE, projectId: 'x-a', text: 'x'.repeat(SHELL_IDEA_TEXT_MAX) }).ok, true, 'the server cleans and cuts it');
    assert.equal(projectIdeaRequest({ ...FROM_PAGE, projectId: 'x-a', text: '' }).ok, true, "'' clears the idea");
  });
});

// ------------------------------------------------------------------ the shell's folder rules
describe('shell: which folder can be a project (checkProjectFolder)', () => {
  test('an ordinary folder is accepted as written', { skip: WINDOWS_ONLY }, () => {
    const w = world();
    const d = w.dir('my-game');
    assert.deepEqual(checkProjectFolder(d, w.rules()), { ok: true, path: d });
    assert.deepEqual(checkProjectFolder(`${d}\\`, w.rules()), { ok: true, path: d }, 'a trailing separator is dropped');
    const inDesktop = path.join(w.home, 'Desktop', 'new-site');
    fs.mkdirSync(inDesktop);
    assert.equal(checkProjectFolder(inDesktop, w.rules()).ok, true, 'a new folder inside the Desktop is fine');
  });

  test('refused: a drive root, the home folder and its parents, Desktop / Documents / Downloads themselves', { skip: WINDOWS_ONLY }, () => {
    const w = world();
    const r = w.rules();
    assert.equal(checkProjectFolder(path.parse(w.base).root, r).reason, 'drive-root');
    assert.equal(checkProjectFolder(w.home, r).reason, 'home');
    assert.equal(checkProjectFolder(w.base, r).reason, 'home', 'a folder that holds the home folder');
    for (const d of ['Desktop', 'Documents', 'Downloads']) assert.equal(checkProjectFolder(path.join(w.home, d), r).reason, 'broad', d);
    assert.equal(checkProjectFolder(path.join(w.home, 'desktop'), r).reason, 'broad', 'any letter case');
  });

  test('refused: the hub and anything inside it; the program folder, anything inside it and anything that holds it', () => {
    const w = world();
    const r = w.rules();
    assert.equal(checkProjectFolder(w.hub, r).reason, 'hub');
    assert.equal(checkProjectFolder(path.join(w.hub, 'registry'), r).reason, 'hub');
    assert.equal(checkProjectFolder(w.app, r).reason, 'program');
    fs.mkdirSync(path.join(w.app, 'resources'));
    assert.equal(checkProjectFolder(path.join(w.app, 'resources'), r).reason, 'program');
    const outer = path.join(w.base, 'outer');
    fs.mkdirSync(path.join(outer, 'program'), { recursive: true });
    assert.equal(checkProjectFolder(outer, { ...r, programDirs: [path.join(outer, 'program')] }).reason, 'program', 'a folder that holds the program');
  });

  test('refused: a folder that is a link (junction), and a folder reached through a junction into the hub', () => {
    const w = world();
    const target = w.dir('real');
    const link = path.join(w.work, 'link-to-real');
    junction(target, link);
    assert.equal(checkProjectFolder(link, w.rules()).reason, 'link');
    const intoHub = path.join(w.work, 'into-hub');
    junction(w.hub, intoHub);
    fs.mkdirSync(path.join(w.hub, 'looks-fine'), { recursive: true });
    assert.equal(checkProjectFolder(path.join(intoHub, 'looks-fine'), w.rules()).reason, 'hub', 'the real form is checked too');
  });

  test('refused: network, WSL and device paths (never touched), relative paths, stream names and reserved characters, a missing folder, a file', { skip: WINDOWS_ONLY }, () => {
    const w = world();
    const r = w.rules();
    let touched = 0;
    const spy = { ...r, lstat: (p) => (touched++, fs.lstatSync(p)), realpath: (p) => (touched++, fs.realpathSync.native(p)) };
    for (const p of ['\\\\server\\share\\proj', '\\\\wsl$\\Ubuntu\\home\\me\\proj', '\\\\wsl.localhost\\Ubuntu\\x', '\\\\?\\C:\\x', '\\\\.\\C:\\x', '//server/share']) {
      assert.equal(checkProjectFolder(p, spy).reason, 'network', p);
    }
    assert.equal(touched, 0, 'a network path is never checked on disk');
    for (const p of ['proj', '.\\proj', 'C:proj', '/proj']) assert.equal(checkProjectFolder(p, r).reason, 'not-local', p);
    for (const p of [`${w.work}\\a::$INDEX_ALLOCATION`, `${w.work}\\a:b`, `${w.work}\\a|b`, `${w.work}\\a\u0007b`]) assert.equal(checkProjectFolder(p, r).reason, 'invalid', JSON.stringify(p));
    for (const p of [undefined, null, 42, '', '   ', 'C:\\' + 'x'.repeat(1100)]) assert.equal(checkProjectFolder(p, r).reason, 'invalid', String(p).slice(0, 20));
    assert.equal(checkProjectFolder(path.join(w.work, 'nope'), r).reason, 'missing');
    const file = path.join(w.work, 'file.txt');
    fs.writeFileSync(file, 'x');
    assert.equal(checkProjectFolder(file, r).reason, 'not-folder');
  });
});

// ------------------------------------------------------------------ the picker flow
describe('shell: the folder picker as one flow', () => {
  const S = getStrings('tr');

  test('the picker: a folder, "New folder" allowed, the texts of the shell language; the folder chosen goes through the check, then to the server', async () => {
    const w = world();
    const d = w.dir('fresh');
    const seen = { options: null, added: [] };
    const r = await pickProjectFolder({
      S,
      showOpenDialog: async (options) => ((seen.options = options), { canceled: false, filePaths: [d] }),
      check: (f) => checkProjectFolder(f, w.rules()),
      add: async (f) => (seen.added.push(f), { ok: true, projectId: 'x-fresh', existed: false, reason: 'added' }),
    });
    assert.deepEqual(r, { ok: true, projectId: 'x-fresh', existed: false, reason: 'added' });
    assert.deepEqual(seen.added, [d]);
    assert.deepEqual(seen.options, projectFolderDialogOptions(S));
    assert.deepEqual(seen.options.properties.slice(0, 2), ['openDirectory', 'createDirectory']);
    assert.equal(seen.options.title, SHELL_STRINGS.tr.newProjectPickTitle);
    assert.equal(seen.options.buttonLabel, SHELL_STRINGS.tr.newProjectPickButton);
  });

  test('cancel, an empty answer, a refused folder or a failing dialog: nothing reaches the server', async () => {
    const w = world();
    let added = 0;
    const run = (answer) =>
      pickProjectFolder({
        S,
        showOpenDialog: typeof answer === 'function' ? answer : async () => answer,
        check: (f) => checkProjectFolder(f, w.rules()),
        add: async () => (added++, { ok: true, projectId: 'x' }),
      });
    assert.deepEqual(await run({ canceled: true, filePaths: [w.work] }), { ok: false, reason: 'cancelled' });
    assert.deepEqual(await run({ canceled: false, filePaths: [] }), { ok: false, reason: 'cancelled' });
    assert.deepEqual(await run(null), { ok: false, reason: 'cancelled' });
    assert.deepEqual(await run({ canceled: false, filePaths: [w.hub] }), { ok: false, reason: 'hub' });
    assert.deepEqual(await run({ canceled: false, filePaths: [w.home] }), { ok: false, reason: 'home' });
    assert.deepEqual(await run(async () => Promise.reject(new Error('no dialog'))), { ok: false, reason: 'error' });
    assert.equal(added, 0);
  });

  test('what the page gets back: the project id and whether it was listed already; never a path', () => {
    assert.deepEqual(projectReply({ ok: true, projectId: 'x-game', existed: true, saved: true, reason: 'added', path: 'C:\\Users\\me\\game' }), { ok: true, reason: 'added', projectId: 'x-game', existed: true });
    assert.deepEqual(projectReply({ ok: true, projectId: 'x-game', saved: false }), { ok: true, reason: 'saved', projectId: 'x-game', saved: false });
    assert.deepEqual(projectReply({ ok: false, reason: 'hub', projectId: 'x' }), { ok: false, reason: 'hub' }, 'no id with a refusal');
    for (const bad of [null, undefined, 'x', { ok: true }, { ok: true, projectId: 'C:\\Users\\me' }, { ok: true, projectId: '../x' }, { ok: false, reason: 'C:\\Users\\me\\x' }, { ok: false, reason: 'x'.repeat(40) }]) {
      const r = projectReply(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.reason, 'error');
      assert.doesNotMatch(JSON.stringify(r), /Users|\\\\/);
    }
  });
});

// ------------------------------------------------------------------ calls to the server process
describe('shell: calls to the server process over its message channel', () => {
  const target = () => {
    const t = { alive: true, sent: [], post: (m) => t.sent.push(m) };
    return t;
  };

  test('a call posts one request and settles with the reply of that very process', async () => {
    const calls = createServerCalls();
    const a = target();
    const b = target();
    const p = calls.call(a, 'project-add', { path: 'C:\\w\\x' });
    assert.equal(a.sent.length, 1);
    const msg = a.sent[0];
    assert.deepEqual({ ...msg, id: 0 }, { sibersentez: 'shell-call', id: 0, type: 'project-add', path: 'C:\\w\\x' });
    assert.ok(Number.isInteger(msg.id) && msg.id > 0);
    assert.equal(calls.receive(b, { sibersentez: 'shell-reply', id: msg.id, ok: true, projectId: 'x-evil' }), false, 'another process cannot answer');
    assert.equal(calls.receive(a, { sibersentez: 'other', id: msg.id }), false);
    assert.equal(calls.receive(a, null), false);
    assert.equal(calls.receive(a, { sibersentez: 'shell-reply', id: msg.id + 1, ok: true }), false, 'no such call');
    assert.equal(calls.receive(a, { sibersentez: 'shell-reply', id: msg.id, ok: true, projectId: 'x-x' }), true);
    assert.deepEqual(await p, { sibersentez: 'shell-reply', id: msg.id, ok: true, projectId: 'x-x' });
    assert.equal(calls.receive(a, { sibersentez: 'shell-reply', id: msg.id, ok: true }), false, 'answered once');
    assert.equal(calls.pending(), 0);
  });

  test('no server, a server that exits, a post that throws, no answer in time: the call settles with a reason', async () => {
    const calls = createServerCalls({ timeoutMs: 30 });
    assert.deepEqual(await calls.call(null, 'project-add'), { ok: false, reason: 'no-server' });
    assert.deepEqual(await calls.call({ alive: false, post() {} }, 'project-add'), { ok: false, reason: 'no-server' });
    const gone = target();
    const p = calls.call(gone, 'project-idea', { projectId: 'x', idea: 'y' });
    calls.drop(gone);
    assert.deepEqual(await p, { ok: false, reason: 'no-server' });
    assert.deepEqual(await calls.call({ alive: true, post: () => { throw new Error('closed'); } }, 'project-add'), { ok: false, reason: 'no-server' });
    assert.deepEqual(await calls.call(target(), 'project-add'), { ok: false, reason: 'timeout' });
    assert.equal(calls.pending(), 0);
  });
});

// ------------------------------------------------------------------ main.mjs wiring
describe('main.mjs: the new project is wired through the tested parts', () => {
  const src = textOf('electron', 'main.mjs');

  test('two more handlers; each checks the sender first; the picker is modal to the window, one at a time; the log names no folder', () => {
    assert.ok(src.includes('ipcMain.handle(PROJECT_PICK_IPC_CHANNEL, onPickProjectFolderRequest);'));
    assert.ok(src.includes('ipcMain.handle(PROJECT_IDEA_IPC_CHANNEL, onSaveProjectIdeaRequest);'));
    const pick = bodyOf(src, 'onPickProjectFolderRequest');
    assert.ok(pick.indexOf('bridgeSender(senderFacts(event))') < pick.indexOf('pickProjectFolder({'), 'the sender first');
    assert.ok(pick.includes("return projectReply({ ok: false, reason: 'refused' });"));
    assert.ok(pick.includes('if (state.pickingFolder) return'));
    assert.ok(pick.includes('showOpenDialog: (options) => dialog.showOpenDialog(win, options),'));
    assert.ok(pick.includes('check: (folder) => checkProjectFolder(folder, projectFolderRules()),'));
    assert.ok(pick.includes("add: (folder) => serverCalls.call(state.server, 'project-add', { path: folder }),"));
    assert.ok(pick.includes('return reply;') && pick.includes('const reply = projectReply(result);'), 'the page gets projectReply only');
    for (const line of pick.split('\n').filter((l) => l.includes('log('))) assert.doesNotMatch(line, /folder|path|filePaths/, `no folder in the log: ${line.trim()}`);
    const idea = bodyOf(src, 'onSaveProjectIdeaRequest');
    assert.ok(idea.indexOf('projectIdeaRequest({ projectId, text, ...senderFacts(event) })') < idea.indexOf('serverCalls.call('));
    assert.ok(idea.includes("serverCalls.call(state.server, 'project-idea', { projectId: check.projectId, idea: check.text })"), 'only the checked values');
    for (const line of idea.split('\n').filter((l) => l.includes('log('))) assert.doesNotMatch(line, /\$\{[^}]*\b(text|idea|projectId)\b[^}]*\}/, `the idea is never logged: ${line.trim()}`);
    const facts = bodyOf(src, 'senderFacts');
    assert.ok(facts.includes('mainWindow: Boolean(win && !win.isDestroyed() && event?.sender === win.webContents), frame: frameFacts(event?.senderFrame), origin: state.origin'));
    const rules = bodyOf(src, 'projectFolderRules');
    for (const needle of ['homeDir: HOME_DIR', 'hubPath: state.hubPath', 'programDirs: [path.dirname(process.execPath), app.getAppPath()]', "known('desktop')", "known('documents')", "known('downloads')"]) assert.ok(rules.includes(needle), needle);
  });

  test('both kinds of server process carry the message channel; only the current process answers its own calls; an exit drops its calls', () => {
    const spawnBody = bodyOf(src, 'spawnServer');
    assert.ok(spawnBody.includes('handle.post = (msg) => child.postMessage(msg);'), 'utilityProcess');
    assert.ok(spawnBody.includes('handle.post = (msg) => child.send(msg);'), 'the forked fallback');
    assert.equal((spawnBody.match(/child\.on\('message', \(msg\) => serverCalls\.receive\(handle, msg\)\);/g) || []).length, 2);
    assert.ok(bodyOf(src, 'onServerExit').includes('serverCalls.drop(handle);'));
  });

  test("the tray's New project hands one fixed script to the page (no data), like the actions hand-over", () => {
    assert.ok(bodyOf(src, 'refreshTrayMenu').includes('{ label: S.trayNewProject, click: () => startNewProjectFromTray()'));
    // The flow itself is the tested newProjectFromTray (the shell part at the end of this file)
    const tray = bodyOf(src, 'startNewProjectFromTray');
    assert.ok(tray.includes('return newProjectFromTray({'));
    assert.ok(tray.includes('windowReady: panelWindowReady(),'));
    assert.ok(tray.includes("show: () => showWindow('tray: new project'),"));
    assert.ok(tray.includes('handOver: () => settleWithin(() => win.webContents.executeJavaScript(NEW_PROJECT_SCRIPT), NEW_PROJECT_HANDOVER_MS, false),'));
    assert.ok(tray.includes('notify: showNewProjectNotReady,'));
    assert.equal(NEW_PROJECT_SCRIPT, "(() => { try { return window.sibersentezNewProject?.start?.() === true; } catch { return false; } })()");
    for (const lang of ['en', 'tr']) for (const k of ['trayNewProject', 'newProjectPickTitle', 'newProjectPickButton']) assert.ok(SHELL_STRINGS[lang][k]?.trim(), `${lang}.${k}`);
  });
});

// ------------------------------------------------------------------ the server: memory, catalog, channel
describe('server: the project memory keeps the idea', () => {
  test('only for a remembered folder; cleaned like the fit reads an idea; written at once; read back; cleared with an empty text', () => {
    const w = world();
    const file = path.join(w.hub, 'registry', 'discovered.json');
    const m = new ProjectMemory({ hubDir: w.hub, debounceMs: 60000 });
    const d = w.dir('a');
    assert.deepEqual(m.setIdea(d, 'x'), { ok: false, reason: 'not-in-memory' }, 'an idea never creates an entry');
    m.record(d, { via: SIBERSENTEZ_VIA });
    assert.equal(m.flush(), true);
    const r = m.setIdea(d, '  Unity\u0000ile\t2D\u200b platform\u202e oyunu  ');
    assert.deepEqual(r, { ok: true, idea: 'Unity ile 2D platform oyunu', changed: true, saved: true });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects[0].idea, 'Unity ile 2D platform oyunu', 'written at once, not after the debounce');
    assert.deepEqual(m.setIdea(d.toUpperCase(), 'Unity ile 2D platform oyunu'), { ok: true, idea: 'Unity ile 2D platform oyunu', changed: false, saved: true }, 'same idea, any spelling of the folder: no write');
    const long = 'ğ'.repeat(IDEA_MAX + 50);
    assert.equal(m.setIdea(d, long).idea, 'ğ'.repeat(IDEA_MAX), `at most ${IDEA_MAX} characters`);
    assert.deepEqual(m.setIdea(d, 'x'.repeat(IDEA_TEXT_MAX + 1)), { ok: false, reason: 'invalid' });
    assert.deepEqual(m.setIdea(d, 42), { ok: false, reason: 'invalid' });
    assert.equal(new ProjectMemory({ hubDir: w.hub }).list()[0].idea, 'ğ'.repeat(IDEA_MAX), 'read back by a new process');
    assert.equal(m.setIdea(d, '').idea, '');
    assert.equal('idea' in JSON.parse(fs.readFileSync(file, 'utf8')).projects[0], false, 'no idea, no key');
    // A hand-edited file is cleaned on load
    fs.writeFileSync(file, JSON.stringify({ version: 1, projects: [{ path: d, via: ['sibersentez'], idea: `a\u0001b${'c'.repeat(400)}` }] }));
    const idea = new ProjectMemory({ hubDir: w.hub }).list()[0].idea;
    assert.equal(Array.from(idea).length, IDEA_MAX);
    assert.ok(idea.startsWith('a b'));
  });
});

describe('server: which folder can be a project (catalog rules) and adding it', () => {
  test('an ordinary folder becomes a listed project with via sibersentez, in the project memory; the registry is untouched; the same folder again opens it', () => {
    const w = world();
    const registry = fs.readFileSync(path.join(w.hub, 'registry', 'projects.json'), 'utf8');
    const c = w.catalog();
    const d = w.dir('My Game');
    const r = c.addProjectFolder(d);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.existed, false);
    assert.equal(r.saved, true);
    assert.match(r.projectId, PROJECT_ID_RE);
    const p = c.getProject(r.projectId);
    assert.equal(p.kind, 'adhoc');
    assert.equal(p.path, d);
    assert.ok(p.via.includes('sibersentez'));
    assert.match(p.description, /SiberSentez/);
    const saved = JSON.parse(fs.readFileSync(path.join(w.hub, 'registry', 'discovered.json'), 'utf8'));
    assert.deepEqual(saved.projects.map((e) => [e.path, e.via]), [[d, ['sibersentez']]]);
    assert.equal(fs.readFileSync(path.join(w.hub, 'registry', 'projects.json'), 'utf8'), registry, "the user's registry is never written");
    // A new process lists it from the memory
    const again = w.catalog();
    const listed = again.allProjects().find((x) => x.path === d);
    assert.ok(listed);
    assert.equal(listed.id, r.projectId);
    assert.deepEqual(listed.via, ['sibersentez']);
    const view = projectView(new Ingest(again), listed);
    assert.deepEqual([view.id, view.via, view.idea], [r.projectId, ['sibersentez'], null]);
    assert.deepEqual(again.addProjectFolder(d), { ok: true, projectId: r.projectId, existed: true, saved: true, reason: 'existing' });
    assert.deepEqual(again.addProjectFolder(path.join(d, 'src') + (fs.mkdirSync(path.join(d, 'src')), '')).projectId, r.projectId, 'a folder inside it opens it');
  });

  test('fresh (a folder just made for a new project, review U05): inside a listed project it is refused before anything is remembered; its own folder made again is added', () => {
    const w = world();
    const c = w.catalog();
    const d = w.dir('Site');
    const first = c.addProjectFolder(d, { fresh: true });
    assert.deepEqual([first.ok, first.existed, first.reason], [true, false, 'added']);
    const inner = w.dir('Site', 'Blog');
    assert.deepEqual(c.addProjectFolder(inner, { fresh: true }), { ok: false, reason: 'inside-project' });
    const remembered = JSON.parse(fs.readFileSync(path.join(w.hub, 'registry', 'discovered.json'), 'utf8')).projects.map((e) => e.path);
    assert.deepEqual(remembered, [d], 'the refused folder is not remembered');
    // Without fresh the old rule stays: a folder inside it opens it
    assert.equal(c.addProjectFolder(inner).projectId, first.projectId);
    // The project's own folder, deleted and made again: it is that project, new on disk (not "already listed")
    const again = c.addProjectFolder(d, { fresh: true });
    assert.deepEqual([again.ok, again.projectId, again.existed, again.reason], [true, first.projectId, false, 'added']);
    // Over the channel: fresh only when the shell says exactly true
    const seen = [];
    const ch = createProjectChannel({ catalog: { addProjectFolder: (p, o) => (seen.push(o.fresh), { ok: false, reason: 'x' }) } });
    ch.handle({ sibersentez: 'shell-call', id: 1, type: 'project-add', path: d, fresh: true });
    ch.handle({ sibersentez: 'shell-call', id: 2, type: 'project-add', path: d, fresh: 'yes' });
    ch.handle({ sibersentez: 'shell-call', id: 3, type: 'project-add', path: d });
    assert.deepEqual(seen, [true, false, false]);
  });

  test('a registered project folder opens the registered project', () => {
    const w = world();
    const d = w.dir('registered');
    fs.writeFileSync(path.join(w.hub, 'registry', 'projects.json'), JSON.stringify({ projects: [{ id: 'reg-one', name: 'Reg', path: d }] }));
    const c = w.catalog();
    assert.deepEqual(c.addProjectFolder(d), { ok: true, projectId: 'reg-one', existed: true, saved: true, reason: 'existing' });
    assert.ok(c.getProject('reg-one').via.includes('sibersentez'));
  });

  test('refused: home, its parents, Desktop, AppData, the hub, the personal Claude folder, the program folder, links, missing folders, network paths, a folder holding listed projects', { skip: WINDOWS_ONLY }, () => {
    const w = world();
    const c = w.catalog();
    const add = (p, o) => c.addProjectFolder(p, o).reason;
    assert.equal(add(w.home), 'home');
    assert.equal(add(w.base), 'home');
    assert.equal(add(path.parse(w.base).root), 'drive-root');
    for (const d of ['Desktop', 'Documents', 'Downloads']) assert.equal(add(path.join(w.home, d)), 'broad', d);
    assert.equal(add(path.join(w.home, 'AppData', 'Local', 'x')), 'broad', 'AppData and below');
    assert.equal(add(w.hub), 'hub');
    assert.equal(add(path.join(w.hub, 'registry')), 'hub');
    assert.equal(add(w.claude), 'personal');
    assert.equal(add(w.app, { appDir: w.app }), 'program');
    assert.equal(add(w.dir('holder'), { appDir: path.join(w.work, 'holder', 'program') }), 'program', 'a folder that holds the program');
    const link = path.join(w.work, 'link');
    junction(w.dir('target'), link);
    assert.equal(add(link), 'link');
    const intoHub = path.join(w.work, 'into-hub');
    junction(w.hub, intoHub);
    assert.equal(add(path.join(intoHub, 'registry')), 'hub', 'through a junction into the hub');
    assert.equal(add(path.join(w.work, 'missing')), 'missing');
    fs.writeFileSync(path.join(w.work, 'f.txt'), 'x');
    assert.equal(add(path.join(w.work, 'f.txt')), 'missing');
    assert.equal(add('\\\\server\\share\\x'), 'network');
    assert.equal(add('relative\\x'), 'not-local');
    assert.equal(add(`${w.work}\\x::$DATA`), 'invalid');
    assert.equal(add(42), 'invalid');
    // A folder that holds a listed project would take it over
    const outer = w.dir('outer');
    assert.equal(c.addProjectFolder(w.dir('outer', 'inner')).ok, true);
    assert.equal(add(outer), 'holds-projects');
    assert.equal(c.memory.list().filter((m) => m.via.includes('sibersentez')).length, 1, 'nothing refused was remembered');
  });

  test('refused as broad: the Windows folder, the program folders and ProgramData with everything below them, a OneDrive root itself (a folder inside OneDrive is fine); variable names in any letter case; also through a junction', { skip: WINDOWS_ONLY }, () => {
    assert.deepEqual([...SYSTEM_TREE_VARS], ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData'], 'the list the shell uses too');
    assert.deepEqual([...ONEDRIVE_ROOT_VARS], ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']);
    const w = world();
    const sys = (...p) => {
      const d = path.join(w.base, 'sys', ...p);
      fs.mkdirSync(d, { recursive: true });
      return d;
    };
    const env = { systemroot: sys('Windows'), ProgramFiles: sys('Program Files'), 'PROGRAMFILES(X86)': sys('Program Files (x86)'), ProgramData: sys('ProgramData'), OneDrive: sys('OneDrive'), OneDriveConsumer: sys('OneDrive Home'), OneDriveCommercial: sys('OneDrive - Work'), ONEDRIVE_X: 'not a folder rule' };
    const c = new Catalog({ hubDir: w.hub, claudeDir: w.claude, homeDir: w.home, adapters: [], env, memory: new ProjectMemory({ hubDir: w.hub, debounceMs: 0 }) });
    c.load();
    const add = (p) => c.addProjectFolder(p).reason;
    for (const d of [env.systemroot, sys('Windows', 'Temp', 'x'), env.ProgramFiles, sys('Program Files', 'App'), env['PROGRAMFILES(X86)'], sys('Program Files (x86)', 'Old App', 'data'), env.ProgramData, sys('ProgramData', 'Vendor'), env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial]) {
      assert.equal(add(d), 'broad', d);
    }
    // Any spelling of the folder
    assert.equal(add(env.ProgramData.toUpperCase()), 'broad');
    // Through a junction: the real form is checked too
    const alias = path.join(w.work, 'alias-of-windows');
    junction(env.systemroot, alias);
    sys('Windows', 'sub');
    assert.equal(add(path.join(alias, 'sub')), 'broad', 'a folder whose real form is inside the Windows folder');
    // Inside OneDrive a project folder is fine; so is a folder next to the system folders
    const site = sys('OneDrive', 'Projects', 'site');
    assert.equal(c.addProjectFolder(site).ok, true);
    assert.equal(c.addProjectFolder(sys('Tools')).ok, true, 'a sibling of the system folders');
    assert.equal(c.memory.list().filter((m) => m.via.includes('sibersentez')).length, 2, 'nothing refused was remembered');
    // Without these variables (a catalog with no environment) none of them is a rule
    assert.equal(w.catalog().addProjectFolder(sys('Program Files', 'Elsewhere')).ok, true);
  });

  test('refused as hub: a folder that holds the hub, also through a junction (the hub rule works both ways)', () => {
    const w = world();
    const outer = w.dir('outer-hub');
    const hub = path.join(outer, 'hub');
    initHub(hub);
    const c = new Catalog({ hubDir: hub, claudeDir: w.claude, homeDir: w.home, adapters: [], env: {}, memory: new ProjectMemory({ hubDir: hub, debounceMs: 0 }) });
    c.load();
    assert.deepEqual(c.addProjectFolder(outer), { ok: false, reason: 'hub' });
    assert.deepEqual(c.addProjectFolder(hub), { ok: false, reason: 'hub' });
    assert.deepEqual(c.addProjectFolder(path.join(hub, 'registry')), { ok: false, reason: 'hub' });
    const alias = path.join(w.base, 'alias-of-work');
    junction(w.work, alias);
    assert.deepEqual(c.addProjectFolder(path.join(alias, 'outer-hub')), { ok: false, reason: 'hub' }, 'its real form holds the hub');
    assert.equal(c.addProjectFolder(w.dir('outer-hub-sibling')).ok, true, 'a folder next to it is fine');
  });
});

describe('server: the idea of a project', () => {
  test('kept for a project the memory holds; shown on the project (catalog and view); read back after a restart; never for an unknown or unremembered project', () => {
    const w = world();
    const d = w.dir('shop');
    const reg = w.dir('registered-never-seen');
    fs.writeFileSync(path.join(w.hub, 'registry', 'projects.json'), JSON.stringify({ projects: [{ id: 'reg-x', name: 'Reg', path: reg }] }));
    const c = w.catalog();
    const { projectId } = c.addProjectFolder(d);
    assert.deepEqual(c.setProjectIdea(projectId, 'Next.js ile online\u0000mağaza'), { ok: true, projectId, changed: true, saved: true });
    assert.equal(c.getProject(projectId).idea, 'Next.js ile online mağaza');
    assert.deepEqual(c.setProjectIdea(projectId, 'Next.js ile online mağaza'), { ok: true, projectId, changed: false, saved: true });
    assert.deepEqual(c.setProjectIdea('x-unknown', 'idea'), { ok: false, reason: 'not-a-project' });
    assert.deepEqual(c.setProjectIdea('reg-x', 'idea'), { ok: false, reason: 'not-in-memory' }, 'a project the memory does not hold');
    assert.deepEqual(c.setProjectIdea('../x', 'idea'), { ok: false, reason: 'invalid' });
    assert.deepEqual(c.setProjectIdea(projectId, 'x'.repeat(IDEA_TEXT_MAX + 1)), { ok: false, reason: 'invalid' });
    const again = w.catalog();
    const p = again.getProject(projectId);
    assert.equal(p.idea, 'Next.js ile online mağaza', 'read back from discovered.json');
    assert.equal(projectView(new Ingest(again), p).idea, 'Next.js ile online mağaza');
    assert.equal(again.getProject('reg-x').idea, undefined);
    assert.equal(again.setProjectIdea(projectId, '').ok, true);
    assert.equal(again.getProject(projectId).idea, undefined, 'cleared');
    again.load();
    assert.equal(projectView(new Ingest(again), again.getProject(projectId)).idea, null);
  });
});

describe('server: the message channel (createProjectChannel)', () => {
  test('answers requests only; a reply carries the id, never the path or the idea; a change reloads the catalog', () => {
    const w = world();
    const c = w.catalog();
    const changes = [];
    const ch = createProjectChannel({ catalog: c, appDir: w.app, onChange: (type, projectId) => changes.push([type, projectId]) });
    for (const msg of [null, undefined, 'x', 42, {}, { sibersentez: 'shell-reply', id: 1 }, { sibersentez: 'shell-call' }, { sibersentez: 'shell-call', id: 0 }, { sibersentez: 'shell-call', id: '1' }, { sibersentez: 'shell-call', id: 1.5 }]) {
      assert.equal(ch.handle(msg), null, JSON.stringify(msg));
    }
    assert.deepEqual(ch.handle({ sibersentez: 'shell-call', id: 1, type: 'project-remove' }), { sibersentez: 'shell-reply', id: 1, ok: false, reason: 'unknown-request' });
    const d = w.dir('channel-proj');
    const added = ch.handle({ sibersentez: 'shell-call', id: 2, type: 'project-add', path: d });
    assert.equal(added.ok, true);
    assert.deepEqual(Object.keys(added).sort(), ['existed', 'id', 'ok', 'projectId', 'reason', 'saved', 'sibersentez']);
    assert.equal(added.reason, 'added');
    assert.doesNotMatch(JSON.stringify(added), /\\/, 'no path (the id is the usual folder-name id)');
    assert.deepEqual(ch.handle({ sibersentez: 'shell-call', id: 3, type: 'project-add', path: w.app }), { sibersentez: 'shell-reply', id: 3, ok: false, reason: 'program' });
    const idea = ch.handle({ sibersentez: 'shell-call', id: 4, type: 'project-idea', projectId: added.projectId, idea: 'Python ile Telegram botu' });
    assert.equal(idea.ok, true);
    assert.doesNotMatch(JSON.stringify(idea), /Telegram/, 'the idea does not come back');
    ch.handle({ sibersentez: 'shell-call', id: 5, type: 'project-idea', projectId: added.projectId, idea: 'Python ile Telegram botu' });
    assert.deepEqual(changes, [['project-add', added.projectId], ['project-idea', added.projectId]], 'only real changes, with the project they changed');
    const broken = createProjectChannel({ catalog: { addProjectFolder: () => { throw new Error('C:\\secret'); } } });
    assert.deepEqual(broken.handle({ sibersentez: 'shell-call', id: 6, type: 'project-add', path: 'C:\\x' }), { sibersentez: 'shell-reply', id: 6, ok: false, reason: 'error' });
  });

  test('after a change (shellChangeHandler): a new project reloads the catalog and drops every fit; an idea drops only the fits of its own project and marks it for the next patch, without a reload', () => {
    const calls = [];
    const onChange = shellChangeHandler({ reload: () => calls.push('reload'), invalidateFit: (...a) => calls.push(['invalidate', ...a]), markProject: (id) => calls.push(['mark', id]) });
    onChange('project-add', 'x-new');
    assert.deepEqual(calls.splice(0), [['invalidate'], 'reload']);
    onChange('project-idea', 'x-game');
    assert.deepEqual(calls.splice(0), [['invalidate', 'x-game'], ['mark', 'x-game']], 'no catalog reload, one project only');
    onChange('project-idea');
    assert.deepEqual(calls.splice(0), [['invalidate'], 'reload'], 'an idea change without a project falls back to the full reload');
    // index.mjs wires it to the fit service, the catalog reload and the ingest's dirty projects (sent by takePatch)
    const src = textOf('server', 'index.mjs');
    const wiring = src.slice(src.indexOf('const projectChannel = createProjectChannel({'), src.indexOf('function answerShell('));
    assert.ok(wiring.includes('onChange: shellChangeHandler({'));
    assert.ok(wiring.includes('reload: reloadCatalog,'));
    assert.ok(wiring.includes('invalidateFit: (projectId) => fit.invalidate(projectId),'));
    assert.ok(wiring.includes('markProject: (projectId) => ingest.dirty.projects.add(projectId),'));
    assert.doesNotMatch(wiring, /catalog\.load\(\)|fit\.invalidate\(\)/, 'no full reload or full fit drop of its own');
  });

  test('index.mjs listens only on the channel its parent gave it; app.mjs has no route for these writes', () => {
    const src = textOf('server', 'index.mjs');
    assert.ok(src.includes("if (process.parentPort && typeof process.parentPort.on === 'function') {"));
    assert.ok(src.includes("process.parentPort.on('message', (e) => answerShell(e?.data, (reply) => process.parentPort.postMessage(reply)));"));
    assert.ok(src.includes("} else if (typeof process.send === 'function') {"));
    assert.ok(src.includes("process.on('message', (msg) => answerShell(msg, (reply) => process.send(reply)));"));
    assert.ok(src.includes('const projectChannel = createProjectChannel({'));
    const app = textOf('server', 'app.mjs');
    assert.doesNotMatch(app, /project-add|project-idea|addProjectFolder|setProjectIdea|createProjectChannel/);
    assert.doesNotMatch(textOf('server', 'actions.mjs'), /addProjectFolder|setProjectIdea|createProjectChannel/);
  });
});

// A forked server with a fake home and a temporary hub: the same message channel the desktop shell's development
// fallback uses (utilityProcess speaks the same messages through process.parentPort)
describe('server end to end: a forked server adds a project and keeps its idea', () => {
  const freePort = () =>
    new Promise((resolve, reject) => {
      const s = net.createServer();
      s.unref();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
  const getJson = (port, url) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: url, headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (d) => (text += d));
          res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
        })
        .on('error', reject);
    });

  // The server's event stream: until(pred) waits for the first event (seen or still to come) that pred accepts
  const openStream = (port) => {
    const events = [];
    const waiters = [];
    let buf = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = { event: 'message', data: '' };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data += line.slice(6);
          }
          events.push(ev);
          for (const w of [...waiters]) if (w.pred(ev)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(ev));
        }
      });
    });
    req.on('error', () => {});
    return {
      until: (pred, what, timeoutMs = 10000) =>
        new Promise((resolve, reject) => {
          const seen = events.find(pred);
          if (seen) return resolve(seen);
          const w = { pred, resolve };
          waiters.push(w);
          setTimeout(() => reject(new Error(`no event: ${what}`)), timeoutMs).unref();
        }),
      close: () => req.destroy(),
    };
  };

  test('project-add and project-idea over the ipc channel; the project list shows it with its idea; the user registry is untouched', async (ctx) => {
    const w = world();
    const project = w.dir('e2e-game');
    const registry = fs.readFileSync(path.join(w.hub, 'registry', 'projects.json'), 'utf8');
    const appDir = path.join(w.base, 'app-copy');
    for (const d of ['server', 'public']) fs.cpSync(path.join(ROOT, d), path.join(appDir, d), { recursive: true });
    const fakeRoaming = path.join(w.base, 'AppData', 'Roaming');
    const fakeLocal = path.join(w.base, 'AppData', 'Local');
    fs.mkdirSync(fakeRoaming, { recursive: true });
    fs.mkdirSync(fakeLocal, { recursive: true });
    const userEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), USERPROFILE: w.home, HOME: w.home, APPDATA: fakeRoaming, LOCALAPPDATA: fakeLocal };
    const port = await freePort();
    const instance = `np-${process.pid}`;
    const child = fork(path.join(appDir, 'server', 'index.mjs'), [], { cwd: appDir, env: buildServerEnv(userEnv, { port, hubPath: w.hub, instance }), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [], windowsHide: true });
    const output = [];
    child.stdout.on('data', (d) => output.push(String(d)));
    child.stderr.on('data', (d) => output.push(String(d)));
    const exited = new Promise((resolve) => child.once('exit', resolve));
    ctx.after(async () => {
      if (child.exitCode === null) child.kill();
      await exited;
    });
    assert.equal(await waitForServer(port, { instance, timeoutMs: 20000, intervalMs: 100 }), 'ready', output.join(''));
    const calls = createServerCalls({ timeoutMs: 10000 });
    const handle = { alive: true, post: (m) => child.send(m) };
    child.on('message', (m) => calls.receive(handle, m));

    const added = await calls.call(handle, 'project-add', { path: project });
    assert.equal(added.ok, true, JSON.stringify(added) + output.join(''));
    assert.equal(added.existed, false);
    const refused = await calls.call(handle, 'project-add', { path: w.home });
    assert.deepEqual([refused.ok, refused.reason], [false, 'home']);
    const snap = (await getJson(port, '/api/snapshot')).json;
    const listed = snap.projects.find((p) => p.id === added.projectId);
    assert.ok(listed, 'listed at once');
    assert.deepEqual([listed.path, listed.via, listed.idea], [project, ['sibersentez'], null]);
    // The page's live stream: the idea reaches it as a patch of that one project (no catalog reload is needed)
    const stream = openStream(port);
    ctx.after(() => stream.close());
    await stream.until((ev) => ev.event === 'hello', 'the stream is open');
    const idea = await calls.call(handle, 'project-idea', { projectId: added.projectId, idea: 'Unity ile 2D platform oyunu' });
    assert.equal(idea.ok, true);
    const patch = await stream.until((ev) => ev.event === 'patch' && JSON.parse(ev.data).projects.some((p) => p.id === added.projectId), 'a patch with the project');
    const patched = JSON.parse(patch.data).projects.find((p) => p.id === added.projectId);
    assert.equal(patched.idea, 'Unity ile 2D platform oyunu');
    const after = (await getJson(port, '/api/snapshot')).json.projects.find((p) => p.id === added.projectId);
    assert.equal(after.idea, 'Unity ile 2D platform oyunu');
    // Its fit without ?idea (the card's badge) reads the saved idea; an explicit empty ?idea= does not
    const saved = (await getJson(port, `/api/projects/${added.projectId}/fit`)).json;
    assert.ok(saved.project.idea.tags.some((g) => g.id === 'unity'), JSON.stringify(saved.project));
    assert.equal((await getJson(port, `/api/projects/${added.projectId}/fit?idea=`)).json.project.idea, undefined);
    const disk = JSON.parse(fs.readFileSync(path.join(w.hub, 'registry', 'discovered.json'), 'utf8'));
    assert.deepEqual(disk.projects.map((e) => [e.path, e.via, e.idea]), [[project, ['sibersentez'], 'Unity ile 2D platform oyunu']]);
    assert.equal(fs.readFileSync(path.join(w.hub, 'registry', 'projects.json'), 'utf8'), registry);
    assert.doesNotMatch(output.join(''), /Unity ile 2D|e2e-game/, 'neither the idea nor the folder is logged');
  });
});

// ------------------------------------------------------------------ the page
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

describe('page: the new-project flow', () => {
  test('the bridge is the one with both functions; a page without it has none', () => {
    const b = { pickProjectFolder() {}, saveProjectIdea() {}, setActionsMode() {} };
    assert.equal(projectBridge({ sibersentezShell: b }), b);
    for (const win of [undefined, null, {}, { sibersentezShell: null }, { sibersentezShell: { setActionsMode() {} } }, { sibersentezShell: { pickProjectFolder() {} } }]) assert.equal(projectBridge(win), null);
  });

  test('every reason the shell or the server can give has a plain text in both languages; a folder reason says the folder cannot be a project', () => {
    const folder = ['network', 'not-local', 'invalid', 'drive-root', 'home', 'broad', 'hub', 'program', 'personal', 'link', 'missing', 'not-folder', 'holds-projects'];
    const request = ['busy', 'refused', 'no-server', 'timeout', 'error'];
    inLanguages((lang, S) => {
      for (const reason of [...folder, ...request]) {
        assert.ok(S[`npErr_${reason}`]?.trim(), `${lang}: npErr_${reason}`);
        const out = newProjectOutcome({ ok: false, reason });
        assert.equal(out.projectId, null);
        assert.equal(out.toast.tone, 'err');
        assert.equal(out.toast.title, folder.includes(reason) ? S.npFailTitle : S.npErrorTitle, reason);
        assert.equal(out.toast.body, S[`npErr_${reason}`]);
      }
      assert.equal(newProjectOutcome({ ok: false, reason: 'something-new' }).toast.body, S.npErr_error, 'an unknown reason');
      assert.deepEqual(newProjectOutcome({ ok: false, reason: 'cancelled' }), { projectId: null, toast: null }, 'cancel says nothing');
      const ok = newProjectOutcome({ ok: true, projectId: 'x-game', existed: false }, () => 'Game');
      assert.deepEqual(ok, { projectId: 'x-game', toast: { tone: 'ok', title: S.npAdded.replace('{name}', 'Game'), body: S.npNextIdea } });
      assert.equal(newProjectOutcome({ ok: true, projectId: 'x-game', existed: true }, () => 'Game').toast.title, S.npExisting.replace('{name}', 'Game'));
    });
    assert.equal(STRINGS.tr.npAppOnlyTitle, 'Bu işlem SiberSentez uygulamasında yapılır');
  });

  test('without the bridge (a browser) the button explains; with it: pick -> wait for the list -> open the drawer at the idea box -> tell', async () => {
    const toasts = [];
    const none = createNewProjectFlow({ bridge: null, toast: (o) => toasts.push(o) });
    assert.equal(await none.start(), 'unavailable');
    assert.deepEqual(toasts, [{ tone: 'dry', title: t('npAppOnlyTitle'), body: t('npAppOnlyBody') }]);

    const listed = new Set();
    const opened = [];
    let refreshed = 0;
    let picks = 0;
    const flow = createNewProjectFlow({
      bridge: { pickProjectFolder: async () => (picks++, { ok: true, projectId: 'x-new', existed: false }), saveProjectIdea: async () => ({ ok: true }) },
      toast: (o) => toasts.push(o),
      openProject: (id) => opened.push(id),
      hasProject: (id) => listed.has(id),
      refresh: async () => (refreshed++, listed.add('x-new')),
      nameOf: (id) => (id === 'x-new' ? 'New' : id),
      wait: async () => {},
      waitMs: 300,
      stepMs: 100,
    });
    const first = flow.start();
    assert.equal(await flow.start(), 'busy', 'one picker at a time');
    assert.equal(await first, 'opened');
    assert.equal(picks, 1);
    assert.equal(refreshed, 1, 'the list was loaded again when the project did not show up in time');
    assert.deepEqual(opened, ['x-new']);
    assert.equal(toasts.at(-1).title, t('npAdded', { name: 'New' }));
    // Listed at once: no reload
    const flow2 = createNewProjectFlow({ bridge: { pickProjectFolder: async () => ({ ok: true, projectId: 'x-new', existed: true }), saveProjectIdea() {} }, toast: (o) => toasts.push(o), openProject: (id) => opened.push(id), hasProject: () => true, refresh: async () => refreshed++ });
    assert.equal(await flow2.start(), 'opened');
    assert.equal(refreshed, 1);
    // Cancel, a refusal, a throwing bridge
    const said = toasts.length;
    const answer = (r) => createNewProjectFlow({ bridge: { pickProjectFolder: typeof r === 'function' ? r : async () => r, saveProjectIdea() {} }, toast: (o) => toasts.push(o), openProject: (id) => opened.push(id) }).start();
    assert.equal(await answer({ ok: false, reason: 'cancelled' }), 'cancelled');
    assert.equal(toasts.length, said, 'cancel says nothing');
    assert.equal(await answer({ ok: false, reason: 'broad' }), 'failed');
    assert.equal(toasts.at(-1).body, t('npErr_broad'));
    assert.equal(await answer(async () => Promise.reject(new Error('x'))), 'failed');
    assert.equal(toasts.at(-1).body, t('npErr_error'));
    assert.deepEqual(opened, ['x-new', 'x-new'], 'nothing opened after a refusal');
  });

  test('the QA stand-in never reaches the shell: pick answers with the first project, anything else refuses', async () => {
    assert.deepEqual(await qaProjectBridge('pick', () => 'x-a').pickProjectFolder(), { ok: true, projectId: 'x-a', existed: false, reason: 'added' });
    assert.deepEqual(await qaProjectBridge('pick', () => null).pickProjectFolder(), { ok: false, reason: 'missing' });
    assert.deepEqual(await qaProjectBridge('hub').pickProjectFolder(), { ok: false, reason: 'hub' });
  });

  test('main.js: the header button, the start card and the tray reach the same flow; the tray only with the real bridge', () => {
    const main = textOf('public', 'js', 'main.js');
    assert.ok(main.includes("newProjectBtn.addEventListener('click', () => newProject.start());"));
    assert.ok(main.includes('createProjectsView($(\'#projectsBody\'), open, { onNewProject: () => newProject.start() })'));
    assert.ok(main.includes('if (projectShell && !QA_NEW) window.sibersentezNewProject = Object.freeze({ start: () => (newProject.start(), true) });'));
    assert.ok(main.includes('keepIdea: projectShell ? (id, text) => projectShell.saveProjectIdea(id, text) : undefined,'));
    assert.ok(main.includes("open({ type: 'project', id, section: 'skills' });"), 'the drawer opens at the idea box');
    const html = textOf('public', 'index.html');
    assert.ok(html.indexOf('id="newProjectBtn"') < html.indexOf('id="actMode"'), 'left of the Actions indicator');
    assert.match(html, /<button type="button" class="chip chip-btn new-proj" id="newProjectBtn" hidden><\/button>/);
  });
});

describe('page: the Getting started card', () => {
  const P = (id, extra = {}) => ({ id, name: id, path: `C:\\w\\${id}`, exists: true, kind: 'adhoc', ...extra });

  test(`shown while ${START_CARD_MAX} or fewer of the user's own projects are listed, until hidden`, () => {
    assert.equal(startCardVisible(new Map(), false), true);
    const two = new Map([P('a'), P('b')].map((p) => [p.id, p]));
    assert.equal(startCardVisible(two, false), true);
    assert.equal(startCardVisible(two, true), false, 'hidden for good');
    const three = new Map([P('a'), P('b'), P('c')].map((p) => [p.id, p]));
    assert.equal(startCardVisible(three, false), false);
    const noise = [P('home', { broad: true }), P('tmp', { tmpOnly: true, path: null }), P('gone', { exists: false }), P('old', { kind: 'hub' })];
    assert.deepEqual(ownProjects([...noise, P('mine')]).map((p) => p.id), ['mine'], 'broad, temp-only, missing and hub entries do not count');
    assert.equal(startCardVisible([...noise, P('a'), P('b')], false), true);
  });

  test('three plain steps, the New project button and "Don\'t show again"', () => {
    inLanguages((lang, S) => {
      const html = startCardHtml();
      // Step 3 is "Start with AI" now (docs/ai-start.md): pick an AI tool, SiberSentez starts it with the idea
      for (const k of ['startCardTitle', 'startCardStep1', 'startCardStep2', 'aiStartCardStep3', 'newProjectButton', 'startCardHide']) assert.ok(html.includes(S[k].replace(/'/g, '&#39;').replace(/"/g, '&quot;')) || html.includes(S[k]), `${lang}: ${k}`);
      assert.ok(html.includes('data-start-act="new"') && html.includes('data-start-act="hide"'));
      assert.equal((html.match(/<li>/g) || []).length, 3);
    });
    assert.equal(STRINGS.tr.startCardStep2, 'Ne yapmak istediğini yaz, SiberSentez uygun skill’leri seçsin');
  });
});

describe('page: the idea kept with the project, and "Then: open a terminal"', () => {
  test("the project's stored idea wins over this browser's copy, unless the person typed in this page", () => {
    const st = { idea: 'old browser idea', ideaWanted: 'old browser idea' };
    assert.equal(adoptHubIdea(st, 'Unity ile 2D platform oyunu'), true);
    assert.deepEqual([st.idea, st.ideaWanted, st.hubIdea], ['Unity ile 2D platform oyunu', 'Unity ile 2D platform oyunu', 'Unity ile 2D platform oyunu']);
    assert.equal(adoptHubIdea(st, 'Unity ile 2D platform oyunu'), false, 'the same stored idea again: nothing to do');
    const typing = { idea: 'what I type now', ideaTouched: true };
    assert.equal(adoptHubIdea(typing, 'an older stored idea'), false);
    assert.equal(typing.idea, 'what I type now');
    for (const hub of [null, undefined, '', '   ']) assert.equal(adoptHubIdea({ idea: 'kept' }, hub), false, `${hub}: no stored idea, the browser copy stays`);
    const same = { idea: 'Unity' };
    assert.equal(adoptHubIdea(same, ' Unity '), false);
    assert.equal(cleanIdea(' a\u0000b '), 'a b');
  });

  test('the terminal button is always there for a project with a folder; off and preview say why; preview offers "Change actions" (off: the drawer banner does); live does not', () => {
    const p = { id: 'x-game', name: 'Game', path: 'C:\\w\\game', exists: true, kind: 'adhoc' };
    inLanguages((lang, S) => {
      const live = startNextHtml(p, null, 'live');
      assert.ok(live.includes('data-menu-act="terminal" data-menu-type="project" data-menu-id="x-game"'), 'the context menu\'s terminal action');
      assert.doesNotMatch(live, /aria-disabled/);
      // "Then: start with AI" (docs/ai-start.md) keeps the plain terminal and the texts of preview and off
      assert.ok(live.includes(S.aiWhyLive));
      assert.doesNotMatch(live, /data-fit-act="chooser"/);
      for (const [mode, key] of [['dry', 'startNextDry'], ['off', 'startNextOff']]) {
        const h = startNextHtml(p, null, mode);
        assert.ok(h.includes(S[key].replace(/"/g, '&quot;')) || h.includes(S[key]), `${lang} ${mode}`);
        assert.equal(h.includes('data-fit-act="chooser"'), mode === 'dry', `${mode}: Change actions only in preview`);
        assert.equal(/data-menu-act="terminal"[^>]*aria-disabled="true"/.test(h), mode === 'off', `${mode}: the button is disabled only while off`);
      }
      assert.ok(live.includes(S.aiPlainTerminal));
      assert.ok(live.includes(S.aiStartTitle));
    });
    for (const q of [null, { ...p, path: null }, { ...p, exists: false }, { ...p, broad: true }, { ...p, tmpOnly: true }]) assert.equal(startNextHtml(q, null, 'live'), '', JSON.stringify(q));
  });

  test('after a live install: "N skill(s) installed. Now open a terminal ..."; nothing after a preview or a failure', () => {
    const p = { id: 'x-game', name: 'Game', path: 'C:\\w\\game', exists: true };
    const plan = [
      { op: 'copy', kind: 'skill', name: 'a' },
      { op: 'copy', kind: 'skill', name: 'b' },
      { op: 'update', kind: 'skill', name: 'c' },
      { op: 'skip', kind: 'skill', name: 'd' },
    ];
    const done = { out: { act: 'apply', r: { ok: true, mode: 'live', applied: true, plan, result: { executed: true } } } };
    setLanguage('tr');
    try {
      assert.ok(startNextHtml(p, done, 'live').includes('3 skill kuruldu. Şimdi terminali açıp istediğin yapay zekâ aracını başlatabilirsin.'));
    } finally {
      setLanguage('en');
    }
    assert.ok(startNextHtml(p, done, 'live').includes('3 skill(s) installed. Now open a terminal'));
    const dry = { out: { act: 'apply', r: { ok: true, mode: 'dry', plan } } };
    assert.doesNotMatch(startNextHtml(p, dry, 'dry'), /start-done/);
    assert.doesNotMatch(startNextHtml(p, { out: { act: 'apply', r: { ok: false, code: 'x' } } }, 'live'), /start-done/);
    assert.doesNotMatch(startNextHtml(p, { out: { act: 'try', r: { ok: true, mode: 'live' } } }, 'live'), /start-done/);
  });
});

// ================================================================== shell: system folders, the hub both ways, the tray
// (the desktop shell's part: electron/helpers.mjs systemFolderRules, checkProjectFolder, newProjectFromTray)
import { systemFolderRules, newProjectFromTray, SYSTEM_TREE_VARS as SHELL_TREE_VARS, SYSTEM_ROOT_VARS as SHELL_ROOT_VARS } from '../electron/helpers.mjs';
import { WIN_ONLY as WINDOWS_ONLY } from './lib/winonly.mjs';

const WIN_ONLY = { skip: process.platform !== 'win32' && 'Windows paths and junctions' };

describe('shell: system folders and the hub both ways (checkProjectFolder)', () => {
  // A fake system inside the test world: Windows, Program Files (both), ProgramData and three OneDrive roots
  function systemWorld() {
    const w = world();
    const sys = {};
    for (const [name, dir] of [
      ['SystemRoot', 'Windows'],
      ['ProgramFiles', 'Program Files'],
      ['ProgramFiles(x86)', 'Program Files (x86)'],
      ['ProgramData', 'ProgramData'],
      ['OneDrive', 'OneDrive'],
      ['OneDriveConsumer', 'OneDrive - Personal'],
      ['OneDriveCommercial', 'OneDrive - Company'],
    ]) {
      sys[name] = path.join(w.base, 'sys', dir);
      fs.mkdirSync(sys[name], { recursive: true });
    }
    const system = systemFolderRules(sys);
    w.sys = sys;
    w.systemRules = () => ({ ...w.rules(), broadDirs: [...w.rules().broadDirs, ...system.roots], systemTrees: system.trees });
    return w;
  }

  test('systemFolderRules: Windows, Program Files (both) and ProgramData are trees; the OneDrive roots are roots; the same lists as the server; any letter case; bad values ignored', WIN_ONLY, () => {
    assert.deepEqual([...SHELL_TREE_VARS], ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']);
    assert.deepEqual([...SHELL_ROOT_VARS], ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']);
    // SYSTEM_TREE_VARS and ONEDRIVE_ROOT_VARS are the server's lists (server/catalog.mjs, imported at the top)
    assert.deepEqual([...SHELL_TREE_VARS], [...SYSTEM_TREE_VARS], 'shell and server refuse the same system trees');
    assert.deepEqual([...SHELL_ROOT_VARS], [...ONEDRIVE_ROOT_VARS], 'shell and server refuse the same OneDrive roots');
    const env = {
      SYSTEMROOT: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'programfiles(x86)': 'C:\\Program Files (x86)',
      ProgramData: 'C:\\ProgramData',
      OneDrive: 'C:\\Users\\me\\OneDrive',
      OneDriveConsumer: 'C:\\Users\\me\\OneDrive', // the same folder twice: listed once
      OneDriveCommercial: '\\\\server\\share\\od', // not a local path: ignored
      PATH: 'C:\\Windows\\System32',
    };
    const r = systemFolderRules(env);
    assert.deepEqual(r.trees, ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']);
    assert.deepEqual(r.roots, ['C:\\Users\\me\\OneDrive']);
    assert.deepEqual(systemFolderRules({ SystemRoot: 'Windows', ProgramData: '', OneDrive: '   ' }), { trees: [], roots: [] }, 'relative or empty: nothing');
    assert.deepEqual(systemFolderRules(), { trees: [], roots: [] });
  });

  test("refused as 'broad': %SystemRoot% and everything inside it, also through a junction", WIN_ONLY, () => {
    const w = systemWorld();
    const r = w.systemRules();
    assert.equal(checkProjectFolder(w.sys.SystemRoot, r).reason, 'broad');
    const deep = path.join(w.sys.SystemRoot, 'System32', 'drivers');
    fs.mkdirSync(deep, { recursive: true });
    assert.equal(checkProjectFolder(path.join(w.sys.SystemRoot, 'System32'), r).reason, 'broad');
    assert.equal(checkProjectFolder(deep, r).reason, 'broad');
    assert.equal(checkProjectFolder(path.join(w.sys.SystemRoot.toLowerCase(), 'system32'), r).reason, 'broad', 'any letter case');
    const link = path.join(w.work, 'to-windows');
    junction(w.sys.SystemRoot, link);
    fs.mkdirSync(path.join(w.sys.SystemRoot, 'Temp'), { recursive: true });
    assert.equal(checkProjectFolder(path.join(link, 'Temp'), r).reason, 'broad', 'the real form is checked too');
  });

  test("refused as 'broad': Program Files (both) and ProgramData with everything inside them", WIN_ONLY, () => {
    const w = systemWorld();
    const r = w.systemRules();
    for (const name of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
      assert.equal(checkProjectFolder(w.sys[name], r).reason, 'broad', name);
      const inside = path.join(w.sys[name], 'Vendor', 'App');
      fs.mkdirSync(inside, { recursive: true });
      assert.equal(checkProjectFolder(inside, r).reason, 'broad', `inside ${name}`);
      assert.equal(checkProjectFolder(inside.toUpperCase(), r).reason, 'broad', `inside ${name}, another letter case`);
    }
  });

  test("refused as 'broad': the OneDrive roots themselves; a project folder inside them is not", WIN_ONLY, () => {
    const w = systemWorld();
    const r = w.systemRules();
    for (const name of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      assert.equal(checkProjectFolder(w.sys[name], r).reason, 'broad', name);
      assert.equal(checkProjectFolder(w.sys[name].toUpperCase(), r).reason, 'broad', `${name} in another letter case`);
    }
    const inOneDrive = path.join(w.sys.OneDrive, 'my-game');
    fs.mkdirSync(inOneDrive);
    assert.deepEqual(checkProjectFolder(inOneDrive, r), { ok: true, path: inOneDrive });
    const inBusiness = path.join(w.sys.OneDriveCommercial, 'Projects', 'site');
    fs.mkdirSync(inBusiness, { recursive: true });
    assert.equal(checkProjectFolder(inBusiness, r).ok, true);
    // Without the system rules (no such variables) the same folders are ordinary
    assert.equal(checkProjectFolder(w.sys.ProgramData, w.rules()).ok, true);
  });

  test("the hub both ways: a folder that holds the hub is refused as 'hub', as written and through a junction", WIN_ONLY, () => {
    const w = world();
    const outer = path.join(w.work, 'outer');
    const hub = path.join(outer, 'nested', 'SiberSentez');
    fs.mkdirSync(hub, { recursive: true });
    const r = { ...w.rules(), hubPath: hub };
    assert.equal(checkProjectFolder(outer, r).reason, 'hub', 'two levels above the hub');
    assert.equal(checkProjectFolder(path.join(outer, 'nested'), r).reason, 'hub', 'right above the hub');
    assert.equal(checkProjectFolder(hub, r).reason, 'hub');
    const sibling = path.join(outer, 'sibling');
    fs.mkdirSync(sibling);
    assert.deepEqual(checkProjectFolder(sibling, r), { ok: true, path: sibling }, 'a folder next to the hub is fine');
    // The hub named through a junction: the folder that really holds it is refused on the real form
    const realOuter = w.dir('real-outer');
    const realHub = path.join(realOuter, 'SiberSentez');
    fs.mkdirSync(realHub);
    const hubLink = path.join(w.work, 'hub-link');
    junction(realHub, hubLink);
    assert.equal(checkProjectFolder(realOuter, { ...w.rules(), hubPath: hubLink }).reason, 'hub', 'the hub given through a junction');
  });
});

describe('shell: "New project…" in the tray is never silent (newProjectFromTray)', () => {
  const fakes = (overrides = {}) => {
    const calls = [];
    return {
      calls,
      args: {
        windowReady: true,
        show: () => calls.push('show'),
        handOver: async () => (calls.push('hand-over'), true),
        notify: () => calls.push('notify'),
        log: (m) => calls.push(`log: ${m}`),
        ...overrides,
      },
    };
  };

  test('the window shows the panel: it comes up and the page takes the request', async () => {
    const f = fakes();
    assert.equal(await newProjectFromTray(f.args), 'handed-over');
    assert.deepEqual(f.calls, ['show', 'hand-over']);
  });

  test('the window is not ready (the server restarts, an error page, no window yet): a balloon says so, nothing else happens', async () => {
    for (const windowReady of [false, undefined, 'yes', 1]) {
      const f = fakes({ windowReady });
      assert.equal(await newProjectFromTray(f.args), 'not-ready', String(windowReady));
      assert.deepEqual(f.calls.filter((c) => !c.startsWith('log: ')), ['notify'], 'only the balloon: the window is not brought up, no script runs');
      assert.equal(f.calls.filter((c) => c.startsWith('log: ')).length, 1, 'and one log line');
    }
  });

  test('a page that does not take it, or a failing hand-over, is logged', async () => {
    const failing = [
      async () => false,
      async () => 'true',
      async () => {
        throw new Error('gone');
      },
      () => {
        throw new Error('sync');
      },
    ];
    for (const handOver of failing) {
      const f = fakes({ handOver });
      assert.equal(await newProjectFromTray(f.args), 'not-taken');
      assert.deepEqual(f.calls, ['show', 'log: new project: the page did not take the request']);
    }
  });

  test('the balloon texts in both languages; main.mjs shows them in the tray; the folder rules carry the system folders', () => {
    assert.equal(SHELL_STRINGS.en.newProjectNotReadyBody, 'SiberSentez is getting ready. Try again in a few seconds.');
    assert.equal(SHELL_STRINGS.tr.newProjectNotReadyBody, 'SiberSentez hazırlanıyor, birkaç saniye sonra yeniden dene.');
    for (const lang of ['en', 'tr']) assert.ok(SHELL_STRINGS[lang].newProjectNotReadyTitle?.trim(), lang);
    const src = textOf('electron', 'main.mjs');
    assert.ok(bodyOf(src, 'showNewProjectNotReady').includes("tray?.displayBalloon({ iconType: 'info', title: S.newProjectNotReadyTitle, content: S.newProjectNotReadyBody });"));
    const rules = bodyOf(src, 'projectFolderRules');
    assert.ok(rules.includes('const system = systemFolderRules(process.env);'));
    assert.ok(rules.includes('...system.roots]') && rules.includes('systemTrees: system.trees,'));
  });
});

test('a folder added through "New project" reads "Added by you" on its card and in its drawer, not "Found automatically"', async () => {
  const { projectKindText } = await import('../public/js/format.js');
  const { setLanguage } = await import('../public/js/i18n.js');
  setLanguage('tr');
  assert.equal(projectKindText({ kind: 'adhoc', via: ['claude-code', 'sibersentez'] }), 'Eklediğin');
  assert.equal(projectKindText({ kind: 'adhoc', via: ['claude-code'] }), 'Otomatik bulundu');
  assert.equal(projectKindText({ kind: 'registered', via: [] }), 'Eklediğin');
  assert.equal(projectKindText({ kind: 'nope' }), '');
  assert.equal(projectKindText(null), '');
  setLanguage('en');
});

// 2026-10-02: a new, empty project the user added got "no project files here: moved?" right after its first job, since
// SiberSentez itself had put only .claude and .sibersentez in it. Only a folder found in the logs can be left behind.
test('a project added here or registered is never "moved?" for holding only what its first job set up; one found in the logs still is', () => {
  const w = world();
  const c = w.catalog();
  const added = w.dir('restoran');
  const r = c.addProjectFolder(added);
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const d of ['.claude', '.sibersentez']) fs.mkdirSync(path.join(added, d), { recursive: true });
  const found = w.dir('old-place');
  fs.mkdirSync(path.join(found, '.claude'), { recursive: true });
  c.memory.record(found, { via: 'claude', lastSeenAt: Date.now() });
  c.memory.flush();
  c.load();
  assert.equal(c.getProject(r.projectId).toolsOnly, false, 'added here');
  const old = c.allProjects().find((p) => p.path && path.resolve(p.path) === path.resolve(found));
  assert.ok(old, 'the folder from the logs is listed');
  assert.equal(old.toolsOnly, true, `found in the logs: maybe moved ${JSON.stringify({ via: old.via, kind: old.kind, exists: old.exists })}`);
  c.loadProjects({ projects: [{ id: 'reg', name: 'Reg', path: added }] });
  assert.equal(c.getProject('reg').toolsOnly, false, 'registered');
});
