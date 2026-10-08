// Turns the in-memory model into plain objects for the browser (snapshot and patch).
import { WINDOW_DAYS, SNAPSHOT_TICKS } from './config.mjs';
import { randomUUID } from 'node:crypto';
import { BUILTIN_AGENTS } from './catalog.mjs';

// New on every server start: when the client sees it, it resets its sequence numbers (a restart)
export const BOOT_ID = randomUUID();

const HOUR = 3600000;

function sumHours(m, fromHour) {
  if (!m) return 0;
  let s = 0;
  for (const [h, n] of m) if (h >= fromHour) s += n;
  return s;
}

function hourSeries(m, hours) {
  const now = Math.floor(Date.now() / HOUR);
  const out = new Array(hours).fill(0);
  if (!m) return out;
  for (const [h, n] of m) {
    const i = hours - 1 - (now - h);
    if (i >= 0 && i < hours) out[i] += n;
  }
  return out;
}

export function sessionView(ing, s) {
  const agentIds = ing.sessionAgents.get(s.id);
  let running = 0;
  let agentCount = 0;
  if (agentIds) {
    for (const id of agentIds) {
      const a = ing.agents.get(id);
      if (!a) continue;
      agentCount++;
      if (a.status === 'running') running++;
    }
  }
  return {
    id: s.id,
    tool: s.tool || 'claude',
    projectId: s.projectId,
    title: s.title,
    firstPrompt: s.firstPrompt,
    jobId: s.jobId || null,
    jobText: s.jobText || null,
    lastPrompt: s.lastPrompt,
    lastPromptAt: s.lastPromptAt,
    promptCount: s.promptCount,
    startedAt: s.startedAt,
    lastAt: s.lastAt,
    model: s.model,
    tokensOut: s.tokensOut,
    contextTokens: s.contextTokens,
    toolCalls: s.toolCalls,
    agentCount,
    runningAgents: running,
    skills: s.skills,
    workflowCount: s.workflows.length,
    branch: s.branch,
    version: s.version,
    compacts: s.compacts,
    live: s.live ? { status: s.live.status, pid: s.live.pid, name: s.live.name, since: s.live.statusUpdatedAt, waitingFor: s.live.waitingFor || '' } : null,
    cwd: s.cwd,
    lastAction: s.lastAction || null,
    toolCounts: s.toolCounts || {},
    plan: s.plan || null,
    apiError: s.apiError || null,
    permissionMode: s.permissionMode || null,
  };
}

export function agentView(a) {
  return {
    id: a.id,
    sessionId: a.sessionId,
    projectId: a.projectId,
    type: a.type,
    label: a.description,
    depth: a.depth,
    workflowRunId: a.workflowRunId,
    background: a.background,
    startedAt: a.startedAt,
    lastAt: a.lastAt,
    toolCalls: a.toolCalls,
    tokensOut: a.tokensOut,
    status: a.status,
    model: a.model,
    lastAction: a.lastAction || null,
    // The workshop (docs/hq.md): which call started it (its lead or another agent) and its tool calls by tool
    toolUseId: a.toolUseId || null,
    toolCounts: a.toolCounts || {},
  };
}

export function workflowView(w) {
  const { doneEmitted, ...rest } = w;
  return rest;
}

