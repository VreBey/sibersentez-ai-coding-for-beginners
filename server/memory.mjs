// @ts-check
// Project memory: every project folder a source adapter has shown is remembered, so a project stays listed after
// a tool deletes its logs (Claude Code removes sessions after 30 days by default). With a hub the memory lives in
// <hub>/registry/discovered.json (the user's registry/projects.json is never touched); without a hub it lives in
// memory only. Folders that no longer exist stay in the memory and are shown as missing; nothing is deleted
// automatically.
//
// File: {"version":1,"projects":[{"path","firstSeenAt","lastSeenAt","via":["claude-code",...],"idea"?}]} (ISO times).
// Writes are atomic (temporary file + rename) and debounced; a newer lastSeenAt alone is only written when it moved
// by more than an hour. A broken file is kept aside as discovered.json.broken and the memory is rebuilt.
// Each folder keeps its best spelling: a folder first reported lower-cased (Gemini CLI stores paths that way) takes
// the on-disk spelling when a later report gives exactly that (contract §3).
//
// New project (docs/start-flow.md, step 2): a folder the user picked in the desktop app is remembered with via
// "sibersentez", and any remembered folder can keep the user's idea for the project ("idea", at most IDEA_MAX characters,
// cleaned like the fit's idea: server/fit.mjs normalizeIdea). Only the desktop shell asks for these writes, over the
// server process's own message channel (createProjectChannel below; server/index.mjs listens), never over HTTP. The
// idea is never logged.
import fs from 'node:fs';
import path from 'node:path';
import { normPath } from './util.mjs';
import { folderSpelling, isLowerCased, localExists } from './fsutil.mjs';
import { normalizeIdea, IDEA_MAX } from './fit.mjs';
import { writeFileAtomic } from './atomic.mjs';

const MEMORY_VERSION = 1;
const HOUR = 3600000;
// The tool id of a folder the user added in SiberSentez itself
export const SIBERSENTEZ_VIA = 'sibersentez';
// The longest idea text a request may carry (the shell's IDEA_TEXT_MAX); normalizeIdea keeps at most IDEA_MAX
export const IDEA_TEXT_MAX = IDEA_MAX * 4;
export { IDEA_MAX };

const toMs = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : 0;
};
const iso = (t) => (t ? new Date(t).toISOString() : null);

function memoryFile(hubDir) {
  return hubDir ? path.join(hubDir, 'registry', 'discovered.json') : null;
}

export class ProjectMemory {
  // hubDir null: memory only. debounceMs 0: every change is written at once (tests).
  constructor({ hubDir = null, debounceMs = 2000, now = Date.now, log = (line) => console.warn(line) } = {}) {
    this.file = memoryFile(hubDir);
    this.debounceMs = debounceMs;
    this.now = now;
    this.log = log;
    this.entries = new Map(); // normPath -> { path, firstSeenAt, lastSeenAt, savedLastSeenAt, via: Set }
    this.dirty = false;
    this.timer = null;
    this.saves = 0;
    this.lastFirstSeenAt = 0; // the firstSeenAt of the last folder recorded in this process (record)
    this.load();
  }

