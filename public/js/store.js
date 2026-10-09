// @ts-check
// Browser-side data store: loads the snapshot, applies the patches from the server,
// and announces the changes to listeners.

import { attentionRank, groupSessions, sessionState, STATES } from './attention.js';
import { t } from './i18n.js';

// The home folder's fixed name from the server (server/catalog.mjs) in the page's language (a language change reloads
// the page, so it is enough to do this when a project arrives)
const HOME_NAME = 'Home folder';
export function localProject(p) {
  return p && p.name === HOME_NAME ? { ...p, name: t('evHomeFolder') } : p;
}

// A session the app started for a job is named by the job as the person wrote it (server: jobText) when the tool's own
// title carries the raw job id or there is none (seen when using the app, 2026-10-08: "Job J764b…8833 görevi")
const RAW_JOB_ID = /\bJ[0-9a-f]{32}\b/;
export function localSession(x) {
  if (!x || typeof x.jobText !== 'string' || !x.jobText || (x.title && !RAW_JOB_ID.test(x.title))) return x;
  return { ...x, title: x.jobText };
}

const MAX_EVENTS = 5000;
const MAX_TICKS = 12000;

class Store {
  constructor() {
    // The terminal dock's sessions that wait for the person (main.js sets it when the dock is there)
    /** @type {(() => string[]) | null} */
    this.dockAsking = null;
    this.projects = new Map();
    this.sessions = new Map();
    this.agents = new Map();
    this.workflows = new Map();
    this.roster = [];
    this.events = [];
    this.ticks = [];
    this.kpi = null;
    this.scan = null;
    this.windowDays = 14;
    // Hub folder: undefined = server sent no field (older version), null = no hub, else { path, projects, library }
    this.hub = undefined;
    this.tools = []; // the adapters: which AI tools left traces here (docs/tool-view.md)
    this.connected = false;
    // The live stream was there and dropped (review B8): not the moment before the first hello
    this.lost = false;
    this.loaded = false;
    this.listeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, payload) {
    for (const fn of this.listeners) {
      try {
        fn(type, payload);
      } catch (e) {
        console.error(e);
      }
    }
  }

  load(s) {
    this.projects = new Map(s.projects.map((p) => [p.id, localProject(p)]));
    this.sessions = new Map(s.sessions.map((x) => [x.id, localSession(x)]));
    this.agents = new Map(s.agents.map((x) => [x.id, x]));
    this.workflows = new Map(s.workflows.map((x) => [x.id, x]));
    this.roster = s.roster;
    this.events = s.events.slice().sort((a, b) => a.t - b.t);
    this.ticks = s.ticks.slice().sort((a, b) => a[0] - b[0]);
    // Patches that come after the snapshot may carry the same events again: de-duplicate by id/sequence.
    // The bound is computed only from this snapshot: if the server restarts, the sequence numbers start
    // over, and if the old bound were carried over every new event would be taken for a "duplicate" and swallowed.
    this.bootId = s.bootId;
    this.maxEventId = s.events.reduce((m, e) => Math.max(m, e.id || 0), 0);
    this.maxTickSeq = s.ticks.reduce((m, t) => Math.max(m, t[4] || 0), 0);
    this.kpi = s.kpi;
    this.tools = Array.isArray(s.tools) ? s.tools : [];
    this.scan = s.scan;
    this.windowDays = s.windowDays;
    this.hub = s.hub;
    this.loaded = true;
    this.emit('snapshot');
  }

  // Applies the patch; returns only the events and ticks that are really new (the stage plays them)
  applyPatch(p) {
    for (const x of p.sessions) this.sessions.set(x.id, localSession(x));
    for (const x of p.agents) this.agents.set(x.id, x);
    for (const x of p.workflows) this.workflows.set(x.id, x);
    for (const x of p.projects) this.projects.set(x.id, localProject(x));
    if (p.removed) {
      for (const id of p.removed.sessions) this.sessions.delete(id);
      for (const id of p.removed.agents) this.agents.delete(id);
      for (const id of p.removed.workflows) this.workflows.delete(id);
    }
    const events = p.events.filter((e) => e.id > this.maxEventId);
    const ticks = p.ticks.filter((t) => t[4] > this.maxTickSeq);
    if (events.length) {
      // Loops, not spreads: a patch of 100 000 items would overflow the call stack
      for (const e of events) {
        if (e.id > this.maxEventId) this.maxEventId = e.id;
        this.events.push(e);
      }
      this.events.sort((a, b) => a.t - b.t);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    if (ticks.length) {
      for (const t of ticks) if (t[4] > this.maxTickSeq) this.maxTickSeq = t[4];
      const last = this.ticks.length ? this.ticks[this.ticks.length - 1][0] : 0;
      for (const t of ticks) this.ticks.push(t);
      // Replay assumes a sorted array
      if (ticks.some((t) => t[0] < last) || ticks.some((t, i) => i && t[0] < ticks[i - 1][0])) this.ticks.sort((a, b) => a[0] - b[0]);
      if (this.ticks.length > MAX_TICKS) this.ticks.splice(0, this.ticks.length - MAX_TICKS);
    }
    if (p.kpi) this.kpi = p.kpi;
    this.emit('patch', p);
    return { events, ticks };
  }

  setRoster(r) {
    this.roster = r.roster;
    if (Object.prototype.hasOwnProperty.call(r, 'hub')) this.hub = r.hub;
    if (Array.isArray(r.tools)) this.tools = r.tools;
    for (const x of r.projects) this.projects.set(x.id, localProject(x));
    this.emit('roster');
  }

  setStatus(connected) {
    this.connected = connected;
    this.emit('status');
  }

  setScan(scan) {
    this.scan = scan;
    this.emit('scan');
  }

  project(id) {
    return this.projects.get(id);
  }

  // Projects: the ones waiting for the person first, then working, open and quiet, closed (attention.js); then by
  // the latest activity
  sortedProjects(now = Date.now()) {
    const byProject = groupSessions(this.sessions.values());
    const rank = new Map([...this.projects.values()].map((p) => [p.id, attentionRank(p, byProject, now)]));
    return [...this.projects.values()].sort((a, b) => rank.get(b.id) - rank.get(a.id) || b.lastActivity - a.lastActivity || a.name.localeCompare(b.name, 'tr'));
  }

  // Open sessions: waiting for the person first, then working, then left open; the latest first within a state
  liveSessions(now = Date.now()) {
    const order = (s) => STATES.indexOf(sessionState(s, now));
    return [...this.sessions.values()].filter((s) => s.live).sort((a, b) => order(a) - order(b) || b.lastAt - a.lastAt);
  }

  sessionLabel(s) {
    if (!s) return '';
    return s.title || s.lastPrompt || s.firstPrompt || (s.live?.name ? s.live.name : t('storeNewSession'));
  }

  agentsOfProject(id) {
    return [...this.agents.values()].filter((a) => a.projectId === id);
  }
}

export const store = new Store();
