// The full tour on an example (public/js/tour.js, 2026-10-05): every step has words in both languages, points at an
// element the page has, shows a moment of the Building's example, and never presses or starts anything.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TOUR_STEPS, tourStepHtml, clampTourStep, TOUR_EXAMPLE_KEY } from '../public/js/tour.js';
import { DEMO_MS } from '../public/js/hq-scene.js';
import { GUIDE_STEPS } from '../public/js/guide.js';
import { setLanguage, STRINGS } from '../public/js/i18n.js';

after(() => setLanguage('en'));
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('steps: words in both languages, a known scene, an example moment inside the example, unique ids', () => {
  assert.equal(new Set(TOUR_STEPS.map((s) => s.id)).size, TOUR_STEPS.length);
  for (const lang of ['en', 'tr']) {
    const S = STRINGS[lang];
    for (const k of ['tourCount', 'tourSim', 'tourClose', 'tourDone', 'tourPalette', 'tourPaletteSub', TOUR_EXAMPLE_KEY, 'guide_welcome_go']) assert.ok(S[k], `${lang} ${k}`);
    for (const s of TOUR_STEPS) assert.ok(S[`tour_${s.id}_title`] && S[`tour_${s.id}_body`], `${lang} ${s.id}`);
  }
  for (const s of TOUR_STEPS) {
    assert.ok(['home', 'type', 'example', 'live'].includes(s.scene), s.id);
    if (s.scene === 'example') assert.ok(Number.isFinite(s.at) && s.at >= 0 && s.at < DEMO_MS, s.id);
  }
  assert.equal(TOUR_STEPS[0].scene, 'home');
  assert.equal(TOUR_STEPS.at(-1).scene, 'live', 'the last step is live again');
});

test('the targets are elements the page draws (index.html or the Building\'s template)', () => {
  const html = read('public/index.html') + read('public/js/views/workshop.js');
  for (const s of TOUR_STEPS.filter((x) => x.target)) {
    const id = /^#([\w-]+)$/.exec(s.target)?.[1];
    const ws = /^\[data-ws="([\w-]+)"\]$/.exec(s.target)?.[1];
    const tab = /^\[data-tab="([\w-]+)"\]$/.exec(s.target)?.[1];
    assert.ok((id && html.includes(`id="${id}"`)) || (ws && html.includes(`data-ws="${ws}"`)) || (tab && html.includes(`data-tab="${tab}"`)), s.target);
  }
});

test('markup: the count, the simulation note, back from the second step, End on the last; escaped and clamped', () => {
  setLanguage('tr');
  const first = tourStepHtml(0);
  assert.ok(first.includes(STRINGS.tr.tourSim) && first.includes(`Tur 1 / ${TOUR_STEPS.length}`) && !first.includes('data-tour="back"'));
  const last = tourStepHtml(TOUR_STEPS.length - 1);
  assert.ok(last.includes('data-tour="back"') && last.includes(`data-tour="close">${STRINGS.tr.tourDone}`));
  assert.equal(clampTourStep(99), TOUR_STEPS.length - 1);
  assert.equal(clampTourStep(-3), 0);
  assert.equal(tourStepHtml(-3), tourStepHtml(0));
  setLanguage('en');
});

test('wiring: the guide\'s first step and the palette open it; the page sets each step up without pressing or starting anything, and puts everything back', () => {
  assert.equal(GUIDE_STEPS[0].go, 'tour');
  const main = read('public/js/main.js');
  assert.ok(main.includes('tour: leaveDrawer(() => tour.show()),') && main.includes("{ id: 'tour', label: t('tourPalette')"));
  const sceneFn = main.slice(main.indexOf('const tour = createTour({'), main.indexOf('const guide = createGuide({'));
  assert.ok(sceneFn.includes('workshop.example(s.at, { lead: !!s.lead })') && sceneFn.includes('workshop.live();') && sceneFn.includes('tourBox(false);'));
  for (const never of ['giveJob', 'runAction', 'runMenuItem', 'requestSubmit', '.click()']) assert.ok(!sceneFn.includes(never), `the tour never calls ${never}`);
  const ws = read('public/js/views/workshop.js');
  assert.ok(ws.includes('example(at, { lead = false } = {}) {') && ws.includes('quietGuide() {'));
});
