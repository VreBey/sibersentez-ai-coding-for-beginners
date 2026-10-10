// @ts-check
// The full tour (2026-10-05): SiberSentez from the first click to the result, on an example. A box at the bottom of the
// window explains one step at a time while the real screen shows it: the element in question is highlighted, the job
// box gets an example job typed into it, and the Building plays its own example (hq-scene.js createDemo) held at the
// step's moment. Nothing is pressed, nothing runs, nothing reaches the server or a project: the example job is never
// started and the box gets its old text back when the tour ends. The steps and their markup are pure (tested in node).
import { t } from './i18n.js';
import { esc } from './format.js';
import { icon } from './icons.js';

// target: the element the step points at; scene: what the page shows for it (main.js tourScene); at: the example's
// moment in ms (the Building's example: the plan waits at 1.5 s, the team builds from 4.5 s, the check from 66 s, the
// result waits from 100 s, the job is done at 120 s)
export const TOUR_STEPS = Object.freeze(
  [
    { id: 'start', icon: 'baton', scene: 'home' },
    { id: 'tools', icon: 'spark', target: '#toolsBtn', scene: 'home' },
    { id: 'project', icon: 'folder', target: '#newProjectBtn', scene: 'home' },
    { id: 'job', icon: 'prompt', target: '[data-ws="give"]', scene: 'type' },
    { id: 'go', icon: 'play', target: '[data-ws="give-go"]', scene: 'type' },
    { id: 'plan', icon: 'plan', target: '[data-ws="stage"]', scene: 'example', at: 2500, lead: true },
    { id: 'build', icon: 'users', target: '[data-ws="stage"]', scene: 'example', at: 30000 },
    { id: 'check', icon: 'check', target: '[data-ws="jobbox"]', scene: 'example', at: 75000 },
    { id: 'result', icon: 'spark', target: '[data-ws="stage"]', scene: 'example', at: 101000, lead: true },
    { id: 'waiting', icon: 'bell', target: '#waitChip', scene: 'example', at: 101000 },
    { id: 'safety', icon: 'replay', target: '[data-tab="projects"]', scene: 'example', at: 121000 },
    { id: 'end', icon: 'check', scene: 'live' },
  ].map((s) => Object.freeze(s)),
);

export const TOUR_EXAMPLE_KEY = 'tourExampleJob';

export function clampTourStep(i) {
  const n = Number.isInteger(i) ? i : 0;
  return Math.min(TOUR_STEPS.length - 1, Math.max(0, n));
}

// The box for step i (pure)
export function tourStepHtml(i) {
  const k = clampTourStep(i);
  const s = TOUR_STEPS[k];
  const last = k === TOUR_STEPS.length - 1;
  return `<div class="tour-head"><span class="guide-ic">${icon(s.icon)}</span><span class="guide-count">${esc(t('tourCount', { n: k + 1, total: TOUR_STEPS.length }))}</span><span class="tour-sim">${esc(t('tourSim'))}</span>
      <button type="button" class="icon-btn guide-x" data-tour="close" aria-label="${esc(t('tourClose'))}">${icon('close')}</button></div>
    <h2 id="tourTitle">${esc(t(`tour_${s.id}_title`))}</h2>
    <p id="tourBody">${esc(t(`tour_${s.id}_body`))}</p>
    <div class="guide-foot"><progress class="tour-bar" max="${TOUR_STEPS.length}" value="${k + 1}" aria-hidden="true"></progress>
      <div class="guide-nav">${k === 0 ? '' : `<button type="button" class="chip chip-btn" data-tour="back">${esc(t('guideBack'))}</button>`}
      <button type="button" class="chip chip-btn guide-next" data-tour="${last ? 'close' : 'next'}">${esc(t(last ? 'tourDone' : 'guideNext'))}</button></div></div>`;
}

// scene(step): sets the page up for a step (main.js); end(): puts everything back. Keys: → ← move, Esc ends.
export function createTour({ scene = (_step) => {}, end = () => {}, doc = document } = {}) {
  const root = doc.createElement('div');
  root.className = 'tour-wrap';
  root.hidden = true;
  root.innerHTML = `<section class="tour glass" role="dialog" aria-modal="false" aria-labelledby="tourTitle" aria-describedby="tourBody"></section>`;
  doc.body.appendChild(root);
  const box = root.firstElementChild;
  let step = 0;
  let spot = null;
  let prevFocus = null;

  function highlight() {
    spot?.classList.remove('guide-spot');
    spot = null;
    const sel = TOUR_STEPS[step].target;
    const el = /** @type {HTMLElement | null} */ (sel ? doc.querySelector(sel) : null);
    if (el && !el.hidden && el.offsetParent !== null) {
      spot = el;
      el.classList.add('guide-spot');
      el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }
  }

  function render(focusSel = '.guide-next') {
    box.innerHTML = tourStepHtml(step);
    try {
      scene(TOUR_STEPS[step]);
    } catch (e) {
      console.error(e);
    }
    // The scene may have drawn the element first (the Building's tab): highlight after it
    setTimeout(highlight, 60);
    /** @type {HTMLElement | null} */ (box.querySelector(focusSel))?.focus({ preventScroll: true });
  }

  function show(at = 0) {
    if (root.hidden) {
      const a = doc.activeElement;
      prevFocus = a && a !== doc.body ? a : null;
    }
    step = clampTourStep(at);
    root.hidden = false;
    render();
  }

  function hide() {
    if (root.hidden) return;
    root.hidden = true;
    spot?.classList.remove('guide-spot');
    spot = null;
    try {
      end();
    } catch (e) {
      console.error(e);
    }
    const back = prevFocus;
    prevFocus = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  function move(d) {
    const next = clampTourStep(step + d);
    if (next === step) return;
    step = next;
    render(d < 0 ? '[data-tour="back"], .guide-next' : '.guide-next');
  }

  box.addEventListener('click', (/** @type {MouseEvent & { target: HTMLElement }} */ e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tour === 'next') move(1);
    else if (b.dataset.tour === 'back') move(-1);
    else if (b.dataset.tour === 'close') hide();
  });
  box.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.altKey) {
      e.preventDefault();
      move(e.key === 'ArrowRight' ? 1 : -1);
    }
  });

  return { show, hide, isOpen: () => !root.hidden, step: () => step };
}
