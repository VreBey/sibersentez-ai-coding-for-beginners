// A new project from the shell: the folder picker, the folder rules and the idea (docs/start-flow.md; plan D8: from
// helpers.mjs, which re-exports it). Pure, no Electron.
import fs from 'node:fs';
import path from 'node:path';
import { redact, PROJECT_ID_RE } from '../server/util.mjs';
import { bridgeSender } from './actions-mode.mjs';
import { IS_WINDOWS, checkLocalDir, isInside, pathsOverlap, samePath } from './shell-paths.mjs';
import { PLATFORM, isLocalAbsolute } from '../server/platform.mjs';

// A local absolute folder from a dialog: Windows' rule as before (absolute, never a network path); elsewhere one
// leading slash (plan G1)
const localAbsolute = (p) => (PLATFORM.windows ? path.win32.isAbsolute(p) && !/^[\\/]{2}/.test(p) : isLocalAbsolute(p, PLATFORM));

// ---------------------------------------------------------------- a new project (docs/start-flow.md, step 2)

// Two more channels of the same bridge (electron/preload.cjs keeps its own copy of the names; the tests check both):
//   sibersentez:pick-project-folder  no arguments: the shell opens the folder picker, checks the folder and has the server
//                                 remember it as a project (the program's project memory, <hub>\registry\discovered.json)
//   sibersentez:save-project-idea    (projectId, text): the server keeps the project's idea with that memory entry
// Both work whatever the actions mode is: the project memory is the program's own record, it is written anyway.
export const PROJECT_PICK_IPC_CHANNEL = 'sibersentez:pick-project-folder';
export const PROJECT_IDEA_IPC_CHANNEL = 'sibersentez:save-project-idea';

// "What needs you" on the taskbar (docs/attention.md §4): the page says how many sessions wait for the person and the
// same words as its header counter; the shell puts a dot on the taskbar button, the count in the tray's tooltip, and
// flashes the button when the count grows while the window is in the background. Nothing else comes with it.
export const ATTENTION_IPC_CHANNEL = 'sibersentez:attention';
export const ATTENTION_TEXT_MAX = 80;

// Checks a page's attention report: from the main window's top frame on the app origin, count an integer 0..999, text
// a short printable string. Returns { ok, count, text } or { ok: false, reason }.
export function attentionRequest({ count, text, mainWindow = false, frame = null, origin = null } = {}) {
  const sender = bridgeSender({ mainWindow, frame, origin });
  if (!sender.ok) return sender;
  if (!Number.isInteger(count) || count < 0 || count > 999) return { ok: false, reason: 'invalid' };
  if (typeof text !== 'string' || text.length > ATTENTION_TEXT_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(text)) return { ok: false, reason: 'invalid' };
  return { ok: true, count, text: text.trim() };
}

// Errors of the page (review A4, public/js/pageErrors.js): one line each in main.log, from the main window's top frame
// only, control characters made spaces, at most PAGE_ERRORS_PER_RUN per run (a page stuck in a loop cannot fill the
// log). Returns the line to write, or null. The log itself masks the home folder.
export const PAGE_ERROR_IPC_CHANNEL = 'sibersentez:page-error';
export const LOGS_OPEN_IPC_CHANNEL = 'sibersentez:open-logs';
export const PAGE_ERROR_MAX = 1000;
export const PAGE_ERRORS_PER_RUN = 50;
export function pageErrorLine({ text, logged = 0, mainWindow = false, frame = null, origin = null } = {}) {
  if (!bridgeSender({ mainWindow, frame, origin }).ok) return null;
  if (typeof text !== 'string' || text.length > PAGE_ERROR_MAX || logged >= PAGE_ERRORS_PER_RUN) return null;
  // Masked like every text the app shows (keys, Bearer values, passwords in addresses): an error's message can quote
  // what it failed on (V8's JSON errors do)
  const line = redact(text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim());
  if (!line) return null;
  return `page error: ${line}${logged === PAGE_ERRORS_PER_RUN - 1 ? ' (no more page errors are logged this run)' : ''}`;
}

