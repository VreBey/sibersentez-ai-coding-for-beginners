// The workshop building's scene (docs/hq.md), pure: no DOM, no clock, no store. The approved drawing
// (public/img/building/hq-tower.png, 1536 x 1024; the "SiberSentez Bina Onayli" package of 2026-10-01) is a three-floor
// house with a lift on the right: six rooms, one per kind. sceneFrom() turns one project's data (the snapshot below)
// into who stands where, the links from a lead to the agents it started, the task and result cards, the tool icons,
// the workflows, the furniture and the doors. hq-render.js draws it; views/workshop.js and hq-today.js show it.
//
// snapshot = { now, project: { id, name, state, mainRoomKind }, sessions: [{ id, title, model, state, since,
//   lastAction }], agents: [{ id, sessionId, toolUseId, type, title, description, model, depth, workflowRunId,
//   background, startedAt, lastAt, toolCalls, toolCounts, tokensOut, status }], workflows: [{ id, sessionId, name,
//   status, agentCount, phases }], tools: [{ id, name, state }], quota: null | { fiveHourPct, weeklyPct } }
// events = [{ t, kind, sessionId, actor: 's:<id>' | 'a:<id>', text, meta }] (the store's feed), ticks = [[t, actor,
// cat, projectId, seq]] (tool calls), history = [{ t, snapshot }] (earlier snapshots, oldest first: the rewind).

export const ART = Object.freeze({ w: 1536, h: 1024 });

// Each floor of the drawing, top first: its top (y), height (h) and the line the actors' feet stand on (feet)
export const FLOORS = [
  { y: 256, h: 153, feet: 404 },
  { y: 490, h: 149, feet: 634 },
  { y: 717, h: 141, feet: 854 },
];

// The rooms: floor (index in FLOORS), walls (x0, x1) and the x of their seats on the feet line, in the order they fill
export const ROOMS = [
  { id: 'library', kind: 'library', floor: 0, x0: 310, x1: 692, seats: [380, 500, 610] },
  { id: 'meeting', kind: 'meeting', floor: 0, x0: 724, x1: 1180, seats: [780, 915, 1050] },
  { id: 'dev', kind: 'dev', floor: 1, x0: 310, x1: 692, seats: [365, 480, 595] },
  { id: 'design', kind: 'design', floor: 1, x0: 724, x1: 1180, seats: [780, 915, 1050] },
  { id: 'server', kind: 'server', floor: 2, x0: 310, x1: 692, seats: [365, 480, 595] },
  { id: 'lounge', kind: 'lounge', floor: 2, x0: 724, x1: 1180, seats: [790, 930, 1070] },
];
export const ROOM_KINDS = Object.freeze(['dev', 'gamedev', 'design', 'server', 'library', 'meeting', 'lounge']);

// The lift's shaft (actors ride it between floors) and the doors each floor has (the room wall and the lift's)
export const LIFT_X = 1320;
export const LIFT_BOX = Object.freeze({ x: 1280, y: 225, w: 100, h: 675 });
export const DOOR_XS = Object.freeze([706, 1215]);
// Where a newcomer comes from: the lift's ground floor
const ENTRY = Object.freeze({ x: LIFT_X, y: 854 });

// The house has one software office: a game's team works there too
export const baseKind = (kind) => (kind === 'gamedev' ? 'dev' : kind);

