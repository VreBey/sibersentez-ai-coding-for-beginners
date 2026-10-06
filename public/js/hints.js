// "?" hints next to words a new user may not know yet (token, agent, workflow...). hintHtml() is a focusable mark;
// one bubble for the whole page follows the mouse and the keyboard focus, placed in the viewport so no card with
// overflow: hidden cuts it. The text is also the mark's accessible description.
import { esc } from './format.js';

// The mark; text: the explanation, already in the page's language
export function hintHtml(text) {
  return `<span class="hint" tabindex="0" role="button" aria-label="${esc(text)}" data-hint="${esc(text)}">?</span>`;
}

let bubble = null;
let current = null;

function show(el) {
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = 'hint-bubble';
    bubble.id = 'hintBubble';
    bubble.setAttribute('role', 'tooltip');
    document.body.append(bubble);
  }
  current = el;
  bubble.textContent = el.dataset.hint || '';
  bubble.hidden = false;
  const r = el.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left + r.width / 2 - b.width / 2), window.innerWidth - b.width - 8);
  // Below the mark, or above it when there is no room below
  const top = r.bottom + 8 + b.height > window.innerHeight ? r.top - b.height - 8 : r.bottom + 8;
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(Math.max(8, top))}px`;
}

function hide(el) {
  if (el && el !== current) return;
  current = null;
  if (bubble) bubble.hidden = true;
}

// Once, from main.js: the page's listeners (the marks come and go with the redraws)
export function initHints(root = document) {
  root.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('.hint');
    if (el) show(el);
  });
  root.addEventListener('mouseout', (e) => {
    const el = e.target.closest?.('.hint');
    if (el && !el.contains(e.relatedTarget)) hide(el);
  });
  root.addEventListener('focusin', (e) => {
    if (e.target.classList?.contains('hint')) show(e.target);
  });
  root.addEventListener('focusout', (e) => {
    if (e.target.classList?.contains('hint')) hide(e.target);
  });
  // A click or Enter keeps the bubble for touch and keyboard users; Esc closes it
  root.addEventListener('click', (e) => {
    const el = e.target.closest?.('.hint');
    if (el) {
      e.preventDefault();
      e.stopPropagation();
      show(el);
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) {
      hide();
      e.stopPropagation();
    } else if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('hint')) {
      e.preventDefault();
      show(e.target);
    }
  });
  window.addEventListener('scroll', () => hide(), { passive: true });
}
