// Copy and paste in the embedded terminal (reported 2026-10-09): the keys Windows Terminal uses are left to the
// browser's own copy and paste; everything else still goes to the program. Run: node --test test/terminal-keys.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { terminalKeyAction, terminalKeyHandler } from '../public/js/terminalKeys.js';

const key = (k, mods = {}, type = 'keydown') => ({ type, key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

test('Ctrl+C copies only with a selection (else it interrupts the program); Ctrl+Shift+C always copies', () => {
  assert.equal(terminalKeyAction(key('c', { ctrlKey: true }), true), 'copy');
  assert.equal(terminalKeyAction(key('c', { ctrlKey: true }), false), 'terminal', 'nothing selected: the interrupt');
  assert.equal(terminalKeyAction(key('C', { ctrlKey: true, shiftKey: true }), false), 'copy');
  assert.equal(terminalKeyAction(key('Insert', { ctrlKey: true }), true), 'copy');
  assert.equal(terminalKeyAction(key('Insert', { ctrlKey: true }), false), 'terminal');
});

test('Ctrl+V, Ctrl+Shift+V and Shift+Insert paste', () => {
  for (const e of [key('v', { ctrlKey: true }), key('V', { ctrlKey: true, shiftKey: true }), key('Insert', { shiftKey: true })]) {
    assert.equal(terminalKeyAction(e, false), 'paste', `${e.key} ${e.ctrlKey} ${e.shiftKey}`);
  }
});

test('Turkish F: the letter decides, not the place (its c sits where Q has v); Ctrl+C with nothing selected still interrupts', () => {
  assert.equal(terminalKeyAction({ ...key('c', { ctrlKey: true }), code: 'KeyV' }, false), 'terminal', 'Ctrl+C on F: the interrupt, never a paste');
  assert.equal(terminalKeyAction({ ...key('c', { ctrlKey: true }), code: 'KeyV' }, true), 'copy');
  assert.equal(terminalKeyAction({ ...key('v', { ctrlKey: true }), code: 'KeyC' }, true), 'paste', 'Ctrl+V on F: a paste, never a copy');
});

test('a layout where the key is not a Latin letter still matches by its place (code); other keys go to the program', () => {
  assert.equal(terminalKeyAction({ ...key('v', { ctrlKey: true }), key: 'м', code: 'KeyV' }), 'paste');
  for (const e of [key('c'), key('v'), key('a', { ctrlKey: true }), key('d', { ctrlKey: true }), key('c', { ctrlKey: true, altKey: true }), key('v', { ctrlKey: true }, 'keyup'), key('Insert')]) {
    assert.equal(terminalKeyAction(e, true), 'terminal', JSON.stringify(e));
  }
  assert.equal(terminalKeyAction(null), 'terminal');
});

test('the handler: false leaves the key to the browser; after a copy the selection is cleared, so the next Ctrl+C interrupts', () => {
  let selected = true;
  let cleared = 0;
  const later = [];
  const term = { hasSelection: () => selected, clearSelection: () => ((selected = false), cleared++) };
  const h = terminalKeyHandler(term, (fn) => later.push(fn));
  assert.equal(h(key('c', { ctrlKey: true })), false, 'the browser copies');
  assert.equal(cleared, 0, 'not before the browser has copied');
  later.shift()();
  assert.equal(cleared, 1);
  assert.equal(h(key('c', { ctrlKey: true })), true, 'now Ctrl+C reaches the program');
  assert.equal(h(key('v', { ctrlKey: true })), false, 'the browser pastes');
  assert.equal(h(key('x')), true);
  assert.equal(later.length, 0);
});

test('wiring: every terminal tab gets the handler right after it opens; the vendored xterm leaves a refused key to the browser and copies its selection', () => {
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes("import { terminalKeyHandler } from './terminalKeys.js';"));
  assert.ok(dock.indexOf('term.attachCustomKeyEventHandler(terminalKeyHandler(term));') > dock.indexOf('term.open(el);'));
  const dir = new URL('../public/vendor/xterm/', import.meta.url);
  const lib = fs.readdirSync(dir).filter((f) => /\.m?js$/.test(f)).map((f) => fs.readFileSync(new URL(f, dir), 'utf8')).find((s) => s.includes('_customKeyEventHandler'));
  assert.ok(lib, 'the vendored xterm');
  assert.ok(lib.includes('_customKeyEventHandler(e)===!1)return!1'), 'a refused key: xterm returns before it cancels the event');
  assert.match(lib, /"copy",\w+=>\{this\.hasSelection\(\)&&/, 'the browser copy takes the selection');
  assert.match(lib, /L\(this\.textarea,"paste",e\)/, 'the browser paste reaches the program');
});

test('screen readers (plan C2): a Settings switch, off by default, followed by every tab; a 24 px close target', async () => {
  const usage = await import('../public/js/usage.js');
  assert.equal(usage.terminalReaderOn(), false, 'off unless turned on');
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes('screenReaderMode: terminalReaderOn() });'), 'new tabs');
  assert.ok(dock.includes('x.term.options.screenReaderMode = terminalReaderOn();'), 'open tabs');
  const { settingsHtml } = await import('../public/js/views/settings.js');
  assert.match(settingsHtml({ updates: { status: 'off' }, updatesChecked: false }), /data-set-reader/);
  const css = fs.readFileSync(new URL('../public/css/terminal-dock.css', import.meta.url), 'utf8');
  assert.match(css, /\.td-tab \.td-x \{[^}]*width: 24px; height: 24px;/);
});
