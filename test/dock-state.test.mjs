// The embedded terminal's decisions (public/js/dockState.js; the roadmap's Y1 and Y2, 2026-10-07): which tab a
// "show the terminal" brings forward, tool-ended events in any order, and which session a tab goes on with.
// Behavior, not source text: the chosen tab id is checked. Run: node --test test/dock-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isRunningAi, tabState, pickRunningTab, toolEndedEvent, takeEarlyToolEnd, tabResumeSession, EARLY_MAX, RECENT_MS } from '../public/js/dockState.js';
import { escapeClosesDrawer, tabTitle } from '../public/js/terminalDock.js';

const tab = (projectId, over = {}) => ({ ai: true, projectId, tool: 'codex', ended: false, toolEnded: false, ...over });
const tabsOf = (...entries) => new Map(entries);

test('Y1: "show the terminal" brings forward a tab whose AI still runs, never one whose tool ended', () => {
  // A running Codex opened first, a finished shell opened later: the running one
  assert.equal(pickRunningTab(tabsOf(['active-codex', tab('p')], ['finished-shell', tab('p', { toolEnded: true })]), 'p'), 'active-codex');
  // Only a finished one: none (the caller says the tool's tab is closed)
  assert.equal(pickRunningTab(tabsOf(['finished-shell', tab('p', { toolEnded: true })]), 'p'), null);
  // Another project's running tab is not this project's
  assert.equal(pickRunningTab(tabsOf(['other', tab('q')]), 'p'), null);
  // Two running: the newest
  assert.equal(pickRunningTab(tabsOf(['older', tab('p')], ['newer', tab('p', { tool: 'gemini' })]), 'p'), 'newer');
  // A closed shell (ended) and a plain shell are never an AI target
  assert.equal(pickRunningTab(tabsOf(['closed', tab('p', { ended: true })], ['plain', tab('p', { ai: false })]), 'p'), null);
  assert.deepEqual([tab('p'), tab('p', { toolEnded: true }), tab('p', { ended: true }), tab('p', { ai: false }), null].map(isRunningAi), [true, false, false, false, false]);
  // The dock uses these, for the Building ("open in the terminal") and for the button alike
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes('const id = pickRunningTab(tabs, projectId);'));
  assert.ok(dock.includes('.filter(isRunningAi)'));
});

test('Y2: a tool-ended event before its tab is kept and applied when the tab comes; after it, twice, after a close', () => {
  const state = () => ({ tabs: new Map(), early: new Set(), gone: new Set() });
  // Event first, tab after (the screen library still loading)
  let s = state();
  assert.equal(toolEndedEvent(s, 't1'), 'kept');
  s.tabs.set('t1', tab('p'));
  assert.equal(takeEarlyToolEnd(s, 't1'), true);
  assert.equal(s.tabs.get('t1').toolEnded, true);
  assert.equal(pickRunningTab(s.tabs, 'p'), null, 'not counted as running any more');
  assert.equal(s.early.size, 0, 'nothing left waiting');
  // Tab first, event after; the same event twice changes nothing more
  s = state();
  s.tabs.set('t1', tab('p'));
  assert.equal(takeEarlyToolEnd(s, 't1'), false);
  assert.equal(toolEndedEvent(s, 't1'), 'marked');
  assert.equal(toolEndedEvent(s, 't1'), 'ignored');
  // A late event for a tab the person closed is dropped, never kept
  s = state();
  s.gone.add('t2');
  assert.equal(toolEndedEvent(s, 't2'), 'ignored');
  assert.equal(s.early.size, 0);
  // A tab whose shell already ended, or a plain shell: nothing to mark
  s = state();
  s.tabs.set('t3', tab('p', { ended: true }));
  s.tabs.set('t4', tab('p', { ai: false }));
  assert.equal(toolEndedEvent(s, 't3'), 'ignored');
  assert.equal(toolEndedEvent(s, 't4'), 'ignored');
  // An event kept for a tab that then comes ended (its shell closed meanwhile) changes nothing and is cleared
  s = state();
  toolEndedEvent(s, 't5');
  s.tabs.set('t5', tab('p', { ended: true }));
  assert.equal(takeEarlyToolEnd(s, 't5'), false);
  assert.equal(s.early.size, 0);
  // Bounded: at most EARLY_MAX ids wait
  s = state();
  for (let i = 1; i <= EARLY_MAX + 5; i++) toolEndedEvent(s, `t${i}`);
  assert.equal(s.early.size, EARLY_MAX);
  assert.equal(toolEndedEvent(s, 3), 'ignored', 'not an id');
  // The dock keeps them and applies them when a tab is added; a closed tab forgets its waiting event
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes("if (toolEndedEvent({ tabs, early: earlyToolEnd, gone }, id) === 'marked') afterToolEnd(tabs.get(id));"));
  assert.ok(dock.includes('gone.add(id);\n    earlyToolEnd.delete(id);'));
  // A reloaded page reads the state from the shell's list (toolEnded), not from an event
  assert.ok(dock.includes("toolEnded: info.ai === true && info.toolEnded === true"));
  // The tab says what follows: a tool the person starts in that shell is not followed (no guess from its output)
  assert.ok(dock.includes("text.textContent = t('dockToolEnded');") && dock.includes('if (x.toolEnded) showToolNote(x);'), 'an element above the screen, also after a reload; never written into the live shell');
  assert.ok(!dock.includes("t('dockToolEnded')}"), 'not in the output stream');
  // An early event is applied after the output the tab printed first, and not when its shell closed meanwhile
  const order = dock.indexOf('early.delete(info.id);\n    }\n    // Its tool-ended event came before the tab');
  assert.ok(order > 0 && dock.includes('&& !earlyEnd.has(info.id)) afterToolEnd(x);'));
});

