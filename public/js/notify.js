// @ts-check
// Notifications: when a session finishes its turn and starts waiting for you, or an agent or workflow finishes.
// In-page card (on by default), desktop notification (if permitted, only while the tab is in the background),
// optional soft sound. Turns that finish while the tab is not visible are counted in the title: "(2) waiting".
// Settings are kept in this browser only (localStorage).
import { store } from './store.js';
import { t, tOs } from './i18n.js';
import { esc, projectColor, agentColor, waitWhat } from './format.js';
import { icon } from './icons.js';
import { mountToast, dismissToast } from './toasts.js';
import { apiErrorWords, liveApiError } from './apiError.js';

const KEY = 'sibersentez.notify';
// In the desktop app the system notification is on by default (the shell grants it; docs/attention.md §4); in a
// browser it stays off until the person turns it on and the browser asks
const IN_APP = typeof window !== 'undefined' && typeof window.sibersentezShell === 'object' && window.sibersentezShell !== null;
const DEFAULTS = { toast: true, desktop: IN_APP, sound: false, agents: true };
const BASE_TITLE = 'SiberSentez';

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage may be disabled */
  }
}

export function createNotifier({ stackEl, buttonEl, menuEl, onOpen }) {
  let settings = loadSettings();
  const waiting = new Set(); // sessions whose turn finished while the tab was not visible
  let audio = null;

  // ---- settings menu ----
  const canDesktop = 'Notification' in window;
  function renderMenu() {
    const perm = canDesktop ? Notification.permission : 'unsupported';
    menuEl.innerHTML = `
      <h4>${icon('pulse')} ${esc(t('nfyTitle'))}</h4>
      <label><input type="checkbox" data-k="toast" ${settings.toast ? 'checked' : ''}><span>${esc(t('nfyToast'))}</span></label>
      <label><input type="checkbox" data-k="desktop" ${settings.desktop && perm === 'granted' ? 'checked' : ''} ${canDesktop && perm !== 'denied' ? '' : 'disabled'}><span>${esc(t('nfyDesktop'))} <small>${esc(t('nfyDesktopNote'))}</small></span></label>
      ${perm === 'denied' ? `<p class="muted small">${esc(tOs('nfyDenied'))}</p>` : ''}
      <label><input type="checkbox" data-k="sound" ${settings.sound ? 'checked' : ''}><span>${esc(t('nfySound'))}</span></label>
      <label><input type="checkbox" data-k="agents" ${settings.agents ? 'checked' : ''}><span>${esc(t('nfyAgents'))}</span></label>
      <p class="muted small">${esc(t('nfyAlways'))}</p>
      <button class="more" data-test>${esc(t('nfyTest'))}</button>`;
    buttonEl.classList.toggle('on', settings.toast || settings.desktop || settings.sound);
  }

  menuEl.addEventListener('change', async (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    settings[k] = e.target.checked;
    if (k === 'desktop' && settings.desktop && canDesktop && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') settings.desktop = false;
    }
    if (k === 'sound' && settings.sound) ensureAudio();
    saveSettings(settings);
    renderMenu();
  });
  menuEl.addEventListener('click', (e) => {
    if (!e.target.closest('[data-test]')) return;
    ensureAudio();
    show('turn', { title: t('nfyTestTitle'), body: t('nfyTestBody'), color: '#5ee39a', target: null, tag: 'test' }, true);
  });
  buttonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    menuEl.hidden = !menuEl.hidden;
    if (!menuEl.hidden) renderMenu();
  });
  document.addEventListener('click', (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target) && e.target !== buttonEl) menuEl.hidden = true;
  });

  // ---- title counter ----
  function updateTitle() {
    document.title = waiting.size ? t('nfyTitleWaiting', { n: waiting.size, base: BASE_TITLE }) : BASE_TITLE;
  }
  const seen = () => {
    if (document.hidden) return;
    waiting.clear();
    updateTitle();
  };
  document.addEventListener('visibilitychange', seen);
  window.addEventListener('focus', seen);

  // ---- sound: two short, soft notes (browser rule: it starts only after the first user gesture) ----
  function ensureAudio() {
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume();
    } catch {
      audio = null;
    }
  }
  function chime(kind) {
    if (!audio) return;
    const notes = kind === 'turn' ? [659.25, 880] : kind === 'workflow' ? [523.25, 659.25, 783.99] : [1046.5];
    const t0 = audio.currentTime + 0.02;
    notes.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const s = t0 + i * 0.13;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.06, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.6);
      o.connect(g).connect(audio.destination);
      o.start(s);
      o.stop(s + 0.65);
    });
  }

  // ---- display ----
  function show(kind, n, force = false) {
    if (settings.toast || force) toast(kind, n);
    if ((settings.desktop || force) && canDesktop && Notification.permission === 'granted' && (document.hidden || !document.hasFocus() || force)) {
      // hidden tab, or a window in the background (the desktop app behind another window)
      try {
        const nt = new Notification(n.title, { body: n.body, tag: n.tag, silent: true });
        nt.onclick = () => {
          window.focus();
          if (n.target) onOpen(n.target);
          nt.close();
        };
      } catch {
        /* in some environments the constructor is disabled */
      }
    }
    if (settings.sound || force) chime(kind);
  }

  function toast(kind, n) {
    const el = document.createElement('button');
    el.className = `toast k-${kind}`;
    el.style.setProperty('--c', n.color);
    el.innerHTML = `<span class="t-ic">${icon(kind === 'turn' ? 'prompt' : kind === 'workflow' ? 'workflow' : 'check')}</span><span class="t-body"><b>${esc(n.title)}</b><span>${esc(n.body || '')}</span></span>`;
    el.addEventListener('click', () => {
      if (n.target) onOpen(n.target);
      dismissToast(el);
    });
    // A stack shared with the action notifications: one upper limit, pausing on hover/focus, focus-safe removal
    mountToast(stackEl, el, { ms: kind === 'turn' ? 9000 : 6000 });
  }

  // Look at the new events that came with the patch
  function handle(events) {
    for (const e of events) {
      const p = store.projects.get(e.projectId);
      const pname = p?.name || t('nfyAProject');
      const asks = e.kind === 'live' && e.meta?.status === 'waiting';
      if (asks || (e.kind === 'live' && e.meta?.status === 'idle' && e.meta?.prev === 'busy')) {
        const s = store.sessions.get(e.sessionId);
        // waiting: the tool asks something (a permission, a question) and says what in live.waitingFor
        const what = asks ? waitWhat(s) : '';
        const why = what ? ` (${what})` : '';
        show('turn', { title: asks ? t('nfyAsks', { project: pname, why }) : t('nfyTurnDone', { project: pname }), body: store.sessionLabel(s), color: projectColor(e.projectId), target: { type: 'session', id: e.sessionId }, tag: 'turn-' + e.sessionId });
        if (document.hidden) {
          waiting.add(e.sessionId);
          updateTitle();
        }
      } else if (e.kind === 'live' && e.meta?.status === 'busy') {
        // A session that starts working again is no longer waiting
        if (waiting.delete(e.sessionId)) updateTitle();
      } else if (e.kind === 'agent_done' && settings.agents) {
        const id = String(e.actor || '').slice(2);
        show('agent', { title: t('nfyAgentDone', { project: pname, type: e.meta?.type || t('nfyAgentDefault') }), body: e.text, color: agentColor(e.meta?.type), target: { type: 'agent', id }, tag: 'agent-' + id });
      } else if (e.kind === 'ai_error') {
        // The AI stopped on an error (a limit, sign-in, the connection): what happened and what to do, as the person's
        // notice settings allow (no agent switch: it is about the person's own job)
        const s = store.sessions.get(e.sessionId);
        const w = apiErrorWords(liveApiError(s) || { kind: e.meta?.kind, t: e.t });
        if (w) show('turn', { title: `${pname}: ${w.title}`, body: w.body, color: projectColor(e.projectId), target: e.projectId ? { type: 'project', id: e.projectId } : null, tag: 'err-' + e.sessionId });
      } else if (e.kind === 'workflow_done') {
        show('workflow', { title: t('nfyWfDone', { project: pname }), body: e.text, color: '#3fe0cc', target: e.sessionId ? { type: 'session', id: e.sessionId } : null, tag: 'wf-' + e.id });
      }
    }
  }

  // A usage limit that opens again (apiError.js resetsAt): said once, when the time comes, so the person does not have to
  // watch the clock (2026-10-02). One that opened before this page looked is only remembered, never said.
  const opened = new Set();
  let firstLook = true;
  function checkLimits(now = Date.now()) {
    for (const s of store.sessions.values()) {
      const e = liveApiError(s, now);
      if (!e || !e.kind.startsWith('limit') || !Number.isFinite(e.resetsAt) || now < e.resetsAt) continue;
      const key = `${s.id}:${e.resetsAt}`;
      if (opened.has(key)) continue;
      opened.add(key);
      if (firstLook || now - e.resetsAt > 10 * 60000) continue;
      const p = store.projects.get(s.projectId);
      const w = apiErrorWords(e, now);
      show('turn', { title: `${p?.name || t('nfyAProject')}: ${w.title}`, body: w.body, color: projectColor(s.projectId), target: s.projectId ? { type: 'project', id: s.projectId } : null, tag: 'open-' + key });
    }
    firstLook = false;
  }
  setInterval(() => store.loaded && checkLimits(), 30000);

  renderMenu();
  updateTitle();
  return { handle, checkLimits };
}
