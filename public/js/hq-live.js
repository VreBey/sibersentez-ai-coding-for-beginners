// The workshop building's live data (docs/hq.md): one project of the store as the snapshot hq-scene.js sceneFrom reads,
// its events and tool calls, the order of the projects, each project's kind (its main room) and the snapshots kept for
// the rewind ("What happened?"). The store is a parameter so the tests can pass their own.
import { groupSessions, projectState, sessionState, isOtherFolder } from './attention.js';
import { projectRoomKind, toolActors, TOOL_NAMES, DONE_MS, HISTORY_MS, recordHistory } from './hq-scene.js';

// A model's short name for the plates: "Opus 5.5", "Sonnet 5.5"; null when unknown
export function shortModel(m) {
  if (!m) return null;
  const x = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(m);
  if (!x) return String(m).slice(0, 18);
  const ver = x[3] && x[3].length <= 2 ? `${x[2]}.${x[3]}` : x[2];
  return `${x[1][0].toUpperCase()}${x[1].slice(1)} ${ver}`;
}

// A text cut with "…" (the plates on the drawing stay short; the card shows the whole text)
export function cut(text, max = 30) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// The projects the workshop can show, the most urgent first (the attention order): an unregistered folder while
// something is open in it or it was worked in during the last 3 days; a folder that is not a project only while
// something is open in it
export function projectsInOrder(store, now = Date.now()) {
  const byProject = groupSessions(store.sessions.values());
  const recent = now - 3 * 86400000;
  return store
    .sortedProjects(now)
    .map((p) => ({ p, state: projectState(p, byProject, now), open: (byProject.get(p.id) || []).filter((s) => sessionState(s, now) !== 'closed').length }))
    .filter(({ p, state }) => (isOtherFolder(p) ? state !== 'closed' : p.kind !== 'adhoc' || state !== 'closed' || p.lastActivity > recent));
}

// Names to show for projects: shared with the project cards (format.js)
export { projectNames } from './format.js';

