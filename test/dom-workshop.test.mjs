// The Building in a browser (plan D1, happy-dom; the canvas draws nothing): one primary action, and the list keeps the
// strip and the job row current (review B/C round 2: in the list the whole loop had stopped, so nothing was drawn at
// all when the list was the remembered choice). Run: node --test test/dom-workshop.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { win, wait, click, setRoutes, closeWindow } from './dom/env.mjs';

after(() => closeWindow());
// happy-dom lays nothing out: an element in the document counts as shown (the Building draws only when it is)
Object.defineProperty(win.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.isConnected ? this.parentElement : null; } });
// The person chose the list before: it is how the Building opens
win.localStorage.setItem('sibersentez.workshop.view', 'list');

const { setLanguage, STRINGS } = await import('../public/js/i18n.js');
const { store } = await import('../public/js/store.js');
const { createWorkshop } = await import('../public/js/views/workshop.js');
setLanguage('tr');
setRoutes({
  'GET /api/projects/kafe/team': { project: 'kafe', step: 'none', history: [] },
  'GET /api/projects/kafe/fit': { project: 'kafe', items: [], tags: [] },
});
store.load(JSON.parse(fs.readFileSync(new URL('./dom/fixtures/snapshot.json', import.meta.url), 'utf8')));
const root = win.document.createElement('div');
win.document.body.append(root);
const ws = createWorkshop(root, { store, autoGuide: false, giveJob: async () => ({ ok: true }) });
const $ = (name) => root.querySelector(`[data-ws="${name}"]`);
await wait(400);

test('the remembered list: the Building opens in it and still fills the strip, the job row and the empty note', () => {
  assert.ok(root.classList.contains('ws-list-mode'));
  assert.equal($('view').getAttribute('aria-pressed'), 'true');
  assert.equal($('view').textContent, STRINGS.tr.wsListView, 'a fixed label; the state is in aria-pressed');
  assert.ok($('next-text').textContent.trim().length > 0, 'the strip says the next step (the loop runs in the list)');
  assert.equal($('list-empty').hidden, false, 'nobody at work: said');
});

test('one primary action: with nobody needed, Start leads and the strip\'s button does not', () => {
  assert.equal($('give-go').classList.contains('quiet'), false);
  assert.equal($('next-go').classList.contains('primary'), false);
  assert.ok($('play').classList.contains('quiet'), 'Play is quiet on a live Building');
});

test('back to the Building: the switch says so, the choice is kept', async () => {
  click($('view'));
  await wait(100);
  assert.equal(root.classList.contains('ws-list-mode'), false);
  assert.equal($('view').getAttribute('aria-pressed'), 'false');
  assert.equal(win.localStorage.getItem('sibersentez.workshop.view'), 'building');
  ws.destroy?.();
});