// A project's main room from its tags (the fit's project tags, server/tags.mjs): a game goes to the software office
// (the game studio of the old drawing), AI and data work to the server room, design or writing with no code to the
// design studio or the library, anything else (and no tags) to the software office
const GAME = new Set(['gamedev', 'unity', 'unreal', 'godot', 'gdscript', 'multiplayer']);
const DATA = new Set(['ai', 'data']);
const CODE = new Set(['nextjs', 'react', 'react-native', 'expo', 'electron', 'tauri', 'vue', 'svelte', 'angular', 'node-server', 'django', 'flask', 'fastapi', 'rails', 'laravel', 'spring', 'dotnet', 'flutter', 'csharp', 'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'swift', 'dart', 'php', 'ruby', 'cpp', 'lua', 'wordpress', 'threejs']);
// A tag found deep in the folder (a tool kept inside the project, like araclar/AICommand/Assets) does not say what the
// project is: only tags seen at the top or one folder down count (the fit's `from`, its first path)
export function tagDepth(from) {
  const first = String(from || '').split(',')[0].trim().replace(/\/+$/, '');
  return first.startsWith('*') ? 0 : (first.match(/\//g) || []).length;
}
export function projectRoomKind(tags) {
  const list = (Array.isArray(tags) ? tags : []).filter((x) => typeof x === 'string' || tagDepth(x?.from) <= 1);
  const ids = new Set(list.map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean));
  const any = (set) => [...ids].some((x) => set.has(x));
  if (any(GAME)) return 'gamedev';
  if (any(DATA)) return 'server';
  const code = any(CODE);
  if (!code && (ids.has('design') || ids.has('ui') || ids.has('slides'))) return 'design';
  if (!code && (ids.has('docs') || ids.has('content'))) return 'library';
  return 'dev';
}

// An agent's room from its type: research reads in the library, planning sits in the meeting room, tests and reviews
// stand at the server racks, design work at the easels; null: the project's main room
export function agentRoomKind(type) {
  const s = String(type || '').toLowerCase();
  if (/explore|research|search|fetch|guide|docs|kasif|reader/.test(s)) return 'library';
  if (/plan|architect|product|manager/.test(s)) return 'meeting';
  if (/test|review|qa|audit|denetci|security|verify|debug/.test(s)) return 'server';
  if (/design|\bui\b|\bux\b|\bart\b|visual/.test(s)) return 'design';
  return null;
}

// Where one actor goes: a session (or another tool) at work in the main room, one that waits for you in the meeting
// room, one that left in the lounge; an agent by its work
export function roomKindFor(actor, mainKind) {
  if (actor?.kind === 'agent') return agentRoomKind(actor.a?.type) || mainKind;
  if (actor?.state === 'waiting') return 'meeting';
  if (actor?.state === 'left') return 'lounge';
  return mainKind;
}

// Other tools (Codex, Gemini CLI, Copilot, Cursor, Antigravity): SiberSentez reads no session of theirs, only when each
// last left a trace in the project's folder (the catalog's toolSeen, from the tools' file times). A trace in the last
// three minutes reads as at work, in the last 45 as having left a while ago; older traces get no actor.
export const TOOL_BUSY_MS = 3 * 60000;
export const TOOL_LEFT_MS = 45 * 60000;
const OWN_TOOLS = new Set(['claude-code', 'sibersentez']); // Claude Code's sessions are actors of their own
export const TOOL_NAMES = Object.freeze({ codex: 'Codex', 'gemini-cli': 'Gemini', copilot: 'Copilot', cursor: 'Cursor', antigravity: 'Antigravity' });
export function toolActors(p, now = Date.now()) {
  const out = [];
  for (const [tool, t] of Object.entries(p?.toolSeen || {})) {
    if (OWN_TOOLS.has(tool) || !Number.isFinite(t) || t <= 0) continue;
    const age = now - t;
    const state = age < TOOL_BUSY_MS ? 'busy' : age < TOOL_LEFT_MS ? 'left' : null;
    if (state) out.push({ kind: 'tool', id: `tool:${tool}:${p.id}`, tool, state, t });
  }
  return out.sort((a, b) => b.t - a.t);
}

// The tool-call categories (server/ingest.mjs toolCategory) and a tool name's category, for the card's bars
export const TOOL_CATS = Object.freeze(['read', 'write', 'shell', 'web', 'agent', 'skill', 'workflow', 'mcp', 'other']);
export function toolCategoryOf(name) {
  const s = String(name || '');
  if (/^mcp__/i.test(s)) return 'mcp';
  if (/read|glob|grep|^ls$|toolsearch/i.test(s)) return 'read';
  if (/edit|write/i.test(s)) return 'write';
  if (/bash|shell|monitor|killshell|taskstop/i.test(s)) return 'shell';
  if (/web|chrome|browser|playwright/i.test(s)) return 'web';
  if (/^(agent|task|sendmessage)$/i.test(s)) return 'agent';
  if (/skill/i.test(s)) return 'skill';
  if (/workflow/i.test(s)) return 'workflow';
  return 'other';
}
// { Read: 4, Edit: 2 } -> { read: 4, write: 2 }
export function countByCategory(toolCounts) {
  const out = {};
  for (const [name, n] of Object.entries(toolCounts || {})) {
    if (!Number.isFinite(n) || n <= 0) continue;
    const cat = toolCategoryOf(name);
    out[cat] = (out[cat] || 0) + n;
  }
  return out;
}

// ---------- motion ----------
// The movement sheets (hq-move-person.png, hq-move-robot.png, hq-chair.png): 4 x 4 cells of 256 x 384, the chair drawn
// apart. Rows: raise a hand (0-3), sit down (4-7), stand up and turn to go (8-11), rest (12-15).
export const MOVE_CELL = Object.freeze({ w: 256, h: 384 });
// Fitting a cell over the typing atlas' square: the seated pose's chair corner (32, 374 in the cell) lands where the
// typing atlas has it, at the typing figure's height (measured on both drawings)
export const MOVE_FIT = Object.freeze({
  person: { x: 0.2187, y: 0.9538, k: 0.9019 / 261 },
  robot: { x: 0.2368, y: 0.9312, k: 0.8748 / 249 },
});
export function moveCellRect(r, who) {
  const f = MOVE_FIT[who] || MOVE_FIT.person;
  const k = f.k * r.w;
  return { x: r.x + f.x * r.w - 32 * k, y: r.y + f.y * r.h - 374 * k, w: MOVE_CELL.w * k, h: MOVE_CELL.h * k };
}

export const SIT_FRAME_MS = 200;
export const SIT_MS = 4 * SIT_FRAME_MS;
export const WALK_MS = 600;
// Which way the walking frame of the move sheets faces (-1 left), checked on the drawings (public/img/building)
export const WALK_FACING = -1;
export const LEAVE_MS = SIT_MS + WALK_MS;
export const WAVE_MS = 450;
export const REST_MS = Object.freeze([1800, 900, 1400, 1200]);
export const TYPE_FRAME_MS = 170;
export const FPS_MOVING = 12;
export const WAIT_RING_MS = 1600;
// A finished agent stays this long: it stands up, its result card travels to its lead, the lead's screen lights up
export const DONE_MS = 2300;
const TASK_CARD_MS = 1200;
const RESULT_CARD_MS = 1600;
// Tool icons: one per actor in a 600 ms window, shown for 800 ms
const ICON_GROUP_MS = 600;
const ICON_MS = 800;
// The rewind reaches 15 minutes back
export const HISTORY_MS = 15 * 60000;

// What an actor shows now: { sheet: 'type' (the typing atlas) | 'move' | 'activity', frame, walk (0..1, how far it
// walked off), alpha, moving (it changes), fast (it needs smooth frames) }. arrivedAt: when it came to this seat;
// stateAt: when it got its state; goneAt: when it went (null while here); still: reduced motion or paused.
export function actorPose({ state, time, arrivedAt = -Infinity, stateAt = -Infinity, goneAt = null, still = false }) {
  if (goneAt != null) {
    const t = time - goneAt;
    if (t < SIT_MS) return { sheet: 'move', frame: 8 + Math.floor(t / SIT_FRAME_MS), walk: 0, alpha: 1, moving: true, fast: true };
    const walk = Math.min(1, (t - SIT_MS) / WALK_MS);
    return { sheet: 'move', frame: 11, walk, alpha: 1 - walk, moving: true, fast: true };
  }
  const since = time - arrivedAt;
  if (!still && since < SIT_MS) {
    return { sheet: 'move', frame: 4 + Math.floor(Math.max(0, since) / SIT_FRAME_MS), walk: 0, alpha: Math.min(1, Math.max(0, since) / 150), moving: true, fast: true };
  }
  const here = { walk: 0, alpha: 1, fast: false };
  if (state === 'busy') return { ...here, sheet: 'type', frame: still ? 0 : Math.floor(time / TYPE_FRAME_MS) % 4, moving: !still };
  if (state === 'waiting') {
    // Up once (0, 1), then waving (2, 3); still: the hand stays up
    if (still) return { ...here, sheet: 'move', frame: 2, moving: false };
    const w = time - Math.max(stateAt, arrivedAt + SIT_MS);
    const frame = w < 200 ? 0 : w < 400 ? 1 : 2 + (Math.floor((w - 400) / WAVE_MS) % 2);
    return { ...here, sheet: 'move', frame, moving: true, fast: true };
  }
  if (state === 'left') {
    if (still) return { ...here, sheet: 'move', frame: 12, moving: false };
    const total = REST_MS.reduce((a, b) => a + b, 0);
    let t = (((time - stateAt) % total) + total) % total;
    if (!Number.isFinite(t)) t = ((time % total) + total) % total;
    let i = 0;
    while (t >= REST_MS[i]) t -= REST_MS[i++];
    return { ...here, sheet: 'move', frame: 12 + i, moving: false };
  }
  return { ...here, sheet: 'type', frame: 0, moving: false };
}

// Milliseconds between frames: 12 a second while something moves, one a second otherwise or with reduced motion
export function frameInterval({ reduced = false, paused = false, moving = false } = {}) {
  if (reduced || paused) return 1000;
  return moving ? 1000 / FPS_MOVING : 1000;
}

// The waiting ring's phase (0..1): it grows from the "!" and fades while it grows
export function waitRing(time, ms = WAIT_RING_MS) {
  return (((time % ms) + ms) % ms) / ms;
}

// ---------- the furniture and the routes ----------
// Which way the actors face at a room's furniture: at the computers from behind, at the racks, easels, meeting table
// and lounge from the side, in the library towards the viewer
const SEAT_VIEWS = Object.freeze({ dev: 'back', gamedev: 'back', design: 'right', server: 'right', meeting: 'right', library: 'front', lounge: 'right' });
export function seatGeometry(room, seat) {
  const x = room.seats[seat];
  const feet = FLOORS[room.floor].feet;
  const activity = { server: 'rack', library: 'read', lounge: 'rest', meeting: 'meeting', design: 'draw' }[room.kind] || 'desk';
  const posture = activity === 'rack' || activity === 'draw' ? 'standing' : 'seated';
  return {
    x,
    feet,
    activity,
    posture,
    facing: SEAT_VIEWS[room.kind],
    desk: activity === 'desk' || activity === 'meeting',
    screen: room.kind === 'dev' || room.kind === 'server',
    headY: feet - (posture === 'standing' ? 80 : 65),
    deskY: feet - 44,
    screenPoint: { x: x + (activity === 'desk' ? 0 : activity === 'rack' ? 26 : 62), y: feet - (activity === 'desk' ? 91 : 60) },
  };
}

// Every seat of the house as a piece of furniture, with who sits there (actors: the scene's placed actors)
export function fixtureList(actors = []) {
  return ROOMS.flatMap((room) =>
    room.seats.map((x, seat) => {
      const g = seatGeometry(room, seat);
      const actor = actors.find((a) => a.room.id === room.id && a.seat === seat);
      const wide = g.activity === 'desk' ? 47 : 35;
      const right = g.activity === 'desk' ? 47 : g.activity === 'read' ? 35 : 95;
      return { id: `f:${room.id}:${seat}`, room, seat, ...g, actorId: actor?.id ?? null, x0: x - wide, x1: x + right, y0: g.feet - 110, y1: g.feet };
    }),
  );
}

// From one spot to another: along the floor, or to the lift, up or down, and along the other floor
export function walkingRoute(from, to) {
  const nearest = (y) => FLOORS.reduce((best, f, i) => (Math.abs(f.feet - y) < Math.abs(FLOORS[best].feet - y) ? i : best), 0);
  const start = nearest(from.y);
  const end = nearest(to.y);
  if (start === end) return [from, to];
  return [from, { x: LIFT_X, y: FLOORS[start].feet }, { x: LIFT_X, y: FLOORS[end].feet }, to];
}

// The point at progress (0..1) of a route, and which way it walks there (1 right, -1 left)
export function routePosition(points, progress) {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let distance = clamp(progress, 0, 1) * lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (distance <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] ? distance / lengths[i] : 1;
      return { x: lerp(points[i].x, points[i + 1].x, f), y: lerp(points[i].y, points[i + 1].y, f), direction: points[i + 1].x >= points[i].x ? 1 : -1 };
    }
    distance -= lengths[i];
  }
  return { ...points[points.length - 1], direction: 1 };
}

// ---------- who sits where ----------
// The seats kept from one moment to the next: an actor keeps its seat while it stays in the same kind of room; a newcomer
// takes the first free seat of its room; a room with no seat left counts the rest ("+N"). Pure: returns a new memory.
function reserve(memory, list, main) {
  const mem = new Map(memory);
  const active = new Set(list.map((a) => a.id));
  for (const id of [...mem.keys()]) if (!active.has(id)) mem.delete(id);
  const occupied = new Set();
  for (const a of list) {
    const entry = mem.get(a.id);
    if (entry && entry.room.kind === baseKind(roomKindFor(a, main))) occupied.add(`${entry.room.id}:${entry.seat}`);
    else mem.delete(a.id);
  }
  const placed = [];
  const more = {};
  for (const a of list) {
    let entry = mem.get(a.id);
    const kind = baseKind(roomKindFor(a, main));
    const room = ROOMS.find((r) => r.kind === kind) || ROOMS.find((r) => r.kind === 'dev');
    if (!entry) {
      const seat = room.seats.findIndex((_, i) => !occupied.has(`${room.id}:${i}`));
      if (seat < 0) {
        more[room.id] = (more[room.id] || 0) + 1;
        continue;
      }
      entry = { room, seat };
      mem.set(a.id, entry);
      occupied.add(`${room.id}:${seat}`);
    }
    placed.push({ actor: a, ...entry });
  }
  return { placed, more, memory: mem };
}

// The actors one snapshot of the history holds (for the seats kept over time)
function historyActors(h) {
  const s = h.snapshot;
  return [
    ...(s.sessions || []).map((x) => ({ id: `s:${x.id}`, kind: 'session', state: x.state })),
    ...(s.agents || []).filter((x) => x.status === 'running' || h.t - x.lastAt < DONE_MS).map((x) => ({ id: `a:${x.id}`, kind: 'agent', a: x })),
    ...(s.tools || []).map((x) => ({ id: `t:${x.id}`, kind: 'tool', state: x.state })),
  ];
}

// The seats over the history, worked out once per history entry (the history only grows at its end, so a frame does
// not walk it again): after[i] is the seat memory after entry i, at.get(t) the placement at that entry
const seatCache = new WeakMap();
function seatsOver(history, main) {
  let c = seatCache.get(history);
  if (!c || c.main !== main || c.first !== history[0] || c.n > history.length) c = { main, first: history[0], n: 0, after: [], at: new Map() };
  for (let i = c.n; i < history.length; i++) {
    const r = reserve(i ? c.after[i - 1] : new Map(), historyActors(history[i]), main);
    c.after.push(r.memory);
    c.at.set(history[i].t, r);
  }
  c.n = history.length;
  seatCache.set(history, c);
  return c;
}

// ---------- the scene ----------
export function sceneFrom(snapshot, events = [], ticks = [], now = snapshot.now, history = []) {
  // The history up to now, and the snapshot itself when it is newer
  let n = 0;
  while (n < history.length && history[n].t <= now) n++;
  const past = history.slice(0, n);
  if (snapshot.now <= now && (!past.length || snapshot.now > past[past.length - 1].t)) past.push({ t: snapshot.now, snapshot });
  const snap = past.length ? past[past.length - 1].snapshot : snapshot;
  const allEvents = events.filter((e) => e.t <= now);
  const main = snap.project.mainRoomKind || projectRoomKind(snap.project.tags);
  const closures = allEvents.filter((e) => e.kind === 'live' && e.meta?.status === 'closed');
  const doneAt = new Map(); // agent actor id -> the last agent_done
  for (const e of allEvents) if (e.kind === 'agent_done') doneAt.set(e.actor, e);
  const actors = [];
  const seen = new Set();

  // The sessions now; one closed a moment ago stays while it stands up and walks off
  for (const s of snap.sessions || []) {
    const id = `s:${s.id}`;
    const closed = latest(closures.filter((e) => e.actor === id && e.t >= s.since));
    if (closed && now - closed.t >= LEAVE_MS) continue;
    actors.push({ id, kind: 'session', state: s.state, sessionId: s.id, title: s.title, model: s.model, data: s, stateAt: s.since, goneAt: closed?.t ?? null });
    seen.add(id);
  }
  // A session that left the data between two snapshots keeps its walk out
  for (let i = 1; i < past.length; i++) {
    const before = past[i - 1].snapshot;
    const after = past[i].snapshot;
    const t = past[i].t;
    if (now - t >= LEAVE_MS) continue;
    for (const s of before.sessions || []) {
      const id = `s:${s.id}`;
      if (seen.has(id) || (after.sessions || []).some((x) => x.id === s.id)) continue;
      const closed = latest(closures.filter((e) => e.actor === id && e.t <= t));
      const goneAt = closed?.t ?? t;
      if (now - goneAt >= LEAVE_MS) continue;
      actors.push({ id, kind: 'session', state: s.state, sessionId: s.id, title: s.title, model: s.model, data: s, stateAt: s.since, goneAt });
      seen.add(id);
    }
  }
  // The agents: the running ones, and one that finished a moment ago (it hands its result over)
  const agentData = new Map((snap.agents || []).map((a) => [a.id, a]));
  for (const h of past) {
    if (h.t >= now) continue;
    for (const a of h.snapshot.agents || []) {
      const done = doneAt.get(`a:${a.id}`);
      if (!agentData.has(a.id) && done && now - done.t < DONE_MS) agentData.set(a.id, a);
    }
  }
  for (const a of agentData.values()) {
    const id = `a:${a.id}`;
    const start = latest(allEvents.filter((e) => e.kind === 'agent_start' && a.toolUseId != null && e.meta?.toolUseId === a.toolUseId));
    const done = doneAt.get(id);
    const goneAt = done?.t ?? (a.status === 'done' ? a.lastAt : null);
    if (goneAt != null && now - goneAt >= DONE_MS) continue;
    // The one who started it: the actor of its agent_start (a lead, or another agent); else its session's lead
    actors.push({ id, kind: 'agent', a, state: 'busy', sessionId: a.sessionId, title: a.title || a.type, model: a.model, data: a, stateAt: a.startedAt, goneAt, parentId: start?.actor ?? `s:${a.sessionId}`, startAt: start?.t ?? a.startedAt });
  }
  // Other tools: no session of theirs, only their name
  for (const tool of snap.tools || []) {
    const first = past.find((h) => (h.snapshot.tools || []).some((x) => x.id === tool.id));
    actors.push({ id: `t:${tool.id}`, kind: 'tool', state: tool.state, sessionId: null, title: tool.name, model: null, data: tool, stateAt: first?.t ?? snap.now, startAt: first?.t ?? -Infinity });
  }

  // Seats: kept over the history, then the actors now
  const kept = history.length && n ? seatsOver(history, main) : null;
  let memory = kept ? kept.after[n - 1] : new Map();
  const placementAt = new Map(kept ? kept.at : []);
  if (past.length > n) {
    // the snapshot itself, newer than the history
    const r = reserve(memory, historyActors(past[past.length - 1]), main);
    memory = r.memory;
    placementAt.set(past[past.length - 1].t, r);
  } else if (!kept) {
    for (const h of past) {
      const r = reserve(memory, historyActors(h), main);
      memory = r.memory;
      placementAt.set(h.t, r);
    }
  }
  const allocation = reserve(memory, actors, main);

  const out = allocation.placed.map(({ actor, room, seat }) => {
    const destination = { x: room.seats[seat], y: FLOORS[room.floor].feet };
    // A session or a tool whose state changed walks from its old room to the new one
    const collection = actor.kind === 'tool' ? 'tools' : 'sessions';
    const prefix = actor.kind === 'tool' ? 't:' : 's:';
    const record = actor.kind === 'agent' ? null : latest(past.filter((h) => (h.snapshot[collection] || []).some((x) => prefix + x.id === actor.id && x.state !== actor.state)));
    const changed = !!record;
    let arrival = actor.startAt ?? actor.data.since ?? -Infinity;
    let source = null;
    if (changed) {
      const boundary = past.find((h) => h.t > record.t && (h.snapshot[collection] || []).some((x) => prefix + x.id === actor.id && x.state === actor.state));
      arrival = boundary?.t ?? arrival;
      const old = placementAt.get(record.t)?.placed.find((p) => p.actor.id === actor.id);
      if (old) source = { x: old.room.seats[old.seat], y: FLOORS[old.room.floor].feet };
    }
    const travelStart = arrival + (changed ? SIT_MS : 0);
    const route = walkingRoute(source ?? ENTRY, destination);
    const routeLength = route.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - route[i].x, p.y - route[i].y), 0);
    const travelMs = clamp(routeLength / 0.55, 900, 5500);
    const travel = clamp((now - travelStart) / travelMs, 0, 1);
    let direction = 1;
    let mobility = 'walk';
    let x = destination.x;
    let y = destination.y;
    if (travel < 1 && Number.isFinite(arrival)) {
      const p = routePosition(route, travel);
      x = p.x;
      y = p.y;
      direction = p.direction;
      if (Math.abs(x - LIFT_X) < 1 && route.length > 2 && Math.abs(y - route[0].y) > 1) mobility = 'lift';
    }
    const pose = actorPose({ state: actor.state, time: now, arrivedAt: travelStart + travelMs, stateAt: Math.max(actor.stateAt, arrival), goneAt: actor.goneAt });
    if (changed && now - arrival < SIT_MS) {
      // it stands up where it was first
      x = source?.x ?? x;
      y = source?.y ?? y;
      Object.assign(pose, { sheet: 'move', frame: 8 + Math.floor(Math.max(0, now - arrival) / SIT_FRAME_MS), alpha: 1, moving: true, fast: true });
    } else if (travel < 1 && actor.goneAt == null) Object.assign(pose, { sheet: 'move', frame: 11, alpha: 1, moving: true, fast: true });
    if (mobility === 'lift' && actor.goneAt == null) pose.frame = 10;
    if (actor.goneAt != null) {
      // it walks off to the lift
      x = lerp(destination.x, LIFT_X, pose.walk);
      y = destination.y;
      direction = LIFT_X >= destination.x ? 1 : -1;
      mobility = 'walk';
    }
    const furniture = seatGeometry(room, seat);
    if (furniture.posture === 'standing') {
      if (actor.goneAt != null) {
        const w = clamp((now - actor.goneAt) / LEAVE_MS, 0, 1);
        Object.assign(pose, { sheet: 'move', frame: 11, walk: w, alpha: 1 - w });
        x = lerp(destination.x, LIFT_X, w);
      } else if (travel === 1) Object.assign(pose, { sheet: 'activity', frame: Math.floor(now / 700) % 4, alpha: 1 });
    }
    // The walking frame (11, "turns to go") faces left in both drawings, the person's and the robot's: it is flipped when
    // the walk goes right. (It once assumed the person faced right, so a person walked backwards to its desk.)
    const walkNativeDirection = WALK_FACING;
    return { ...actor, room, seat, x, y, destination, pose, arrival, travel, route, direction, walkNativeDirection, walkFlip: direction !== walkNativeDirection, mobility, furniture };
  });

  // The links from a lead (or the agent that started one) to its agents, the cards on them, the lead's light
  const byId = new Map(out.map((a) => [a.id, a]));
  const links = [];
  const cards = [];
  const flashes = [];
  for (const a of out.filter((x) => x.kind === 'agent')) {
    const chief = byId.get(`s:${a.sessionId}`);
    const owner = byId.get(a.parentId) ?? chief;
    if (!owner) continue;
    const age = a.goneAt == null ? null : now - a.goneAt;
    const colorOwner = chief?.id ?? owner.id;
    links.push({ from: owner.id, to: a.id, colorOwner, background: !!a.a.background, alpha: age == null ? 1 : clamp(1 - age / RESULT_CARD_MS, 0, 1) });
    if (now - a.startAt < TASK_CARD_MS) cards.push({ kind: 'task', from: { x: owner.destination.x + 28, y: owner.destination.y }, to: { x: a.destination.x + 28, y: a.destination.y }, p: clamp((now - a.startAt) / TASK_CARD_MS, 0, 1), owner: colorOwner });
    if (age != null && age < RESULT_CARD_MS) cards.push({ kind: 'result', from: { x: a.destination.x + 28, y: a.destination.y }, to: { x: owner.destination.x + 28, y: owner.destination.y }, p: clamp((age - 400) / 1200, 0, 1), owner: colorOwner });
    if (age != null && age >= 1500 && age < DONE_MS) flashes.push({ id: owner.id, strength: 1 - (age - 1500) / 800 });
  }

  // Tool icons: per actor, one 600 ms window at a time with how many calls came in it
  const groups = new Map();
  for (const tick of ticks) {
    const [t, id, cat, projectId] = tick;
    if (t > now || now - t > 3000 || projectId !== snap.project.id) continue;
    const g = groups.get(id);
    if (!g || t - g.t >= ICON_GROUP_MS) groups.set(id, { id, cat, t, count: 1 });
    else g.count++;
  }
  const icons = out.map((a) => groups.get(a.id)).filter((g) => g && now - g.t < ICON_MS);

  // Workflows: how many of their agents run and how many finished (which phase runs is not in the data: not guessed)
  const workflows = (snap.workflows || []).map((w) => {
    const done = new Set((snap.agents || []).filter((a) => a.workflowRunId === w.id && a.status === 'done').map((a) => a.id));
    for (const h of past) for (const a of h.snapshot.agents || []) if (a.workflowRunId === w.id && doneAt.has(`a:${a.id}`)) done.add(a.id);
    const running = (snap.agents || []).filter((a) => a.workflowRunId === w.id && a.status === 'running').length;
    const lead = byId.get(`s:${w.sessionId}`);
    return { ...w, running, done: done.size, floor: lead?.room.floor ?? 0 };
  });

  const fixtures = fixtureList(out);
  const doors = FLOORS.flatMap((floor, i) => DOOR_XS.map((x) => ({ id: `door:${i}:${x}`, floor: i, x, y: floor.feet, open: out.some((a) => a.travel < 1 && Math.abs(a.x - x) < 60 && Math.abs(a.y - floor.feet) < 16) })));
  return {
    now,
    project: snap.project,
    actors: out,
    allActors: actors,
    more: allocation.more,
    links,
    cards,
    flashes,
    icons,
    workflows,
    fixtures,
    doors,
    quota: snap.quota || null,
    waiting: out.filter((a) => a.state === 'waiting' && a.goneAt == null),
    // The job (docs/simplify.md): its step for the four lamps, the lead whose plan waits for approval, and whether
    // its result is ready (the team's last step and the lead waits for the person)
    job: snap.job || null,
    planPending: out.find((a) => a.kind === 'session' && a.goneAt == null && a.data.planPending)?.id || null,
    resultReady: snap.job?.step === 'finish' ? out.find((a) => a.kind === 'session' && a.goneAt == null && a.state === 'waiting' && !a.data.planPending)?.id || null : null,
    closed: snap.project.state === 'closed',
    moving: out.some((a) => a.pose.moving || a.data?.planPending) || icons.length > 0 || cards.length > 0 || snap.job?.step === 'finish',
    events: allEvents.filter((e) => e.t >= now - HISTORY_MS),
    snapshot: snap,
  };
}

