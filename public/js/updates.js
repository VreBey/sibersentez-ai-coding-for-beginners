// "A new version is out" on the page (roadmap F3a, 2026-10-08): off unless the person turns it on in Settings; then
// the page asks its own server (GET /api/update, which asks GitHub at most once a day, server/update.mjs) when it
// starts. A newer version is told once per version (a notice) and shown in Settings with its release page's link.
// Nothing is downloaded or installed. The choice and the version told are kept in this browser.
import { t } from './i18n.js';
import { esc } from './format.js';

export const UPDATES_KEY = 'sibersentez.updates';
export const TOLD_KEY = 'sibersentez.updates.told';
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
// A GitHub release page (the server names this repository's only, server/update.mjs; no account name in the page)
const URL_RE = /^https:\/\/github\.com\/[\w.-]{1,40}\/[\w.-]{1,100}\/releases\/(?:latest|tag\/v?\d+\.\d+\.\d+[\w.-]{0,20})$/;

const store = {
  get(k) {
    try {
      return globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      globalThis.localStorage?.setItem(k, v);
    } catch {
      /* this page only */
    }
  },
};

export const updatesOn = () => store.get(UPDATES_KEY) === '1';

// The server's answer, cleaned (pure): only known words, versions and this repository's release page pass
export function cleanAnswer(a) {
  if (!a || typeof a !== 'object') return { ok: false, reason: 'network' };
  const current = typeof a.current === 'string' && VERSION_RE.test(a.current) ? a.current : null;
  if (a.ok !== true) return { ok: false, reason: typeof a.reason === 'string' && /^[a-z-]{1,24}$/.test(a.reason) ? a.reason : 'network', current };
  const latest = typeof a.latest === 'string' && VERSION_RE.test(a.latest) ? a.latest : null;
  if (!latest) return { ok: false, reason: 'no-release', current };
  return { ok: true, current, latest, newer: a.newer === true, url: typeof a.url === 'string' && URL_RE.test(a.url) ? a.url : null };
}

let state = { status: updatesOn() ? 'idle' : 'off', answer: null };
const listeners = new Set();
const set = (next) => {
  state = next;
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {
      /* one listener does not stop the others */
    }
  }
};
export const updatesState = () => state;
export function onUpdates(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Asks the server when the person turned it on; never otherwise. fetchImpl: tests pass their own.
export async function checkUpdates({ fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  if (!updatesOn()) return set({ status: 'off', answer: null });
  set({ status: 'checking', answer: state.answer });
  try {
    const res = await fetchImpl('/api/update', { cache: 'no-store', credentials: 'same-origin' });
    const a = cleanAnswer(await res.json());
    set({ status: a.ok ? 'ready' : 'error', answer: a });
  } catch {
    set({ status: 'error', answer: { ok: false, reason: 'network' } });
  }
  return state;
}

export function setUpdatesOn(on, opts) {
  store.set(UPDATES_KEY, on ? '1' : '0');
  return on ? checkUpdates(opts) : set({ status: 'off', answer: null });
}

// Whether a notice is due (pure but for the stored version): a newer version not told yet. markTold: remember it.
export const noticeDue = (s = state) => s.status === 'ready' && s.answer?.newer === true && store.get(TOLD_KEY) !== s.answer.latest;
export const markTold = (s = state) => s.answer?.latest && store.set(TOLD_KEY, s.answer.latest);

// The Settings row's text and link (pure)
export function updateRowHtml(s = state) {
  if (s.status === 'off') return `<span class="small muted">${esc(t('updOffText'))}</span>`;
  if (s.status === 'idle' || s.status === 'checking') return `<span class="small muted">${esc(t('updChecking'))}</span>`;
  const a = s.answer || {};
  if (!a.ok) return `<span class="small muted">${esc(t('updFailed'))}</span>`;
  if (!a.newer) return `<span class="small">${esc(t('updLatest', { version: a.current || a.latest }))}</span>`;
  const link = a.url ? ` <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(t('updOpen'))}</a>` : '';
  return `<span class="small"><b>${esc(t('updNewer', { latest: a.latest, current: a.current || '?' }))}</b>${link}</span>`;
}
