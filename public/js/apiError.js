// When the AI stops on an error (docs/attention.md): Claude Code wrote a limit, sign-in, connection or length error in
// place of an answer (server/apierror.mjs). The page says what happened and what to do, in the page's language.
// Pure (tested in node): which error of a project still counts, and its words.
import { esc } from './format.js';
import { t, language } from './i18n.js';

const KINDS = new Set(['limit-session', 'limit-week', 'login', 'org', 'connection', 'too-long', 'other']);
const HOUR = 3600000;
// An error counts for a day; a limit until an hour after it opened again (then the card says it opened)
const FRESH_MS = 24 * HOUR;
const AFTER_RESET_MS = HOUR;

// The error a session shows now, or null: a known kind, not older than a day, a limit not long past its reset
export function liveApiError(s, now = Date.now()) {
  const e = s?.apiError;
  if (!e || !KINDS.has(e.kind) || !Number.isFinite(e.t)) return null;
  if (now - e.t > FRESH_MS) return null;
  if (Number.isFinite(e.resetsAt) && now - e.resetsAt > AFTER_RESET_MS) return null;
  return e;
}

// The newest error among a project's sessions: { s, e } or null
export function projectApiError(sessions, projectId, now = Date.now()) {
  let best = null;
  for (const s of sessions) {
    if (s?.projectId !== projectId) continue;
    const e = liveApiError(s, now);
    if (e && (!best || e.t > best.e.t)) best = { s, e };
  }
  return best;
}

// A moment as the clock shows it: the time today, else the day and the time
function when(ms, now) {
  const d = new Date(ms);
  const loc = language() === 'tr' ? 'tr-TR' : 'en-GB';
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString(loc, { day: 'numeric', month: 'long' })} ${time}`;
}

// { title, body, tone: 'stop' | 'warn' } for an error that counts
export function apiErrorWords(e, now = Date.now()) {
  if (!e || !KINDS.has(e.kind)) return null;
  const k = e.kind;
  const title = t(`aeTitle_${k}`);
  if (k.startsWith('limit')) {
    const opened = Number.isFinite(e.resetsAt) && now >= e.resetsAt;
    const at = Number.isFinite(e.resetsAt) && !opened ? ` ${t('aeOpensAt', { time: when(e.resetsAt, now) })}` : '';
    return { title: opened ? t('aeOpened') : title, body: opened ? t('aeOpenedBody') : `${t(`aeBody_${k}`)}${at}`, tone: opened ? 'warn' : 'stop' };
  }
  const body = k === 'other' ? (e.text ? t('aeBody_other', { text: e.text }) : t('aeBody_otherNone')) : t(`aeBody_${k}`);
  return { title, body, tone: k === 'connection' ? 'warn' : 'stop' };
}

// The card (the drawer and the Building's job box)
export function apiErrorHtml(e, now = Date.now()) {
  const w = apiErrorWords(e, now);
  if (!w) return '';
  return `<div class="dr-missing ai-stop ${w.tone}" role="status" data-ai-error="${esc(e.kind)}"><b>${esc(w.title)}</b><p>${esc(w.body)}</p></div>`;
}
