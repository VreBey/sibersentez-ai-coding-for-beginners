// The workshop building (public/js/hq-scene.js, hq-live.js, hq-render.js, views/workshop.js, docs/hq.md): the rooms of
// the approved drawing, who sits where, the orchestration the scene shows (who started whom, the task and result
// cards, the tool icons, the workflows), the poses, the rewind's history, the example, the live data, and the rules
// of the project (colours from the theme, words from the string table).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ART, FLOORS, ROOMS, ROOM_KINDS, LIFT_X, baseKind, tagDepth, projectRoomKind, agentRoomKind, roomKindFor, toolActors, TOOL_BUSY_MS, TOOL_LEFT_MS,
  countByCategory, toolCategoryOf, actorPose, SIT_MS, SIT_FRAME_MS, WALK_MS, WAVE_MS, REST_MS, LEAVE_MS, DONE_MS, HISTORY_MS, moveCellRect, MOVE_CELL,
  frameInterval, waitRing, WAIT_RING_MS, walkingRoute, routePosition, fixtureList, sceneFrom, recordHistory, snapshotKey, createDemo, DEMO_MS, eventLabel,
} from '../public/js/hq-scene.js';
import { shortModel, cut, liveSnapshot, liveEvents, liveTicks, LiveHistory } from '../public/js/hq-live.js';
import { STRINGS } from '../public/js/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const session = (id, state) => ({ kind: 'session', id, state });
const agent = (id, type) => ({ kind: 'agent', id, state: 'busy', a: { type } });
const project = (over = {}) => ({ id: 'p', name: 'P', state: 'busy', mainRoomKind: 'dev', ...over });
const S = (id, state = 'busy', since = 0) => ({ id, title: id, model: 'Opus 5.5', state, since });
const A = (id, over = {}) => ({ id, sessionId: 'lead', toolUseId: `use-${id}`, type: 'general-purpose', title: id, model: 'Sonnet 5.5', depth: 1, workflowRunId: null, background: false, startedAt: 0, lastAt: 0, toolCalls: 0, toolCounts: {}, tokensOut: 0, status: 'running', ...over });
const snap = (now, over = {}) => ({ now, project: project(), sessions: [S('lead')], agents: [], workflows: [], tools: [], quota: null, ...over });
const word = (key, vars = {}) => String(STRINGS.en[`ws${key[0].toUpperCase()}${key.slice(1)}`] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

test('the rooms of the drawing: inside their floor, seats inside their walls, one room for every kind of work', () => {
  assert.deepEqual(ART, { w: 1536, h: 1024 });
  const ids = new Set();
  for (const r of ROOMS) {
    assert.ok(!ids.has(r.id), r.id);
    ids.add(r.id);
    assert.ok(FLOORS[r.floor], r.id);
    assert.ok(ROOM_KINDS.includes(r.kind), r.id);
    assert.ok(r.x0 < r.x1 && r.x0 >= 0 && r.x1 < LIFT_X, r.id);
    for (const x of r.seats) assert.ok(x > r.x0 && x < r.x1, `${r.id} seat ${x}`);
  }
  for (const k of ROOM_KINDS) assert.equal(ROOMS.filter((r) => r.kind === baseKind(k)).length, 1, k);
  for (const f of FLOORS) assert.ok(f.y < f.feet && f.feet <= f.y + f.h && f.y + f.h < ART.h);
  assert.equal(fixtureList().length, ROOMS.reduce((n, r) => n + r.seats.length, 0), 'one piece of furniture per seat');
});

test('a project’s main room from its tags; a tag found deep inside the folder does not count', () => {
  assert.equal(projectRoomKind([{ id: 'unity', from: 'Assets/, ProjectSettings/' }]), 'gamedev');
  assert.equal(projectRoomKind([{ id: 'unreal', from: '*.uproject x4' }, { id: 'python', from: '*.py x73' }]), 'gamedev');
  assert.equal(projectRoomKind([{ id: 'unity', from: 'araclar/AICommand/Assets, ProjectSettings' }, { id: 'javascript', from: '*.js x13' }]), 'dev', 'a tool kept inside the project');
  assert.equal(projectRoomKind([{ id: 'python', from: '*.py x9' }, { id: 'ai', from: 'requirements.txt' }]), 'server');
  assert.equal(projectRoomKind([{ id: 'design', from: 'design/' }]), 'design');
  assert.equal(projectRoomKind([{ id: 'docs', from: 'docs/' }]), 'library');
  assert.equal(projectRoomKind([{ id: 'design', from: 'design/' }, { id: 'react', from: 'package.json' }]), 'dev', 'design with code is software');
  assert.equal(projectRoomKind(undefined), 'dev');
  assert.deepEqual(['Assets/', 'design/gdd/', '*.js x3', 'a/b/c'].map(tagDepth), [0, 1, 0, 2]);
  assert.equal(baseKind('gamedev'), 'dev', 'a game’s team works in the software office');
});

test('who sits where: work in the main room, waiting in the meeting room, left in the lounge, agents by their work', () => {
  assert.equal(roomKindFor(session('s', 'busy'), 'server'), 'server');
  assert.equal(roomKindFor(session('s', 'waiting'), 'dev'), 'meeting');
  assert.equal(roomKindFor(session('s', 'left'), 'dev'), 'lounge');
  const cases = [['Explore', 'library'], ['web-fetch', 'library'], ['repo-kasif', 'library'], ['Plan', 'meeting'], ['kod-denetci', 'server'], ['tester', 'server'], ['ui-designer', 'design'], ['designer', 'design'], ['general-purpose', 'dev'], ['builder', 'dev']];
  for (const [type, kind] of cases) assert.equal(roomKindFor(agent('a', type), 'dev'), kind, type);
  assert.equal(agentRoomKind('build-runner'), null, '"ui" inside a word is not design work');
});

test('the scene places everyone: a seat each, kept over time; the rest of a full room counts as "+N"', () => {
  const sessions = Array.from({ length: 5 }, (_, i) => S(`s${i}`));
  const s = sceneFrom(snap(1e6, { sessions, agents: [A('x', { type: 'Explore' })] }), [], [], 1e6);
  const seats = s.actors.map((a) => `${a.room.id}:${a.seat}`);
  assert.equal(new Set(seats).size, seats.length, 'one actor per seat');
  assert.equal(s.actors.filter((a) => a.room.id === 'dev').length, 3);
  assert.equal(s.more.dev, 2);
  assert.equal(s.actors.find((a) => a.id === 'a:x').room.id, 'library');
  // Over the history a lead keeps its seat while newcomers take the free ones
  const h = [{ t: 0, snapshot: snap(0, { sessions: [S('b'), S('lead')] }) }, { t: 1000, snapshot: snap(1000, { sessions: [S('lead')] }) }];
  const later = sceneFrom(snap(2000, { sessions: [S('c'), S('lead')] }), [], [], 2000, h);
  assert.equal(later.actors.find((a) => a.id === 's:lead').seat, 1, 'kept its seat');
  assert.equal(later.actors.find((a) => a.id === 's:c').seat, 0, 'the free one');
  assert.equal(sceneFrom(snap(0, { project: project({ state: 'closed' }), sessions: [] }), [], [], 0).closed, true);
});

test('orchestration: a link from whoever started an agent, the task card, the result handed back, then it goes', () => {
  const start = { t: 1000, kind: 'agent_start', actor: 's:lead', sessionId: 'lead', meta: { toolUseId: 'use-r' } };
  const nested = { t: 2000, kind: 'agent_start', actor: 'a:r', sessionId: 'lead', meta: { toolUseId: 'use-n' } };
  const data = (now, status = 'running') => snap(now, { agents: [A('r', { type: 'Explore', startedAt: 1000 }), A('n', { type: 'research', startedAt: 2000, background: true, depth: 2, status, lastAt: 9000 })] });
  let s = sceneFrom(data(2500), [start, nested], [], 2500);
  const link = (to) => s.links.find((l) => l.to === to);
  assert.deepEqual([link('a:r').from, link('a:n').from], ['s:lead', 'a:r'], 'the nested agent hangs from the agent that started it');
  assert.equal(link('a:n').background, true, 'a background agent: a dashed line');
  assert.equal(link('a:n').colorOwner, 's:lead', 'in its lead’s colour');
  assert.deepEqual(s.cards.map((c) => c.kind), ['task'], 'the task card travels for a moment');
  // Without its agent_start (an older event) the agent hangs from its session's lead
  assert.equal(sceneFrom(data(2500), [], [], 2500).links.find((l) => l.to === 'a:n').from, 's:lead');
  // Done: it stands up, the result card goes back, the lead's screen lights up, then it is gone
  const done = { t: 9000, kind: 'agent_done', actor: 'a:n' };
  s = sceneFrom(data(9000 + 800, 'done'), [start, nested, done], [], 9800);
  assert.ok(s.cards.some((c) => c.kind === 'result'));
  assert.notEqual(s.actors.find((a) => a.id === 'a:n').goneAt, null);
  s = sceneFrom(data(9000 + 1800, 'done'), [start, nested, done], [], 10800);
  assert.deepEqual(s.flashes.map((f) => f.id), ['a:r'], 'the one that started it receives the result');
  s = sceneFrom(data(9000 + DONE_MS, 'done'), [start, nested, done], [], 9000 + DONE_MS);
  assert.ok(!s.actors.some((a) => a.id === 'a:n'));
});

test('tool calls: one icon per actor and 600 ms window, with a count, shown 800 ms, only this project’s', () => {
  const ticks = [[1000, 's:lead', 'read', 'p', 1], [1200, 's:lead', 'write', 'p', 2], [1300, 's:lead', 'read', 'p', 3], [1250, 's:lead', 'shell', 'other', 4]];
  let s = sceneFrom(snap(1500), [], ticks, 1500);
  assert.deepEqual(s.icons.map((i) => [i.id, i.cat, i.count]), [['s:lead', 'read', 3]]);
  assert.equal(s.moving, true);
  s = sceneFrom(snap(1900), [], ticks, 1900);
  assert.deepEqual(s.icons, [], 'gone after 800 ms');
  assert.deepEqual(countByCategory({ Read: 2, Grep: 1, Edit: 3, Bash: 1, WebFetch: 1, mcp__x__y: 2, Agent: 1, Skill: 1, Workflow: 1, Foo: 1, Bad: -1 }), { read: 3, write: 3, shell: 1, web: 1, mcp: 2, agent: 1, skill: 1, workflow: 1, other: 1 });
  assert.equal(toolCategoryOf('mcp__claude-in-chrome__read_page'), 'mcp');
});

test('workflows: how many of their agents run and how many finished; which phase runs is not guessed', () => {
  const s = sceneFrom(snap(5000, { workflows: [{ id: 'w', sessionId: 'lead', name: 'Build', status: 'running', agentCount: 3, phases: ['A', 'B'] }], agents: [A('1', { workflowRunId: 'w' }), A('2', { workflowRunId: 'w' }), A('3', { workflowRunId: 'w', status: 'done', lastAt: 1000 })] }), [], [], 5000);
  const w = s.workflows[0];
  assert.deepEqual([w.running, w.done, w.phases], [2, 1, ['A', 'B']]);
  assert.ok(!('phase' in w) && !('current' in w));
});

test('moving about: a session that waits walks to the meeting room by the lift; a closed one walks off and goes', () => {
  const h = [{ t: 0, snapshot: snap(0) }];
  const waiting = (now) => snap(now, { sessions: [S('lead', 'waiting', 1000)] });
  h.push({ t: 1000, snapshot: waiting(1000) });
  let s = sceneFrom(waiting(1000 + SIT_MS / 2), [], [], 1000 + SIT_MS / 2, h);
  let a = s.actors[0];
  assert.equal(a.room.id, 'meeting');
  assert.deepEqual([a.x, a.y], [ROOMS.find((r) => r.id === 'dev').seats[0], FLOORS[1].feet], 'it stands up where it was');
  s = sceneFrom(waiting(3000), [], [], 3000, h);
  a = s.actors[0];
  assert.ok(a.travel < 1 && a.route.some((p) => p.x === LIFT_X), 'on its way, by the lift');
  s = sceneFrom(waiting(20000), [], [], 20000, h);
  assert.deepEqual([s.actors[0].travel, s.waiting.length], [1, 1]);
  // Closed: it stays while it walks off, then it is gone
  const closed = { t: 30000, kind: 'live', actor: 's:lead', meta: { status: 'closed' } };
  s = sceneFrom(snap(30500, { sessions: [S('lead', 'busy', 0)] }), [closed], [], 30500);
  assert.equal(s.actors[0].goneAt, 30000);
  assert.equal(sceneFrom(snap(30000 + LEAVE_MS, { sessions: [S('lead', 'busy', 0)] }), [closed], [], 30000 + LEAVE_MS).actors.length, 0);
  // A route on one floor is straight; on two floors it rides the lift
  assert.equal(walkingRoute({ x: 400, y: 404 }, { x: 800, y: 404 }).length, 2);
  assert.deepEqual(routePosition([{ x: 0, y: 0 }, { x: 100, y: 0 }], 0.5), { x: 50, y: 0, direction: 1 });
});

test('other tools: a trace in the last 3 minutes is "seen" (never "working"), in the last 45 rests in the lounge; Claude Code is not doubled', () => {
  const now = 10_000_000;
  const p = { id: 'x', toolSeen: { codex: now - 60_000, 'gemini-cli': now - 20 * 60_000, copilot: now - 2 * 3600_000, 'claude-code': now, sibersentez: now } };
  assert.deepEqual(toolActors(p, now).map((a) => [a.tool, a.state]), [['codex', 'seen'], ['gemini-cli', 'left']]);
  assert.ok(TOOL_BUSY_MS < TOOL_LEFT_MS);
  const s = sceneFrom(snap(now, { sessions: [], tools: [{ id: 'codex', name: 'Codex', state: 'busy' }, { id: 'gemini-cli', name: 'Gemini', state: 'left' }] }), [], [], now);
  assert.deepEqual(s.actors.map((a) => [a.title, a.room.id]), [['Codex', 'dev'], ['Gemini', 'lounge']]);
});

test('other tools: a tool that runs in SiberSentez\'s terminal for this project is "open in the terminal"; another project\'s tab, Claude Code and the sign do not count it as working', () => {
  const now = 10_000_000;
  const p = { id: 'x', toolSeen: { codex: now - 60_000 } };
  const dock = [{ projectId: 'x', tool: 'codex' }, { projectId: 'x', tool: 'gemini' }, { projectId: 'y', tool: 'qwen' }, { projectId: 'x', tool: 'claude' }, { projectId: 'x', tool: null }];
  assert.deepEqual(toolActors(p, now, dock).map((a) => [a.tool, a.state]).sort(), [['codex', 'running'], ['gemini-cli', 'running']]);
  assert.deepEqual(toolActors(p, now, 'nonsense').map((a) => a.state), ['seen']);
  for (const lang of ['en', 'tr']) for (const k of ['wsSeen', 'wsRunning']) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
  // The sign says working only for a state that is known: busy
  const ws = fs.readFileSync(new URL('../public/js/views/workshop.js', import.meta.url), 'utf8');
  assert.ok(ws.includes("scene.actors.some((a) => a.state === 'busy'"));
  const dockSrc = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dockSrc.includes('const running = () => [...tabs.values()].filter((x) => x.ai && !x.ended)'));
  const live = fs.readFileSync(new URL('../public/js/hq-live.js', import.meta.url), 'utf8');
  assert.ok(live.includes('toolActors(p, now, store.dockRunning?.() || [])'));
});

