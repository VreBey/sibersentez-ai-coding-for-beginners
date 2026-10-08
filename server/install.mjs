// Install, remove and try library items in a project (docs/skills-flow.md §3).
//
// Where an item comes from: the hub library first; an item the library does not hold comes from the SiberSentez kit
// (server/kit.mjs, the folder shipped with the app; docs/kit.md), copied straight from there, never through the
// library. A kit install is recorded with source 'kit', the kit version and the item version.
//
// Targets: 'claude' -> <p>/.claude/skills/<name>/ and <p>/.claude/agents/<name>.md; 'agents' -> <p>/.agents/skills/
// <name>/ (skills only; an agent always goes to 'claude'). The install record <hub>/registry/installs.json lists what
// SiberSentez installed; nothing else is written into a project. Rules:
//   - never overwrite what SiberSentez did not install (project-owned), never overwrite or delete what changed since
//     the install (modified); remove deletes only what the record lists and only when unchanged;
//   - every destination resolves inside <p>/.claude or <p>/.agents, and no folder on the way is a reparse point;
//   - copies never follow junctions or symbolic links.
// Computing a plan never writes. Pure module: node built-ins and local modules that do not import config.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { normPath } from './util.mjs';
import { isLocalPath } from './fsutil.mjs';
import { codeError, lstat, isLink, isRealDir, findLibraryItem, treeHash, measureTree, sizeProblem, sameHash, placeCopy, copyTree, writeJsonAtomic, within, withinReal, isLegacyHub, realPath, hasStreamColon, isDriveRoot, sweepStaging, libraryStageDirs, LIMITS } from './library.mjs';
import { readKit, findKitItem, defaultKitDir, KIT_SOURCE } from './kit.mjs';
import { AGENT_FORMATS, AGENT_FORMAT_VERSION, agentFileName, convertAgent } from './agentFormats.mjs';
import crypto from 'node:crypto';

// claude and agents hold skills (and claude the agents as they are); gemini, qwen, opencode and codex hold agents only,
// converted to that tool's own file (server/agentFormats.mjs, 2026-10-07)
export const TARGETS = Object.freeze(['claude', 'agents', ...AGENT_FORMATS]);
const SKILL_TARGETS = Object.freeze(['claude', 'agents']);
const TOOL_FOLDER = Object.freeze({ claude: '.claude', agents: '.agents', gemini: '.gemini', qwen: '.qwen', opencode: '.opencode', codex: '.codex' });
const converted = (target) => AGENT_FORMATS.includes(target);
// A converted copy's record keeps its source's hash and the converter's version (a new converter updates the copies)
const srcHashOf = (libHash) => `${libHash}|f${AGENT_FORMAT_VERSION}`;
// Tools that read the shared Agent Skills folder (.agents/skills) and not .claude/skills
const AGENTS_TOOLS = Object.freeze(['codex', 'gemini-cli', 'antigravity']);
export const TRIAL_MARKER = '.sibersentez-trial.json';
export const TRIAL_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const TRIAL_RE = /^\d{8}-\d{6}-\d{3}-[a-z0-9][a-z0-9-]{0,39}(?:-\d{1,3})?$/;
const fail = (status, error) => ({ ok: false, status, error });

// Default targets from the tools a project was used with (the project's `via`): 'claude' when Claude Code is among
// them or no tool that reads .agents is; 'agents' when Codex, Gemini CLI or Antigravity is among them.
export function defaultTargets(via) {
  const v = new Set(Array.isArray(via) ? via : []);
  const agents = AGENTS_TOOLS.some((t) => v.has(t));
  const out = [];
  if (v.has('claude-code') || !agents) out.push('claude');
  if (agents) out.push('agents');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Install record
// ---------------------------------------------------------------------------------------------------------------

export function installsFile(hubDir) {
  return path.join(hubDir, 'registry', 'installs.json');
}

const validRecord = (r) => r && typeof r === 'object' && ['project', 'target', 'kind', 'name', 'path', 'hash'].every((k) => typeof r[k] === 'string' && r[k]);

// { ok, installs, rows }. installs: the rows that can be used (every field present); rows: every row of the file as
// read, the unusable ones included, in file order (installs holds the same objects). A writer rewrites rows, so a
// row this version cannot use is kept, never dropped (contract §3.9). A missing file is an empty record; an
// unreadable or broken file gives ok: false (writers refuse then, so a broken record is never replaced by a shorter
// one).
export function readInstalls(hubDir) {
  const none = (ok) => ({ ok, installs: [], rows: [] });
  if (typeof hubDir !== 'string' || !hubDir) return none(true);
  let text;
  try {
    text = fs.readFileSync(installsFile(hubDir), 'utf8');
  } catch (e) {
    return none(e?.code === 'ENOENT');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return none(false);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.installs)) return none(false);
  return { ok: true, installs: data.installs.filter(validRecord), rows: data.installs.slice() };
}

