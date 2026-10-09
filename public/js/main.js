// Entry point: the live connection, tabs, top bar, right rail, indicator strip
import { store } from './store.js';
import { Stage } from './stage.js';
import { projectsInOrder } from './hq-live.js';
import { createWorkshop } from './views/workshop.js';
import { giveJob, fetchFitFor } from './views/job.js';
import { createProjectsView, createNewProjectFlow, projectBridge, qaProjectBridge } from './views/projects.js';
import { createIdeaDialog } from './views/newIdea.js';
import { checkUpdates, noticeDue, markTold, updatesState } from './updates.js';
import { createRosterView } from './views/roster.js';
import { createTimelineView } from './views/timeline.js';
import { createFeedView, renderMiniFeed, bindOpen } from './views/feed.js';
import { createSettingsView } from './views/settings.js';
import { createTodayRecent } from './views/today.js';
import { createChecklist, hasOwnProject, checklistModel } from './views/checklist.js';
import { createLearnPath } from './views/learnPath.js';
import { firstScreenParts } from './firstScreen.js';
import { createDrawer, resetFlows } from './views/drawer.js';
import { createNotifier } from './notify.js';
import { createPalette } from './palette.js';
import { esc, num, tok, modelName, projectColor, CAT, STATUS, agoTag, fillAgo, actionLine, replaceHtml, waitWhat } from './format.js';
import { icon } from './icons.js';
import { initActions, actionsReady, actionsState, onActionsChange, runAction } from './actions.js';
import { createContextMenu, focusKeyOf, suggestable, setDockOpener, runMenuItem, AI_STARTED_EVENT } from './contextmenu.js';
import { pointsChanged, rememberStartPoint } from './restore.js';
import { onHiddenChange } from './hiddenProjects.js';
import { createTerminalDock, qaTerminalBridge, escapeClosesDrawer } from './terminalDock.js';
import { tabResumeSession } from './dockState.js';
import { actionToast } from './toasts.js';
import { libraryState } from './rosterModel.js';
import { pickLanguage, setLanguage, t, indicatorMode, language } from './i18n.js';
import { createActionsSwitch, shellBridge, qaBridge, keepPlace, resumeRecord, readResume, RESUME_KEY } from './actionsSwitch.js';
import { stripHtml, setPeriod, setCostShown, costShown, onPrefs, stripOpen, setStripOpen, advancedShown } from './usage.js';
import { reconnectDelay } from './layout.js';
import { createWaitingMenu } from './views/waiting.js';
import { sessionState } from './attention.js';
import { createGuide, shouldAutoOpen, startStep, readSeen } from './guide.js';
import { createTour, TOUR_EXAMPLE_KEY } from './tour.js';
import { openToolsPanel, needTools, toolsState, installedTools, onToolsChange, loadTools, setSetupTyper, setWizardDone } from './views/tools.js';
import { setRunTyper, setRunOpener, setRunAsker } from './runHint.js';
import { startTheme } from './theme.js';
import { sessionTool, sessionToolName, canContinueTool } from './jobId.js';
import { diagnosticsText, collectDiagnostics } from './diagnostics.js';
import { hintHtml, initHints } from './hints.js';
import { installPageErrors } from './pageErrors.js';
import { whileVisible, everyVisible } from './whileVisible.js';

// First in this file, so an error anywhere below is caught too (review A4); the imports above run before it
const pageErrors = installPageErrors();
const $ = (s) => document.querySelector(s);

// The product was renamed (2026-09-30): this browser's settings under the old names are copied to the new ones once
// (the tab, the building size, the usage period, the dollars, the advanced views, the checklist, ...)
try {
  const OLD_PREFIX = 'orkestra.';
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(OLD_PREFIX)) continue;
    const next = 'sibersentez.' + k.slice(OLD_PREFIX.length);
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(k));
  }
} catch {
  /* storage may be blocked */
}

// If the content did not change, leave the DOM alone: rewriting on every patch breaks clicks, focus and selection
// If it changed, the focused card/row (e.g. a session card in the right rail) takes focus again after the redraw
function setHtml(el, html) {
  if (el._html !== html) {
    const act = document.activeElement;
    const key = act && el.contains(act) ? focusKeyOf(act) : null;
    const tag = act?.tagName?.toLowerCase();
    el._html = html;
    replaceHtml(el, html);
    if (key) el.querySelector(`${tag}[${key[0]}="${CSS.escape(key[1])}"]`)?.focus({ preventScroll: true });
  }
  fillAgo(el);
}

// QA hooks (for headless screenshots): ?qa=1 opens no live connection and loads one snapshot.
// ?tab=roster|timeline|feed opens the tab, ?replay=0.6 opens replay mode at that position, ?open=project:<id> opens the drawer.
const params = new URLSearchParams(location.search);
const QA = params.has('qa');
// Language of the new, localized strings (i18n.js): ?lang= from the desktop shell, else the browser's
setLanguage(pickLanguage({ setting: params.get('lang'), browser: navigator.language }));
// The look (theme-boot.js already set it before the first paint): kept, the shell told, the system followed
startTheme();

// The static texts of index.html: data-i18n = the text, data-i18n-html = trusted markup from the string table,
// data-i18n-attr = "attribute:key;attribute:key". The HTML holds the English text; this fills in the page language.
function applyStaticText() {
  document.documentElement.lang = language();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':');
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
}
applyStaticText();

// ---------- action notice (context menu and skill flow results) ----------
// The same stack and rules as the bell notices (toasts.js): one upper limit, one remove function
const actionToastHere = (o) => actionToast($('#toasts'), o);

// ---------- new project (docs/start-flow.md, step 2) ----------
// The desktop shell's bridge for a new project (window.sibersentezShell: the folder picker and the project's idea); null in
// a plain browser. QA only (?qa=1&newproject=pick|<reason>|browser): a stand-in that never reaches the shell; 'pick'
// answers with the first project that can take skills, 'browser' shows the page without a bridge.
const QA_NEW = QA ? params.get('newproject') : null;
const projectShell = QA_NEW === 'browser' ? null : QA_NEW ? qaProjectBridge(QA_NEW, () => [...store.projects.values()].find(suggestable)?.id || null) : projectBridge(window);

// ---------- drawer and scene ----------
// "Change actions" in the drawer takes the header indicator's path (the in-app switch, or where the mode is changed
// in a plain browser). Every fit the drawer loads also updates the project list badge (no second request for it).
// In the desktop app a project's idea is also kept with the project (keepIdea); in a browser only in the browser.
const drawer = createDrawer($('#drawer'), $('#scrim'), {
  toast: actionToastHere,
  openActionsChooser: () => $('#actMode')?.click(),
  // "Turn actions on and install" (docs/direction.md §3.2): through the switch's own bridge call; never in QA (QA never
  // turns actions on)
  turnActionsOn: !QA && shellBridge(window) ? () => actSwitch.turnOn() : null,
  onFit: (id, fit) => views.projects.noteFit(id, fit),
  keepIdea: projectShell ? (id, text) => projectShell.saveProjectIdea(id, text) : undefined,
});
// The last target opened from the page (kept across the reload after a mode change; see "where the user was" below)
let lastOpened = null;
const open = (t) => {
  if (!t || t.type === 'podium') return;
  lastOpened = t;
  drawer.open(t);
};

// The Building (the Workshop, docs/hq.md) is the main screen (docs/simplify.md): a project and, when there was one,
// the actor to show
const openWorkshop = (projectId, actorId = null) => {
  showTab('today');
  workshop.showProject(projectId, actorId);
};
// The orchestra scene: an advanced view on the Feed screen since the Building became the main screen
const SCENE = 'orchestra';
const sceneOpts = () => ({ onSelect: open, tooltip: $('#tooltip'), clockEl: $('#stageClock'), emptyEl: $('#stageEmpty'), replayBar: $('#replayBar') });
$('#stageWrap').classList.add('scene-' + SCENE);
let stage = new Stage($('#stage'), sceneOpts());

