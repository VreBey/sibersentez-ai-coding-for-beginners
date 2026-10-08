// Every AI tool waits for the person, not only Claude Code (2026-10-07): an AI tab in SiberSentez's terminal whose
// screen asks something (terminalDock asking()) is a "waiting for you" row and makes its project wait
// (attention.js dockWaiting, waitingSessions, projectState). Run: node --test test/dock-waiting.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dockWaiting, waitingSessions, projectState, groupSessions } from '../public/js/attention.js';
import { STRINGS } from '../public/js/i18n.js';

const ask = (over = {}) => ({ tabId: 't1', projectId: 'p', tool: 'codex', title: 'Codex', kind: 'command', since: 2000, ...over });

test('an asking tab of another tool is a waiting row; a Claude Code tab is not counted twice (its session says it)', () => {
  const rows = dockWaiting([ask(), ask({ tabId: 't2', tool: 'gemini', title: 'Gemini' }), ask({ tabId: 't3', tool: 'claude' }), null, { tool: 'codex' }]);
  assert.deepEqual(rows.map((r) => r.tabId), ['t1', 't2']);
  assert.equal(rows[0].dock, true);
  assert.equal(rows[0].live.status, 'waiting');
  assert.equal(rows[0].id, 'dock:t1');
  assert.deepEqual(dockWaiting(undefined), []);
});

test('the waiting list holds sessions and asking tabs together, the newest first', () => {
  const now = 10_000;
  const sessions = [
    { id: 'S1', projectId: 'p', live: { status: 'waiting', since: 1000 } },
    { id: 'S2', projectId: 'p', live: { status: 'busy', since: 9000 } },
  ];
  assert.deepEqual(waitingSessions(sessions, now, [ask({ since: 3000 })]).map((x) => x.id), ['dock:t1', 'S1']);
  assert.deepEqual(waitingSessions(sessions, now).map((x) => x.id), ['S1'], 'without asks: as before');
});

test("an asking tab makes its own project wait, never another project", () => {
  const byProject = groupSessions([]);
  assert.equal(projectState({ id: 'p' }, byProject, 0, [ask()]), 'waiting');
  assert.equal(projectState({ id: 'q' }, byProject, 0, [ask()]), 'closed');
  assert.equal(projectState({ id: 'p' }, byProject, 0, [ask({ tool: 'claude' })]), 'closed', 'Claude: its session decides');
  assert.equal(projectState({ id: 'p' }, byProject, 0), 'closed');
});

test('wiring: the dock tracks a question apart from its note (hiding the note is no answer, typing is); the page reads it everywhere', () => {
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes('setAsk(x, prompt && isRunningAi(x) && prompt.sig !== x.typedSig ? prompt : null);'));
  const onData = dock.slice(dock.indexOf('term.onData((d) => {'), dock.indexOf('// "What the AI asks" (promptHelp.js)'));
  assert.ok(onData.includes('x.typedSig = x.ask.sig;') && onData.includes('setAsk(x, null);'), 'typing answers it');
  const close = dock.slice(dock.indexOf("if (!e.target.closest('[data-ph=\"close\"]')) return;"), dock.indexOf('el.append(helpEl);'));
  assert.ok(!close.includes('typedSig') && !close.includes('setAsk'), 'closing the note does not');
  assert.ok(dock.includes('function afterToolEnd(x) {\n    setAsk(x, null);'), 'a tool that ended asks nothing');
  const main = fs.readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  assert.ok(main.includes('onAsk: () => schedule()') && main.includes('store.dockAsking = () => termDock.asking();') && main.includes('showTab: (tabId) => termDock.showTab(tabId)'));
  for (const f of ['hq-live.js', 'views/projects.js', 'views/today.js', 'views/waiting.js']) assert.ok(fs.readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8').includes('store.dockAsking?.() || []'), f);
  for (const lang of ['en', 'tr']) assert.ok(STRINGS[lang].attnDockRow?.includes('{name}'), lang);
});
