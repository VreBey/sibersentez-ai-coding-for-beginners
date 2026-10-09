// Preload of the SiberSentez window (docs/actions-toggle.md §3b, docs/start-flow.md step 2). It runs sandboxed and
// context-isolated in the window's top frame only (no preload in subframes, window.open is always denied), so the page
// never sees ipcRenderer, Node or Electron. The page gets these functions:
//
//   window.sibersentezShell.setActionsMode(mode)              mode: 'off' | 'dry' | 'live'
//   window.sibersentezShell.pickProjectFolder()               the folder picker for a new project
//   window.sibersentezShell.pickLibraryFolder()               the folder picker of "Add to the library" (answers the path)
//   window.sibersentezShell.setLanguage(lang)                 the language chosen in Settings ('auto' | 'en' | 'tr')
//   window.sibersentezShell.setTheme(theme)                   the look chosen in Settings ('dark' | 'light' | 'system')
//   window.sibersentezShell.saveProjectIdea(projectId, text)  the project's idea, kept with the program's project memory
//   window.sibersentezShell.reportError(text)                 an error of the page, written to the shell's log (review A4)
//   window.sibersentezShell.openLogs()                        the folder of the shell's logs, in File Explorer
//
// setActionsMode asks the shell to switch the actions mode and resolves the shell's short answer ({ changed, mode,
// reason, code? }, electron/helpers.mjs panelReply). The panel asks the user before it sends 'live'.
// pickProjectFolder opens the system folder picker (a folder can be created in it); the shell checks the folder and the
// server remembers it as a project. saveProjectIdea stores the idea of a project the server already remembers. Both
// resolve { ok, reason, projectId?, existed?, saved? } (helpers.mjs projectReply): never a path.
// The shell honours every call only from its main window's top frame while that frame shows the server origin
// (helpers.mjs bridgeSender); anything but the listed argument types is refused here already and never reaches the
// shell. Nothing else is exposed: no listener, no send, no way to read the mode or a folder (pickLibraryFolder answers
// only the folder the person just chose in the system picker).
// CommonJS on purpose: a sandboxed preload cannot be an ES module.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Same names as ACTIONS_IPC_CHANNEL, PROJECT_PICK_IPC_CHANNEL and PROJECT_IDEA_IPC_CHANNEL in helpers.mjs (checked by
// test/actions-in-app.test.mjs and test/new-project.test.mjs)
const CHANNEL = 'sibersentez:set-actions-mode';
const PICK_CHANNEL = 'sibersentez:pick-project-folder';
const IDEA_CHANNEL = 'sibersentez:save-project-idea';
const IDEA_PROJECT_CHANNEL = 'sibersentez:create-idea-project';
// Same name as LIBRARY_PICK_IPC_CHANNEL in helpers.mjs
const LIBRARY_PICK_CHANNEL = 'sibersentez:pick-library-folder';
// Same name and choices as LANGUAGE_IPC_CHANNEL and LANGUAGE_CHOICES in helpers.mjs
const LANGUAGE_CHANNEL = 'sibersentez:set-language';
const LANGUAGES = ['auto', 'en', 'tr'];
// Same name and choices as THEME_IPC_CHANNEL and THEME_CHOICES in helpers.mjs
const THEME_CHANNEL = 'sibersentez:set-theme';
const THEMES = ['dark', 'light', 'system'];
// Same name and limit as ATTENTION_IPC_CHANNEL and ATTENTION_TEXT_MAX in helpers.mjs
const ATTENTION_CHANNEL = 'sibersentez:attention';
const ATTENTION_MAX = 80;
// Same names and limit as PAGE_ERROR_IPC_CHANNEL, LOGS_OPEN_IPC_CHANNEL and PAGE_ERROR_MAX in helpers.mjs
const PAGE_ERROR_CHANNEL = 'sibersentez:page-error';
const LOGS_CHANNEL = 'sibersentez:open-logs';
const PAGE_ERROR_MAX = 1000;
const MODES = ['off', 'dry', 'live'];
// Same rules as PROJECT_ID_RE (server/util.mjs; the sandboxed preload cannot import it) and IDEA_TEXT_MAX in helpers.mjs
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const IDEA_MAX = 1200;

// Embedded terminals (docs/embedded-terminal.md): ids and keystrokes only; the main process checks the sender and asks
// the server where a terminal opens
const TERM = { open: 'sibersentez:term-open', write: 'sibersentez:term-write', resize: 'sibersentez:term-resize', close: 'sibersentez:term-close', list: 'sibersentez:term-list', data: 'sibersentez:term-data', exit: 'sibersentez:term-exit', toolEnd: 'sibersentez:term-tool-end' };
const TERM_ID = /^t[1-9][0-9]{0,6}$/;
const LAUNCH_ID = /^L[0-9a-f]{24}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERM_WRITE_MAX = 64 * 1024;
const size = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);