// ---------- actions and the context menu ----------
// /api/actions 404 → actions off: the menu has only client jobs (copy, details), the drawer as it is today
initActions();
// The mode or token changed (e.g. the server restarted from dry to live): old trials are void,
// "Install" must not open without a new trial; the open drawer is redrawn with the new mode
onActionsChange(() => {
  resetFlows();
  if (drawer.isOpen()) drawer.rerender();
  actSwitch.setMode(actionsState().mode);
});

// Actions mode indicator and its in-app switch (docs/actions-toggle.md §3b). The page reads the mode from /api/actions.
// In the SiberSentez window the indicator (mouse, Enter or Space: it is a button) opens the panel under itself, which
// changes the mode only through the shell's bridge (window.sibersentezShell, electron/preload.cjs). A plain browser has no
// bridge: the indicator explains where the mode is changed instead, and nothing on the page can change it.
// QA only (?qa=1&actpanel=choose|confirm|error|saved): a stand-in bridge that never reaches the shell, for screenshots.
const QA_PANEL = QA ? params.get('actpanel') : null;
const actSwitch = createActionsSwitch({
  button: $('#actMode'),
  panel: $('#actPanel'),
  bridge: QA_PANEL ? qaBridge(QA_PANEL === 'saved') : shellBridge(window),
  getMode: () => actionsState().mode,
  onUnavailable: () => actionToastHere({ tone: 'dry', title: t('actionsIndicator', { mode: indicatorMode(actionsState().mode) }), body: t('actionsHowTo') }),
});
actionsReady().then(() => actSwitch.setMode(actionsState().mode));
// The shell hands On from the tray or the window menu to this panel (electron/helpers.mjs PANEL_CONFIRM_LIVE_SCRIPT)
if (shellBridge(window)) window.sibersentezActionsPanel = Object.freeze({ confirmLive: () => actSwitch.confirmLive() });

// QA (only ?qa=1): simulate a mode change without touching the server; go back to the real mode
if (QA) {
  window.__sibersentezQa = {
    fakeMode: (mode) => initActions({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ mode, token: 'f'.repeat(64) }) }) }),
    realMode: () => initActions({ fetch: (...a) => globalThis.fetch(...a) }),
    // Redraw through the app's own drawing paths (like the patch refresh of the live panel)
    rerenderDrawer: () => drawer.rerender(),
    rerenderRail: () => {
      $('#nowList')._html = null;
      renderRail();
    },
    toast: (o) => actionToastHere(o),
    open: (t) => open(t),
    actions: actSwitch,
  };
}
const openSkills = (t) => open({ ...t, section: t.type === 'project' ? 'skills' : 'install' });
// An asking terminal tab of any tool is a row too: its row brings the tab forward (termDock is made further down; a
// click comes after)
const waitingMenu = createWaitingMenu({ chipEl: $('#waitChip'), menuEl: $('#waitMenu'), open, showTab: (tabId) => termDock.showTab(tabId) });
const menu = createContextMenu({ openDrawer: open, openSkills, toast: actionToastHere, getData: () => store, qa: QA });
// Terminals inside the window (docs/embedded-terminal.md): only in the SiberSentez window, whose preload has the bridge;
// then "Open terminal" opens here and Windows Terminal becomes the menu's second item
// QA only (?qa=1&dock=demo): a stand-in bridge that echoes what is typed, for screenshots; nothing reaches a shell
// (only where there is no real bridge, and only then does it open one by itself)
const qaDock = QA && ['demo', 'ask', 'err', 'shell'].includes(params.get('dock')) && !globalThis.sibersentezTerminal;
const QA_ASK = '\x1b[1mBash command\x1b[0m\r\n  npm install express\r\n  Install the web server package\r\n\r\nDo you want to proceed?\r\n\x1b[36m❯ 1. Yes\x1b[0m\r\n  2. Yes, and don\'t ask again for npm install commands in C:\\Projects\\demo\r\n  3. No, and tell Claude what to do differently (esc)\r\n';
// ?dock=err: a PowerShell that cannot run an npm tool's script (the known-error note)
const QA_ERR = "PS C:\\Projects\\demo> gemini\r\n\x1b[31mgemini : File D:\\Tools\\npm\\gemini.ps1 cannot be loaded because running scripts is disabled on this system.\x1b[0m\r\n\r\nPS C:\\Projects\\demo> ";
// ?dock=shell: a question typed into the plain shell as if it were the AI (the "not a command" note)
const QA_SHELL = "PS C:\\Projects\\demo> nasıl çalıştırılır\r\n\x1b[31mnasıl : The term 'nasıl' is not recognized as the name of a cmdlet, function, script file, or operable program.\x1b[0m\r\n\r\nPS C:\\Projects\\demo> ";
if (qaDock) globalThis.sibersentezTerminal = qaTerminalBridge({ ask: QA_ASK, err: QA_ERR, shell: QA_SHELL }[params.get('dock')] || '', { ai: params.get('dock') === 'ask' });
// A command run in the setup terminal ended: check the tools again (a tool just installed shows up)
// The Claude Code session of a project that acted in the last two minutes: the one an AI tab that just ended ran (none
// when the tab ran another tool, so nothing else is resumed by mistake)
// The Claude session a Claude tab goes on with once its tool ended: its own job's first (dockState.js), never another
// job's, never one whose job still runs in another tab
const recentSession = (projectId, jobId = null, tool = 'claude') => tabResumeSession(store.sessions.values(), { projectId, jobId, tool, busyJobs: new Set(termDock.running().map((x) => x.jobId).filter(Boolean)) });
// onFix: an error of the person's own program goes to the project's running AI tab as one sentence (typed, never sent);
// with no AI tab (or one whose screen asks something) the project's drawer opens with the sentence in its job box
const termDock = createTerminalDock({
  toast: actionToastHere,
  onSetupDone: () => loadTools({ refresh: true }),
  resumeFor: recentSession,
  onResume: (s) => resumeSession(s.id),
  onAsk: () => schedule(),
  onFix: (projectId, text) => {
    const r = termDock.askAi(projectId, text);
    if (r?.ok || r?.reason === 'asks' || !store.projects.get(projectId)) return;
    if (active !== 'projects') showTab('projects');
    drawer.openWithJob(projectId, text);
  },
});
if (qaDock) setTimeout(() => termDock.open({ projectId: store.sortedProjects()[0]?.id || 'demo' }), 800);
if (termDock.available) setDockOpener((target) => termDock.open(target), () => termDock.count() >= 8);
// What the last start's restore point holds, per project: the job box says it next to the job (restore.js)
// A start takes a point (and may push an old one out): the project's list is asked again
window.addEventListener(AI_STARTED_EVENT, (e) => {
  pointsChanged(e.detail?.projectId);
  rememberStartPoint(e.detail?.projectId, e.detail?.restorePoint, e.detail?.jobId);
});
// The building shows a tool that runs in SiberSentez's terminal as open there (hq-live.js liveSnapshot)
if (termDock.available) store.dockRunning = () => termDock.running();
// Every tool's question in the terminal waits for the person too (attention.js dockWaiting: the header, the Building)
if (termDock.available) store.dockAsking = () => termDock.asking();
// "How to run it" (runHint.js): a command goes into the project's terminal, never with Enter
if (termDock.available) setRunTyper((projectId, cmd) => termDock.typeInto(projectId, cmd));
// The way to run it is not known (review U09): the question into the project's running AI tab, never with Enter
if (termDock.available) setRunAsker((projectId, text) => termDock.askAi(projectId, text), (projectId) => termDock.running().some((x) => x.projectId === projectId));
// "Open in the browser" of a plain web page (docs/run-hint.md): the explorer action with the project's own index.html,
// on the person's click, under the actions mode like every action
setRunOpener((projectId) => runMenuItem({ id: 'open-page', label: t('runOpenPage'), action: 'explorer', payload: { projectId, open: 'index.html' } }, { toast: actionToastHere }));
// The tools panel's install commands and setup fixes: into a plain terminal of the home folder, never with Enter
if (termDock.available) setSetupTyper((cmd) => termDock.typeSetup(cmd));
// QA: ?qa=1&dock=demo&runtype=1 types a command into the first project's stand-in terminal (no Enter)
if (qaDock && params.get('runtype') === '1') setTimeout(() => termDock.typeInto(store.sortedProjects()[0]?.id || 'demo', 'npm run dev'), 1500);
let stageCanvas = $('#stage');
const MENU_TARGETS = '[data-session],[data-agent],[data-roster],[data-project]';