test("the tab's resume bar: its own job's session first, never another job's; a resumed tab takes the newest", () => {
  const NOW = 1_800_000_000_000;
  const J = 'J' + '0123456789abcdef'.repeat(2);
  const K = 'J' + 'fedcba9876543210'.repeat(2);
  const s = (id, over = {}) => ({ id, projectId: 'p', lastAt: NOW - 30000, ...over });
  // Its own job's session, even when another session of the project acted later
  assert.equal(tabResumeSession([s('own', { jobId: J }), s('newer-hand', { lastAt: NOW - 1000 })], { projectId: 'p', jobId: J }, NOW).id, 'own');
  // Another job's session is never this tab's, even the newest
  assert.equal(tabResumeSession([s('other', { jobId: K, lastAt: NOW - 1000 })], { projectId: 'p', jobId: J }, NOW), null);
  // A session of no app job (started by hand) is the fallback
  assert.equal(tabResumeSession([s('other', { jobId: K }), s('hand')], { projectId: 'p', jobId: J }, NOW).id, 'hand');
  // A tab of no job (a resumed session): the newest of the project, whatever job it names
  assert.equal(tabResumeSession([s('a', { jobId: K, lastAt: NOW - 5000 }), s('b', { lastAt: NOW - 9000 })], { projectId: 'p' }, NOW).id, 'a');
  // Only the last two minutes, only this project
  assert.equal(tabResumeSession([s('old', { jobId: J, lastAt: NOW - RECENT_MS - 1 })], { projectId: 'p', jobId: J }, NOW), null);
  assert.equal(tabResumeSession([s('q', { projectId: 'q' })], { projectId: 'p' }, NOW), null);
  // A tab of no job never resumes a session whose job still runs in another tab (it would open it twice)
  assert.equal(tabResumeSession([s('busy', { jobId: K, lastAt: NOW - 1000 }), s('free', { lastAt: NOW - 9000 })], { projectId: 'p', busyJobs: new Set([K]) }, NOW).id, 'free');
  assert.equal(tabResumeSession([s('busy', { jobId: K })], { projectId: 'p', busyJobs: new Set([K]) }, NOW), null);
  // The tab of that very job still takes its own session
  assert.equal(tabResumeSession([s('own', { jobId: K })], { projectId: 'p', jobId: K, busyJobs: new Set([K]) }, NOW).id, 'own');
  assert.ok(fs.readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8').includes('busyJobs: new Set(termDock.running().map((x) => x.jobId).filter(Boolean))'));
  // The terminal tells the page each AI tab's job, so the bar can ask for it
  const terminals = fs.readFileSync(new URL('../electron/terminals.mjs', import.meta.url), 'utf8');
  assert.ok(terminals.includes('return { ok: true, id, title: t.title, projectId, ai: t.ai, tool: t.tool, jobId: t.jobId };'));
});

test('Esc in the terminal while the drawer is open closes the drawer and never reaches the AI tool; otherwise the tool gets it', () => {
  const drawer = (open, escape = false) => ({ calls: [], isOpen: () => open, escape() { this.calls.push('escape'); return escape; }, close() { this.calls.push('close'); } });
  const key = (k, inDock) => ({ key: k, target: { closest: (sel) => (sel === '.term-dock' && inDock ? {} : null) }, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } });
  let d = drawer(true);
  let e = key('Escape', true);
  assert.equal(escapeClosesDrawer(e, d), true);
  assert.deepEqual([e.stopped, e.prevented, d.calls], [true, true, ['escape', 'close']], 'the drawer closes; the tool never sees the key');
  d = drawer(true, true);
  escapeClosesDrawer(key('Escape', true), d);
  assert.deepEqual(d.calls, ['escape'], 'an open confirmation inside the drawer is cancelled first');
  for (const [k, inDock, open] of [['Escape', true, false], ['Escape', false, true], ['Enter', true, true]]) {
    d = drawer(open);
    e = key(k, inDock);
    assert.equal(escapeClosesDrawer(e, d), false, `${k} dock:${inDock} open:${open}`);
    assert.deepEqual([e.stopped, d.calls], [false, []]);
  }
  const main = fs.readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  assert.ok(main.includes("document.addEventListener('keydown', (e) => escapeClosesDrawer(e, drawer), true);"), 'on the document, before the terminal (capture)');
});

