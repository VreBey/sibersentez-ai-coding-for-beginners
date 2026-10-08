// Today's "First 10 minutes" checklist (docs/shell.md): the four things a new user does once, each ticked by itself from
// what SiberSentez already knows (the AI tools found, the actions mode, the projects, the sessions), each with the one
// button that does it. It goes away when all four are done or when the person hides it.
// checklistModel and checklistHtml are pure (tested in node); createChecklist wires the buttons.
import { store } from '../store.js';
import { esc } from '../format.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { isOtherFolder } from '../attention.js';

export const CHECKLIST_KEY = 'sibersentez.checklist';
export const STEPS = Object.freeze(['tool', 'actions', 'project', 'session']);

// s: { tools: the tools state ({ status, tools }), mode, projects: [project], sessions: [session], askOnStart }
// -> { steps: [{ id, done, pending }], done, next } ; pending: not known yet (the tools are still being looked for).
// askOnStart: the desktop app, where Start asks once to turn actions on (2026-10-02), so "Turn actions on" is no step
export function checklistModel({ tools = { status: 'idle', tools: [] }, mode = 'off', projects = [], sessions = [], askOnStart = false } = {}) {
  const real = projects.filter((p) => !isOtherFolder(p));
  const known = tools.status === 'ready';
  const steps = [
    { id: 'tool', done: known && tools.tools.some((x) => x.installed), pending: !known },
    { id: 'actions', done: mode === 'live', pending: false },
    { id: 'project', done: real.length > 0, pending: false },
    // A session in a project counts (the logs keep 14 days): the person has started an AI tool at least once
    { id: 'session', done: sessions.some((s) => s && s.projectId), pending: false },
  ].filter((s) => !(askOnStart && s.id === 'actions'));
  const next = steps.find((s) => !s.done && !s.pending)?.id || null;
  return { steps, done: steps.every((s) => s.done), next };
}

// The one big start (docs/direction.md §3.3): while there is no project of the person's own yet, Today shows a single
// card, "Got an idea?", with one primary button (New project) instead of the four-step list, and a link to the short
// tour. The list comes once the first project exists. tools: the tools state; no tool found yet adds its button.
export function startCardHtml({ tools = { status: 'idle', tools: [] } } = {}) {
  const noTool = tools.status === 'ready' && !tools.tools.some((x) => x.installed);
  const toolBtn = noTool ? `<button type="button" class="act-btn" data-cl="tool" data-fk="cl:tool">${esc(t('cl_tool_go'))}</button>` : '';
  return `<section class="first-card" aria-labelledby="firstCardH"><div class="fc-text"><h2 id="firstCardH">${esc(t('firstCardTitle'))}</h2><p>${esc(t('firstCardBody'))}</p></div><div class="fc-btns"><button type="button" class="act-btn primary fc-go" data-cl="project" data-fk="cl:project">${icon('folder')}<span>${esc(t('firstCardGo'))}</span></button>${toolBtn}<button type="button" class="act-btn" data-cl="demo" data-fk="cl:demo">${icon('play')}<span>${esc(t('firstCardDemo'))}</span></button><button type="button" class="linkish" data-cl="tour" data-fk="cl:tour">${esc(t('firstCardTour'))}</button></div></section>`;
}

// Whether the person has a project of their own (a folder they work in; broad and system folders do not count)
export function hasOwnProject(projects = []) {
  return projects.some((p) => p && !isOtherFolder(p));
}