function menuTargetOf(el) {
  const n = el?.closest?.(MENU_TARGETS);
  if (!n || n.closest('.ctx-menu')) return null;
  const d = n.dataset;
  const target = d.session ? { type: 'session', id: d.session } : d.agent ? { type: 'agent', id: d.agent } : d.roster ? { type: 'roster', id: d.roster } : d.project ? { type: 'project', id: d.project } : null;
  return target ? { target, el: n } : null;
}

// When opened by keyboard (or when the position is outside the element) the menu anchors to the element's top left corner
function anchorPoint(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(20, r.width / 2), y: Math.min(r.bottom, r.top + 36) };
}
const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

// After a keyboard opening the browser may also send a contextmenu event for the same key: only that
// trigger's event arriving within a short time is swallowed (a mouse right click is not affected)
let keyMenuAt = 0;
let keyMenuEl = null;
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest?.('.ctx-menu')) return e.preventDefault();
  if (keyMenuEl && e.target === keyMenuEl && performance.now() - keyMenuAt < 600) return e.preventDefault();
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return; // the native menu (paste etc.)
  const sel = window.getSelection?.();
  if (sel && !sel.isCollapsed && sel.toString().trim() && sel.containsNode(e.target, true)) return; // selected text: the native "Copy"
  let hit = null;
  if (e.target === stageCanvas) {
    const h = stage.hitAt(e.clientX, e.clientY);
    if (h) hit = { target: h, el: null };
  } else hit = menuTargetOf(e.target);
  if (!hit) return;
  e.preventDefault();
  let x = e.clientX;
  let y = e.clientY;
  if (hit.el && ((x === 0 && y === 0) || !inside(hit.el.getBoundingClientRect(), x, y))) ({ x, y } = anchorPoint(hit.el));
  menu.openAt(x, y, hit.target, hit.el);
});
// Shift+F10 or the ContextMenu key: the menu for the focused card/row
document.addEventListener('keydown', (e) => {
  if (!((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') || palette.isOpen()) return;
  // The building's keyboard ring: the menu of what it is on, at that spot
  if (document.activeElement === stageCanvas && stage.focus) {
    const f = stage.focus.type === 'floor' ? { type: 'project', id: stage.focus.id } : stage.focus;
    const at = stage.clientPosOf(stage.focus.type, stage.focus.id);
    if (!at) return;
    e.preventDefault();
    keyMenuAt = performance.now();
    keyMenuEl = stageCanvas;
    menu.openAt(at.x, at.y, f, null);
    return;
  }
  const hit = menuTargetOf(document.activeElement);
  if (!hit) return;
  e.preventDefault();
  keyMenuAt = performance.now();
  keyMenuEl = hit.el;
  const p = anchorPoint(hit.el);
  menu.openAt(p.x, p.y, hit.target, hit.el);
});

// ---------- notices and the command palette ----------
$('#bellBtn').innerHTML = icon('bell');
$('#paletteBtn').innerHTML = `${icon('search')}<span>${esc(t('palInputAria'))}</span><kbd>Ctrl K</kbd>`;
// A narrow window shows the header's buttons as icons (review U15): their names stay for screen readers
$('#paletteBtn').setAttribute('aria-label', t('palInputAria'));
// A notice about a session or an agent opens the Building on its project with that actor's card (its plan or result
// is there, docs/simplify.md); anything else opens its drawer
const openFromNotice = (target) => {
  const rec = target?.type === 'session' ? store.sessions.get(target.id) : target?.type === 'agent' ? store.agents.get(target.id) : null;
  if (!rec?.projectId) return open(target);
  showTab('today');
  workshop.showProject(rec.projectId, `${target.type === 'session' ? 's' : 'a'}:${target.id}`);
};
const notifier = createNotifier({ stackEl: $('#toasts'), buttonEl: $('#bellBtn'), menuEl: $('#bellMenu'), onOpen: openFromNotice });
// First-run guide (docs/first-run.md); its step buttons run at click time, after everything below exists
// The full tour on an example (tour.js): the Building plays its example, the job box gets an example job typed into
// it; nothing is pressed or started, and everything goes back when the tour ends
let tourSaved = null; // the job box's own text while the tour types its example
let tourTimer = 0;
function tourBox(fill) {
  const input = $('#wsGiveText');
  if (!input) return;
  clearInterval(tourTimer);
  if (!fill) {
    if (tourSaved !== null) input.value = tourSaved;
    tourSaved = null;
    input.readOnly = false;
    return;
  }
  // The example is shown, not the person's own text: nothing typed meanwhile would be put back
  input.readOnly = true;
  const text = t(TOUR_EXAMPLE_KEY);
  if (tourSaved === null) tourSaved = input.value;
  if (input.value === text) return;
  // Typed on from where it is (the next step keeps typing), else from the start; two letters a tick
  let i = input.value && text.startsWith(input.value) && tourSaved !== input.value ? input.value.length : 0;
  input.value = text.slice(0, i);
  tourTimer = setInterval(() => {
    i = Math.min(text.length, i + 2);
    input.value = text.slice(0, i);
    if (i >= text.length) clearInterval(tourTimer);
  }, 30);
}
const tour = createTour({
  scene: (s) => {
    showTab('today');
    workshop.quietGuide();
    if (s.scene === 'example') {
      tourBox(false);
      workshop.example(s.at, { lead: !!s.lead });
    } else {
      workshop.live();
      tourBox(s.scene === 'type');
    }
  },
  end: () => {
    workshop.live();
    tourBox(false);
  },
});
// A move that acts on the page behind the drawer (a dialog over it, the page inert: review U02) closes it first
const leaveDrawer = (fn) => (...args) => {
  if (drawer.isOpen()) drawer.close();
  return fn(...args);
};
const guide = createGuide({
  go: {
    // The tour plays on the page behind; the tools panel as from the search (its beforeRun closes the drawer too)
    tour: leaveDrawer(() => tour.show()),
    tools: leaveDrawer(() => openToolsPanel()),
    newProject: leaveDrawer(() => newProject.start()),
    projects: leaveDrawer(() => showTab('projects')),
    roster: leaveDrawer(() => showTab('roster')),
    // The actions panel lives in the desktop app only
    actions: shellBridge(window) ? leaveDrawer(() => actSwitch.open()) : undefined,
  },
  getMode: () => actionsState().mode,
});
$('#guideBtn').addEventListener('click', () => guide.show());
onActionsChange(() => guide.refresh());
const palette = createPalette({
  open,
  beforeRun: () => drawer.isOpen() && drawer.close(),
  commands: [
    // The two main moves first (2026-10-02): give a job in the Building's box, start a new project
    { id: 'tour', label: t('tourPalette'), sub: t('tourPaletteSub'), hay: 'tour guide demo simulation how help tur rehber simulasyon nasil yardim tam kullanim', run: () => tour.show() },
    { id: 'give-job', label: t('wsPaletteGive'), sub: t('wsPaletteGiveSub'), hay: 'job give start task do iş ver işi başlat görev yap is ver isi baslat gorev yapay zeka zekâ', run: () => (showTab('today'), setTimeout(() => $('#wsGiveText')?.focus(), 50)) },
    { id: 'new-project', label: t('newProjectButton'), sub: t('wsPaletteNewSub'), hay: 'new project folder idea yeni proje klasör klasor fikir', run: () => newProject.start() },
    { id: 'guide', label: t('guidePalette'), sub: t('guidePaletteSub'), hay: 'guide help tour rehber yardim yardım ?', run: () => guide.show() },
    { id: 'words', label: t('guideWordsTitle'), sub: t('guideWordsPaletteSub'), hay: 'words glossary terms what is skill agent session sözlük sozluk terim nedir ne demek ajan oturum', run: () => guide.showWords() },
    { id: 'library-add', label: t('rfLibAdd'), sub: t('rfLibAddSub'), hay: 'library add import skill agent github folder kütüphane kutuphane ekle içe al ice al klasör klasor', run: () => (showTab('roster'), views.roster.openImport()) },
    { id: 'tools', label: t('aiPalette'), sub: t('aiPaletteSub'), hay: 'ai tools setup check install error kurulum kontrolü kontrol araç araçlar yapay zeka zekâ hata path git node', run: () => openToolsPanel() },
  ],
});
// AI tools and the setup check, always one click away (docs/ai-start.md)
$('#toolsBtn').innerHTML = `${icon('spark')}<span>${esc(t('navTools'))}</span>`;
$('#toolsBtn').addEventListener('click', () => openToolsPanel());
$('#guideBtn').innerHTML = `<span class="side-q" aria-hidden="true">?</span><span>${esc(t('navGuide'))}</span>`;
// The menu's icons (docs/shell.md)
for (const b of document.querySelectorAll('[data-nav-icon]')) b.insertAdjacentHTML('afterbegin', icon(b.dataset.navIcon));
$('#paletteBtn').addEventListener('click', () => palette.show());

// Color key: stays closed, opens on hover (so it does not cover parts of the scene)
$('#legend').innerHTML =
  `<span class="lg-title">${icon('spark')}${esc(t('shLegendTitle'))}</span><div class="lg-items">` +
  Object.entries(CAT)
    .filter(([k]) => k !== 'other')
    .map(([, v]) => `<span><i style="--c:${v.c}"></i>${esc(v.l)}</span>`)
    .join('') +
  `<span class="lg-sep"></span><span><i class="ring" style="--c:${STATUS.busy.c}"></i>${esc(t('shLegendBusy'))}</span><span><i class="ring" style="--c:${STATUS.idle.c}"></i>${esc(t('shLegendIdle'))}</span>` +
  `<span class="lg-sep"></span><span class="lg-note">${esc(t('shLegendNote'))}</span></div>`;

// ---------- scene mode: live / replay ----------
const modeBtns = document.querySelectorAll('.stage-controls [data-mode]');
const rangeSel = $('#replayRange');
const replayBar = $('#replayBar');
const playBtn = $('#replayPlay');
function setMode(mode) {
  if (SCENE === 'building' && mode === 'replay') return; // the building has no replay
  for (const b of modeBtns) b.classList.toggle('on', b.dataset.mode === mode);
  if (mode === 'replay') {
    stage.startReplay(Number(rangeSel.value));
    replayBar.hidden = false;
    playBtn.innerHTML = icon('pause');
  } else {
    stage.stopReplay();
    replayBar.hidden = true;
  }
  rangeSel.disabled = mode !== 'replay';
}
for (const b of modeBtns) b.addEventListener('click', () => setMode(b.dataset.mode));
rangeSel.addEventListener('change', () => stage.mode === 'replay' && setMode('replay'));
playBtn.addEventListener('click', () => {
  const r = stage.replay;
  if (r && r.elapsed >= r.duration) stage.seek(0);
  const paused = stage.togglePause();
  playBtn.innerHTML = icon(paused ? 'play' : 'pause');
});
$('#replayTrack').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  stage.seek((e.clientX - r.left) / r.width);
});
rangeSel.disabled = true;

// ---------- new project: the header button, the start card, the tray ----------
// The "New project" window (review U05): a name and an idea -> the shell makes the folder under Documents › SiberSentez
// (or where the person picks) -> the project's drawer opens with the idea in its job box; Start stays the person's.
// "Already have a project folder?" takes the old way: the shell's picker -> the drawer at the idea box. In a plain
// browser the button explains that this happens in the app.
const ideaDialog = createIdeaDialog();
const newProject = createNewProjectFlow({
  bridge: projectShell,
  ask: (prev) => ideaDialog.ask(prev),
  toast: actionToastHere,
  hasProject: (id) => store.projects.has(id),
  refresh: () => loadSnapshot(),
  nameOf: (id) => store.projects.get(id)?.name || id,
  openProject: (id, idea) => {
    if (active !== 'projects') showTab('projects');
    if (idea) drawer.openWithJob(id, idea);
    else open({ type: 'project', id, section: 'skills' });
  },
});
const newProjectBtn = $('#newProjectBtn');
newProjectBtn.innerHTML = `${icon('folder')}<span>${esc(t('newProjectButton'))}</span>`;
newProjectBtn.title = t('newProjectButtonTitle');
newProjectBtn.setAttribute('aria-label', t('newProjectButton'));
newProjectBtn.hidden = false;
newProjectBtn.addEventListener('click', () => newProject.start());
// The setup wizard's last step goes on to a project (roadmap F2): the same New project window
setWizardDone(() => newProject.start());
// "A new version is out" (roadmap F3a): only when the person turned it on in Settings (off by default: nothing leaves
// this computer); one notice per version, the link is in Settings. Never in QA (screenshots stay as asked).
if (!QA) {
  checkUpdates().then(() => {
    if (!noticeDue()) return;
    const a = updatesState().answer;
    actionToastHere({ tone: 'info', title: t('updNoticeTitle', { latest: a.latest }), body: t('updNoticeBody') });
    markTold();
  });
}
initHints();
// The tray's "New project…" (electron/helpers.mjs NEW_PROJECT_SCRIPT) starts the same flow; only with the real bridge
if (projectShell && !QA_NEW) window.sibersentezNewProject = Object.freeze({ start: () => (newProject.start(), true) });

// ---------- screens (docs/shell.md): the menu on the left, one screen at a time ----------
// The Workshop (docs/hq.md): it follows the store itself; the card's actions come back as hq-action events
// A job given under the building (docs/simplify.md): the same Start as the drawer's (views/job.js giveJob)
const giveJobTo = (projectId, text) => {
  const p = store.projects.get(projectId);
  if (!p) return null;
  // Nothing but AI tools' setup in the folder (a moved project's old folder): its drawer says so and opens the real one
  if (p.toolsOnly) {
    open({ type: 'project', id: p.id });
    actionToastHere({ tone: 'warn', title: t('jobToolsOnlyTitle'), body: t('jobToolsOnlyBody') });
    return null;
  }
  // No AI tool on this computer yet (or still being looked for): say so and open the tools panel; before, the box
  // did nothing
  if (!installedTools(toolsState()).length) {
    actionToastHere({ tone: 'warn', title: t('jobAsk'), body: t(toolsState().status === 'ready' ? 'jobNoTool' : 'aiLoading') });
    openToolsPanel();
    return null;
  }
  // Actions off: the project's drawer asks the one question (turn on and start) with the job already in its box
  if (actionsState().mode === 'off') {
    drawer.askStart(p.id, text);
    return null;
  }
  return giveJob(p, text, { mode: actionsState().mode, tools: toolsState(), fetchFit: fetchFitFor, runAction, runMenuItem, openDrawer: open, toast: actionToastHere });
};
const workshop = createWorkshop($('#workshopBody'), { store, toast: (title) => actionToastHere({ tone: 'ok', title }), label: (s) => store.sessionLabel(s), autoGuide: !QA || params.get('wsguide') === '1', giveJob: giveJobTo });
// A closed session goes on where it stopped, in the terminal below, with its own tool's resume (the session menu's own
// item; the actions mode decides as for every start). A session of a tool that cannot continue is said, not started.
const resumeSession = (sessionId) => {
  const s = store.sessions.get(sessionId);
  const tool = sessionTool(s);
  if (!canContinueTool(tool)) return actionToastHere({ tone: 'warn', title: t('termResume'), body: t('aiErr_resume-not-supported') });
  return runMenuItem({ id: 'resume', label: tool === 'claude' ? t('termResume') : t('termResumeTool', { tool: sessionToolName(s) }), action: 'start-ai', payload: { sessionId, tool, resume: true } }, { openDrawer: open, toast: actionToastHere });
};
window.addEventListener('hq-action', (e) => {
  const d = e.detail || {};
  if (d.action === 'open-session' && d.sessionId) open({ type: 'session', id: d.sessionId });
  else if (d.action === 'open-project' && d.projectId) open({ type: 'project', id: d.projectId });
  // The plan and the result (docs/simplify.md): the AI's own terminal tab comes forward so the person answers there;
  // a session outside SiberSentez's terminal opens its drawer and says where to answer
  else if (d.action === 'open-ai-terminal' && d.projectId) {
    if (!termDock.showProject(d.projectId)) {
      // Its terminal was closed, so the AI ended: it goes on where it stopped (what the person meant by the click)
      if (d.sessionId && sessionState(store.sessions.get(d.sessionId)) === 'closed') resumeSession(d.sessionId);
      else {
        if (d.sessionId) open({ type: 'session', id: d.sessionId });
        actionToastHere({ tone: 'warn', title: t('wsPlanTitle'), body: t('wsNoTerminal') });
      }
    }
  } else if (d.action === 'resume-session' && d.sessionId) resumeSession(d.sessionId); else if (d.action === 'open-changes' && d.projectId) open({ type: 'project', id: d.projectId, section: 'changes' });
  else if (d.action === 'open-restore' && d.projectId) open({ type: 'project', id: d.projectId, section: 'restore' });
  else if (d.action === 'open-run' && d.projectId) open({ type: 'project', id: d.projectId, section: 'run' });
  // The next step's buttons (nextStep.js): a new project for an idea; the tool's tab in SiberSentez's terminal
  else if (d.action === 'new-project') newProject.start();
  else if (d.action === 'show-terminal' && d.projectId) {
    if (!termDock.showProject(d.projectId)) actionToastHere({ tone: 'warn', title: t('wsNoToolTabTitle'), body: t('wsNoToolTab') });
  }
  else if (d.action === 'open-terminal' && d.sessionId) {
    // The session's menu (continue, fork, terminal), as the actions mode allows: nothing runs by itself
    const r = $('#workshopBody').getBoundingClientRect();
    menu.openAt(d.x ?? r.left + r.width / 2, d.y ?? r.top + 80, { type: 'session', id: d.sessionId }, null);
  }
});

const views = {
  // Today's parts (the scene, the rail, the numbers, the usage strip) draw themselves as data comes in
  today: { render: () => {} },
  workshop: { render: () => {} },
  projects: createProjectsView($('#projectsBody'), open, { onNewProject: () => newProject.start() }),
  roster: createRosterView($('#rosterBody'), open),
  timeline: createTimelineView($('#timelineBody'), open),
  feed: createFeedView($('#feedBody'), open),
  settings: createSettingsView($('#settingsBody'), {
    openTools: () => openToolsPanel(),
    openGuide: () => guide.show(),
    openActions: shellBridge(window) ? () => actSwitch.open() : null,
    openLogs:
      typeof window.sibersentezShell?.openLogs === 'function'
        ? async () => {
            const r = await window.sibersentezShell.openLogs().catch(() => null);
            if (!r?.ok) actionToastHere({ tone: 'err', title: t('setLogsFailed') });
          }
        : null,
    copyDiagnostics: async () => {
      const text = diagnosticsText({ ...(await collectDiagnostics({ loadTools, toolsState })), mode: actionsState().mode, lang: language(), desktop: !!shellBridge(window), pageErrors: pageErrors.count() });
      try {
        await navigator.clipboard.writeText(text);
        actionToastHere({ tone: 'ok', title: t('setDiagCopied'), code: text });
      } catch {
        actionToastHere({ tone: 'err', title: t('shCmCopyFailed'), body: t('setDiagCopyFailed') });
      }
    },
  }),
};
const todayRecent = createTodayRecent($('#todayRecent'), { open, showProjects: () => showTab('projects') });
// Today's "First 10 minutes" checklist (views/checklist.js): ticks itself, each step one button away
const checklist = createChecklist($('#todayChecklist'), {
  tools: () => openToolsPanel(),
  actions: shellBridge(window) ? () => actSwitch.open() : null,
  newProject: () => newProject.start(),
  // The job box at the top of the Building, for that project (the one Start: docs/simplify.md)
  startAi: (id) => {
    openWorkshop(id);
    setTimeout(() => $('#wsGiveText')?.focus(), 50);
  },
  needTools: () => needTools(),
  toolsState: () => toolsState(),
  mode: () => actionsState().mode,
  guide: () => guide.show(),
  tour: () => tour.show(),
  // "Watch the example": the Building's own example plays (the card is on the Building already); nothing runs
  demo: () => workshop.playExample(),
});
// "Learn by doing" (plan C5, views/learnPath.js): after the first ten minutes, five small jobs on the shown project
const learnPath = createLearnPath($('#todayLearn'), {
  ready: () => store.loaded && hasOwnProject([...store.projects.values()]) && checklistModel({ tools: toolsState(), mode: actionsState().mode, projects: [...store.projects.values()], sessions: [...store.sessions.values()], askOnStart: !!shellBridge(window) }).done,
  write: (text) => {
    const box = $('#wsGiveText');
    if (!box) return;
    // A job of their own is in the box: it stays; they decide (review B/C)
    if (box.value.trim() && box.value.trim() !== text) {
      box.focus();
      return actionToastHere({ tone: 'info', title: t('lpTitle'), body: t('lpBoxBusy') });
    }
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
    box.scrollIntoView?.({ block: 'center' });
  },
  restore: () => {
    const id = $('[data-ws="project"]')?.value || store.sortedProjects().find((x) => hasOwnProject([x]))?.id;
    if (id) open({ type: 'project', id, section: 'restore' });
  },
  afterHide: () => $('#wsGiveText')?.focus(),
});
// Advanced views (docs/direction.md §3.3, Settings): off by default. Off hides every .adv-only element (the Feed's
// numbers, its timeline switch and the orchestra scene, the drawer's tiles, the most used charts); nothing is deleted.
function applyAdvanced() {
  const on = advancedShown();
  document.body.classList.toggle('adv', on);
  if (on) return;
  if (active === 'timeline') showTab('feed');
}
onPrefs(applyAdvanced);
// Only while Today shows (renderChrome draws it when Today opens)
const todayShown = () => !$('#tab-today').hidden;
onToolsChange(() => todayShown() && checklist.render());
onToolsChange(() => todayShown() && learnPath.render());
onActionsChange(() => todayShown() && checklist.render());
// Every screen; the menu's keys 1-5 name NAV_KEYS (Timeline shares the Feed item: a switch on that screen). 'today' is
// the Building (the Workshop, docs/simplify.md)
const TAB_KEYS = ['today', 'projects', 'roster', 'feed', 'timeline', 'settings'];
const NAV_KEYS = ['today', 'projects', 'roster', 'feed', 'settings'];
let active = 'today';
try {
  const saved = localStorage.getItem('sibersentez.tab');
  if (TAB_KEYS.includes(saved)) active = saved;
} catch {
  /* storage may be blocked */
}
function showTab(key) {
  active = key;
  for (const b of document.querySelectorAll('[data-tab]')) {
    const on = b.dataset.tab === key || b.dataset.tabAlso === key;
    b.classList.toggle('on', on);
    // The menu moves between screens (navigation, review U03): its buttons say which screen is shown (aria-current);
    // the Feed/Timeline switch inside a screen stays a pressed toggle
    if (b.closest('.side-nav, .side-foot')) {
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    } else b.setAttribute('aria-pressed', on);
  }
  for (const k of TAB_KEYS) $(`#tab-${k}`).hidden = k !== key;
  try {
    localStorage.setItem('sibersentez.tab', key);
  } catch {
    /* ignore */
  }
  if (store.loaded) {
    renderChrome();
    views[key].render();
    lastRender[key] = Date.now();
  }
  if (key === 'today') workshop.shown();
}
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------- where the user was, across the reload after a mode change ----------
// A mode change restarts the panel server and the shell reloads the window (docs/actions-toggle.md §3b): the tab and
// the open drawer are kept in this window's sessionStorage when the page goes away after a restart, and put back once
// after the next load (the drawer once the first snapshot is in).
let serverLost = false; // the live connection dropped while this page was open (a restart, a crash)
let resume = { tab: null, drawer: null };
try {
  resume = readResume(sessionStorage.getItem(RESUME_KEY), TAB_KEYS);
  sessionStorage.removeItem(RESUME_KEY);
} catch {
  /* storage may be blocked */
}
if (resume.tab) active = resume.tab;
window.addEventListener('pagehide', () => {
  if (!keepPlace({ switching: actSwitch.pendingReload(), serverLost })) return;
  const rec = resumeRecord({ tab: active, drawer: drawer.isOpen() ? lastOpened : null }, TAB_KEYS);
  try {
    if (rec) sessionStorage.setItem(RESUME_KEY, rec);
  } catch {
    /* ignore */
  }
});

// ---------- draw timing ----------
const MIN_GAP = { projects: 1500, roster: 8000, timeline: 5000, feed: 1000 };
const lastRender = { projects: 0, roster: 0, timeline: 0, feed: 0 };
let pending = false;
// A hidden window draws nothing; one full draw as soon as it shows again (plan D5). The notifications and the window
// title do not wait (notify.js)
const drawWhenShown = whileVisible(() => schedule(true));
function schedule(force = false) {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    if (document.hidden) return drawWhenShown();
    renderChrome();
    const now = Date.now();
    // A screen without a gap (Today, Settings: drawn by renderChrome) has nothing to wait for; before, its undefined
    // gap made the comparison false and the retry delay NaN, so the draw re-armed itself about four times a second
    const gap = MIN_GAP[active];
    if (force || !gap || now - lastRender[active] >= gap) {
      views[active].render();
      lastRender[active] = now;
    } else {
      setTimeout(() => schedule(), gap - (now - lastRender[active]) + 20);
    }
    if (drawer.isOpen()) drawer.refresh();
  }, 250);
}

