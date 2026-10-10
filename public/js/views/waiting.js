// @ts-check
// The header's "waiting for you" counter (docs/attention.md): how many open sessions finished their turn and wait for
// the person. One waiting session opens at once; several open a short list under the counter, the latest first.
import { store } from '../store.js';
import { waitingSessions } from '../attention.js';
import { esc, projectColor, agoTag, fillAgo, replaceHtml, waitWhat } from '../format.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { replay } from '../motion.js';

// The rows of the waiting sessions (the header's menu and Today's first block share them). A row of another AI tool's
// terminal tab that asks something (attention.js dockWaiting) brings that tab forward instead of a session's drawer.
function rowsHtml(waiting) {
  return waiting
    .map((s) => {
      const p = store.projects.get(s.projectId);
      if (s.dock) {
        const asks = s.kind ? t(`phTitle_${s.kind}`) : '';
        return `<button type="button" class="wait-row" data-dock-tab="${esc(s.tabId)}" style="--c:${projectColor(s.projectId)}">
          <span class="wr-proj"><i></i>${esc(p?.name || s.projectId || '')}</span>
          <span class="wr-title">${esc(t('attnDockRow', { name: s.title || s.tool }))}</span>
          ${asks && !asks.startsWith('phTitle_') ? `<span class="wr-asks">${esc(t('attnAsks', { what: asks }))}</span>` : ''}
          ${agoTag(s.live.since, 'time')}
        </button>`;
      }
      return `<button type="button" class="wait-row" data-session="${esc(s.id)}" style="--c:${projectColor(s.projectId)}">
          <span class="wr-proj"><i></i>${esc(p?.name || s.projectId || '')}</span>
          <span class="wr-title">${esc(store.sessionLabel(s))}</span>
          ${waitWhat(s) ? `<span class="wr-asks">${esc(t('attnAsks', { what: waitWhat(s) }))}</span>` : ''}
          ${agoTag(s.live.since, 'time')}
        </button>`;
    })
    .join('');
}

// todayEl (optional): Today's "Waiting for you" block, shown only while someone waits (docs/shell.md). showTab(tabId):
// brings an asking terminal tab forward (main.js: terminalDock showTab)
export function createWaitingMenu({ chipEl, menuEl, open = undefined, todayEl = null, showTab = (_tab) => false }) {
  let lastChip = '';
  let lastReport = '';
  let lastCount = null;

  const list = () => waitingSessions(store.sessions.values(), Date.now(), store.dockAsking?.() || []);
  const go = (w) => (w.dock ? showTab(w.tabId) : open({ type: 'session', id: w.id }));

  function render() {
    const waiting = list();
    const n = waiting.length;
    const html = n
      ? `<i class="sdot s-waiting"></i><b>${n === 1 ? esc(t('attnChipOne')) : esc(t('attnChip', { count: n }))}</b>`
      : `${icon('check')}<span>${esc(t('attnChipNone'))}</span>`;
    if (html !== lastChip) {
      lastChip = html;
      replaceHtml(chipEl, html);
    }
    chipEl.classList.toggle('on', n > 0);
    // One nudge when someone new starts waiting (not on the first render)
    if (lastCount !== null && n > lastCount) replay(chipEl, 'nudge');
    lastCount = n;
    chipEl.title = t('attnChipTip');
    // Its name when a narrow window shows only the icon (review U15)
    chipEl.setAttribute('aria-label', n ? (n === 1 ? t('attnChipOne') : t('attnChip', { count: n })) : t('attnChipNone'));
    // The desktop app shows the same count on the taskbar and in the tray (docs/attention.md §4); sent on change only
    const words = n ? (n === 1 ? t('attnChipOne') : t('attnChip', { count: n })) : '';
    const report = `${n}|${words}`;
    if (report !== lastReport && typeof window.sibersentezShell?.setAttention === 'function') {
      lastReport = report;
      window.sibersentezShell.setAttention(Math.min(n, 999), words.slice(0, 80));
    }
    if (!menuEl.hidden) renderMenu(waiting);
    renderToday(waiting);
  }

  let lastToday = '';
  function renderToday(waiting) {
    if (!todayEl) return;
    const html = waiting.length ? `<h2 class="tw-title"><i class="sdot s-waiting"></i>${esc(waiting.length === 1 ? t('attnChipOne') : t('attnChip', { count: waiting.length }))}</h2><p class="wait-hint">${esc(t('attnMenuHint'))}</p><div class="wait-rows">${rowsHtml(waiting)}</div>` : '';
    todayEl.hidden = !html;
    if (html === lastToday) return fillAgo(todayEl);
    lastToday = html;
    replaceHtml(todayEl, html);
    fillAgo(todayEl);
  }

  function renderMenu(waiting = list()) {
    const rows = rowsHtml(waiting);
    menuEl.innerHTML = `<h3 id="waitMenuTitle">${esc(t('attnMenuTitle'))}</h3>
      <p class="wait-hint">${esc(waiting.length ? t('attnMenuHint') : t('attnMenuEmpty'))}</p>
      ${rows ? `<div class="wait-rows">${rows}</div>` : ''}`;
    fillAgo(menuEl);
  }

  function setOpen(on) {
    menuEl.hidden = !on;
    chipEl.setAttribute('aria-expanded', String(on));
    if (on) {
      renderMenu();
      menuEl.querySelector('.wait-row')?.focus({ preventScroll: true });
    }
  }

  chipEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const waiting = list();
    if (waiting.length === 1 && menuEl.hidden) return go(waiting[0]);
    setOpen(menuEl.hidden);
  });
  menuEl.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-dock-tab]');
    if (tab) {
      setOpen(false);
      return void showTab(tab.dataset.dockTab);
    }
    const row = e.target.closest('[data-session]');
    if (!row) return;
    setOpen(false);
    open({ type: 'session', id: row.dataset.session });
  });
  todayEl?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-dock-tab]');
    if (tab) return void showTab(tab.dataset.dockTab);
    const row = e.target.closest('[data-session]');
    if (row) open({ type: 'session', id: row.dataset.session });
  });
  menuEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    setOpen(false);
    chipEl.focus();
  });
  document.addEventListener('click', (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target) && !chipEl.contains(e.target)) setOpen(false);
  });

  return { render, close: () => setOpen(false) };
}
