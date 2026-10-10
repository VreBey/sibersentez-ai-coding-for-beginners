// Tests for the in-app actions switch (docs/actions-toggle.md §3b): the panel under the header indicator
// (public/js/actionsSwitch.js), the window's preload (electron/preload.cjs), the shell's check of the page's request and
// the confirmation routing (electron/helpers.mjs), and their wiring (main.mjs, main.js, index.html). Every file lives
// under a fresh folder in the system temp folder; nothing starts Electron, a browser or a server.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  ACTIONS_CONFIRM_OK,
  ACTIONS_IPC_CHANNEL,
  ACTION_MODES,
  PANEL_CONFIRM_LIVE_SCRIPT,
  PANEL_HANDOVER_MS,
  appOrigin,
  confirmActionsLive,
  liveConfirmation,
  panelReply,
  panelRequest,
  readHubActionsSetting,
  requestActionsMode,
  settleWithin,
  switchActionsMode,
} from '../electron/helpers.mjs';
import { getStrings } from '../electron/strings.mjs';
import { STRINGS as PAGE_STRINGS, FEATURE_TABLES, setLanguage, t, modeName } from '../public/js/i18n.js';
import { esc } from '../public/js/format.js';
import {
  RESUME_KEY,
  SWITCH_MODES,
  createActionsSwitch,
  indicatorModel,
  initialSwitch,
  keepPlace,
  qaBridge,
  readResume,
  replyError,
  resumeRecord,
  shellBridge,
  switchHtml,
  switchKey,
  switchStep,
} from '../public/js/actionsSwitch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-actions-in-app-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
after(() => setLanguage('en'));
// Source text with LF line ends (the working tree may use CRLF), so a function body ends at its own closing brace
const textOf = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const bodyOf = (src, name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  // Up to the "}" at the function's own indentation (functions inside createQaRun are indented)
  const end = src.indexOf(`\n${(src.slice(src.lastIndexOf('\n', start) + 1, start).match(/^\s*/) || [''])[0]}}\n`, start);
  assert.ok(end > start, `end of function ${name}`);
  return src.slice(start, end);
};

const ORIGIN = appOrigin(47712);
// The main window's own top frame, showing the server origin: the only sender the shell listens to
const FROM_PANEL = { mainWindow: true, frame: { top: true, url: `${ORIGIN}/?lang=tr` }, origin: ORIGIN };