// The header always; a screen's own parts only while that screen shows (showTab draws them when it opens). A list
// redrawn inside a hidden screen kept its removed rows alive: their CSS animations (the rows' entry, the busy dots'
// endless ping) are not cancelled without a style pass, so the document timeline held every old row (soak test:
// tens of thousands of detached nodes in a few minutes)
function renderChrome() {
  renderHeader();
  if (active === 'today') {
    todayRecent.render();
    checklist.render();
    learnPath.render();
  }
  // The orchestra scene's rail sits on the Feed screen with it
  if (active === 'feed') {
    renderRail();
    renderKpis();
  }
  if (active === 'settings') renderHubFoot();
}

// Footer: where the hub folder is (registry and library are read from it)
function renderHubFoot() {
  const st = libraryState(store.hub);
  setHtml(
    $('#hubFoot'),
    st.state === 'unknown' ? '' : st.state === 'none' ? t('shHubNone') : t('shHubInfo', { path: `<code translate="no">${esc(st.path)}</code>`, projects: num(st.projects), library: num(st.library) }),
  );
}

function renderHeader() {
  waitingMenu.render();
  // No project of the person's own yet, or none the Building shows: the start card or the strip holds the one primary
  // New project; this one is a quiet shortcut (firstScreen.js)
  newProjectBtn.classList.toggle('quiet', firstScreenParts({ loaded: store.loaded, ownProject: hasOwnProject([...store.projects.values()]), buildingProject: projectsInOrder(store).length > 0 }).headerQuiet);
  const k = store.kpi || {};
  // Nothing open: no "0 open sessions" chip (docs/direction.md §3.3, fewer header items)
  setHtml($('#statusChips'), `
    <span class="chip ${k.busy ? 'hot' : ''}${k.live || k.busy ? '' : ' none'}"><i class="sdot s-${k.busy ? 'busy' : k.live ? 'idle' : 'closed'}"></i>${t('shChipSessions', { live: `<b>${num(k.live)}</b>`, busy: `<b>${num(k.busy)}</b>` })}</span>
    ${k.runningAgents ? `<span class="chip hot-a">${icon('agent')}${t('shChipAgents', { n: `<b>${num(k.runningAgents)}</b>` })}</span>` : ''}
    ${k.runningWorkflows ? `<span class="chip hot-w">${icon('workflow')}${t('shChipWorkflows', { n: `<b>${num(k.runningWorkflows)}</b>` })}</span>` : ''}`);
}