// What the shell does with a new count (pure): the overlay dot on or off, the tray tooltip, and whether to flash the
// taskbar button (the count grew and the window is not focused).
export function attentionPlan({ count, text, previous = 0, focused = true, baseTooltip = 'SiberSentez' }) {
  return {
    overlay: count > 0,
    tooltip: count > 0 && text ? `${baseTooltip} · ${text}` : baseTooltip,
    flash: count > previous && !focused,
  };
}

// The taskbar dot: a size x size BGRA bitmap (nativeImage.createFromBitmap), a coral disc with a thin dark ring so it
// reads on light and dark taskbars; the edge is softened by coverage
export function attentionBadgeBitmap(size = 16) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const cover = Math.max(0, Math.min(1, r + 0.5 - d));
      if (!cover) continue;
      const ring = d > r - 1.5;
      const [R, G, B] = ring ? [0x5a, 0x1e, 0x14] : [0xff, 0x8f, 0x6b];
      const i = (y * size + x) * 4;
      buf[i] = B;
      buf[i + 1] = G;
      buf[i + 2] = R;
      buf[i + 3] = Math.round(cover * 255);
    }
  }
  return buf;
}

// A project id as the server makes them (registry ids, 'x-<folder slug>'); the same rule as server/actions.mjs
// One project id rule with the server (plan D9)
export { PROJECT_ID_RE };
// The longest idea text the bridge carries. The server keeps at most 300 characters after it cleaned the text
// (server/fit.mjs normalizeIdea, which reads no more than this many code units in the first place).
export const IDEA_TEXT_MAX = 1200;

// Whether a saveProjectIdea call may reach the server: the bridge's sender rule, a project id and a string of at most
// IDEA_TEXT_MAX characters ('' clears the idea). The text is cleaned by the server, not here.
// Returns { ok: true, projectId, text } or { ok: false, reason: <bridgeSender's> | 'invalid' }.
export function projectIdeaRequest({ projectId, text, mainWindow = false, frame = null, origin = null } = {}) {
  const sender = bridgeSender({ mainWindow, frame, origin });
  if (!sender.ok) return sender;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return { ok: false, reason: 'invalid' };
  if (typeof text !== 'string' || text.length > IDEA_TEXT_MAX) return { ok: false, reason: 'invalid' };
  return { ok: true, projectId, text };
}

// A new project from an idea (review U05, 2026-10-07): the person names it and writes the idea; the shell makes its
// folder under Documents\SiberSentez (the owner's choice), or under a folder the person picks ("Somewhere else…"),
// checks it as a picked folder is checked, has the server remember it, keeps the idea with it. The page gets the
// project id only, never a path.
export const IDEA_PROJECT_IPC_CHANNEL = 'sibersentez:create-idea-project';
export const PROJECT_NAME_MAX = 60;
export const IDEA_PROJECTS_DIR = 'SiberSentez';

// Where "Create" makes a new project's folder: <Documents>/SiberSentez. A Linux home without XDG user folders (WSL, a
// server, a minimal desktop) reports the home itself as Documents, and <home>/SiberSentez is the hub, which never
// holds a project: then <home>/Documents, the folder XDG would have made (tried on WSL, 2026-10-09).
export function ideaProjectsBase(documents, home) {
  const p = PLATFORM.path;
  const docs = documents && p.resolve(documents) !== p.resolve(home) ? documents : p.join(home, 'Documents');
  return p.join(docs, IDEA_PROJECTS_DIR);
}
const WIN_NAME_BAD_RE = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g;
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(\..*)?$/i;

