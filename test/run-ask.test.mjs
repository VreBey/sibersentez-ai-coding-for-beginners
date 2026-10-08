// "How to run it" when the way is not known (review U09): one way that leads somewhere. An AI of the project runs in
// SiberSentez's terminal: the question is written into it without Enter (terminalDock askAi, dockState aiDraftOk);
// none runs: the question goes into the job box (the drawer's fillJob), Start stays the person's.
// Run: node --test test/run-ask.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSectionHtml, bindRunHint, setRunAsker } from '../public/js/runHint.js';
import { aiDraftOk, AI_DRAFT_MAX } from '../public/js/dockState.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';
import { esc } from '../public/js/format.js';

const p = { id: 'a', path: 'C:\\p' };
const unknown = { state: 'unknown', plans: [] };

test('unknown way: the running AI is asked in place; without one the question becomes a new job; copying stays', () => {
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const S = STRINGS[lang];
      const ai = runSectionHtml(p, unknown, { aiRuns: true });
      assert.ok(ai.includes('data-run-ask') && !ai.includes('data-run-job') && ai.includes(esc(S.runAskAiNote)) && ai.includes('data-run-copy'), lang);
      const none = runSectionHtml(p, unknown, { aiRuns: false });
      assert.ok(none.includes('data-run-job') && !none.includes('data-run-ask') && none.includes(esc(S.runAskJobNote)) && none.includes('data-run-copy'), lang);
      // "in its terminal" is no longer the only, unreachable way
      assert.doesNotMatch(S.runUnknown, /terminal/i, lang);
      // A known way shows neither
      const ok = runSectionHtml(p, { state: 'ok', plans: [{ kind: 'node', steps: [{ id: 'script', cmd: 'npm start' }] }] }, { aiRuns: true });
      assert.ok(!ok.includes('data-run-ask') && !ok.includes('data-run-job'), lang);
    }
  } finally {
    setLanguage('en');
  }
});

// A drawer body that hears clicks, and a button that answers closest() like the real one
function fakeBody() {
  let onClick = null;
  return { addEventListener: (type, fn) => type === 'click' && (onClick = fn), click: (el) => onClick({ target: el }) };
}
function fakeButton(attr) {
  const el = { hasAttribute: (a) => a === attr, closest: (sel) => (sel.includes(`[${attr}]`) ? el : null) };
  return el;
}

test('the ask button writes the question into the AI; when the AI stopped meanwhile it goes into the job box instead', () => {
  setLanguage('en');
  const asked = [];
  const jobs = [];
  let answer = { ok: true, id: 't1' };
  setRunAsker((id, text) => (asked.push([id, text]), answer), () => true);
  try {
    const body = fakeBody();
    bindRunHint(body, { projectOf: () => 'a', asJob: (id, text) => jobs.push([id, text]) });
    body.click(fakeButton('data-run-ask'));
    assert.deepEqual(asked, [['a', STRINGS.en.runAsk]]);
    assert.deepEqual(jobs, []);
    answer = { ok: false, reason: 'no-ai' };
    body.click(fakeButton('data-run-ask'));
    assert.deepEqual(jobs, [['a', STRINGS.en.runAsk]], 'the question still goes somewhere');
    body.click(fakeButton('data-run-job'));
    assert.equal(asked.length, 2, 'the job button never types into a terminal');
    assert.equal(jobs.length, 2);
  } finally {
    setRunAsker(null, null);
  }
});

test('a draft for an AI: one line in any language, never a control character (no Enter, no escape sequence)', () => {
  const ch = (n) => String.fromCharCode(n);
  assert.ok(aiDraftOk(STRINGS.tr.runAsk) && aiDraftOk(STRINGS.en.runAsk));
  assert.ok(aiDraftOk('ğüşiöç ĞÜŞİÖÇ'));
  for (const n of [0, 9, 10, 13, 27, 127, 0x9b]) assert.equal(aiDraftOk(`a${ch(n)}b`), false, `code ${n}`);
  assert.equal(aiDraftOk(''), false);
  assert.equal(aiDraftOk('x'.repeat(AI_DRAFT_MAX)), true);
  assert.equal(aiDraftOk('x'.repeat(AI_DRAFT_MAX + 1)), false);
  assert.equal(aiDraftOk(null), false);
});

test('wiring: the dock types the draft into the running AI tab only after the check; main.js asks it; the drawer fills its job box', () => {
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  const body = dock.slice(dock.indexOf('function askAi('), dock.indexOf('// The AI tabs that still run'));
  assert.ok(body.indexOf('if (!aiDraftOk(text))') < body.indexOf('api.write(id, text)') && body.includes('pickRunningTab(tabs, projectId)'));
  const main = fs.readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  assert.ok(main.includes('setRunAsker((projectId, text) => termDock.askAi(projectId, text), (projectId) => termDock.running().some((x) => x.projectId === projectId));'));
  const drawer = fs.readFileSync(new URL('../public/js/views/drawer.js', import.meta.url), 'utf8');
  assert.ok(drawer.includes('bindRunHint(body, { projectOf: () => (current?.type === \'project\' ? current.id : null), asJob: fillJob });'));
});