function renderRail() {
  const live = store.liveSessions();
  setHtml(
    $('#nowList'),
    live.length
    ? live
        .map((s) => {
          const p = store.projects.get(s.projectId);
          const st = sessionState(s);
          return `<button class="now-card st-${st}" data-session="${esc(s.id)}" style="--c:${projectColor(s.projectId)}">
            <span class="nc-top"><span class="nc-proj"><i></i>${esc(p?.name || t('shUnknown'))}</span><span class="pstate s-${st}"${st === 'left' ? ` title="${esc(t('attnLeftTip'))}"` : ''}><i></i>${esc(t('attnState_' + st))}</span></span>
            <span class="nc-title">${esc(store.sessionLabel(s))}</span>
            ${st === 'waiting' && waitWhat(s) ? `<span class="nc-asks">${esc(t('attnAsks', { what: waitWhat(s) }))}</span>` : ''}
            ${st === 'busy' && s.lastAction ? `<span class="nc-act">${icon('action')}${actionLine(s.lastAction)} · ${agoTag(s.lastAction.t, 'span')}</span>` : ''}
            <span class="nc-meta">${modelName(s.model)} · ${t('shCtx', { n: tok(s.contextTokens) })} · ${t('shToolsN', { n: num(s.toolCalls) })}${s.runningAgents ? ` · <b>${t('shAgentsN', { n: s.runningAgents })}</b>` : ''} · ${agoTag(s.live.since || s.lastAt, 'span')}</span>
          </button>`;
        })
        .join('')
    : `<p class="muted small">${t('shNoLive', { cmd: '<code>claude</code>' })}</p>`,
  );
  renderMiniFeed($('#miniFeed'));
}