// A project name as a Windows folder name: characters Windows refuses become spaces, spaces collapse, no trailing dot
// or space, at most PROJECT_NAME_MAX characters, never a reserved device name. '' when nothing is left.
export function projectFolderName(name) {
  let s = String(name || '').normalize('NFC').replace(WIN_NAME_BAD_RE, ' ').replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, PROJECT_NAME_MAX).join('').replace(/[. ]+$/, '').trim();
  return s && !WIN_RESERVED_RE.test(s) ? s : '';
}

// Checks the page's request: the bridge's sender rule, a name that makes a folder name, an idea of at most
// IDEA_TEXT_MAX characters, choose a boolean (true: pick where). Returns { ok, name, idea, choose } or { ok: false, reason }.
export function ideaProjectRequest({ name, idea = '', choose = false, mainWindow = false, frame = null, origin = null } = {}) {
  const sender = bridgeSender({ mainWindow, frame, origin });
  if (!sender.ok) return sender;
  if (typeof name !== 'string' || name.length > 200 || typeof idea !== 'string' || idea.length > IDEA_TEXT_MAX || typeof choose !== 'boolean') return { ok: false, reason: 'invalid' };
  const folderName = projectFolderName(name);
  if (!folderName) return { ok: false, reason: 'bad-name' };
  return { ok: true, name: folderName, idea, choose };
}

// A folder name not taken yet under base: "<name>", else "<name> (2)" ... "(99)"; null when all are taken
export function freeProjectFolder(base, name, exists) {
  for (let n = 1; n < 100; n++) {
    const p = PLATFORM.path.join(base, n === 1 ? name : `${name} (${n})`);
    if (!exists(p)) return p;
  }
  return null;
}

// "Somewhere else…": the folder the new project's folder goes into
export function ideaParentDialogOptions(S) {
  return { title: S.newProjectWhereTitle || S.newProjectPickTitle, buttonLabel: S.newProjectWhereButton || S.newProjectPickButton, properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] };
}

// The steps (pure but for the injected parts): where (base, or a picked folder), a free name, its path checked before
// anything is made, the folder made (the last step never recursive: a folder that appeared meanwhile is never taken
// over, the next name is tried), checked in full as a picked folder is, remembered by the server as a new project
// only (a folder inside a listed project is refused: its idea would land on that project), the idea kept with it.
// Refused after it was made: the empty folder is removed again, and the base folder too when this call made it and it
// is empty. Parts: showOpenDialog, exists(p), mkdir(p, recursive) (throws EEXIST when p is there and not recursive),
// removeEmpty(p) (only an empty folder), precheck(folder) (plannedFolderRefusal: a reason or null), check(folder)
// (checkProjectFolder), add(folder) ('project-add' with fresh), saveIdea(projectId, idea) ('project-idea').
// Returns the server's reply with created: true, or { ok: false, reason }.
export async function createIdeaProject({ S, base, name, idea = '', choose = false, showOpenDialog, exists, mkdir, removeEmpty, precheck = () => null, check, add, saveIdea }) {
  let root = base;
  if (choose) {
    let r;
    try {
      r = await showOpenDialog(ideaParentDialogOptions(S));
    } catch {
      return { ok: false, reason: 'error' };
    }
    root = r && !r.canceled && Array.isArray(r.filePaths) ? r.filePaths[0] : null;
    if (typeof root !== 'string' || !root) return { ok: false, reason: 'cancelled' };
  }
  if (typeof root !== 'string' || !localAbsolute(root)) return { ok: false, reason: 'not-local' };
  const rootMade = !exists(root);
  let folder = freeProjectFolder(root, name, exists);
  if (!folder) return { ok: false, reason: 'exists' };
  const early = precheck(folder);
  if (early) return { ok: false, reason: early };
  const removeIfEmpty = (p) => {
    try {
      removeEmpty(p);
    } catch {
      /* not empty or gone: left as it is */
    }
  };
  try {
    if (rootMade) mkdir(root, true);
  } catch {
    return { ok: false, reason: 'error' };
  }
  // Every name tried once at most: a name that says EEXIST while exists() says no (a broken link) is not tried again
  const tried = new Set();
  for (let made = false; !made; ) {
    tried.add(folder);
    try {
      mkdir(folder, false);
      made = true;
    } catch (e) {
      // Made by someone else between the look and the make: never taken over, the next free name is tried
      const next = e?.code === 'EEXIST' ? freeProjectFolder(root, name, (p) => tried.has(p) || exists(p)) : null;
      if (!next) {
        if (rootMade) removeIfEmpty(root);
        return { ok: false, reason: e?.code === 'EEXIST' ? 'exists' : 'error' };
      }
      folder = next;
    }
  }
  const undo = () => {
    removeIfEmpty(folder);
    if (rootMade) removeIfEmpty(root);
  };
  const c = check(folder);
  if (!c?.ok) {
    undo();
    return { ok: false, reason: c?.reason || 'invalid' };
  }
  let r = null;
  try {
    r = await add(c.path);
  } catch {
    r = null;
  }
  if (!r?.ok) {
    undo();
    return r && typeof r === 'object' ? r : { ok: false, reason: 'error' };
  }
  // The server answered with a project that was there already (an older server without fresh): the new folder lies
  // inside it. Its idea and its job must not land on that project (review of U05).
  if (r.existed === true) {
    undo();
    return { ok: false, reason: 'inside-project' };
  }
  if (idea) {
    try {
      await saveIdea(r.projectId, idea);
    } catch {
      /* the project is there; its idea can be written again in its drawer */
    }
  }
  return { ...r, created: true };
}

