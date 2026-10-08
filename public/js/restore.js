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
// answer's jobs) is asked for; startPointsVersion() changes when an answer changes what the box says.
// A record is history, not a promise (docs/development-plan-2026-10-07.md F2): whether the copy is still there is read
// from the project's points as last listed (here, or by the drawer's restore section), checked again every 30 s while
// the box shows it, and at once after something that changes the points (a start, going back).
const startPoints = new Map();
const pointIds = new Map(); // projectId -> { ids: Set of the points there, at }
let pointsVersion = 0;
export const startPointsVersion = () => pointsVersion;
export function rememberStartPoint(projectId, point, jobId = null) {
  if (typeof projectId === 'string' && projectId && point && typeof point === 'object') {
    startPoints.set(projectId, { point, jobId: typeof jobId === 'string' && jobId ? jobId : null });
    pointsVersion++;
  }
}
// Each change of a project's points (pointsChanged) starts a new generation: an answer asked for before the change
// (still on its way when a start took a new point) says nothing about now and is dropped
const gens = new Map(); // projectId -> generation
export const pointsGen = (projectId) => gens.get(projectId) || 0;
// The project's points as listed now (a /restore answer); gen: the generation the answer was asked in
export function notePoints(projectId, data, at = Date.now(), gen = pointsGen(projectId)) {
  if (typeof projectId !== 'string' || !projectId || !Array.isArray(data?.points) || gen !== pointsGen(projectId)) return;
  const ids = new Set(data.points.map((x) => x?.id).filter((id) => typeof id === 'string'));
  const was = pointIds.get(projectId);
  pointIds.set(projectId, { ids, at });
  if (!was || was.ids.size !== ids.size || [...ids].some((id) => !was.ids.has(id))) pointsVersion++;
}
// Something changed the project's points (a start, going back): the next look asks again
export function pointsChanged(projectId) {
  gens.set(projectId, pointsGen(projectId) + 1);
  tried.delete(projectId);
  if (pointIds.delete(projectId)) pointsVersion++;
}
// The start point of this job, with available: false when the newest list no longer holds it
export function startPointOf(projectId, jobId = null) {
  const x = startPoints.get(projectId);
  if (!x || !x.jobId || x.jobId !== jobId) return null;
  const known = pointIds.get(projectId);
  return typeof x.point.id === 'string' && known ? { ...x.point, available: known.ids.has(x.point.id) } : x.point;
}
const asked = new Map(); // project|job -> { at, n }: a job without a record is asked again after a while, a few times
// (a job started outside the app, or before 0.16, has none and never gets one)
const ASK_AGAIN_MS = 30000;
const ASK_MAX = 4;
export const POINTS_FRESH_MS = 30000;
const inflight = new Set();
const tried = new Map(); // projectId -> when its list was last asked for (answered or not)
// Called for the shown job on every frame: asks only when there is something to learn, at most every 30 s
export function askJobPoint(projectId, jobId, { fetchFn = fetchPoints, now = Date.now } = {}) {
  if (typeof projectId !== 'string' || !projectId || typeof jobId !== 'string' || !jobId || inflight.has(projectId)) return null;
  const known = startPointOf(projectId, jobId);
  if (known) {
    // A copy that could not be made has nothing to check; a kept one is checked again when its list is old. A failed
    // ask counts too (a restarting server, no network): asked again after the same 30 s, never on every frame
    if (typeof known.id !== 'string') return null;
    const last = Math.max(pointIds.get(projectId)?.at ?? -Infinity, tried.get(projectId) ?? -Infinity);
    if (now() - last < POINTS_FRESH_MS) return null;
    tried.set(projectId, now());
  } else {
    const key = `${projectId}|${jobId}`;
    const was = asked.get(key);
    if (was && (was.n >= ASK_MAX || now() - was.at < ASK_AGAIN_MS)) return null;
    asked.set(key, { at: now(), n: (was?.n || 0) + 1 });
  }
  inflight.add(projectId);
  const gen = pointsGen(projectId);
  return fetchFn(projectId)
    .then((data) => {
      notePoints(projectId, data, now(), gen);
      if (known) return true;
      const rec = (Array.isArray(data?.jobs) ? data.jobs : []).find((r) => r && r.jobId === jobId);
      if (!rec) return false;
      // The start of this very page (rememberStartPoint) answered meanwhile: it stays
      if (!startPointOf(projectId, jobId)) rememberStartPoint(projectId, rec, jobId);
      return true;
    })
    .catch(() => false)
    .finally(() => inflight.delete(projectId));
}
// One sentence (pure): a full copy, a lean one (how many big files and logs it left out), one no longer kept, or
// none and why
export function startPointText(point) {
  if (!point || typeof point !== 'object') return '';
  if (typeof point.problem === 'string') return t('rstStartNone');
  if (typeof point.id !== 'string') return '';
  if (point.available === false) return t('rstStartGone');
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
  return `${label ? `<p class="small rst-l">${esc(label)}</p>` : ''}<ul class="rst-names">${shown}${rest > 0 ? `<li class="muted">${esc(t('rstMore', { count: rest }))}</li>` : ''}</ul>`;
};

