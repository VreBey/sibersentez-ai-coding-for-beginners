// @ts-check
// The shell's QA run (docs/release.md; tools/electron-qa.ps1): the actions switch, the screenshot and the fixed probes
// a --qa start runs, moved out of electron/main.mjs (docs/internal/module-split-plan.md M1). main.mjs makes it once with
// what it shares (ctx: the window, the strings and the tray are read when used; they change while the app runs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { QA_ACTIONS_SCRIPTS, QA_SERVED_MODE_SCRIPT, QA_BRIDGE_PROBE_SCRIPT, QA_KIT_PROBE_SCRIPT, QA_ABOUT_PROBE_SCRIPT, QA_PANEL_PATH, QA_PANEL_PROBE_SCRIPT, QA_LAPTOP_PATH, QA_LAPTOP_PROBE_SCRIPT, QA_LAPTOP_SIZE, QA_VIEWPORT_SCRIPT, QA_LAPTOP_DEMO_SCRIPT, QA_KEYS_SCRIPTS, actionsMenuItems, checkProjectFolder, pickProjectFolder, projectReply, systemFolderRules } from './helpers.mjs';

/**
 * @typedef {{
 *   QA: any, QA_ACTIONS: any, QA_SHELL: any, log: (line: string) => void, state: any, serverCalls: any,
 *   readonly S: any, readonly win: any, readonly tray: any,
 *   currentActionsMode: () => string, chooseActionsMode: (mode: any, source: string) => Promise<any>,
 *   projectFolderRules: () => any, quitApp: (reason: string) => void, loadPty: () => any
 * }} QaContext
 */