export function writeInstalls(hubDir, rows) {
  writeJsonAtomic(installsFile(hubDir), { version: 1, installs: rows });
}

const recKey = (r) => `${r.project}|${r.target}|${r.kind}|${r.name}`.toLowerCase();

// The record of an item in a project and target, only when it points at this very destination (a project that moved
// keeps its old record, which never makes SiberSentez touch the new folder)
export function findRecord(installs, projectId, target, kind, name, dest) {
  const k = recKey({ project: projectId, target, kind, name });
  return installs.find((r) => recKey(r) === k && normPath(r.path) === normPath(dest)) || null;
}

// Replaces the usable row of the same project, target, kind and name, or appends; unusable rows stay where they are
function upsert(rows, rec) {
  const i = rows.findIndex((r) => validRecord(r) && recKey(r) === recKey(rec));
  if (i === -1) rows.push(rec);
  else rows[i] = rec;
}

// ---------------------------------------------------------------------------------------------------------------
// Project and destinations
// ---------------------------------------------------------------------------------------------------------------

// Broad folders are never install targets: a drive root, the home folder, Desktop, Documents, Downloads, System32.
// Checked on the given path and on the real path of both the folder and the home folder, so an 8.3 short name, a
// junction or an alternate data stream form of a broad folder is broad too.
export function isBroadFolder(dir, homeDir) {
  const forms = [dir, realPath(dir)].filter(Boolean);
  const homes = homeDir ? [homeDir, realPath(homeDir)].filter(Boolean) : [];
  return forms.some((f) => {
    const n = normPath(f);
    if (isDriveRoot(f) || /^[a-z]:$/.test(n) || /\/windows\/system32$/.test(n)) return true;
    return homes.some((h) => ['', 'Desktop', 'Documents', 'Downloads'].some((x) => n === normPath(x ? path.join(h, x) : h)));
  });
}

// A project the skill actions may write into: listed, a local drive path without a ':' after the drive letter, not
// broad, existing, not the hub or inside it, and neither of its tool folders is (or is inside) the personal Claude
// folder. The broad, hub and personal-folder rules are checked on the real path too. Returns { ok, project, dir }.
export function resolveProject({ catalog, projectId, hubDir = null, homeDir = null, claudeDir = null }) {
  const p = catalog?.getProject?.(projectId) || null;
  if (!p) return fail(404, 'not-a-project');
  if (p.broad) return fail(409, 'broad-folder');
  if (!p.path || p.tmpOnly) return fail(404, 'folder-missing');
  if (!isLocalPath(p.path) || hasStreamColon(p.path) || /[\u0000-\u001f\u007f-\u009f]/.test(p.path)) return fail(409, 'not-local');
  let dir = path.win32.normalize(p.path);
  if (dir.length > 3) dir = dir.replace(/[\\/]+$/, '');
  if (isBroadFolder(dir, homeDir) || (typeof catalog.isBroad === 'function' && catalog.isBroad(normPath(dir)))) return fail(409, 'broad-folder');
  let st = null;
  try {
    st = fs.statSync(dir);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) return fail(404, 'folder-missing');
  const real = realPath(dir);
  if (!real) return fail(404, 'folder-missing');
  if (!isLocalPath(real) || hasStreamColon(real)) return fail(409, 'not-local');
  if (typeof catalog.isBroad === 'function' && catalog.isBroad(normPath(real))) return fail(409, 'broad-folder');
  if (hubDir && (withinReal(dir, hubDir) || within(real, realPath(hubDir) || hubDir))) return fail(409, 'project-in-hub');
  if (claudeDir) {
    const realClaude = realPath(claudeDir);
    for (const t of ['.claude', '.agents']) {
      for (const d of [path.join(dir, t), path.join(real, t)]) {
        if (within(d, claudeDir) || within(claudeDir, d) || withinReal(d, claudeDir)) return fail(409, 'personal-folder');
        if (realClaude && (within(d, realClaude) || within(realClaude, d))) return fail(409, 'personal-folder');
      }
    }
  }
  return { ok: true, project: p, dir };
}

