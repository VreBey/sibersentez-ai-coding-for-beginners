// Settings › General's restore copies row in a browser (happy-dom, a fake server; independent review 2026-10-20, T05):
// counted when Settings is drawn, the removal asked once, its result kept once the copies are counted again, a failed
// removal said. Run: node --test test/dom-settings-disk.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { settle, win, click, requests, setRoutes, closeWindow } from './dom/env.mjs';

after(() => closeWindow());
const { setLanguage, STRINGS } = await import('../public/js/i18n.js');
const { initActions } = await import('../public/js/actions.js');
const { createSettingsView } = await import('../public/js/views/settings.js');
setLanguage('tr');
const S = STRINGS.tr;
const KEY = 'a'.repeat(24);
let orphans = [{ key: KEY, projectId: 'x-eski-site', points: 2, bytes: 3 * 1024 * 1024 }];
let clean = () => ({ ok: true, mode: 'live', action: 'restore-clean', result: { executed: true, removed: [KEY], kept: [] } });
setRoutes({
  'GET /api/actions': { mode: 'live', token: 'a'.repeat(64), actions: ['restore-clean'] },
  'GET /api/restore-disk': () => ({ bytes: 5 * 1024 * 1024, projects: 2, orphans }),
  'GET /api/tools': { at: 1, tools: [], node: { installed: true }, git: { installed: true, onPath: true } },
  'POST /api/action': () => clean(),
});
await initActions();
const root = win.document.createElement('div');
win.document.body.append(root);
const view = createSettingsView(root);
const row = () => root.querySelector('.set-disk')?.textContent || '';
const until = async (cond) => {
  for (let i = 0; i < 50 && !cond(); i++) await settle();
  assert.ok(cond());
};

test('counted when drawn; the removal is asked once, sent with the keys, and its result stays after the new count', async () => {
  view.render();
  await until(() => row().includes('x-eski-site'));
  assert.ok(row().includes(S.setDiskTotal.replace('{size}', '5 MB')));
  click(root.querySelector('[data-set-act="disk-clean"]'));
  await settle();
  assert.equal(requests.filter((r) => r.key === 'POST /api/action').length, 0, 'asked first');
  assert.ok(root.querySelector('[data-set-act="disk-yes"]'));
  orphans = [];
  click(root.querySelector('[data-set-act="disk-yes"]'));
  await until(() => row().includes(S.setDiskDone.replace('{count}', '1')));
  const sent = requests.filter((r) => r.key === 'POST /api/action').map((r) => r.body);
  assert.deepEqual(sent.map((b) => [b.action, b.keys]), [['restore-clean', [KEY]]]);
  assert.ok(!root.querySelector('[data-set-act="disk-clean"]'), 'nothing left to remove');
});

test('a removal that fails is said, and the row is not counted again over it', async () => {
  orphans = [{ key: KEY, projectId: 'x-eski-site', points: 2, bytes: 1024 }];
  clean = () => ({ ok: false, mode: 'live', error: 'busy' });
  // A new count (Settings drawn again later) shows the folder again
  const again = createSettingsView(root);
  root.innerHTML = '';
  root._html = '';
  again.render();
  await until(() => !!root.querySelector('[data-set-act="disk-clean"]'));
  click(root.querySelector('[data-set-act="disk-clean"]'));
  await settle();
  click(root.querySelector('[data-set-act="disk-yes"]'));
  await until(() => row().includes(S.setDiskCleanFailed));
  setLanguage('en');
});
