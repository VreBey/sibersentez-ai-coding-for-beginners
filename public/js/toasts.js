// Notification stack: ONE upper limit and ONE removal function for action notifications (main.js) and bell notifications (notify.js).
// Rules (WCAG 2.2.1, 2.4.3):
// - while the pointer is over it or focus is inside, the timer pauses, and it closes a short time after leaving;
// - an error notification (sticky) stays until the user closes it, and is not removed on overflow either;
// - on overflow a card that contains focus is skipped; if the removed card contains focus, focus moves to a safe target.
// Does not touch the DOM while the module loads.
import { esc } from './format.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { focusableVisible } from './contextmenu.js';

export const TOAST_MAX = 4;
const RESUME_MS = 4000;
// A pointer resting on a card pauses it at most this long (a card that appeared under a pointer left there, over the
// terminal, never closed); focus inside still holds it, and an error stays until closed
export const HOVER_MAX_MS = 15000;
const TONE = { ok: '#5ee39a', dry: '#ffe39a', warn: '#ffb454', err: '#ff7a7a' };
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Add the card to the stack and set up its timer
export function mountToast(stack, el, { ms = 9000, sticky = false } = {}) {
  let timer = null;
  let back = null; // where focus was before it entered the notification
  if (sticky) el.dataset.sticky = '1';
  const arm = (t) => {
    clearTimeout(timer);
    if (!sticky) timer = setTimeout(() => dismissToast(el), t);
  };
  const hold = () => clearTimeout(timer);
  el.addEventListener('mouseenter', () => {
    hold();
    if (!sticky) timer = setTimeout(() => !el.contains(document.activeElement) && dismissToast(el), HOVER_MAX_MS);
  });
  el.addEventListener('mouseleave', () => !el.contains(document.activeElement) && arm(RESUME_MS));
  el.addEventListener('focusin', (e) => {
    hold();
    if (e.relatedTarget && !el.contains(e.relatedTarget)) back = e.relatedTarget;
  });
  el.addEventListener('focusout', (e) => {
    if (!el.contains(e.relatedTarget) && !el.matches(':hover')) arm(RESUME_MS);
  });
  el._back = () => back;
  el._hold = hold;
  stack.prepend(el);
  trimToasts(stack);
  arm(ms);
  return el;
}

// Upper limit: removal starts from the oldest; cards being removed (data-gone), errors (sticky) and those
// that contain focus are not counted/are skipped. Errors may exceed the limit (they stay until closed).
export function trimToasts(stack, max = TOAST_MAX) {
  const alive = [...stack.children].filter((c) => !c.dataset.gone);
  let extra = alive.length - max;
  for (let i = alive.length - 1; i >= 0 && extra > 0; i--) {
    const c = alive[i];
    if (c.dataset.sticky || c.contains(document.activeElement)) continue;
    dismissToast(c);
    extra--;
  }
}

// Single removal function: if focus is inside, it is moved to a safe target first
export function dismissToast(el) {
  if (!el?.isConnected || el.dataset.gone) return;
  el.dataset.gone = '1';
  el._hold?.();
  if (el.contains(document.activeElement)) {
    // Order: the close button of the neighbouring card in the stack (or the button, if it is the card itself), the element
    // before entering the notification, the active tab button
    const sibs = [el.nextElementSibling, el.previousElementSibling].filter((x) => x && !x.dataset.gone);
    const next = sibs.map((x) => x.querySelector?.('.t-x') || (x.matches?.('button') ? x : null)).find(Boolean);
    const target = [next, el._back?.(), document.querySelector('[data-tab].on')].find(focusableVisible);
    target?.focus({ preventScroll: true });
  }
  if (reduced()) return el.remove();
  el.classList.add('out');
  setTimeout(() => el.remove(), 550);
}

// Action notification (results of menu and skill flows). An error or a warning stays until closed.
export function actionToast(stack, { tone = 'ok', title = '', body = '', code = '' } = {}) {
  const el = document.createElement('div');
  el.className = `toast act t-${tone}`;
  el.style.setProperty('--c', TONE[tone] || TONE.ok);
  el.innerHTML = `<span class="t-ic">${icon(tone === 'err' ? 'close' : tone === 'dry' ? 'spark' : tone === 'warn' ? 'bell' : 'check')}</span><span class="t-body"><b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}${code ? `<code translate="no">${esc(code)}</code>` : ''}</span><button type="button" class="t-x icon-btn" aria-label="${esc(t('toastClose'))}">${icon('close')}</button>`;
  el.querySelector('.t-x').addEventListener('click', () => dismissToast(el));
  return mountToast(stack, el, { ms: 9000, sticky: tone === 'err' || tone === 'warn' });
}
