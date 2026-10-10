// What needs the person (public/js/attention.js): session and project states, the waiting list, the rank, the held
// order, and the strings of the four states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionState, waitingSessions, sessionCounts, projectState, groupSessions, attentionRank, holdOrder, liveKnown, STATES, WAIT_FRESH_MS } from '../public/js/attention.js';
import { STRINGS, LANGUAGES } from '../public/js/i18n.js';

const NOW = Date.parse('2026-09-29T15:00:00Z');
const ses = (id, projectId, status, sinceAgoMs) => ({ id, projectId, live: status ? { status, since: sinceAgoMs == null ? 0 : NOW - sinceAgoMs } : null });

test('a session: busy while it works, waiting up to 6 hours after its turn, left after that, closed without a process', () => {
  assert.equal(sessionState(ses('a', 'p', 'busy', 10), NOW), 'busy');
  assert.equal(sessionState(ses('a', 'p', 'idle', 60000), NOW), 'waiting');
  assert.equal(sessionState(ses('a', 'p', 'idle', WAIT_FRESH_MS), NOW), 'waiting', 'the edge still waits');
  assert.equal(sessionState(ses('a', 'p', 'idle', WAIT_FRESH_MS + 1), NOW), 'left');
  assert.equal(sessionState(ses('a', 'p', 'idle', null), NOW), 'left', 'no time: not counted as waiting');
  assert.equal(sessionState(ses('a', 'p', null), NOW), 'closed');
  assert.equal(sessionState(null, NOW), 'closed');
});

test('the waiting list: only waiting sessions, the one that finished last first; the counts by state', () => {
  const all = [ses('old', 'p', 'idle', 3600000), ses('new', 'q', 'idle', 60000), ses('run', 'p', 'busy', 5), ses('stale', 'q', 'idle', WAIT_FRESH_MS * 2), ses('shut', 'p', null)];
  assert.deepEqual(waitingSessions(all, NOW).map((s) => s.id), ['new', 'old']);
  assert.deepEqual(sessionCounts(all, NOW), { waiting: 2, busy: 1, left: 1 });
});

test('a project: waiting beats working, a running agent counts as working, a quiet open session is left', () => {
  const by = groupSessions([ses('a', 'p', 'busy', 1), ses('b', 'p', 'idle', 1000), ses('c', 'q', 'idle', WAIT_FRESH_MS * 2), ses('d', 'r', null)]);
  assert.equal(projectState({ id: 'p' }, by, NOW), 'waiting');
  assert.equal(projectState({ id: 'q' }, by, NOW), 'left');
  assert.equal(projectState({ id: 'q', runningAgents: 2 }, by, NOW), 'busy');
  assert.equal(projectState({ id: 'r' }, by, NOW), 'closed', 'a closed session is not grouped');
  assert.equal(projectState({ id: 'none' }, by, NOW), 'closed');
  const rank = (id, extra = {}) => attentionRank({ id, ...extra }, by, NOW);
  assert.ok(rank('p') > rank('q', { runningAgents: 1 }) && rank('q', { runningAgents: 1 }) > rank('q') && rank('q') > rank('none'));
});

test('held order: kept while held, gone items dropped, new items at the end; fresh order when not held', () => {
  const fresh = [{ id: 'c' }, { id: 'a' }, { id: 'd' }];
  assert.deepEqual(holdOrder(fresh, ['a', 'b', 'c'], true).map((x) => x.id), ['a', 'c', 'd']);
  assert.deepEqual(holdOrder(fresh, ['a', 'b', 'c'], false).map((x) => x.id), ['c', 'a', 'd']);
  assert.deepEqual(holdOrder(fresh, [], true).map((x) => x.id), ['c', 'a', 'd']);
});

test('every state has one word in each language, the same four words everywhere', () => {
  assert.deepEqual(STATES, ['waiting', 'busy', 'left', 'closed']);
  for (const lang of LANGUAGES) for (const st of STATES) assert.ok(STRINGS[lang]['attnState_' + st], `${lang} ${st}`);
  assert.equal(STRINGS.tr.attnState_waiting, 'Seni bekliyor');
  assert.equal(STRINGS.en.attnState_waiting, 'Waiting for you');
});

