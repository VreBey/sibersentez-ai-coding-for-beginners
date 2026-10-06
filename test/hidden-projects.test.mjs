// Hiding a project from the lists (public/js/hiddenProjects.js, 2026-10-02): this browser only, nothing on disk; a
// hidden project folds into "Other folders" and comes back from the same menu.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// A browser's storage, for the module (node has none)
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const { isHiddenProject, setProjectHidden, onHiddenChange, resetHiddenProjects } = await import('../public/js/hiddenProjects.js');
const { isOtherFolder } = await import('../public/js/attention.js');
const { projectGroups } = await import('../public/js/views/projects.js');
const { runMenuItem } = await import('../public/js/contextmenu.js');
const { STRINGS } = await import('../public/js/i18n.js');

beforeEach(() => {
  mem.clear();
  resetHiddenProjects();
});

test('hidden ids are kept in this browser; a hidden project counts as one of the other folders; shown again it is back', () => {
  const p = { id: 'deneme', name: 'deneme', kind: 'adhoc', path: 'C:\\deneme', lastActivity: Date.now() };
  assert.equal(isOtherFolder(p), false);
  const heard = [];
  const off = onHiddenChange((id, hidden) => heard.push([id, hidden]));
  assert.equal(setProjectHidden('deneme', true), true);
  assert.equal(setProjectHidden('deneme', true), false, 'already hidden: no change');
  assert.equal(isHiddenProject('deneme'), true);
  assert.equal(isOtherFolder(p), true);
  assert.deepEqual(JSON.parse(mem.get('sibersentez.hiddenProjects')), ['deneme']);
  const groups = projectGroups([p, { id: 'real', name: 'real', kind: 'registered', path: 'C:\\real', lastActivity: Date.now() }], { sort: 'activity' });
  assert.deepEqual(groups.map((g) => [g.items.map((x) => x.id).join(','), !!g.other]), [['real', false], ['deneme', true]]);
  resetHiddenProjects();
  assert.equal(isHiddenProject('deneme'), true, 'read back from storage');
  setProjectHidden('deneme', false);
  assert.equal(isOtherFolder(p), false);
  assert.deepEqual(heard, [['deneme', true], ['deneme', false]]);
  off();
});

test('broken or blocked storage hides nothing and never throws', () => {
  mem.set('sibersentez.hiddenProjects', '{not json');
  assert.equal(isHiddenProject('x'), false);
  resetHiddenProjects();
  mem.set('sibersentez.hiddenProjects', JSON.stringify([1, null, 'ok']));
  assert.equal(isHiddenProject('ok'), true);
  assert.equal(isHiddenProject(1), false);
});

test('the project menu hides and shows again; the item says so in both languages and runs nothing', async () => {
  const toasts = [];
  await runMenuItem({ id: 'hide', label: 'x', hide: { id: 'deneme', hidden: true } }, { toast: (o) => toasts.push(o) });
  assert.equal(isHiddenProject('deneme'), true);
  await runMenuItem({ id: 'unhide', label: 'x', hide: { id: 'deneme', hidden: false } }, { toast: (o) => toasts.push(o) });
  assert.equal(isHiddenProject('deneme'), false);
  assert.deepEqual(toasts.map((o) => o.title), [STRINGS.en.prjHidden, STRINGS.en.prjShown]);
  for (const lang of ['en', 'tr']) for (const k of ['prjHide', 'prjUnhide', 'prjHideHint', 'prjHidden', 'prjHiddenBody', 'prjShown', 'prjHiddenTag']) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
  const menu = fs.readFileSync(new URL('../public/js/contextmenu.js', import.meta.url), 'utf8');
  assert.ok(menu.includes("hide: { id: p.id, hidden: !hidden }"));
});
