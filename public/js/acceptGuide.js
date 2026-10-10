// @ts-check
// A beginner's acceptance guide (docs/internal/acceptance-guide-plan.md; independent review of 0.18.0 §11): before
// accepting a job's result, the person tries the plan's "Done when" items (server/team.mjs parsePlan doneWhen: the
// kit's planner writes things that can be run or seen) and marks each "Works" or "Not as asked". The marks are the
// person's own notes, kept in this browser's storage per project and Job-ID: never a test, never sent anywhere, never
// shown as the app's check. Items are keyed by a hash of their text, so a plan edited later carries no mark onto
// another item. A "Not as asked" item can go to the AI as a draft (never Enter), as the result card's other drafts.
import { t } from './i18n.js';
import { esc } from './format.js';
import { icon } from './icons.js';
import { AI_DRAFT_MAX } from './dockState.js';

const STORE_KEY = 'sibersentez.accept';
// Jobs whose marks are kept, the newest last (an older job's marks leave first)
export const JOBS_KEPT = 30;

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

// ---------- the marks, in this browser's storage ----------

function readAll(storage) {
  try {
    const v = JSON.parse(storage?.getItem(STORE_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// { [itemKey]: 'ok' | 'no' } for one job; {} when none (or storage is not there)
export function readMarks(projectId, jobId, storage = globalThis.localStorage) {
  if (!projectId || !jobId) return {};
  const m = readAll(storage)[`${projectId}|${jobId}`];
  const out = {};
  if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) if (/^[0-9a-f]{8}$/.test(k) && (v === 'ok' || v === 'no')) out[k] = v;
  return out;
}

// Mark an item (value null clears it). The job moves to the end; at most JOBS_KEPT jobs are kept. Never throws.
export function writeMark(projectId, jobId, key, value, storage = globalThis.localStorage) {
  if (!projectId || !jobId || !/^[0-9a-f]{8}$/.test(String(key))) return false;
  try {
    const all = readAll(storage);
    const id = `${projectId}|${jobId}`;
    const marks = { ...readMarks(projectId, jobId, storage) };
    if (value === 'ok' || value === 'no') marks[key] = value;
    else delete marks[key];
    delete all[id];
    if (Object.keys(marks).length) all[id] = marks;
    const ids = Object.keys(all);
    for (const old of ids.slice(0, Math.max(0, ids.length - JOBS_KEPT))) delete all[old];
    storage.setItem(STORE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
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

// The guide (pure). team: the /team answer; marks: readMarks. '' before the result
export function acceptGuideHtml(team, marks = {}) {
  if (!team || (team.step !== 'finish' && team.step !== 'done')) return '';
  const items = guideItems(team);
  const c = guideCounts(items, marks);
  // A plan from before job ids has no Job-ID to keep the marks under: the list without buttons
  const canMark = !!team.plan?.jobId;
  const rows = items
    .map((x) => {
      const m = marks[x.key] || '';
      const btn = (value, label, ic) => `<button type="button" class="chip chip-btn ag-${value}${m === value ? ' on' : ''}" data-ag="${value}" data-ag-key="${esc(x.key)}" aria-pressed="${m === value}" data-fk="ag:${value}:${esc(x.key)}">${icon(ic)}<span>${esc(label)}</span></button>`;
      // The buttons' group is named by the item's own text beside it (read once, not twice)
      const btns = canMark ? `<span class="ag-btns" role="group" aria-labelledby="agt-${esc(x.key)}">${btn('ok', t('agWorks'), 'check')}${btn('no', t('agNot'), 'close')}</span>` : '';
      return `<li class="ag-item${m ? ` ag-${m}` : ''}"><span class="ag-text" id="agt-${esc(x.key)}">${esc(x.text)}</span>${btns}</li>`;
    })
    .join('');
  const line = !canMark ? '' : c.tried === c.total && !c.no ? t('agAllOk') : t('agCount', { tried: c.tried, total: c.total });
  const left = canMark && team.step === 'finish' && c.left ? ` ${t('agLeft', { count: c.left })}` : '';
  const change = c.no ? `<button type="button" class="act-btn" data-ag-act="change" data-fk="ag:change">${icon('spark')}<span>${esc(t('agChange'))}</span></button>` : '';
  return `<div class="ag" role="group" aria-labelledby="agH"><p class="small"><b id="agH">${esc(t('agTitle'))}</b> <span class="ag-count" aria-live="polite">${esc(line + left)}</span></p><ul class="ag-list">${rows}</ul>${change}<p class="small muted ag-note">${esc(t('agNote'))}</p></div>`;
}