function sparkPath(series, w, h) {
  const max = Math.max(1, ...series);
  const step = w / Math.max(1, series.length - 1);
  const pts = series.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="kspark" aria-hidden="true"><path d="M0,${h} L${pts.join(' L')} L${w},${h} Z" class="area"/><path d="M${pts.join(' L')}" class="line"/></svg>`;
}

function renderKpis() {
  const k = store.kpi;
  if (!k) return;
  const d = k.day;
  // Tools and messages always stand; the rest only once they happened in the last 24 hours, so a new user does not
  // meet a row of zeros for words they do not know yet
  const opt = (n, html) => (n ? html : '');
  setHtml($('#kpis'), `
    <div class="kpi wide"><span class="kl">${icon('pulse')} ${esc(t('shKpiTools'))}${hintHtml(t('shHintTools'))}</span><b>${num(d.tools)}</b>${sparkPath(k.hourly.slice(-24), 160, 34)}</div>
    <div class="kpi"><span class="kl">${icon('prompt')} ${esc(t('shKpiPrompts'))}${hintHtml(t('shHintPrompts'))}</span><b>${num(d.prompts)}</b></div>
    ${opt(d.agentsStarted || d.agentsDone, `<div class="kpi"><span class="kl">${icon('agent')} ${esc(t('shKpiAgents'))}${hintHtml(t('shHintAgents'))}</span><b>${num(d.agentsStarted)} <small>/ ${num(d.agentsDone)}</small></b></div>`)}
    ${opt(d.skills, `<div class="kpi"><span class="kl">${icon('skill')} ${esc(t('shKpiSkills'))}${hintHtml(t('shHintSkills'))}</span><b>${num(d.skills)}</b></div>`)}
    ${opt(d.workflows, `<div class="kpi"><span class="kl">${icon('workflow')} ${esc(t('shKpiWorkflows'))}${hintHtml(t('shHintWorkflows'))}</span><b>${num(d.workflows)}</b></div>`)}
    ${opt(d.commits, `<div class="kpi"><span class="kl">${icon('commit')} ${esc(t('shKpiCommits'))}${hintHtml(t('shHintCommits'))}</span><b>${num(d.commits)}</b></div>`)}`);
  renderUsageStrip();
}

// ---------- usage: input, output and API-equivalent cost (docs/usage.md §6) ----------
// The period (24 hours, 7 days, this month, 30 days) and whether dollars are shown are kept in this browser
// (usage.js); a change redraws the strip, the project cards and an open drawer.
function renderUsageStrip() {
  const el = $('#usageStrip');
  const html = stripHtml(store.kpi?.usage || null);
  el.hidden = !html;
  if (el._html === html) return;
  // The focused period button or dollar switch keeps the focus across the redraw
  const act = document.activeElement;
  const fk = act && el.contains(act) ? act.dataset?.fk : null;
  el._html = html;
  replaceHtml(el, html);
  if (fk) el.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
}
$('#usageStrip').addEventListener('click', (e) => {
  const p = e.target.closest('[data-usage-period]');
  if (p) return setPeriod(p.dataset.usagePeriod);
  if (e.target.closest('[data-usage-cost]')) return setCostShown(!costShown());
  if (e.target.closest('[data-usage-setup]')) return openToolsPanel();
  if (e.target.closest('[data-usage-open]') && setStripOpen(!stripOpen())) renderUsageStrip();
});
// A project hidden or shown again (hiddenProjects.js): the lists, the Building's picker and an open drawer follow
onHiddenChange(() => {
  if (!store.loaded) return;
  views.projects.render();
  lastRender.projects = Date.now();
  todayRecent.render();
  checklist.render();
  if (drawer.isOpen()) drawer.rerender();
});
onPrefs(() => {
  renderUsageStrip();
  if (store.loaded && active === 'projects') {
    views.projects.render();
    lastRender.projects = Date.now();
  }
  if (drawer.isOpen()) drawer.rerender();
});

$('#nowList').addEventListener('click', (e) => bindOpen(e, open));
$('#miniFeed').addEventListener('click', (e) => bindOpen(e, open));

// ---------- clock and connection indicator ----------
function tickClock() {
  $('#clock').textContent = new Date().toLocaleTimeString(language() === 'tr' ? 'tr-TR' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
everyVisible(tickClock, 1000);
tickClock();
// Relative times ("12 s ago") are updated in place without rewriting the DOM
everyVisible(() => fillAgo(document), 5000);

function renderConn() {
  const c = $('#conn');
  c.className = 'conn ' + (store.connected ? 'on' : 'off');
  c.innerHTML = `<i></i><span>${esc(store.connected ? t('shConnOn') : t('shConnOff'))}</span>`;
  c.title = store.connected ? t('shConnOn') : t('shConnOff');
  const scan = store.scan;
  const sEl = $('#scan');
  if (scan && scan.state === 'loading') {
    sEl.hidden = false;
    const pct = scan.total ? Math.round((scan.done / scan.total) * 100) : 0;
    sEl.innerHTML = `<span>${esc(t('shScanning'))}</span><span class="bar"><i style="width:${pct}%"></i></span><b>%${pct}</b>`;
  } else {
    sEl.hidden = true;
  }
}

// ---------- live connection ----------
let buffer = null;
// One snapshot request at a time; after a failure the next one waits 2, 4 ... 30 s (every patch of a restarted server
// asks for one, twice a second)
let snapshotRun = null;
let snapshotFails = 0;
let snapshotRetryAt = 0;
function loadSnapshot() {
  if (snapshotRun) return snapshotRun;
  if (Date.now() < snapshotRetryAt) return Promise.resolve();
  snapshotRun = loadSnapshotNow().finally(() => (snapshotRun = null));
  return snapshotRun;
}
async function loadSnapshotNow() {
  buffer = [];
  try {
    const res = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const snap = await res.json();
    const first = !store.loaded;
    const prevBoot = store.bootId;
    store.load(snap);
    // The server restarted: the actions mode and token may have been renewed too
    if (!first && prevBoot !== snap.bootId) initActions();
    for (const p of buffer) if (p.bootId === snap.bootId && p.t > snap.generatedAt) store.applyPatch(p);
    if (first) stage.warmStart();
    // The drawer that was open before the reload after a mode change (not in QA: screenshots stay as asked)
    if (first && resume.drawer && !QA) open(resume.drawer);
    snapshotFails = 0;
    snapshotRetryAt = 0;
  } catch (e) {
    console.error(t('shSnapshotFailed'), e);
    snapshotFails++;
    snapshotRetryAt = Date.now() + Math.min(30000, 1000 * 2 ** snapshotFails);
  } finally {
    buffer = null;
  }
  renderConn();
  schedule(true);
  if (QA) applyQaParams();
}

let qaApplied = false;
function applyQaParams() {
  if (qaApplied) return;
  qaApplied = true;
  if (params.has('replay')) {
    setMode('replay');
    stage.seek(Number(params.get('replay')) || 0);
  }
  // Usage (docs/usage.md §6): ?usage=24h|7d|month|30d the period, ?cost=0 dollars hidden, ?sort=spend the Projects sort
  if (params.has('usage')) setPeriod(params.get('usage'));
  if (params.get('cost') === '0') setCostShown(false);
  if (params.get('sort') === 'spend') views.projects.sortBy('spend');
  const o = /^(project|session|agent|roster):(.+)$/.exec(params.get('open') || '');
  // ?skills=1: scroll to the skills section in the drawer ("Install into a project" on a roster item); the section depends on the actions mode
  if (o && params.has('skills')) actionsReady().then(() => qaSkills(o[1], o[2]));
  else if (o) open({ type: o[1], id: o[2] });
  if (params.has('palette')) palette.show(params.get('palette'));
  // ?floor=<project id>: the building inside that floor; ?floor=1 the first floor (docs/cutaway.md §2)
  if (params.has('floor') && stage.zoomTo) stage.zoomTo(params.get('floor') === '1' ? projectsInOrder(store)[0]?.p.id : params.get('floor'));
  // ?wsdemo=<ms>: the Workshop's example at that moment; ?wsproject=<id>: the Workshop on that project
  if (params.has('wsproject')) workshop.showProject(params.get('wsproject'));
  if (params.has('wsdemo')) workshop.simulate({ demoAt: Number(params.get('wsdemo')) || 0 });
  else if (active === 'today') workshop.simulate();
  // ?actpanel=choose|confirm|error|saved: the in-app actions switch at that step (stand-in bridge, nothing changes)
  if (QA_PANEL) actionsReady().then(() => qaActionsPanel(QA_PANEL));
  // ?newproject=pick|<reason>|browser: the new-project flow once, through the stand-in (nothing reaches the shell)
  if (QA_NEW) actionsReady().then(() => setTimeout(() => newProject.start(), 300));
  if (params.has('toast')) notifier.handle([{ kind: 'live', projectId: [...store.projects.keys()][1], sessionId: store.liveSessions()[0]?.id, meta: { status: 'idle', prev: 'busy' } }]);
  // Headless Chrome produces no frames in virtual time: advance the scene synchronously for a few seconds
  stage.simulate(1.6); // let the sections settle into place first
  if (stage.mode === 'live') store.ticks.slice(-30).forEach((t) => stage.spawnNote(t));
  stage.simulate(stage.mode === 'replay' ? 2.5 : 0.9);
  // Headless Chrome re-lays out the page at capture time; when the scene size changes, one frame
  // is drawn and the transition is left half done. In QA, settle the scene again after every size change.
  new ResizeObserver(() => stage.simulate(1.2)).observe($('#stageWrap'));
  // ?menu=project:<id> (session:, agent:, roster:): show the menu open, anchored to the node or card
  // The cards and the right rail are in the DOM after the first draw (250 ms): open the menu after that
  const m = /^(project|session|agent|roster):(.+)$/.exec(params.get('menu') || '');
  if (m) actionsReady().then(() => setTimeout(() => qaMenu(m[1], m[2]), 400));
  document.body.dataset.ready = '1';
}

// QA: the in-app switch at one step, through the page's own click path; the stand-in bridge never reaches the shell
function qaActionsPanel(step) {
  if (step === 'confirm') return actSwitch.confirmLive();
  actSwitch.open();
  const other = actionsState().mode === 'dry' ? 'off' : 'dry';
  if (step === 'error' || step === 'saved') document.querySelector(`#actPanel [data-asw-mode="${other}"]`)?.click();
}

