// A narrow window keeps the header on one line (review U15): the buttons become icons with their names kept for
// screen readers, and the actions indicator keeps its mode's name.
// Run: node --test test/narrow-header.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { indicatorModel, indicatorPartsHtml } from '../public/js/actionsSwitch.js';
import { setLanguage } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// The text of a small piece of markup, read only in this test: the pieces between its tags, joined
const strip = (html) => html.split(/<[^>]*>/).join('');

test('the indicator in parts: the same text as its accessible name, the mode name in a part of its own', () => {
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    for (const mode of ['off', 'dry', 'live', 'bogus']) {
      const html = indicatorPartsHtml(mode);
      assert.equal(strip(html), indicatorModel(mode, true).text, `${lang} ${mode}`);
      assert.match(html, /<span class="asw-mode">[^<]+<\/span>/);
      assert.match(html, /class="asw-pre"/);
      assert.match(html, /class="asw-state"/);
    }
  }
  setLanguage('en');
  assert.equal(strip(indicatorPartsHtml('off').match(/<span class="asw-mode">[^<]+<\/span>/)[0]), 'Off');
});

test('wiring: one line under 980 px; what is hidden keeps a name', () => {
  const css = read('public/css/polish.css');
  const rule = css.slice(css.indexOf('@media (max-width: 980px) {', css.indexOf('review U15')));
  for (const s of ['flex-wrap: nowrap !important', '.topbar .search-btn span, .topbar .search-btn kbd { display: none !important; }', '.topbar .wait-chip:not(.on) span { display: none; }', '.topbar .new-proj span { display: none; }', '.topbar .act-mode .asw-pre, .topbar .act-mode .asw-state { display: none; }']) assert.ok(rule.includes(s), s);
  assert.ok(read('public/index.html').indexOf('studio-pro.css') < read('public/index.html').indexOf('polish.css'), 'after the theme');
  const main = read('public/js/main.js');
  assert.ok(main.includes("$('#paletteBtn').setAttribute('aria-label', t('palInputAria'));"));
  assert.ok(main.includes("newProjectBtn.setAttribute('aria-label', t('newProjectButton'));"));
  assert.ok(read('public/js/views/waiting.js').includes("chipEl.setAttribute('aria-label', n ?"));
  assert.ok(read('public/js/actionsSwitch.js').includes('<span>${indicatorPartsHtml(state.current)}</span>'));
});

test('reading text has a 13.5–14 px floor; short secondary marks stay small (review U16)', () => {
  const css = read('public/css/polish.css');
  const block = css.slice(css.indexOf('review U16'));
  // The first rule of the block whose selector list starts with sel: its font-size
  const size = (sel) => {
    const line = block.split('\n').find((l) => l.startsWith(sel + ' ') || l.startsWith(sel + ','));
    const m = line ? /font-size: ([0-9.]+)px/.exec(line) : null;
    return m ? Number(m[1]) : null;
  };
  for (const [sel, min] of [['.small', 13.5], ['.screen-subtitle', 14], ['.pdesc', 13.5], ['.ws-head p', 14], ['.ws-card p', 14], ['.ws-note', 13], ['.ws-hint', 12.5]]) {
    const v = size(sel);
    assert.ok(v !== null && v >= min, `${sel}: ${v}`);
  }
  // Loaded after the Workshop and the theme, so these win
  const html = read('public/index.html');
  assert.ok(html.indexOf('workshop.css') < html.indexOf('polish.css') && html.indexOf('studio-pro.css') < html.indexOf('polish.css'));
});