// canActions: the desktop app can open the actions panel here
export function checklistHtml(model, { canActions = true } = {}) {
  if (model.done) return '';
  const count = model.steps.filter((s) => s.done).length;
  // Done steps fold into one line of ticks (2026-10-02: three done cards took half a laptop screen); the steps left
  // stay cards, each with its button
  const doneLine = count
    ? `<p class="cl-done-line">${model.steps
        .filter((s) => s.done)
        .map((s) => `<span class="cl-done-item">${icon('check')}${esc(t(`cl_${s.id}`))}<span class="sr-only">${esc(t('clDoneSr'))}</span></span>`)
        .join('')}</p>`
    : '';
  const rows = model.steps
    .map((s, i) => {
      if (s.done) return '';
      const state = s.done ? 'done' : s.pending ? 'pending' : s.id === model.next ? 'next' : 'todo';
      const mark = s.done ? icon('check') : `<span class="cl-num">${i + 1}</span>`;
      // Starting the AI needs a project first: no button that would do nothing
      const blocked = (s.id === 'actions' && !canActions) || (s.id === 'session' && !model.steps.find((x) => x.id === 'project').done);
      const btn = s.done || s.pending || blocked ? '' : `<button type="button" class="act-btn${state === 'next' ? ' primary' : ''}" data-cl="${s.id}" data-fk="cl:${s.id}">${esc(t(`cl_${s.id}_go`))}</button>`;
      const note = s.pending ? t('clPending') : s.id === 'actions' && !s.done && !canActions ? t('clActionsApp') : t(`cl_${s.id}_why`);
      return `<li class="cl-row ${state}"><span class="cl-mark" aria-hidden="true">${mark}</span><div class="cl-text"><b>${esc(t(`cl_${s.id}`))}</b><p class="small">${esc(note)}</p></div>${btn}<span class="sr-only">${esc(t(s.done ? 'clDoneSr' : 'clTodoSr'))}</span></li>`;
    })
    .join('');
  return `<section class="checklist" aria-labelledby="clTitle"><div class="cl-head"><h2 id="clTitle">${esc(t('clTitle'))}</h2><span class="cl-count">${esc(t('clCount', { done: count, total: model.steps.length }))}</span><button type="button" class="linkish cl-hide" data-cl="hide" data-fk="cl:hide">${esc(t('clHide'))}</button></div>${doneLine}<ol class="cl-list">${rows}</ol></section>`;
}

// actions: { tools(), actions() | null, newProject(), startAi(projectId), needTools(), toolsState(), mode(), guide() }
export function createChecklist(el, actions) {
  let last = '';
  const hidden = () => {
    try {
      return localStorage.getItem(CHECKLIST_KEY) === 'hidden';
    } catch {
      return false;
    }
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-cl]');
    if (!b) return;
    const id = b.dataset.cl;
    if (id === 'hide') {
      try {
        localStorage.setItem(CHECKLIST_KEY, 'hidden');
      } catch {
        /* storage may be blocked: hidden for this window only */
      }
      el.hidden = true;
      el.innerHTML = '';
      last = '';
      return;
    }
    if (id === 'guide') actions.guide?.();
    // The link names the full tour, so it opens the tour itself (review U12: it opened the guide's window before)
    else if (id === 'tour') actions.tour?.();
    else if (id === 'demo') actions.demo?.();
    else if (id === 'tool') actions.tools();
    else if (id === 'actions') actions.actions?.();
    else if (id === 'project') actions.newProject();
    else if (id === 'session') {
      // The most recent real project: the Building's job box for it
      const p = store.sortedProjects().find((x) => !isOtherFolder(x));
      if (p) actions.startAi(p.id);
    }
  });
  return {
    render() {
      if (!store.loaded) {
        el.hidden = true;
        return;
      }
      // No project of their own yet: the one big start, whether the list was hidden or not
      if (!hasOwnProject([...store.projects.values()])) {
        actions.needTools();
        const html = startCardHtml({ tools: actions.toolsState() });
        el.hidden = false;
        if (html !== last) {
          last = html;
          el.innerHTML = html;
        }
        return;
      }
      if (hidden()) {
        el.hidden = true;
        return;
      }
      actions.needTools(); // first need: finds the AI tools once (docs/ai-start.md)
      const model = checklistModel({ tools: actions.toolsState(), mode: actions.mode(), projects: [...store.projects.values()], sessions: [...store.sessions.values()], askOnStart: typeof actions.actions === 'function' });
      const html = checklistHtml(model, { canActions: typeof actions.actions === 'function' });
      el.hidden = !html;
      if (html === last) return;
      last = html;
      el.innerHTML = html;
    },
  };
}