test('poses: sit down on arrival, a hand up while waiting, rest while idle, stand up and walk off; still holds one pose', () => {
  const pose = (o) => actorPose({ time: 10000, ...o });
  assert.deepEqual([0, SIT_FRAME_MS, 3 * SIT_FRAME_MS].map((d) => pose({ state: 'busy', arrivedAt: 10000 - d }).frame), [4, 5, 7]);
  assert.equal(pose({ state: 'busy', arrivedAt: 10000 - SIT_MS }).sheet, 'type');
  const w = (d) => pose({ state: 'waiting', arrivedAt: 0, stateAt: 10000 - d }).frame;
  assert.deepEqual([w(0), w(250), w(400), w(400 + WAVE_MS), w(400 + 2 * WAVE_MS)], [0, 1, 2, 3, 2]);
  const r = (d) => pose({ state: 'left', arrivedAt: 0, stateAt: 10000 - d });
  assert.deepEqual([r(0).frame, r(REST_MS[0]).frame, r(REST_MS[0] + REST_MS[1]).frame], [12, 13, 14]);
  const g = (d) => pose({ state: 'busy', arrivedAt: 0, goneAt: 10000 - d });
  assert.deepEqual([g(0).frame, g(SIT_MS - 1).frame, g(SIT_MS).walk, g(SIT_MS + WALK_MS).alpha], [8, 11, 0, 0]);
  assert.deepEqual(['busy', 'waiting', 'left'].map((state) => pose({ state, arrivedAt: 10000, still: true })).map((x) => [x.sheet, x.frame, x.moving]), [['type', 0, false], ['move', 2, false], ['move', 12, false]]);
  const cell = moveCellRect({ x: 0, y: 0, w: 100, h: 100 }, 'person');
  assert.ok(Math.abs(cell.x + 32 * (cell.w / MOVE_CELL.w) - 21.87) < 0.01 && Math.abs(cell.y + 374 * (cell.h / MOVE_CELL.h) - 95.38) < 0.01);
  assert.deepEqual([waitRing(0), waitRing(WAIT_RING_MS / 4), waitRing(WAIT_RING_MS)], [0, 0.25, 0]);
  assert.equal(frameInterval({ moving: true }), 1000 / 12);
  for (const o of [{}, { moving: true, reduced: true }, { moving: true, paused: true }]) assert.equal(frameInterval(o), 1000);
});