contextBridge.exposeInMainWorld('sibersentezTerminal', {
  open(target, cols, rows) {
    const t = target && typeof target === 'object' ? target : {};
    const req =
      typeof t.projectId === 'string' && PROJECT_ID.test(t.projectId)
        ? { projectId: t.projectId }
        : typeof t.sessionId === 'string' && SESSION_ID.test(t.sessionId)
          ? { sessionId: t.sessionId }
          : typeof t.launchId === 'string' && LAUNCH_ID.test(t.launchId)
            ? { launchId: t.launchId }
            : // The setup terminal (installing an AI tool): exactly { setup: true } (it was dropped here: "Type in
              // terminal" never opened, found by using the app 2026-10-08)
              t.setup === true && Object.keys(t).length === 1
              ? { setup: true }
              : null;
    if (!req) return Promise.resolve({ ok: false, reason: 'invalid' });
    return ipcRenderer.invoke(TERM.open, req, size(cols, 2, 500), size(rows, 2, 200));
  },
  write(id, data) {
    if (typeof id === 'string' && TERM_ID.test(id) && typeof data === 'string' && data.length <= TERM_WRITE_MAX) ipcRenderer.send(TERM.write, id, data);
  },
  resize(id, cols, rows) {
    if (typeof id === 'string' && TERM_ID.test(id) && size(cols, 2, 500) && size(rows, 2, 200)) ipcRenderer.send(TERM.resize, id, cols, rows);
  },
  close(id) {
    return typeof id === 'string' && TERM_ID.test(id) ? ipcRenderer.invoke(TERM.close, id) : Promise.resolve(false);
  },
  list() {
    return ipcRenderer.invoke(TERM.list);
  },
  // One listener each (listenOnly); the page gets (id, text) and (id, exitCode), never the event object
  onData(fn) {
    if (typeof fn === 'function') listenOnly(TERM.data, (_e, id, text) => fn(id, text));
  },
  onExit(fn) {
    if (typeof fn === 'function') listenOnly(TERM.exit, (_e, id, code) => fn(id, code));
  },
  // The AI tool of a tab ended, its shell stays open (the launcher's mark): the page gets (id)
  onToolEnd(fn) {
    if (typeof fn === 'function') listenOnly(TERM.toolEnd, (_e, id) => fn(id));
  },
});

// The terminal bridge's listeners (above; hoisted): one per channel (review A7): a second call replaces the first instead of adding another, so a page that
// sets its terminal up again never gets each line twice
const listening = {};
function listenOnly(channel, handler) {
  if (listening[channel]) ipcRenderer.removeListener(channel, listening[channel]);
  listening[channel] = handler;
  ipcRenderer.on(channel, handler);
}

contextBridge.exposeInMainWorld('sibersentezShell', {
  setActionsMode(mode) {
    if (typeof mode !== 'string' || !MODES.includes(mode)) return Promise.resolve({ changed: false, mode: null, reason: 'invalid' });
    return ipcRenderer.invoke(CHANNEL, mode);
  },
  pickProjectFolder() {
    return ipcRenderer.invoke(PICK_CHANNEL);
  },
  // A new project from an idea (review U05): its name and idea; choose: pick where its folder goes (else
  // the SiberSentez folder in Documents). Resolves { ok, projectId? , reason } only, never a path.
  createIdeaProject(name, idea, choose) {
    if (typeof name !== 'string' || name.length > 200 || typeof idea !== 'string' || idea.length > IDEA_MAX || typeof choose !== 'boolean') {
      return Promise.resolve({ ok: false, reason: 'invalid' });
    }
    return ipcRenderer.invoke(IDEA_PROJECT_CHANNEL, name, idea, choose);
  },
  // "Add to the library": the system folder picker; resolves { ok, path } or { ok: false, reason }
  pickLibraryFolder() {
    return ipcRenderer.invoke(LIBRARY_PICK_CHANNEL);
  },
  // The language chosen in Settings: 'auto' (follow Windows), 'en' or 'tr'; the window loads again in it
  setLanguage(lang) {
    if (typeof lang !== 'string' || !LANGUAGES.includes(lang)) return Promise.resolve({ ok: false, reason: 'invalid' });
    return ipcRenderer.invoke(LANGUAGE_CHANNEL, lang);
  },
  // The look chosen in Settings: the window's title bar and background follow it; resolves { ok }
  setTheme(theme) {
    if (typeof theme !== 'string' || !THEMES.includes(theme)) return Promise.resolve({ ok: false, reason: 'invalid' });
    return ipcRenderer.invoke(THEME_CHANNEL, theme);
  },
  saveProjectIdea(projectId, text) {
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId) || typeof text !== 'string' || text.length > IDEA_MAX) {
      return Promise.resolve({ ok: false, reason: 'invalid' });
    }
    return ipcRenderer.invoke(IDEA_CHANNEL, projectId, text);
  },
  // How many sessions wait for the person, and the header's words for it (docs/attention.md §4)
  setAttention(count, text) {
    if (!Number.isInteger(count) || count < 0 || count > 999 || typeof text !== 'string' || text.length > ATTENTION_MAX) {
      return Promise.resolve({ ok: false, reason: 'invalid' });
    }
    return ipcRenderer.invoke(ATTENTION_CHANNEL, count, text);
  },
  // An error of the page (pageErrors.js): one line of text to the shell's log; resolves whether it was written
  reportError(text) {
    if (typeof text !== 'string' || text.length === 0 || text.length > PAGE_ERROR_MAX) return Promise.resolve(false);
    return ipcRenderer.invoke(PAGE_ERROR_CHANNEL, text);
  },
  openLogs() {
    return ipcRenderer.invoke(LOGS_CHANNEL);
  },
});