  load() {
    if (!this.file) return;
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e?.code !== 'ENOENT') this.log(`project memory unreadable (${e?.code || 'error'}); starting empty`);
      return;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) {
      this.log('project memory is broken; kept aside as discovered.json.broken and rebuilt');
      try {
        fs.renameSync(this.file, this.file + '.broken');
      } catch {
        /* rebuilt anyway */
      }
      this.dirty = true;
      return;
    }
    for (const e of data.projects) {
      if (!e || typeof e.path !== 'string' || !e.path.trim()) continue;
      const n = normPath(e.path);
      if (!n || this.entries.has(n)) continue;
      const lastSeenAt = toMs(e.lastSeenAt);
      this.entries.set(n, {
        path: e.path,
        firstSeenAt: toMs(e.firstSeenAt) || lastSeenAt,
        lastSeenAt,
        savedLastSeenAt: lastSeenAt,
        // 'the old product name' (renamed 2026-09-30) reads as the new one
        via: new Set(Array.isArray(e.via) ? e.via.filter((v) => typeof v === 'string' && v).map((v) => (v === 'orkestra' ? SIBERSENTEZ_VIA : v)) : []),
        // A hand-edited file is cleaned the same way as a request
        idea: normalizeIdea(e.idea),
      });
    }
  }

  // The memory entry of a folder (any spelling), or null
  entry(folder) {
    const n = normPath(folder);
    return n ? this.entries.get(n) || null : null;
  }

  // Keep the user's idea for a remembered folder (docs/start-flow.md). text is cleaned (normalizeIdea: controls and
  // invisible marks out, spaces collapsed, at most IDEA_MAX characters); '' removes it. A folder the memory does not
  // hold is refused: an idea never creates an entry. Written at once (the user is waiting for it).
  // Returns { ok: true, idea, changed, saved } or { ok: false, reason: 'invalid' | 'not-in-memory' }; saved is false
  // when the file could not be written (the idea is kept in memory and written with the next change) or there is no hub.
  setIdea(folder, text) {
    if (typeof text !== 'string' || text.length > IDEA_TEXT_MAX) return { ok: false, reason: 'invalid' };
    const e = this.entry(folder);
    if (!e) return { ok: false, reason: 'not-in-memory' };
    const idea = normalizeIdea(text);
    if (e.idea === idea) return { ok: true, idea, changed: false, saved: !!this.file && !this.dirty };
    e.idea = idea;
    this.dirty = true;
    const saved = this.flush();
    if (!saved) this.touch(); // retried with the debounce
    return { ok: true, idea, changed: true, saved };
  }

  // Remember a project folder seen by an adapter (via = adapter id)
  /** @param {string} folder @param {{ via?: string, lastSeenAt?: number }} [options] */
  record(folder, { via, lastSeenAt = 0 } = {}) {
    const n = normPath(folder);
    if (!n) return;
    const seenAt = toMs(lastSeenAt);
    let e = this.entries.get(n);
    let changed = false;
    if (!e) {
      // Every new folder is seen first at its own millisecond (one pass records many): the catalog gives the plain id
      // of two folders that differ only in case (Linux) to the one seen first, and this keeps that order the order
      // they were recorded in (review 2026-10 F01)
      const now = Math.max(this.now(), this.lastFirstSeenAt + 1);
      this.lastFirstSeenAt = now;
      e = { path: folder, firstSeenAt: now, lastSeenAt: seenAt || now, savedLastSeenAt: 0, via: new Set(), idea: '' };
      this.entries.set(n, e);
      changed = true;
    } else if (folder !== e.path && this.betterSpelling(e, folder)) {
      e.path = folder;
      changed = true;
    }
    if (via && !e.via.has(via)) {
      e.via.add(via);
      changed = true;
    }
    if (seenAt > e.lastSeenAt) {
      e.lastSeenAt = seenAt;
      if (seenAt - e.savedLastSeenAt > HOUR) changed = true;
    }
    if (changed) this.touch();
  }

  // Is `folder` (the same path as the entry, spelled differently) a better spelling: exactly the on-disk spelling. A
  // lower-cased spelling never is. A spelling found not better is not checked again while the process runs (the
  // same tool reports the same spelling every pass).
  betterSpelling(e, folder) {
    if (isLowerCased(folder) || e.notBetter?.has(folder)) return false;
    if (folderSpelling(folder) === folder) return true;
    (e.notBetter ||= new Set()).add(folder);
    return false;
  }

  // [{ path, firstSeenAt, lastSeenAt, via, exists, idea }]; a UNC path is never checked (exists false); idea '' = none
  list() {
    return [...this.entries.values()].map((e) => ({ path: e.path, firstSeenAt: e.firstSeenAt, lastSeenAt: e.lastSeenAt, via: [...e.via], exists: localExists(e.path), idea: e.idea || '' }));
  }

  get size() {
    return this.entries.size;
  }

  toJSON() {
    const projects = [...this.entries.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((e) => ({ path: e.path, firstSeenAt: iso(e.firstSeenAt), lastSeenAt: iso(e.lastSeenAt), via: [...e.via].sort(), ...(e.idea ? { idea: e.idea } : {}) }));
    return { version: MEMORY_VERSION, projects };
  }

  touch() {
    this.dirty = true;
    if (!this.file) return;
    if (this.debounceMs <= 0) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  // Write now if there is anything to write. Atomic: a temporary file next to the target, then a rename.
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.file || !this.dirty) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(this.toJSON(), null, 2) + '\n');
    } catch (e) {
      this.log(`project memory could not be written (${e?.code || 'error'}); will retry`);
      return false;
    }
    for (const e of this.entries.values()) e.savedLastSeenAt = e.lastSeenAt;
    this.dirty = false;
    this.saves++;
    return true;
  }
}

