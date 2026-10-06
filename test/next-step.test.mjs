// The next step above the building (public/js/nextStep.js, docs/development-review-2026-10-06.md §3): one sentence and
// one button, before every other control; the sign says the same. Run: node --test test/next-step.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { nextStep, NEXT_STEPS } from '../public/js/nextStep.js';
import { STRINGS } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the next step: the first that holds, in the order of what the person must do', () => {
  const all = { demo: true, past: true, hasProject: false, error: true, planPending: true, resultReady: true, waiting: 2, stopped: true, busy: true, running: true };
  const order = [];
  const facts = { ...all };
  for (const [key, off] of [['demo', 'demo'], ['past', 'past'], ['newProject', 'hasProject'], ['error', 'error'], ['plan', 'planPending'], ['result', 'resultReady'], ['waiting', 'waiting'], ['stopped', 'stopped'], ['working', 'busy'], ['running', 'running']]) {
    order.push(nextStep(facts).key);
    assert.equal(nextStep(facts).key, key);
    facts[off] = off === 'hasProject' ? true : off === 'waiting' ? 0 : false;
  }
  order.push(nextStep(facts).key);
  assert.deepEqual(order, NEXT_STEPS, 'every step reached, in the documented order');
  assert.deepEqual(nextStep(), { key: 'give', act: 'give' }, 'nothing known: say what should be done');
  assert.equal(nextStep({ busy: true }).act, null, 'nothing to do while the team works');
  assert.deepEqual(['demo', 'newProject', 'plan', 'result', 'waiting', 'stopped', 'running'].map((k) => nextStep({ demo: k === 'demo', hasProject: k !== 'newProject', planPending: k === 'plan', resultReady: k === 'result', waiting: k === 'waiting' ? 1 : 0, stopped: k === 'stopped', running: k === 'running' }).act), ['back-live', 'new-project', 'open-lead', 'open-lead', 'open-session', 'resume', 'show-terminal']);
});

test('every step has its sentence in both languages, and every step with a button its label', () => {
  for (const lang of ['en', 'tr']) {
    for (const key of NEXT_STEPS) {
      assert.ok(STRINGS[lang][`wsNext_${key}`], `${lang} wsNext_${key}`);
      if (nextStep({ demo: key === 'demo', past: key === 'past', hasProject: key !== 'newProject', error: key === 'error', planPending: key === 'plan', resultReady: key === 'result', waiting: key === 'waiting' ? 1 : 0, stopped: key === 'stopped', busy: key === 'working', running: key === 'running' }).act) assert.ok(STRINGS[lang][`wsNextGo_${key}`], `${lang} wsNextGo_${key}`);
    }
    for (const k of ['wsSignError', 'wsSignStopped']) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
  }
  assert.notEqual(STRINGS.en.wsNext_demo, STRINGS.tr.wsNext_demo);
});

test('the strip comes first on the building screen, the sign reads the same step, and its buttons reach real actions', () => {
  const ws = read('public/js/views/workshop.js');
  const tpl = ws.slice(ws.indexOf('const TEMPLATE'), ws.indexOf('</div>`;', ws.indexOf('const TEMPLATE')));
  const strip = tpl.indexOf('data-ws="next"');
  assert.ok(strip > 0 && strip < tpl.indexOf('class="ws-head"') && strip < tpl.indexOf('data-ws="nav"') && strip < tpl.indexOf('data-ws="jobbox"'), 'before the job box, the toolbar and the hidden navigation buttons');
  assert.ok(ws.includes('aria-live="polite"'), 'a screen reader hears a new step');
  assert.ok(ws.includes("const SIGN_OF_STEP = Object.freeze({ error: 'signError', plan: 'signPlan', result: 'signResult', waiting: 'waiting', stopped: 'signStopped', working: 'working', running: 'signRunning' });"), 'an error or a stopped job is never "resting" on the sign');
  assert.ok(ws.includes("word(mode === 'live' && liveMode ? SIGN_OF_STEP[next.key] || sceneSign : sceneSign)"), 'live and now, the sign reads the next step');
  assert.ok(ws.includes('past: live && !liveMode,'), 'a rewound moment is no next step: it says so');
  assert.ok(ws.includes("if (act === 'back-now') {") && ws.includes("$('live').click();"), 'and goes back to now');
  assert.ok(!ws.includes('return shownNext;'), 'the strip never freezes a step (another project\'s, or the past\'s)');
  assert.deepEqual(nextStep({ past: true, planPending: true, waiting: 1 }), { key: 'past', act: 'back-now' }, 'the past\'s plan or waiting session is not offered');
  assert.ok(ws.includes('const { act } = shownNext;'), 'the button does what is on screen');
  for (const act of ["act === 'back-live'", "act === 'open-lead'", "act === 'open-session'", "act === 'resume'", "act === 'give'", "act === 'jobbox'"]) assert.ok(ws.includes(act), act);
  const main = read('public/js/main.js');
  assert.ok(main.includes("d.action === 'new-project') newProject.start();"));
  assert.ok(main.includes("d.action === 'show-terminal' && d.projectId"));
  const css = read('public/css/workshop.css');
  assert.ok(css.includes('.ws-next {'));
});
