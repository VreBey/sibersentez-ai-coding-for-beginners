// The terminal panel in a browser (plan D1, happy-dom; xterm.js is a stand-in, test/dom/fake-xterm.mjs): typing reaches
// the bridge, copy and paste keys are left to the browser, a draft for the AI is typed without Enter and never while
// the tool asks with a menu, and the screen reader switch reaches every open tab. Run: node --test test/dom-terminal.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { settle, win, closeWindow } from './dom/env.mjs';
after(() => closeWindow());

const { Terminal } = await import('./dom/fake-xterm.mjs');
const { setLanguage } = await import('../public/js/i18n.js');
const { createTerminalDock } = await import('../public/js/terminalDock.js');
const { setTerminalReader } = await import('../public/js/usage.js');
setLanguage('tr');

// The desktop shell's bridge as the panel sees it: tabs are opened, keystrokes recorded, output pushed back
const writes = [];
let push = () => {};
let n = 0;
globalThis.sibersentezTerminal = {
  open: async (target) => ({ ok: true, id: `t${++n}`, title: target.projectId, projectId: target.projectId, ai: target.ai === true, tool: target.ai ? 'claude' : null }),
  write: (id, data) => writes.push([id, data]),
  resize: () => {},
  close: async () => true,
  list: async () => [],
  onData: (fn) => (push = fn),
  onExit: () => {},
  onToolEnd: () => {},
};
const toasts = [];
const dock = createTerminalDock({ toast: (t) => toasts.push(t), root: win.document.body });
const keydown = (key, mods = {}) => ({ type: 'keydown', key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

test('a tab: what is typed reaches the bridge as it is; the tool\'s output is written to its screen', async () => {
  const r = await dock.open({ projectId: 'kafe' });
  assert.equal(r.ok, true);
  await settle();
  const term = Terminal.all.at(-1);
  assert.ok(term && term.element, 'xterm opened in a pane');
  term.type('npm run dev');
  assert.deepEqual(writes.at(-1), [r.id, 'npm run dev']);
  push(r.id, 'hazır\r\n');
  assert.ok(term.written.includes('hazır'));
});

test('copy and paste: left to the browser; Ctrl+C with nothing selected still interrupts', async () => {
  const term = Terminal.all.at(-1);
  assert.equal(term.key(keydown('v', { ctrlKey: true })), false, 'Ctrl+V: the browser pastes');
  assert.equal(term.key(keydown('c', { ctrlKey: true })), true, 'nothing selected: to the program (interrupt)');
  term.selection = 'npm';
  assert.equal(term.key(keydown('c', { ctrlKey: true })), false, 'a selection: the browser copies');
  await settle();
  assert.equal(term.hasSelection(), false, 'then the selection goes, so the next Ctrl+C interrupts');
  assert.equal(term.key(keydown('x')), true);
});

test('a draft for the AI: typed into its tab without Enter; never while the tool asks with a menu; no AI, no draft', async () => {
  const before = writes.length;
  assert.equal(dock.askAi('nope', 'Planı onaylıyorum').ok, false, 'no AI tab of that project');
  const r = await dock.open({ projectId: 'site', ai: true });
  await settle();
  const ok = dock.askAi('site', 'Planı onaylıyorum, başlayabilirsin.');
  assert.equal(ok.ok, true);
  assert.deepEqual(writes.at(-1), [r.id, 'Planı onaylıyorum, başlayabilirsin.']);
  assert.ok(!writes.slice(before).some(([, d]) => /[\r\n]/.test(d)), 'never Enter');
  // The tool shows a permission menu: its letters could answer it, so nothing is typed
  push(r.id, '\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No, and tell Claude what to do differently (esc)\r\n');
  await settle();
  const count = writes.length;
  assert.equal(dock.askAi('site', 'Planı onaylıyorum').reason, 'asks');
  assert.equal(writes.length, count, 'nothing written while it asks');
  assert.equal(dock.askAi('site', 'satır\rsonu').ok, false, 'a draft with Enter in it is refused');
});

test('screen readers: the switch reaches every open tab at once, and new ones', async () => {
  assert.ok(Terminal.all.every((x) => x.options.screenReaderMode === false));
  setTerminalReader(true);
  assert.ok(Terminal.all.every((x) => x.options.screenReaderMode === true), 'open tabs follow');
  await dock.open({ projectId: 'third' });
  await settle();
  assert.equal(Terminal.all.at(-1).options.screenReaderMode, true, 'a new tab starts with it');
  setTerminalReader(false);
  assert.ok(Terminal.all.every((x) => x.options.screenReaderMode === false));
});