// QA: ?pick=<item id> and ?flow=preview|confirm work only in preview (dry) mode: a real process is never started
const qaDry = () => actionsState().mode === 'dry';

function qaMenu(type, id) {
  if (type === 'roster' && active !== 'roster') {
    showTab('roster');
    views.roster.render();
  }
  let el = null;
  let pos = null;
  if (type === 'project' || type === 'agent') {
    const c = stage.clientPosOf(type, id);
    if (c) pos = { x: c.x + c.r * 0.7, y: c.y + c.r * 0.7 };
  }
  if (!pos) {
    el = document.querySelector(`[data-${type}="${CSS.escape(id)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      pos = anchorPoint(el);
    }
  }
  menu.openAt(pos ? pos.x : innerWidth / 2, pos ? pos.y : innerHeight / 3, { type, id }, el);
  const pick = params.get('pick');
  if (pick && qaDry()) setTimeout(() => menu.activateById(pick), 200);
}

async function qaSkills(type, id) {
  open({ type, id, section: type === 'roster' ? 'install' : 'skills' });
  const flow = params.get('flow');
  if (!flow || !qaDry()) return;
  const click = (act) => document.querySelector(`#drawer [data-flow-act="${act}"]`)?.click();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // The project section loads its suggestions first (GET /api/projects/<id>/suggestions)
  await wait(700);
  // ?proj=<id>: the target project of a roster item's install section
  const proj = params.get('proj');
  const pick = proj && document.querySelector('#drawer [data-flow-proj]');
  if (pick && [...pick.options].some((o) => o.value === proj)) {
    pick.value = proj;
    pick.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(100);
  }
  if (flow === 'try') {
    click('try');
    return;
  }
  click('preview');
  await wait(600);
  if (flow === 'confirm' || flow === 'install') {
    click('install');
    await wait(200);
    if (flow === 'install') {
      click('confirm');
      await wait(600);
    }
  }
}

// Attempts in a row to open the live stream again (reset by its hello)
let streamRetries = 0;
function connect() {
  const es = new EventSource('/api/stream');
  let greeted = false;
  es.addEventListener('hello', (e) => {
    streamRetries = 0;
    store.lost = false;
    store.setStatus(true);
    const d = JSON.parse(e.data);
    store.setScan(d.scan);
    renderConn();
    schedule();
    if (d.scan?.state === 'ready') loadSnapshot();
    // A reconnect may have missed an `actions` event (docs/actions-toggle.md §3.5): ask for the mode again
    if (greeted) initActions();
    greeted = true;
  });
  es.addEventListener('scan', (e) => {
    store.setScan(JSON.parse(e.data));
    renderConn();
  });
  es.addEventListener('ready', () => loadSnapshot());
  // The actions mode changed without a restart (docs/actions-toggle.md §3.5): ask for the new mode and token
  es.addEventListener('actions', () => initActions());
  es.addEventListener('patch', (e) => {
    const p = JSON.parse(e.data);
    if (buffer) return buffer.push(p);
    if (!store.loaded) return;
    // The server restarted: the sequence numbers were reset, take a new snapshot first
    if (p.bootId !== store.bootId) return loadSnapshot();
    const fresh = store.applyPatch(p);
    stage.onTicks(fresh.ticks);
    stage.onEvents(fresh.events);
    notifier.handle(fresh.events);
    schedule();
  });
  es.addEventListener('roster', (e) => {
    if (!store.loaded) return;
    store.setRoster(JSON.parse(e.data));
    schedule();
  });
  es.onerror = () => {
    serverLost = true;
    store.lost = true;
    store.setStatus(false);
    renderConn();
    // The job cards say the connection is lost (review B8) instead of showing the last state as live
    schedule();
    // A non-200 answer closes an EventSource for good: in a plain browser the page stayed frozen (the desktop app
    // reloads its page). Open a new one after a growing pause (docs/backlog.md "Long-running load")
    if (es.readyState === 2) {
      es.close();
      setTimeout(connect, reconnectDelay(streamRetries++));
    }
  };
}

// ---------- keyboard ----------
// The menu: the up and down arrows move between its screen buttons (each one stays in the Tab order too)
const NAV_BUTTONS = '.side-nav [data-tab], .side-foot [data-tab]';
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const at = document.activeElement;
  if (!at?.matches?.(NAV_BUTTONS)) return;
  const list = [...document.querySelectorAll(NAV_BUTTONS)].filter((b) => b.getClientRects().length > 0);
  const i = list.indexOf(at);
  if (i < 0) return;
  e.preventDefault();
  list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus();
});
// Esc in SiberSentez's terminal while the project drawer is open closes the drawer first and never reaches the AI tool
// (seen when using the app, 2026-10-08: the terminal keeps its keys, so the Esc meant for the drawer cancelled Claude
// Code's "trust this folder?" and the tool quit). The next Esc goes to the tool as always.
document.addEventListener('keydown', (e) => escapeClosesDrawer(e, drawer), true);
document.addEventListener('keydown', (e) => {
  if (palette.isOpen() || guide.isOpen()) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  // Esc: if an install confirmation is open in the drawer, only it is cancelled; otherwise the drawer closes
  if (e.key === 'Escape' && drawer.isOpen()) return drawer.escape() || drawer.close();
  if (typing) return;
  // Esc in the building: out of a floor (docs/cutaway.md §2)
  if (e.key === 'Escape' && active === 'today' && workshop.escape()) return;
  if (e.key === 'Escape' && active === 'feed' && stage.escape?.()) return;
  if (e.key >= '1' && e.key <= '5') showTab(NAV_KEYS[Number(e.key) - 1]);
  else if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) guide.show();
  else if (e.key === 'r' || e.key === 'R') setMode(stage.mode === 'replay' ? 'live' : 'replay');
  else if (e.key === ' ' && stage.mode === 'replay') {
    e.preventDefault();
    playBtn.click();
  } else if (e.key === '/') {
    const input = $(`#tab-${active} input[type=search]`);
    if (input) {
      e.preventDefault();
      input.focus();
    }
  }
});

if (TAB_KEYS.includes(params.get('tab'))) active = params.get('tab');
showTab(active);
renderConn();
// ?wsproject=<id>: the Workshop opens on that project (a link from outside the app)
if (params.has('wsproject') && !QA) workshop.showProject(params.get('wsproject'));
if (QA) {
  store.setStatus(true);
  loadSnapshot();
} else {
  connect();
}
// Advanced views as the Settings say (after the first tab and scene are known)
applyAdvanced();
// The guide opens only when asked (docs/direction.md §3.3); a QA page with ?guide=1 or ?guide=step:<n>
if (shouldAutoOpen({ stored: readSeen(), qa: QA, param: params.get('guide') })) guide.show(startStep(params.get('guide')));