// Destination of an item in a target: { base (the tool folder: .claude, .agents, .gemini, .qwen, .opencode, .codex),
// group (skills or agents folder), dest, inside }
export function destination(dir, kind, name, target) {
  const base = path.resolve(dir, TOOL_FOLDER[target] || '.claude');
  const group = path.join(base, kind === 'skill' ? 'skills' : 'agents');
  const dest = path.resolve(group, kind === 'skill' ? name : agentFileName(name, target));
  const inside = dest.toLowerCase().startsWith(group.toLowerCase() + path.sep) && path.dirname(dest).toLowerCase() === group.toLowerCase();
  return { base, group, dest, inside };
}

// A folder on the way to the destination (the tool folder or its skills/agents folder) is a junction or a link
function reparseOnTheWay({ base, group }) {
  return isLink(base) || isLink(group);
}

// An agent always goes to .claude (Claude Code, Copilot CLI and Cursor CLI read it) and to the converted targets asked
// for; a skill to the skill targets asked for
const targetsOf = (kind, targets) => (kind === 'agent' ? ['claude', ...targets.filter(converted)] : targets.filter((t) => SKILL_TARGETS.includes(t)));

// The item an install or a trial copies: the library's, else the kit's. kit: a kit (kit.mjs readKit) or undefined
// for the kit of this process (defaultKitDir: the one config.mjs names KIT_DIR). null: in neither.
export function findSourceItem(library, kind, name, kit) {
  return findLibraryItem(library, kind, name) || findKitItem(kit === undefined ? readKit(defaultKitDir()) : kit, kind, name);
}

// A kit item (kit.mjs readKit, or a copy of one a preview stands in with)
const isKitItem = (it) => it?.origin === KIT_SOURCE;

// ---------------------------------------------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------------------------------------------

// Install plan (skills-preview and skills-install). Entries: { op: copy|update|skip, kind, name, target, path,
// reason } plus internal fields. Reasons: new, missing (recorded but gone: copied again), library-changed (update),
// kit-changed (update from a newer kit copy), up-to-date, modified, project-owned, not-in-library (neither in the
// library nor in the kit), reparse-point, outside-project, too-large, too-many-files, too-many-folders, too-deep. A
// library or kit item is measured before it is hashed; one over the limits is never hashed. kit: see findSourceItem.
export function planInstall({ project, dir, items, targets, library, installs, limits = LIMITS, kit }) {
  const plan = [];
  const hashes = new Map();
  for (const it of items) {
    const lib = findSourceItem(library, it.kind, it.name, kit);
    let libHash = null;
    let libProblem = null;
    if (lib) {
      if (!hashes.has(lib.path)) {
        const problem = sizeProblem(measureTree(lib.path, limits), limits);
        hashes.set(lib.path, { problem, hash: problem ? null : treeHash(lib.path, { links: 'skip', limits }) });
      }
      ({ hash: libHash, problem: libProblem } = hashes.get(lib.path));
    }
    for (const target of targetsOf(it.kind, targets)) {
      const d = destination(dir, it.kind, it.name, target);
      const e = { op: 'skip', kind: it.kind, name: it.name, target, path: d.dest, reason: '' };
      plan.push(e);
      if (!lib) {
        e.reason = 'not-in-library';
        continue;
      }
      if (libProblem) {
        e.reason = libProblem;
        continue;
      }
      if (!d.inside) {
        e.reason = 'outside-project';
        continue;
      }
      if (reparseOnTheWay(d)) {
        e.reason = 'reparse-point';
        continue;
      }
      const rec = findRecord(installs, project.id, target, it.kind, it.name, d.dest);
      const st = lstat(d.dest);
      const fromKit = isKitItem(lib);
      Object.assign(e, { _src: lib.path, _rel: lib.rel, _kit: fromKit ? { kitVersion: lib.kitVersion || null, itemVersion: lib.version || null } : null, _libHash: libHash, _rec: rec, _d: d });
      // A converted agent is converted here, so the preview says when it cannot be (and no folder is made for it)
      if (converted(target)) {
        let text = null;
        try {
          text = convertAgent(fs.readFileSync(lib.path, 'utf8'), target, it.name);
        } catch {
          text = null;
        }
        if (!text) {
          e.reason = 'not-convertible';
          continue;
        }
        e._text = text;
      }
      if (st?.isSymbolicLink()) e.reason = 'reparse-point';
      else if (!st) {
        e.op = 'copy';
        e.reason = rec ? 'missing' : 'new';
      } else if (!rec) e.reason = 'project-owned';
      else if (!sameHash(treeHash(d.dest, { limits }), rec.hash)) e.reason = 'modified';
      // A converted agent is another text than its source: its record keeps the source's hash apart (srcHash)
      else if (converted(target) ? rec.srcHash === srcHashOf(libHash) : libHash === rec.hash) e.reason = 'up-to-date';
      else {
        e.op = 'update';
        e.reason = fromKit ? 'kit-changed' : 'library-changed';
      }
    }
  }
  return plan;
}