test('the rewind’s history: a new entry only when someone came, went or changed, 15 minutes back', () => {
  const h = [];
  recordHistory(h, snap(0));
  recordHistory(h, snap(1000, { sessions: [{ ...S('lead'), lastAction: { text: 'x' } }] }));
  assert.equal(h.length, 1, 'a new action alone is not a new moment');
  recordHistory(h, snap(2000, { sessions: [S('lead', 'waiting')] }));
  recordHistory(h, snap(1500, { sessions: [] }));
  assert.deepEqual(h.map((x) => x.t), [0, 2000], 'never back in time');
  assert.notEqual(snapshotKey(snap(0)), snapshotKey(snap(0, { agents: [A('a')] })));
  const long = [];
  for (let i = 0; i < 120; i++) recordHistory(long, snap(i * 20000, { sessions: [S('lead', i % 2 ? 'busy' : 'left')] }));
  assert.ok(long[0].t >= 119 * 20000 - HISTORY_MS - 51 * 20000 && long.length < 120, 'the oldest go in batches');
});

test('the example shows everything once: tasks, a nested and a background agent, workflow, waiting, rest, tools, quota, closing', () => {
  const d = createDemo(word);
  const kinds = new Set(d.events.map((e) => e.kind));
  for (const k of ['agent_start', 'agent_done', 'workflow_start', 'workflow_done', 'live']) assert.ok(kinds.has(k), k);
  assert.ok(d.events.some((e) => e.kind === 'agent_start' && e.actor.startsWith('a:')), 'an agent starts an agent');
  assert.ok(d.history.some((h) => h.snapshot.agents.some((a) => a.background)));
  assert.ok(d.history.some((h) => h.snapshot.sessions.some((s) => s.state === 'waiting')));
  assert.ok(d.history.some((h) => h.snapshot.sessions.some((s) => s.state === 'left')));
  assert.ok(d.history.some((h) => h.snapshot.tools.length === 2));
  assert.ok(d.history.some((h) => (h.snapshot.quota?.fiveHourPct || 0) >= 95));
  assert.equal(d.history[d.history.length - 1].snapshot.project.state, 'closed');
  assert.deepEqual(new Set(d.ticks.map((t) => t[2])).size, 9, 'every tool category');
  for (const t of [0, 25000, 47000, 110000, 150000, 170000, DEMO_MS - 1]) assert.ok(sceneFrom(d.snapshot, d.events, d.ticks, t, d.history), `scene at ${t}`);
  const s = sceneFrom(d.snapshot, d.events, d.ticks, 47000, d.history);
  assert.ok(s.links.length >= 3 && s.actors.some((a) => a.room.id === 'library') && s.actors.some((a) => a.room.id === 'server'));
  assert.ok(sceneFrom(d.snapshot, d.events, d.ticks, 110000, d.history).waiting.length === 1);
});

