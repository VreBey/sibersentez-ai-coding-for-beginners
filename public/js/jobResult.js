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
function goHtml(go) {
  if (!go) return '';
  if (go.session === null && !go.tab) return `<p class="small">${esc(t('jrNoSession'))}</p>`;
  const stopped = go.stopped ? `<p class="small job-now">${esc(t('wsJobStopped'))}</p>` : '';
  return `${stopped}<div class="jr-go"><button type="button" class="act-btn primary" data-job-act="open-ai"${go.session ? ` data-job-session="${esc(go.session)}"` : ''} data-fk="job:open-ai">${icon('prompt')}<span>${esc(t('jrGoAi'))}</span></button></div>`;
}

// team: the /team answer (step, plan, review); changes: the /job-changes answer or null; point: the job's start
// point as the job box knows it (restore.js startPointOf) or null. '' before the result.
// steps: the job's steps (job.js stepsHtml), shown here when the result comes first in the drawer (review U07); go:
// { session: the job's session id or null, tab: an AI tab of the project runs, stopped: its AI no longer runs } while
// the result waits (finish)
export function jobResultHtml({ team = null, changes = null, point = null, steps = '', go = null } = {}) {
  if (!team || !RESULT_STEPS.includes(team.step)) return '';
  const asked = team.plan?.title ? `<p class="small"><b>${esc(t('jrAsked'))}</b> ${esc(team.plan.title)}</p>` : '';
  const verdict = team.review?.verdict;
  const review = verdict === 'APPROVE' ? t('jrReviewApproved') : verdict === 'REVISE' ? t('jrReviewRevise') : t('jrReviewNone');
  const checks = `<p class="small"><b>${esc(t('jrChecks'))}</b></p><ul class="jr-checks"><li>${esc(review)}</li><li>${esc(t('jrNotRun'))}</li><li>${esc(team.step === 'done' ? t('jrAccepted') : t('jrNotAccepted'))}</li></ul>`;
  const back = startPointText(point);
  return `<section class="dr-sec job-result" data-sec="result" aria-labelledby="jrH"><h3 id="jrH">${icon('check')} ${esc(t('jrTitle'))}</h3>${steps}${asked}${changesHtml(changes)}${checks}${team.step === 'finish' ? goHtml(go) : ''}<p class="small">${esc(t('jrOpen'))}</p>${back ? `<p class="small"><b>${esc(t('jrBack'))}</b> ${esc(back)}</p>` : ''}</section>`;
}

// The answers per project and job: asked again after ttl (files change while the person tries the result)
export function createJobResult({ fetchJson = fetchJobChanges, onData = () => {}, now = () => Date.now(), ttl = 20000 } = {}) {
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