test('a second tab of the same name gets the time it started; a name of its own stays as it is', () => {
  const at = new Date(2026, 9, 8, 12, 30).getTime();
  assert.equal(tabTitle('Kafe', [], at), 'Kafe');
  assert.equal(tabTitle('Kafe', ['Setup', 'Demo'], at), 'Kafe');
  assert.equal(tabTitle('Kafe', ['Kafe'], at), 'Kafe · 12:30');
  assert.equal(tabTitle('Kafe', ['Kafe', 'Kafe · 12:30'], at), 'Kafe · 12:30 (2)', 'two started in the same minute');
  assert.equal(tabTitle('', ['x'], at), '');
});

test('the drawer ends above SiberSentez\'s terminal, so its last lines ("Go back to this point") can be clicked', () => {
  const css = fs.readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  const rule = /\.drawer \{[^}]*\}/.exec(css)?.[0] || '';
  assert.match(rule, /bottom: var\(--dock-space, 0px\)/);
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes("document.documentElement.style.setProperty('--dock-space',"), 'the terminal says how much room it takes');
});

test('"press again to stop": a second press anywhere on the asking tab closes it (its longer name moves the close button)', () => {
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes(`if (e.target.closest('[data-td="close"]') || tab.classList.contains('confirm')) return void askClose(tab.dataset.term);`));
  assert.ok(dock.includes("x.tabEl.classList.add('confirm');"), 'the asking tab is marked');
});

test('the shell prompt is seen when the screen ends with a cursor move (it reads as a line break)', () => {
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  const re = new RegExp(/const AT_PROMPT_RE = (\/.*\/);/.exec(dock)[1].slice(1, -1));
  const atPrompt = (plain) => re.test(plain.replace(/\s+$/, ' '));
  assert.ok(dock.includes(String.raw`const atPrompt = (x) => AT_PROMPT_RE.test(x.plain.replace(/\s+$/, ' '));`));
  assert.equal(atPrompt('PS C:\p>\n'), true);
  assert.equal(atPrompt('PS C:\p> \n  \n'), true);
  assert.equal(atPrompt('PS C:\p> npm run dev\n'), false);
});

test('a tab says its state in words, not by its dot\'s color alone; an open AI tool is "open", never "working" (ui-states U3)', async () => {
  assert.equal(tabState(tab('p')), 'ai');
  assert.equal(tabState(tab('p', { asks: true })), 'asks');
  assert.equal(tabState(tab('p', { toolEnded: true, asks: true })), 'toolEnded', 'a question of a tool that ended is gone');
  assert.equal(tabState(tab('p', { ended: true, toolEnded: true })), 'ended');
  assert.equal(tabState({ ai: false, ended: false }), 'shell');
  assert.equal(tabState(null), 'shell');
  const { STRINGS } = await import('../public/js/i18n.js');
  for (const lang of ['en', 'tr']) for (const st of ['ai', 'asks', 'toolEnded', 'ended', 'shell']) assert.ok(STRINGS[lang][`dockSt_${st}`], `${lang} dockSt_${st}`);
  assert.doesNotMatch(STRINGS.en.dockSt_ai, /work/i);
  const src = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(src.includes('<span class="sr-only td-state"></span>'), 'read with the tab\'s name');
  assert.equal((src.match(/paintState\(x\);/g) || []).length, 4, 'painted when the tab opens, asks, its tool ends and it ends');
});

test('a plain shell whose screen asks says so in words too (review U1-U3)', () => {
  assert.equal(tabState({ ai: false, asks: true }), 'asks');
  assert.equal(tabState({ ai: false, asks: true, ended: true }), 'ended');
});