test('the feed on the rewind: what each event says, and the events the workshop leaves out', () => {
  const k = (e) => eventLabel(e)?.key ?? null;
  assert.deepEqual(
    [{ kind: 'agent_start' }, { kind: 'agent_done' }, { kind: 'workflow_start' }, { kind: 'workflow_done' }, { kind: 'prompt' }, { kind: 'live', meta: { status: 'idle' } }, { kind: 'live', meta: { status: 'closed' } }, { kind: 'command' }, { kind: 'live' }].map(k),
    ['assigned', 'completed', 'workflowStart', 'workflowDone', 'userPrompt', 'prompt', 'exitAction', null, null],
  );
  for (const e of [{ kind: 'agent_done' }, { kind: 'live', meta: { status: 'waiting' } }]) assert.ok(['done', 'prompt'].includes(eventLabel(e).dot));
});

test('the live data: one project of the store as the scene’s snapshot', () => {
  const now = 10_000_000;
  const store = {
    projects: new Map([['p', { id: 'p', name: 'P', toolSeen: { codex: now - 1000 } }]]),
    sessions: new Map([
      ['s1', { id: 's1', projectId: 'p', title: 'A very long first message that goes on and on', model: 'claude-opus-5-5', live: { status: 'busy', since: now - 5000 }, lastAt: now, toolCounts: { Read: 2 } }],
      ['s2', { id: 's2', projectId: 'p', model: null, live: null, lastAt: now - 1000 }],
      ['s3', { id: 's3', projectId: 'q', live: { status: 'busy', since: now } }],
    ]),
    agents: new Map([
      ['a1', { id: 'a1', projectId: 'p', sessionId: 's1', type: 'Explore', label: 'look', status: 'running', startedAt: now - 3000, lastAt: now, model: 'claude-sonnet-5-5', toolUseId: 'u1', toolCounts: { Grep: 1 } }],
      ['a2', { id: 'a2', projectId: 'p', sessionId: 's1', type: 'Plan', status: 'done', lastAt: now - 600000 }],
    ]),
    workflows: new Map([['w', { id: 'w', projectId: 'p', sessionId: 's1', name: 'Run', status: 'running', agentCount: 2, phases: ['x'] }]]),
    events: [{ t: now - HISTORY_MS - 1, projectId: 'p' }, { t: now - 10, projectId: 'p', kind: 'agent_start' }, { t: now - 5, projectId: 'q' }],
    ticks: [[now - 9000, 's:s1', 'read', 'p', 1], [now - 100, 's:s1', 'read', 'p', 2], [now - 50, 's:s3', 'read', 'q', 3]],
  };
  const s = liveSnapshot(store, store.projects.get('p'), { now, mainRoomKind: 'server', label: (x) => x.title || 'new' });
  assert.deepEqual(s.sessions.map((x) => [x.id, x.state, x.model]), [['s1', 'busy', 'Opus 5.5']]);
  assert.ok(s.sessions[0].title.length <= 30 && s.sessions[0].title.endsWith('…'));
  assert.deepEqual(s.agents.map((a) => [a.id, a.toolUseId, a.model, a.description]), [['a1', 'u1', 'Sonnet 5.5', 'look']]);
  assert.deepEqual([s.workflows.length, s.tools.map((x) => x.name), s.project.mainRoomKind, s.project.state, s.quota], [1, ['Codex'], 'server', 'busy', null]);
  assert.deepEqual(liveEvents(store, 'p', now).map((e) => e.t), [now - 10]);
  assert.deepEqual(liveTicks(store, 'p', now).map((t) => t[4]), [2]);
  assert.deepEqual([shortModel('claude-haiku-4-5-20251001'), shortModel(null), cut('  a  b  ')], ['Haiku 4.5', null, 'a b']);
  const live = new LiveHistory();
  live.record(s);
  assert.equal(live.of('p').length, 1);
  assert.ok(sceneFrom(s, liveEvents(store, 'p', now), liveTicks(store, 'p', now), now, live.of('p')).actors.length >= 3);
});

