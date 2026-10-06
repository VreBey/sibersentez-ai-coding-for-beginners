// "Restore points" in the project drawer (docs/restore.md, docs/direction.md §3.4): the copies SiberSentez keeps before
// an AI tool starts, and going back to one. restoreSectionHtml is pure (tested in node); createRestore keeps the
// answers of GET /api/projects/<id>/restore (asked again after 15 s) and each project's step: the preview of one
// point (restore-preview, writes nothing), then the question, then the result of restore-apply.
import { esc, locale } from './format.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

// What the restore point of the last AI start holds, per project (the start-ai answer's restorePoint): the job box says
// it next to the job, so nobody counts on an undo that does not cover something. It belongs to the job that start
// began (its Job-ID): another job of the project never shows it.
// After a reload, or for a job started in another window, the server's record of the job's start (the /restore
// answer's jobs) is asked once per job; startPointsVersion() changes when one arrives, so the job box draws again.
const startPoints = new Map();
let pointsVersion = 0;
export const startPointsVersion = () => pointsVersion;
export function rememberStartPoint(projectId, point, jobId = null) {
  if (typeof projectId === 'string' && projectId && point && typeof point === 'object') {
    startPoints.set(projectId, { point, jobId: typeof jobId === 'string' && jobId ? jobId : null });
    pointsVersion++;
  }
}
export function startPointOf(projectId, jobId = null) {
  const x = startPoints.get(projectId);
  return x && x.jobId && x.jobId === jobId ? x.point : null;
}
const asked = new Map(); // project|job -> { at, n }: asked again after a while, a few times (a job started outside
// the app, or before 0.16, has no record and never gets one)
const ASK_AGAIN_MS = 30000;
const ASK_MAX = 4;
export function askJobPoint(projectId, jobId, { fetchFn = fetchPoints, now = Date.now } = {}) {
  if (typeof projectId !== 'string' || !projectId || typeof jobId !== 'string' || !jobId || startPointOf(projectId, jobId)) return null;
  const key = `${projectId}|${jobId}`;
  const was = asked.get(key);
  if (was && (was.n >= ASK_MAX || now() - was.at < ASK_AGAIN_MS)) return null;
  asked.set(key, { at: now(), n: (was?.n || 0) + 1 });
  return fetchFn(projectId)
    .then((data) => {
      const rec = (Array.isArray(data?.jobs) ? data.jobs : []).find((r) => r && r.jobId === jobId);
      if (!rec) return false;
      // The start of this very page (rememberStartPoint) answered meanwhile: it stays
      if (!startPointOf(projectId, jobId)) rememberStartPoint(projectId, rec, jobId);
      // A job with no record yet (its start is still copying) is asked again later; a found one never
      return true;
    })
    .catch(() => false);
}
// One sentence (pure): a full copy, a lean one (how many big files and logs it left out), or none and why
export function startPointText(point) {
  if (!point || typeof point !== 'object') return '';
  if (typeof point.problem === 'string') return t('rstStartNone');
  if (typeof point.id !== 'string') return '';
  const left = Number.isInteger(point.leftOut) ? point.leftOut : 0;
  return point.scope === 'lean' && left > 0 ? t('rstStartLean', { count: left }) : t('rstStartFull');
}

const REASONS = new Set(['ai-start', 'before-restore', 'manual']);
const STEPS = new Set(['', 'loading', 'confirm', 'busy', 'done', 'failed']);
const NAMES_SHOWN = 8;