test('Claude Code says a session waits (a permission, a question): waiting however long ago, and what it asks', async () => {
  const { liveStatus } = await import('../server/live.mjs');
  assert.deepEqual(liveStatus({ status: 'waiting', waitingFor: 'dialog open' }), { status: 'waiting', waitingFor: 'dialog open' });
  assert.deepEqual(liveStatus({ status: 'waiting', waitingFor: 'a\u0007b'.padEnd(200, 'x') }).waitingFor.length, 80);
  assert.equal(liveStatus({ status: 'waiting', waitingFor: 'a\u0007b' }).waitingFor, 'a b');
  assert.deepEqual(liveStatus({ status: 'idle', waitingFor: 'stale' }), { status: 'idle', waitingFor: '' });
  assert.deepEqual(liveStatus({ status: 'busy' }), { status: 'busy', waitingFor: '' });
  assert.deepEqual(liveStatus({ status: 'strange' }), { status: 'idle', waitingFor: '' });
  const old = { id: 'w', projectId: 'p', live: { status: 'waiting', since: NOW - WAIT_FRESH_MS * 5, waitingFor: 'input needed' } };
  assert.equal(sessionState(old, NOW), 'waiting');
  assert.deepEqual(waitingSessions([old], NOW).map((s) => s.id), ['w']);
});

test('the taskbar: the shell checks the report, plans the dot, the tooltip and the flash, and draws the dot', async () => {
  const { attentionRequest, attentionPlan, attentionBadgeBitmap, ATTENTION_IPC_CHANNEL } = await import('../electron/helpers.mjs');
  assert.equal(ATTENTION_IPC_CHANNEL, 'sibersentez:attention');
  const origin = 'http://127.0.0.1:4545';
  const from = { mainWindow: true, frame: { top: true, url: origin + '/' }, origin };
  assert.deepEqual(attentionRequest({ ...from, count: 2, text: '2 seni bekliyor' }), { ok: true, count: 2, text: '2 seni bekliyor' });
  for (const bad of [{ count: -1, text: '' }, { count: 1.5, text: '' }, { count: 1000, text: '' }, { count: 1, text: 'x'.repeat(81) }, { count: 1, text: 'a\u0000b' }, { count: 1, text: 5 }]) {
    assert.equal(attentionRequest({ ...from, ...bad }).ok, false, JSON.stringify(bad));
  }
  assert.equal(attentionRequest({ ...from, mainWindow: false, count: 1, text: '' }).ok, false, 'another window');
  assert.equal(attentionRequest({ ...from, frame: { top: false, url: origin + '/' }, count: 1, text: '' }).ok, false, 'a sub-frame');
  assert.deepEqual(attentionPlan({ count: 2, text: '2 waiting', previous: 1, focused: false, baseTooltip: 'SiberSentez' }), { overlay: true, tooltip: 'SiberSentez · 2 waiting', flash: true });
  assert.equal(attentionPlan({ count: 2, text: 'x', previous: 1, focused: true }).flash, false, 'no flash while the person looks');
  assert.equal(attentionPlan({ count: 1, text: 'x', previous: 2, focused: false }).flash, false, 'no flash when it drops');
  assert.deepEqual(attentionPlan({ count: 0, text: '', previous: 1, focused: false, baseTooltip: 'SiberSentez' }), { overlay: false, tooltip: 'SiberSentez', flash: false });
  const bmp = attentionBadgeBitmap(16);
  assert.equal(bmp.length, 16 * 16 * 4);
  assert.equal(bmp[(0 * 16 + 0) * 4 + 3], 0, 'a transparent corner');
  assert.deepEqual([...bmp.subarray((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)], [0x6b, 0x8f, 0xff, 255], 'a coral middle (BGRA)');
});

test('a tool whose live state is not read: its session is not known, and the page never calls it closed (ui-states U1)', async () => {
  assert.equal(liveKnown({ tool: 'claude' }), true);
  assert.equal(liveKnown({}), true, 'a session without a tool is Claude Code\'s');
  for (const tool of ['codex', 'gemini', 'qwen', 'copilot', 'opencode', 'cursor']) assert.equal(liveKnown({ tool }), false, tool);
  const { STATUS } = await import('../public/js/format.js');
  const { setLanguage } = await import('../public/js/i18n.js');
  assert.equal(STATUS.unknown.l, 'Live state not known');
  setLanguage('tr');
  try {
    assert.equal(STATUS.unknown.l, 'Canlı durumu bilinmiyor');
  } finally {
    setLanguage('en');
  }
  const fs = await import('node:fs');
  const drawer = fs.readFileSync(new URL('../public/js/views/drawer.js', import.meta.url), 'utf8');
  assert.ok(drawer.includes("const st = d.live ? d.live.status : liveKnown(d) ? 'closed' : 'unknown';"), 'the session\'s badge');
});
