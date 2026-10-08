// Today's "Pick up where you left off" block (docs/shell.md): the three projects worked in most recently (what waits or
// runs first), each one click from its detail, and a link to every project. todayRecentHtml is pure (tested in node).
import { store } from '../store.js';
import { esc, ago, projectColor, replaceHtml } from '../format.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { projectState, groupSessions, isOtherFolder } from '../attention.js';

export const RECENT_COUNT = 3;

// projects: store.sortedProjects(now) (most urgent, then most recent first); byProject: groupSessions(...)
export function todayRecentHtml(projects, byProject, now = Date.now()) {
  const list = projects.filter((p) => !isOtherFolder(p) && (p.lastActivity || projectState(p, byProject, now, store.dockAsking?.() || []) !== 'closed')).slice(0, RECENT_COUNT);
  if (!list.length) {
    // Projects there, none worked in yet: point at the job box, not at "New project"
    const any = projects.some((p) => !isOtherFolder(p));
    return `<div class="tr-head"><h2 id="todayRecentH">${esc(t('todayRecent'))}</h2></div><p class="tr-empty small muted">${esc(t(any ? 'todayRecentNoWork' : 'todayRecentEmpty'))}</p>`;
  }
  const cards = list
    .map((p) => {
      const st = projectState(p, byProject, now, store.dockAsking?.() || []);
      return `<button type="button" class="tr-card st-${st}" data-today-open="${esc(p.id)}" style="--c:${projectColor(p.id)}">
        <span class="tr-name"><i></i>${esc(p.name || p.id)}</span>
        <span class="tr-meta">${esc(t(`attnState_${st}`))}${p.lastActivity ? ` · ${esc(ago(p.lastActivity, now))}` : ''}</span>
      </button>`;
    })
    .join('');
  return `<div class="tr-head"><h2 id="todayRecentH">${esc(t('todayRecent'))}</h2><button type="button" class="linkish" data-today-all>${esc(t('todayAllProjects'))}</button></div><div class="tr-cards">${cards}</div>`;
}

export function createTodayRecent(el, { open, showProjects }) {
  let last = '';
  el.addEventListener('click', (e) => {
    const card = e.target.closest?.('[data-today-open]');
    if (card) return open({ type: 'project', id: card.dataset.todayOpen });
    if (e.target.closest?.('[data-today-all]')) showProjects();
  });
  return {
    render() {
      if (!store.loaded) return;
      const now = Date.now();
      const html = todayRecentHtml(store.sortedProjects(now), groupSessions(store.sessions.values()), now);
      if (html === last) return;
      last = html;
      replaceHtml(el, html);
    },
  };
}
