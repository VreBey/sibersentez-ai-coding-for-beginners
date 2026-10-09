// Projects tab: a card per project with "what is going on now / what finished last"
import { store } from '../store.js';
import { esc, ago, num, tok, projectColor, agentColor, modelName, dayTime, actionLine, locale, shownDescription, replaceHtml, projectKindText, projectNames } from '../format.js';
import { icon } from '../icons.js';
import { libraryState } from '../rosterModel.js';
import { suggestable } from '../contextmenu.js';
import { t } from '../i18n.js';
import { cardLineHtml, bySpend, costShown } from '../usage.js';
import { openToolsPanel } from './tools.js';
import { realTwin } from './job.js';
import { isHiddenProject } from '../hiddenProjects.js';
import { groupSessions, projectState, sessionState, holdOrder, isOtherFolder } from '../attention.js';
import { withTransition, replay, transitionName } from '../motion.js';
import { multiTool, toolOptions, matchesTool, toolTagsHtml, toolSelectHtml } from '../toolTags.js';

const RECENT_ICON = { session: 'prompt', agent: 'check', workflow: 'workflow', commit: 'commit' };
const RECENT_LABEL = { session: 'prjRecent_session', agent: 'prjRecent_agent', workflow: 'prjRecent_workflow', commit: 'prjRecent_commit' };

// ---------- "N fit" badge (docs/auto-skills.md §4) ----------

// Badge number of a fit (pure): strong-fit candidates that can be installed and are not in the project yet, one per
// kind and name, from the SiberSentez kit or the library (what the drawer lists before "also from my other projects").
// A fit with a problem (no hub, a broad folder, ...) has none.
export function fitBadgeCount(fit) {
  if (!fit || typeof fit !== 'object' || fit.problem) return 0;
  const seen = new Set();
  for (const c of Array.isArray(fit.candidates) ? fit.candidates : []) {
    const own = Array.isArray(c?.sources) && (c.sources.includes('kit') || c.sources.includes('library'));
    if (c && own && c.confidence === 'high' && !c.installed && c.installable === true) seen.add(`${c.kind}:${String(c.name).toLowerCase()}`);
  }
  return seen.size;
}

// The badge of one card; nothing when the count is 0. A button: it opens the drawer at "Skills for this project".
export function fitBadgeHtml(projectId, count) {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  const title = t('fitBadgeTitle', { count: num(n) });
  return `<button type="button" class="fit-badge" data-fit-open="${esc(projectId)}" title="${esc(title)}" aria-label="${esc(title)}">${icon('grid')}<span>${esc(t('fitBadge', { count: num(n) }))}</span></button>`;
}

// Fit requests for the badges, kept few: only for the projects whose cards are on screen (want), one request at a
// time, each answer cached (ttl; a failure is tried again after failTtl). A fit the drawer loaded is taken as it is
// (note), without a request. fetchFit(id) resolves to the fit or rejects; eligible(id) says whether a project can
// have a fit worth asking for; onChange(id) runs when a badge number changed. Pure apart from the injected calls.
export function createFitBadges({ fetchFit, eligible = () => true, onChange = () => {}, now = () => Date.now(), ttl = 5 * 60 * 1000, failTtl = 60 * 1000 } = {}) {
  const cache = new Map(); // id -> { at, ok, count }
  let queue = [];
  let inflight = null;
  let running = false;
  const stats = { requests: 0 };

  const fresh = (id) => {
    const c = cache.get(id);
    return !!c && now() - c.at < (c.ok ? ttl : failTtl);
  };
  function put(id, entry) {
    const prev = cache.get(id);
    cache.set(id, entry);
    if ((prev?.count || 0) !== entry.count) {
      try {
        onChange(id);
      } catch (e) {
        console.error(e);
      }
    }
  }

  // The projects on screen now: the queue becomes exactly those that still need an answer (cards scrolled away
  // are dropped before their request is sent)
  function want(ids) {
    const seen = new Set();
    queue = [];
    for (const id of ids || []) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      if (id === inflight || fresh(id) || !eligible(id)) continue;
      queue.push(id);
    }
    return pump();
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const id = queue.shift();
        if (fresh(id)) continue;
        inflight = id;
        stats.requests++;
        let entry;
        try {
          entry = { at: now(), ok: true, count: fitBadgeCount(await fetchFit(id)) };
        } catch {
          entry = { at: now(), ok: false, count: cache.get(id)?.count || 0 };
        }
        inflight = null;
        put(id, entry);
      }
    } finally {
      inflight = null;
      running = false;
    }
  }

  // A fit that arrived elsewhere (the drawer): cached as a fresh answer, no request
  function note(id, fit) {
    if (typeof id !== 'string' || !id) return;
    queue = queue.filter((x) => x !== id);
    put(id, { at: now(), ok: true, count: fitBadgeCount(fit) });
  }

  return { want, note, count: (id) => cache.get(id)?.count || 0, stats, pending: () => queue.length + (inflight ? 1 : 0), idle: () => !running };
}

