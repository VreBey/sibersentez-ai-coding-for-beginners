// Notification cards (public/js/toasts.js): a card closes by itself even when the pointer rests on it; focus inside and
// an error still keep it. A small stand-in for the DOM and mocked timers; nothing is drawn.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { activeElement: null, querySelector: () => null };
const { mountToast, HOVER_MAX_MS } = await import('../public/js/toasts.js');

function card() {
  const on = {};
  const el = {
    dataset: {},
    isConnected: true,
    removed: false,
    classList: { add() {} },
    addEventListener: (type, fn) => ((on[type] ||= []).push(fn)),
    fire: (type, e = {}) => (on[type] || []).forEach((fn) => fn(e)),
    contains: (x) => x === el,
    matches: () => false,
    remove() {
      el.removed = true;
      el.isConnected = false;
    },
  };
  return el;
}
const stack = () => ({ children: [], prepend(el) { this.children.unshift(el); } });

test('a card under a resting pointer (over the terminal) still closes after HOVER_MAX_MS; leaving closes it sooner', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const el = card();
    mountToast(stack(), el, { ms: 9000 });
    el.fire('mouseenter');
    mock.timers.tick(9000);
    assert.equal(el.dataset.gone, undefined, 'paused while the pointer is on it');
    mock.timers.tick(HOVER_MAX_MS - 9000 + 600);
    assert.equal(el.dataset.gone, '1', 'closed although the pointer never left');
    mock.timers.tick(600);
    assert.equal(el.removed, true, 'taken away after its closing animation');

    const b = card();
    mountToast(stack(), b, { ms: 9000 });
    b.fire('mouseenter');
    b.fire('mouseleave');
    mock.timers.tick(4000);
    assert.equal(b.dataset.gone, '1', 'leaving resumes with a short wait');
  } finally {
    mock.timers.reset();
  }
});

test('focus inside keeps a card past the pointer limit, and an error stays until it is closed', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const el = card();
    mountToast(stack(), el, { ms: 9000 });
    el.fire('mouseenter');
    document.activeElement = el;
    mock.timers.tick(HOVER_MAX_MS + 1000);
    assert.equal(el.dataset.gone, undefined, 'focus inside: the person is reading it');
    document.activeElement = null;

    const err = card();
    mountToast(stack(), err, { ms: 9000, sticky: true });
    err.fire('mouseenter');
    mock.timers.tick(HOVER_MAX_MS * 3);
    assert.equal(err.dataset.gone, undefined, 'an error stays');
  } finally {
    mock.timers.reset();
    document.activeElement = null;
  }
});

test('the stack sits above the terminal dock when it is open', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.toasts \{[^}]*bottom: calc\(18px \+ var\(--dock-space, 0px\)\)/);
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes("setProperty('--dock-space'"), 'the dock says how much room it takes');
});
