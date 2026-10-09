// @ts-check
// "This job's result" in the project drawer (docs/comprehensive-roadmap-tr-2026-10-07.md package 3): once a job reached
// its result (finish) or was accepted (done), what was asked, what changed since the job's own start copy, what was
// checked and by whom, how to open it and whether going back is there, in one place. Three kinds of evidence stay
// apart: the AI reviewer's own report, what SiberSentez itself ran (nothing yet) and the person's acceptance.
// jobResultHtml is pure (tested in node); createJobResult keeps the answers of GET /api/projects/<id>/job-changes.
import { esc } from './format.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { startPointText } from './restore.js';

export const RESULT_STEPS = Object.freeze(['finish', 'done']);
const NAMES_SHOWN = 8;
const BASES = new Set(['no-record', 'no-copy', 'gone', 'unreadable']);

async function fetchJobChanges(projectId, jobId) {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/job-changes?job=${encodeURIComponent(jobId)}`, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// What changed, in words and a short list (pure); null: still asked
function changesHtml(c) {
  if (!c) return `<p class="small muted">${esc(t('jrLoading'))}</p>`;
  if (c.basis !== 'start') return `<p class="small">${esc(t(BASES.has(c.basis) ? `jrBasis_${c.basis}` : 'jrBasis_unreadable'))}</p>`;
  const lines = [];
  const unknownCount = c.counts?.unknown ?? (Array.isArray(c.unknown) ? c.unknown.length : 0);
  // Nothing changed among the files that could be read: never "nothing changed" while some could not be (Z1)
  if (!c.total) lines.push(`<p class="small">${esc(t(unknownCount ? 'jrNoChangesRead' : 'jrNoChanges'))}</p>`);
  else {
    // The whole counts (the server cuts the names at its maximum)
    const n = c.counts || { changed: c.changed.length, added: c.added.length, deleted: c.deleted.length };
    lines.push(`<p class="small">${esc(t('jrChanges', n))}</p>`);
    const all = [...c.changed.map((f) => ['changed', f]), ...c.added.map((f) => ['added', f]), ...c.deleted.map((f) => ['deleted', f])];
    const shown = all.slice(0, NAMES_SHOWN).map(([kind, f]) => `<li class="jr-${kind}"><code translate="no" title="${esc(f)}">${esc(f)}</code></li>`).join('');
    const rest = c.total - Math.min(all.length, NAMES_SHOWN);
    lines.push(`<ul class="jr-files">${shown}${rest > 0 ? `<li class="muted">${esc(t('jrMore', { count: rest }))}</li>` : ''}</ul>`);
  }
  if (unknownCount) lines.push(`<p class="small">${esc(t('jrUnknown', { count: unknownCount }))}</p>`);
  if (c.notes > 0) lines.push(`<p class="small muted">${esc(t(c.total ? 'jrNotes' : 'jrNotesOnly'))}</p>`);
  if (c.scope === 'lean' && c.leftOut > 0) lines.push(`<p class="small muted">${esc(t('jrLean', { count: c.leftOut }))}</p>`);
  lines.push(`<p class="small muted">${esc(t('jrBasis'))}</p>`);
  return lines.join('');
}

// The way to answer a result that waits (review U08): the job's own AI session (its terminal tab, or the session going
// on where it stopped: main.js open-ai-terminal), never "the lead's terminal" the person has to find (pure)
function tipsHtml(tips) {
  const list = (Array.isArray(tips) ? tips : []).filter((k) => k === 'short' || k === 'many');
  return list.length ? `<div class="jr-tips"><p class="small"><b>${esc(t('jrTipsTitle'))}</b></p><ul>${list.map((k) => `<li class="small">${esc(t(`jrTip_${k}`))}</li>`).join('')}</ul></div>` : '';
}

function goHtml(go) {
  if (!go) return '';
  if (go.session === null && !go.tab) return `<p class="small">${esc(t('jrNoSession'))}</p>`;
  const stopped = go.stopped ? `<p class="small job-now">${esc(t('wsJobStopped'))}</p>` : '';
  return `${stopped}<div class="jr-go"><button type="button" class="act-btn" data-job-act="open-ai"${go.session ? ` data-job-session="${esc(go.session)}"` : ''} data-fk="job:open-ai">${icon('prompt')}<span>${esc(t('jrGoAi'))}</span></button></div>`;
}

// The result's four ways, in one row while it waits (review B3, UX plan §6.4): open it (the run section's own way),
// ask for a change and accept it (a draft into the AI's tab, never with Enter: the AI waits for the person's answer
// there), go back to before the job (the preview of its start copy, like any restore point). Open leads. Pure.
// back: { mode, busy } of the restore section (review B/C): with actions off the button asks to turn them on, as the
// section's own buttons do; while a restore runs it is disabled
export function resultActsHtml(point = null, { mode = 'live', busy = false } = {}) {
  const dis = (mode === 'dry' || mode === 'live' ? '' : ' aria-disabled="true"') + (busy ? ' disabled' : '');
  const back = point && typeof point.id === 'string' && point.available !== false ? `<button type="button" class="act-btn" data-rst-act="preview" data-rst-id="${esc(point.id)}" data-fk="jr:back"${dis}>${icon('replay')}<span>${esc(t('jrActBack'))}</span></button>` : '';
  return `<div class="jr-acts" role="group" aria-label="${esc(t('jrActsLabel'))}"><button type="button" class="act-btn primary" data-jr-act="open" data-fk="jr:open">${icon('play')}<span>${esc(t('jrActOpen'))}</span></button><button type="button" class="act-btn" data-jr-act="change" data-fk="jr:change">${icon('spark')}<span>${esc(t('jrActChange'))}</span></button><button type="button" class="act-btn" data-jr-act="accept" data-fk="jr:accept">${icon('check')}<span>${esc(t('jrActAccept'))}</span></button><button type="button" class="act-btn" data-jr-act="explain" data-fk="jr:explain">${icon('prompt')}<span>${esc(t('jrActExplain'))}</span></button>${back}</div><p class="small muted jr-acts-note">${esc(t('jrActsNote'))}</p>`;
}

// team: the /team answer (step, plan, review); changes: the /job-changes answer or null; point: the job's start
// point as the job box knows it (restore.js startPointOf) or null. '' before the result.
// steps: the job's steps (job.js stepsHtml), shown here when the result comes first in the drawer (review U07); go:
// { session: the job's session id or null, tab: an AI tab of the project runs, stopped: its AI no longer runs } while
// the result waits (finish)
// A tip for the next job, from the person's own words (plan C4; the job's start copy keeps its first 80 characters):
// 'short' when it says too little to go on, 'many' when it puts several jobs into one. At most two keys. Pure.
// Joining words as whole words in any alphabet (review B/C: \b took "güve" and "düve" for "ve"); commas count only
// beside a joining word ("add a menu, a form and colours"), so a list of adjectives ("a blue, big, round button") is
// one job
const JOIN_RE = /(?<![\p{L}\p{N}])(ve|ayrıca|sonra da|and|also|then)(?![\p{L}\p{N}])/giu;
export function jobTips(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return [];
  const words = s.split(/\s+/).filter(Boolean).length;
  const conj = (s.match(JOIN_RE) || []).length;
  const joins = conj + (conj > 0 ? (s.match(/[,;]/g) || []).length : 0);
  const tips = [];
  if (words < 6) tips.push('short');
  if (words >= 8 && joins >= 2) tips.push('many');
  return tips.slice(0, 2);
}

// cost: this job's usage in a line (jobCost.js jobCostText); '' says nothing
// tips: jobTips keys for "next time" (plan C4)
export function jobResultHtml({ team = null, changes = null, point = null, steps = '', go = null, cost = '', tips = [], back: backOpts = {} } = {}) {
  if (!team || !RESULT_STEPS.includes(team.step)) return '';
  const asked = team.plan?.title ? `<p class="small"><b>${esc(t('jrAsked'))}</b> ${esc(team.plan.title)}</p>` : '';
  const verdict = team.review?.verdict;
  const review = verdict === 'APPROVE' ? t('jrReviewApproved') : verdict === 'REVISE' ? t('jrReviewRevise') : t('jrReviewNone');
  const checks = `<p class="small"><b>${esc(t('jrChecks'))}</b></p><ul class="jr-checks"><li>${esc(review)}</li><li>${esc(t('jrNotRun'))}</li><li>${esc(team.step === 'done' ? t('jrAccepted') : t('jrNotAccepted'))}</li></ul>`;
  const back = startPointText(point);
  return `<section class="dr-sec job-result" data-sec="result" aria-labelledby="jrH"><h3 id="jrH">${icon('check')} ${esc(t('jrTitle'))}</h3>${steps}${asked}${changesHtml(changes)}${cost ? `<p class="small muted jr-cost">${esc(cost)}</p>` : ''}${team.step === 'finish' ? resultActsHtml(point, backOpts) : ''}${checks}${team.step === 'finish' ? goHtml(go) : ''}${tipsHtml(tips)}<p class="small">${esc(t('jrOpen'))}</p>${back ? `<p class="small"><b>${esc(t('jrBack'))}</b> ${esc(back)}</p>` : ''}</section>`;
}

// The answers per project and job: asked again after ttl (files change while the person tries the result)
export function createJobResult({ fetchJson = fetchJobChanges, onData = (_projectId) => {}, now = () => Date.now(), ttl = 20000 } = {}) {
  const cache = new Map();
  function get(projectId, jobId) {
    if (typeof projectId !== 'string' || !projectId || !/^J[0-9a-f]{32}$/.test(jobId || '')) return null;
    const k = `${projectId}|${jobId}`;
    const e = cache.get(k);
    if (e && (e.pending || now() - e.at < ttl)) return e.data;
    cache.set(k, { at: e?.at || 0, data: e?.data || null, pending: true });
    Promise.resolve()
      .then(() => fetchJson(projectId, jobId))
      .then(
        (data) => cache.set(k, { at: now(), data, pending: false }),
        () => cache.set(k, { at: now(), data: e?.data || { basis: 'unreadable' }, pending: false }),
      )
      .then(() => {
        try {
          onData(projectId);
        } catch (err) {
          console.error(err);
        }
      });
    return e?.data || null;
  }
  return {
    get,
    // opts: { steps, go } as jobResultHtml takes them
    html(p, team, point, opts = {}) {
      if (!team || !RESULT_STEPS.includes(team.step)) return '';
      // A job from before job ids has no start copy of its own
      const changes = team.plan?.jobId ? get(p.id, team.plan.jobId) : { basis: 'no-record' };
      return jobResultHtml({ team, changes, point, ...opts });
    },
  };
}