// GET /api/projects/<id>/fit for a badge (read-only; the server caches it)
async function fetchFitJson(id) {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/fit`, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// ---------- New project (docs/start-flow.md, step 2) ----------
// Choose or create a folder -> write the idea -> install what is suggested -> open a terminal. The folder picker belongs
// to the desktop shell: the page asks through window.sibersentezShell (electron/preload.cjs), which answers with the
// project id only. A plain browser has no bridge: the button explains where projects are added instead.

// The bridge's new-project functions, or null (a plain browser, an older app)
export function projectBridge(win) {
  const b = win?.sibersentezShell;
  return b && typeof b.pickProjectFolder === 'function' && typeof b.saveProjectIdea === 'function' ? b : null;
}

// Reasons whose text says the folder itself cannot be a project (the rest are errors of the request)
const FOLDER_REASONS = new Set(['network', 'not-local', 'invalid', 'drive-root', 'home', 'broad', 'hub', 'program', 'personal', 'link', 'missing', 'not-folder', 'holds-projects']);

// What the page does with the shell's answer to pickProjectFolder or createIdeaProject (pure). nameOf(id): the
// project's name. made: the project was made from an idea (review U05); withIdea: its idea waits in the job box.
// Returns { projectId: string | null, toast: { tone, title, body } | null }: the project to open (its drawer, at the idea
// box, or with the idea in its job box) and the notice. Cancel says nothing.
export function newProjectOutcome(reply, nameOf = (id) => id, { made = false, withIdea = false } = {}) {
  const r = reply && typeof reply === 'object' ? reply : {};
  if (r.ok === true && typeof r.projectId === 'string' && r.projectId) {
    const name = nameOf(r.projectId) || r.projectId;
    if (made) return { projectId: r.projectId, toast: { tone: 'ok', title: t('npCreated', { name }), body: t(withIdea ? 'npCreatedNext' : 'npNextIdea') } };
    return { projectId: r.projectId, toast: { tone: 'ok', title: t(r.existed ? 'npExisting' : 'npAdded', { name }), body: t('npNextIdea') } };
  }
  const reason = typeof r.reason === 'string' ? r.reason : 'error';
  if (reason === 'cancelled') return { projectId: null, toast: null };
  const known = t(`npErr_${reason}`) !== `npErr_${reason}`;
  const title = made ? 'npCreateFailTitle' : FOLDER_REASONS.has(reason) ? 'npFailTitle' : 'npErrorTitle';
  return { projectId: null, toast: { tone: 'err', title: t(title), body: known ? t(`npErr_${reason}`) : t('npErr_error') } };
}

// The flow behind the header button, the start card and the tray's "New project…". Parts are injected (tests):
//   bridge          projectBridge(window) or a QA stand-in; null in a plain browser
//   toast(o)        a notice                          openProject(id)   the project's drawer at the idea box
//   hasProject(id)  the page lists it already         refresh()         load the project list again (a snapshot)
//   nameOf(id)      a project's name                  wait(ms)          a pause (tests pass a fast one)
//   ask(prev)       the "New project" window (views/newIdea.js createIdeaDialog().ask; prev: what the last try had and
//                   why it did not work); without it, or with a bridge that cannot make a folder, the folder picker
//                   opens at once (the old way)
// openProject(id, idea) gets the idea of a project made from one (its job box is filled, Start stays the person's).
// One picker at a time. The server lists the new project before it answers; the page may still be a moment behind, so
// it waits up to waitMs for the project, then loads the list again once. Resolves 'opened' | 'cancelled' | 'failed' |
// 'busy' | 'unavailable'.
export function createNewProjectFlow({ bridge, toast = () => {}, openProject = () => {}, hasProject = () => true, refresh = async () => {}, nameOf = (id) => id, ask = null, wait = (ms) => new Promise((r) => setTimeout(r, ms)), waitMs = 4000, stepMs = 150 } = {}) {
  let busy = false;
  async function until(id, ms) {
    for (let waited = 0; !hasProject(id) && waited < ms; waited += stepMs) await wait(stepMs);
    return hasProject(id);
  }
  async function start() {
    if (!bridge) {
      toast({ tone: 'dry', title: t('npAppOnlyTitle'), body: t('npAppOnlyBody') });
      return 'unavailable';
    }
    if (busy) return 'busy';
    busy = true;
    try {
      // The window first (a name and an idea); "Already have a project folder?" and an older shell take the picker. A
      // try that did not work (refused, or "Somewhere else" cancelled) brings the window back with what was typed and
      // the reason in it, until it works or the person leaves it.
      const windowed = typeof ask === 'function' && typeof bridge.createIdeaProject === 'function';
      let prev = null;
      let choice;
      let made;
      let idea;
      let reply;
      for (;;) {
        choice = { action: 'existing' };
        if (windowed) {
          try {
            choice = (await ask(prev)) || { action: 'cancel' };
          } catch {
            choice = { action: 'cancel' };
          }
        }
        if (choice.action !== 'existing' && choice.action !== 'create' && choice.action !== 'elsewhere') return 'cancelled';
        made = choice.action !== 'existing';
        idea = made && typeof choice.idea === 'string' ? choice.idea : '';
        try {
          reply = made ? await bridge.createIdeaProject(String(choice.name || ''), idea, choice.action === 'elsewhere') : await bridge.pickProjectFolder();
        } catch {
          reply = { ok: false, reason: 'error' };
        }
        if (!made || reply?.ok === true) break;
        const failed = newProjectOutcome(reply, nameOf, { made: true });
        prev = { name: String(choice.name || ''), idea, error: failed.toast ? failed.toast.body : '' };
      }
      const pid = reply?.ok === true && typeof reply.projectId === 'string' ? reply.projectId : null;
      if (pid && !(await until(pid, waitMs))) {
        try {
          await refresh();
        } catch {
          // the list comes with the next update
        }
        await until(pid, 2000);
      }
      const out = newProjectOutcome(reply, nameOf, { made, withIdea: !!idea });
      if (out.toast) toast(out.toast);
      if (!out.projectId) return out.toast ? 'failed' : 'cancelled';
      openProject(out.projectId, idea);
      return 'opened';
    } finally {
      busy = false;
    }
  }
  return { start, busy: () => busy };
}

// A QA stand-in for the bridge (?qa=1&newproject=<answer>): 'pick' answers with the first project that can take skills
// (as if its folder was chosen, or made from an idea), any other value is the reason of a refusal; nothing reaches the
// shell or the server
export function qaProjectBridge(answer, firstProject = () => null) {
  const reply = () => {
    const id = answer === 'pick' ? firstProject() : null;
    return id ? { ok: true, projectId: id, existed: false, reason: 'added' } : { ok: false, reason: answer === 'pick' ? 'missing' : String(answer || 'error') };
  };
  return Object.freeze({
    pickProjectFolder: async () => reply(),
    createIdeaProject: async () => reply(),
    saveProjectIdea: async (projectId) => ({ ok: true, projectId, reason: 'saved' }),
  });
}

// ---------- "Getting started" card ----------
const START_CARD_KEY = 'sibersentez.start.hidden';
// Shown while this many projects or fewer are listed (and the card was not hidden)
export const START_CARD_MAX = 2;

// Projects that count as the user's own: a folder that exists, not a broad one, not only a temp folder
export function ownProjects(projects) {
  const list = projects instanceof Map ? [...projects.values()] : Array.isArray(projects) ? projects : [];
  return list.filter((p) => p && p.path && p.exists !== false && !p.broad && !p.tmpOnly && p.kind !== 'hub');
}

export function startCardVisible(projects, hidden) {
  return !hidden && ownProjects(projects).length <= START_CARD_MAX;
}

// The card (pure): three plain steps (the third: pick an AI tool, SiberSentez starts it with the idea; docs/ai-start.md),
// the "New project" button, "AI tools" (the tools panel), "Don't show again"
export function startCardHtml() {
  const steps = ['startCardStep1', 'startCardStep2', 'aiStartCardStep3'].map((k, i) => `<li><span class="sc-n" aria-hidden="true">${i + 1}</span><span>${esc(t(k))}</span></li>`).join('');
  return `<section class="start-card" aria-labelledby="startCardH"><div class="sc-main"><h3 id="startCardH">${esc(t('startCardTitle'))}</h3><ol class="sc-steps">${steps}</ol><p class="small muted sc-note">${esc(t('startCardNote'))}</p></div><div class="sc-acts"><button type="button" class="act-btn primary" data-start-act="new" data-start-fk="new">${icon('folder')}<span>${esc(t('newProjectButton'))}</span></button><button type="button" class="act-btn" data-start-act="tools" data-start-fk="tools">${icon('spark')}<span>${esc(t('aiStartCardTools'))}</span></button><button type="button" class="sc-hide" data-start-act="hide" data-start-fk="hide">${esc(t('startCardHide'))}</button></div></section>`;
}

function readHidden() {
  try {
    return globalThis.localStorage?.getItem(START_CARD_KEY) === '1';
  } catch {
    return false;
  }
}

// Sort of the Projects tab: 'activity' (open and busy first, then the latest activity) or 'spend' (the last 30 days'
// API-equivalent dollars, or processed tokens while dollars are hidden; docs/usage.md §6), kept in this browser
const SORT_KEY = 'sibersentez.projects.sort';
const SORTS = ['activity', 'spend'];
function readSort() {
  try {
    const v = globalThis.localStorage?.getItem(SORT_KEY);
    return SORTS.includes(v) ? v : 'activity';
  } catch {
    return 'activity';
  }
}

// Groups of the list (pure): by activity the open ones, the last N days, the quiet ones; by spend the projects with
// usage in the last 30 days, most first, then the rest in activity order. all: projects in activity order.
// Folders that are not projects (isOtherFolder, docs/folders.md) go to a last group of their own ({ other: true }).
// A moved project's old folder (nothing but AI settings in it, the real project with the same name listed, not open
// now) goes there too: it stood beside the real one in "Last 14 days" (seen 2026-10-02, the game project on two drives).
export function projectGroups(list, { sort = 'activity', windowDays = 14, now = Date.now(), cost = costShown() } = {}) {
  const leftBehind = (p) => !!p.toolsOnly && !p.live && !!realTwin(list, p);
  const away = (p) => isOtherFolder(p) || leftBehind(p);
  const all = list.filter((p) => !away(p));
  const others = list.filter(away);
  const otherGroup = others.length ? [{ title: t('foldersOther'), items: others, other: true }] : [];
  if (sort === 'spend') {
    const [used, unused] = bySpend(all, cost);
    return [
      { title: t('usageGroupSpend'), items: used },
      { title: t('usageGroupNone'), items: unused },
    ].filter((g) => g.items.length).concat(otherGroup);
  }
  return [
    { title: t('prjGroupOpen'), items: all.filter((p) => p.live) },
    { title: t('prjGroupDays', { n: windowDays }), items: all.filter((p) => !p.live && p.lastActivity > now - windowDays * 86400000) },
    { title: t('prjGroupQuiet'), items: all.filter((p) => !p.live && !(p.lastActivity > now - windowDays * 86400000)) },
  ].filter((g) => g.items.length).concat(otherGroup);
}

// options.onNewProject(): the new-project flow (main.js), started from the start card
export function createProjectsView(root, openDrawer, { onNewProject = () => {} } = {}) {
  let startHidden = readHidden();
  let query = '';
  let showAdhoc = true;
  // Which AI tool's projects (docs/tool-view.md); the filter shows only when more than one tool left traces here
  let tool = 'all';
  let sort = readSort();
  // The card order of the last render (holdOrder keeps it while the person is in the list)
  let lastOrder = [];
  // Motion: the order and the card states of the last render (null: nothing drawn yet)
  let renderedOrder = null;
  let lastStates = new Map();
  // Is the "Other folders" group open (it starts folded)
  let otherOpen = false;
  // Badges: redrawn (once, shortly after) when a number changed
  let redraw = null;
  const badges = createFitBadges({
    fetchFit: fetchFitJson,
    eligible: (id) => suggestable(store.projects.get(id)),
    onChange: () => {
      if (!redraw) redraw = setTimeout(() => ((redraw = null), render()), 50);
    },
  });
  // Cards on screen (IntersectionObserver); without it, the first cards count as visible
  const visible = new Set();
  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          for (const e of entries) {
            const id = e.target.dataset.project;
            if (e.isIntersecting) visible.add(id);
            else visible.delete(id);
          }
          badges.want([...visible]);
        })
      : null;
  function watchCards() {
    const cards = [...groupsEl.querySelectorAll('.pcard[data-project]')];
    if (!observer) return badges.want(cards.slice(0, 12).map((c) => c.dataset.project));
    observer.disconnect();
    visible.clear();
    for (const c of cards) observer.observe(c);
  }
  root.innerHTML = `
    <div class="toolbar">
      <label class="search">${icon('search')}<input type="search" placeholder="${esc(t('prjSearch'))}" data-k="q" aria-label="${esc(t('prjSearchAria'))}"></label>
      <label class="toggle"><input type="checkbox" data-k="adhoc" checked><span>${esc(t('prjShowAdhoc'))}</span></label>
      <select class="tool-sel" data-k="tool" aria-label="${esc(t('tvFilterLabel'))}" title="${esc(t('tvFilterLabel'))}" hidden></select>
      <label class="psort"><span>${esc(t('usageSort'))}</span><select data-k="sort"></select></label>
      <div class="toolbar-note" data-k="note"></div>
    </div>
    <div class="start-slot" data-k="start"></div>
    <div class="pgroups" data-k="groups"></div>`;
  const groupsEl = root.querySelector('[data-k=groups]');
  groupsEl.addEventListener('toggle', (e) => {
    if (e.target.matches?.('details[data-other]')) otherOpen = e.target.open;
  }, true);
  // Leaving the list lets the fresh order back in (holdOrder)
  groupsEl.addEventListener('mouseleave', () => render());
  groupsEl.addEventListener('focusout', (e) => {
    if (!groupsEl.contains(e.relatedTarget)) render();
  });
  const noteEl = root.querySelector('[data-k=note]');
  const startEl = root.querySelector('[data-k=start]');
  // The "Getting started" card: "New project" starts the flow; "Don't show again" hides it for good (this browser)
  startEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-start-act]');
    if (!b) return;
    if (b.dataset.startAct === 'new') return onNewProject();
    if (b.dataset.startAct === 'tools') return openToolsPanel();
    if (b.dataset.startAct === 'hide') {
      startHidden = true;
      try {
        globalThis.localStorage?.setItem(START_CARD_KEY, '1');
      } catch {
        // storage blocked: hidden until a reload
      }
      render();
      root.querySelector('[data-k=q]')?.focus({ preventScroll: true });
    }
  });
  root.querySelector('[data-k=q]').addEventListener('input', (e) => {
    query = e.target.value.trim().toLocaleLowerCase('tr-TR');
    render();
  });
  const toolEl = root.querySelector('[data-k=tool]');
  toolEl.addEventListener('change', (e) => {
    tool = e.target.value || 'all';
    render();
  });
  root.querySelector('[data-k=adhoc]').addEventListener('change', (e) => {
    showAdhoc = e.target.checked;
    render();
  });
  const sortEl = root.querySelector('[data-k=sort]');
  sortEl.addEventListener('change', (e) => {
    sort = SORTS.includes(e.target.value) ? e.target.value : 'activity';
    try {
      globalThis.localStorage?.setItem(SORT_KEY, sort);
    } catch {
      // storage blocked: kept until a reload
    }
    render();
  });
  // The spend option names what it sorts by: dollars, or tokens while dollars are hidden
  function renderSort() {
    const html = [
      ['activity', t('usageSortActivity')],
      ['spend', costShown() ? t('usageSortSpend') : t('usageSortTokens')],
    ]
      .map(([v, label]) => `<option value="${v}"${v === sort ? ' selected' : ''}>${esc(label)}</option>`)
      .join('');
    if (sortEl._html === html) return;
    sortEl._html = html;
    sortEl.innerHTML = html;
  }
  groupsEl.addEventListener('click', (e) => {
    // The "N fit" badge opens the drawer at "Skills for this project"
    const fit = e.target.closest('[data-fit-open]');
    if (fit) return openDrawer({ type: 'project', id: fit.dataset.fitOpen, section: 'skills' });
    const s = e.target.closest('[data-session]');
    if (s) return openDrawer({ type: 'session', id: s.dataset.session });
    const a = e.target.closest('[data-agent]');
    if (a) return openDrawer({ type: 'agent', id: a.dataset.agent });
    const card = e.target.closest('[data-project]');
    if (card) openDrawer({ type: 'project', id: card.dataset.project });
  });
  // A card opens with the keyboard too (Enter/Space); while it has focus, Shift+F10 opens the right-click menu
  // The session/agent rows in the card's recent work take focus as well: Enter/Space opens the detail, Shift+F10 the menu
  groupsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target;
    if (t.matches('.pcard[data-project]')) {
      e.preventDefault();
      e.stopPropagation();
      return openDrawer({ type: 'project', id: t.dataset.project });
    }
    if (t.matches('li[tabindex="0"][data-session], li[tabindex="0"][data-agent]')) {
      e.preventDefault();
      e.stopPropagation();
      openDrawer(t.dataset.session ? { type: 'session', id: t.dataset.session } : { type: 'agent', id: t.dataset.agent });
    }
  });

  function render() {
    const startHtml = store.loaded && startCardVisible(store.projects, startHidden) ? startCardHtml() : '';
    if (startEl._html !== startHtml) {
      const back = startEl.contains(document.activeElement) ? document.activeElement.dataset?.startFk : null;
      startEl._html = startHtml;
      startEl.innerHTML = startHtml;
      if (back) startEl.querySelector(`[data-start-fk="${back}"]`)?.focus({ preventScroll: true });
    }
    renderSort();
    const multi = multiTool(store.tools, store.projects.values());
    shownNames = projectNames([...store.projects.values()]);
    const toolHtml = multi ? toolSelectHtml(toolOptions([...store.projects.values()], store.tools), tool, t('tvAllTools')) : '';
    if (toolEl._html !== toolHtml) {
      toolEl._html = toolHtml;
      toolEl.innerHTML = toolHtml;
      toolEl.hidden = !multi;
      tool = multi ? toolEl.value : 'all';
    }
    const fresh = store.sortedProjects().filter((p) => (!multi || matchesTool(p, tool)) && (showAdhoc || p.kind !== 'adhoc') && (!query || `${p.name} ${p.description} ${p.path}`.toLocaleLowerCase(locale()).includes(query)));
    // While the person points at or works in the list, the cards keep their places (attention.js holdOrder); the
    // fresh order comes back when the pointer and the focus leave it
    const held = groupsEl.matches(':hover') || groupsEl.contains(document.activeElement);
    const all = holdOrder(fresh, lastOrder, held);
    lastOrder = all.map((p) => p.id);
    const byProject = groupSessions(store.sessions.values());
    const groups = projectGroups(all, { sort, windowDays: store.windowDays });
    const real = all.filter((p) => !isOtherFolder(p));
    noteEl.textContent = t('prjNote', { n: real.length, open: real.filter((p) => p.live).length });
    const cards = (g) => `<div class="pgrid">${g.items.map((p) => card(p, badges.count(p.id), byProject, multi)).join('')}</div>`;
    // The other folders are folded away unless the person opened them (kept while the page is open)
    const html = groups
      .map((g) =>
        g.other
          ? `<details class="pgroup pother" data-other${otherOpen ? ' open' : ''}><summary class="group-title">${esc(g.title)} <span>${g.items.length}</span></summary><p class="pother-hint">${esc(t('foldersOtherHint'))}</p>${cards(g)}</details>`
          : `<section class="pgroup"><h3 class="group-title">${esc(g.title)} <span>${g.items.length}</span></h3>${cards(g)}</section>`,
      )
      .join('') || emptyProjects();
    // Do not touch it if unchanged; if changed, keyboard focus returns to the same card/row (a redraw must not drop focus)
    if (groupsEl._html === html) return;
    const focus = focusSelector(document.activeElement, groupsEl);
    groupsEl._html = html;
    // Motion (docs/motion.md): when the order changed, the cards glide to their places; a project that just started
    // waiting glows once. Never while the person is in the list (the order is held then anyway).
    const order = all.map((p) => p.id).join('|');
    const moved = !held && renderedOrder !== null && order !== renderedOrder;
    renderedOrder = order;
    const called = all.filter((p) => stateOf(p, byProject)[0] === 'waiting' && lastStates.get(p.id) !== 'waiting' && lastStates.has(p.id)).map((p) => p.id);
    lastStates = new Map(all.map((p) => [p.id, stateOf(p, byProject)[0]]));
    const apply = () => {
      replaceHtml(groupsEl, html);
      if (focus) groupsEl.querySelector(focus)?.focus({ preventScroll: true });
      watchCards();
      for (const id of called) replay(groupsEl.querySelector(`.pcard[data-project="${CSS.escape(id)}"]`), 'called');
    };
    if (moved) withTransition(apply);
    else apply();
  }

  // noteFit: a fit the drawer loaded updates the badge without a request of its own; sortBy: the sort for this page
  // (QA screenshots; the choice is not stored)
  const sortBy = (s) => {
    if (!SORTS.includes(s) || s === sort) return;
    sort = s;
    render();
  };
  return { render, noteFit: (id, fit) => badges.note(id, fit), sortBy };
}

// No projects at all (fresh install): explain what will appear; otherwise the filter matched nothing
function emptyProjects() {
  if (store.projects.size) return `<div class="empty-state">${esc(t('prjNoMatch'))}</div>`;
  const st = libraryState(store.hub);
  const reg = st.path ? `<br><span class="small">${esc(t('prjRegistryNote'))} <code translate="no">${esc(st.path)}</code></span>` : '';
  return `<div class="empty-state"><b>${esc(t('prjNone'))}</b><br>${esc(t('startEmptyHow'))} ${esc(t('startCardNote'))}${reg}</div>`;
}

// A selector to find the focused element again after a redraw (tag + data attribute)
function focusSelector(el, root) {
  if (!el || !root.contains(el)) return null;
  for (const a of ['data-fit-open', 'data-session', 'data-agent', 'data-project']) {
    if (el.hasAttribute(a)) return `${el.tagName.toLowerCase()}[${a}="${CSS.escape(el.getAttribute(a))}"]`;
  }
  return null;
}

// The card's state: the four states of attention.js; a closed project shows its last activity instead of "Closed"
function stateOf(p, byProject) {
  const st = projectState(p, byProject, Date.now(), store.dockAsking?.() || []);
  if (st !== 'closed') return [st, t('attnState_' + st)];
  return ['rest', p.lastActivity ? ago(p.lastActivity) : t('prjNoActivity')];
}

function spark(series) {
  const max = Math.max(1, ...series);
  const w = 4;
  const gap = 1.5;
  const h = 28;
  const bars = series
    .map((v, i) => {
      const bh = v ? Math.max(2, (v / max) * h) : 1;
      return `<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="1" class="${v ? 'on' : ''}"/>`;
    })
    .join('');
  return `<svg class="spark" viewBox="0 0 ${series.length * (w + gap)} ${h}" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
}

