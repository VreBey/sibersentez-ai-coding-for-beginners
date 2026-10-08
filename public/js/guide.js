// First-run guide (docs/first-run.md): five short steps: what SiberSentez shows, the AI tool, idea to skills and start,
// the actions mode, and the help while the AI works. It opens by itself once (the seen version stays in this browser), and again from the header's
// "?" button, the "?" key or the
// command palette. The model part (steps, when to open, storage) touches no DOM and is tested in node.
import { t } from './i18n.js';
import { esc } from './format.js';
import { icon } from './icons.js';

export const GUIDE_KEY = 'sibersentez.guide';
// Raise this when the tour changes enough to be shown again to people who saw the old one
export const GUIDE_VERSION = 2;

// id -> string keys guide_<id>_title / guide_<id>_body; go = the step's button (guide_<id>_go), target = the element
// of the page the step points at (highlighted while the step is shown)
export const GUIDE_STEPS = Object.freeze(
  [
    // The welcome step offers the full tour on an example (tour.js)
    { id: 'welcome', icon: 'baton', go: 'tour' },
    { id: 'tools', icon: 'command', go: 'tools' },
    { id: 'idea', icon: 'skill', go: 'newProject', target: '#newProjectBtn' },
    { id: 'modes', icon: 'action', go: 'actions', target: '#actMode' },
    { id: 'work', icon: 'prompt' },
  ].map((s) => Object.freeze(s)),
);

// The words the app uses, each said plainly once (review U11): the guide's "What do these words mean?" opens them.
// gl_<id>_t is the word as the screens show it (the technical name in brackets), gl_<id>_d its meaning.
export const GLOSSARY = Object.freeze(['tool', 'project', 'job', 'plan', 'session', 'skill', 'agent', 'actions', 'restore', 'building']);

export function glossaryHtml() {
  const rows = GLOSSARY.map((id) => `<dt>${esc(t(`gl_${id}_t`))}</dt><dd>${esc(t(`gl_${id}_d`))}</dd>`).join('');
  return `<div class="guide-head"><span class="guide-ic">${icon('list')}</span><span class="guide-count">${esc(t('guideWordsCount', { n: GLOSSARY.length }))}</span>
      <button type="button" class="icon-btn guide-x" data-guide="close" aria-label="${esc(t('guideClose'))}">${icon('close')}</button></div>
    <h2 id="guideTitle">${esc(t('guideWordsTitle'))}</h2>
    <p id="guideBody">${esc(t('guideWordsIntro'))}</p>
    <dl class="guide-words-list">${rows}</dl>
    <div class="guide-foot"><div class="guide-nav"><button type="button" class="chip chip-btn guide-next" data-guide="words-back">${esc(t('guideWordsBack'))}</button></div></div>`;
}

export function clampStep(i) {
  const n = Number.isInteger(i) ? i : 0;
  return Math.min(GUIDE_STEPS.length - 1, Math.max(0, n));
}

// stored: the value under GUIDE_KEY; qa: the page is a QA snapshot; param: ?guide= (QA shows the guide only when asked)
// Since docs/direction.md §3.3 the guide never opens by itself: a first start met the tour on top of the "First 10
// minutes" list, two lessons at once. Today's start card and the menu open it; QA opens it with ?guide.
export function shouldAutoOpen({ stored = null, qa = false, param = null } = {}) {
  void stored;
  void qa;
  return param === '1' || /^step:\d+$/.test(param || '');
}

// ?guide=step:<n> opens at that step (QA screenshots); anything else starts at the first
export function startStep(param) {
  const m = /^step:(\d+)$/.exec(param || '');
  return m ? clampStep(Number(m[1])) : 0;
}

