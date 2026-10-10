// @ts-check
// Project registry and roster (skills, agents, plugins) catalog (contract §4, §9).
// The catalog knows no AI tool: source adapters (adapters/index.mjs) report the projects a tool has been used in
// and the items it provides. Every project folder an adapter reports is remembered by the project memory
// (memory.mjs), so it stays listed after the tool deletes its logs.
// Projects: the hub registry, remembered project folders and folders of live sessions (ingest). No hub project.
// A folder the user adds in the desktop app ("New project", docs/start-flow.md) is remembered like the others, with
// via "sibersentez"; a project whose remembered folder holds the user's idea carries it as `idea`.
// Roster sources: library (hub library catalog), kit (the SiberSentez kit shipped with the app, server/kit.mjs) plus
// what the adapters report: personal, claudeai, project, plugin, builtin. Every roster item lists the adapters that
// reported it in `tools` (adapter order).
// The hub may be null: registry and library are then empty and discovery still works.
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { HUB_DIR, CLAUDE_DIR, HOME_DIR, KIT_DIR } from './config.mjs';
import { readRegistry, normalizeRegistry } from './hub.mjs';
import { libraryItems, hasStreamColon, isDriveRoot, realPath, within, checkSource } from './library.mjs';
import { isBroadFolder } from './install.mjs';
import { readKit, kitCounts, KIT_SOURCE } from './kit.mjs';
import { readSources, originOf } from './github.mjs';
import { normPath, slugify, readFrontmatter, truncate, PROJECT_ID_RE } from './util.mjs';
import { DirLister, exists, isLocalPath, isLowerCased, localExists, toolsOnly } from './fsutil.mjs';
import { readPlan } from './plan.mjs';
import { ADAPTERS } from './adapters/index.mjs';
import { ProjectMemory, SIBERSENTEZ_VIA } from './memory.mjs';
import { readRelinks, readJoins } from './relinks.mjs';
import { PLATFORM, PROGRAM_HOME_FOLDERS, configRoot, normalizeDir, isSystemFolder, tempFolders, programDataFolders } from './platform.mjs';

export { BUILTIN_AGENTS, readHeadCwd, resolveSlug } from './adapters/claude-code.mjs';

const DESC_MAX = 400;
// The stepped rescan gives the loop back inside one tool's read once this much time went by (a frame or so)
export const STEP_MS = 16;
const ID_TAIL = 48;
// Claude Code scratchpad and task folders are never projects of their own
const SCRATCH_MARKER = '/appdata/local/temp/claude/';
// A path key (normPath) inside a Claude Code scratchpad: the marker in any letter case, since a key keeps its case on
// Linux (review 2026-10 F01) and a Windows home is seen from WSL as /mnt/c/Users/<name>/AppData/...
const isScratch = (n) => String(n).toLowerCase().includes(SCRATCH_MARKER);

// The same name can live in several places: an item's primary `source` is the widest place where it is active.
// Personal applies in every project; a library item installed into a project stays a library item (the client
// derives installable categories from it), and so does a kit item. Every place is listed in `sources`, in this order.
export const SOURCE_ORDER = Object.freeze(['personal', 'claudeai', 'library', 'kit', 'plugin', 'project', 'builtin']);
const rank = (s) => {
  const i = SOURCE_ORDER.indexOf(s);
  return i === -1 ? SOURCE_ORDER.length : i;
};

const PROJECT_NOTE = 'Not in the registry; found in AI tool records.';
// An unregistered project the user added in the desktop app ("New project")
const ADDED_NOTE = 'Added in SiberSentez as a new project.';
// A project id as a request names it (the same rule as server/actions.mjs)

// New project (docs/start-flow.md, step 2): system and synced folders a folder the user picks may never be, named by
// environment variables (any letter case; the same list as the desktop shell's checkProjectFolder, reason 'broad'):
// the Windows folder, the program folders and ProgramData, each with everything below it (programs, their data and the
// system, never a project), and each OneDrive root itself (a project folder inside OneDrive is fine).
export const SYSTEM_TREE_VARS = Object.freeze(['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']);
export const ONEDRIVE_ROOT_VARS = Object.freeze(['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']);

// Folder levels searched upward for the skills or agents folder of a nested item (agents/sub/deep/x.md)
const PERSONAL_DIR_UP = 3;