// The team's notes (the app's .sibersentez folder): told apart from the project's own files
const isNote = (n) => /^\.sibersentez\//i.test(String(n));
const KINDS = [['changed', 'rstChanged'], ['missing', 'rstMissing'], ['added', 'rstAdded']];

// What going back would do, in plain words: the project's own files in three short lists, the team's notes (plan,
// tasks, review) folded under one line (the server counts them apart, plan.notes; seen when using the app, 2026-10-08:
// style.css was one line among eleven notes). An older server without the counts: every file as before.
export function planHtml(plan) {
  const c = plan?.counts || {};
  const total = (c.changed || 0) + (c.missing || 0) + (c.added || 0);
  if (!total) return `<p class="small">${esc(t('rstNothing'))}</p>`;
  const split = !!plan.notes && typeof plan.notes === 'object';
  const noteOf = (key) => (split ? Math.max(0, Number(plan.notes[key]) || 0) : 0);
  const own = (key) => Math.max(0, (c[key] || 0) - noteOf(key));
  const names = (key) => (plan[key] || []).filter((n) => !split || !isNote(n));
  const lists = KINDS.map(([key, label]) => nameList(t(label, { count: own(key) }), names(key), own(key))).join('');
  const noteCount = KINDS.reduce((a, [key]) => a + noteOf(key), 0);
  const noteNames = split ? KINDS.flatMap(([key]) => (plan[key] || []).filter(isNote)) : [];
  const notes = noteCount ? `<details class="rst-notes"><summary class="small">${esc(t('rstNotes', { count: noteCount }))}</summary>${nameList('', noteNames, noteCount)}</details>` : '';
  const ownTotal = KINDS.reduce((a, [key]) => a + own(key), 0);
  return `<div class="rst-plan">${ownTotal ? lists : `<p class="small">${esc(t('rstOnlyNotes'))}</p>`}${notes}</div>`;
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
    // What stays as it is, said next to what changes (review U17): never in a copy, and a lean point's big files
    const pt = points.find((x) => x.id === ui.pointId);
    const lean = pt?.scope === 'lean' && Number(pt.leftOut) > 0 ? ` ${t('rstLean', { count: Number(pt.leftOut) })}.` : '';
    const untouched = any ? `<p class="small muted rst-untouched">${esc(t('rstUntouched') + lean)}</p>` : '';
    panel = `<div class="flow-confirm rst-confirm" role="group" aria-labelledby="rstQ"><p id="rstQ" class="small"><b>${esc(t('rstPlanTitle'))}</b> ${esc(note)}</p>${planHtml(ui.plan)}${untouched}<div class="flow-btns">${yes}<button type="button" class="act-btn" data-rst-act="no" data-fk="rst:no">${esc(t(any ? 'rstNo' : 'rstClose'))}</button></div></div>`;
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
    const gen = pointsGen(projectId);
    Promise.resolve()
      .then(() => fetchJson(projectId))
      .then(
        (data) => {
          cache.set(projectId, { at: now(), data, pending: false });
          // The job box reads the same list (is its start copy still there), unless the points changed meanwhile
          notePoints(projectId, data, now(), gen);
        },
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
      pointsChanged(projectId);
      return get(projectId);
    },
    ui: (projectId) => uis.get(projectId) || {},
    setUi: (projectId, v) => uis.set(projectId, v && STEPS.has(v.step) ? v : {}),
    html: (p, opts = {}) => (p?.path ? restoreSectionHtml(p, get(p.id).data, { ...opts, ui: uis.get(p.id) || {} }) : ''),
  };
}