async function fetchPoints(projectId) {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/restore`, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

const nameList = (label, names, count) => {
  if (!count) return '';
  const shown = names.slice(0, NAMES_SHOWN).map((n) => `<li><code translate="no" title="${esc(n)}">${esc(n)}</code></li>`).join('');
  const rest = count - Math.min(names.length, NAMES_SHOWN);
  return `<p class="small rst-l">${esc(label)}</p><ul class="rst-names">${shown}${rest > 0 ? `<li class="muted">${esc(t('rstMore', { count: rest }))}</li>` : ''}</ul>`;
};

// What going back would do, in plain words and three short lists (the preview's answer)
function planHtml(plan) {
  const c = plan?.counts || {};
  const total = (c.changed || 0) + (c.missing || 0) + (c.added || 0);
  if (!total) return `<p class="small">${esc(t('rstNothing'))}</p>`;
  const lists = [nameList(t('rstChanged', { count: c.changed || 0 }), plan.changed || [], c.changed || 0), nameList(t('rstMissing', { count: c.missing || 0 }), plan.missing || [], c.missing || 0), nameList(t('rstAdded', { count: c.added || 0 }), plan.added || [], c.added || 0)].join('');
  return `<div class="rst-plan">${lists}</div>`;
}

// The section (pure). p: the project; data: the /restore answer or null while it is asked; opts: { mode ('off' |
// 'dry' | 'live'), ui: { step, pointId, plan, result, error } }
export function restoreSectionHtml(p, data, { mode = 'off', ui = {} } = {}) {
  if (!p?.path || p.exists === false || p.broad || p.tmpOnly || p.kind === 'hub') return '';
  const head = `<h3 id="rstH">${icon('replay')} ${esc(t('rstTitle'))}</h3>`;
  const wrap = (inner) => `<section class="dr-sec rst" data-sec="restore" aria-labelledby="rstH">${head}${inner}</section>`;
  if (!data) return wrap(`<p class="muted small">${esc(t('rstLoading'))}</p>`);
  const points = (Array.isArray(data.points) ? data.points : []).filter((x) => x && typeof x.id === 'string');
  // Short, and what a copy never holds said in plain sight (it was on hover only, docs/development-review-2026-10-06.md §4)
  const intro = `<p class="muted small">${esc(t('rstIntro'))}</p><p class="muted small rst-never">${esc(t('rstIntroMore'))}</p>`;
  if (!points.length) return wrap(`${intro}<p class="small">${esc(t('rstNone'))}</p>`);
  const on = mode === 'dry' || mode === 'live';
  const dis = on ? '' : ' aria-disabled="true"';
  const step = STEPS.has(ui.step) ? ui.step : '';
  const busy = step === 'loading' || step === 'busy';
  const rows = points
    .map((x) => {
      const reason = REASONS.has(x.reason) ? x.reason : 'manual';
      // The clock, to the second: two points a moment apart must not read the same ("just now" twice)
      const when = Number.isFinite(x.at) && x.at > 0 ? new Date(x.at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      // A lean point (a big project, docs/restore.md §7) says how many big files and logs it left out
      const lean = x.scope === 'lean' && Number(x.leftOut) > 0 ? t('rstLean', { count: Number(x.leftOut) }) : '';
      // A point taken for a job says which one: going back undoes that job and what came after (2026-10-02)
      const label = typeof x.label === 'string' && x.label ? t('rstBeforeJob', { job: x.label.length >= 80 ? `${x.label}…` : x.label }) : t(`rstReason_${reason}`);
      const meta = [label, when, t('rstFiles', { count: Number(x.files) || 0 }), lean].filter(Boolean).join(' · ');
      const picked = ui.pointId === x.id;
      const btn = `<button type="button" class="act-btn" data-rst-act="preview" data-rst-id="${esc(x.id)}" data-fk="rst:${esc(x.id)}"${dis}${busy ? ' disabled' : ''}>${esc(t('rstGoBack'))}</button>`;
      return `<li class="rst-row${picked ? ' on' : ''}"><span class="rst-meta">${esc(meta)}</span>${btn}</li>`;
    })
    .join('');
  let panel = '';
  if (step === 'loading') panel = `<p class="small" role="status">${esc(t('rstLoadingPlan'))}</p>`;
  else if (step === 'busy') panel = `<p class="small" role="status">${esc(t('rstBusy'))}</p>`;
  else if (step === 'failed') panel = `<p class="small warn" role="status">${esc(ui.error || t('rstFailed'))}</p>`;
  else if (step === 'confirm' && ui.plan) {
    const c = ui.plan.counts || {};
    const any = (c.changed || 0) + (c.missing || 0) + (c.added || 0) > 0;
    // Preview: the plan is shown, going back needs actions on
    const yes = !any ? '' : mode === 'live' ? `<button type="button" class="act-btn primary" data-rst-act="yes" data-fk="rst:yes">${esc(t('rstYes'))}</button>` : '';
    const note = any ? (mode === 'live' ? t('rstAsk') : t('rstDryNote')) : '';
    panel = `<div class="flow-confirm rst-confirm" role="group" aria-labelledby="rstQ"><p id="rstQ" class="small"><b>${esc(t('rstPlanTitle'))}</b> ${esc(note)}</p>${planHtml(ui.plan)}<div class="flow-btns">${yes}<button type="button" class="act-btn" data-rst-act="no" data-fk="rst:no">${esc(t(any ? 'rstNo' : 'rstClose'))}</button></div></div>`;
  } else if (step === 'done' && ui.result) {
    const r = ui.result;
    const failed = Number(r.failed?.length) || 0;
    panel = `<p class="small ${failed ? 'warn' : 'ok'}" role="status">${esc(t('rstDone', { restored: Number(r.restored) || 0, removed: Number(r.removed) || 0 }))}${failed ? ` ${esc(t('rstDoneFailed', { count: failed }))}` : ''} ${esc(t('rstUndo'))}</p>`;
  }
  const why = on ? '' : `<p class="small muted">${esc(t('rstWhyOff'))}</p>`;
  return wrap(`${intro}<ul class="rst-list">${rows}</ul>${why}${panel}`);
}

// Answers and steps per project. onData(projectId): an answer arrived (the drawer redraws when that project is open)
export function createRestore({ fetchJson = fetchPoints, onData = () => {}, now = () => Date.now(), ttl = 15000 } = {}) {
  const cache = new Map();
  const uis = new Map();
  function get(projectId) {
    const e = cache.get(projectId);
    if (e && (e.pending || now() - e.at < ttl)) return e;
    const next = { at: e?.at || 0, data: e?.data || null, pending: true };
    cache.set(projectId, next);
    Promise.resolve()
      .then(() => fetchJson(projectId))
      .then(
        (data) => cache.set(projectId, { at: now(), data, pending: false }),
        () => cache.set(projectId, { at: now(), data: next.data || { points: [] }, pending: false }),
      )
      .then(() => {
        try {
          onData(projectId);
        } catch (err) {
          console.error(err);
        }
      });
    return next;
  }
  return {
    get,
    // Ask again at once (after going back: the point of the present is new)
    refresh(projectId) {
      cache.delete(projectId);
      return get(projectId);
    },
    ui: (projectId) => uis.get(projectId) || {},
    setUi: (projectId, v) => uis.set(projectId, v && STEPS.has(v.step) ? v : {}),
    html: (p, opts = {}) => (p?.path ? restoreSectionHtml(p, get(p.id).data, { ...opts, ui: uis.get(p.id) || {} }) : ''),
  };
}
