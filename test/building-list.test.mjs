// Building / List (review U18, plan C1): the same data and the same buttons; the list shows the people and robots as
// the keyboard's own buttons, the moving picture rests. Run: node --test test/building-list.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STRINGS, LANGUAGES } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the switch is in the toolbar, keeps its choice in this browser and says which view it leads to', () => {
  const ws = read('public/js/views/workshop.js');
  assert.ok(ws.includes(`<button type="button" data-ws="view" aria-pressed="false">\${esc(word('listView'))}</button>`));
  assert.ok(ws.includes("const LIST_KEY = 'sibersentez.workshop.view';"));
  assert.ok(ws.includes("root.classList.toggle('ws-list-mode', on);") && ws.includes("$('view').setAttribute('aria-pressed', String(on));"));
  assert.ok(ws.includes("$('list-empty').hidden = scene.actors.length > 0;"));
  for (const lang of LANGUAGES) for (const k of ['wsListView', 'wsBuildingView', 'wsListEmpty']) assert.ok(STRINGS[lang][k]?.trim(), `${lang}.${k}`);
});

test('the list: only the people and robots, visible and plain; the picture, the rooms and the hint rest', () => {
  const css = read('public/css/workshop.css');
  for (const rule of ['.ws-list-mode .ws-stage canvas, .ws-list-mode .ws-sign, .ws-list-mode .ws-hint, .ws-list-mode .ws-rooms { display: none; }', '.ws-list-mode .ws-nav button[data-actor] { position: static;', '.ws-list-mode .ws-nav button:not([data-actor]) { display: none; }', '.ws:not(.ws-list-mode) .ws-list-empty { display: none; }']) {
    assert.ok(css.includes(rule), rule);
  }
});
