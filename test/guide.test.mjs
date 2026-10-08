// First-run guide (docs/first-run.md): the steps and their strings, when it opens by itself, the stored "seen" value,
// the step markup and how the page wires it (header button, ? key, palette command).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE_STEPS, GUIDE_KEY, GUIDE_VERSION, GLOSSARY, glossaryHtml, clampStep, shouldAutoOpen, startStep, readSeen, markSeen, stepHtml } from '../public/js/guide.js';
import { STRINGS, LANGUAGES, setLanguage } from '../public/js/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}
const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };

test('every step has a title and a body in every language, and a button text when it has a button', () => {
  assert.equal(GUIDE_STEPS[0].id, 'welcome');
  assert.equal(GUIDE_STEPS.at(-1).id, 'work');
  assert.equal(new Set(GUIDE_STEPS.map((s) => s.id)).size, GUIDE_STEPS.length);
  for (const lang of LANGUAGES) {
    for (const s of GUIDE_STEPS) {
      assert.ok(STRINGS[lang][`guide_${s.id}_title`], `${lang} ${s.id} title`);
      assert.ok(STRINGS[lang][`guide_${s.id}_body`], `${lang} ${s.id} body`);
      if (s.go) assert.ok(STRINGS[lang][`guide_${s.id}_go`], `${lang} ${s.id} go`);
    }
    assert.match(STRINGS[lang].guide_modes_body, /\{mode\}/);
  }
});

test('the guide never opens by itself (docs/direction.md §3.3: the start card links to it); ?guide opens it', () => {
  assert.equal(shouldAutoOpen({}), false, 'a first start: the start card, not a tour on top of it');
  assert.equal(shouldAutoOpen({ stored: String(GUIDE_VERSION) }), false);
  assert.equal(shouldAutoOpen({ stored: '0' }), false);
  assert.equal(shouldAutoOpen({ qa: true }), false);
  assert.equal(shouldAutoOpen({ qa: true, param: '1' }), true);
  assert.equal(shouldAutoOpen({ qa: true, param: 'step:3' }), true);
  assert.equal(shouldAutoOpen({ qa: true, param: 'yes' }), false);
  assert.equal(shouldAutoOpen({ stored: String(GUIDE_VERSION), param: '1' }), true);
});

test('start step: ?guide=step:<n> is clamped to the steps; anything else starts at the first', () => {
  assert.equal(startStep('step:2'), 2);
  assert.equal(startStep('step:99'), GUIDE_STEPS.length - 1);
  assert.equal(startStep('1'), 0);
  assert.equal(startStep(null), 0);
  assert.equal(clampStep(-4), 0);
  assert.equal(clampStep(1.5), 0);
});

test('seen: stored under its key; a blocked storage neither throws nor counts as seen', () => {
  const s = memoryStorage();
  assert.equal(readSeen(s), null);
  assert.equal(markSeen(s), true);
  assert.equal(s.map.get(GUIDE_KEY), String(GUIDE_VERSION));
  assert.equal(shouldAutoOpen({ stored: readSeen(s) }), false);
  assert.equal(readSeen(blocked), null);
  assert.equal(markSeen(blocked), false);
  assert.equal(readSeen(undefined), null);
});

test('step markup: Skip on the first step, Back after it, Start on the last; a missing action hides its button', () => {
  setLanguage('en');
  const first = stepHtml(0);
  assert.match(first, /data-guide="close"[^>]*>Skip</);
  assert.match(first, /data-guide="next"/);
  assert.match(first, /class="guide-again"/);
  const mid = stepHtml(2);
  assert.match(mid, /data-guide="back"/);
  assert.match(mid, /data-guide-go="newProject"/);
  assert.doesNotMatch(stepHtml(2, { available: () => false }), /data-guide-go/);
  const last = stepHtml(GUIDE_STEPS.length - 1, { mode: 'dry', available: (k) => k !== 'actions' });
  assert.match(last, /data-guide="close"[^>]*>Start</);
  assert.doesNotMatch(last, /data-guide="next"/);
  assert.doesNotMatch(last, /data-guide-go/);
  const modes = stepHtml(GUIDE_STEPS.findIndex((s) => s.id === 'modes'), { mode: 'dry', available: (k) => k !== 'actions' });
  assert.match(modes, /Now: Preview\./);
  assert.doesNotMatch(modes, /data-guide-go/, 'no actions panel: no button');
  assert.equal((last.match(/class="guide-dot[ "]/g) || []).length, GUIDE_STEPS.length);
  assert.match(last, /aria-current="step"/);
  setLanguage('tr');
  assert.match(stepHtml(GUIDE_STEPS.findIndex((s) => s.id === 'modes'), { mode: 'live' }), /Şu an: Açık\./);
  setLanguage('en');
});

