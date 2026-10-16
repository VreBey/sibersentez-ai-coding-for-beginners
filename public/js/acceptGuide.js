// @ts-check
// A beginner's acceptance guide (docs/internal/acceptance-guide-plan.md; independent review of 0.18.0 §11): before
// accepting a job's result, the person tries the plan's "Done when" items (server/team.mjs parsePlan doneWhen: the
// kit's planner writes things that can be run or seen) and marks each "Works" or "Not as asked". The marks are the
// person's own record: never a test, never shown as the app's check, never sent to the AI unless the person sends a
// change. Since the independent review of 0.19.0 (§8, §11) the app keeps them in the hub's record of the job
// (server/jobResults.mjs writeTried, the accept-marks action, actions On) with the items the person saw, when they
// last marked and the files' quick fingerprint then; with actions not On they stay in this window only. Items are
// keyed by a hash of their text, so a plan edited later carries no mark onto another item. A "Not as asked" item can
// go to the AI as a draft (never Enter), as the result card's other drafts.
import { t } from './i18n.js';
import { esc, dayTime } from './format.js';
import { icon } from './icons.js';
import { AI_DRAFT_MAX } from './dockState.js';

const STORE_KEY = 'sibersentez.accept';
// A short key for an item's text (FNV-1a, 32 bits, hex): the same text, the same key
export function itemKey(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text || '')) {
    h ^= ch.codePointAt(0) || 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// The items to try: the plan's Done-when list, else one general item (open the result, try what was asked)
export function guideItems(team) {
  const list = Array.isArray(team?.plan?.doneWhen) ? team.plan.doneWhen.filter((x) => typeof x === 'string' && x.trim()) : [];
  const texts = list.length ? list : [t('agGeneral')];
  return texts.map((text) => ({ key: itemKey(text), text, general: !list.length }));
}

// ---------- the marks ----------

const KEY_RE = /^[0-9a-f]{8}$/;
const SEND_AFTER_MS = 400;
const RETRY_MS = 3200;

// Marks kept in this browser's storage per project and Job-ID: by an earlier version, and while actions are not On
// (the hub is written only by the accept-marks action). Moved into the hub once actions are On and the record holds
// none, then removed here. { [itemKey]: 'ok' | 'no' }; {} when none (or storage is not there)
// Jobs whose marks this browser keeps, the newest last (an older job's marks leave first)
export const JOBS_KEPT = 30;
function readAll(storage) {
  try {
    const v = JSON.parse(storage?.getItem(STORE_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
export function legacyMarks(projectId, jobId, storage = globalThis.localStorage) {
  if (!projectId || !jobId) return {};
  const m = readAll(storage)[`${projectId}|${jobId}`];
  const out = {};
  if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) if (KEY_RE.test(k) && (v === 'ok' || v === 'no')) out[k] = v;
  return out;
}
// The job's whole set in this browser (an empty set removes it); never throws
function writeLocal(projectId, jobId, marks, storage) {
  try {
    const all = readAll(storage);
    const id = `${projectId}|${jobId}`;
    delete all[id];
    if (Object.keys(marks).length) all[id] = marks;
    const ids = Object.keys(all);
    for (const old of ids.slice(0, Math.max(0, ids.length - JOBS_KEPT))) delete all[old];
    if (Object.keys(all).length) storage.setItem(STORE_KEY, JSON.stringify(all));
    else storage.removeItem?.(STORE_KEY);
    return true;
  } catch {
    return false;
  }
}

// The marks of the jobs on screen. send(body): the action client (actions.js runAction); mode(): the actions mode;
// onChange(projectId): redraw. view() says which marks to show and where they are kept:
//   hub      kept in the hub's record (at: the last mark the app kept)
//   saving   sent, no answer yet
//   window   actions are not On: kept in this browser only (not with the job)
//   failed   the hub refused or could not be reached: held in this window only
//   loading  the record is still asked (actions On): no mark is taken yet, so a click never overwrites marks the hub
//            holds with a set made from nothing
//   none     nothing marked
// tried: the record's part (the /job-result answer's record.tried): undefined while the record is still asked or its
// last look failed (the last one known stands in then), null when it holds none.
export function createMarks({ send, mode = () => 'off', onChange = (_projectId) => {}, storage = globalThis.localStorage, now = () => Date.now(), wait = (fn, ms) => setTimeout(fn, ms) }) {
  const held = new Map(); // `${projectId}|${jobId}` -> { marks, items, status, at, timer }
  const known = new Map(); // `${projectId}|${jobId}` -> the record's last known tried (null: none)
  const moved = new Set();
  const changed = (projectId) => {
    try {
      onChange(projectId);
    } catch (e) {
      console.error(e);
    }
  };
  async function flush(projectId, jobId, entry) {
    const k = `${projectId}|${jobId}`;
    entry.timer = null;
    // A newer mark replaced this set before it went out: only the newest is sent
    if (held.get(k) !== entry) return;
    let r;
    try {
      r = await send({ action: 'accept-marks', projectId, jobId, marks: entry.marks, itemKeys: entry.items });
    } catch {
      r = { ok: false, error: 'network' };
    }
    // A newer mark took over: its own answer decides
    if (held.get(k) !== entry || entry.timer) return;
    if (r?.ok && r.result?.executed) {
      entry.status = 'hub';
      entry.at = Number.isFinite(r.tried?.at) ? r.tried.at : now();
      writeLocal(projectId, jobId, {}, storage);
    } else if (r?.status === 429 || r?.busy) {
      // Sent again a moment later (the same set within the server's repeat guard, or one still on its way)
      entry.timer = wait(() => flush(projectId, jobId, entry), RETRY_MS);
      return;
    } else if (r?.ok) {
      // The mode changed to Preview meanwhile: kept in this browser
      entry.status = 'window';
      writeLocal(projectId, jobId, entry.marks, storage);
    } else entry.status = 'failed';
    changed(projectId);
  }
  function keep(projectId, jobId, entry) {
    held.set(`${projectId}|${jobId}`, entry);
    if (mode() !== 'live') {
      entry.status = 'window';
      writeLocal(projectId, jobId, entry.marks, storage);
      return;
    }
    entry.status = 'saving';
    entry.timer = wait(() => flush(projectId, jobId, entry), SEND_AFTER_MS);
  }
  // The record's tried as far as it is known: this answer's, else the last one known
  function base(k, tried) {
    if (tried !== undefined) {
      known.set(k, tried);
      return tried;
    }
    return known.has(k) ? known.get(k) : undefined;
  }
  function view(projectId, jobId, tried, items = []) {
    if (!projectId || !jobId) return { marks: {}, state: 'none', at: null };
    const k = `${projectId}|${jobId}`;
    const rec = base(k, tried);
    const h = held.get(k);
    if (h) return { marks: { ...h.marks }, state: Object.keys(h.marks).length || h.status !== 'hub' ? h.status : 'none', at: h.at || null };
    if (rec?.marks) return { marks: { ...rec.marks }, state: 'hub', at: rec.at || null };
    const live = mode() === 'live';
    const old = legacyMarks(projectId, jobId, storage);
    // Actions On and the record not known yet: nothing to build a set on
    if (live && rec === undefined) return { marks: old, state: 'loading', at: null };
    if (!Object.keys(old).length) return { marks: {}, state: 'none', at: null };
    // Marks kept in this browser: into the hub once the record is known to hold none (actions On)
    if (rec === null && live && !moved.has(k)) {
      moved.add(k);
      const shown = new Set(items.map((x) => x.key));
      const marks = Object.fromEntries(Object.entries(old).filter(([key]) => shown.has(key)));
      if (Object.keys(marks).length) {
        keep(projectId, jobId, { marks, items: [...shown], status: 'saving', at: null, timer: null });
        return view(projectId, jobId, tried, items);
      }
    }
    return { marks: old, state: 'window', at: null };
  }
  // Mark an item (value null clears it): the whole set goes to the hub a moment later (actions On), else into this
  // browser. Refused while the record is still asked (state loading)
  function mark(projectId, jobId, key, value, items, tried) {
    if (!projectId || !jobId || !KEY_RE.test(String(key))) return false;
    const shown = items.map((x) => x.key);
    if (!shown.includes(key)) return false;
    const v = view(projectId, jobId, tried, items);
    if (v.state === 'loading') return false;
    const marks = Object.fromEntries(Object.entries(v.marks).filter(([k]) => shown.includes(k)));
    if (value === 'ok' || value === 'no') marks[key] = value;
    else delete marks[key];
    keep(projectId, jobId, { marks, items: shown, status: 'saving', at: null, timer: null });
    return true;
  }
  return { view, mark };
}

// ---------- what the card shows ----------

// How many items were tried, and how many are left (pure)
export function guideCounts(items, marks) {
  const tried = items.filter((x) => marks[x.key]).length;
  return { tried, left: items.length - tried, no: items.filter((x) => marks[x.key] === 'no').length, total: items.length };
}

// The draft for "Ask for a change about these": the items marked "Not as asked", cut so the whole draft fits the AI
// tab's draft limit (dockState.js AI_DRAFT_MAX); '' when none is marked so
export function changeDraft(items, marks) {
  const no = items.filter((x) => marks[x.key] === 'no' && !x.general).map((x) => x.text);
  const general = items.some((x) => x.general && marks[x.key] === 'no');
  if (!no.length) return general ? t('agChangeGeneral') : '';
  // Measured as the draft check measures it (UTF-16 length), cut by whole characters
  const make = (list) => t('agChangeDraft', { items: list });
  const whole = no.join('; ');
  if (make(whole).length <= AI_DRAFT_MAX) return make(whole);
  const chars = Array.from(whole);
  while (chars.length && make(`${chars.join('').trimEnd()}…`).length > AI_DRAFT_MAX) chars.pop();
  return make(`${chars.join('').trimEnd()}…`);
}

// Where the marks are kept, in one line under the list (pure). info: createMarks view's { state, at }, and from the
// /job-result answer triedFresh ('changed': files were written after the last mark) and listChanged (the plan's list
// is not the one the marks were made on)
function keptHtml(info, hasMarks) {
  const state = info?.state || 'none';
  const lines = [];
  if (state === 'hub' && hasMarks) lines.push(t('agKeptHub', { time: info.at ? dayTime(info.at) : '' }));
  else if (state === 'saving') lines.push(t('agKeeping'));
  else if (state === 'loading') lines.push(t('agLoading'));
  else if (state === 'unread') lines.push(t('agUnread'));
  else if (state === 'window') lines.push(t('agKeptWindow'));
  else if (state === 'failed') lines.push(t('agKeptFailed'));
  else lines.push(t('agNote'));
  const warn = [];
  if (state === 'hub' && hasMarks && info?.triedFresh === 'changed') warn.push(t('agTriedChanged'));
  if (state === 'hub' && hasMarks && info?.listChanged) warn.push(t('agListChanged'));
  return `<p class="small muted ag-note">${esc(lines.join(' '))}</p>${warn.length ? `<p class="small ag-stale">${esc(warn.join(' '))}</p>` : ''}`;
}

// The guide (pure). team: the /team answer; marks: createMarks view's marks; info: see keptHtml. '' before the result
export function acceptGuideHtml(team, marks = {}, info = null) {
  if (!team || (team.step !== 'finish' && team.step !== 'done')) return '';
  const items = guideItems(team);
  const c = guideCounts(items, marks);
  // A plan from before job ids has no Job-ID to keep the marks under: the list without buttons
  const canMark = !!team.plan?.jobId;
  // The marks the hub keeps are still being read: the buttons wait (a click would build a set from nothing)
  const wait = canMark && (info?.state === 'loading' || info?.state === 'unread') ? ' disabled' : '';
  const rows = items
    .map((x) => {
      const m = marks[x.key] || '';
      const btn = (value, label, ic) => `<button type="button" class="chip chip-btn ag-${value}${m === value ? ' on' : ''}" data-ag="${value}" data-ag-key="${esc(x.key)}" aria-pressed="${m === value}"${wait} data-fk="ag:${value}:${esc(x.key)}">${icon(ic)}<span>${esc(label)}</span></button>`;
      // The buttons' group is named by the item's own text beside it (read once, not twice)
      const btns = canMark ? `<span class="ag-btns" role="group" aria-labelledby="agt-${esc(x.key)}">${btn('ok', t('agWorks'), 'check')}${btn('no', t('agNot'), 'close')}</span>` : '';
      return `<li class="ag-item${m ? ` ag-${m}` : ''}"><span class="ag-text" id="agt-${esc(x.key)}">${esc(x.text)}</span>${btns}</li>`;
    })
    .join('');
  const line = !canMark ? '' : c.tried === c.total && !c.no ? t('agAllOk') : t('agCount', { tried: c.tried, total: c.total });
  const left = canMark && team.step === 'finish' && c.left ? ` ${t('agLeft', { count: c.left })}` : '';
  const change = c.no ? `<button type="button" class="act-btn" data-ag-act="change" data-fk="ag:change">${icon('spark')}<span>${esc(t('agChange'))}</span></button>` : '';
  return `<div class="ag" role="group" aria-labelledby="agH"><p class="small"><b id="agH">${esc(t('agTitle'))}</b> <span class="ag-count" aria-live="polite">${esc(line + left)}</span></p><ul class="ag-list">${rows}</ul>${change}${canMark ? keptHtml(info, c.tried > 0) : `<p class="small muted ag-note">${esc(t('agNote'))}</p>`}</div>`;
}