// The names the cards show: two folders with one name (a project moved to another drive) say where they are
let shownNames = new Map();
const shownName = (p) => shownNames.get(p.id) || p.name;

function card(p, fitCount = 0, byProject = groupSessions(store.sessions.values()), multi = false) {
  const [st, stLabel] = stateOf(p, byProject);
  const color = projectColor(p.id);
  const ORDER = { waiting: 0, busy: 1, left: 2 };
  const live = (byProject.get(p.id) || []).slice().sort((a, b) => ORDER[sessionState(a)] - ORDER[sessionState(b)]);
  const running = [...store.agents.values()].filter((a) => a.projectId === p.id && a.status === 'running');
  const nowHtml = live.length || running.length
    ? `<div class="pnow">
        ${live
          .map(
            (s) => `<button class="now-row" data-session="${esc(s.id)}" title="${esc(t('attnState_' + sessionState(s)))}"><i class="sdot s-${sessionState(s)}"></i><span class="now-title">${esc(store.sessionLabel(s))}</span><span class="now-meta">${modelName(s.model)}${s.contextTokens ? ' · ' + tok(s.contextTokens) : ''}</span>${
              s.live.status === 'busy' && s.lastAction ? `<span class="now-act">${icon('action')}${actionLine(s.lastAction)}</span>` : ''
            }</button>`,
          )
          .join('')}
        ${running.length ? `<div class="agent-chips">${running
          .slice(0, 8)
          .map((a) => `<button class="achip" data-agent="${esc(a.id)}" style="--c:${agentColor(a.type)}" title="${esc(a.label)}"><i></i>${esc(a.type)}</button>`)
          .join('')}${running.length > 8 ? `<span class="achip more">+${running.length - 8}</span>` : ''}</div>` : ''}
      </div>`
    : '';
  const recent = (p.recent || []).slice(0, 5);
  const recentHtml = recent.length
    ? `<ul class="precent">${recent
        .map((r) => {
          const attr = r.kind === 'session' ? `data-session="${esc(r.ref)}" tabindex="0"` : r.kind === 'agent' ? `data-agent="${esc(r.ref)}" tabindex="0"` : '';
          const type = r.kind === 'agent' && r.type ? `<em>${esc(r.type)}</em>` : '';
          return `<li class="rk-${r.kind}" ${attr}>${icon(RECENT_ICON[r.kind] || 'spark')}<span class="rtext" title="${esc(t(RECENT_LABEL[r.kind]))}">${type}${esc(r.text)}</span><time>${dayTime(r.t)}</time></li>`;
        })
        .join('')}</ul>`
    : `<p class="muted small">${esc(t('prjNoRecent'))}</p>`;
  const git = p.git
    ? `<span class="meta-item" title="git">${icon('branch')}${esc(p.git.branch || '—')}${
        p.git.changed == null ? ` · ${esc(t('prjGitUnknown'))}` : p.git.changed || p.git.untracked ? ` · <b>${num(p.git.changed + p.git.untracked)}</b> ${esc(t('prjGitChanges'))}` : ` · ${esc(t('prjGitClean'))}`
      }</span>`
    : '';
  const installed = p.installed && (p.installed.skills || p.installed.agents) ? `<span class="meta-item">${icon('users')}${esc(t('prjInstalled', { skills: num(p.installed.skills), agents: num(p.installed.agents) }))}</span>` : '';
  return `<article class="pcard st-${st}" data-project="${esc(p.id)}" style="--pc:${color};view-transition-name:${transitionName('pc', p.id)}" tabindex="0" aria-label="${esc(shownName(p))} · ${esc(stLabel)}">
    <header class="pcard-head">
      <span class="pmark">${esc(initialsOf(p.name))}</span>
      <div class="ptitle"><h4>${esc(shownName(p))}</h4><span class="pkind k-${esc(p.kind)}">${esc(isHiddenProject(p.id) ? t('prjHiddenTag') : p.toolsOnly ? t('jobToolsOnlyTag') : isOtherFolder(p) ? t('foldersPlace_' + (p.place || 'broad')) : projectKindText(p))}</span></div>
      ${fitBadgeHtml(p.id, fitCount)}
      <span class="pstate s-${st}">${st !== 'rest' ? '<i></i>' : ''}${esc(stLabel)}</span>
    </header>
    ${p.idea ? `<p class="pdesc pidea"><b>${esc(t('cardIdea'))}</b> ${esc(p.idea)}</p>` : p.plan ? '' : p.phase || shownDescription(p.description) ? `<p class="pdesc">${esc(p.phase || shownDescription(p.description))}</p>` : ''}
    ${planStrip(p)}
    ${nowHtml}
    ${quiet24(p) ? '' : `<div class="pstats">
      ${spark(p.hourly || [])}
      <div class="pnums"><span><b>${num(p.stats24.tools)}</b> ${esc(t('prjTools'))}</span><span><b>${tok(p.stats24.tokens)}</b> token</span><span><b>${num(p.stats24.agents)}</b> ${esc(t('prjAgents'))}</span><span class="muted">${esc(t('prjLast24'))}</span></div>
    </div>`}
    ${cardLineHtml(p.usage30)}
    ${recentHtml}
    <footer class="pfoot">${multi ? toolTagsHtml(p.via, store.tools) : ''}${git}${installed}${p.packages?.length ? `<span class="meta-item pk" title="${esc(t('prjPackagesTitle'))}">${icon('grid')}${esc(p.packages.slice(0, 3).join(', '))}${p.packages.length > 3 ? '…' : ''}</span>` : ''}</footer>
  </article>`;
}

// Nothing in the last 24 hours: the empty chart and its three zeros are left out (most cards on a real machine,
// 2026-10-02); the 30-day line and the recent list below still say what happened
export function quiet24(p) {
  const s = p?.stats24 || {};
  return !s.tools && !s.tokens && !s.agents && !(p?.hourly || []).some((x) => x > 0);
}

// "What it will do": the stage, the current work and the next step from the project's own status file
function planStrip(p) {
  const pl = p.plan;
  if (!pl) return '';
  const stage = [pl.stage, pl.reviewMode].filter(Boolean).join(' · ');
  return `<div class="pplan">
    <span class="pp-head">${icon('plan')}${esc(t('prjPlan'))}${stage ? ` <em>${esc(stage)}</em>` : ''}</span>
    ${pl.current ? `<p><b>${esc(t('prjNow'))}</b>${esc(pl.current)}</p>` : ''}
    ${pl.next ? `<p><b>${esc(t('prjNext'))}</b>${esc(pl.next)}</p>` : ''}
  </div>`;
}

function initialsOf(name) {
  const w = String(name || '?').replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || '?') + (w[1]?.[0] || '')).toLocaleUpperCase(locale());
}

