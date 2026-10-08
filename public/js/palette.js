// Command palette (Ctrl+K): search projects, sessions, agents and roster items, Enter goes to the detail.
import { store } from './store.js';
import { t, language } from './i18n.js';
import { esc, projectColor, agentColor, ago, STATUS, sourceLabel } from './format.js';
import { icon } from './icons.js';
import { focusableVisible } from './contextmenu.js';

const LIMIT = 40;
// Lower case with the Turkish letters folded to their plain twins, so "is ver" finds "İş ver" (2026-10-02)
const FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
export const lower = (s) => String(s || '').toLocaleLowerCase(language() === 'tr' ? 'tr-TR' : 'en-US').replace(/[çğıöşüâîû]/g, (c) => FOLD[c]).normalize('NFC');
// A word in a label starts with the term (a match inside a word, "finish" for "is", counts less)
export const wordStart = (label, w) => label.startsWith(w) || label.split(/[\s\-_.·/]+/).some((x) => x.startsWith(w));

// commands: [{ id, label, sub, hay, run }] — things to do (the guide) found by their words; Enter runs them
// beforeRun: before a command acts on the page (main.js: the drawer, a dialog over it, closes first)
export function createPalette({ open, commands = [], beforeRun = () => {} }) {
  const root = document.createElement('div');
  root.className = 'palette-wrap';
  root.hidden = true;
  root.innerHTML = `
    <div class="palette" role="dialog" aria-modal="true" aria-label="${esc(t('palAria'))}">
      <label class="pal-input">${icon('search')}<input type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="palList" placeholder="${esc(t('palPlaceholder'))}" aria-label="${esc(t('palInputAria'))}"><kbd>Esc</kbd></label>
      <ol class="pal-list" id="palList" role="listbox" aria-label="${esc(t('palInputAria'))}"></ol>
      <p class="sr-only" data-pal="count" aria-live="polite"></p>
      <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> ${esc(t('palSelect'))}</span><span><kbd>Enter</kbd> ${esc(t('palOpen'))}</span><span><kbd>Ctrl</kbd>+<kbd>K</kbd> ${esc(t('palToggle'))}</span></div>
    </div>`;
  document.body.appendChild(root);
  const input = root.querySelector('input');
  const list = root.querySelector('.pal-list');
  const count = root.querySelector('[data-pal="count"]');
  let results = [];
  let sel = 0;
  // The element focused before the palette opened: focus returns to it on close; a drawer opened from the
  // palette also records it as its "opener" (focus goes there when the drawer closes). Otherwise the "Search" button.
  let prevFocus = null;

  function items() {
    const out = [];
    for (const p of store.projects.values()) {
      out.push({ type: 'project', id: p.id, label: p.name, sub: t('palProjectSub', { state: p.busy ? t('cmnWorking') : p.live ? t('cmnWaiting') : p.lastActivity ? ago(p.lastActivity) : t('cmnQuiet') }), hay: lower(`${p.name} ${p.path || ''} ${p.description || ''}`), color: projectColor(p.id), icon: 'folder', boost: (p.live ? 3 : 0) + (p.busy ? 2 : 0) });
    }
    for (const s of store.sessions.values()) {
      const p = store.projects.get(s.projectId);
      out.push({ type: 'session', id: s.id, label: store.sessionLabel(s), sub: t('palSessionSub', { project: p?.name || '', id: String(s.id).slice(0, 8), state: s.live ? (s.live.status === 'busy' ? t('cmnWorking') : t('cmnWaiting')) : ago(s.lastAt) }), hay: lower(`${store.sessionLabel(s)} ${s.firstPrompt || ''} ${p?.name || ''} ${s.id}`), color: projectColor(s.projectId), icon: 'prompt', boost: s.live ? 2 : 0, t: s.lastAt });
    }
    for (const a of store.agents.values()) {
      if (a.workflowRunId && a.status !== 'running') continue;
      const p = store.projects.get(a.projectId);
      out.push({ type: 'agent', id: a.id, label: a.label || a.type, sub: `${a.type} · ${p?.name || ''} · ${(STATUS[a.status] || {}).l || a.status}`, hay: lower(`${a.label} ${a.type} ${p?.name || ''}`), color: agentColor(a.type), icon: 'agent', boost: a.status === 'running' ? 2 : 0, t: a.lastAt });
    }
    for (const r of store.roster) {
      out.push({ type: 'roster', id: r.id, label: r.name, sub: `${r.kind === 'agent' ? t('palKindAgent') : r.kind === 'plugin' ? t('palKindPlugin') : r.kind} · ${sourceLabel(r.source)}${r.usage ? t('palCalls', { n: r.usage.count }) : ''}`, hay: lower(`${r.name} ${r.description || ''} ${r.category || ''}`), color: r.kind === 'agent' ? agentColor(r.name) : '#ffd66b', icon: r.kind === 'agent' ? 'users' : r.kind === 'plugin' ? 'plugin' : 'skill', boost: r.usage ? 1 : 0, t: r.usage?.lastAt || 0 });
    }
    for (const c of commands) {
      // A command that matches comes before the skills and agents whose descriptions share a word (2026-10-02: "iş
      // ver" listed finish-branch first)
      out.push({ type: 'command', id: c.id, label: c.label, sub: c.sub, hay: lower(`${c.label} ${c.hay || ''}`), color: '#7c9cff', icon: 'spark', boost: 3, run: c.run });
    }
    return out;
  }

  function search(q) {
    const terms = lower(q).split(/\s+/).filter(Boolean);
    let all = items();
    if (!terms.length) {
      // When empty: what is live right now and the latest activity
      return all.filter((x) => x.boost >= 2 || x.type === 'project').sort((a, b) => b.boost - a.boost || (b.t || 0) - (a.t || 0)).slice(0, LIMIT);
    }
    all = all.filter((x) => terms.every((w) => x.hay.includes(w)));
    const first = terms[0];
    const score = (x) => {
      const l = lower(x.label);
      return (l.startsWith(first) ? 10 : wordStart(l, first) ? 7 : l.includes(first) ? 2 : 0) + x.boost + (x.type === 'project' ? 2 : 0);
    };
    return all.sort((a, b) => score(b) - score(a) || (b.t || 0) - (a.t || 0)).slice(0, LIMIT);
  }

  const typeLabel = (type) => t('palType_' + type);
  function render() {
    results = search(input.value);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    list.innerHTML = results.length
      ? results
          .map(
            (r, i) => `<li role="option" id="palOpt${i}" aria-selected="${i === sel}" class="${i === sel ? 'on' : ''}" data-i="${i}" style="--c:${r.color}"><span class="pal-ic">${icon(r.icon)}</span><span class="pal-main"><b>${esc(r.label)}</b><span>${esc(r.sub)}</span></span><em>${typeLabel(r.type)}</em></li>`,
          )
          .join('')
      : `<li class="pal-empty">${esc(t('palEmpty'))}</li>`;
    list.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
    // The active option for a screen reader (the visual one is .on), and how many there are
    if (results.length) input.setAttribute('aria-activedescendant', `palOpt${sel}`);
    else input.removeAttribute('aria-activedescendant');
    const said = results.length ? t('palCount', { count: results.length }) : t('palEmpty');
    if (count.textContent !== said) count.textContent = said;
  }

  function choose(i) {
    const r = results[i];
    if (!r) return;
    hide();
    if (r.run) {
      beforeRun();
      return r.run();
    }
    open({ type: r.type, id: r.id });
  }

  function show(q = '') {
    if (root.hidden) {
      const a = document.activeElement;
      prevFocus = a && a !== document.body && !root.contains(a) ? a : document.getElementById('paletteBtn');
    }
    root.hidden = false;
    input.value = q;
    sel = 0;
    render();
    input.focus();
  }
  function hide() {
    if (root.hidden) return;
    root.hidden = true;
    const back = prevFocus;
    prevFocus = null;
    if (focusableVisible(back)) back.focus({ preventScroll: true });
  }

  input.addEventListener('input', () => {
    sel = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      sel = Math.min(results.length - 1, sel + 1);
      render();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      sel = Math.max(0, sel - 1);
      render();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      choose(sel);
      e.preventDefault();
    }
  });
  // The whole dialog, wherever the keyboard is in it: Escape closes it (focus back to where it was), Tab and
  // Shift+Tab stay in it (its one control is the input: the page behind is not reached; review U01)
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hide();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      input.focus();
    }
  });
  // Focus that leaves the dialog some other way (a click outside closes it already) comes back to the input
  root.addEventListener('focusout', (e) => {
    if (!root.hidden && e.relatedTarget && !root.contains(e.relatedTarget)) input.focus();
  });
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('[data-i]');
    if (li && Number(li.dataset.i) !== sel) {
      sel = Number(li.dataset.i);
      for (const x of list.children) {
        x.classList.toggle('on', x === li);
        if (x.hasAttribute('aria-selected')) x.setAttribute('aria-selected', String(x === li));
      }
      input.setAttribute('aria-activedescendant', li.id);
    }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) choose(Number(li.dataset.i));
  });
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) hide();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (root.hidden) show();
      else hide();
    }
  });

  return { show, hide, isOpen: () => !root.hidden };
}