// ------------------------------------------------------------------ the preload
describe('preload: the page gets exactly the bridge functions', () => {
  // Runs electron/preload.cjs the way a sandboxed preload runs: plain script, require('electron') only
  function loadPreload() {
    const code = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');
    const exposed = {};
    const invokes = [];
    const required = [];
    const ipcRenderer = new Proxy(
      {
        invoke: (...args) => {
          invokes.push(args);
          return Promise.resolve({ changed: true, mode: args[1], reason: 'saved' });
        },
      },
      {
        get(target, key) {
          if (key in target) return target[key];
          throw new Error(`the preload used ipcRenderer.${String(key)}`);
        },
      },
    );
    const electron = { contextBridge: { exposeInMainWorld: (key, api) => (exposed[key] = api) }, ipcRenderer };
    vm.runInNewContext(code, {
      require: (m) => {
        required.push(m);
        if (m === 'electron') return electron;
        throw new Error(`a sandboxed preload cannot require ${m}`);
      },
    });
    return { exposed, invokes, required };
  }

  test("window.sibersentezShell holds setActionsMode and the new project's two functions (test/new-project.test.mjs); setActionsMode invokes its channel with the mode and nothing else", async () => {
    const p = loadPreload();
    assert.deepEqual(p.required, ['electron']);
    assert.deepEqual(Object.keys(p.exposed), ['sibersentezTerminal', 'sibersentezShell'], 'the terminal bridge is checked in test/terminal.test.mjs');
    assert.deepEqual(Object.keys(p.exposed.sibersentezShell), ['setActionsMode', 'pickProjectFolder', 'createIdeaProject', 'pickLibraryFolder', 'setLanguage', 'setTheme', 'saveProjectIdea', 'setAttention', 'reportError', 'openLogs', 'supportParts', 'saveSupport']);
    // The look: its own channel with one of the three choices; anything else never reaches the shell
    for (const theme of ['dark', 'light', 'system']) await p.exposed.sibersentezShell.setTheme(theme);
    assert.deepEqual(p.invokes.splice(0), [['sibersentez:set-theme', 'dark'], ['sibersentez:set-theme', 'light'], ['sibersentez:set-theme', 'system']]);
    for (const bad of ['Light', 'auto', '', null, 1, { theme: 'dark' }]) assert.equal(JSON.stringify(await p.exposed.sibersentezShell.setTheme(bad)), '{"ok":false,"reason":"invalid"}');
    assert.deepEqual(p.invokes, []);
    assert.equal(typeof p.exposed.sibersentezShell.setActionsMode, 'function');
    // The library picker invokes its own channel with no argument, whatever the page passes
    await p.exposed.sibersentezShell.pickLibraryFolder('C:\\ignored', { path: 'x' });
    assert.deepEqual(p.invokes.pop(), ['sibersentez:pick-library-folder']);
    for (const mode of ACTION_MODES) {
      const reply = await p.exposed.sibersentezShell.setActionsMode(mode);
      assert.equal(reply.mode, mode);
    }
    assert.deepEqual(p.invokes, ACTION_MODES.map((m) => [ACTIONS_IPC_CHANNEL, m]), 'one invoke per call, the mode as its only argument');
  });

  test('anything but off|dry|live is refused in the preload and never reaches the shell', async () => {
    const p = loadPreload();
    for (const v of ['LIVE', ' live', 'live ', 'on', 'true', '', 1, 0, true, null, undefined, {}, ['live'], { toString: () => 'live' }]) {
      const reply = await p.exposed.sibersentezShell.setActionsMode(v);
      assert.deepEqual({ ...reply }, { changed: false, mode: null, reason: 'invalid' }, String(v));
    }
    assert.deepEqual(p.invokes, []);
  });

  test('the channel name is the shell\'s; window.sibersentezShell listens to nothing and sends nothing else', () => {
    // The terminal bridge before it listens and sends by design (test/terminal.test.mjs); sibersentezShell never does
    const all = textOf('electron', 'preload.cjs');
    const code = all.slice(all.indexOf("contextBridge.exposeInMainWorld('sibersentezShell'"));
    assert.equal((all.match(/exposeInMainWorld\(/g) || []).length, 2, 'sibersentezTerminal and sibersentezShell');
    assert.doesNotMatch(all, /exposeInIsolatedWorld|webFrame|process\.|executeJavaScript/);
    assert.ok(all.includes(`const CHANNEL = '${ACTIONS_IPC_CHANNEL}';`), 'the same channel as helpers.mjs');
    assert.equal(ACTIONS_IPC_CHANNEL, 'sibersentez:set-actions-mode');
    assert.doesNotMatch(code, /ipcRenderer\.(on|once|send|sendSync|sendToHost|postMessage|addListener)\b/);
    assert.doesNotMatch(code, /exposeInIsolatedWorld|webFrame|process\.|executeJavaScript/);
    assert.equal((code.match(/exposeInMainWorld\(/g) || []).length, 1);
  });
});

// ------------------------------------------------------------------ who may ask the shell
describe("shell: the page's request is honoured only from the main window's top frame on the server origin", () => {
  test('the main window, its top frame, the server origin and a valid mode: accepted', () => {
    for (const mode of ACTION_MODES) assert.deepEqual(panelRequest({ ...FROM_PANEL, mode }), { ok: true, mode });
    assert.deepEqual(panelRequest({ ...FROM_PANEL, mode: 'dry', frame: { top: true, url: `${ORIGIN}/` } }), { ok: true, mode: 'dry' });
  });

  test('another window or webContents (DevTools, anything else): refused', () => {
    for (const mainWindow of [false, undefined, null, 'yes', 1, {}]) {
      assert.deepEqual(panelRequest({ ...FROM_PANEL, mainWindow, mode: 'live' }), { ok: false, reason: 'not-main-window' }, String(mainWindow));
    }
  });

  test('a subframe, or a frame that navigated away or is gone: refused', () => {
    assert.deepEqual(panelRequest({ ...FROM_PANEL, frame: { top: false, url: `${ORIGIN}/` }, mode: 'live' }), { ok: false, reason: 'not-top-frame' }, 'a subframe on our own origin');
    for (const frame of [null, undefined, { url: `${ORIGIN}/` }, { top: 'true', url: `${ORIGIN}/` }, { top: 1, url: `${ORIGIN}/` }]) {
      assert.deepEqual(panelRequest({ ...FROM_PANEL, frame, mode: 'live' }), { ok: false, reason: 'not-top-frame' }, JSON.stringify(frame));
    }
  });

  test('a top frame that does not show the server origin right now (an error page, another port or host, no server ready): refused', () => {
    for (const url of ['', 'about:blank', 'chrome-error://chromewebdata/', 'http://127.0.0.1:47713/', 'http://127.0.0.1:4545/', 'http://localhost:47712/', 'https://127.0.0.1:47712/', 'http://u:p@127.0.0.1:47712/', 'devtools://devtools/bundled/devtools_app.html', 'data:text/html,x', 'file:///C:/x.html', null]) {
      assert.deepEqual(panelRequest({ ...FROM_PANEL, frame: { top: true, url }, mode: 'dry' }), { ok: false, reason: 'not-app-origin' }, String(url));
    }
    assert.deepEqual(panelRequest({ ...FROM_PANEL, origin: null, mode: 'dry' }), { ok: false, reason: 'not-app-origin' }, 'no server ready');
  });

  test('only exactly off, dry or live', () => {
    for (const mode of ['LIVE', ' live', 'on', '', 1, null, undefined, ['live'], { mode: 'live' }]) {
      assert.deepEqual(panelRequest({ ...FROM_PANEL, mode }), { ok: false, reason: 'invalid-mode' }, JSON.stringify(mode));
    }
    assert.deepEqual(panelRequest(), { ok: false, reason: 'not-main-window' });
  });

  test("the reply carries whether it changed, the mode, the reason and an error code; never a path or any other detail", () => {
    const file = 'C:\\Users\\someone\\SiberSentez\\settings.json';
    assert.deepEqual(panelReply({ changed: true, mode: 'dry', reason: 'saved', from: 'off' }), { changed: true, mode: 'dry', reason: 'saved' });
    assert.deepEqual(panelReply({ changed: false, mode: 'off', reason: 'write-failed', from: 'off', error: { ok: false, code: 'SETTINGS_INVALID', file, detail: 'EPERM' } }), {
      changed: false,
      mode: 'off',
      reason: 'write-failed',
      code: 'SETTINGS_INVALID',
    });
    for (const bad of [null, undefined, 'x', 42, { reason: file }, { reason: 'x'.repeat(40) }, { changed: 'yes', mode: 'LIVE', error: { code: file } }]) {
      const r = panelReply(bad);
      assert.equal(r.changed, false, JSON.stringify(bad));
      assert.equal(r.reason, 'error', JSON.stringify(bad));
      assert.equal(r.mode, null);
      assert.equal('code' in r, false);
      assert.doesNotMatch(JSON.stringify(r), /Users|settings\.json/);
    }
  });

  test('main.mjs: the one handler checks the sender with panelRequest before anything else, then takes the menus\' path; the reply is panelReply', () => {
    const src = textOf('electron', 'main.mjs');
    assert.ok(src.includes('ipcMain.handle(ACTIONS_IPC_CHANNEL, onPanelActionsRequest);'));
    const h = bodyOf(src, 'onPanelActionsRequest');
    for (const needle of [
      'const check = panelRequest({',
      'mainWindow: Boolean(win && !win.isDestroyed() && event?.sender === win.webContents),',
      'frame: frameFacts(event?.senderFrame),',
      'origin: state.origin,',
      "return panelReply({ changed: false, reason: 'refused' });",
      "return panelReply(await chooseActionsMode(check.mode, 'panel'));",
    ]) {
      assert.ok(h.includes(needle), `onPanelActionsRequest: ${needle}`);
    }
    assert.ok(h.indexOf('if (!check.ok)') < h.indexOf('chooseActionsMode('), 'refused before the mode is touched');
    assert.doesNotMatch(h, /chooseActionsMode\(mode\b|writeHubActionsSetting|switchActionsMode/, 'only the checked mode, only through chooseActionsMode');
    assert.ok(bodyOf(src, 'frameFacts').includes('top: frame.parent === null'));
    // A failed write from the panel is shown in the panel, not in a native dialog
    assert.ok(bodyOf(src, 'chooseActionsMode').includes("if (result.reason === 'write-failed' && source !== 'panel') showActionsError(result.error);"));
  });
});

// ------------------------------------------------------------------ how On is confirmed
describe('shell: how turning actions On is confirmed, by where the request comes from', () => {
  test('route: none for anything but a switch to On; QA refuses; the panel asked itself; a menu hands it to the window when it can, else the native dialog', () => {
    for (const requested of ['off', 'dry', 'bogus', undefined]) {
      for (const source of ['panel', 'tray', 'menu', 'qa']) assert.equal(liveConfirmation({ requested, current: 'off', source, windowReady: true }), 'none', `${requested} ${source}`);
    }
    assert.equal(liveConfirmation({ requested: 'live', current: 'live', source: 'tray', windowReady: true }), 'none', 'already on');
    for (const source of ['panel', 'tray', 'menu', 'qa']) assert.equal(liveConfirmation({ requested: 'live', current: 'off', source, qa: true, windowReady: true }), 'refuse', source);
    assert.equal(liveConfirmation({ requested: 'live', current: 'dry', source: 'panel' }), 'page');
    for (const source of ['tray', 'menu']) {
      assert.equal(liveConfirmation({ requested: 'live', current: 'off', source, windowReady: true }), 'panel', source);
      for (const windowReady of [false, undefined, 'yes', 1]) assert.equal(liveConfirmation({ requested: 'live', current: 'off', source, windowReady }), 'native', `${source} ${windowReady}`);
    }
    assert.equal(liveConfirmation({ requested: 'live', current: 'off', source: 'something-new', windowReady: false }), 'native', 'an unknown source never skips a confirmation');
  });

  test('with the real hub: the panel\'s On is written without a dialog; a menu\'s On goes to the panel (nothing written) or, when the page does not take it, to the native dialog', async () => {
    const hub = path.join(TMP, 'hub-route');
    fs.mkdirSync(hub, { recursive: true });
    const file = path.join(hub, 'settings.json');
    const reset = (mode = 'off') => fs.writeFileSync(file, JSON.stringify({ language: 'en', actions: mode }));
    const run = async ({ requested = 'live', source, windowReady = false, took = false, native = false, qa = false }) => {
      const calls = { handOver: 0, native: 0 };
      const applied = [];
      const r = await requestActionsMode({
        requested,
        source,
        current: readHubActionsSetting(hub),
        qa,
        windowReady,
        handOver: async () => {
          calls.handOver++;
          if (took instanceof Error) throw took;
          return took;
        },
        confirmNative: async () => {
          calls.native++;
          return native;
        },
        switchMode: (confirm) => switchActionsMode({ hubPath: hub, requested, confirm, apply: async (m) => applied.push(m) }),
      });
      return { r, calls, applied };
    };
    // The panel: it asked in the page; no hand-over and no native dialog
    reset();
    let x = await run({ source: 'panel', windowReady: true });
    assert.equal(x.r.reason, 'saved');
    assert.deepEqual(x.calls, { handOver: 0, native: 0 });
    assert.deepEqual(x.applied, ['live']);
    assert.equal(readHubActionsSetting(hub), 'live');
    // The tray while the window shows the panel: handed over, nothing written, nothing applied, no native dialog
    for (const source of ['tray', 'menu']) {
      reset();
      const before = fs.readFileSync(file);
      x = await run({ source, windowReady: true, took: true, native: true });
      assert.deepEqual(x.r, { changed: false, mode: 'off', from: 'off', reason: 'in-panel' }, source);
      assert.deepEqual(x.calls, { handOver: 1, native: 0 });
      assert.deepEqual(x.applied, []);
      assert.ok(fs.readFileSync(file).equals(before), 'settings.json byte for byte');
    }
    // The page did not take it (false, or the hand-over failed): the native dialog asks; its Cancel writes nothing
    for (const took of [false, undefined, 'yes', new Error('page gone')]) {
      reset();
      const before = fs.readFileSync(file);
      x = await run({ source: 'tray', windowReady: true, took, native: false });
      assert.equal(x.r.reason, 'cancelled', String(took));
      assert.deepEqual(x.calls, { handOver: 1, native: 1 });
      assert.ok(fs.readFileSync(file).equals(before));
    }
    reset();
    x = await run({ source: 'tray', windowReady: true, took: false, native: true });
    assert.equal(x.r.reason, 'saved');
    assert.equal(readHubActionsSetting(hub), 'live');
    // No window that can ask: straight to the native dialog
    reset();
    x = await run({ source: 'tray', windowReady: false, native: true });
    assert.deepEqual(x.calls, { handOver: 0, native: 1 });
    assert.equal(x.r.reason, 'saved');
    // Off and Preview: no confirmation anywhere, from any source
    for (const source of ['panel', 'tray', 'menu']) {
      reset('live');
      x = await run({ requested: 'dry', source, windowReady: true, took: true, native: false });
      assert.equal(x.r.reason, 'saved', source);
      assert.deepEqual(x.calls, { handOver: 0, native: 0 });
      assert.equal(readHubActionsSetting(hub), 'dry');
    }
    // QA never turns actions on, from the panel either; nothing is asked
    for (const source of ['panel', 'tray']) {
      reset();
      const before = fs.readFileSync(file);
      x = await run({ source, qa: true, windowReady: true, took: true, native: true });
      assert.equal(x.r.reason, 'cancelled', source);
      assert.deepEqual(x.calls, { handOver: 0, native: 0 });
      assert.ok(fs.readFileSync(file).equals(before));
    }
    // With the real native confirmation helper: only its On button turns actions on
    reset();
    const S = getStrings('en');
    const box = async () => ({ response: ACTIONS_CONFIRM_OK });
    const r = await requestActionsMode({
      requested: 'live',
      source: 'tray',
      current: 'off',
      handOver: async () => false,
      confirmNative: () => confirmActionsLive({ S, showMessageBox: box }),
      switchMode: (confirm) => switchActionsMode({ hubPath: hub, requested: 'live', confirm, apply: async () => {} }),
    });
    assert.equal(r.reason, 'saved');
  });

  test('the hand-over script: true only when the page\'s switch says it shows the question', () => {
    const run = (window) => vm.runInNewContext(PANEL_CONFIRM_LIVE_SCRIPT, { window });
    assert.equal(run({ sibersentezActionsPanel: { confirmLive: () => true } }), true);
    for (const w of [{}, { sibersentezActionsPanel: null }, { sibersentezActionsPanel: {} }, { sibersentezActionsPanel: { confirmLive: 'x' } }, { sibersentezActionsPanel: { confirmLive: () => 'true' } }, { sibersentezActionsPanel: { confirmLive: () => 1 } }, { sibersentezActionsPanel: { confirmLive: () => false } }]) {
      assert.equal(run(w), false, JSON.stringify(w));
    }
    assert.equal(run({ sibersentezActionsPanel: { confirmLive: () => { throw new Error('x'); } } }), false, 'a throwing page answers false');
    assert.equal(PANEL_HANDOVER_MS, 1500);
  });

  test('settleWithin: the value in time; the fallback for a slow, rejecting or throwing call', async () => {
    assert.equal(await settleWithin(Promise.resolve(true), 50, false), true);
    assert.equal(await settleWithin(() => Promise.resolve('x'), 50, false), 'x');
    assert.equal(await settleWithin(new Promise(() => {}), 20, 'late'), 'late');
    assert.equal(await settleWithin(Promise.reject(new Error('x')), 50, 'no'), 'no');
    assert.equal(
      await settleWithin(() => {
        throw new Error('x');
      }, 50, 'thrown'),
      'thrown',
    );
  });

  test('main.mjs: the hand-over shows the window and runs the fixed script with a time limit; only a window on the server origin qualifies', () => {
    // The shell's main module and its QA run (electron/qa-run.mjs): every executeJavaScript of the shell
    const src = textOf('electron', 'main.mjs') + textOf('electron', 'qa-run.mjs');
    const hand = bodyOf(src, 'handOverToPanel');
    assert.ok(hand.includes('if (!panelWindowReady()) return false;'));
    assert.ok(hand.includes('showWindow();'));
    assert.ok(hand.includes('settleWithin(() => win.webContents.executeJavaScript(PANEL_CONFIRM_LIVE_SCRIPT), PANEL_HANDOVER_MS, false)) === true;'));
    assert.equal((src.match(/executeJavaScript\(/g) || []).filter(Boolean).length, 3, 'the hand-over, the tray\'s new project (NEW_PROJECT_SCRIPT) and the QA permission probe, nothing else');
    assert.equal((src.match(/executeJavaScript\(NEW_PROJECT_SCRIPT\)/g) || []).length, 1, 'the new project hands over one fixed script');
    assert.ok(bodyOf(src, 'panelWindowReady').includes('return isAppUrl(win.webContents.getURL(), state.origin);'));
    const choose = bodyOf(src, 'chooseActionsMode');
    for (const needle of ['current: currentActionsMode(),', 'qa: QA.enabled,', 'windowReady: panelWindowReady(),', 'handOver: handOverToPanel,', 'confirmNative: confirmActionsOn,']) {
      assert.ok(choose.includes(needle), `chooseActionsMode: ${needle}`);
    }
  });
});

// ------------------------------------------------------------------ the panel's state machine
describe('page: the switch panel, step by step', () => {
  const open = (current = 'off') => switchStep(initialSwitch(current), { type: 'open' }).state;
  const step = (s, ev) => switchStep(s, ev);

  test('closed at first; the indicator opens it on the options with the focus on the stored mode, and closes it again giving the focus back', () => {
    const s0 = initialSwitch('dry');
    assert.deepEqual(s0, { open: false, step: 'choose', current: 'dry', focus: 'dry', error: null, saved: null });
    assert.equal(initialSwitch('bogus').current, 'off');
    const a = step(s0, { type: 'toggle' });
    assert.equal(a.state.open, true);
    assert.equal(a.state.step, 'choose');
    assert.deepEqual(a.effects, [{ type: 'focus', target: 'option' }]);
    const b = step(a.state, { type: 'toggle' });
    assert.equal(b.state.open, false);
    assert.deepEqual(b.effects, [{ type: 'closed', restore: true }]);
  });

  test('Off and Preview are sent at once; the stored mode just closes; On only opens the question', () => {
    for (const [current, pick] of [['off', 'dry'], ['dry', 'off'], ['live', 'off'], ['live', 'dry']]) {
      const r = step(open(current), { type: 'pick', mode: pick });
      assert.equal(r.state.step, 'saving', `${current} -> ${pick}`);
      assert.deepEqual(r.effects, [{ type: 'set', mode: pick }]);
    }
    for (const m of SWITCH_MODES) {
      const r = step(open(m), { type: 'pick', mode: m });
      assert.equal(r.state.open, false, m);
      assert.deepEqual(r.effects, [{ type: 'closed', restore: true }], 'nothing is sent');
    }
    for (const current of ['off', 'dry']) {
      const r = step(open(current), { type: 'pick', mode: 'live' });
      assert.equal(r.state.step, 'confirm');
      assert.deepEqual(r.effects, [{ type: 'focus', target: 'cancel' }], 'the focus goes to Cancel, nothing is sent');
    }
  });

  test('the question: Turn on sends On; Cancel or Esc go back to the options (focus on On); Off or Preview can still be picked', () => {
    const q = step(open('off'), { type: 'pick', mode: 'live' }).state;
    let r = step(q, { type: 'confirm' });
    assert.equal(r.state.step, 'saving');
    assert.deepEqual(r.effects, [{ type: 'set', mode: 'live' }]);
    for (const ev of [{ type: 'cancel' }, { type: 'escape' }]) {
      r = step(q, ev);
      assert.equal(r.state.step, 'choose', ev.type);
      assert.equal(r.state.open, true);
      assert.equal(r.state.focus, 'live');
      assert.deepEqual(r.effects, [{ type: 'focus', target: 'option' }]);
    }
    r = step(q, { type: 'pick', mode: 'dry' });
    assert.deepEqual(r.effects, [{ type: 'set', mode: 'dry' }]);
    r = step(q, { type: 'pick', mode: 'live' });
    assert.equal(r.state.step, 'confirm', 'On again keeps asking');
    assert.deepEqual(r.effects, [{ type: 'focus', target: 'cancel' }]);
    // The shell hands a menu's On over: the panel opens on the question
    r = step(initialSwitch('dry'), { type: 'open', confirm: true });
    assert.equal(r.state.open, true);
    assert.equal(r.state.step, 'confirm');
    assert.deepEqual(r.effects, [{ type: 'focus', target: 'cancel' }]);
  });

  test('Esc closes (focus back), a click or the focus elsewhere closes (focus stays there); while the shell answers both wait', () => {
    assert.deepEqual(step(open(), { type: 'escape' }).effects, [{ type: 'closed', restore: true }]);
    assert.deepEqual(step(open(), { type: 'outside' }).effects, [{ type: 'closed', restore: false }]);
    const q = step(open(), { type: 'pick', mode: 'live' }).state;
    assert.deepEqual(step(q, { type: 'outside' }).effects, [{ type: 'closed', restore: false }], 'a click outside also drops the question');
    assert.equal(step(q, { type: 'outside' }).state.step, 'choose', 'reopening starts on the options');
    const saving = step(open(), { type: 'pick', mode: 'dry' }).state;
    for (const ev of [{ type: 'escape' }, { type: 'outside' }, { type: 'close' }, { type: 'pick', mode: 'off' }, { type: 'confirm' }, { type: 'move', by: 1 }]) {
      const r = step(saving, ev);
      assert.equal(r.state, saving, ev.type);
      assert.deepEqual(r.effects, [], ev.type);
    }
    // Closed: nothing reacts
    const closed = initialSwitch('off');
    for (const ev of [{ type: 'escape' }, { type: 'outside' }, { type: 'pick', mode: 'dry' }, { type: 'confirm' }, { type: 'cancel' }]) assert.deepEqual(step(closed, ev).effects, [], ev.type);
  });

  test('arrow keys, Home and End move the focus between the options (wrapping) and apply nothing; Tab and Enter keep their own meaning', () => {
    let s = open('off');
    const seq = [];
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'End', 'Home', 'ArrowLeft', 'ArrowRight']) {
      const ev = switchKey(key, s.step);
      const r = step(s, ev);
      assert.deepEqual(r.effects, [{ type: 'focus', target: 'option' }], key);
      s = r.state;
      seq.push(s.focus);
    }
    assert.deepEqual(seq, ['dry', 'live', 'off', 'live', 'live', 'off', 'live', 'off']);
    assert.equal(s.step, 'choose');
    assert.equal(s.current, 'off', 'moving never changes the mode');
    for (const key of ['Tab', 'Enter', ' ', 'a', '1', 'r']) assert.equal(switchKey(key, 'choose'), null, key);
    assert.deepEqual(switchKey('Escape', 'saving'), { type: 'escape' });
    assert.equal(switchKey('ArrowDown', 'saving'), null);
    assert.equal(switchKey('ArrowDown', 'saved'), null);
  });

  test("the shell's answer: saved shows the saved step; same closes; any other answer keeps the mode and says why", () => {
    const saving = step(open('off'), { type: 'pick', mode: 'dry' }).state;
    let r = step(saving, { type: 'result', reply: { changed: true, mode: 'dry', reason: 'saved' } });
    assert.equal(r.state.step, 'saved');
    assert.equal(r.state.saved, 'dry');
    assert.deepEqual(r.effects, [{ type: 'focus', target: 'status' }]);
    assert.equal(step(r.state, { type: 'pick', mode: 'off' }).effects.length, 0, 'nothing more until the reload');
    r = step(saving, { type: 'result', reply: { changed: false, mode: 'dry', reason: 'same' } });
    assert.equal(r.state.open, false);
    assert.equal(r.state.current, 'dry');
    for (const [reply, key] of [
      [{ changed: false, reason: 'busy' }, 'actionsSwitchErrBusy'],
      [{ changed: false, reason: 'write-failed', code: 'SETTINGS_INVALID' }, 'actionsSwitchErrInvalid'],
      [{ changed: false, reason: 'write-failed', code: 'SETTINGS_UNREADABLE' }, 'actionsSwitchErrRead'],
      [{ changed: false, reason: 'write-failed', code: 'WRITE_FAILED' }, 'actionsSwitchErrWrite'],
      [{ changed: false, reason: 'write-failed', code: 'NO_HUB' }, 'actionsSwitchErrNoHub'],
      [{ changed: false, reason: 'write-failed', code: 'toString' }, 'actionsSwitchErrWrite'],
      [{ changed: false, reason: 'refused' }, 'actionsSwitchErrOther'],
      [{ changed: false, reason: 'cancelled' }, 'actionsSwitchErrOther'],
      [{ changed: true, reason: 'saved', mode: 'bogus' }, 'actionsSwitchErrOther'],
      [null, 'actionsSwitchErrOther'],
    ]) {
      r = step(saving, { type: 'result', reply });
      assert.equal(r.state.step, 'choose', JSON.stringify(reply));
      assert.equal(r.state.open, true);
      assert.equal(r.state.error, key, JSON.stringify(reply));
      assert.equal(r.state.current, 'off', 'the mode did not change');
      assert.equal(replyError(reply), key);
    }
    // An answer nobody waits for changes nothing
    assert.deepEqual(step(open('off'), { type: 'result', reply: { changed: true, mode: 'live', reason: 'saved' } }).effects, []);
  });

  test('On is never sent without the question: from every reachable state, only Turn on on the question sends On', () => {
    const events = [
      { type: 'open' },
      { type: 'open', confirm: true },
      { type: 'toggle' },
      { type: 'close', restore: true },
      { type: 'escape' },
      { type: 'outside' },
      ...SWITCH_MODES.map((mode) => ({ type: 'pick', mode })),
      { type: 'pick', mode: 'LIVE' },
      { type: 'confirm' },
      { type: 'cancel' },
      { type: 'move', by: 1 },
      { type: 'move', by: -1 },
      { type: 'first' },
      { type: 'last' },
      { type: 'result', reply: { changed: false, reason: 'busy' } },
      { type: 'result', reply: { changed: true, mode: 'dry', reason: 'saved' } },
      ...SWITCH_MODES.map((mode) => ({ type: 'mode', mode })),
    ];
    const seen = new Set();
    const queue = SWITCH_MODES.map((m) => initialSwitch(m));
    let explored = 0;
    while (queue.length) {
      const s = queue.shift();
      const key = JSON.stringify(s);
      if (seen.has(key)) continue;
      seen.add(key);
      explored++;
      for (const ev of events) {
        const r = switchStep(s, ev);
        const sendsLive = r.effects.some((fx) => fx.type === 'set' && fx.mode === 'live');
        if (sendsLive) assert.ok(ev.type === 'confirm' && s.step === 'confirm' && s.open, `On sent by ${JSON.stringify(ev)} from ${key}`);
        // A set is always one of the three modes, and never the stored one, except Turn on while the page already
        // believes On is stored (a stale view: the shell is the judge and answers 'same')
        for (const fx of r.effects) if (fx.type === 'set') assert.ok(SWITCH_MODES.includes(fx.mode) && (fx.mode !== s.current || ev.type === 'confirm'), `a set that changes nothing: ${key}`);
        queue.push(r.state);
      }
    }
    assert.ok(explored > 30, `explored ${explored} states`);
  });

  test('the page learning a new stored mode updates the mark (and the focus while closed)', () => {
    let r = step(initialSwitch('off'), { type: 'mode', mode: 'dry' });
    assert.equal(r.state.current, 'dry');
    assert.equal(r.state.focus, 'dry');
    r = step({ ...open('off'), focus: 'live' }, { type: 'mode', mode: 'dry' });
    assert.equal(r.state.current, 'dry');
    assert.equal(r.state.focus, 'live', 'an open panel keeps the focus where the user is');
    assert.equal(step(initialSwitch('off'), { type: 'mode', mode: 'bogus' }).state.current, 'off');
  });
});

// ------------------------------------------------------------------ markup and texts
describe('page: what the panel says and how it is marked up', () => {
  test('three options with their one-line explanation, the stored one checked, one tab stop; no inline script or style', () => {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const s = { ...initialSwitch('dry'), open: true, focus: 'live' };
      const html = switchHtml(s);
      assert.match(html, /role="radiogroup" aria-labelledby="actPanelTitle"/);
      assert.equal((html.match(/role="radio"/g) || []).length, 3);
      assert.match(html, /data-asw-mode="dry" data-asw-key="option:dry" aria-describedby="aswDesc-dry"/);
      assert.equal((html.match(/aria-checked="true"/g) || []).length, 1);
      assert.match(html, /class="asw-opt m-dry is-current" role="radio" aria-checked="true" tabindex="-1"/);
      assert.match(html, /class="asw-opt m-live" role="radio" aria-checked="false" tabindex="0"/, 'the focused option is the one tab stop');
      for (const m of SWITCH_MODES) {
        assert.ok(html.includes(`>${esc(modeName(m))}`), `${lang} name ${m}`);
        assert.ok(html.includes(esc(t(`actionsSwitchDesc${m === 'off' ? 'Off' : m === 'dry' ? 'Dry' : 'Live'}`))), `${lang} description ${m}`);
      }
      assert.ok(html.includes(t('actionsSwitchCurrent')));
      assert.ok(html.includes(`id="actPanelTitle">${t('actionsSwitchTitle')}<`));
      assert.ok(html.includes(`id="actPanelIntro">${t('actionsSwitchIntro')}<`));
      assert.doesNotMatch(html, /asw-confirm|role="alert"/, 'no question, no error');
      assert.doesNotMatch(html, /\son\w+=|style=|<script/i, 'CSP: no inline handlers, styles or scripts');
    }
  });

  test('the question, the saving and saved steps, and an error', () => {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const q = switchStep({ ...initialSwitch('off'), open: true }, { type: 'pick', mode: 'live' }).state;
      let html = switchHtml(q);
      assert.ok(html.includes(esc(t('actionsSwitchConfirmTitle'))));
      assert.ok(html.includes(esc(t('actionsSwitchConfirmBody'))));
      assert.match(html, new RegExp(`data-asw-act="cancel" data-asw-key="cancel">${t('actionsSwitchConfirmCancel')}<`));
      assert.match(html, new RegExp(`class="act-btn danger" data-asw-act="confirm" data-asw-key="confirm">${t('actionsSwitchConfirmOk')}<`));
      assert.ok(html.indexOf('data-asw-act="cancel"') < html.indexOf('data-asw-act="confirm"'), 'Cancel first');
      assert.match(html, /class="asw-opt m-live is-asking"/);
      const saving = switchStep(q, { type: 'confirm' }).state;
      html = switchHtml(saving);
      assert.ok(html.includes(t('actionsSwitchSaving')));
      assert.equal((html.match(/aria-disabled="true"/g) || []).length, 5, 'three options and both buttons wait');
      const saved = switchStep(saving, { type: 'result', reply: { changed: true, mode: 'live', reason: 'saved' } }).state;
      assert.ok(switchHtml(saved).includes(t('actionsSwitchSaved', { mode: modeName('live') })));
      const failed = switchStep(saving, { type: 'result', reply: { changed: false, reason: 'write-failed', code: 'SETTINGS_INVALID' } }).state;
      html = switchHtml(failed);
      assert.match(html, /<p class="asw-error" role="alert">/);
      assert.ok(html.includes(esc(t('actionsSwitchErrInvalid'))));
      assert.doesNotMatch(html, /asw-confirm/);
    }
  });

  test("the texts: plain one-liners in both languages (the user's wording in Turkish); the mode names are the indicator's and the tray's", () => {
    const tr = PAGE_STRINGS.tr;
    assert.equal(tr.actionsSwitchDescOff, 'SiberSentez yalnız izler, eylem çalıştırmaz (yapay zekâ araçlarını tanır).');
    assert.equal(tr.actionsSwitchDescDry, 'Her işlemde ne yapılacağını gösterir, hiçbir şey çalıştırmaz.');
    assert.equal(tr.actionsSwitchDescLive, 'Terminal açma, skill kurma gibi işlemler gerçekten yapılır.');
    assert.equal(tr.actionsSwitchConfirmOk, 'Aç');
    // What On does, as the context menu now offers it: a plain terminal in the project folder (any AI tool), resuming
    // Claude Code sessions, Explorer and VS Code, installing skills and agents
    assert.match(PAGE_STRINGS.en.actionsSwitchConfirmBody, /opens a terminal in the project folder \(you start the AI tool you want there\), resumes Claude Code sessions/);
    assert.match(PAGE_STRINGS.en.actionsSwitchConfirmBody, /installs skills and agents into project folders/);
    assert.match(tr.actionsSwitchConfirmBody, /proje klasöründe terminal açar \(istediğin yapay zekâ aracını orada başlatırsın\), Claude Code oturumuna devam eder/);
    assert.match(tr.actionsSwitchConfirmBody, /skill ve ajanları proje klasörlerine kurar/);
    for (const lang of ['en', 'tr']) assert.doesNotMatch(PAGE_STRINGS[lang].actionsSwitchConfirmBody, /terminals with Claude Code|oturumlarıyla terminal/);
    assert.equal(tr.actionsSwitchConfirmCancel, 'Vazgeç');
    const table = FEATURE_TABLES.actionsInApp;
    assert.deepEqual(Object.keys(table.tr).sort(), Object.keys(table.en).sort());
    for (const lang of ['en', 'tr']) {
      for (const [k, v] of Object.entries(table[lang])) {
        assert.ok(k.startsWith('actionsSwitch'), `${lang}.${k}`);
        assert.ok(v.trim() && !/\n/.test(v), `${lang}.${k}`);
        if (k.startsWith('actionsSwitchDesc')) assert.ok(v.length <= 80, `${lang}.${k} stays one short line`);
      }
      assert.notEqual(table[lang].actionsSwitchDescLive, table[lang === 'en' ? 'tr' : 'en'].actionsSwitchDescLive);
    }
    // The same three words everywhere: indicator (page), panel (page) and tray (shell)
    for (const lang of ['en', 'tr']) {
      const S = getStrings(lang);
      assert.equal(PAGE_STRINGS[lang].actionsModeOff, S.trayActionsOff);
      assert.equal(PAGE_STRINGS[lang].actionsModeLive, S.trayActionsLive);
      assert.ok(S.trayActionsDry.startsWith(PAGE_STRINGS[lang].actionsModeDry));
    }
  });

  test('indicator: in the app its name is the mode and its tooltip says a click chooses; in a plain browser it says where the mode is changed', () => {
    setLanguage('tr');
    const app = indicatorModel('dry', true);
    // The mode's name (the same word as the panel and the tray) and what it means (review U11)
    assert.equal(app.text, 'Eylemler: Önizleme · yalnız gösterir');
    assert.equal(app.label, 'Eylemler: Önizleme · yalnız gösterir');
    assert.equal(app.title, `Eylemler: Önizleme · yalnız gösterir. ${PAGE_STRINGS.tr.actionsSwitchTip}`);
    const browser = indicatorModel('live', false);
    assert.equal(browser.text, 'Eylemler: Açık · iş yapar');
    assert.equal(browser.title, `Eylemler: Açık · iş yapar. ${PAGE_STRINGS.tr.actionsHowTo}`);
    assert.equal(browser.label, browser.title);
    setLanguage('en');
    assert.equal(indicatorModel('bogus', true).text, 'Actions: Off · only watches');
  });

  test('index.html: the panel is a labelled, non-modal dialog next to the indicator; the style sheet keeps it above the drawer', () => {
    const html = textOf('public', 'index.html');
    assert.match(
      html,
      /<div class="act-wrap">\s*<button type="button" class="chip chip-btn act-mode" id="actMode" data-mode="off" hidden><\/button>\s*<div class="act-panel" id="actPanel" role="dialog" aria-modal="false" aria-labelledby="actPanelTitle" aria-describedby="actPanelIntro" hidden><\/div>\s*<\/div>/,
    );
    assert.ok(html.indexOf('/css/app.css') < html.indexOf('/css/actions-in-app.css'), 'loaded after app.css');
    const css = textOf('public', 'css', 'actions-in-app.css');
    const z = Number(/\.act-panel \{[^}]*z-index: (\d+);/.exec(css)?.[1]);
    assert.ok(z > 21 && z < 50, `z-index ${z}: above the drawer (21) and its scrim, below the palette (50)`);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /@media \(forced-colors: active\)/);
  });
});