// catalog: to say where an unregistered folder sits (place); optional so older callers still work
export function projectView(ing, p, catalog = null) {
  const sids = ing.projectSessions.get(p.id) || new Set();
  const aids = ing.projectAgents.get(p.id) || new Set();
  let lastActivity = 0;
  let live = 0;
  let busy = 0;
  let sessions = 0;
  const recent = [];
  for (const id of sids) {
    const s = ing.sessions.get(id);
    // Same filter as the snapshot: sessions with no timestamp at all (empty) are not counted
    if (!s || !(s.lastAt || s.live)) continue;
    sessions++;
    if (s.lastAt > lastActivity) lastActivity = s.lastAt;
    if (s.live) {
      live++;
      if (s.live.status === 'busy') busy++;
      if ((s.live.statusUpdatedAt || 0) > lastActivity) lastActivity = s.live.statusUpdatedAt;
    }
    if (s.title || s.lastPrompt) recent.push({ t: s.lastAt || s.startedAt, kind: 'session', text: s.title || s.lastPrompt, ref: s.id, live: !!s.live });
  }
  let running = 0;
  const runningTypes = {};
  for (const id of aids) {
    const a = ing.agents.get(id);
    if (!a) continue;
    if (a.lastAt > lastActivity) lastActivity = a.lastAt;
    if (a.status === 'running') {
      running++;
      runningTypes[a.type] = (runningTypes[a.type] || 0) + 1;
    } else if (a.status === 'done' && !a.workflowRunId) {
      recent.push({ t: a.lastAt, kind: 'agent', text: a.description || a.type, ref: a.id, type: a.type });
    }
  }
  for (const w of ing.workflows.values()) {
    if (w.projectId !== p.id) continue;
    recent.push({ t: w.endedAt || w.startedAt, kind: 'workflow', text: w.name || w.id, ref: w.id, status: w.status });
  }
  for (const c of p.git?.commits || []) recent.push({ t: c.t, kind: 'commit', text: c.s, ref: c.h });
  for (const c of p.git?.commits || []) if (c.t > lastActivity) lastActivity = c.t;
  recent.sort((a, b) => b.t - a.t);
  // A project found outside the log window still shows when it was last used (newest session file)
  if ((p.lastSeenAt || 0) > lastActivity) lastActivity = p.lastSeenAt;
  const pm = ing.projHourly.get(p.id);
  const h24 = Math.floor(Date.now() / HOUR) - 23;
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    path: p.path,
    exists: p.exists,
    // Nothing but AI tools' setup in the folder (fsutil toolsOnly): a moved project's old folder
    toolsOnly: !!p.toolsOnly,
    broad: !!p.broad,
    place: typeof catalog?.placeOf === 'function' ? catalog.placeOf(p) : null,
    description: p.description,
    status: p.status,
    phase: p.phase,
    stack: p.stack,
    packages: p.packages,
    rules: p.rules,
    build: p.build || null,
    plan: p.plan || null,
    installed: p.installed || { skills: 0, agents: 0 },
    git: p.git || null,
    lastActivity,
    lastSeenAt: p.lastSeenAt || null,
    via: p.via || [],
    // When each tool last left a trace here (catalog.mjs; the building shows another tool at work)
    toolSeen: p.toolSeen || {},
    // The user's idea for the project (docs/start-flow.md), kept in the program's project memory; null when none
    idea: typeof p.idea === 'string' && p.idea ? p.idea : null,
    sessions,
    live,
    busy,
    runningAgents: running,
    runningTypes,
    agentsTotal: aids.size,
    stats24: {
      tools: sumHours(pm?.get('tools'), h24),
      tokens: sumHours(pm?.get('tokens'), h24),
      prompts: sumHours(pm?.get('prompt'), h24) + sumHours(pm?.get('command'), h24),
      agents: sumHours(pm?.get('agent_start'), h24),
      commits: sumHours(pm?.get('commit'), h24),
    },
    hourly: hourSeries(pm?.get('tools'), 48),
    recent: recent.slice(0, 12),
    // Tokens and API-equivalent dollars of the last 30 days (server/usage.mjs); null without usage or a ledger
    usage30: ing.ledger ? ing.ledger.projectUsage(p.id) : null,
  };
}

export function kpiView(ing) {
  const h24 = Math.floor(Date.now() / HOUR) - 23;
  const g = (k) => sumHours(ing.hourly.get(k), h24);
  let runningAgents = 0;
  for (const a of ing.agents.values()) if (a.status === 'running') runningAgents++;
  let live = 0;
  let busy = 0;
  for (const s of ing.sessions.values()) {
    if (!s.live) continue;
    live++;
    if (s.live.status === 'busy') busy++;
  }
  let runningWorkflows = 0;
  for (const w of ing.workflows.values()) if (w.status === 'running') runningWorkflows++;
  return {
    live,
    busy,
    runningAgents,
    runningWorkflows,
    day: {
      tools: g('tools'),
      tokens: g('tokens'),
      prompts: g('prompt') + g('command'),
      agentsStarted: g('agent_start'),
      agentsDone: g('agent_done'),
      skills: g('skill'),
      workflows: g('workflow_start'),
      commits: g('commit'),
    },
    hourly: hourSeries(ing.hourly.get('tools'), 48),
    hourlyTokens: hourSeries(ing.hourly.get('tokens'), 48),
    // Input, output and API-equivalent cost of the four periods (server/usage.mjs summary); null without a ledger
    usage: ing.ledger ? ing.ledger.summary() : null,
  };
}