// The personal folder an item was found in, for the roster's folder filter: its skills or agents folder, relative to
// the home folder ("~/.claude/skills", "~/.agents/skills", "~/.claude/agents" for a nested agent). The user name and
// drive are never part of it; a folder outside the home folder (CODEX_HOME elsewhere) keeps only its last two parts
// ("…/codex-home/skills"). file: the item's SKILL.md or agent file. null when there is no path.
export function personalDir(file, kind, homeDir) {
  if (typeof file !== 'string' || !file || typeof homeDir !== 'string' || !homeDir) return null;
  // A skill is the folder holding SKILL.md: its parent is the skills folder. An agent is a file (or a folder holding
  // agent.md): its folder, or the nearest agents folder above a nested one.
  let dir = path.dirname(path.resolve(file));
  if (kind === 'skill') dir = path.dirname(dir);
  const want = kind === 'skill' ? 'skills' : 'agents';
  let probe = dir;
  for (let i = 0; i <= PERSONAL_DIR_UP; i++) {
    if (path.basename(probe).toLowerCase() === want) {
      dir = probe;
      break;
    }
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const rel = path.relative(path.resolve(homeDir), dir);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${rel.split(/[\\/]+/).join('/')}`;
  return `…/${[path.basename(path.dirname(dir)), path.basename(dir)].filter(Boolean).join('/')}`;
}

export class Catalog {
  // Options exist for tests; by default they come from settings (config.mjs). hubDir may be null.
  // projectsDir defaults to <claudeDir>/projects (Claude Code's session logs, one folder per working directory).
  // adapters: source adapters (default: all). memory: project memory (default: in <hub>/registry, or memory only).
  // env: the environment the adapters read (CODEX_HOME, COPILOT_HOME, APPDATA, ...); tests pass a fake one.
  /** @param {{ hubDir?: string | null, claudeDir?: string, homeDir?: string, projectsDir?: string, adapters?: readonly any[], memory?: any, env?: Record<string, string | undefined> }} [options] */
  constructor({ hubDir = HUB_DIR, claudeDir = CLAUDE_DIR, homeDir = HOME_DIR, projectsDir, adapters = ADAPTERS, memory, env = process.env } = {}) {
    this.hubDir = hubDir || null;
    // The SiberSentez kit folder (server/kit.mjs, roster source 'kit'): the settings' KIT_DIR for a catalog that reads
    // the process environment (the app); a catalog given an environment of its own (tests) has none, so its roster
    // stays the one its fake world describes (a test sets kitDir itself before load()).
    this.kitDir = env === process.env ? KIT_DIR : null;
    this.kit = null; // { version, skill, agent, total } after a roster pass, or null without a kit
    this.claudeDir = claudeDir;
    this.homeDir = homeDir;
    this.projectsDir = projectsDir || path.join(claudeDir, 'projects');
    this.env = env && typeof env === 'object' ? env : {};
    // Where desktop programs keep their settings (VS Code-style editors keep their workspaces there; platform.mjs)
    this.appDataDir = configRoot(this.env, homeDir);
    this.adapters = adapters;
    this.toolRank = new Map(adapters.map((a, i) => [a.id, i])); // roster "tools" and project "via" follow this order
    this.memory = memory || new ProjectMemory({ hubDir: this.hubDir });
    this.adapterCache = new Map(); // adapter id -> private cache Map
    this.active = []; // adapters whose tool is present (detect)
    this.projects = []; // registered projects
    this.adhoc = new Map(); // normPath -> project found in logs or in the project memory
    // Moved projects linked to their new folder (relinks.mjs): the links, the ones applied (the project was there),
    // normPath(new folder) -> the kept project, and the joins of undone links (their hours stay with the kept project)
    this.links = [];
    this.appliedLinks = [];
    this.linkedPaths = new Map();
    this.joins = [];
    this.resolveCache = new Map();
    this.roster = new Map(); // key -> roster item
    this.itemFiles = new Map(); // kind:name -> [{ source, file }] (buildRoster; server only)
    this.hub = null; // { path, projects, library } or null
    this.version = 0;
    this.fmCache = new Map(); // file -> { mtimeMs, size, meta: { <kind>: value }, gen } (see fileMeta)
    this.fmGen = 0;
    this.lister = null; // folder lister of the running pass (see load)
    this.discovered = new Map(); // normPath(folder) -> { path, projectId, lastSeenAt, via, exists }
    this.adapterErrors = new Set();
  }

  // Context handed to an adapter (see adapters/index.mjs). ls is the folder lister of the running pass (absent
  // outside a pass).
  adapterCtx(adapter) {
    let cache = this.adapterCache.get(adapter.id);
    if (!cache) this.adapterCache.set(adapter.id, (cache = new Map()));
    return {
      homeDir: this.homeDir,
      claudeDir: this.claudeDir,
      projectsDir: this.projectsDir,
      env: this.env,
      appDataDir: this.appDataDir,
      cache,
      ls: this.lister || undefined,
      frontmatter: (f) => this.frontmatter(f),
      fileMeta: (f, kind, read) => this.fileMeta(f, kind, read),
    };
  }

  // Adapter ids in adapter order (unknown ids last, in their given order)
  sortTools(ids) {
    const r = (id) => (this.toolRank.has(id) ? this.toolRank.get(id) : this.toolRank.size);
    return [...ids].sort((a, b) => r(a) - r(b));
  }

  // Calls an adapter method; a throwing adapter is logged once and skipped, the others keep working
  callAdapter(adapter, method, ...args) {
    if (typeof adapter[method] !== 'function') return method === 'detect' ? false : [];
    try {
      return adapter[method](...args, this.adapterCtx(adapter)) ?? (method === 'detect' ? false : []);
    } catch (e) {
      const key = `${adapter.id}.${method}`;
      if (!this.adapterErrors.has(key)) {
        this.adapterErrors.add(key);
        console.error(`adapter ${key} failed: ${e?.message}`);
      }
      return method === 'detect' ? false : [];
    }
  }

  // A tool's global items in parts (adapters/index.mjs globalItemSteps), or in one part (findGlobalItems). A part
  // that throws ends that tool's read, logged once like callAdapter; the parts before it stay.
  *globalItemParts(adapter) {
    if (typeof adapter.globalItemSteps !== 'function') {
      const all = this.callAdapter(adapter, 'findGlobalItems');
      if (Array.isArray(all)) yield all;
      return;
    }
    try {
      for (const part of adapter.globalItemSteps(this.adapterCtx(adapter))) if (Array.isArray(part)) yield part;
    } catch (e) {
      const key = `${adapter.id}.globalItemSteps`;
      if (!this.adapterErrors.has(key)) {
        this.adapterErrors.add(key);
        console.error(`adapter ${key} failed: ${e?.message}`);
      }
    }
  }

  // Can this folder be remembered as a project: a local drive-letter path (a UNC path is never checked: that can
  // block on an offline share or wake a WSL distribution), it exists, it is not a Claude scratchpad and not a broad
  // folder (home, Desktop, Documents, Downloads, a drive root, C:\Windows\System32). This is the filter every
  // adapter's project folders go through.
  isProjectFolder(folder) {
    if (!isLocalPath(folder)) return false;
    const n = normPath(folder);
    if (!n || isScratch(n)) return false;
    if (this.isBroad(n) || /windows\/system32$/i.test(n)) return false;
    return exists(folder);
  }

  // Project discovery, independent of any log window: every active adapter reports the folders its tool has been
  // used in; they are remembered, and every remembered folder becomes a project (a registered match or an
  // unregistered one). A remembered folder that no longer exists is listed as missing, never dropped.
  discoverProjects() {
    const hints = new Map();
    // When each tool last left a trace in each folder (this pass only): the building shows another tool at work
    // (docs/hq.md, "Other tools"). Times only, from the adapters' file times; nothing of a session is read.
    const seenBy = new Map(); // normPath(folder) -> { [adapter id]: ms }
    for (const adapter of this.active) {
      for (const f of this.callAdapter(adapter, 'findProjects')) {
        if (!f || typeof f.path !== 'string' || !this.isProjectFolder(f.path)) continue;
        this.memory.record(f.path, { via: adapter.id, lastSeenAt: f.lastSeenAt });
        if (f.hint) hints.set(normPath(f.path), f.hint);
        const t = Number(f.lastSeenAt) || 0;
        if (t > 0) {
          const k = normPath(f.path);
          const row = seenBy.get(k) || {};
          if (t > (row[adapter.id] || 0)) row[adapter.id] = t;
          seenBy.set(k, row);
        }
      }
    }
    if (this.memory.dirty) this.memory.touch(); // retries a failed write on the next pass
    const found = new Map();
    // The user's idea of a project (docs/start-flow.md): from the memory entry of the project's own folder, else from
    // the first remembered folder of that project that has one
    const ideas = new Map(); // project id -> { idea, own }
    for (const m of this.memory.list()) {
      const n = normPath(m.path);
      if (!n || !isLocalPath(m.path) || isScratch(n) || this.isBroad(n) || isSystemFolder(n)) continue;
      const pid = this.resolve(m.path, hints.get(n));
      const p = pid ? this.getProject(pid) : null;
      if (!p) continue;
      if (m.idea) {
        const own = normPath(p.path) === n;
        const prev = ideas.get(pid);
        if (!prev || (own && !prev.own)) ideas.set(pid, { idea: m.idea, own });
      }
      // The memory learned the real spelling of a folder first seen lower-cased (Gemini CLI): the project takes it
      if (p.kind === 'adhoc' && p.path !== m.path && normPath(p.path) === n && isLowerCased(p.path) && !isLowerCased(m.path)) {
        p.path = m.path;
        p.name = path.basename(m.path) || m.path;
        p._paths = [m.path];
      }
      if (m.lastSeenAt > (p.lastSeenAt || 0)) p.lastSeenAt = m.lastSeenAt;
      p.via = this.sortTools(new Set([...(p.via || []), ...m.via]));
      for (const [tool, t] of Object.entries(seenBy.get(n) || {})) {
        if (!p.toolSeen) p.toolSeen = {};
        if (t > (p.toolSeen[tool] || 0)) p.toolSeen[tool] = t;
      }
      if (p.kind === 'adhoc' && p.description === PROJECT_NOTE && m.via.includes(SIBERSENTEZ_VIA) && normPath(p.path) === n) p.description = ADDED_NOTE;
      found.set(n, { path: m.path, projectId: pid, lastSeenAt: m.lastSeenAt, via: m.via, exists: m.exists });
    }
    this.discovered = found;
    for (const p of this.allProjects()) {
      const x = ideas.get(p.id);
      if (x) p.idea = x.idea;
      else delete p.idea;
    }
  }

  // ---- New project (docs/start-flow.md, step 2) ----
  // The desktop shell asks for these over the server process's message channel (memory.mjs createProjectChannel); no
  // HTTP route reaches them. They write only the program's own project memory, never the user's registry.

  // The listed project a folder already belongs to (registered, or found in the tool records or the memory), without
  // making one: the same matching as resolve()
  knownProjectFor(folder) {
    const n = normPath(folder);
    if (!n) return null;
    let best = null;
    let len = 0;
    for (const p of this.projects) {
      for (const pp of p._norm) {
        if ((n === pp || n.startsWith(pp + '/')) && pp.length > len) {
          best = p;
          len = pp.length;
        }
      }
    }
    let linked = false;
    for (const [ln, p] of this.linkedPaths) {
      if ((n === ln || n.startsWith(ln + '/')) && ln.length > len) {
        best = p;
        len = ln.length;
        linked = true;
      }
    }
    if (linked) return this.longerAdhoc(n, len) || best;
    if (best) return best;
    for (const [pn, p] of this.adhoc) {
      if (p.tmpOnly || !p.path) continue;
      if ((pn === n || (!this.isBroad(pn) && n.startsWith(pn + '/'))) && pn.length > len) {
        best = p;
        len = pn.length;
      }
    }
    return best;
  }

  // The system and synced folders of this catalog's environment (SYSTEM_TREE_VARS, ONEDRIVE_ROOT_VARS), in normPath
  // form, each also in its real form: { trees: [...], roots: [...] }. A value that is not an absolute drive path is
  // ignored. Read once.
  systemFolders() {
    if (!this.sysFolders) {
      const keys = Object.keys(this.env);
      const read = (name) => {
        const k = keys.find((x) => x.toLowerCase() === name.toLowerCase());
        const v = k ? this.env[k] : null;
        if (typeof v !== 'string' || !/^[a-zA-Z]:[\\/]/.test(v.trim())) return [];
        const dir = v.trim();
        return [...new Set([dir, realPath(dir)].filter(Boolean).map(normPath))].filter((n) => n && !/^[a-z]:$/i.test(n));
      };
      this.sysFolders = { trees: SYSTEM_TREE_VARS.flatMap(read), roots: ONEDRIVE_ROOT_VARS.flatMap(read) };
    }
    return this.sysFolders;
  }

  // n (normPath form) is a system folder or below one, or a OneDrive root itself
  isSystemFolder(n) {
    if (!n) return false;
    const { trees, roots } = this.systemFolders();
    return trees.some((t) => n === t || n.startsWith(t + '/')) || roots.includes(n);
  }

  // Can a folder the user picked be a project. The same rules every adapter's folders go through (isProjectFolder:
  // local drive path, not a scratchpad, not broad: home, Desktop, Documents, Downloads, the temp folder, AppData, a drive
  // root, System32), checked on the real path too (install.mjs isBroadFolder), plus: not a system or synced folder (the
  // Windows folder, the program folders, ProgramData and below them, a OneDrive root: isSystemFolder, reason 'broad'),
  // not a link itself, not the hub, inside it or holding it, not the personal Claude folder or inside it, not
  // overlapping the program folder (appDir).
  // Returns { ok: true, path } or { ok: false, reason: 'invalid' | 'network' | 'not-local' | 'drive-root' | 'home' |
  // 'broad' | 'missing' | 'link' | 'hub' | 'personal' | 'program' }.
  checkNewProjectFolder(folder, { appDir = null } = {}) {
    const fail = (reason) => ({ ok: false, reason });
    if (typeof folder !== 'string' || !folder || folder.length > 1024) return fail('invalid');
    if (/^[\\/]{2}/.test(folder)) return fail('network');
    if (!isLocalPath(folder)) return fail('not-local');
    if (hasStreamColon(folder) || /[<>"|?*\u0000-\u001f\u007f-\u009f]/.test(folder)) return fail('invalid');
    const dir = normalizeDir(folder);
    const home = normPath(this.homeDir);
    const why = (p) => {
      const n = normPath(p);
      if (isDriveRoot(p) || /^[a-z]:$/i.test(n)) return 'drive-root';
      if (home && (n === home || home.startsWith(n + '/'))) return 'home';
      if (isScratch(n) || this.isBroad(n) || /windows\/system32$/i.test(n) || isBroadFolder(p, this.homeDir) || this.isSystemFolder(n)) return 'broad';
      // The hub, a folder inside it, or a folder that holds it (as a project it would take the hub in)
      if (this.hubDir && (within(p, this.hubDir) || within(this.hubDir, p))) return 'hub';
      if (this.claudeDir && within(p, this.claudeDir)) return 'personal';
      if (appDir && (within(p, appDir) || within(appDir, p))) return 'program';
      return null;
    };
    const first = why(dir);
    if (first) return fail(first);
    let st = null;
    try {
      st = fs.lstatSync(dir);
    } catch {
      return fail('missing');
    }
    if (st.isSymbolicLink()) return fail('link');
    if (!st.isDirectory()) return fail('missing');
    const real = realPath(dir);
    if (!real) return fail('missing');
    if (/^[\\/]{2}/.test(real)) return fail('network');
    if (!isLocalPath(real)) return fail('not-local');
    const second = why(real);
    if (second) return fail(second);
    // The rules' own folders in their real form (the hub or the personal folder behind a junction)
    const realHub = this.hubDir ? realPath(this.hubDir) : null;
    const realClaude = this.claudeDir ? realPath(this.claudeDir) : null;
    const realApp = appDir ? realPath(appDir) : null;
    if (realHub && (within(real, realHub) || within(realHub, real))) return fail('hub');
    if (realClaude && within(real, realClaude)) return fail('personal');
    if (realApp && (within(real, realApp) || within(realApp, real))) return fail('program');
    return { ok: true, path: dir };
  }

  // A folder the user picked in the desktop app becomes a project: checked (checkNewProjectFolder), remembered with via
  // "sibersentez" and written at once, then listed. A folder that already belongs to a listed project (registered, found
  // by a tool, or remembered) opens that project instead (existed: true). A folder that holds listed projects is
  // refused ('holds-projects'): as a project of its own it would take their folders over (a subfolder belongs to the
  // project above it). The user's registry is never written. fresh (a folder the shell has just made for a new project,
  // review U05): a folder that belongs to a listed project is refused ('inside-project') before anything is remembered.
  // Returns { ok: true, projectId, existed, saved, reason: 'added' | 'existing' } or { ok: false, reason }.
  addProjectFolder(folder, { appDir = null, fresh = false } = {}) {
    const check = this.checkNewProjectFolder(folder, { appDir });
    if (!check.ok) return check;
    const dir = check.path;
    const known = this.knownProjectFor(dir);
    const n = normPath(dir);
    // A fresh folder that is a listed project's own folder (made again after it was deleted) is that project, new on
    // disk: it opens as added
    const own = !!known && (normPath(known.path) === n || (known._norm || []).includes(n));
    if (fresh && known && !own) return { ok: false, reason: 'inside-project' };
    const existed = !!known && !(fresh && own);
    if (!known && this.allProjects().some((p) => p.path && !p.tmpOnly && !p.broad && normPath(p.path).startsWith(n + '/'))) return { ok: false, reason: 'holds-projects' };
    this.memory.record(dir, { via: SIBERSENTEZ_VIA, lastSeenAt: Date.now() });
    const saved = this.memory.flush() || (!!this.memory.file && !this.memory.dirty);
    if (this.memory.dirty) this.memory.touch(); // a failed write is tried again
    const id = known ? known.id : this.resolve(dir);
    const p = id ? this.getProject(id) : null;
    if (!p) return { ok: false, reason: 'error' };
    p.via = this.sortTools(new Set([...(p.via || []), SIBERSENTEZ_VIA]));
    if (p.kind === 'adhoc' && p.description === PROJECT_NOTE && !known) p.description = ADDED_NOTE;
    if (!p.lastSeenAt) p.lastSeenAt = Date.now();
    return { ok: true, projectId: p.id, existed, saved, reason: existed ? 'existing' : 'added' };
  }

  // The remembered folder a project's idea is kept with: the project's own folder, else a remembered folder of that
  // project (a subfolder the user picked). null when the memory holds none.
  memoryFolderOf(p) {
    if (!p?.path) return null;
    if (this.memory.entry(p.path)) return p.path;
    for (const root of this.discovered.values()) if (root.projectId === p.id && this.memory.entry(root.path)) return root.path;
    return null;
  }

  // Keep the user's idea for a project the memory holds (any via). Returns { ok: true, projectId, changed, saved } or
  // { ok: false, reason: 'invalid' | 'not-a-project' | 'not-in-memory' }. The idea is never logged.
  setProjectIdea(projectId, text) {
    if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return { ok: false, reason: 'invalid' };
    if (typeof text !== 'string') return { ok: false, reason: 'invalid' };
    const p = this.getProject(projectId);
    if (!p || !p.path || p.tmpOnly || p.broad) return { ok: false, reason: 'not-a-project' };
    const folder = this.memoryFolderOf(p);
    if (!folder) return { ok: false, reason: 'not-in-memory' };
    const r = this.memory.setIdea(folder, text);
    if (!r.ok) return r;
    if (r.idea) p.idea = r.idea;
    else delete p.idea;
    return { ok: true, projectId: p.id, changed: r.changed, saved: r.saved };
  }

  // Metadata of a small file (frontmatter, a Codex agent's name and description), cached: the roster rescans
  // thousands of files every minute, so an unchanged file (same modification time and size) is not reopened, and
  // within one pass a file several tools read (.agents/skills/x/SKILL.md) is looked at once. kind names the reader;
  // read(file) returns null when the file cannot be read (locked, access denied): that is not cached, the file is
  // read again on the next pass. A missing file -> null.
  fileMeta(file, kind, read) {
    let hit = this.fmCache.get(file);
    if (hit && this.lister && hit.gen === this.fmGen && Object.hasOwn(hit.meta, kind)) return hit.meta[kind];
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      hit = { mtimeMs: st.mtimeMs, size: st.size, meta: {}, gen: this.fmGen };
      this.fmCache.set(file, hit);
    }
    hit.gen = this.fmGen;
    if (!Object.hasOwn(hit.meta, kind)) {
      const value = read(file);
      if (value === null || value === undefined) return null;
      hit.meta[kind] = value;
    }
    return hit.meta[kind];
  }

  // Frontmatter { name, description, ... }, {} without frontmatter, null when unreadable (see fileMeta)
  frontmatter(file) {
    return this.fileMeta(file, 'frontmatter', readFrontmatter);
  }

  // One pass: every adapter reports projects and items. A new folder lister is made at the start of every pass, so
  // a folder several adapters read is listed once per pass and a change on disk is seen on the next pass.
  // roster: false reloads the projects only (tens of milliseconds) and keeps the skills and agents as they were; the
  // roster scan walks every skill and agent folder of every tool (half a second on a full machine) and runs less often
  load({ roster = true } = {}) {
    this.lister = new DirLister();
    try {
      this.active = this.adapters.filter((a) => this.callAdapter(a, 'detect') === true);
      this.loadProjects();
      // Moved projects linked to their new folder, before the folders are looked at and the memory is matched
      this.links = this.hubDir ? readRelinks(this.hubDir) : [];
      this.joins = this.hubDir ? readJoins(this.hubDir) : [];
      this.applyLinks();
      // A folder can disappear (or come back) while the app runs: unregistered projects are checked again too
      // (a UNC path is never checked)
      for (const p of this.adhoc.values()) {
        if (!p.path) continue;
        p.exists = localExists(p.path);
      }
      this.discoverProjects();
      // "Moved?" only for a folder found in the logs: one the user added here is new, not left behind (after the
      // discovery, which adds the folders first remembered in this pass and the tools each was seen by)
      for (const p of this.adhoc.values()) p.toolsOnly = !!p.path && p.exists === true && !(p.via || []).includes(SIBERSENTEZ_VIA) && toolsOnly(p.path);
      if (roster) this.loadRoster();
      this.version++;
    } finally {
      this.lister = null;
    }
  }

  // reg: raw registry JSON in either format (English "projects" or legacy "projeler"). When given, the
  // registry file is not read (tests stay off the real registry).
  loadProjects(reg) {
    const { projects: rows } = reg === undefined ? readRegistry(this.hubDir) : normalizeRegistry(reg);
    // A project record: these fields, and more set below (exists, toolsOnly, git, installed, plan, ...)
    const list = rows.map((p) => /** @type {Record<string, any>} */ ({
      id: p.id,
      name: p.name,
      kind: 'registered',
      path: p.path,
      description: p.description,
      status: p.status,
      phase: p.phase,
      stack: p.stack,
      packages: p.packages,
      rules: p.rules,
      build: p.build,
      _paths: [p.path, ...p.extraPaths, p.build].filter(Boolean),
      _slugs: [...p.memorySlugs],
    }));
    // A reload must not lose the git state (written by GitWatcher) nor the skill and agent counts (written by the
    // roster scan, which runs every fifth reload: without them the card lost its "N skills · M agents" line)
    const prev = new Map(this.projects.map((p) => [p.id, p]));
    for (const p of list) {
      p.exists = exists(p.path);
      // A project the user registered is never taken for a moved project's old folder: a new, empty one holds only
      // what SiberSentez set up for its first job (.claude, .sibersentez)
      p.toolsOnly = false;
      p._norm = p._paths.map(normPath);
      p._slugs = [...new Set([...p._slugs, ...p._paths.map((x) => slugify(x).toLowerCase())])];
      const old = prev.get(p.id);
      if (old?.git) p.git = old.git;
      if (old?.installed && old.path === p.path) p.installed = old.installed;
      // "What it will do": the project's own status file (CCGS production/), refreshed every 60 s
      p.plan = p.exists ? readPlan(p.path) : null;
    }
    this.projects = list;
    this.resolveCache.clear();
  }

  // A moved project linked to its new folder (relinks.mjs) keeps its id, so its history: its folder becomes the new one
  // (its old folders stay among its paths, so its old sessions still resolve to it), and the new folder's own project
  // is not listed (its sessions resolve to the kept project through linkedPaths). An unregistered project's id is made
  // from its old folder, so it is made from there first; a link whose project is gone (or whose id no longer comes out
  // of that folder) is not applied. An unregistered project unlinked since goes back to its old folder.
  applyLinks() {
    for (const p of this.adhoc.values()) {
      if (!p.linked || this.links.some((l) => l.id === p.id)) continue;
      p.path = p.linked.oldPath;
      p._paths = [p.path];
      p._norm = [normPath(p.path)];
      p._slugs = [slugify(p.path).toLowerCase()];
      p.exists = localExists(p.path);
      delete p.linked;
    }
    this.linkedPaths = new Map();
    this.appliedLinks = [];
    for (const l of this.links) {
      let p = this.projects.find((x) => x.id === l.id) || null;
      if (!p) {
        const a = this.adhocFor(l.oldPath);
        p = a?.id === l.id ? a : null;
      }
      const n = normPath(l.path);
      if (!p || !n) continue;
      if (!p.linked) p.linked = { at: l.at, from: l.from, oldPath: l.oldPath };
      p.path = l.path;
      p._paths = [...new Set([l.path, ...p._paths])];
      p._norm = p._paths.map(normPath);
      p._slugs = [...new Set([...p._slugs, ...p._paths.map((x) => slugify(x).toLowerCase())])];
      p.exists = p.kind === 'registered' ? exists(l.path) : localExists(l.path);
      if (p.kind === 'registered') p.plan = p.exists ? readPlan(p.path) : null;
      const own = this.adhoc.get(n);
      if (own && own !== p) this.adhoc.delete(n);
      this.linkedPaths.set(n, p);
      this.appliedLinks.push(l);
    }
    this.resolveCache.clear();
  }

  // The usage ledger's joins (usage.mjs setJoins): an applied link's new folder id joins the kept project for good; an
  // undone link's, until it was undone
  ledgerJoins() {
    return [...this.appliedLinks.filter((l) => l.from).map((l) => ({ from: l.from, to: l.id, until: null })), ...this.joins];
  }

  // An unregistered project whose folder lies inside a linked folder, by the longest match: a folder of its own (a
  // project made inside the new folder) stays its own and is not taken over by the link. null: none longer than len
  longerAdhoc(n, len) {
    let best = null;
    for (const [pn, p] of this.adhoc) {
      if (p.tmpOnly || !p.path || p.linked) continue;
      if ((pn === n || n.startsWith(pn + '/')) && pn.length > len) {
        best = p;
        len = pn.length;
      }
    }
    return best;
  }

  // cwd (and the ~/.claude/projects folder name, if any) -> project id.
  // Returns null when there is no cwd and the folder name matches no registered project: an unregistered project only
  // opens once a real working folder is known (otherwise ownerless empty projects pile up).
  resolve(cwd, slug) {
    const key = `${cwd || ''}|${slug || ''}`;
    const hit = this.resolveCache.get(key);
    if (hit) return hit;
    const n = normPath(cwd);
    let best = null;
    let bestLen = 0;
    if (n) {
      for (const p of this.projects) {
        for (const pp of p._norm) {
          if ((n === pp || n.startsWith(pp + '/')) && pp.length > bestLen) {
            best = p;
            bestLen = pp.length;
          }
        }
      }
      // A moved project's new folder (applyLinks): its kept project, by the same longest match; a project of its own
      // inside that folder stays its own
      let linked = false;
      for (const [ln, p] of this.linkedPaths) {
        if ((n === ln || n.startsWith(ln + '/')) && ln.length > bestLen) {
          best = p;
          bestLen = ln.length;
          linked = true;
        }
      }
      if (linked) best = this.longerAdhoc(n, bestLen) || best;
    }
    const s = (slug || '').toLowerCase();
    if (!best && s) best = this.projects.find((p) => p._slugs.includes(s)) || null;
    // Temporary scratchpad/tasks folders: the real project name is embedded in the path
    // (slugs are lower case: the folder name embedded in the path is looked at in lower case too)
    const ln = n.toLowerCase();
    const probe = ln.includes(SCRATCH_MARKER) ? ln.split(SCRATCH_MARKER)[1] : s.includes('-temp-claude-') ? s.split('-temp-claude-')[1] : '';
    if (!best && probe) {
      const embedded = probe.split('/')[0];
      // Bounded, longest match: "...-demo" does not match "...-demo2"
      const fits = (x) => !!x && (embedded === x || embedded.startsWith(x + '-'));
      let len = 0;
      // Broad folders (home, Desktop) match every sub-path as a prefix: they (whether real or
      // seen only from a temporary folder) become a candidate only on an exact match
      const candidates = [...this.projects, ...[...this.adhoc.values()].filter((a) => a.tmpOnly || a.path)];
      for (const p of candidates) {
        for (const x of p._slugs) {
          const ok = p.kind === 'adhoc' && this.isBroadSlug(x) ? embedded === x : fits(x);
          if (ok && x.length > len) {
            best = p;
            len = x.length;
          }
        }
      }
      // The parent folder's project has not been seen yet: do not open a junk "scratchpad" project, open a temporary
      // project from the embedded folder name. Once the real folder is seen, adhocFor promotes the same object (same id).
      if (!best) best = this.tmpAdhoc(embedded);
    }
    if (!best && cwd) best = this.adhocFor(cwd);
    if (!best) return null;
    this.resolveCache.set(key, best.id);
    return best.id;
  }

  // Broad folder: not a project (home, Desktop, Documents, Downloads, the temp folder and every drive root). Other
  // tools remember the temp folder itself as a project (Gemini CLI started there); as a project it would swallow
  // every working folder below it (adhocFor maps a subfolder to its parent project).
  // <home>\AppData and every folder below it are broad too: editors report their own install folders
  // (AppData\Local\Programs\<editor>) and games their save folders as workspaces, and none of them is a project.
  // The one exception keeps the temp rule as it is: a temp folder inside AppData (AppData\Local\Temp) is itself
  // broad, a working folder inside it stays a project of its own (Claude Code's scratchpad under Temp\claude is
  // handled separately, SCRATCH_MARKER). A temp folder that holds the home folder instead (a home made inside
  // %TEMP%) carves nothing out of that home's AppData.
  isBroad(n) {
    if (!this.broad) {
      const h = this.homeDir;
      // The platform's temp folders and program data places (platform.mjs; plan G2)
      const temps = tempFolders(this.env, h);
      this.broad = new Set([h, path.join(h, 'Desktop'), path.join(h, 'Documents'), path.join(h, 'Downloads'), ...temps].map(normPath));
      this.appDataRoots = programDataFolders(h).map(normPath);
      this.appDataRoot = this.appDataRoots[0] || '';
      this.tempRoots = temps.map(normPath).filter((t) => this.appDataRoots.some((a) => t.startsWith(a + '/')));
      this.homeKey = h ? normPath(h) : '';
    }
    if (this.broad.has(n) || /^[a-z]:$/i.test(n)) return true;
    // Linux and macOS: the home folder's program folders (~/.npm, ~/.nvm, ~/.cargo...: platform.mjs) and what is below
    // them are the programs' own, as AppData is on Windows; a hidden folder of the person's own (~/.dotfiles) is not.
    // The system's own folders (/usr, /etc/nginx...) never become projects from a tool record either (review G)
    if (!PLATFORM.windows) {
      if (this.homeKey && PROGRAM_HOME_FOLDERS.some((d) => n === `${this.homeKey}/${d}` || n.startsWith(`${this.homeKey}/${d}/`))) return true;
      if (isSystemFolder(n)) return true;
    }
    return this.inAppData(n);
  }

  // Where an unregistered folder sits, for the page to keep it out of the projects (docs/folders.md): 'broad' (a broad
  // or system folder), 'temp' (inside a temp folder: a test or a download, gone soon), 'chat' (a chat folder of the
  // Codex desktop app, <home>\Documents\Codex\<date>\<slug>, one per conversation), or null (a project). A registered
  // project is always null: the person listed it.
  placeOf(p) {
    if (!p || p.kind !== 'adhoc') return null;
    if (p.broad) return 'broad';
    const n = p.path ? normPath(p.path) : '';
    if (!n) return null;
    this.isBroad(n); // builds the broad and temp lists
    if (this.isSystemFolder(n) || /windows\/system32$/i.test(n)) return 'broad';
    const temps = tempFolders(this.env, this.homeDir).map(normPath);
    if (temps.some((t) => n.startsWith(t + '/'))) return 'temp';
    const docs = normPath(path.join(this.homeDir, 'Documents', 'Codex'));
    if (n.startsWith(docs + '/') && /^\d{4}-\d{2}-\d{2}\/[^/]+$/.test(n.slice(docs.length + 1))) return 'chat';
    return null;
  }

  // n (normPath form) is <home>\AppData or below it, and not inside a temp folder that lies within AppData
  inAppData(n) {
    if (!n || !(this.appDataRoots || []).some((a) => a && (n === a || n.startsWith(a + '/')))) return false;
    return !this.tempRoots.some((t) => n.startsWith(t + '/'));
  }

  // The same broad folders in Claude Code folder-name (slug) form
  isBroadSlug(slugLower) {
    if (!this.broadSlugs) {
      this.isBroad('');
      this.broadSlugs = new Set([...this.broad].map((b) => slugify(b).toLowerCase()));
    }
    return this.broadSlugs.has(slugLower) || /^[a-z]-$/.test(slugLower);
  }

  // Unregistered project id from the folder name (Claude Code slug form); the same whether computed from the real
  // path or from the name embedded in a temp folder. A long name keeps its last whole words (cut at a '-') plus a
  // short hash of the full name: the id never starts mid-word and two long paths with the same tail differ.
  // Names up to ID_TAIL characters keep their previous id.
  adhocId(slugLower) {
    const s = slugLower.replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (s.length <= ID_TAIL) return 'x-' + s;
    const tail = s.slice(-ID_TAIL);
    const words = s[s.length - ID_TAIL - 1] === '-' ? tail : tail.slice(tail.indexOf('-') + 1);
    const hash = crypto.createHash('sha1').update(s).digest('hex').slice(0, 6);
    return `x-${words}-${hash}`;
  }

  // The id of an unregistered folder n (normPath form) whose slug is slugLower (review 2026-10 F01). The slug is lower
  // case, as it always was, so every id stored so far (restore points, usage, job records) stays the same. Where letter
  // case counts (Linux), two folders can share that slug (work/App and work/app): the one the project memory saw first
  // (firstSeenAt, ties by byte order) keeps the plain id, every other one gets a short digest of its exact path after
  // it. Decided from the memory, not from the order the folders show up in, so a restart gives each the same id; an
  // id another listed folder already has is never given twice. A record that merged two such folders before is not
  // split: it stays one folder's, under its old id.
  adhocIdFor(n, slugLower) {
    const plain = this.adhocId(slugLower);
    if (PLATFORM.caseless) return plain;
    const mine = this.memory.entries?.get(n);
    const before = (k, e) => !mine || e.firstSeenAt < mine.firstSeenAt || (e.firstSeenAt === mine.firstSeenAt && k < n);
    let taken = false;
    for (const [k, e] of this.memory.entries || []) {
      if (k !== n && before(k, e) && slugify(k).toLowerCase() === slugLower) taken = true;
    }
    for (const [k, p] of this.adhoc) if (k !== n && p.id === plain) taken = true;
    if (!taken) return plain;
    // SHA-256 (code scanning #15); a short tag only, never a secret. adhocId above keeps SHA-1: ids stored so far
    return `${plain}-${crypto.createHash('sha256').update(n).digest('hex').slice(0, 6)}`;
  }

  tmpAdhoc(embedded) {
    const key = 'tmp:' + embedded;
    let p = this.adhoc.get(key);
    if (p) return p;
    // Guess a readable name: drop the drive, user and Desktop/Documents/Projects prefixes
    const guess = embedded.replace(/^[a-z]--/, '').replace(/^users-[^-]+-/, '').replace(/^(desktop|documents|projects|projeler)-/, '').replace(/-/g, ' ').trim();
    p = {
      id: this.adhocId(embedded),
      name: guess || embedded,
      kind: 'adhoc',
      path: null,
      exists: false,
      tmpOnly: true,
      description: 'Only seen in temporary (scratchpad) folders; the real folder is not known yet.',
      status: 'unregistered',
      phase: '',
      stack: [],
      packages: [],
      rules: [],
      _paths: [],
      _norm: [],
      _slugs: [embedded],
    };
    this.adhoc.set(key, p);
    return p;
  }

  adhocFor(cwd) {
    const n = normPath(cwd);
    let parent = null;
    for (const [pn, p] of this.adhoc) {
      if (p.tmpOnly) continue;
      if (!this.isBroad(pn) && n.startsWith(pn + '/') && (!parent || pn.length > normPath(parent.path).length)) parent = p;
    }
    if (parent) return parent;
    const existing = this.adhoc.get(n);
    if (existing) return existing;
    const raw = cwd;
    let name = path.basename(String(raw).replace(/[\\/]+$/, '')) || raw;
    if (n === normPath(this.homeDir)) name = 'Home folder';
    if (/windows\/system32$/i.test(n)) name = 'Windows';
    // A broad/system folder is not a project: the UI does not offer "add to registry"
    const broad = this.isBroad(n) || /windows\/system32$/i.test(n);
    // If a project was opened earlier only from a temporary folder, promote it to the real path (the id stays the same)
    const slugLower = slugify(n).toLowerCase();
    const tmp = this.adhoc.get('tmp:' + slugLower);
    if (tmp) {
      this.adhoc.delete('tmp:' + slugLower);
      Object.assign(tmp, { name, path: cwd, exists: localExists(cwd), tmpOnly: false, broad, description: PROJECT_NOTE, _paths: [cwd], _norm: [n], _slugs: [slugLower] });
      this.adhoc.set(n, tmp);
      return tmp;
    }
    const p = {
      id: this.adhocIdFor(n, slugLower),
      name,
      kind: 'adhoc',
      path: cwd,
      exists: localExists(cwd),
      broad,
      description: PROJECT_NOTE,
      status: 'unregistered',
      phase: '',
      stack: [],
      packages: [],
      rules: [],
      _paths: [cwd],
      _norm: [n],
      _slugs: [slugify(cwd).toLowerCase()],
    };
    this.adhoc.set(n, p);
    return p;
  }

  allProjects() {
    return [...this.projects, ...this.adhoc.values()];
  }

  // Where "Add to the library" takes a listed skill or agent from (docs/skills-flow.md §5.1): { source, pick } for the
  // library's own scan and import (server/library.mjs scanSource, planImport), or null. A skill is its folder (the
  // folder holding SKILL.md; pick '.'); an agent is a .md file right inside a folder named agents (pick: the file
  // name). The personal copy first, then a project's, then the rest (rank). The library and the kit are never a
  // source (they are already there), a source is at most 260 characters (the scan's limit).
  // The answer is kept until the roster is built again (the roster view asks for every item on every snapshot).
  itemOrigin(kind, name) {
    if (kind !== 'skill' && kind !== 'agent') return null;
    const key = `${kind}:${name}`.toLowerCase();
    if (this.originCache?.files !== this.itemFiles) this.originCache = { files: this.itemFiles, map: new Map() };
    if (this.originCache.map.has(key)) return this.originCache.map.get(key);
    const o = this.findOrigin(kind, key);
    this.originCache.map.set(key, o);
    return o;
  }

  // Whether the list may offer "Add to the library" (the roster view, every item on every snapshot): the same choice of
  // place as findOrigin without its disk checks. Those cost about a second on a full machine (2,400 items, a realpath
  // each, measured 2026-10-02) and held the first page; the action itself still runs the full check (itemOrigin)
  // and says why when a place turns out to be a link or gone. Pure string work.
  itemOriginLikely(kind, name) {
    if (kind !== 'skill' && kind !== 'agent') return false;
    const key = `${kind}:${name}`.toLowerCase();
    const hub = this.hubDir ? normPath(this.hubDir) : null;
    const home = this.homeDir ? normPath(this.homeDir) : null;
    for (const { source, file } of this.itemFiles.get(key) || []) {
      if (source === 'library' || source === KIT_SOURCE || !path.isAbsolute(file) || !/^[A-Za-z]:[\\/]/.test(file)) continue;
      let dir = null;
      if (kind === 'skill') dir = path.basename(file).toLowerCase() === 'skill.md' ? path.dirname(file) : file;
      else if (/\.md$/i.test(file) && path.basename(path.dirname(file)).toLowerCase() === 'agents') dir = path.dirname(file);
      if (!dir || dir.length > 260) continue;
      const n = normPath(dir);
      if ((hub && (n === hub || n.startsWith(hub + '/'))) || (home && n === home) || /^[a-z]:\/?$/i.test(n)) continue;
      return true;
    }
    return false;
  }

  // The first place of an item that the library's scan would also take (checkSource: no junction, not inside the hub,
  // not the home folder or a drive root, still there): so "Add to the library" is offered only where it works
  findOrigin(kind, key) {
    const list = [...(this.itemFiles.get(key) || [])].sort((a, b) => rank(a.source) - rank(b.source));
    for (const { source, file } of list) {
      if (source === 'library' || source === KIT_SOURCE || !path.isAbsolute(file)) continue;
      let origin = null;
      if (kind === 'skill') origin = { source: path.basename(file).toLowerCase() === 'skill.md' ? path.dirname(file) : file, pick: '.' };
      else if (/\.md$/i.test(file) && path.basename(path.dirname(file)).toLowerCase() === 'agents') origin = { source: path.dirname(file), pick: path.basename(file) };
      if (origin && origin.source.length <= 260 && checkSource(origin.source, { hubDir: this.hubDir, homeDir: this.homeDir }).ok) return origin;
    }
    return null;
  }

  getProject(id) {
    return this.projects.find((p) => p.id === id) || [...this.adhoc.values()].find((p) => p.id === id) || null;
  }

  // Folder whose project items are read: it must exist; a broad folder (home included) is skipped, and so is an
  // unregistered project on a UNC path (never checked). Tool-specific rules (e.g. a .claude that is the personal
  // folder) are applied by the adapters.
  projectFolder(p) {
    if (!p?.path || p.tmpOnly || p.broad) return null;
    if (p.kind === 'adhoc' && !isLocalPath(p.path)) return null;
    return this.scanFolderOf(p.path);
  }

  // The same rule for a bare folder (a remembered or discovered working directory)
  scanFolderOf(folder) {
    const n = normPath(folder);
    if (!n || n === normPath(this.homeDir) || this.isBroad(n) || /windows\/system32$/i.test(n)) return null;
    return exists(folder) ? folder : null;
  }

  // ---- Roster ----
  // Called by load() inside its pass; called alone it runs as a pass of its own (with its own folder lister)
  loadRoster() {
    if (this.lister) return this.buildRoster();
    this.lister = new DirLister();
    try {
      return this.buildRoster();
    } finally {
      this.lister = null;
    }
  }

  // The same scan in steps (the library and the kit, each tool's global items, each project folder), giving the event
  // loop back between them, so the five-minute rescan never holds the live view and the requests for half a second
  // (measured 2026-10-06: 0.45 s in one piece on a machine with thousands of items, the largest step about 60 ms: a long tool read gives the loop back between its parts). Nothing is
  // seen half done: the roster, the project counts, the hub and the kit change together at the end. A full scan that
  // runs meanwhile (after an action) wins: this one then ends without changing anything. One at a time.
  // pause(): what gives the loop back (setImmediate; a test passes its own). Returns true when it changed the roster.
  async loadRosterInSteps({ pause = () => new Promise((r) => setImmediate(r)) } = {}) {
    if (this.rosterStepping) return false;
    this.rosterStepping = true;
    const ls = new DirLister();
    const steps = this.rosterSteps();
    try {
      for (;;) {
        const prev = this.lister;
        this.lister = ls;
        let step;
        try {
          step = steps.next();
        } finally {
          this.lister = prev;
        }
        if (step.done) return step.value === true;
        await pause();
      }
    } finally {
      this.rosterStepping = false;
    }
  }

  buildRoster() {
    const steps = this.rosterSteps();
    while (!steps.next().done);
  }

  *rosterSteps() {
    const pass = (this.rosterPass = (this.rosterPass || 0) + 1);
    // The tools of this pass, one list for the global items and the project folders alike
    const active = [...this.active];
    this.fmGen++;
    const roster = new Map();
    // Where each skill or agent the tools see lives on this disk (kind:name -> [{ source, file }]): for "Add to the
    // library" from the list (itemOrigin). Server only: a path never goes into a roster item.
    const files = new Map();
    const add = (item) => {
      const key = `${item.kind}:${item.name}`.toLowerCase();
      const prev = roster.get(key);
      if (!prev) {
        item.sources = [item.source];
        item.tools = item.tools ? [...item.tools] : [];
        item.installedIn = item.installedIn || [];
        item.global = !!item.global;
        roster.set(key, item);
        return item;
      }
      if (!prev.sources.includes(item.source)) prev.sources.push(item.source);
      for (const t of item.tools || []) if (!prev.tools.includes(t)) prev.tools.push(t);
      for (const pid of item.installedIn || []) if (!prev.installedIn.includes(pid)) prev.installedIn.push(pid);
      if (item.global) prev.global = true;
      for (const d of item.personalDirs || []) {
        if (!prev.personalDirs) prev.personalDirs = [];
        if (!prev.personalDirs.includes(d)) prev.personalDirs.push(d);
      }
      if (!prev.description && item.description) prev.description = item.description;
      if (item.plugin && !prev.plugin) prev.plugin = item.plugin;
      if (item.enabled !== undefined) prev.enabled = !!prev.enabled || item.enabled;
      if (item.kitCategory && !prev.kitCategory) Object.assign(prev, { kitCategory: item.kitCategory, kitVersion: item.kitVersion, stage: item.stage });
      // Category only means something in the library and the kit: an item from there (they are always added first)
      // keeps it
      if (rank(item.source) < rank(prev.source)) {
        prev.source = item.source;
        if (!prev.sources.includes('library') && !prev.sources.includes(KIT_SOURCE)) prev.category = item.category;
      }
      return prev;
    };
    // Roster item from an adapter item: only known fields, trimmed description, tagged with the adapter id. A personal
    // item also carries the home-relative folder it was found in (personalDirs; never a full path).
    const fromAdapter = (it, tool, extra = {}) => {
      if ((it.kind === 'skill' || it.kind === 'agent') && typeof it.path === 'string' && it.path) {
        const k = `${it.kind}:${it.name}`.toLowerCase();
        if (!files.has(k)) files.set(k, []);
        files.get(k).push({ source: it.source, file: it.path });
      }
      /** @type {Record<string, any>} */
      const out = { kind: it.kind, name: it.name, source: it.source, category: it.category || it.source, description: truncate(it.description, DESC_MAX), global: !!it.global, tools: [tool], ...extra };
      if (it.source === 'personal') {
        const d = personalDir(it.path, it.kind, this.homeDir);
        if (d) out.personalDirs = [d];
      }
      if (it.enabled !== undefined) out.enabled = !!it.enabled;
      if (it.plugin) out.plugin = it.plugin;
      if (it.pluginId) out.pluginId = it.pluginId;
      return out;
    };
    const valid = (it) => it && typeof it.name === 'string' && it.name && ['skill', 'agent', 'plugin'].includes(it.kind) && typeof it.source === 'string';

    // Library (hub): the library folders (docs/skills-flow.md §2.1; frontmatter through the cache, so an unchanged
    // file is not read again) plus catalog.json rows without a folder. A legacy hub: its catalog only.
    const library = this.hubDir ? libraryItems(this.hubDir, { frontmatter: (f) => this.frontmatter(f) }) : [];
    // Where a library item came from, when it was brought from GitHub (docs/github-import.md §7): repository, short
    // commit and license only (registry/sources.json; never a path). A row names the category it was imported into.
    const origins = new Map();
    if (this.hubDir) for (const r of readSources(this.hubDir).sources) origins.set(`${r.kind}:${r.name}`.toLowerCase(), r);
    for (const o of library) {
      const row = origins.get(`${o.kind}:${o.name}`.toLowerCase());
      const origin = row && (!row.category || row.category === o.category) ? originOf(row) : null;
      add({ kind: o.kind, name: o.name, source: 'library', category: o.category, description: truncate(o.description, DESC_MAX), global: false, ...(origin ? { origin } : {}) });
    }
    const libraryCount = library.length;

    // The SiberSentez kit (read-only, shipped with the app): after the library, so an item of the user's own library
    // with the same name stays a library item (its category and description first). kitCategory: the kit folder
    // the item sits in (the roster's folder filter), whatever the library calls it.
    const kit = readKit(this.kitDir, { frontmatter: (f) => this.frontmatter(f) });
    for (const o of kit.items) {
      add({ kind: o.kind, name: o.name, source: KIT_SOURCE, category: o.category, kitCategory: o.category, kitVersion: o.version, stage: o.stage, description: truncate(o.description, DESC_MAX), global: false });
    }
    const kitInfo = kit.items.length ? { version: kit.version, ...kitCounts(kit) } : null;
    yield;
    // A full scan ran meanwhile (an action): its answer is newer, the rest of this one is not needed
    if (pass !== this.rosterPass) return false;

    // Items active outside a single project (personal, claude.ai, plugins, built-in), per tool
    // A tool that reads in parts (its plugins) gives the loop back inside its read too, once a step took STEP_MS
    for (const adapter of active) {
      let since = performance.now();
      let fresh = false; // the loop was just given back: the tool's end needs no second pause
      for (const part of this.globalItemParts(adapter)) {
        for (const it of part) if (valid(it)) add(fromAdapter(it, adapter.id));
        fresh = false;
        if (performance.now() - since < STEP_MS) continue;
        yield;
        if (pass !== this.rosterPass) return false;
        since = performance.now();
        fresh = true;
      }
      if (fresh) continue;
      yield;
      if (pass !== this.rosterPass) return false;
    }

    // Items installed in or owned by a project: every registered project, every project found in the logs or
    // remembered, and every remembered folder (a subfolder mapped to a parent project is read too; its items count
    // for that project). Several tools can read the same file (.claude/skills, .agents/skills): it is counted once
    // per project (by its normalized path; an item without a path by kind:name).
    const scanned = new Set();
    const counted = new Map(); // project id -> Set of counted item keys
    const installed = new Map(); // project id -> { skills, agents }, put on the projects at the end
    const scanInto = (p, folder) => {
      if (!p || !folder || scanned.has(normPath(folder))) return false;
      scanned.add(normPath(folder));
      let seen = counted.get(p.id);
      if (!seen) counted.set(p.id, (seen = new Set()));
      let n = installed.get(p.id);
      if (!n) installed.set(p.id, (n = { skills: 0, agents: 0 }));
      for (const adapter of active) {
        for (const it of this.callAdapter(adapter, 'findItems', folder)) {
          if (!valid(it) || (it.kind !== 'skill' && it.kind !== 'agent')) continue;
          add(fromAdapter({ ...it, source: 'project', category: 'project', global: false }, adapter.id, { installedIn: [p.id] }));
          const key = typeof it.path === 'string' && it.path ? `file:${normPath(it.path)}` : `item:${it.kind}:${it.name}`.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          if (it.kind === 'skill') n.skills++;
          else n.agents++;
        }
      }
      return true;
    };
    for (const p of this.allProjects()) {
      if (!scanInto(p, this.projectFolder(p))) continue;
      yield;
      if (pass !== this.rosterPass) return false;
    }
    for (const root of [...this.discovered.values()]) {
      const p = this.getProject(root.projectId);
      if (!p || p.broad || !scanInto(p, this.scanFolderOf(root.path))) continue;
      yield;
      if (pass !== this.rosterPass) return false;
    }

    // A full scan ran meanwhile (an action): its answer is newer, this one changes nothing
    if (pass !== this.rosterPass) return false;
    for (const it of roster.values()) {
      it.sources.sort((a, b) => rank(a) - rank(b));
      it.tools = this.sortTools(it.tools);
      if (it.personalDirs) it.personalDirs.sort();
    }
    this.hub = this.hubDir ? { path: this.hubDir, projects: this.projects.length, library: libraryCount } : null;
    this.kit = kitInfo;
    for (const p of this.allProjects()) p.installed = installed.get(p.id) || { skills: 0, agents: 0 };
    this.itemFiles = files;
    this.roster = roster;
    // Drop cache entries for files not seen in this pass (deleted or moved)
    for (const [file, e] of this.fmCache) if (e.gen !== this.fmGen) this.fmCache.delete(file);
    return true;
  }
}