test('the page wires the guide: header button, stylesheet, ? key, palette command, auto-open after start', () => {
  const html = read('public', 'index.html');
  // The guide's button sits at the foot of the menu (docs/shell.md), labelled "Guide", titled like before
  assert.match(html, /id="guideBtn"[^>]*data-i18n-attr="title:guideBtnLabel"/);
  assert.match(html, /href="\/css\/guide.css"/);
  const main = read('public', 'js', 'main.js');
  assert.match(main, /createGuide\(/);
  assert.match(main, /e\.key === '\?'[^\n]*guide\.show\(\)/);
  assert.match(main, /palette\.isOpen\(\) \|\| guide\.isOpen\(\)/);
  // In the palette's commands (after "Give a job" and "New project" since 2026-10-02)
  assert.match(main, /commands: \[[\s\S]*?\{ id: 'guide'/);
  // The tools panel (setup check) is one click away as well: a header button and a palette command
  assert.match(main, /\{ id: 'tools', label: t\('aiPalette'\)[^\n]*run: \(\) => openToolsPanel\(\) \}/);
  assert.match(main, /\$\('#toolsBtn'\)\.addEventListener\('click', \(\) => openToolsPanel\(\)\)/);
  assert.match(read('public', 'index.html'), /id="toolsBtn"[^>]*data-i18n-attr="title:aiHeaderBtn"/);
  // The mode arrives after the first render: the open step is drawn again when it does
  assert.match(main, /onActionsChange\(\(\) => guide\.refresh\(\)\)/);
  assert.match(main, /shouldAutoOpen\(\{ stored: readSeen\(\), qa: QA, param: params\.get\('guide'\) \}\)/);
  assert.doesNotMatch(main, /<span>Ara<\/span>/, 'the search button text comes from the string table');
  const pal = read('public', 'js', 'palette.js');
  assert.match(pal, /if \(r\.run\) \{\n      beforeRun\(\);\n      return r\.run\(\);/, 'a command runs after the drawer closed (review U02)');
  // Code and comments stay English (the Turkish words live in the string table and in the palette's search words)
  assert.doesNotMatch(read('public', 'js', 'guide.js'), /[çğıöşüÇĞİÖŞÜ]/);
});

test('the words the app uses, each said plainly (review U11): every word has a name and a meaning in both languages; every step links to them; the palette opens them', () => {
  for (const lang of LANGUAGES) {
    setLanguage(lang);
    for (const id of GLOSSARY) {
      assert.ok(STRINGS[lang][`gl_${id}_t`]?.trim(), `${lang} gl_${id}_t`);
      assert.ok(STRINGS[lang][`gl_${id}_d`]?.trim(), `${lang} gl_${id}_d`);
    }
    const html = glossaryHtml();
    assert.equal((html.match(/<dt>/g) || []).length, GLOSSARY.length);
    assert.match(html, /data-guide="words-back"/, 'back to the step it was opened from');
    assert.match(html, /id="guideTitle"/, 'the dialog keeps its accessible name');
    for (let i = 0; i < GUIDE_STEPS.length; i++) assert.match(stepHtml(i), /data-guide="words"/, `step ${i}`);
  }
  setLanguage('en');
  // The technical name stays, in brackets, next to the plain one
  assert.match(STRINGS.tr.gl_skill_t, /\(skill\)/);
  assert.match(STRINGS.tr.gl_agent_t, /\(ajan\)/);
  // The menu, the subtitle and the restore section say what they are for
  assert.equal(STRINGS.tr.shTabRoster, 'Yardımcılar');
  assert.equal(STRINGS.tr.rstTitle, 'Önceki hâle dön');
  assert.doesNotMatch(STRINGS.tr.shBrandSub, /kontrol salonu/);
  // The guide's New project step follows the "New project" window (review U05)
  assert.doesNotMatch(STRINGS.tr.guide_idea_body, /bir klasör seç/);
  const guide = read('public', 'js', 'guide.js');
  assert.ok(guide.includes("else if (b.dataset.guide === 'words') showWords();"));
  assert.ok(guide.includes('return { show, hide, refresh, showWords,'));
  assert.ok(guide.includes("if (root.hidden || box.querySelector('.guide-words-list')) return;"), 'a mode change does not close the words');
  const main = read('public', 'js', 'main.js');
  assert.ok(main.includes("run: () => guide.showWords() },"));
});

test('the same words for going back everywhere (review U11): the drawer section and the Workshop button', () => {
  for (const lang of LANGUAGES) assert.equal(STRINGS[lang].wsPointOpen, STRINGS[lang].rstTitle, lang);
});
