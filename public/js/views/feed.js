// @ts-check
// Feed: what happened, in which project, who did it. Both the short feed in the right rail and the full tab.
import { store } from '../store.js';
import { esc, dayTime, projectColor, KIND, fillAgo, locale, eventText, replaceHtml } from '../format.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const DEFAULT_KINDS = ['prompt', 'command', 'agent_start', 'agent_done', 'skill', 'workflow_start', 'workflow_done', 'commit', 'compact', 'title'];

export function eventRow(e, { compact = false } = {}) {
  const k = KIND[e.kind] || { l: e.kind, c: '#8a93a6', i: 'spark' };
  const p = store.projects.get(e.projectId);
  const s = e.sessionId ? store.sessions.get(e.sessionId) : null;
  const target = e.actor && e.actor.startsWith('a:') && e.kind === 'agent_done' ? `data-agent="${esc(e.actor.slice(2))}"` : e.sessionId ? `data-session="${esc(e.sessionId)}"` : e.projectId ? `data-project="${esc(e.projectId)}"` : '';
  const extra = e.kind === 'agent_start' || e.kind === 'agent_done' ? (e.meta?.type ? `<em class="etype">${esc(e.meta.type)}</em>` : '') : e.kind === 'skill' ? '<em class="etype">skill</em>' : '';
  return `<li class="ev k-${e.kind}" ${target} style="--k:${k.c}">
    <span class="ev-ic" title="${esc(k.l)}">${icon(k.i)}</span>
    <div class="ev-body">
      <div class="ev-line">${extra}<span class="ev-text">${esc(eventText(e))}</span></div>
      <div class="ev-meta">${p ? `<span class="ev-proj" style="--c:${projectColor(p.id)}"><i></i>${esc(p.name)}</span>` : ''}${!compact && s ? `<span class="ev-sess">${esc(trunc(store.sessionLabel(s), 70))}</span>` : ''}<span class="ev-kind">${esc(k.l)}</span></div>
    </div>
    ${compact ? `<time title="${esc(new Date(e.t).toLocaleString(locale()))}" data-ago="${Number(e.t) || 0}"></time>` : `<time title="${esc(new Date(e.t).toLocaleString(locale()))}">${dayTime(e.t)}</time>`}
  </li>`;
}

export function createFeedView(root, openDrawer) {
  const kinds = new Set(DEFAULT_KINDS);
  let q = '';
  let project = 'all';
  let limit = 250;
  root.innerHTML = `
    <div class="toolbar wrap">
      <label class="search">${icon('search')}<input type="search" placeholder="${esc(t('feedSearch'))}" data-k="q" aria-label="${esc(t('feedSearchAria'))}"></label>
      <select data-k="project" aria-label="${esc(t('feedProjectAria'))}"><option value="all">${esc(t('feedAllProjects'))}</option></select>
      <div class="chips" data-k="kinds">${Object.entries(KIND)
        .map(([k, v]) => `<button data-v="${k}" class="kchip ${kinds.has(k) ? 'on' : ''}" style="--k:${v.c}">${icon(v.i)}${esc(v.l)}</button>`)
        .join('')}</div>
    </div>
    <ol class="feed full" data-k="list"></ol>`;
  const $ = (k) => root.querySelector(`[data-k=${k}]`);
  $('q').addEventListener('input', (e) => {
    q = e.target.value.trim().toLocaleLowerCase(locale());
    render();
  });
  $('project').addEventListener('change', (e) => {
    project = e.target.value;
    render();
  });
  $('kinds').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const k = b.dataset.v;
    if (kinds.has(k)) kinds.delete(k);
    else kinds.add(k);
    b.classList.toggle('on', kinds.has(k));
    render();
  });
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) {
      limit += 500;
      return render();
    }
    bindOpen(e, openDrawer);
  });

  let projKey = '';
  function render() {
    const projects = store.sortedProjects();
    const key = projects.map((p) => p.id).join('|');
    if (key !== projKey) {
      projKey = key;
      const sel = $('project');
      const cur = sel.value;
      sel.innerHTML = `<option value="all">${esc(t('feedAllProjects'))}</option>` + projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      sel.value = projects.some((p) => p.id === cur) ? cur : 'all';
    }
    const out = [];
    for (let i = store.events.length - 1; i >= 0 && out.length < limit + 1; i--) {
      const e = store.events[i];
      if (!kinds.has(e.kind)) continue;
      if (project !== 'all' && e.projectId !== project) continue;
      if (q && !eventText(e).toLocaleLowerCase(locale()).includes(q)) continue;
      out.push(e);
    }
    const more = out.length > limit;
    replaceHtml($('list'), out.slice(0, limit).map((e) => eventRow(e)).join('') + (more ? `<li class="more-row"><button class="more" data-more>${esc(t('feedMore'))}</button></li>` : '') || `<li class="empty-state">${esc(t('feedNoMatch'))}</li>`);
  }

  return { render };
}

// The short feed in the right rail: only the important events
export function renderMiniFeed(el) {
  const out = [];
  for (let i = store.events.length - 1; i >= 0 && out.length < 60; i--) {
    const e = store.events[i];
    if (e.kind === 'live' || e.kind === 'title') continue;
    out.push(e);
  }
  const html = out.map((e) => eventRow(e, { compact: true })).join('') || `<li class="empty-state small">${esc(t('feedNone'))}</li>`;
  // Do not touch it if unchanged (so the DOM is not refreshed during a click)
  if (el._html !== html) {
    el._html = html;
    replaceHtml(el, html);
  }
  fillAgo(el);
}

export function bindOpen(e, openDrawer) {
  const a = e.target.closest('[data-agent]');
  if (a) return openDrawer({ type: 'agent', id: a.dataset.agent });
  const s = e.target.closest('[data-session]');
  if (s && s.dataset.session) return openDrawer({ type: 'session', id: s.dataset.session });
  const p = e.target.closest('[data-project]');
  if (p) openDrawer({ type: 'project', id: p.dataset.project });
}

function trunc(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
