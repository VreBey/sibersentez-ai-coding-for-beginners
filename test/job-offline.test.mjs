// A lost connection is never a finish (review B8, UX plan §6.3): the job card says the page cannot reach its server
// and shows the last state as such, not as live. Run: node --test test/job-offline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { jobNowText, stepsHtml } from '../public/js/views/job.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('offline: every step but done says the connection is lost; never "the tool closed"; done stays done', () => {
  setLanguage('tr');
  try {
    for (const d of [{ step: 'plan' }, { step: 'plan', plan: { approved: true } }, { step: 'build', current: { id: 'T1', title: 'x' } }, { step: 'check' }, { step: 'finish' }]) {
      assert.equal(jobNowText(d, { offline: true, idle: true }), STRINGS.tr.jobNowOffline, d.step);
    }
    assert.equal(jobNowText({ step: 'done' }, { offline: true }), STRINGS.tr.jobNowDone);
    assert.notEqual(jobNowText({ step: 'build' }, { offline: false }), STRINGS.tr.jobNowOffline);
    assert.match(stepsHtml({ step: 'build' }, { offline: true }), /class="small job-now warn" role="status">Bağlantı kesildi/);
    assert.match(stepsHtml({ step: 'done' }, { offline: true }), /class="small job-now" role="status">/);
  } finally {
    setLanguage('en');
  }
});

test('wiring: the drawer and the building pass the connection; a drop and a reconnect redraw', () => {
  // Lost: the stream was there and dropped; not the moment before its first hello (review B/C: a flash at start)
  assert.ok(read('public/js/views/drawer.js').includes('offline: store.lost }'));
  assert.ok(read('public/js/views/drawer.js').includes('steps: stepsHtml(d, { offline: store.lost })'), 'the result\'s steps too');
  assert.ok(read('public/js/views/workshop.js').includes("stepsHtml(job, { offline: mode === 'live' && store.lost,"));
  const m = read('public/js/main.js');
  assert.ok(m.includes('    store.lost = true;\n    store.setStatus(false);') && m.includes('    store.lost = false;\n    store.setStatus(true);'));
  assert.ok(read('public/js/store.js').includes('this.lost = false;'), 'not lost before the first hello');
  const main = read('public/js/main.js');
  const err = main.indexOf('es.onerror = () => {');
  assert.ok(err > 0 && main.indexOf('schedule();', err) < main.indexOf('if (es.readyState === 2)', err), 'a drop redraws');
  const hello = main.indexOf("es.addEventListener('hello'");
  assert.ok(main.indexOf('schedule();', hello) < main.indexOf("es.addEventListener('scan'", hello), 'a reconnect redraws');
});
