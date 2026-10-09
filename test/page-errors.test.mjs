// The page's own errors reach the shell's log, and Settings opens the log folder (review A4). Nothing leaves the
// computer; diagnostics says only how many errors there were. Run: node --test test/page-errors.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { errorText, installPageErrors, PAGE_ERRORS_LOGGED } from '../public/js/pageErrors.js';
import { PAGE_ERROR_IPC_CHANNEL, LOGS_OPEN_IPC_CHANNEL, PAGE_ERROR_MAX, PAGE_ERRORS_PER_RUN, pageErrorLine } from '../electron/helpers.mjs';
import { diagnosticsText } from '../public/js/diagnostics.js';
import { settingsHtml } from '../public/js/views/settings.js';
import { setLanguage } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ORIGIN = 'http://127.0.0.1:47700';
const PANEL = { mainWindow: true, frame: { top: true, url: `${ORIGIN}/?lang=tr` }, origin: ORIGIN };

test('the text of an error: its name and message, where it happened, the first lines of its stack; one line, capped', () => {
  const err = new TypeError('x is not a function');
  err.stack = 'TypeError: x is not a function\n    at a (http://127.0.0.1:47700/js/main.js:10:5)\n    at b (http://127.0.0.1:47700/js/main.js:20:7)';
  assert.equal(errorText({ message: 'Uncaught TypeError: x is not a function', filename: `${ORIGIN}/js/main.js`, lineno: 10, colno: 5, error: err }), `TypeError: x is not a function @ ${ORIGIN}/js/main.js:10:5 | at a (http://127.0.0.1:47700/js/main.js:10:5) | at b (http://127.0.0.1:47700/js/main.js:20:7)`);
  assert.equal(errorText('a\nplain\tstring'), 'a plain string');
  assert.equal(errorText({ code: 1 }), 'unknown error');
  assert.equal(errorText(undefined), 'unknown error');
  assert.equal(errorText('x'.repeat(5000)).length, 1000);
});

test('caught on the window: each different error reported once, at most PAGE_ERRORS_LOGGED; every one counted; a failing report changes nothing', () => {
  const target = new EventTarget();
  const sent = [];
  const errors = installPageErrors({ target, report: (t) => sent.push(t) });
  const fire = (message) => target.dispatchEvent(Object.assign(new Event('error'), { message, filename: `${ORIGIN}/js/x.js`, lineno: 1, colno: 2 }));
  fire('first');
  fire('first');
  target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('nobody waited') }));
  assert.equal(errors.count(), 3);
  assert.equal(sent.length, 2, 'the same error once');
  assert.match(sent[1], /^unhandled rejection: Error: nobody waited/);
  for (let i = 0; i < PAGE_ERRORS_LOGGED + 5; i++) fire(`e${i}`);
  assert.equal(sent.length, PAGE_ERRORS_LOGGED);
  assert.equal(errors.count(), 3 + PAGE_ERRORS_LOGGED + 5);
  const quiet = installPageErrors({ target: new EventTarget(), report: () => {
    throw new Error('no bridge');
  } });
  assert.equal(quiet.count(), 0);
  assert.doesNotThrow(() => installPageErrors({ target: {}, report: () => {} }), 'no window: nothing caught, nothing breaks');
});

test('the shell: only the main window top frame; one clean line; at most PAGE_ERRORS_PER_RUN, the last one says so', () => {
  assert.equal(pageErrorLine({ ...PANEL, text: 'TypeError: x\u0000y\r\nz' }), 'page error: TypeError: x y z');
  // An error's message may quote what it failed on (V8's JSON errors do): masked like every text the app shows
  assert.equal(pageErrorLine({ ...PANEL, text: 'SyntaxError: "api_key=sk-ant-abcdefabcdefabcdef1234" is not valid JSON' }), 'page error: SyntaxError: "api_key=•••" is not valid JSON');
  assert.equal(pageErrorLine({ ...PANEL, mainWindow: false, text: 'x' }), null, 'another window');
  assert.equal(pageErrorLine({ ...PANEL, frame: { top: false, url: `${ORIGIN}/` }, text: 'x' }), null, 'a subframe');
  assert.equal(pageErrorLine({ ...PANEL, frame: { top: true, url: 'https://example.com/' }, text: 'x' }), null, 'another site');
  for (const text of [undefined, 3, '', '   ', 'x'.repeat(PAGE_ERROR_MAX + 1)]) assert.equal(pageErrorLine({ ...PANEL, text }), null, String(text).slice(0, 10));
  assert.match(pageErrorLine({ ...PANEL, text: 'x', logged: PAGE_ERRORS_PER_RUN - 1 }), /no more page errors are logged this run/);
  assert.equal(pageErrorLine({ ...PANEL, text: 'x', logged: PAGE_ERRORS_PER_RUN }), null);
});

test('diagnostics says how many, never what; Settings offers the log folder only in the desktop app', () => {
  const base = { about: { version: '0.17.0' }, tools: null, mode: 'off', lang: 'tr', now: 0 };
  assert.match(diagnosticsText({ ...base, desktop: true, pageErrors: 2 }), /\nPage errors this run: 2 \(details in main\.log\)\n/);
  assert.match(diagnosticsText({ ...base, desktop: false, pageErrors: 0 }), /\nPage errors this run: 0\n/);
  assert.doesNotMatch(diagnosticsText({ ...base, desktop: true }), /Page errors/);
  setLanguage('tr');
  try {
    const on = settingsHtml({ canLogs: true, updates: { status: 'off' }, updatesChecked: false });
    assert.ok(on.includes('Kayıt dosyaları') && on.includes('data-set-act="logs"'));
    assert.ok(!settingsHtml({ updates: { status: 'off' }, updatesChecked: false }).includes('data-set-act="logs"'), 'a browser has no log folder');
  } finally {
    setLanguage('en');
  }
});

test('wiring: the preload sends and asks on the shell\'s channels; the shell checks and registers them; the page catches first', () => {
  const preload = read('electron/preload.cjs');
  assert.ok(preload.includes(`const PAGE_ERROR_CHANNEL = '${PAGE_ERROR_IPC_CHANNEL}';`) && preload.includes(`const LOGS_CHANNEL = '${LOGS_OPEN_IPC_CHANNEL}';`) && preload.includes(`const PAGE_ERROR_MAX = ${PAGE_ERROR_MAX};`));
  assert.ok(preload.includes('return ipcRenderer.invoke(PAGE_ERROR_CHANNEL, text);') && preload.includes('return ipcRenderer.invoke(LOGS_CHANNEL);'));
  const main = read('electron/main.mjs');
  assert.ok(main.includes('ipcMain.handle(PAGE_ERROR_IPC_CHANNEL, onPageError);') && main.includes('ipcMain.handle(LOGS_OPEN_IPC_CHANNEL, onOpenLogs);'));
  assert.ok(main.includes('if (!bridgeSender(senderFacts(event)).ok) return { ok: false, reason: \'refused\' };'), 'the folder only for our own page');
  assert.ok(main.includes('await shell.openPath(LOG_DIR)'), 'always the log folder, never a path from the page');
  const page = read('public/js/main.js');
  const first = page.indexOf('const pageErrors = installPageErrors();');
  assert.ok(first > 0 && first < page.indexOf('const $ = (s) => document.querySelector(s);'), 'before anything else runs');
});
