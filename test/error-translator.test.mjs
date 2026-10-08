// The error translator (roadmap F2, 2026-10-08): an error of the person's own program in a plain terminal of a project
// is said in plain words and can go to the AI tool as one sentence, typed without Enter (or into the job box).
// Run: node --test test/error-translator.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectCodeError, codeFixText, promptHelpHtml, CODE_ERRORS, detectError } from '../public/js/promptHelp.js';
import { aiDraftOk, AI_DRAFT_MAX } from '../public/js/dockState.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the errors it knows, from what programs print; nothing on a clean screen', () => {
  const cases = [
    ["node server.js\nError: Cannot find module 'express'\nRequire stack:", 'module', "Error: Cannot find module 'express'"],
    ["Module not found: Error: Can't resolve './Header' in 'C:\\p\\src'", 'module', null],
    ["ModuleNotFoundError: No module named 'flask'", 'module', null],
    ['Error: listen EADDRINUSE: address already in use :::3000', 'port', null],
    ['Port 3000 is already in use', 'port', null],
    ['npm error Missing script: "dev"', 'script', null],
    ["SyntaxError: Unexpected token '}'", 'syntax', null],
    ['IndentationError: unexpected indent', 'syntax', null],
    ["TypeError: Cannot read properties of undefined (reading 'map')", 'runtime', null],
    ["NameError: name 'x' is not defined", 'runtime', null],
    ['Failed to compile.', 'build', null],
    ["src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", 'build', null],
  ];
  for (const [text, kind, line] of cases) {
    const h = detectCodeError(text);
    assert.equal(h?.kind, kind, text);
    if (line) assert.equal(h.line, line);
  }
  for (const clean of ['', 'VITE v5.0.0  ready in 300 ms\n  ➜  Local:   http://localhost:5173/', 'Compiled successfully!', 'PS C:\\p> ', 'Port 5173 is in use, trying another one...', ' ⚠ Port 3000 is in use, trying 3001 instead.', ' ⚠ Port 3000 is in use by an unknown process, using available port 3001 instead.']) assert.equal(detectCodeError(clean), null, clean);
  assert.deepEqual(CODE_ERRORS.map((e) => e.id), ['module', 'port', 'script', 'syntax', 'runtime', 'build']);
});

test('the newest error on the screen wins; the line is shortened and cleaned; the sentence fits what may be typed into an AI tab', () => {
  const h = detectCodeError("SyntaxError: old one\nfixed, ran again\nError: Cannot find module 'react'");
  assert.equal(h.kind, 'module');
  const long = detectCodeError(`TypeError: ${'x'.repeat(400)}\u0007`);
  assert.ok(Array.from(long.line).length <= 160);
  assert.doesNotMatch(long.line, /[\u0000-\u001f]/);
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    const text = codeFixText(long);
    assert.ok(aiDraftOk(text) && text.length <= AI_DRAFT_MAX, `${lang}: ${text.length}`);
    assert.ok(text.includes(long.line.slice(0, 20)));
  }
  setLanguage('en');
  assert.equal(codeFixText(null), '');
  assert.equal(codeFixText({ id: 'error' }), '');
});

test('the box: the line, what it means in plain words, "Ask the AI to fix it"; both languages', () => {
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    for (const e of CODE_ERRORS) assert.ok(STRINGS[lang][`phCode_${e.id}`]?.trim(), `${lang} phCode_${e.id}`);
    for (const k of ['phTitle_code', 'phAsk', 'phAskText', 'phFoot_code']) assert.ok(STRINGS[lang][k]?.trim(), `${lang} ${k}`);
    assert.match(STRINGS[lang].phAskText, /\{line\}/);
    const html = promptHelpHtml(detectCodeError('Error: listen EADDRINUSE: address already in use :::3000'));
    assert.ok(html.includes('data-ph="ask"') && html.includes('data-ph="close"') && html.includes(STRINGS[lang].phCode_port));
    assert.ok(html.includes('<code translate="no">Error: listen EADDRINUSE'));
  }
  setLanguage('en');
  // A setup error is still the setup check's (its fixes), not a code error
  assert.equal(detectError('running scripts is disabled on this system')?.id, 'error');
});

test('wiring: only in a plain terminal of a project; the sentence to the running AI tab, else the job box; never sent by itself', () => {
  const dock = read('public/js/terminalDock.js');
  assert.ok(dock.includes("(!x.ai && x.projectId ? detectCodeError(x.plain) : null)"), 'not in an AI tool\'s own tab');
  assert.ok(dock.includes("onFix?.(x.projectId, codeFixText(x.help));"));
  const main = read('public/js/main.js');
  const fix = main.slice(main.indexOf('onFix: (projectId, text) => {'), main.indexOf('onFix: (projectId, text) => {') + 320);
  assert.ok(fix.includes('termDock.askAi(projectId, text)') && fix.includes('drawer.openWithJob(projectId, text)'));
  assert.ok(fix.includes("r?.reason === 'asks'"), 'a tab whose screen asks something is not typed into, and no job box opens over it');
  assert.ok(main.indexOf('const drawer = createDrawer(') < main.indexOf('const termDock = createTerminalDock('));
});