test('the server sends what the workshop needs: an agent’s starting call and its tool counts, a session’s tool counts', () => {
  const views = read('server/views.mjs');
  const agentView = views.slice(views.indexOf('export function agentView'), views.indexOf('export function workflowView'));
  assert.match(agentView, /toolUseId: a\.toolUseId \|\| null/);
  assert.match(agentView, /toolCounts: a\.toolCounts \|\| \{\}/);
  assert.match(views.slice(views.indexOf('export function sessionView'), views.indexOf('export function agentView')), /toolCounts: s\.toolCounts \|\| \{\}/);
});

test('the theme owns the colours and the string table the words', () => {
  const theme = read('public/css/theme.css');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const f of ['public/js/hq-render.js', 'public/js/hq-scene.js', 'public/js/views/workshop.js', 'public/css/workshop.css', 'public/css/hq.css']) {
    const src = strip(read(f));
    assert.doesNotMatch(src, /#[0-9a-f]{3,8}\b(?![-\w])|rgba?\(/i, `${f}: colours from the theme`);
    for (const v of new Set(src.match(/--hq-[a-z0-9-]+/g) || [])) assert.ok(theme.includes(`${v}:`), `${f}: ${v} is defined in theme.css`);
  }
  // Every colour the canvas reads is a theme token
  const render = read('public/js/hq-render.js');
  const colors = JSON.parse(render.match(/const COLORS = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  for (const c of colors) assert.ok(theme.includes(`--${c}:`), c);
  // Every ws* key in both languages, and every word() key the code asks for exists
  const en = Object.keys(STRINGS.en).filter((k) => k.startsWith('ws'));
  const tr = Object.keys(STRINGS.tr).filter((k) => k.startsWith('ws'));
  assert.deepEqual(en.sort(), tr.sort());
  assert.ok(en.length > 120);
  const code = ['public/js/views/workshop.js', 'public/js/hq-render.js', 'public/js/hq-scene.js'].map(read).join('\n');
  for (const m of code.matchAll(/word\('(\w+)'/g)) assert.ok(STRINGS.en[`ws${m[1][0].toUpperCase()}${m[1].slice(1)}`], `ws key for ${m[1]}`);
  for (const kind of ['dev', 'gamedev', 'design', 'server', 'library', 'meeting', 'lounge']) assert.ok(STRINGS.tr[`ws${kind[0].toUpperCase()}${kind.slice(1)}`], kind);
  for (const a of ['desk', 'meeting', 'rack', 'draw', 'read', 'rest']) assert.ok(STRINGS.tr[`ws${a[0].toUpperCase()}${a.slice(1)}Fixture`], a);
});

test('the drawings are there, and SOURCE.md says where each came from; the old building is gone', () => {
  const source = read('public/img/building/SOURCE.md');
  for (const img of ['hq-tower', 'hq-rear', 'hq-activity', 'hq-actors', 'hq-move-person', 'hq-move-robot', 'hq-chair']) {
    assert.ok(fs.existsSync(new URL(`../public/img/building/${img}.png`, import.meta.url)), img);
    assert.ok(source.includes(`${img}.png`), `SOURCE.md: ${img}`);
    assert.ok(read('public/js/hq-render.js').includes(`'${img}'`), `hq-render.js loads ${img}`);
  }
  for (const old of ['public/js/cutaway.js', 'public/js/cutaway-hq.js', 'public/js/hq-model.js', 'public/js/sprites.js', 'public/js/hq-today.js', 'public/img/building/hq-modern.png']) assert.ok(!fs.existsSync(new URL(`../${old}`, import.meta.url)), old);
});

test('the job in the building: four lamps, the lead whose plan waits, the result when the team finished and the lead waits', async () => {
  const { jobLamps, JOB_STEPS } = await import('../public/js/hq-scene.js');
  const { jobOf } = await import('../public/js/hq-live.js');
  assert.deepEqual(JOB_STEPS, ['plan', 'build', 'check', 'finish']);
  assert.deepEqual(jobLamps(null), ['off', 'off', 'off', 'off']);
  assert.deepEqual(jobLamps({ step: 'build' }), ['done', 'now', 'off', 'off']);
  assert.deepEqual(jobLamps({ step: 'done' }), ['done', 'done', 'done', 'done']);
  assert.equal(jobOf({ step: 'none' }), null);
  assert.deepEqual(jobOf({ step: 'check', tasks: { done: 2, total: 3 }, review: null, current: null, extra: 1 }), { step: 'check', tasks: { done: 2, total: 3 }, review: null, current: null, title: null, jobId: null, updatedAt: null });
  assert.equal(jobOf({ step: 'build', plan: { title: 'Açılışı netleştir' } }).title, 'Açılışı netleştir', 'the plan title travels with the job');
  assert.equal(jobOf({ step: 'build', plan: { jobId: 'J' + 'a'.repeat(32) } }).jobId, 'J' + 'a'.repeat(32), 'and its job id (what the start\'s restore point is matched by)');
  const lead = (over) => ({ ...S('lead', 'waiting', 1000), ...over });
  let s = sceneFrom(snap(5000, { sessions: [lead({ plan: { t: 900, text: '1. x' }, planPending: true })], job: { step: 'plan' } }), [], [], 5000);
  assert.equal(s.planPending, 's:lead');
  assert.equal(s.resultReady, null);
  assert.equal(s.moving, true, 'the plan sheet glows');
  s = sceneFrom(snap(5000, { sessions: [lead({})], job: { step: 'finish' } }), [], [], 5000);
  assert.deepEqual([s.planPending, s.resultReady], [null, 's:lead']);
  s = sceneFrom(snap(5000, { sessions: [lead({})], job: { step: 'build' } }), [], [], 5000);
  assert.equal(s.resultReady, null, 'waiting in the middle of the job is a question, not a result');
  s = sceneFrom(snap(5000, { sessions: [S('lead', 'busy')], job: { step: 'finish' } }), [], [], 5000);
  assert.equal(s.resultReady, null, 'still working: not ready');
});

test('the live data marks a plan as waiting only while the session waits on that very question', () => {
  const now = 10_000_000;
  const base = { id: 's1', projectId: 'p', live: { status: 'waiting', since: now - 1000 }, lastAt: now, plan: { t: now - 2000, text: 'the plan' } };
  const make = (s) => ({ projects: new Map([['p', { id: 'p', name: 'P' }]]), sessions: new Map([['s1', s]]), agents: new Map(), workflows: new Map(), events: [], ticks: [] });
  const one = (s) => liveSnapshot(make(s), { id: 'p', name: 'P' }, { now }).sessions[0];
  assert.equal(one({ ...base, lastAction: { tool: 'ExitPlanMode', t: now - 2000 } }).planPending, true);
  assert.equal(one({ ...base, lastAction: { tool: 'Edit', t: now - 500 } }).planPending, false, 'approved: it went on working');
  assert.equal(one({ ...base, live: { status: 'busy', since: now }, lastAction: { tool: 'ExitPlanMode' } }).planPending, false, 'not waiting');
  assert.equal(one({ ...base, plan: null, lastAction: { tool: 'ExitPlanMode' } }).planPending, false, 'no plan text');
  assert.equal(one({ ...base, lastAction: { tool: 'ExitPlanMode' } }).plan.text, 'the plan');
});

test('the Workshop: the sign opens the plan or the result, the card answers in the AI\'s own terminal, the dock brings it forward', () => {
  const ws = read('public/js/views/workshop.js');
  assert.match(ws, /const lead = scene\?\.planPending \|\| scene\?\.resultReady;\n    if \(lead\) return selectActor\(lead\);/);
  assert.match(ws, /button\('planApprove', \(el\) => dispatch\('open-ai-terminal', a, el\)\)/);
  assert.match(ws, /button\('resultChanges', \(\) => dispatch\('open-changes', a\)\), button\('resultUndo', \(\) => dispatch\('open-restore', a\)\)/);
  const main = read('public/js/main.js');
  assert.match(main, /d\.action === 'open-ai-terminal' && d\.projectId\) \{\n    if \(!termDock\.showProject\(d\.projectId\)\)/);
  const dock = read('public/js/terminalDock.js');
  const fn = dock.slice(dock.indexOf('function showProject('), dock.indexOf('return { available: true'));
  assert.ok(fn.includes('select(id);') && fn.includes('.term.focus();'));
  assert.doesNotMatch(fn, /api\.write|typeInto|write\(/, 'nothing is typed: the person answers');
  for (const k of ['wsSignPlan', 'wsSignResult', 'wsPlanApprove', 'wsResultAnswer', 'wsInbox_plan', 'wsInbox_result', 'wsInbox_wait', 'wsNoTerminal']) assert.ok(STRINGS.tr[k] && STRINGS.en[k], k);
});

test('the job box beside the building (seen in a real job, 2026-10-01): the lamps named, the plan title, where it stands', async () => {
  const { stepsHtml, jobNowText } = await import('../public/js/views/job.js');
  const html = stepsHtml({ step: 'build', title: 'x', tasks: { done: 0, total: 5 }, current: { id: 'T1', title: 'Research', status: 'todo' } });
  assert.match(html, /<li class="done"[^>]*>[^<]+<\/li><li class="now" aria-current="step">/);
  assert.match(html, /T1 Research/);
  assert.doesNotThrow(() => jobNowText({ step: 'build', tasks: null, current: null }), 'a build step without counts (the demo, an early read)');
  const ws = fs.readFileSync(new URL('../public/js/views/workshop.js', import.meta.url), 'utf8');
  assert.ok(ws.indexOf('data-ws="jobbox"') < ws.indexOf('data-ws="inbox"'), 'above the waiting list');
  for (const s of ['renderJobBox();', "word('jobBoxTitle')", 'mode, scene.job, ']) assert.ok(ws.includes(s), s);
});

test('two projects with one name say where they are (a project moved to another drive leaves its old folder)', async () => {
  const { projectNames } = await import('../public/js/hq-live.js');
  const m = projectNames([
    { id: 'a', name: 'arena', path: 'C:\\Users\\me\\Desktop\\rena' },
    { id: 'b', name: 'arena', path: 'D:\\Projeler\\rena' },
    { id: 'c', name: 'webtoon', path: 'D:\\Projeler\\webtoon' },
  ]);
  assert.deepEqual([...m.values()], ['arena (C:\\…\\Desktop)', 'arena (D:\\Projeler)', 'webtoon']);
  const ws = fs.readFileSync(new URL('../public/js/views/workshop.js', import.meta.url), 'utf8');
  assert.ok(ws.includes('esc(names.get(x.p.id))'), 'the project list uses them');
});

test('a lead with a plan goes by its title, not the tool\'s English slug; a name the person gave is kept', async () => {
  const { planTitle, leadName } = await import('../public/js/hq-live.js');
  const plan = { text: '# Plan: Açılışı netleştir, Yüzüklerin Efendisi havası ver\n\n## Bağlam\n...' };
  assert.equal(planTitle(plan.text), 'Açılışı netleştir, Yüzüklerin Efendisi havası ver');
  assert.equal(planTitle('no heading'), '');
  const label = (s) => s.title;
  assert.equal(leadName({ title: 'lotr-style-opening-clarification', plan }, label), 'Açılışı netleştir, Yüzüklerin Efendisi havası ver');
  assert.equal(leadName({ title: 'Roman açılışı', plan }, label), 'Roman açılışı', 'a title the person gave');
  assert.equal(leadName({ title: 'fix-login-bug' }, label), 'fix-login-bug', 'no plan: the slug stays');
});

test('walking faces the way it goes: the walking frame faces left in both drawings, so a walk to the left is drawn as it is and a walk to the right is flipped (a person once walked backwards to its desk)', async () => {
  const { WALK_FACING, LIFT_X } = await import('../public/js/hq-scene.js');
  assert.equal(WALK_FACING, -1);
  const now = 100000;
  // Both arrive: from the lift on the right towards a seat on the left; looked at along the walk, on the floor part
  for (const id of ['s:lead', 'a:r']) {
    let seen = 0;
    for (let ms = 100; ms < 6000; ms += 100) {
      const s = sceneFrom(snap(now, { sessions: [S('lead', 'busy', now - ms)], agents: [A('r', { startedAt: now - ms })] }), [], [], now);
      const a = s.actors.find((x) => x.id === id);
      if (!a || a.travel >= 1 || a.mobility !== 'walk' || Math.abs(a.x - LIFT_X) < 1) continue;
      seen++;
      assert.ok(a.destination.x < a.x, `${id} walks left at ${ms} ms`);
      assert.deepEqual([a.direction, a.pose.frame, a.walkFlip], [-1, 11, false], `${id} is drawn facing left, the way it walks`);
    }
    assert.ok(seen > 0, `${id} was seen walking on the floor`);
  }
  // Leaving: back to the lift, to the right
  const gone = sceneFrom(snap(now, { sessions: [{ ...S('lead', 'busy', 0) }] }), [], [], now);
  const lead = gone.actors.find((a) => a.id === 's:lead');
  const left = { ...lead, goneAt: now - 900 };
  assert.ok(lead.destination.x < LIFT_X, 'its desk is left of the lift, so leaving walks right');
  assert.equal(left.walkNativeDirection, -1);
});

test('a closed terminal (seen 2026-10-01): its job box says the job stopped and goes on where it stopped; the plan and result buttons resume a closed session; closing a running AI asks once', () => {
  const ws = fs.readFileSync(new URL('../public/js/views/workshop.js', import.meta.url), 'utf8');
  for (const s of ["mode === 'live' && job.step !== 'done' ? stoppedLead(scene.project.id) : null", "word('jobStopped')", "button('jobResume', (el) => dispatch('resume-session', { sessionId: last.id }, el))", "const stoppedLead = (projectId) => stoppedSession(store.sessions.values(), projectId, Date.now(), scene?.job?.updatedAt);", "body.querySelector('.job-now')?.remove();"]) assert.ok(ws.includes(s), s);
  const main = fs.readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  assert.ok(main.includes("action: 'start-ai', payload: { sessionId, tool: 'claude', resume: true }"), 'the session menu\'s own resume (start-ai with resume)');
  assert.ok(main.includes("sessionState(store.sessions.get(d.sessionId)) === 'closed') resumeSession(d.sessionId)"));
  assert.ok(main.includes("d.action === 'resume-session' && d.sessionId) resumeSession(d.sessionId)"));
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes("if (!x.ai || x.ended || x.confirmUntil > Date.now()) return void closeTab(id);"), 'a plain shell or an ended AI closes at once');
  assert.ok(dock.includes("return void askClose(tab.dataset.term);") && dock.includes("e.key === 'Delete' && active) askClose(active);"), 'click and Delete both ask');
  for (const lang of ['en', 'tr']) for (const k of ['wsJobStopped', 'wsJobStoppedAt', 'wsJobResume', 'dockCloseAi']) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
});

test('the rewind before the app started is rebuilt from the logs: a session works while it acts, rests, then leaves; an agent runs from its start to its last line; nobody is shown waiting; it goes before what was recorded, once', async () => {
  const { pastSnapshots, LiveHistory, PAST_ACT_MS, PAST_STAY_MS } = await import('../public/js/hq-live.js');
  const T = 1_000_000_000;
  const p = { id: 'p', name: 'P' };
  const store = {
    sessions: new Map([['s1', { id: 's1', projectId: 'p', title: 'lead', model: 'claude-opus-5-5', startedAt: T }]]),
    agents: new Map([['a1', { id: 'a1', projectId: 'p', sessionId: 's1', type: 'Explore', startedAt: T + 60000, lastAt: T + 120000, status: 'done' }]]),
    // the lead acts at 0-30 s and 60-120 s, then goes quiet
    ticks: [0, 10, 20, 30, 60, 90, 120].map((s, i) => [T + s * 1000, 's:s1', 'read', 'p', i + 1]).concat([[T + 5000, 's:other', 'read', 'q', 99]]),
    events: [{ t: T, kind: 'prompt', projectId: 'p', sessionId: 's1' }],
  };
  const snaps = pastSnapshots(store, p, { from: T, to: T + 600000, step: 5000 });
  const at = (sec) => snaps.find((s) => s.now === T + sec * 1000);
  assert.equal(at(15).sessions[0].state, 'busy');
  assert.equal(at(15).project.state, 'busy');
  assert.equal(at(120 + PAST_ACT_MS / 1000 + 5).sessions[0].state, 'left', 'quiet: it rests');
  assert.equal(at(120 + PAST_STAY_MS / 1000 + 5).sessions.length, 0, 'quiet for long: gone');
  assert.ok(snaps.every((s) => s.sessions.every((x) => x.state !== 'waiting' && !x.planPending)), 'nobody waits in the rebuilt past');
  assert.equal(at(90).agents[0].status, 'running');
  assert.equal(at(55).agents.length, 0, 'not started yet');
  assert.ok(snaps.every((s) => s.sessions.every((x) => x.since === T)), 'seated once: the arrival does not move');
  assert.ok(snaps.every((s) => !s.sessions.some((x) => x.id === 'other')), 'another project is not in it');

  const h = new LiveHistory();
  h.record({ ...snaps[0], now: T + 300000, sessions: [], agents: [] });
  let calls = 0;
  h.seed('p', () => (calls++, snaps));
  h.seed('p', () => (calls++, snaps));
  assert.equal(calls, 1, 'once per project');
  const list = h.of('p');
  assert.ok(list.every((e, i) => i === 0 || e.t > list[i - 1].t), 'in time order');
  assert.equal(list[list.length - 1].t, T + 300000, 'the recorded moment stays the newest');
  assert.ok(list.length > 2 && list[0].t === T, 'the rebuilt past goes before it');
});

test('an AI tab that ended by itself offers to go on where it stopped, only for a Claude Code session of its project that just acted', () => {
  const dock = fs.readFileSync(new URL('../public/js/terminalDock.js', import.meta.url), 'utf8');
  assert.ok(dock.includes("const s = x.ai && x.tool === 'claude' ? resumeFor(x.projectId) : null;\n    if (s) showResume(x, s);"), 'only a Claude Code tab, only with a session: a Codex tab never offers a Claude session');
  assert.ok(dock.includes('onResume(s);'));
  const main = fs.readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  assert.ok(main.includes("s.projectId === projectId && Date.now() - (s.lastAt || 0) < 2 * 60000"), 'a session of that project that acted in the last two minutes');
  assert.ok(main.includes('resumeFor: recentSession, onResume: (s) => resumeSession(s.id)'));
  for (const lang of ['en', 'tr']) for (const k of ['dockResumeText', 'dockResume']) assert.ok(STRINGS[lang][k], `${lang} ${k}`);
});

test('the project cards tell two folders with one name apart too (the Projects screen showed two "arena game" cards)', () => {
  const pj = fs.readFileSync(new URL('../public/js/views/projects.js', import.meta.url), 'utf8');
  for (const s of ['shownNames = projectNames([...store.projects.values()]);', '<h4>${esc(shownName(p))}</h4>', 'aria-label="${esc(shownName(p))}']) assert.ok(pj.includes(s), s);
});

test('the job box examples: each fills the box (never submits), the idea of the project first while it has no job', async () => {
  const fs = await import('node:fs');
  const { GIVE_EXAMPLES } = await import('../public/js/views/workshop.js');
  const { STRINGS } = await import('../public/js/i18n.js');
  for (const lang of ['en', 'tr']) for (const k of GIVE_EXAMPLES) assert.ok(STRINGS[lang][`wsEx_${k}`] && STRINGS[lang][`wsExText_${k}`], `${lang} ${k}`);
  const ws = fs.readFileSync(new URL('../public/js/views/workshop.js', import.meta.url), 'utf8');
  const click = ws.slice(ws.indexOf("$('give-ex').addEventListener"), ws.indexOf("// What the job box's error card"));
  assert.ok(click.includes('input.value =') && !click.includes('requestSubmit') && !click.includes('giveJob'), 'fills only');
  assert.ok(ws.includes("const idea = !scene.job && p ? String(p.idea || '').trim() : '';"));
});
