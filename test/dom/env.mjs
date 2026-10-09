// A browser for the DOM tests (plan D1): a happy-dom window whose document, events and storage become the globals the
// page's modules use, a canvas that draws nothing, a fetch that answers from a table, and xterm.js mapped to a
// stand-in. Import this before any page module. Nothing reaches the network; no window opens.
import { register } from 'node:module';
import { Window } from 'happy-dom';

register('./vendor-hooks.mjs', import.meta.url);

export const ORIGIN = 'http://127.0.0.1:47700';
export const win = new Window({ url: `${ORIGIN}/?lang=tr`, width: 1440, height: 900 });

const GLOBALS = ['document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLCanvasElement', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'InputEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'CSS', 'DOMParser', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'innerWidth', 'innerHeight', 'scrollTo', 'devicePixelRatio', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'getSelection', 'scrollY', 'scrollX', 'Image', 'HTMLImageElement', 'performance', 'OffscreenCanvas', 'Path2D'];
globalThis.window = win;
for (const k of GLOBALS) {
  if (win[k] === undefined) continue;
  Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: typeof win[k] === 'function' && /^[a-z]/.test(k) ? win[k].bind(win) : win[k] });
}
// The page's timers (refreshes every few seconds) never keep the test process alive; the tests' own waits use the real
// ones (they must, or node could end while a test still waits)
const realSetTimeout = globalThis.setTimeout;
for (const name of ['setTimeout', 'setInterval']) {
  const real = globalThis[name];
  globalThis[name] = (...args) => {
    const id = real(...args);
    id?.unref?.();
    return id;
  };
}
// A canvas that draws nothing: every call of a 2D context is accepted
const noop = () => {};
const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 8 }) : k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern' ? () => ({ addColorStop: noop }) : k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) }) : noop), set: (t, k, v) => ((t[k] = v), true) });
win.HTMLCanvasElement.prototype.getContext = () => ctx;
globalThis.EventSource = class {
  constructor() {
    this.readyState = 1;
  }
  addEventListener() {}
  close() {
    this.readyState = 2;
  }
};

// fetch: answers from routes ({ 'GET /api/snapshot': body | (url, init) => body }); anything else is a 404. Every
// request is kept in `requests`.
export const requests = [];
let routes = {};
export function setRoutes(r) {
  routes = r;
}
// More fake answers next to the ones set
export function addRoutes(r) {
  routes = { ...routes, ...r };
}
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input), ORIGIN);
  const method = (init.method || 'GET').toUpperCase();
  const key = `${method} ${u.pathname}`;
  requests.push({ key, url: u.href, body: init.body ? JSON.parse(init.body) : null });
  const r = routes[key];
  const body = typeof r === 'function' ? await r(u, init) : r;
  const ok = body !== undefined;
  return { ok, status: ok ? 200 : 404, json: async () => body ?? { error: 'not-found' }, text: async () => JSON.stringify(body ?? {}) };
};

// The next turns of the event loop (timers the page set with 0 ms, answers of the fake fetch)
export const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => realSetTimeout(r, 0));
};
// Some real time (frames: requestAnimationFrame runs on timers)
export const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));
export const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

// Close the window after the file's tests (its timers would keep node alive)
export const closeWindow = () => win.happyDOM?.close?.();