// A blocked storage (private window, site data off) throws: the guide then shows once per page load, never breaks it
export function readSeen(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(GUIDE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function markSeen(storage = globalThis.localStorage) {
  try {
    storage?.setItem(GUIDE_KEY, String(GUIDE_VERSION));
    return true;
  } catch {
    return false;
  }
}

// The step's markup; available(go) says whether this page can do the step's button (the actions panel needs the app)
export function stepHtml(i, { mode = 'off', available = () => true } = {}) {
  const s = GUIDE_STEPS[clampStep(i)];
  const last = i === GUIDE_STEPS.length - 1;
  const body = t(`guide_${s.id}_body`, { mode: t({ off: 'actionsModeOff', dry: 'actionsModeDry', live: 'actionsModeLive' }[mode] || 'actionsModeOff') });
  const go = s.go && available(s.go) ? `<button type="button" class="chip chip-btn guide-go" data-guide-go="${s.go}">${esc(t(`guide_${s.id}_go`))}</button>` : '';
  const dots = GUIDE_STEPS.map(
    (x, k) => `<button type="button" class="guide-dot${k === i ? ' on' : ''}" data-guide-step="${k}" aria-label="${esc(t('guideStep', { n: k + 1, total: GUIDE_STEPS.length }))}"${k === i ? ' aria-current="step"' : ''}></button>`,
  ).join('');
  return `<div class="guide-head"><span class="guide-ic">${icon(s.icon)}</span><span class="guide-count">${esc(t('guideStep', { n: i + 1, total: GUIDE_STEPS.length }))}</span>
      <button type="button" class="icon-btn guide-x" data-guide="close" aria-label="${esc(t('guideClose'))}">${icon('close')}</button></div>
    <h2 id="guideTitle">${esc(t(`guide_${s.id}_title`))}</h2>
    <p id="guideBody">${esc(body)}</p>
    ${go}
    ${i === 0 ? `<p class="guide-again">${esc(t('guideAgain'))}</p>` : ''}
    <button type="button" class="guide-words" data-guide="words">${esc(t('guideWordsLink'))}</button>
    <div class="guide-foot"><div class="guide-dots">${dots}</div>
      <div class="guide-nav">${i === 0 ? `<button type="button" class="chip chip-btn" data-guide="close">${esc(t('guideSkip'))}</button>` : `<button type="button" class="chip chip-btn" data-guide="back">${esc(t('guideBack'))}</button>`}
      <button type="button" class="chip chip-btn guide-next" data-guide="${last ? 'close' : 'next'}">${esc(t(last ? 'guideDone' : 'guideNext'))}</button></div></div>`;
}

// go: { tools, newProject, projects, roster, actions } -> functions; a missing one hides that step's button.
// getMode: the current actions mode, for the last step.
export function createGuide({ go = {}, getMode = () => 'off', storage = globalThis.localStorage, doc = document } = {}) {
  const root = doc.createElement('div');
  root.className = 'guide-wrap';
  root.hidden = true;
  root.innerHTML = `<div class="guide glass" role="dialog" aria-modal="true" aria-labelledby="guideTitle" aria-describedby="guideBody"></div>`;
  doc.body.appendChild(root);
  const box = root.firstElementChild;
  let step = 0;
  let spot = null;
  let prevFocus = null;

  const available = (k) => typeof go[k] === 'function';

  function highlight() {
    spot?.classList.remove('guide-spot');
    spot = null;
    const sel = GUIDE_STEPS[step].target;
    const el = sel ? doc.querySelector(sel) : null;
    if (el && !el.hidden && el.offsetParent !== null) {
      spot = el;
      el.classList.add('guide-spot');
    }
  }

  function render(focusSel = '.guide-next') {
    box.innerHTML = stepHtml(step, { mode: getMode(), available });
    highlight();
    box.querySelector(focusSel)?.focus({ preventScroll: true });
  }

  function show(at = 0) {
    if (root.hidden) {
      const a = doc.activeElement;
      prevFocus = a && a !== doc.body ? a : doc.getElementById('guideBtn');
    }
    step = clampStep(at);
    root.hidden = false;
    render();
  }

  // The glossary in the same box; Back returns to the step it was opened from. Opened from outside (the palette), it
  // opens the guide first.
  function showWords() {
    if (root.hidden) show(step);
    spot?.classList.remove('guide-spot');
    spot = null;
    box.innerHTML = glossaryHtml();
    box.querySelector('[data-guide="words-back"]')?.focus({ preventScroll: true });
  }

  // Closing in any way (Done, Skip, Esc, the X, a step button) counts as seen
  function hide() {
    if (root.hidden) return;
    root.hidden = true;
    spot?.classList.remove('guide-spot');
    spot = null;
    markSeen(storage);
    const back = prevFocus;
    prevFocus = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  function move(d) {
    const next = clampStep(step + d);
    if (next === step) return;
    step = next;
    render(d < 0 ? '[data-guide="back"], [data-guide="close"]' : '.guide-next');
  }

  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.guideStep) {
      step = clampStep(Number(b.dataset.guideStep));
      render(`[data-guide-step="${step}"]`);
    } else if (b.dataset.guideGo) {
      const fn = go[b.dataset.guideGo];
      hide();
      fn?.();
    } else if (b.dataset.guide === 'next') move(1);
    else if (b.dataset.guide === 'back') move(-1);
    else if (b.dataset.guide === 'close') hide();
    else if (b.dataset.guide === 'words') showWords();
    else if (b.dataset.guide === 'words-back') render('[data-guide="words"]');
  });
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) hide();
  });
  // Every key stays inside the guide (the page's shortcuts and Ctrl+K wait); Tab cycles within the dialog
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      // In the words, Esc goes back to the step they were opened from; on a step it closes the guide
      if (box.querySelector('.guide-words-list')) render('[data-guide="words"]');
      else hide();
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.altKey && !box.querySelector('.guide-words-list')) {
      e.preventDefault();
      move(e.key === 'ArrowRight' ? 1 : -1);
    } else if (e.key === 'Tab') {
      const f = [...box.querySelectorAll('button')];
      if (!f.length) return;
      const i = f.indexOf(doc.activeElement);
      const to = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
      e.preventDefault();
      f[to].focus();
    }
  });

  // The actions mode arrives after the first render (and changes later): draw the open step again, focus kept in place
  function refresh() {
    if (root.hidden || box.querySelector('.guide-words-list')) return;
    const a = doc.activeElement;
    const keep = !box.contains(a) || a.classList.contains('guide-next') ? '.guide-next' : a.dataset.guide ? `[data-guide="${a.dataset.guide}"]` : a?.dataset?.guideStep ? `[data-guide-step="${a.dataset.guideStep}"]` : '.guide-next';
    render(keep);
  }

  return { show, hide, refresh, showWords, isOpen: () => !root.hidden, step: () => step };
}