function usageView(u, minDay) {
  if (!u) return null;
  let count = 0;
  for (const [d, n] of u.days) if (d >= minDay) count += n;
  if (!count) return null;
  return { count, lastAt: u.lastAt, projects: [...u.projects], recent: u.recent.slice().reverse() };
}

export function rosterView(ing, catalog) {
  const items = [];
  const seen = new Set();
  const lc = (s) => String(s || '').toLowerCase();
  const minDay = Math.floor(ing.cutoff / 86400000);
  const agentUsage = new Map([...ing.usage.agents].map(([k, v]) => [lc(k), v]));
  const skillUsage = new Map();
  for (const [k, v] of ing.usage.skills) skillUsage.set(lc(k), v);
  for (const [k, v] of ing.usage.commands) if (!skillUsage.has(lc(k))) skillUsage.set(lc(k), v);
  // Skills synced from claude.ai can be invoked with a namespace ("<namespace>:<skill>") in the logs. Such usage
  // with no exact roster match is attached to the claude.ai skill of the same name (no fake plugin item is created).
  const syncedSkills = new Set();
  for (const it of catalog.roster.values()) if (it.kind === 'skill' && it.source === 'claudeai' && !it.plugin) syncedSkills.add(lc(it.name));
  const syncedUsage = new Map();
  for (const [k, v] of skillUsage) {
    const i = k.indexOf(':');
    if (i <= 0 || catalog.roster.has(`skill:${k}`)) continue;
    const bare = k.slice(i + 1);
    if (syncedSkills.has(bare) && !skillUsage.has(bare)) syncedUsage.set(bare, { key: k, u: v });
  }
  for (const it of catalog.roster.values()) {
    const key = `${it.kind}:${lc(it.name)}`;
    seen.add(key);
    let u = it.kind === 'agent' ? agentUsage.get(lc(it.name)) : it.kind === 'skill' ? skillUsage.get(lc(it.name)) : null;
    const synced = it.kind === 'skill' && !u ? syncedUsage.get(lc(it.name)) : null;
    if (synced) {
      u = synced.u;
      seen.add(`skill:${synced.key}`);
    }
    // adoptable: "Add to the library" can take it from its folder on this disk (never the path itself)
    // A likely place is enough to offer it; the action checks the place on disk (catalog.itemOriginLikely)
    const adoptable = !(it.sources || []).includes('library') && (typeof catalog.itemOriginLikely === 'function' ? catalog.itemOriginLikely(it.kind, it.name) : typeof catalog.itemOrigin === 'function' && !!catalog.itemOrigin(it.kind, it.name));
    items.push({ ...it, sources: [...(it.sources || [it.source])], tools: [...(it.tools || [])], installedIn: [...(it.installedIn || [])], id: key, usage: usageView(u, minDay), ...(adoptable ? { adoptable: true } : {}) });
  }
  // Seen in the logs but not in the roster (skills of removed plugins, agents under another name)
  for (const [k, u] of ing.usage.agents) {
    const key = `agent:${lc(k)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = BUILTIN_AGENTS[k] ? 'builtin' : 'other';
    items.push({ id: key, kind: 'agent', name: k, source, sources: [source], tools: [], category: source, description: u.recent.at(-1)?.text ? `Last task: ${u.recent.at(-1).text}` : '', installedIn: [], global: false, usage: usageView(u, minDay) });
  }
  for (const [k, u] of ing.usage.skills) {
    const key = `skill:${lc(k)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const plugin = k.includes(':') ? k.split(':')[0] : null;
    const source = plugin ? 'plugin' : 'other';
    items.push({ id: key, kind: 'skill', name: k, source, sources: [source], tools: [], category: plugin || 'other', description: plugin ? `${plugin} eklentisinin skill'i` : '', installedIn: [], global: false, usage: usageView(u, minDay) });
  }
  return items;
}

// Hub summary: null or { path, projects (registered project count), library (library item count) }
export function hubView(catalog) {
  const h = catalog?.hub;
  return h ? { path: h.path, projects: h.projects, library: h.library } : null;
}

// One row per source adapter: is the tool present, and how many listed projects (whose "via" holds the adapter id)
// and roster skills, agents and plugins (whose "tools" hold it) it contributes
export function toolsView(catalog) {
  const projects = catalog?.allProjects ? catalog.allProjects() : [];
  const roster = catalog?.roster ? [...catalog.roster.values()] : [];
  const active = new Set((catalog?.active || []).map((a) => a.id));
  return (catalog?.adapters || []).map((a) => {
    const count = (kind) => roster.filter((it) => it.kind === kind && (it.tools || []).includes(a.id)).length;
    return {
      id: a.id,
      name: a.name,
      detected: active.has(a.id),
      projects: projects.filter((p) => (p.via || []).includes(a.id)).length,
      skills: count('skill'),
      agents: count('agent'),
      plugins: count('plugin'),
    };
  });
}

export function snapshot(ing, catalog) {
  return {
    bootId: BOOT_ID,
    generatedAt: Date.now(),
    windowDays: WINDOW_DAYS,
    hub: hubView(catalog),
    tools: toolsView(catalog),
    scan: ing.scan,
    kpi: kpiView(ing),
    projects: catalog.allProjects().map((p) => projectView(ing, p, catalog)),
    sessions: [...ing.sessions.values()].filter((s) => s.lastAt || s.live).map((s) => sessionView(ing, s)),
    agents: [...ing.agents.values()].map(agentView),
    workflows: [...ing.workflows.values()].map(workflowView),
    roster: rosterView(ing, catalog),
    events: ing.events.slice(-3000),
    ticks: ing.ticks.slice(-SNAPSHOT_TICKS),
  };
}

// Changes since the last patch
export function takePatch(ing, catalog) {
  const d = ing.dirty;
  const rm = ing.removed;
  const removedCount = rm.sessions.length + rm.agents.length + rm.workflows.length;
  // Usage numbers changed (or the hour turned, which slides the periods): the patch carries them and the cards of
  // the projects whose numbers changed
  const ledger = ing.ledger || null;
  const usageStamp = ledger ? ledger.stamp() : null;
  const usageChanged = !!ledger && usageStamp !== ledger.sentStamp;
  if (usageChanged) for (const pid of ledger.takeTouched()) if (pid) d.projects.add(pid);
  if (!usageChanged && !removedCount && !d.sessions.size && !d.agents.size && !d.workflows.size && !d.projects.size && !ing.pendingEvents.length && !ing.pendingTicks.length) return null;
  if (ledger) ledger.sentStamp = usageStamp;
  for (const id of d.sessions) {
    const s = ing.sessions.get(id);
    if (s?.projectId) d.projects.add(s.projectId);
  }
  for (const id of d.agents) {
    const a = ing.agents.get(id);
    if (a?.projectId) d.projects.add(a.projectId);
  }
  const patch = {
    bootId: BOOT_ID,
    t: Date.now(),
    sessions: [...d.sessions].map((id) => ing.sessions.get(id)).filter((s) => s && (s.lastAt || s.live)).map((s) => sessionView(ing, s)),
    agents: [...d.agents].map((id) => ing.agents.get(id)).filter(Boolean).map(agentView),
    workflows: [...d.workflows].map((id) => ing.workflows.get(id)).filter(Boolean).map(workflowView),
    projects: [...d.projects].map((id) => catalog.getProject(id)).filter(Boolean).map((p) => projectView(ing, p, catalog)),
    events: ing.pendingEvents,
    ticks: ing.pendingTicks,
    removed: removedCount ? { ...rm } : null,
    kpi: kpiView(ing),
  };
  ing.removed = { sessions: [], agents: [], workflows: [] };
  // Agent counts of the main sessions may have changed
  for (const a of patch.agents) {
    if (!d.sessions.has(a.sessionId)) {
      const s = ing.sessions.get(a.sessionId);
      if (s && (s.lastAt || s.live)) {
        patch.sessions.push(sessionView(ing, s));
        d.sessions.add(a.sessionId);
      }
    }
  }
  ing.pendingEvents = [];
  ing.pendingTicks = [];
  for (const k of Object.keys(d)) d[k].clear();
  return patch;
}

export function sessionDetail(ing, id) {
  const s = ing.sessions.get(id);
  if (!s) return null;
  const agents = [...(ing.sessionAgents.get(id) || [])].map((aid) => ing.agents.get(aid)).filter(Boolean).map(agentView);
  const workflows = [...ing.workflows.values()].filter((w) => w.sessionId === id).map(workflowView);
  return { ...sessionView(ing, s), prompts: s.prompts, toolCounts: s.toolCounts, workflowsStarted: s.workflows, agents, workflowRuns: workflows };
}

export function agentDetail(ing, id) {
  const a = ing.agents.get(id);
  if (!a) return null;
  return { ...agentView(a), prompt: a.prompt, toolCounts: a.toolCounts, contextTokens: a.contextTokens, cwd: a.cwd };
}
