// The Helpers screen (review U14): the latest project's strong fits lead it, and an empty library with the kit there
// says first that the built-in helpers are ready.
// Run: node --test test/roster-suggest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { suggestProject, suggestItems, suggestHtml, SUGGEST_MAX } from '../public/js/views/roster.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the project: the most recently active of the person’s own; broad, temporary, missing and moved-away folders never', () => {
  const projects = new Map([
    ['a', { id: 'a', name: 'Eski', path: 'C:/p/a', lastActivity: 100 }],
    ['b', { id: 'b', name: 'Yeni', path: 'C:/p/b', lastActivity: 300 }],
    ['home', { id: 'home', path: 'C:/Users/x', broad: true, lastActivity: 999 }],
    ['tmp', { id: 'tmp', path: 'C:/t', tmpOnly: true, lastActivity: 999 }],
    ['gone', { id: 'gone', path: 'C:/g', exists: false, lastActivity: 999 }],
    ['moved', { id: 'moved', path: 'C:/m', toolsOnly: true, lastActivity: 999 }],
    ['nopath', { id: 'nopath', lastActivity: 999 }],
  ]);
  assert.equal(suggestProject(projects).id, 'b');
  assert.equal(suggestProject([...projects.values()]).id, 'b');
  assert.equal(suggestProject(new Map()), null);
  assert.equal(suggestProject(null), null);
});

test('the items: installable, not installed, from the kit or the library; strong ones first, then possible ones; at most SUGGEST_MAX; a fit with a problem gives none', () => {
  const c = (name, over = {}) => ({ kind: 'skill', name, sources: ['kit'], confidence: 'high', installable: true, installed: false, ...over });
  const fit = {
    candidates: [
      c('ui-check'),
      c('weak', { confidence: 'medium' }),
      c('low', { confidence: 'low' }),
      c('there', { installed: true }),
      c('blocked', { installable: false }),
      c('from-logs', { sources: ['other'] }),
      c('mine', { sources: ['library'] }),
      c('a1'),
      c('a2'),
      c('a3'),
    ],
  };
  assert.deepEqual(suggestItems(fit).map((x) => x.name), ['ui-check', 'mine', 'a1', 'a2']);
  // Room left: the possible ones after the strong ones, never a low one
  assert.deepEqual(suggestItems({ candidates: [c('m1', { confidence: 'medium' }), c('h1'), c('l1', { confidence: 'low' })] }).map((x) => x.name), ['h1', 'm1']);
  assert.equal(SUGGEST_MAX, 4);
  for (const bad of [null, {}, { problem: 'broad', candidates: [c('x')] }, { candidates: 'x' }]) assert.deepEqual(suggestItems(bad), []);
});

test('the section: the project’s name, the kit’s plain summary, one button to the project’s drawer; nothing when nothing fits', () => {
  for (const lang of ['en', 'tr']) {
    setLanguage(lang);
    const p = { id: 'x-site', name: 'Tarif sitem' };
    const html = suggestHtml(p, [{ kind: 'skill', name: 'ui-check', sources: ['kit'], description: 'Checks a UI.' }, { kind: 'agent', name: 'reviewer', sources: ['library'], description: 'Reviews code.' }]);
    assert.ok(html.includes(STRINGS[lang].rfSuggestTitle.replace('{name}', 'Tarif sitem')));
    assert.ok(html.includes('data-suggest-open="x-site"'));
    assert.equal((html.match(/<li>/g) || []).length, 2);
    assert.ok(html.includes('Reviews code.'), 'a library item keeps its own description');
    assert.equal(suggestHtml(p, []), '');
    assert.equal(suggestHtml(null, [{ kind: 'skill', name: 'x', sources: ['kit'] }]), '');
    for (const k of ['rfKitLeadTitle', 'rfKitLeadNote', 'rfKitLeadOwn', 'rfSuggestTitle', 'rfSuggestNote', 'rfSuggestOpen']) assert.ok(STRINGS[lang][k]?.trim(), `${lang}: ${k}`);
  }
  setLanguage('en');
});

test('wiring: the section sits above the library card, opens the drawer at its skills; an empty library with the kit leads with the kit', () => {
  const src = read('public/js/views/roster.js');
  assert.ok(src.indexOf('<div data-k="suggest"></div>') < src.indexOf('<div class="roster-top">'));
  assert.ok(src.includes("openDrawer({ type: 'project', id: b.dataset.suggestOpen, section: 'skills' })"));
  assert.ok(src.includes('fetchFitFor(id, idea, { signal: timeoutSignal(SUGGEST_TIMEOUT_MS) })'), 'the same fit the drawer asks for, with a time limit');
  const card = src.slice(src.indexOf('if (empty && kit.total) {'), src.indexOf('return `<section class="lib-card${empty'));
  assert.ok(card.includes('act-btn primary lc-show') && card.includes('data-folder="group:kit"'), 'the kit is the primary');
  assert.ok(!card.includes('act-btn primary lc-add'), 'adding a folder is secondary');
});

test('createSuggest: one request per project and minute; an answer for a project no longer shown is dropped; a failure keeps the last list', async () => {
  const { createSuggest } = await import('../public/js/views/roster.js');
  let clock = 0;
  const asks = [];
  const answers = new Map();
  const fetchFit = (id, idea) => {
    asks.push([id, idea]);
    const a = answers.get(id);
    return typeof a === 'function' ? a() : Promise.resolve(a);
  };
  let changes = 0;
  const s = createSuggest({ fetchFit, onChange: () => changes++, now: () => clock, ttl: 1000 });
  const fit = (...names) => ({ candidates: names.map((name) => ({ kind: 'skill', name, sources: ['kit'], confidence: 'high', installable: true, installed: false })) });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  answers.set('a', fit('one'));
  assert.deepEqual(s.itemsFor({ id: 'a', idea: '  my\nidea  ' }), [], 'nothing known yet');
  assert.deepEqual(asks, [], 'asked on the next turn');
  await tick();
  await tick();
  assert.deepEqual(asks, [['a', 'my idea']], 'the idea cleaned as the drawer cleans it');
  assert.equal(changes, 1);
  assert.deepEqual(s.itemsFor({ id: 'a' }).map((x) => x.name), ['one']);
  assert.equal(asks.length, 1, 'not asked again within the minute');
  // After the minute: asked again; a failure keeps the list
  clock = 2000;
  answers.set('a', () => Promise.reject(new Error('500')));
  assert.deepEqual(s.itemsFor({ id: 'a' }).map((x) => x.name), ['one']);
  await tick();
  await tick();
  assert.equal(asks.length, 2);
  assert.deepEqual(s.itemsFor({ id: 'a' }).map((x) => x.name), ['one'], 'the last list stays');
  // A slow answer for b, then the screen shows c: b's answer never shows for c
  clock = 5000;
  let release;
  answers.set('b', () => new Promise((r) => (release = () => r(fit('for-b')))));
  answers.set('c', fit('for-c'));
  s.itemsFor({ id: 'b' });
  await tick();
  assert.deepEqual(s.itemsFor({ id: 'c' }), [], 'c waits while b is asked');
  release();
  await tick();
  await tick();
  assert.deepEqual(s.itemsFor({ id: 'c' }), [], 'b answered: c is asked now');
  await tick();
  await tick();
  assert.deepEqual(s.itemsFor({ id: 'c' }).map((x) => x.name), ['for-c']);
  assert.deepEqual(s.itemsFor(null), []);
});