/** @param {QaContext} ctx */
export function createQaRun(ctx) {
  const { QA, QA_ACTIONS, QA_SHELL, log, state, serverCalls, currentActionsMode, chooseActionsMode, projectFolderRules, quitApp, loadPty } = ctx;
  let qaShotScheduled = false;
  let qaActionsStep = QA_ACTIONS.mode ? 'pending' : 'none'; // 'pending' -> 'running' -> 'done'

  // Permission states as the page sees them (read-only query; the clipboard itself is not touched)
  const QA_PERMISSION_PROBE = `Promise.all(['clipboard-write', 'clipboard-read', 'notifications', 'geolocation'].map((name) =>
    navigator.permissions.query({ name }).then((s) => name + '=' + s.state, () => name + '=error'))).then((r) => r.join(', '))`;

  // QA actions switch (SIBERSENTEZ_QA_ACTIONS): after the first page load and the QA delay, the mode changes through
  // chooseActionsMode, the tray's own path. The tray submenu's template is logged before and after.
  function logQaActionsMenu(when) {
    const items = actionsMenuItems(ctx.S, currentActionsMode()).map(({ label, checked }) => ({ label, checked }));
    log(`QA tray actions menu (${when}): ${JSON.stringify({ label: ctx.S.trayActions, submenu: items })}`);
  }

  function scheduleQaActions() {
    if (qaActionsStep !== 'pending') return;
    qaActionsStep = 'running';
    setTimeout(async () => {
      logQaActionsMenu('before');
      const r = await chooseActionsMode(QA_ACTIONS.mode, 'qa');
      logQaActionsMenu('after');
      qaActionsStep = 'done';
      // No change means no restart and no reload: the page on screen is final
      if (!r?.changed) scheduleQaShot();
    }, QA.delayMs);
  }

  function scheduleQaShot() {
    // With a QA actions switch the screenshot waits for the page reloaded after the restart; the probes take their own
    if (!QA.shot || QA_SHELL.probes || qaShotScheduled || (qaActionsStep !== 'none' && qaActionsStep !== 'done')) return;
    qaShotScheduled = true;
    setTimeout(async () => {
      log(`QA permissions: ${await qaRun(QA_PERMISSION_PROBE)}`);
      await qaCapture(QA.shot);
      quitApp('QA: screenshot taken');
    }, QA.delayMs);
  }

  // Every script the QA code runs in the page goes through here: fixed texts only (QA_PERMISSION_PROBE and the probes'
  // scripts in helpers.mjs). An error is returned as text, never thrown.
  async function qaRun(script) {
    try {
      return await ctx.win.webContents.executeJavaScript(script);
    } catch (e) {
      return `error: ${e?.message}`;
    }
  }

  // The window's page as a PNG (never overwrites an existing file). A hidden window paints its first page by itself
  // (windowOptions); after a later navigation it may still hold an old frame. While a capture runs the page counts as
  // visible to its renderer (Electron's capturer count), so a first capture asks for a new frame and the second one,
  // a moment later, takes it.
  async function qaCapture(file) {
    try {
      await ctx.win.webContents.capturePage();
      ctx.win.webContents.invalidate();
      await qaSleep(1500);
      const image = await ctx.win.webContents.capturePage();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, image.toPNG(), { flag: 'wx' }); // never overwrites an existing file
      const { width, height } = image.getSize();
      log(`QA: screenshot saved (${width}x${height}${image.isEmpty() ? ', empty' : ''})`);
    } catch (e) {
      log(`QA: screenshot failed: ${e?.code || e?.message}`);
    }
  }

  // ---------------------------------------------------------------- QA probes (SIBERSENTEZ_QA_PROBES)
  // Each probe writes one line "QA probe <name>: <result>" to the main log, which tools/electron-qa.ps1 reads. Nothing of a
  // probe needs a visible window, a dialog or the tray; the project probe runs only in a hidden run.

  // One-shot signals of the shell's own events: the next ready server, the next finished page load
  const qaWaiters = { 'server-ready': [], 'page-loaded': [] };
  function qaSignal(name) {
    const list = qaWaiters[name];
    if (!list?.length) return;
    qaWaiters[name] = [];
    for (const resolve of list) resolve(true);
  }
  function qaNext(name, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      qaWaiters[name].push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  const qaSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const qaJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  function qaProbe(name, value) {
    log(`QA probe ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }

  let qaProbesStarted = false;
  function scheduleQaProbes() {
    if (!QA_SHELL.probes || qaProbesStarted) return;
    qaProbesStarted = true;
    setTimeout(() => {
      runQaProbes()
        .catch((e) => log(`QA probes failed: ${e?.message}`))
        .finally(() => quitApp('QA: probes done'));
    }, QA.delayMs);
  }

  // setActionsMode(mode) through the page's bridge (the in-app panel's path, IPC and all). The running server takes the
  // mode in place (docs/actions-toggle.md §3.5), which the shell has awaited before the bridge answers: the probe asks
  // the page's server for the mode it now serves and checks that the same server process is still the one
  async function qaSwitchThroughBridge(mode) {
    const oldPid = state.server?.pid ?? null;
    const reply = qaJson(await qaRun(QA_ACTIONS_SCRIPTS[mode]));
    const stored = currentActionsMode();
    const served = qaJson(await qaRun(QA_SERVED_MODE_SCRIPT));
    qaProbe(`actions ${mode}`, { reply, stored, served, sameServer: oldPid !== null && (state.server?.pid ?? null) === oldPid });
  }

  // A new project the way the header button adds one, without the picker: the tested pickProjectFolder with the QA
  // folder as the picker's answer, the shell's folder check, and the server's 'project-add' over its message channel;
  // then the idea. The log gets the replies (projectReply: never a path).
  async function qaProjectProbe() {
    const rules = projectFolderRules();
    const reasonOf = (folder) => checkProjectFolder(folder, rules).reason || 'ok';
    qaProbe('folder rule inside the hub', reasonOf(path.join(state.hubPath, 'registry')));
    qaProbe('folder rule holding the hub', reasonOf(path.dirname(state.hubPath)));
    const systemRoot = systemFolderRules(process.env).trees[0];
    qaProbe('folder rule system folder', systemRoot ? reasonOf(path.join(systemRoot, 'System32')) : 'no SystemRoot');
    const added = projectReply(
      await pickProjectFolder({
        S: ctx.S,
        showOpenDialog: async () => ({ canceled: false, filePaths: [QA_SHELL.projectDir] }),
        check: (folder) => checkProjectFolder(folder, rules),
        add: (folder) => serverCalls.call(state.server, 'project-add', { path: folder }),
      }),
    );
    qaProbe('project-add', added);
    if (!added.ok) return;
    qaProbe('project-idea', projectReply(await serverCalls.call(state.server, 'project-idea', { projectId: added.projectId, idea: 'QA: a small test project' })));
  }

  // The actions panel through its own QA hook (?qa=1&actpanel=choose), and a screenshot of it
  async function qaPanelProbe() {
    const loaded = qaNext('page-loaded', 30000);
    ctx.win.loadURL(`${state.origin}${QA_PANEL_PATH}`);
    if (!(await loaded)) return qaProbe('actions panel', 'page not loaded');
    let panel = 'closed';
    for (let i = 0; i < 40 && panel !== 'open'; i++) {
      await qaSleep(250);
      panel = await qaRun(QA_PANEL_PROBE_SCRIPT);
    }
    qaProbe('actions panel', panel);
    if (QA.shot) await qaCapture(QA.shot);
  }

  // The next step on a laptop screen (helpers QA_LAPTOP_PROBE_SCRIPT): the page is shown as a 1366 x 768 screen
  // (device emulation: a hidden window keeps its own size), then back to the window's own
  async function qaLaptopProbe() {
    const wc = ctx.win.webContents;
    const { width, height } = QA_LAPTOP_SIZE;
    try {
      const loaded = qaNext('page-loaded', 30000);
      ctx.win.loadURL(`${state.origin}${QA_LAPTOP_PATH}`);
      if (!(await loaded)) return qaProbe('laptop next step', 'page not loaded');
      wc.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width, height }, viewPosition: { x: 0, y: 0 }, viewSize: { width, height }, deviceScaleFactor: 0, scale: 1 });
      let got = 'missing';
      for (let i = 0; i < 40; i++) {
        await qaSleep(250);
        got = await qaRun(QA_LAPTOP_PROBE_SCRIPT);
        const size = qaJson(await qaRun(QA_VIEWPORT_SCRIPT)) || [];
        if (got !== 'missing' && size[0] === width && size[1] === height) break;
      }
      qaProbe('laptop next step', got);
      // The same in the example, whose step has a button
      let demo = await qaRun(QA_LAPTOP_DEMO_SCRIPT);
      for (let i = 0; i < 20 && demo !== 'missing'; i++) {
        await qaSleep(250);
        demo = await qaRun(QA_LAPTOP_PROBE_SCRIPT);
        if (qaJson(demo)?.step === 'demo') break;
      }
      qaProbe('laptop next step demo', demo);
    } finally {
      wc.disableDeviceEmulation();
    }
  }

  // The keyboard (helpers QA_KEYS_SCRIPTS): real key events into the page the laptop probe left loaded. A hidden run
  // takes them as well (they go to the page, not to the screen)
  async function qaKeyboardProbe() {
    const wc = ctx.win.webContents;
    const key = async (keyCode, modifiers = []) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      if (keyCode.length === 1) wc.sendInputEvent({ type: 'char', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await qaSleep(200);
    };
    const out = {};
    out.searchButton = await qaRun(QA_KEYS_SCRIPTS.focusSearch);
    await key('K', ['control']);
    out.opened = qaJson(await qaRun(QA_KEYS_SCRIPTS.searchState));
    await key('Tab');
    await key('Tab');
    await key('Tab', ['shift']);
    out.afterTabs = qaJson(await qaRun(QA_KEYS_SCRIPTS.searchState));
    await key('Escape');
    out.afterEscape = qaJson(await qaRun(QA_KEYS_SCRIPTS.searchState));
    out.menuButton = await qaRun(QA_KEYS_SCRIPTS.focusMenu);
    await key('Down');
    out.menu = qaJson(await qaRun(QA_KEYS_SCRIPTS.menuState));
    qaProbe('keyboard', out);
  }

  async function runQaProbes() {
    qaProbe('hidden', { hidden: QA_SHELL.hidden, visible: Boolean(ctx.win?.isVisible()), tray: Boolean(ctx.tray) });
    qaProbe('bridge', await qaRun(QA_BRIDGE_PROBE_SCRIPT));
    qaProbe('kit', await qaRun(QA_KIT_PROBE_SCRIPT));
    qaProbe('about', await qaRun(QA_ABOUT_PROBE_SCRIPT));
    qaProbe('kit folder', { packaged: app.isPackaged, resourcesKit: app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'kit', 'catalog.json')) });
    // On is never reached in QA: not through the page's bridge, not through the tray's path
    qaProbe('actions live via bridge', { reply: qaJson(await qaRun(QA_ACTIONS_SCRIPTS.live)), stored: currentActionsMode() });
    const viaTray = await chooseActionsMode('live', 'tray');
    qaProbe('actions live via tray', { changed: viaTray.changed, reason: viaTray.reason, stored: currentActionsMode() });
    await qaSwitchThroughBridge('dry');
    await qaSwitchThroughBridge('off');
    if (QA_SHELL.hidden && QA_SHELL.projectDir) await qaProjectProbe();
    else qaProbe('project-add', 'skipped (needs SIBERSENTEZ_QA_HIDDEN=1 and SIBERSENTEZ_QA_PROJECT_DIR)');
    await qaLaptopProbe();
    await qaKeyboardProbe();
    await qaPanelProbe();
    await qaTerminalProbe();
    qaProbe('hidden at the end', { visible: Boolean(ctx.win?.isVisible()), tray: Boolean(ctx.tray) });
  }

  // The embedded terminals' pseudo console in this build (docs/embedded-terminal.md): node-pty loads from outside the
  // archive and runs one fixed command in the temp folder; nothing reaches the window
  async function qaTerminalProbe() {
    // The platform's own pty binary: Windows' and macOS' prebuilt ones; on Linux node-pty is built from source
    // (build/Release/pty.node), there is no prebuilt binary for it
    const ptyBin = process.platform === 'win32' ? ['prebuilds', 'win32-x64', 'conpty.node'] : process.platform === 'darwin' ? ['prebuilds', `darwin-${process.arch}`, 'pty.node'] : ['build', 'Release', 'pty.node'];
    const unpacked = app.isPackaged ? fs.existsSync(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty', ...ptyBin)) : null;
    const result = await new Promise((resolve) => {
      let out = '';
      let p;
      try {
        p =
          process.platform === 'win32'
            ? loadPty().spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/c', 'echo sibersentez-pty-ok'], { name: 'xterm-256color', useConpty: true, cwd: os.tmpdir(), cols: 80, rows: 24, env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows' } }) // an empty environment: CreateProcess error 87 on current Windows
            : loadPty().spawn('/bin/sh', ['-c', 'echo sibersentez-pty-ok'], { name: 'xterm-256color', cwd: os.tmpdir(), cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin' } });
      } catch (e) {
        resolve({ loaded: false, error: e?.code || e?.message || 'error' });
        return;
      }
      const timer = setTimeout(() => {
        try {
          p.kill();
        } catch {
          // gone
        }
        resolve({ loaded: true, exitCode: null, echoed: out.includes('sibersentez-pty-ok') });
      }, 10000);
      p.onData((d) => (out += d));
      p.onExit(({ exitCode }) => {
        clearTimeout(timer);
        resolve({ loaded: true, exitCode, echoed: out.includes('sibersentez-pty-ok') });
      });
    });
    qaProbe('terminal', { unpacked, ...result });
  }

  return { qaSignal, scheduleQaActions, scheduleQaShot, scheduleQaProbes };
}