// The four lamps of the sign (docs/simplify.md): done, now or ahead per step of the job (pure); no job: all dark
export const JOB_STEPS = Object.freeze(['plan', 'build', 'check', 'finish']);
export function jobLamps(job) {
  if (!job) return JOB_STEPS.map(() => 'off');
  const at = job.step === 'done' ? JOB_STEPS.length : JOB_STEPS.indexOf(job.step);
  return JOB_STEPS.map((_, i) => (i < at ? 'done' : i === at ? 'now' : 'off'));
}

// ---------- the history ----------
// What a snapshot is made of, for the history: a new entry only when someone came, went or changed state
export function snapshotKey(s) {
  return JSON.stringify([
    s.project?.state,
    (s.sessions || []).map((x) => [x.id, x.state]),
    (s.agents || []).map((x) => [x.id, x.status]),
    (s.tools || []).map((x) => [x.id, x.state]),
    (s.workflows || []).map((x) => [x.id, x.status]),
  ]);
}
// Adds a snapshot to a project's history (mutates it): kept when it differs from the last one, at most 15 minutes and
// `max` entries back. The oldest entries go in batches, so the seats are not worked out again every time.
export function recordHistory(history, snapshot, { max = 400, ms = HISTORY_MS } = {}) {
  const last = history[history.length - 1];
  if (last && last.t >= snapshot.now) return history;
  const key = snapshotKey(snapshot);
  if (last && last.key === key) return history;
  history.push({ t: snapshot.now, key, snapshot });
  const old = history.findIndex((h) => h.t >= snapshot.now - ms);
  if (history.length > max + 50) history.splice(0, history.length - max);
  else if (old > 50) history.splice(0, old);
  return history;
}