// Runs the copy and update entries (live mode) and writes the record once. Every entry is checked again just
// before it is written; a failing entry becomes a skip with its code. The staging copies live in the tool folder
// (<p>/.claude, <p>/.agents), never inside skills/ or agents/; once a new copy is in place the record gets its hash
// even when the old copy could not be deleted (contract §3.7). rows: every row of the record file (readInstalls),
// rewritten with the changes so unusable rows are kept. removeTree: see placeCopy.
// Returns { copied, updated, recordError }.
export function executeInstall({ plan, project, hubDir, installs, rows = installs, now = Date.now, limits = LIMITS, removeTree }) {
  const records = rows.slice();
  let copied = 0;
  let updated = 0;
  for (const e of plan) {
    if (e.op !== 'copy' && e.op !== 'update') continue;
    try {
      if (reparseOnTheWay(e._d)) throw codeError('reparse-point');
      fs.mkdirSync(e._d.group, { recursive: true });
      if (reparseOnTheWay(e._d)) throw codeError('reparse-point');
      const opts = { limits, stageDir: e._d.base, ...(removeTree ? { removeTree } : {}) };
      // A converted agent: its text is written in the staging folder under a staging name (swept if left over), and
      // placed from there as any copy
      let src = e._src;
      let staged = null;
      if (converted(e.target)) {
        if (!e._text) throw codeError('not-convertible');
        staged = path.join(e._d.base, `.sibersentez-tmp-${crypto.randomBytes(6).toString('hex')}`);
        fs.writeFileSync(staged, e._text, { flag: 'wx' });
        src = staged;
      }
      try {
        if (e.op === 'copy') placeCopy(src, e.path, { ...opts, replace: false });
        else placeCopy(src, e.path, { ...opts, replace: true, expectHash: e._rec.hash });
      } finally {
        if (staged) fs.rmSync(staged, { force: true });
      }
      const hash = treeHash(e.path, { limits });
      // A kit copy names the kit, its version and the item's version (so a later kit can offer an update)
      const from = e._kit ? { source: KIT_SOURCE, kitVersion: e._kit.kitVersion, itemVersion: e._kit.itemVersion, kitPath: String(e._rel || '').replace(/^kit\//, '') } : { source: e._rel };
      upsert(records, { project: project.id, target: e.target, kind: e.kind, name: e.name, path: e.path, hash, ...(converted(e.target) ? { srcHash: srcHashOf(e._libHash) } : {}), ...from, installedAt: new Date(now()).toISOString() });
      if (e.op === 'copy') copied++;
      else updated++;
    } catch (err) {
      e.op = 'skip';
      e.reason = errCode(err);
    }
  }
  let recordError = false;
  if (copied || updated) {
    try {
      writeInstalls(hubDir, records);
    } catch {
      recordError = true;
    }
  }
  return { copied, updated, recordError };
}

const errCode = (err) => (typeof err?.code === 'string' && /^[a-z][a-z-]*$/.test(err.code) ? (err.code === 'exists' ? 'project-owned' : err.code) : 'error');

// Remove plan (skills-remove). Only what the record lists for this very destination, and only when unchanged.
// Reasons: unchanged (remove), missing (remove: only the record entry goes), modified, project-owned, not-installed,
// reparse-point.
export function planRemove({ project, dir, items, targets, installs }) {
  const plan = [];
  for (const it of items) {
    // An agent's converted copies go with it: every converted target the record lists for this project and agent,
    // whatever the request named (the page sends claude; a job may have installed .codex or .gemini: review 2026-10-07)
    const recorded = it.kind === 'agent' ? (installs || []).filter((r) => r.project === project.id && r.kind === 'agent' && r.name === it.name && converted(r.target)).map((r) => r.target) : [];
    for (const target of [...new Set([...targetsOf(it.kind, targets), ...recorded])]) {
      const d = destination(dir, it.kind, it.name, target);
      const e = { op: 'skip', kind: it.kind, name: it.name, target, path: d.dest, reason: '' };
      plan.push(e);
      const rec = d.inside ? findRecord(installs, project.id, target, it.kind, it.name, d.dest) : null;
      const st = lstat(d.dest);
      e._rec = rec;
      e._d = d;
      if (!rec) e.reason = st ? 'project-owned' : 'not-installed';
      else if (!st) {
        e.op = 'remove';
        e.reason = 'missing';
      } else if (st.isSymbolicLink() || reparseOnTheWay(d)) e.reason = 'reparse-point';
      else if (!sameHash(treeHash(d.dest), rec.hash)) e.reason = 'modified';
      else {
        e.op = 'remove';
        e.reason = 'unchanged';
      }
    }
  }
  return plan;
}

// Runs the remove entries (live mode): each item is hashed again right before it is deleted. rows: every row of the
// record file (readInstalls), rewritten without the removed ones so unusable rows are kept. Returns { removed,
// forgotten, recordError }.
export function executeRemove({ plan, hubDir, installs, rows = installs }) {
  let records = rows.slice();
  let removed = 0;
  let forgotten = 0;
  for (const e of plan) {
    if (e.op !== 'remove') continue;
    try {
      const st = lstat(e.path);
      if (st) {
        if (st.isSymbolicLink() || reparseOnTheWay(e._d)) throw codeError('reparse-point');
        if (!sameHash(treeHash(e.path), e._rec.hash)) throw codeError('modified');
        fs.rmSync(e.path, { recursive: true, force: false });
        removed++;
      } else forgotten++;
      records = records.filter((r) => r !== e._rec);
    } catch (err) {
      e.op = 'skip';
      e.reason = errCode(err);
    }
  }
  let recordError = false;
  if (removed || forgotten) {
    try {
      writeInstalls(hubDir, records);
    } catch {
      recordError = true;
    }
  }
  return { removed, forgotten, recordError };
}

// ---------------------------------------------------------------------------------------------------------------
// Try without installing (skills-trial)
// ---------------------------------------------------------------------------------------------------------------

// Folder name: <UTC timestamp to the millisecond>-<project slug>
export function trialName(projectId, now) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`;
  const slug =
    String(projectId || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'project';
  return `${stamp}-${slug}`;
}

// Trial plan: the session-only plugin folder <hub>/trials/<name>/ with skills/<name>/ and agents/<name>.md copies
// (from the library, or from the kit: see findSourceItem). Other tools of the project get a skip entry: trials start
// Claude Code only. Returns { dir, plan }.
export function planTrial({ hubDir, projectId, items, library, via = [], now = Date.now(), limits = LIMITS, kit }) {
  const trials = path.join(hubDir, 'trials');
  const name = trialName(projectId, now);
  let dir = path.join(trials, name);
  for (let i = 2; lstat(dir) && i < 1000; i++) dir = path.join(trials, `${name}-${i}`);
  const plan = [];
  for (const it of items) {
    const lib = findSourceItem(library, it.kind, it.name, kit);
    const dest = it.kind === 'skill' ? path.join(dir, 'skills', it.name) : path.join(dir, 'agents', `${it.name}.md`);
    const e = { op: 'skip', kind: it.kind, name: it.name, path: dest, reason: '' };
    plan.push(e);
    if (!lib) e.reason = 'not-in-library';
    else {
      const problem = sizeProblem(measureTree(lib.path, limits), limits);
      if (problem) e.reason = problem;
      else Object.assign(e, { op: 'copy', reason: 'trial', _src: lib.path });
    }
  }
  for (const t of Array.isArray(via) ? via : []) if (t !== 'claude-code') plan.push({ op: 'skip', kind: 'tool', name: t, reason: 'trial-claude-code-only' });
  return { dir, plan };
}

// Builds the trial folder (live mode): the marker first, so even a half-built folder is recognized and cleaned up.
// Throws with a code; a failed build leaves nothing behind.
export function makeTrial({ hubDir, dir, plan, projectId, now = Date.now, limits = LIMITS }) {
  if (isLegacyHub(hubDir)) throw codeError('legacy-hub');
  const trials = path.dirname(dir);
  if (isLink(trials)) throw codeError('reparse-point');
  fs.mkdirSync(trials, { recursive: true });
  if (!isRealDir(trials)) throw codeError('reparse-point');
  fs.mkdirSync(dir);
  try {
    const items = plan.filter((e) => e.op === 'copy').map((e) => ({ kind: e.kind, name: e.name }));
    fs.writeFileSync(path.join(dir, TRIAL_MARKER), JSON.stringify({ sibersentez: 'trial', version: 1, createdAt: new Date(now()).toISOString(), project: projectId, items }, null, 2) + '\n', { flag: 'wx' });
    for (const e of plan) {
      if (e.op !== 'copy') continue;
      fs.mkdirSync(path.dirname(e.path), { recursive: true });
      copyTree(e._src, e.path, limits);
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function readMarker(file) {
  const st = lstat(file);
  if (!st || !st.isFile() || st.size > 64 * 1024) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return m && m.sibersentez === 'trial' && m.version === 1 ? m : null;
  } catch {
    return null;
  }
}

// Server start: removes trial folders older than maxAgeMs that carry the marker. Only real folders named like a trial
// folder directly under <hub>/trials; everything else there is left alone. Never on a legacy hub.
// Returns { removed, kept }.
export function cleanupTrials(hubDir, { now = Date.now(), maxAgeMs = TRIAL_MAX_AGE_MS } = {}) {
  const out = { removed: 0, kept: 0 };
  if (typeof hubDir !== 'string' || !hubDir || isLegacyHub(hubDir)) return out;
  const root = path.join(hubDir, 'trials');
  if (!isRealDir(root)) return out;
  let ents = [];
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of ents) {
    const dir = path.join(root, d.name);
    const marker = d.isDirectory() && TRIAL_RE.test(d.name) ? readMarker(path.join(dir, TRIAL_MARKER)) : null;
    const created = marker ? Date.parse(marker.createdAt) : NaN;
    if (!marker || !Number.isFinite(created) || now - created <= maxAgeMs) {
      out.kept++;
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      out.removed++;
    } catch {
      out.kept++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Staging leftovers (contract §3.7)
// ---------------------------------------------------------------------------------------------------------------

// The tool folders of the recorded installs where a staging copy may be left: <p>/.claude or <p>/.agents (where a
// copy stages now) and its skills/ or agents/ folder (where an older version staged). Only rows shaped like an
// install (…/.claude|.agents/skills|agents/<item>), a local path without a ':' after the drive letter, no link
// anywhere on the way (the real path of the tool folder is the recorded one), never the personal Claude folder.
export function recordStageDirs(installs, { claudeDir = null } = {}) {
  const out = new Map();
  const realClaude = claudeDir ? realPath(claudeDir) : null;
  for (const r of installs) {
    if (!isLocalPath(r.path) || hasStreamColon(r.path) || /[\u0000-\u001f\u007f-\u009f]/.test(r.path)) continue;
    const group = path.dirname(r.path);
    const base = path.dirname(group);
    if (!/^(skills|agents)$/i.test(path.basename(group)) || !/^\.(claude|agents|gemini|qwen|opencode|codex)$/i.test(path.basename(base))) continue;
    if (claudeDir && (within(base, claudeDir) || (realClaude && within(base, realClaude)))) continue;
    const real = realPath(base);
    if (!real || normPath(real) !== normPath(base) || !isRealDir(base)) continue;
    out.set(normPath(base), base);
    if (isRealDir(group)) out.set(normPath(group), group);
  }
  return [...out.values()];
}

// Server start: removes staging leftovers named .sibersentez-(tmp|old)-<12 hex> from the recorded project targets and
// from the hub library. Only entries with exactly that name, only real folders or files, nothing followed. Never
// on a legacy hub. Returns { removed, kept }.
export function sweepLeftovers(hubDir, { claudeDir = null } = {}) {
  const out = { removed: 0, kept: 0 };
  if (typeof hubDir !== 'string' || !hubDir || isLegacyHub(hubDir)) return out;
  const dirs = [...libraryStageDirs(hubDir), ...recordStageDirs(readInstalls(hubDir).installs, { claudeDir })];
  for (const dir of dirs) {
    const r = sweepStaging(dir);
    out.removed += r.removed;
    out.kept += r.kept;
  }
  return out;
}
