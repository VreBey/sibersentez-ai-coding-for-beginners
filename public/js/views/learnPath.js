// @ts-check
// "Learn by doing" (plan C5): after the first ten minutes, five small jobs that teach working with an AI by doing it on a
// project of one's own: make a page, change how it looks, add a form, break something on purpose, and go back. Each
// step writes a sample job into the Building's job box (Start stays the person's) or, the last one, opens the project's
// restore points; the person ticks a step when it is done (kept in this browser). It goes away when all five are done
// or when it is hidden. learnModel and learnHtml are pure (tested in node); createLearnPath wires the buttons.
import { esc } from '../format.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const LEARN_KEY = 'sibersentez.learn';
export const LEARN_STEPS = Object.freeze(['page', 'look', 'form', 'break', 'back']);

// done: the ids ticked so far; ready: the first ten minutes are done (a tool, a project, a first AI session)
export function learnModel({ done = [], ready = false, hidden = false } = {}) {
  const set = new Set((Array.isArray(done) ? done : []).filter((x) => LEARN_STEPS.includes(x)));
  const steps = LEARN_STEPS.map((id) => ({ id, done: set.has(id) }));
  const next = steps.find((s) => !s.done)?.id || null;
  return { steps, next, show: ready && !hidden && next !== null };
}

export function learnHtml(m) {
  if (!m?.show) return '';
  const count = m.steps.filter((s) => s.done).length;
  const rows = m.steps
    .map((s) => {
      const act = s.id === 'back' ? `<button type="button" class="act-btn" data-lp="back">${icon('replay')}<span>${esc(t('lpBackGo'))}</span></button>` : `<button type="button" class="act-btn" data-lp="write" data-lp-step="${s.id}">${icon('spark')}<span>${esc(t('lpWrite'))}</span></button>`;
      const tick = `<button type="button" class="linkish" data-lp="tick" data-lp-step="${s.id}">${esc(t(s.done ? 'lpUndo' : 'lpDone'))}</button>`;
      return `<li class="lp-step${s.done ? ' done' : ''}${s.id === m.next ? ' now' : ''}"><div><b>${esc(t(`lp_${s.id}`))}</b><p class="small muted">${esc(t(`lp_${s.id}_why`))}</p></div><div class="lp-acts">${s.done ? '' : act}${tick}</div></li>`;
    })
    .join('');
  // Compact (the packaged QA, 2026-10-09: the whole list pushed the Building's next-step strip below the first screen):
  // one line with the next step and its buttons; every step, and what the card is, behind "All steps"
  const next = m.steps.find((s) => s.id === m.next);
  const nextAct = next.id === 'back' ? `<button type="button" class="act-btn" data-lp="back">${icon('replay')}<span>${esc(t('lpBackGo'))}</span></button>` : `<button type="button" class="act-btn" data-lp="write" data-lp-step="${next.id}">${icon('spark')}<span>${esc(t('lpWrite'))}</span></button>`;
  const nextTick = `<button type="button" class="linkish" data-lp="tick" data-lp-step="${next.id}">${esc(t('lpDone'))}</button>`;
  return `<section class="lp" aria-labelledby="lpH"><div class="lp-head"><h2 id="lpH">${esc(t('lpTitle'))}</h2><span class="small muted">${esc(t('lpCount', { count, total: m.steps.length }))}</span><span class="lp-next small"><b>${esc(t(`lp_${next.id}`))}</b> · ${esc(t(`lp_${next.id}_why`))}</span><span class="lp-acts">${nextAct}${nextTick}</span><button type="button" class="linkish" data-lp="hide">${esc(t('lpHide'))}</button></div><details class="lp-all"><summary class="small">${esc(t('lpAll'))}</summary><p class="small muted">${esc(t('lpIntro'))}</p><ol class="lp-steps">${rows}</ol></details></section>`;
}

const read = () => {
  try {
    const v = JSON.parse(localStorage.getItem(LEARN_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
const write = (v) => {
  try {
    localStorage.setItem(LEARN_KEY, JSON.stringify(v));
  } catch {
    /* kept for this window only */
  }
};

// actions: { ready() (the first ten minutes are done), write(text) (into the Building's job box), restore() (the shown
// project's restore points) }
export function createLearnPath(el, actions) {
  let state = read();
  let last = '';
  el.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-lp]');
    if (!b) return;
    const what = b.dataset.lp;
    const step = b.dataset.lpStep;
    if (what === 'hide') state = { ...state, hidden: true };
    else if (what === 'tick' && LEARN_STEPS.includes(step)) {
      const done = new Set(Array.isArray(state.done) ? state.done : []);
      if (done.has(step)) done.delete(step);
      else done.add(step);
      state = { ...state, done: [...done] };
    } else if (what === 'write' && LEARN_STEPS.includes(step)) return actions.write?.(t(`lp_${step}_job`));
    else if (what === 'back') return actions.restore?.();
    write(state);
    render();
    // The keyboard stays where it was (review B/C): on the same step's tick, or, the card gone, on the job box
    if (what === 'tick') el.querySelector(`[data-lp="tick"][data-lp-step="${step}"]`)?.focus();
    else if (what === 'hide') actions.afterHide?.();
  });
  function render() {
    const html = learnHtml(learnModel({ done: state.done, hidden: state.hidden === true, ready: !!actions.ready?.() }));
    if (html === last) return;
    last = html;
    el.hidden = !html;
    el.innerHTML = html;
  }
  return { render };
}