// ------------------------------------------------------------------ the switch in a (fake) page
// A small stand-in for the DOM: enough for createActionsSwitch's wiring (listeners, attributes, focus), no browser
function fakePage() {
  const doc = { listeners: {}, activeElement: null, body: null };
  doc.addEventListener = (type, fn, capture) => (doc.listeners[type] ||= []).push({ fn, capture });
  const el = (tag, parent = null) => {
    const e = {
      tag,
      parentElement: parent,
      dataset: {},
      attrs: {},
      listeners: {},
      hidden: true,
      innerHTML: '',
      title: '',
      id: '',
      isConnected: true,
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute(k) {
        return this.attrs[k] ?? null;
      },
      addEventListener(type, fn) {
        (this.listeners[type] ||= []).push(fn);
      },
      contains(other) {
        for (let n = other; n; n = n.parentElement) if (n === this) return true;
        return false;
      },
      querySelector: () => null,
      closest: () => null,
      focus() {
        doc.activeElement = this;
      },
    };
    return e;
  };
  doc.body = el('body');
  doc.activeElement = doc.body;
  const wrap = el('div', doc.body);
  const button = el('button', wrap);
  const panel = el('div', wrap);
  panel.id = 'actPanel';
  const outside = el('button', doc.body);
  const event = (props = {}) => {
    const ev = { stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }, ...props };
    return ev;
  };
  const fire = (target, type, props) => {
    const ev = event({ target, ...props });
    for (const fn of target.listeners[type] || []) fn(ev);
    return ev;
  };
  const fireDoc = (type, props) => {
    const ev = event(props);
    for (const l of doc.listeners[type] || []) l.fn(ev);
    return ev;
  };
  // A click on an element of the panel's markup, found by what it carries
  const target = (data) => ({ closest: (sel) => (sel === '[data-asw-mode]' && data.aswMode) || (sel === '[data-asw-act]' && data.aswAct) ? { dataset: data } : null });
  return { doc, wrap, button, panel, outside, fire, fireDoc, target };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('page: the switch wired to a page', () => {
  test('in a plain browser (no bridge) the indicator only explains: no panel, no request, nothing changes', () => {
    setLanguage('en');
    const p = fakePage();
    let explained = 0;
    const sw = createActionsSwitch({ button: p.button, panel: p.panel, bridge: shellBridge({}), getMode: () => 'dry', onUnavailable: () => explained++, doc: p.doc });
    sw.setMode('dry');
    assert.equal(p.button.hidden, false);
    assert.equal(p.button.title, `Actions: Preview · only shows. ${PAGE_STRINGS.en.actionsHowTo}`);
    assert.equal(p.button.getAttribute('aria-haspopup'), null, 'nothing pops up');
    p.fire(p.button, 'click');
    p.fire(p.button, 'click');
    assert.equal(explained, 2);
    assert.equal(p.panel.hidden, true);
    assert.equal(p.panel.innerHTML, '');
    sw.open();
    assert.equal(sw.confirmLive(), false, 'the shell cannot hand On to a page without the bridge');
    assert.equal(sw.isOpen(), false);
    assert.equal(sw.pendingReload(), false);
  });

  test('shellBridge: only a real setActionsMode function counts; a browser has none', () => {
    for (const w of [undefined, null, {}, { sibersentezShell: null }, { sibersentezShell: {} }, { sibersentezShell: { setActionsMode: 'x' } }, { sibersentezShell: { requestActionsMode() {} } }]) {
      assert.equal(shellBridge(w), null, JSON.stringify(w));
    }
    const bridge = { setActionsMode: async () => ({}) };
    assert.equal(shellBridge({ sibersentezShell: bridge }), bridge);
  });

  test("in the app: the indicator opens the panel; Preview goes to the shell at once; On only after Turn on; the shell's answer is shown", async () => {
    setLanguage('en');
    const p = fakePage();
    const sent = [];
    const bridge = { setActionsMode: async (mode) => (sent.push(mode), { changed: true, mode, reason: 'saved' }) };
    const sw = createActionsSwitch({ button: p.button, panel: p.panel, bridge, getMode: () => 'off', doc: p.doc });
    sw.setMode('off');
    assert.equal(p.button.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(p.button.getAttribute('aria-controls'), 'actPanel');
    assert.equal(p.button.getAttribute('aria-expanded'), 'false');
    assert.equal(p.button.getAttribute('aria-label'), 'Actions: Off · only watches');
    p.fire(p.button, 'click');
    assert.equal(p.panel.hidden, false);
    assert.equal(p.button.getAttribute('aria-expanded'), 'true');
    assert.match(p.panel.innerHTML, /role="radiogroup"/);
    // On: the question, nothing sent
    p.fire(p.panel, 'click', { target: p.target({ aswMode: 'live' }) });
    assert.equal(sw.state().step, 'confirm');
    assert.match(p.panel.innerHTML, /asw-confirm/);
    await tick();
    assert.deepEqual(sent, []);
    // Cancel: back to the options, still nothing sent
    p.fire(p.panel, 'click', { target: p.target({ aswAct: 'cancel' }) });
    assert.equal(sw.state().step, 'choose');
    await tick();
    assert.deepEqual(sent, []);
    // On, then Turn on: sent once
    p.fire(p.panel, 'click', { target: p.target({ aswMode: 'live' }) });
    p.fire(p.panel, 'click', { target: p.target({ aswAct: 'confirm' }) });
    assert.equal(sw.pendingReload(), true);
    await tick();
    assert.deepEqual(sent, ['live']);
    assert.equal(sw.state().step, 'saved');
    assert.ok(p.panel.innerHTML.includes(t('actionsSwitchSaved', { mode: modeName('live') })));
    // A second page: Preview goes at once
    const q = fakePage();
    const sent2 = [];
    const sw2 = createActionsSwitch({ button: q.button, panel: q.panel, bridge: { setActionsMode: async (m) => (sent2.push(m), { changed: false, reason: 'write-failed', code: 'WRITE_FAILED' }) }, doc: q.doc });
    sw2.setMode('off');
    q.fire(q.button, 'click');
    q.fire(q.panel, 'click', { target: q.target({ aswMode: 'dry' }) });
    await tick();
    assert.deepEqual(sent2, ['dry']);
    assert.equal(sw2.state().error, 'actionsSwitchErrWrite');
    assert.ok(q.panel.innerHTML.includes(PAGE_STRINGS.en.actionsSwitchErrWrite));
  });

  test('"Turn actions on and install" (the drawer): turnOn saves On through the one bridge call, shows it like a change and answers the reply; busy while a change runs', async () => {
    setLanguage('en');
    const p = fakePage();
    const sent = [];
    const bridge = { setActionsMode: async (mode) => (sent.push(mode), { changed: true, mode, reason: 'saved' }) };
    const sw = createActionsSwitch({ button: p.button, panel: p.panel, bridge, getMode: () => 'off', doc: p.doc });
    sw.setMode('off');
    const pending = sw.turnOn();
    assert.equal(sw.state().step, 'saving', 'the drawer asked the question: straight to saving');
    assert.deepEqual(await sw.turnOn(), { changed: false, mode: null, reason: 'busy' }, 'a second call while saving does nothing');
    assert.deepEqual(await pending, { changed: true, mode: 'live', reason: 'saved' });
    assert.deepEqual(sent, ['live'], 'one call');
    assert.equal(sw.state().step, 'saved');
    // No bridge (a plain browser): nothing is asked
    const q = fakePage();
    const none = createActionsSwitch({ button: q.button, panel: q.panel, bridge: null, doc: q.doc });
    assert.equal((await none.turnOn()).reason, 'busy');
    // A refused write: the reply comes back and the switch shows the error
    const w = fakePage();
    const sw3 = createActionsSwitch({ button: w.button, panel: w.panel, bridge: { setActionsMode: async () => ({ changed: false, reason: 'write-failed', code: 'WRITE_FAILED' }) }, doc: w.doc });
    sw3.setMode('off');
    assert.equal((await sw3.turnOn()).reason, 'write-failed');
    assert.equal(sw3.state().error, 'actionsSwitchErrWrite');
  });

  test('a bridge that fails or throws reads as "not changed"; the page never crashes', async () => {
    for (const setActionsMode of [async () => { throw new Error('ipc gone'); }, () => Promise.reject(new Error('x')), async () => undefined]) {
      const p = fakePage();
      const sw = createActionsSwitch({ button: p.button, panel: p.panel, bridge: { setActionsMode }, doc: p.doc });
      sw.setMode('off');
      p.fire(p.button, 'click');
      p.fire(p.panel, 'click', { target: p.target({ aswMode: 'dry' }) });
      await tick();
      assert.equal(sw.state().step, 'choose');
      assert.equal(sw.state().error, 'actionsSwitchErrOther');
    }
  });

  test("while open the switch owns the keyboard: Esc closes it and no global shortcut (tabs, replay, the drawer's Esc) sees the key", () => {
    const p = fakePage();
    const sw = createActionsSwitch({ button: p.button, panel: p.panel, bridge: qaBridge(), doc: p.doc });
    sw.setMode('off');
    // Closed: keys pass through untouched
    let ev = p.fire(p.wrap, 'keydown', { key: 'Escape', target: p.button });
    assert.equal(ev.stopped, false);
    p.fire(p.button, 'click');
    for (const key of ['1', 'r', 'Tab']) {
      ev = p.fire(p.wrap, 'keydown', { key, target: p.panel });
      assert.equal(ev.stopped, true, key);
      assert.equal(ev.prevented, false, `${key} keeps its own meaning`);
    }
    ev = p.fire(p.wrap, 'keydown', { key: 'ArrowDown', target: p.panel });
    assert.equal(ev.prevented, true);
    assert.equal(sw.state().focus, 'dry');
    ev = p.fire(p.wrap, 'keydown', { key: 'Escape', target: p.panel });
    assert.equal(ev.stopped, true);
    assert.equal(sw.isOpen(), false);
    assert.equal(p.panel.hidden, true);
    assert.equal(p.doc.activeElement, p.button, 'the focus goes back to the indicator');
  });

  test('a click outside closes it and is not passed on; the focus leaving it (Tab) closes it too', () => {
    const p = fakePage();
    const sw = createActionsSwitch({ button: p.button, panel: p.panel, bridge: qaBridge(), doc: p.doc });
    sw.setMode('off');
    p.fire(p.button, 'click');
    // Inside the switch: nothing happens
    let down = p.fireDoc('pointerdown', { target: p.panel });
    assert.equal(down.stopped, false);
    assert.equal(sw.isOpen(), true);
    down = p.fireDoc('pointerdown', { target: p.outside });
    assert.equal(sw.isOpen(), false);
    assert.equal(down.stopped, true, 'the press that closes it reaches nothing else');
    const click = p.fireDoc('click', { target: p.outside });
    assert.equal(click.prevented && click.stopped, true, 'nor does its click');
    const later = p.fireDoc('click', { target: p.outside });
    assert.equal(later.stopped, false, 'the next click is an ordinary click again');
    // Closed: a click anywhere is untouched
    assert.equal(p.fireDoc('pointerdown', { target: p.outside }).stopped, false);
    // Tab out of the switch
    p.fire(p.button, 'click');
    assert.equal(sw.isOpen(), true);
    p.fire(p.wrap, 'focusout', { relatedTarget: p.outside });
    assert.equal(sw.isOpen(), false);
    // The focus moving inside the switch, or to nowhere (another window), keeps it open
    p.fire(p.button, 'click');
    p.fire(p.wrap, 'focusout', { relatedTarget: p.button });
    p.fire(p.wrap, 'focusout', { relatedTarget: null });
    assert.equal(sw.isOpen(), true);
  });

  test("the shell's hand-over opens the question; the drawer's Change actions opens the same switch", () => {
    const p = fakePage();
    const sw = createActionsSwitch({ button: p.button, panel: p.panel, bridge: qaBridge(), doc: p.doc });
    sw.setMode('dry');
    assert.equal(sw.confirmLive(), true);
    assert.equal(sw.isOpen(), true);
    assert.equal(sw.state().step, 'confirm');
    const main = textOf('public', 'js', 'main.js');
    assert.ok(main.includes('if (shellBridge(window)) window.sibersentezActionsPanel = Object.freeze({ confirmLive: () => actSwitch.confirmLive() });'), 'only in the app');
    assert.ok(main.includes("openActionsChooser: () => $('#actMode')?.click(),"));
    assert.ok(main.includes('button: $(\'#actMode\'),') && main.includes("panel: $('#actPanel'),"));
    assert.ok(main.includes("bridge: QA_PANEL ? qaBridge(QA_PANEL === 'saved') : shellBridge(window),"), 'the stand-in only with ?qa=1&actpanel=');
    assert.ok(main.includes("const QA_PANEL = QA ? params.get('actpanel') : null;"));
  });

  test('the QA stand-in never reaches anything: it only answers', async () => {
    assert.deepEqual(await qaBridge().setActionsMode('live'), { changed: false, mode: null, reason: 'refused' });
    assert.deepEqual(await qaBridge(true).setActionsMode('dry'), { changed: true, mode: 'dry', reason: 'saved' });
    assert.deepEqual(Object.keys(qaBridge()), ['setActionsMode']);
  });
});

// ------------------------------------------------------------------ where the user was
describe('page: the tab and the open drawer survive the reload after a mode change', () => {
  const TABS = ['projects', 'roster', 'timeline', 'feed'];

  test('kept only for a reload after a restart (a change from the panel, or a server that went away)', () => {
    assert.equal(keepPlace({ switching: true }), true);
    assert.equal(keepPlace({ serverLost: true }), true);
    assert.equal(keepPlace({}), false, 'a manual reload of a healthy page starts fresh');
    assert.equal(keepPlace({ switching: 'yes', serverLost: 1 }), false);
    assert.equal(keepPlace(), false);
  });

  test('the record: a known tab and a drawer target (type, id, section); anything else is dropped', () => {
    const rec = resumeRecord({ tab: 'roster', drawer: { type: 'project', id: 'alpha', section: 'skills', extra: 'x' } }, TABS);
    assert.deepEqual(JSON.parse(rec), { tab: 'roster', drawer: { type: 'project', id: 'alpha', section: 'skills' } });
    assert.deepEqual(readResume(rec, TABS), { tab: 'roster', drawer: { type: 'project', id: 'alpha', section: 'skills' } });
    assert.deepEqual(readResume(resumeRecord({ tab: 'feed', drawer: { type: 'session', id: 's1', section: 'bogus' } }, TABS), TABS), { tab: 'feed', drawer: { type: 'session', id: 's1' } });
    assert.equal(resumeRecord({ tab: 'nope', drawer: null }, TABS), null, 'nothing worth keeping');
    assert.equal(resumeRecord({ tab: 'projects', drawer: { type: 'podium', id: 'x' } }, TABS), JSON.stringify({ tab: 'projects', drawer: null }));
    const none = { tab: null, drawer: null };
    for (const raw of [null, undefined, '', '{', 'null', '42', '"x"', JSON.stringify({ tab: 'x', drawer: { type: 'project', id: 7 } }), JSON.stringify({ drawer: { type: 'project', id: 'a'.repeat(600) } }), 'x'.repeat(3000)]) {
      assert.deepEqual(readResume(raw, TABS), none, String(raw).slice(0, 40));
    }
    assert.equal(RESUME_KEY, 'sibersentez.resume');
  });

  test('main.js: read and removed once at start, the drawer reopened after the first snapshot, saved on pagehide after a restart', () => {
    const main = textOf('public', 'js', 'main.js');
    assert.ok(main.includes('resume = readResume(sessionStorage.getItem(RESUME_KEY), TAB_KEYS);\n  sessionStorage.removeItem(RESUME_KEY);'));
    assert.ok(main.includes('if (resume.tab) active = resume.tab;'));
    assert.ok(main.indexOf('if (resume.tab) active = resume.tab;') < main.indexOf('showTab(active);\nrenderConn();'), 'before the first showTab');
    assert.ok(main.includes('if (first && resume.drawer && !QA) open(resume.drawer);'));
    assert.ok(main.includes("window.addEventListener('pagehide', () => {\n  if (!keepPlace({ switching: actSwitch.pendingReload(), serverLost })) return;"));
    assert.ok(main.includes('const rec = resumeRecord({ tab: active, drawer: drawer.isOpen() ? lastOpened : null }, TAB_KEYS);'));
    assert.ok(/es\.onerror = \(\) => \{\n\s+serverLost = true;/.test(main), 'a dropped live connection marks the restart');
    assert.doesNotMatch(main, /localStorage\.setItem\(RESUME_KEY/, 'this window only, never across app runs');
  });
});