// The system folder picker. Windows' picker has "New folder" itself; createDirectory asks for the same on macOS.
export function projectFolderDialogOptions(S) {
  return { title: S.newProjectPickTitle, buttonLabel: S.newProjectPickButton, properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] };
}

// "Add to the library" from a folder (docs/skills-flow.md §5): the page asks for the system folder picker instead of a
// typed path. The answer carries the chosen folder's path: the page shows it in the folder field and sends it to the
// server's library-scan (which checks it again, as it checks a typed path). Nothing is read or copied here.
export const LIBRARY_PICK_IPC_CHANNEL = 'sibersentez:pick-library-folder';
export const LIBRARY_SOURCE_MAX = 260; // the server's limit for a scan source (bad-source past it)

export function libraryFolderDialogOptions(S) {
  return { title: S.libraryPickTitle, buttonLabel: S.libraryPickButton, properties: ['openDirectory', 'dontAddToRecent'] };
}

// What the page gets (pure): { ok: true, path } for a local absolute folder the server would take, else
// { ok: false, reason } ('cancelled', 'too-long', 'invalid', 'error')
export function libraryPickReply(r) {
  if (!r || r.canceled || !Array.isArray(r.filePaths) || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
  const p = r.filePaths[0];
  if (typeof p !== 'string' || !localAbsolute(p) || /[\u0000-\u001f]/.test(p)) return { ok: false, reason: 'invalid' };
  if (p.length > LIBRARY_SOURCE_MAX) return { ok: false, reason: 'too-long' };
  return { ok: true, path: p };
}

// The system folders a project may not be, from the environment (Windows names; values that are not an absolute local
// path are ignored):
//   trees  %SystemRoot% (C:\Windows): neither it nor anything inside it
//   roots  %ProgramFiles%, %ProgramFiles(x86)%, %ProgramData% and the OneDrive roots (%OneDrive%, %OneDriveConsumer%,
//          %OneDriveCommercial%): not the folder itself (a project folder inside OneDrive is fine)
// The server applies the same list with the same reason ('broad'). Returns { trees: [...], roots: [...] }.
// The same lists as the server's (server/catalog.mjs SYSTEM_TREE_VARS, ONEDRIVE_ROOT_VARS): the Windows and program
// folders are refused with everything inside them, a OneDrive root only itself (a project inside OneDrive is fine)
export const SYSTEM_TREE_VARS = Object.freeze(['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']);
export const SYSTEM_ROOT_VARS = Object.freeze(['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']);

export function systemFolderRules(env = {}) {
  // Windows environment names are case-insensitive: look each one up in any case
  const byName = new Map(Object.keys(env || {}).map((k) => [k.toUpperCase(), env[k]]));
  const read = (names) => {
    const out = [];
    for (const name of names) {
      const v = byName.get(name.toUpperCase());
      if (typeof v !== 'string' || !v.trim()) continue;
      const c = checkLocalDir(v);
      if (c.ok && !out.some((o) => samePath(o, c.path))) out.push(c.path);
    }
    return out;
  };
  return { trees: read(SYSTEM_TREE_VARS), roots: read(SYSTEM_ROOT_VARS) };
}

// Can the picked folder be a project, as the shell sees it (the server checks it again with the catalog's own rules:
// server/catalog.mjs checkNewProjectFolder). rules:
//   homeDir      the user's home folder: neither it nor any folder above it
//   broadDirs    Desktop, Documents, Downloads (as Electron names them, possibly moved to OneDrive) and the system roots
//                (systemFolderRules roots: the OneDrive roots): not themselves
//   systemTrees  %SystemRoot%, %ProgramFiles%, %ProgramFiles(x86)%, %ProgramData% (systemFolderRules trees): neither
//                they nor anything inside them ('broad')
//   hubPath      the hub: neither it, nor anything inside it, nor a folder that holds it
//   programDirs  the program's folders: none of them, nothing inside them, nothing that holds them
//   lstat, realpath  injectable for tests
// Every rule is checked on the path as written and on its real form (a junction on the way into the hub is caught).
// A folder that is itself a link (junction or symbolic link) is refused: the project would be somewhere else.
// Returns { ok: true, path } or { ok: false, reason: 'invalid' | 'network' | 'not-local' | 'drive-root' | 'home' |
// 'broad' | 'hub' | 'program' | 'missing' | 'not-folder' | 'link' }.
const givenDir = (d) => typeof d === 'string' && d.trim();
// The rules a folder's path breaks as written (nothing on disk is read): its reason, or null
function folderRuleOf({ homeDir = null, broadDirs = [], systemTrees = [], hubPath = null, programDirs = [] } = {}) {
  return (p) => {
    if (samePath(p, path.parse(p).root)) return 'drive-root';
    if (givenDir(homeDir) && (samePath(p, homeDir) || isInside(homeDir, p))) return 'home';
    if (broadDirs.some((b) => givenDir(b) && samePath(p, b))) return 'broad';
    if (systemTrees.some((t) => givenDir(t) && (samePath(p, t) || isInside(p, t)))) return 'broad';
    // Both ways: a project inside the hub, and a project folder that holds the hub
    if (givenDir(hubPath) && pathsOverlap(p, hubPath)) return 'hub';
    if (programDirs.some((d) => givenDir(d) && pathsOverlap(p, d))) return 'program';
    return null;
  };
}

// Why a folder that does not exist yet could not be a project, from its path alone (the rules of checkProjectFolder
// that read nothing on disk): the reason, or null. A new project's folder is checked with it before it is made
// (review U05), and again in full once it is there.
export function plannedFolderRefusal(raw, rules = {}) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) return 'invalid';
  const v = raw.trim();
  // \\server\share, \\wsl$\..., \\wsl.localhost\..., \\?\ and \\.\ device paths: never touched
  if (/^[\\/]{2}/.test(v)) return 'network';
  if (IS_WINDOWS ? !/^[a-zA-Z]:[\\/]/.test(v) : !path.isAbsolute(v)) return 'not-local';
  // A ':' after the drive letter (an alternate data stream), reserved characters, control characters
  if (/[<>:"|?*\u0000-\u001f\u007f-\u009f]/.test(IS_WINDOWS ? v.slice(2) : v)) return 'invalid';
  return folderRuleOf(rules)(path.resolve(v));
}

export function checkProjectFolder(raw, { homeDir = null, broadDirs = [], systemTrees = [], hubPath = null, programDirs = [], lstat = (p) => fs.lstatSync(p), realpath = fs.realpathSync.native } = {}) {
  const first = plannedFolderRefusal(raw, { homeDir, broadDirs, systemTrees, hubPath, programDirs });
  if (first) return { ok: false, reason: first };
  const written = path.resolve(raw.trim());
  const given = givenDir;
  const why = folderRuleOf({ homeDir, broadDirs, systemTrees, hubPath, programDirs });
  let st;
  try {
    st = lstat(written);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'link' };
  if (!st.isDirectory()) return { ok: false, reason: 'not-folder' };
  let real;
  try {
    real = realpath(written);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (/^[\\/]{2}/.test(real)) return { ok: false, reason: 'network' };
  const canonical = (p) => {
    try {
      return realpath(p);
    } catch {
      return p;
    }
  };
  // The real form of every rule's folder too (the hub or the program folder behind a junction)
  const second = why(real) || (() => {
    const realRules = {
      home: given(homeDir) ? canonical(homeDir) : null,
      hub: given(hubPath) ? canonical(hubPath) : null,
      broad: broadDirs.filter(given).map(canonical),
      trees: systemTrees.filter(given).map(canonical),
      program: programDirs.filter(given).map(canonical),
    };
    if (realRules.home && (samePath(real, realRules.home) || isInside(realRules.home, real))) return 'home';
    if (realRules.broad.some((b) => samePath(real, b))) return 'broad';
    if (realRules.trees.some((t) => samePath(real, t) || isInside(real, t))) return 'broad';
    if (realRules.hub && pathsOverlap(real, realRules.hub)) return 'hub';
    if (realRules.program.some((d) => pathsOverlap(real, d))) return 'program';
    return null;
  })();
  if (second) return { ok: false, reason: second };
  return { ok: true, path: written };
}

// The picker as one flow; main.mjs passes in the Electron parts:
//   showOpenDialog(options)  dialog.showOpenDialog with the main window as parent (modal to it)
//   check(folder)            checkProjectFolder with the shell's rules
//   add(folder)              the server call that remembers the folder ('project-add'); resolves its reply
// Nothing reaches the server unless a folder was chosen and passed the check. Returns the server's reply, or
// { ok: false, reason: 'cancelled' | <check's reason> | 'error' }.
export async function pickProjectFolder({ S, showOpenDialog, check, add }) {
  let r;
  try {
    r = await showOpenDialog(projectFolderDialogOptions(S));
  } catch {
    return { ok: false, reason: 'error' };
  }
  const folder = r && !r.canceled && Array.isArray(r.filePaths) ? r.filePaths[0] : null;
  if (typeof folder !== 'string' || !folder) return { ok: false, reason: 'cancelled' };
  const c = check(folder);
  if (!c?.ok) return { ok: false, reason: c?.reason || 'invalid' };
  try {
    return (await add(c.path)) || { ok: false, reason: 'error' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// What the page gets back from pickProjectFolder and saveProjectIdea: { ok, reason, projectId?, existed?, saved? }.
// Never a path, the idea or any other detail. An answer that says ok without a valid project id is an error.
export function projectReply(result) {
  const r = result && typeof result === 'object' ? result : {};
  const ok = r.ok === true && typeof r.projectId === 'string' && PROJECT_ID_RE.test(r.projectId);
  const reason = typeof r.reason === 'string' && /^[a-z-]{1,32}$/.test(r.reason) ? r.reason : null;
  const reply = { ok, reason: ok ? reason || 'saved' : r.ok === true ? 'error' : reason || 'error' };
  if (ok) {
    reply.projectId = r.projectId;
    if (typeof r.existed === 'boolean') reply.existed = r.existed;
    if (r.saved === false) reply.saved = false;
  }
  return reply;
}