// The title of a plan the lead wrote: its first heading, "Plan:" left out ('' when it has none)
export function planTitle(text) {
  const line = String(text || '')
    .split('\n')
    .find((l) => /^#\s+\S/.test(l));
  return line ? line.replace(/^#\s+/, '').replace(/^plan\s*[:—-]\s*/i, '').trim() : '';
}

// A lead's name: the tool names a session with a short English slug ("lotr-style-opening-clarification"); a lead with
// a plan goes by the plan's title, in the person's language. A title the person gave (no slug) is kept.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
export function leadName(s, label) {
  const name = label(s);
  return SLUG_RE.test(name) && planTitle(s.plan?.text) ? planTitle(s.plan.text) : name;
}

// One project as the scene's snapshot. mainRoomKind: the project's kind (KindCache); label(s): a session's title.
export function liveSnapshot(store, p, { now = Date.now(), mainRoomKind = 'dev', label = (s) => s.title || '', job = null } = {}) {
  const byProject = groupSessions(store.sessions.values());
  const sessions = (byProject.get(p.id) || [])
    .map((s) => ({ s, state: sessionState(s, now) }))
    .filter((x) => x.state !== 'closed')
    .map(({ s, state }) => ({
      id: s.id,
      title: cut(leadName(s, label)),
      fullTitle: leadName(s, label),
      model: shortModel(s.model),
      state,
      since: Number(s.live?.since) || s.lastAt || now,
      lastAction: s.lastAction || null,
      toolCounts: s.toolCounts || null,
      toolCalls: s.toolCalls || 0,
      tokensOut: s.tokensOut || 0,
      startedAt: s.startedAt || null,
      description: s.lastPrompt || s.firstPrompt || '',
      // The plan it shows for approval (Claude Code's plan mode): pending while it waits on that very question
      plan: s.plan?.text ? { t: s.plan.t, text: s.plan.text } : null,
      planPending: state === 'waiting' && s.lastAction?.tool === 'ExitPlanMode' && !!s.plan?.text,
    }));
  // The running agents, and the ones that finished a moment ago (they still hand their result over)
  const agents = [...store.agents.values()]
    .filter((a) => a.projectId === p.id && (a.status === 'running' || now - (a.lastAt || 0) < DONE_MS))
    .map((a) => ({
      id: a.id,
      sessionId: a.sessionId,
      toolUseId: a.toolUseId ?? null,
      type: a.type,
      title: cut(a.type, 24),
      description: a.label || '',
      model: shortModel(a.model),
      depth: a.depth || 1,
      workflowRunId: a.workflowRunId || null,
      background: !!a.background,
      startedAt: a.startedAt,
      lastAt: a.lastAt,
      toolCalls: a.toolCalls || 0,
      toolCounts: a.toolCounts || {},
      tokensOut: a.tokensOut || 0,
      status: a.status === 'running' ? 'running' : 'done',
      lastAction: a.lastAction || null,
    }));
  // Workflows that run, or ended within the rewind's reach
  const workflows = [...store.workflows.values()]
    .filter((w) => w.projectId === p.id && (w.status === 'running' || now - (w.endedAt || w.startedAt || 0) < HISTORY_MS))
    .map((w) => ({ id: w.id, sessionId: w.sessionId, name: w.name || '', status: w.status === 'running' ? 'running' : 'done', agentCount: w.agentCount || 0, phases: Array.isArray(w.phases) ? w.phases.map(String) : [] }));
  const tools = toolActors(p, now).map((x) => ({ id: x.tool, name: TOOL_NAMES[x.tool] || x.tool, state: x.state }));
  return { now, project: { id: p.id, name: p.name, state: projectState(p, byProject, now), mainRoomKind }, sessions, agents, workflows, tools, quota: null, job: jobOf(job) };
}

// A project's job from the team's hand-off files (GET /api/projects/<id>/team, views/job.js): the step and its
// counts, or null when no job of the team is there
const STEPS = ['plan', 'build', 'check', 'finish', 'done'];
export function jobOf(d) {
  if (!d || !STEPS.includes(d.step)) return null;
  return { step: d.step, tasks: d.tasks || null, review: d.review || null, current: d.current || null, title: d.plan?.title || null, updatedAt: d.updatedAt || null };
}

// The project's feed and tool calls within the rewind's reach (the scene reads nothing older)
export function liveEvents(store, projectId, now = Date.now()) {
  const from = now - HISTORY_MS;
  const out = [];
  for (let i = store.events.length - 1; i >= 0; i--) {
    const e = store.events[i];
    if (e.t < from) break;
    if (e.projectId === projectId) out.push(e);
  }
  return out.reverse();
}
export function liveTicks(store, projectId, now = Date.now()) {
  const out = [];
  for (let i = store.ticks.length - 1; i >= 0; i--) {
    const tk = store.ticks[i];
    if (tk[0] < now - 5000) break;
    if (tk[3] === projectId) out.push(tk);
  }
  return out.reverse();
}

// A project's kind from its tags (GET /api/projects/<id>/fit, read-only and cached by the server): 'dev' until known,
// asked again after five minutes
const KIND_MS = 5 * 60000;
export class KindCache {
  constructor(onChange) {
    this.kinds = new Map();
    this.onChange = onChange;
  }
  kindOf(id) {
    const e = this.kinds.get(id);
    if (e && (e.pending || Date.now() - e.at <= KIND_MS)) return e.kind;
    const next = { kind: e?.kind || 'dev', at: Date.now(), pending: true };
    this.kinds.set(id, next);
    fetch(`/api/projects/${encodeURIComponent(id)}/fit`, { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (d) => this.kinds.set(id, { kind: projectRoomKind(d?.project?.tags), at: Date.now(), pending: false }),
        () => this.kinds.set(id, { kind: next.kind, at: Date.now(), pending: false }),
      )
      .then(() => this.onChange?.());
    return next.kind;
  }
}

// The snapshots of each project, kept while the page is open (15 minutes back): the rewind's memory
// The rewind before the app started (docs/hq.md): the project's last minutes rebuilt from what the logs say, the tool
// calls and prompts of each session and each agent's start and last line. A session works while it acts (a tool call
// or a prompt within PAST_ACT_MS), rests after that, and is gone once quiet for PAST_STAY_MS; an agent runs from its
// start to its last line. Nobody is shown waiting for the person: the logs cannot say it, and a false call is worse
// than none. Returns snapshots in time order, one per `step`, in liveSnapshot's shape.
export const PAST_ACT_MS = 45000;
export const PAST_STAY_MS = 5 * 60000;
export function pastSnapshots(store, p, { from, to, step = 5000, mainRoomKind = 'dev', label = (s) => s.title || '' } = {}) {
  const acts = new Map(); // actor -> sorted times
  const add = (actor, t) => {
    if (!acts.has(actor)) acts.set(actor, []);
    acts.get(actor).push(t);
  };
  for (const tk of store.ticks) if (tk[3] === p.id && tk[0] >= from - PAST_STAY_MS && tk[0] <= to) add(tk[1], tk[0]);
  for (const e of store.events) if (e.projectId === p.id && e.kind === 'prompt' && e.t >= from - PAST_STAY_MS && e.t <= to) add(`s:${e.sessionId}`, e.t);
  for (const list of acts.values()) list.sort((a, b) => a - b);
  // The last act at or before t (binary search)
  const lastAct = (list, t) => {
    let lo = 0;
    let hi = list.length - 1;
    let best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= t) {
        best = list[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  };
  const sessions = [...store.sessions.values()].filter((s) => s.projectId === p.id && acts.has(`s:${s.id}`));
  const agents = [...store.agents.values()].filter((a) => a.projectId === p.id && a.startedAt && a.startedAt <= to && (a.lastAt || a.startedAt) + DONE_MS >= from);
  const out = [];
  for (let t = from; t < to; t += step) {
    const ss = [];
    for (const s of sessions) {
      const list = acts.get(`s:${s.id}`);
      const last = lastAct(list, t);
      if (last == null || t - last > PAST_STAY_MS) continue;
      // Seated from its first act in reach, so it does not walk in again at every moment
      const since = Math.max(s.startedAt || list[0], list[0]);
      ss.push({ id: s.id, title: cut(leadName(s, label)), fullTitle: leadName(s, label), model: shortModel(s.model), state: t - last <= PAST_ACT_MS ? 'busy' : 'left', since, lastAction: null, toolCounts: null, toolCalls: 0, tokensOut: 0, startedAt: s.startedAt || null, description: s.lastPrompt || s.firstPrompt || '', plan: null, planPending: false });
    }
    const ag = agents
      .filter((a) => a.startedAt <= t && t <= (a.lastAt || a.startedAt) + DONE_MS)
      .map((a) => ({ id: a.id, sessionId: a.sessionId, toolUseId: a.toolUseId ?? null, type: a.type, title: cut(a.type, 24), description: a.label || '', model: shortModel(a.model), depth: a.depth || 1, workflowRunId: a.workflowRunId || null, background: !!a.background, startedAt: a.startedAt, lastAt: a.lastAt, toolCalls: 0, toolCounts: {}, tokensOut: 0, status: t <= (a.lastAt || a.startedAt) ? 'running' : 'done', lastAction: null }));
    const state = ss.some((x) => x.state === 'busy') || ag.some((x) => x.status === 'running') ? 'busy' : ss.length ? 'left' : 'closed';
    out.push({ now: t, project: { id: p.id, name: p.name, state, mainRoomKind }, sessions: ss, agents: ag, workflows: [], tools: [], quota: null, job: null });
  }
  return out;
}

export class LiveHistory {
  constructor() {
    this.byProject = new Map();
    this.seeded = new Set();
  }
  // The rewind's past before the app started, once per project (make() gives the rebuilt snapshots, oldest first):
  // they go before what was recorded, never after it
  seed(projectId, make) {
    if (this.seeded.has(projectId)) return;
    this.seeded.add(projectId);
    const h = this.of(projectId);
    const first = h.length ? h[0].t : Infinity;
    const past = [];
    for (const s of make()) if (s.now < first) recordHistory(past, s, { max: Infinity });
    h.unshift(...past);
  }
  of(projectId) {
    let h = this.byProject.get(projectId);
    if (!h) this.byProject.set(projectId, (h = []));
    return h;
  }
  record(snapshot) {
    return recordHistory(this.of(snapshot.project.id), snapshot);
  }
}

// Each project's job (the team's files), asked again after ttl ms while the building shows it
export class TeamCache {
  constructor(onChange, ttl = 8000) {
    this.data = new Map();
    this.onChange = onChange;
    this.ttl = ttl;
  }
  jobOf(id) {
    const e = this.data.get(id);
    if (e && (e.pending || Date.now() - e.at < this.ttl)) return e.value;
    const next = { value: e?.value ?? null, at: Date.now(), pending: true };
    this.data.set(id, next);
    fetch(`/api/projects/${encodeURIComponent(id)}/team`, { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (d) => this.data.set(id, { value: d, at: Date.now(), pending: false }),
        () => this.data.set(id, { value: next.value, at: Date.now(), pending: false }),
      )
      .then(() => this.onChange?.());
    return next.value;
  }
}
