// Today's "First 10 minutes" checklist (public/js/views/checklist.js): ticks itself from what SiberSentez knows, points at
// the next step, goes away when all four are done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checklistModel, checklistHtml, STEPS } from '../public/js/views/checklist.js';
import { STRINGS, setLanguage } from '../public/js/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ready = (installed) => ({ status: 'ready', tools: [{ id: 'claude', installed }] });

test('model: each step ticks itself; the next step is the first one not done; the tools not known yet are pending, not missing', () => {
  const fresh = checklistModel({ tools: { status: 'loading', tools: [] }, mode: 'off', projects: [], sessions: [] });
  assert.deepEqual(fresh.steps.map((s) => [s.id, s.done, s.pending]), [['tool', false, true], ['actions', false, false], ['project', false, false], ['session', false, false]]);
  assert.equal(fresh.next, 'actions', 'a pending step is not the next one');
  const some = checklistModel({ tools: ready(true), mode: 'live', projects: [{ id: 'a', kind: 'registered' }], sessions: [] });
  assert.deepEqual([some.steps.map((s) => s.done), some.next, some.done], [[true, true, true, false], 'session', false]);
  const other = checklistModel({ tools: ready(false), mode: 'dry', projects: [{ id: 'tmp', kind: 'adhoc', place: 'temp' }], sessions: [] });
  assert.deepEqual(other.steps.map((s) => s.done), [false, false, false, false], 'Preview is not On; a folder that is not a project does not count');
  const all = checklistModel({ tools: ready(true), mode: 'live', projects: [{ id: 'a' }], sessions: [{ id: 's', projectId: 'a' }] });
  assert.equal(all.done, true);
  assert.equal(checklistHtml(all), '', 'all done: the list goes away');
  // The desktop app: Start asks once to turn actions on (2026-10-02), so that is no step there; numbered 1-3
  const app = checklistModel({ tools: ready(true), mode: 'off', projects: [{ id: 'a', kind: 'registered' }], sessions: [], askOnStart: true });
  assert.deepEqual(app.steps.map((s) => s.id), ['tool', 'project', 'session']);
  assert.equal(app.next, 'session');
  const h = checklistHtml(app);
  assert.ok(!h.includes('data-cl="actions"') && h.includes('<span class="cl-num">3</span>') && !h.includes('<span class="cl-num">4</span>'));
  // Done steps fold into one line of ticks; only the steps left are cards
  assert.equal((h.match(/class="cl-done-item"/g) || []).length, 2);
  assert.equal((h.match(/<li class="cl-row/g) || []).length, 1, 'one card: the step left');
});

test('html: both languages, the next step has the primary button, done steps have none, the actions step says where to turn it on outside the app', () => {
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      const S = STRINGS[lang];
      const m = checklistModel({ tools: ready(true), mode: 'off', projects: [], sessions: [] });
      const h = checklistHtml(m, { canActions: true });
      assert.ok(h.includes(S.clTitle) && h.includes(S.clHide), lang);
      assert.match(h, /class="act-btn primary" data-cl="actions"/);
      assert.ok(!h.includes('data-cl="tool"'), 'a done step has no button');
      for (const id of STEPS) assert.ok(S[`cl_${id}`] && S[`cl_${id}_why`] && S[`cl_${id}_go`], `${lang} ${id}`);
      assert.ok(!h.includes('data-cl="session"'), 'no project yet: no start button that would do nothing');
      const withProject = checklistHtml(checklistModel({ tools: ready(true), mode: 'live', projects: [{ id: 'a' }], sessions: [] }));
      assert.match(withProject, /class="act-btn primary" data-cl="session"/);
      const web = checklistHtml(m, { canActions: false });
      assert.ok(!web.includes('data-cl="actions"') && web.includes(S.clActionsApp));
    }
  } finally {
    setLanguage('en');
  }
});

test('wiring: the list sits first on Today, renders with the rest and when the tools or the mode change', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const today = html.slice(html.indexOf('id="tab-today"'), html.indexOf('id="hero"'));
  assert.ok(today.indexOf('id="todayChecklist"') < today.indexOf('id="workshopBody"'));
  const main = fs.readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8');
  for (const s of ['checklist.render();', 'onToolsChange(() => todayShown() && checklist.render());', 'onActionsChange(() => todayShown() && checklist.render());']) assert.ok(main.includes(s), s);
});

test('lists that redraw cancel the animations inside first (a running animation kept the removed row alive)', async () => {
  const { replaceHtml } = await import('../public/js/format.js');
  const log = [];
  const el = { getAnimations: (o) => (log.push(['get', o.subtree]), [{ cancel: () => log.push(['cancel', 1]) }, { cancel: () => log.push(['cancel', 2]) }]) };
  Object.defineProperty(el, 'innerHTML', { set: (v) => log.push(['html', v]) });
  replaceHtml(el, '<li>x</li>');
  assert.deepEqual(log, [['get', true], ['cancel', 1], ['cancel', 2], ['html', '<li>x</li>']], 'cancelled before the content goes');
  for (const [file, call] of [
    ['views/feed.js', "replaceHtml($('list'),"],
    ['views/feed.js', 'replaceHtml(el, html);'],
    ['views/drawer.js', 'replaceHtml(body, html);'],
    ['views/projects.js', 'replaceHtml(groupsEl, html);'],
    ['views/timeline.js', 'replaceHtml(wrap,'],
    ['views/today.js', 'replaceHtml(el, html);'],
    ['views/waiting.js', 'replaceHtml(todayEl, html);'],
    ['main.js', 'replaceHtml(el, html);'],
  ]) assert.ok(fs.readFileSync(path.join(ROOT, 'public', 'js', file), 'utf8').includes(call), `${file}: ${call}`);
});

test('a destroyed scene cancels its pending frame (while no frames ran, the callback kept the old scene alive)', () => {
  for (const file of ['stage.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', file), 'utf8');
    const destroy = src.slice(src.indexOf('  destroy() {'), src.indexOf('\n  }\n', src.indexOf('  destroy() {')));
    assert.ok(destroy.includes('cancelAnimationFrame(this.frameId);'), file);
    assert.ok(!/[^.]requestAnimationFrame\(/.test(src.replace(/this\.frameId = requestAnimationFrame\(/g, '')), `${file}: every frame request is kept in frameId`);
  }
});

test('screens: Today\'s parts draw only while Today shows, a screen without a gap never re-arms itself (the NaN loop)', () => {
  const main = fs.readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8');
  const chrome = main.slice(main.indexOf('function renderChrome() {'), main.indexOf('\n}\n', main.indexOf('function renderChrome() {')));
  assert.ok(/if \(active === 'today'\) \{\s+todayRecent\.render\(\);\s+checklist\.render\(\);/.test(chrome), 'Today parts behind the active screen');
  assert.ok(/if \(active === 'feed'\) \{\s+renderRail\(\);\s+renderKpis\(\);/.test(chrome), 'the rail and the numbers with the Feed');
  assert.ok(main.includes('if (force || !gap || now - lastRender[active] >= gap) {'), 'a missing gap draws at once');
  const show = main.slice(main.indexOf('function showTab(key) {'), main.indexOf('\n}\n', main.indexOf('function showTab(key) {')));
  assert.ok(show.indexOf('renderChrome();') > 0 && show.indexOf('renderChrome();') < show.indexOf('views[key].render();'), 'opening a screen draws its parts');
});
