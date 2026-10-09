// "Learn by doing" (plan C5): five small jobs after the first ten minutes, each a sample job for the Building's box (Start
// stays the person's) or the restore points; ticked by the person. Run: node --test test/learn-path.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { learnModel, learnHtml, LEARN_STEPS } from '../public/js/views/learnPath.js';
import { setLanguage, STRINGS, LANGUAGES } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('shown only after the first ten minutes, until all five are done or it is hidden; the next step leads', () => {
  assert.equal(learnModel({ ready: false }).show, false, 'not before the first ten minutes');
  assert.equal(learnModel({ ready: true, hidden: true }).show, false);
  assert.equal(learnModel({ ready: true, done: [...LEARN_STEPS] }).show, false, 'all done');
  const m = learnModel({ ready: true, done: ['page', 'bogus'] });
  assert.deepEqual([m.show, m.next, m.steps.filter((s) => s.done).map((s) => s.id)], [true, 'look', ['page']]);
});

test('each step: a sample job into the box (never started from here), the last one the restore points; one primary', () => {
  setLanguage('tr');
  try {
    const h = learnHtml(learnModel({ ready: true, done: ['page'] }));
    assert.ok(h.includes(STRINGS.tr.lpTitle) && h.includes('5 adımdan 1 tamam'));
    assert.equal((h.match(/act-btn primary/g) || []).length, 0, 'no primary: the box\'s Start or the strip leads the Building (review B/C)');
    assert.match(h, /class="lp-step now"><div><b>Görünüşünü değiştir/, 'the next step is marked');
    assert.doesNotMatch(h, /aria-pressed/, 'the tick\'s label says its state');
    assert.match(h, /data-lp="back"/);
    assert.ok(!h.includes('data-lp-step="page"><svg'), 'a done step offers no job again');
    assert.equal(learnHtml(learnModel({ ready: false })), '');
  } finally {
    setLanguage('en');
  }
  for (const lang of LANGUAGES) for (const id of LEARN_STEPS) for (const k of [`lp_${id}`, `lp_${id}_why`]) assert.ok(STRINGS[lang][k]?.trim(), `${lang}.${k}`);
  for (const lang of LANGUAGES) for (const id of LEARN_STEPS.filter((x) => x !== 'back')) assert.doesNotMatch(STRINGS[lang][`lp_${id}_job`], /[\r\n]/, `${lang}: ${id} is one line`);
});

test('wiring: under the first ten minutes on the Building; the box gets the text, Start is never pressed', () => {
  assert.ok(read('public/index.html').includes('<div class="today-learn" id="todayLearn" hidden></div>'));
  const main = read('public/js/main.js');
  assert.ok(main.includes("const learnPath = createLearnPath($('#todayLearn'), {"));
  const block = main.slice(main.indexOf('const learnPath = createLearnPath'), main.indexOf('// Advanced views (docs/direction.md'));
  assert.doesNotMatch(block, /give-go|\.click\(\)|requestSubmit|submit\(/, 'nothing is started from the card');
  assert.ok(block.includes("open({ type: 'project', id, section: 'restore' })"));
});

test('compact: one line with the next step; the whole list behind "All steps" (the packaged QA: the list pushed the Building\'s strip below the first screen)', () => {
  const h = learnHtml(learnModel({ ready: true, done: ['page'] }));
  const head = h.slice(0, h.indexOf('<details class="lp-all">'));
  assert.equal((head.match(/data-lp="write"/g) || []).length, 1, 'one step\'s button in sight');
  assert.match(head, /data-lp-step="look"/);
  assert.ok(h.includes('<details class="lp-all"><summary'), 'the list is folded');
  assert.ok(!/<details class="lp-all" open/.test(h));
});