// The desktop shell's requests to this server (docs/start-flow.md, step 2), as they arrive over the server process's
// own message channel (server/index.mjs: process.parentPort under Electron's utilityProcess, the ipc channel of a
// forked process in development). Nothing else can send on that channel; a request is still checked in full.
//   { sibersentez: 'shell-call', id, type: 'project-add', path, fresh? }         catalog.addProjectFolder(path) (fresh:
//                                                                                a folder just made, never inside a project)
//   { sibersentez: 'shell-call', id, type: 'project-idea', projectId, idea }     catalog.setProjectIdea(projectId, idea)
//   { sibersentez: 'shell-call', id, type: 'terminal-target', launchId | setup | projectId | sessionId }   actions.terminalTarget
//   { sibersentez: 'shell-call', id, type: 'terminal-state', sessions, ended }   actions.terminalState (what runs in the
//                                                                                embedded terminals, after every change)
// handle(msg) returns the reply { sibersentez: 'shell-reply', id, ok, reason, projectId?, existed?, saved? }, or null for a
// message that is not a request (it gets no answer). onChange(type, projectId) runs after a change (see
// shellChangeHandler for what the server does then). The reply never carries a path or the idea.
/** @param {{ catalog?: any, appDir?: string | null, onChange?: (type: string, projectId: string) => void, reloadActions?: any, terminalTarget?: any, terminalState?: any }} [options] */
export function createProjectChannel({ catalog, appDir = null, onChange = () => {}, reloadActions = null, terminalTarget = null, terminalState = null } = {}) {
  const changed = (type, projectId) => {
    try {
      onChange(type, projectId);
    } catch {
      // the change is made; the next catalog reload (at most a minute) shows it
    }
  };
  function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.sibersentez !== 'shell-call' || !Number.isInteger(msg.id) || msg.id < 1) return null;
    const reply = (r) => {
      const out = { sibersentez: 'shell-reply', id: msg.id, ok: r?.ok === true, reason: typeof r?.reason === 'string' ? r.reason : r?.ok === true ? 'saved' : 'error' };
      if (typeof r?.projectId === 'string') out.projectId = r.projectId;
      if (typeof r?.existed === 'boolean') out.existed = r.existed;
      if (typeof r?.saved === 'boolean') out.saved = r.saved;
      if (typeof r?.mode === 'string') out.mode = r.mode;
      // terminal-target: where the embedded terminal opens (to the shell only; the shell never passes it to the page)
      if (typeof r?.dir === 'string') out.dir = r.dir;
      if (typeof r?.title === 'string') out.title = r.title;
      if (r?.program && typeof r.program.file === 'string' && Array.isArray(r.program.args)) out.program = { file: r.program.file, args: r.program.args.map(String) };
      // The tool and the app job of a start-ai in the dock: the shell keeps them with the terminal (lifecycle)
      if (typeof r?.tool === 'string') out.tool = r.tool;
      if (typeof r?.jobId === 'string') out.jobId = r.jobId;
      return out;
    };
    try {
      if (msg.type === 'project-add') {
        const r = catalog.addProjectFolder(msg.path, { appDir, fresh: msg.fresh === true });
        if (r.ok) changed('project-add', r.projectId);
        return reply(r);
      }
      if (msg.type === 'project-idea') {
        const r = catalog.setProjectIdea(msg.projectId, msg.idea);
        if (r.ok && r.changed) changed('project-idea', r.projectId);
        return reply(r);
      }
      // actions-reload: the shell saved a new actions mode; the server reads it again from its own sources (the message
      // carries no mode, so this channel can never pick one) and answers with the mode it now runs in
      if (msg.type === 'actions-reload' && reloadActions) return reply(reloadActions());
      if (msg.type === 'terminal-target' && terminalTarget) {
        // The setup terminal's { setup } is passed on as it came (terminalTarget checks it is exactly true)
        const req = msg.launchId !== undefined ? { launchId: msg.launchId } : msg.setup !== undefined ? { setup: msg.setup } : { projectId: msg.projectId, sessionId: msg.sessionId };
        return reply(terminalTarget(req));
      }
      // terminal-state: what runs in the embedded terminals and the one that just ended (the shell sends it after every
      // change and to a new server process); the server checks every field (actions.terminalState)
      if (msg.type === 'terminal-state' && terminalState) return reply(terminalState({ sessions: msg.sessions, ended: msg.ended }));
      return reply({ ok: false, reason: 'unknown-request' });
    } catch {
      return reply({ ok: false, reason: 'error' });
    }
  }
  return { handle };
}

// What the server does after a shell request changed something (server/index.mjs builds its onChange with this):
//   project-add   a new project: every cached fit is dropped (the project list is part of what a fit depends on) and
//                 the catalog is reloaded, so the page gets the new project list.
//   project-idea  one project's idea: catalog.setProjectIdea has already put it on the project, so there is no catalog
//                 reload; only that project's cached fits are dropped (a fit asked for without ?idea, the card's badge
//                 and skills-apply without keys, uses the saved idea: server/fit.mjs) and the project is marked for the
//                 next patch, which carries its new idea to the page.
// reload(), invalidateFit(projectId?) (none: every project), markProject(projectId).
export function shellChangeHandler({ reload, invalidateFit, markProject }) {
  return (type, projectId) => {
    if (type === 'project-idea' && typeof projectId === 'string' && projectId) {
      invalidateFit(projectId);
      markProject(projectId);
      return;
    }
    invalidateFit();
    reload();
  };
}