// ---------- the demo ----------
// The three-minute example (the "Play" button): every movement of the building at least once, in the same data shape
// as the app's. word(key): the localized text of a ws* key (strings/workshop.js).
export const DEMO_MS = 180000;
export function createDemo(word) {
  const base = { now: 0, project: { id: 'demo', name: word('brand'), state: 'busy', mainRoomKind: 'dev' }, sessions: [{ id: 'chief', title: word('chief'), model: 'Opus', state: 'busy', since: 0, lastAction: { t: 0, tool: 'Read', cat: 'read', text: word('readAction') } }], agents: [], workflows: [], tools: [], quota: null, job: { step: 'plan' } };
  const events = [];
  const ticks = [];
  const history = [];
  let seq = 0;
  const schedule = [];
  const at = (t, fn) => schedule.push({ t, fn });
  const emit = (t, kind, actor, text, meta = {}) => events.push({ t, kind, sessionId: actor === 's:second' ? 'second' : 'chief', actor, text, meta });
  const checkpoint = (t) => {
    base.now = t;
    history.push({ t, snapshot: clone(base) });
  };
  const TYPES = { research: 'research', build: 'worker', review: 'tester', nested: 'research', designTask: 'designer' };
  const spawn = (id, label, key, model, depth, parent, background = false, workflowRunId = 'wf') => (t) => {
    const a = { id, sessionId: 'chief', toolUseId: `use-${id}`, type: TYPES[label], title: word(label), description: word(key), model, depth, workflowRunId, background, startedAt: t, lastAt: t, toolCalls: 0, toolCounts: {}, tokensOut: 0, status: 'running' };
    base.agents.push(a);
    emit(t, 'agent_start', parent, word('assigned'), { type: a.type, toolUseId: a.toolUseId });
  };
  const finish = (id) => (t) => {
    const a = base.agents.find((x) => x.id === id);
    a.status = 'done';
    a.lastAt = t;
    emit(t, 'agent_done', `a:${id}`, word('completed'));
  };
  const TOOL = { read: 'Read', write: 'Edit', shell: 'Bash', web: 'WebFetch', agent: 'Agent', skill: 'Skill', workflow: 'Workflow', mcp: 'mcp__local', other: 'Other' };
  const call = (id, cat) => (t) => {
    ticks.push([t, id, cat, 'demo', seq++]);
    const tool = TOOL[cat];
    const lastAction = { t, tool, cat, text: word(`${cat}Action`) };
    if (id.startsWith('a:')) {
      const a = base.agents.find((x) => `a:${x.id}` === id);
      if (!a || a.status !== 'running') return;
      a.toolCalls++;
      a.toolCounts[tool] = (a.toolCounts[tool] || 0) + 1;
      a.tokensOut += 120;
      a.lastAt = t;
      a.lastAction = lastAction;
    } else {
      const s = base.sessions.find((x) => `s:${x.id}` === id);
      if (!s) return;
      s.lastAction = lastAction;
      s.toolCounts = { ...(s.toolCounts || {}), [tool]: (s.toolCounts?.[tool] || 0) + 1 };
    }
  };
  const lead = () => base.sessions.find((s) => s.id === 'chief');
  at(0, (t) => emit(t, 'live', 's:chief', word('working'), { status: 'busy' }));
  // The plan waits for approval, then the team works through the four steps (docs/simplify.md)
  at(1500, (t) => {
    Object.assign(lead(), { state: 'waiting', since: t, plan: { t, text: word('demoPlan') }, planPending: true, lastAction: { t, tool: 'ExitPlanMode', cat: 'other', text: word('signPlan') } });
    base.project.state = 'waiting';
    emit(t, 'live', 's:chief', word('prompt'), { status: 'waiting' });
  });
  at(4500, (t) => {
    Object.assign(lead(), { state: 'busy', since: t, planPending: false });
    base.project.state = 'busy';
    base.job = { step: 'build', tasks: { done: 0, total: 4 } };
    emit(t, 'live', 's:chief', word('working'), { status: 'busy' });
  });
  at(66000, () => {
    base.job = { step: 'check', tasks: { done: 4, total: 4 } };
  });
  at(96000, () => {
    base.job = { step: 'finish', tasks: { done: 4, total: 4 }, review: { verdict: 'APPROVE' } };
  });
  at(3000, (t) => {
    base.workflows.push({ id: 'wf', sessionId: 'chief', name: word('workflowName'), status: 'running', agentCount: 4, phases: [word('phaseExplore'), word('phaseBuild'), word('phaseVerify')] });
    emit(t, 'workflow_start', 's:chief', word('workflowStart'));
  });
  at(5000, spawn('research', 'research', 'researchTask', 'Sonnet', 1, 's:chief'));
  at(12000, spawn('build', 'build', 'buildTask', 'Sonnet', 1, 's:chief'));
  at(20000, spawn('nested', 'nested', 'nestedTask', 'Haiku', 2, 'a:research', true));
  at(35000, spawn('review', 'review', 'reviewTask', 'Sonnet', 1, 's:chief', true));
  at(42000, () => {
    base.tools = [
      { id: 'codex', name: 'Codex', state: 'busy' },
      { id: 'gemini', name: 'Gemini', state: 'busy' },
    ];
    base.quota = { fiveHourPct: 64, weeklyPct: 43 };
  });
  at(50000, (t) => base.sessions.push({ id: 'second', title: word('second'), model: 'Haiku', state: 'busy', since: t, lastAction: { t, tool: 'Read', cat: 'read', text: word('readAction') } }));
  at(58000, finish('nested'));
  at(66000, finish('research'));
  at(80000, finish('build'));
  at(94000, finish('review'));
  at(96000, (t) => {
    base.workflows[0].status = 'done';
    emit(t, 'workflow_done', 's:chief', word('workflowDone'));
  });
  at(100000, (t) => {
    Object.assign(lead(), { state: 'waiting', since: t, lastAction: { t, tool: '', cat: 'other', text: word('waitAction') } });
    base.project.state = 'waiting';
    base.quota = { fiveHourPct: 82, weeklyPct: 70 };
    // the app's feed says it the same way: the session's state became "waiting for you"
    emit(t, 'live', 's:chief', word('prompt'), { status: 'waiting' });
  });
  at(112000, (t) => {
    Object.assign(base.sessions[1], { state: 'left', since: t, lastAction: { t, tool: '', cat: 'other', text: word('restAction') } });
    base.tools[1].state = 'left';
  });
  at(120000, (t) => {
    base.job = { step: 'done', tasks: { done: 4, total: 4 } };
    Object.assign(lead(), { state: 'busy', since: t });
    base.project.state = 'busy';
    emit(t, 'live', 's:chief', word('working'), { status: 'busy' });
  });
  at(124000, spawn('design', 'designTask', 'designDescription', null, 1, 's:chief', false, null));
  at(133000, () => {
    base.quota = { fiveHourPct: 96, weeklyPct: 86 };
  });
  at(140000, finish('design'));
  at(145000, (t) => {
    Object.assign(lead(), { state: 'left', since: t, lastAction: { t, tool: '', cat: 'other', text: word('restAction') } });
    base.project.state = 'left';
  });
  at(156000, (t) => {
    emit(t, 'live', 's:second', word('exitAction'), { status: 'closed' });
    base.sessions = base.sessions.filter((s) => s.id !== 'second');
  });
  at(164000, (t) => {
    base.sessions = [];
    emit(t, 'live', 's:chief', word('exitAction'), { status: 'closed' });
    base.tools = [];
  });
  at(167000, (t) => {
    base.agents = [];
    base.project.state = 'closed';
    base.quota = null;
    emit(t, 'live', 's:chief', word('closed'));
  });
  at(179000, () => {});
  const CATS = ['read', 'write', 'shell', 'web', 'agent', 'skill', 'workflow', 'mcp', 'other'];
  for (let t = 7000; t < 93000; t += 2700) {
    const id = t < 12000 ? 'a:research' : t < 20000 ? 'a:build' : t < 58000 ? 'a:nested' : t < 66000 ? 'a:research' : t < 80000 ? 'a:build' : 'a:review';
    at(t, call(id, CATS[Math.floor(t / 2700) % 9]));
  }
  CATS.forEach((cat, i) => at(1000 + i * 3500, call('s:chief', cat)));
  [0, 100, 200].forEach((d) => at(28000 + d, call('a:build', 'write')));
  at(126000, call('a:design', 'write'));
  at(129000, call('a:design', 'read'));
  schedule.sort((a, b) => a.t - b.t);
  for (const item of schedule) {
    item.fn(item.t);
    checkpoint(item.t);
  }
  return { snapshot: clone(base), events: events.sort((a, b) => a.t - b.t), ticks, history };
}

// What one feed event says on the rewind's track and in "Recent activity": a key of strings/workshop.js (without its
// ws prefix) and the dot's kind, or null for an event the workshop does not show
export function eventLabel(e) {
  if (e.kind === 'agent_start') return { key: 'assigned', dot: '' };
  if (e.kind === 'agent_done') return { key: 'completed', dot: 'done' };
  if (e.kind === 'workflow_start') return { key: 'workflowStart', dot: '' };
  if (e.kind === 'workflow_done') return { key: 'workflowDone', dot: 'done' };
  if (e.kind === 'prompt') return { key: 'userPrompt', dot: '' };
  if (e.kind === 'live') {
    const st = e.meta?.status;
    if (st === 'waiting' || st === 'idle') return { key: 'prompt', dot: 'prompt' };
    if (st === 'closed') return { key: 'exitAction', dot: '' };
    if (st === 'busy') return { key: 'working', dot: '' };
  }
  return null;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function lerp(a, b, p) {
  return a + (b - a) * p;
}
function latest(items) {
  return items.length ? items[items.length - 1] : null;
}
