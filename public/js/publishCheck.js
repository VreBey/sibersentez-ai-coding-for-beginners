// @ts-check
// "Get ready to publish" (plan E1) in the project drawer: "Put it online" first asks the server what in the project
// should not go online (GET /api/projects/<id>/publish-check: keys, .env files, private keys, passwords in the code,
// identity numbers, phone numbers, e-mail addresses; read-only, no account), shows it, and then writes the AI's steps
// for GitHub Pages into the job box. SiberSentez publishes nothing itself and connects to no account: the AI does the
// steps with the person, who presses Start and approves each step.
import { esc } from './format.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

const KINDS = new Set(['key', 'env-file', 'key-file', 'password', 'tc-id', 'phone', 'email']);
const LEVELS = new Set(['danger', 'warn', 'info']);
const SHOWN = 10;
const FIX_FILES = 8;

async function fetchPublishCheck(projectId) {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/publish-check`, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// The findings the page shows: known kinds and levels only, a path and a line (pure)
export function publishFindings(data) {
  return (Array.isArray(data?.findings) ? data.findings : []).filter((f) => f && KINDS.has(f.kind) && LEVELS.has(f.level) && typeof f.file === 'string' && f.file.length <= 400);
}

// The job box text: the steps for GitHub Pages, and first the files to keep out when something serious was found
// A file name as the job text carries it (review E1: a name is the project's, it may hold line breaks or words meant
// for the AI): control characters and backquotes out, at most 120 characters, inside backquotes, so it reads as a name
export const jobFileName = (f) => {
  const s = Array.from(String(f).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/g, ' ').replace(/\s+/g, ' ').trim());
  return `\`${s.length > 120 ? s.slice(0, 119).join('') + '…' : s.join('')}\``;
};
export function publishJobText(data) {
  const serious = [...new Set(publishFindings(data).filter((f) => f.level !== 'info').map((f) => f.file))];
  const fix = serious.length ? ` ${t('pcJobFix', { files: serious.slice(0, FIX_FILES).map(jobFileName).join(', ') + (serious.length > FIX_FILES ? ', …' : '') })}` : '';
  const gap = publishIncomplete(data) ? ` ${t('pcJobIncomplete')}` : '';
  return `${t('pcJobText')}${fix}${gap}`;
}

// What the walk skipped, by reason (pure; review F04). An answer from before the reasons were counted has only its
// truncated flag.
const SKIP_REASONS = ['large', 'deep', 'unreadable'];
const skippedCount = (data, k) => Math.max(0, Math.floor(Number(data?.skipped?.[k]) || 0));
// The walk did not see every file (pure): then the page never says "nothing found"
export const publishIncomplete = (data) => data?.complete === false || data?.status === 'incomplete' || !!data?.truncated || SKIP_REASONS.some((k) => skippedCount(data, k) > 0);
// The folder itself could not be read (pure)
export const publishFailed = (data) => data?.ok === false || data?.status === 'failed';

// The section (pure). st: { step: 'loading' | 'done' | 'error', data } or null (not asked: nothing shown)
export function publishCheckHtml(p, st) {
  if (!st || !p?.path) return '';
  const head = `<h3 id="pcH">${icon('globe')} ${esc(t('pcTitle'))}</h3>`;
  const wrap = (inner) => `<section class="dr-sec pc" data-sec="publish" aria-labelledby="pcH">${head}${inner}</section>`;
  const close = `<button type="button" class="act-btn" data-pub-act="close">${esc(t('pcClose'))}</button>`;
  if (st.step === 'loading') return wrap(`<p class="small" role="status">${esc(t('pcLoading'))}</p>`);
  if (st.step === 'error' || publishFailed(st.data)) return wrap(`<p class="small warn" role="status">${esc(t('pcFailed'))}</p><div class="flow-btns"><button type="button" class="act-btn" data-pub-act="again">${esc(t('pcAgain'))}</button>${close}</div>`);
  const list = publishFindings(st.data);
  const serious = list.filter((f) => f.level !== 'info').length;
  // Review F04: "nothing found" only when every file was looked through; otherwise what was skipped, by reason
  const partial = publishIncomplete(st.data);
  const gapNote = `<p class="small warn"${serious ? '' : ' role="status"'}>${esc(t('pcIncomplete'))}</p>`;
  const head2 = serious ? `<p class="small warn" role="status">${esc(t('pcFound', { count: serious }))}</p>` : partial ? gapNote : `<p class="small ok" role="status">${icon('check')} ${esc(t(list.length ? 'pcOnlyInfo' : 'pcClean'))}</p>`;
  const reasons = SKIP_REASONS.filter((k) => skippedCount(st.data, k) > 0).map((k) => `<li>${esc(t(`pcSkipped_${k}`, { count: skippedCount(st.data, k) }))}</li>`).join('');
  const gap = partial ? `${serious ? gapNote : ''}${reasons ? `<ul class="small muted">${reasons}</ul>` : ''}` : '';
  const rows = list
    .slice(0, SHOWN)
    .map((f) => `<li class="pc-${f.level}"><span class="pc-kind">${esc(t(`pcKind_${f.kind}`))}</span> <code translate="no">${esc(f.file)}${Number(f.line) > 0 ? `:${Number(f.line)}` : ''}</code>${typeof f.sample === 'string' && f.sample ? ` <span class="muted small">${esc(f.sample)}</span>` : ''}</li>`)
    .join('');
  const hidden = list.length - SHOWN + (Number(st.data?.more) || 0);
  const more = hidden > 0 ? `<p class="small muted">${esc(t('pcMore', { count: hidden }))}</p>` : '';
  const cut = st.data?.truncated ? `<p class="small muted">${esc(t('pcTruncated'))}</p>` : '';
  const what = `<p class="small muted">${esc(t('pcWhat'))}</p>`;
  const btns = `<div class="flow-btns"><button type="button" class="act-btn primary" data-pub-act="write">${esc(t('pcWrite'))}</button><button type="button" class="act-btn" data-pub-act="again">${esc(t('pcAgain'))}</button>${close}</div>`;
  return wrap(`${head2}${rows ? `<ul class="pc-list">${rows}</ul>` : ''}${more}${gap}${cut}${what}${btns}`);
}

// The check per project: start(projectId) asks (again), get(projectId) the state, close(projectId) hides it.
// onData(projectId): an answer arrived (the drawer redraws when that project is open)
export function createPublishCheck({ fetchJson = fetchPublishCheck, onData = (_projectId) => {} } = {}) {
  const states = new Map();
  let seq = 0;
  function start(projectId) {
    const n = ++seq;
    states.set(projectId, { step: 'loading', data: null, n });
    Promise.resolve()
      .then(() => fetchJson(projectId))
      .then(
        (data) => states.get(projectId)?.n === n && states.set(projectId, { step: 'done', data, n }),
        () => states.get(projectId)?.n === n && states.set(projectId, { step: 'error', data: null, n }),
      )
      .then(() => onData(projectId));
  }
  return {
    start,
    get: (projectId) => states.get(projectId) || null,
    close: (projectId) => states.delete(projectId),
    html: (p) => publishCheckHtml(p, p ? states.get(p.id) || null : null),
  };
}
