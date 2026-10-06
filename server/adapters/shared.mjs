// Helpers shared by the source adapters of tools other than Claude Code (contract docs/adapters-wave1.md).
// Every root is derived from the adapter context only (ctx.homeDir, ctx.env, ctx.appDataDir), never from the real
// home or the process environment, so the tests run against a fake home. Every helper swallows file system errors
// and returns an empty result. Nothing here writes anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normPath } from '../util.mjs';
import { PLAIN_LISTER, exists, folderSpelling, hasEntries, isLocalPath, listDirs, listFiles, mtimeOf, safeDirs, skillDirs, upperDrive } from '../fsutil.mjs';

export { upperDrive };

// ---------------- roots and paths ----------------

// A tool root: an absolute path in the named environment variable (ctx.env), else <home>/<fallback...>
export function envRoot(ctx, name, ...fallback) {
  const v = ctx.env?.[name];
  if (typeof v === 'string' && v.trim() && path.isAbsolute(v.trim())) return path.resolve(v.trim());
  return path.join(ctx.homeDir, ...fallback);
}

// The folder lister of the current pass (one listing per folder, shared by every adapter), else no cache
export const listerOf = (ctx) => ctx?.ls || PLAIN_LISTER;

// A folder path reported by a tool: a local drive-letter path with an upper-case drive letter, else null. This is the
// one filter every project source of these adapters goes through (Codex, Gemini CLI, Copilot, the VS Code-style
// editors): UNC paths (\\server\share, \\wsl$, \\wsl.localhost) and relative paths are skipped (contract §3).
export function cleanPath(p) {
  if (typeof p !== 'string') return null;
  const s = p.trim();
  return isLocalPath(s) ? upperDrive(s) : null;
}

// Local folder of a VS Code-style workspace URI. Only file: URIs have one; remote (vscode-remote://), virtual
// (vscode-vfs://) and other schemes are skipped, and so is a file: URI with a host (file://server/share,
// file://wsl.localhost/...: a UNC path). fileURLToPath decodes %3A, spaces and non-ASCII letters.
export function folderFromUri(uri) {
  if (typeof uri !== 'string' || !/^file:\/\//i.test(uri)) return null;
  try {
    return cleanPath(fileURLToPath(uri));
  } catch {
    return null;
  }
}

// On-disk casing of a path a tool may have stored lower-cased (Gemini CLI): the exact spelling on disk (see
// folderSpelling; a junction on the way is walked by name, never followed), else the stored path as it is (missing,
// ambiguous). null for anything that is not a local drive-letter path.
// readDirs(dir) lists sub folder names (can be memoized by the caller).
export function onDiskCase(stored, readDirs = (d) => listDirs(d, { hidden: true })) {
  const p = cleanPath(stored);
  if (!p) return null;
  return folderSpelling(p, readDirs) || p;
}

// At most `max` bytes of a small text file (a marker, a manifest); null when unreadable
export function readText(file, max = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    let text = buf.toString('utf8', 0, n);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// The first line of a small text file for which match(line) is true, read in small chunks and never past that line:
// reading stops at the line break that ends it, so at most one chunk past it is read into memory, and those bytes
// are never decoded. Lines before it are decoded one by one (only complete lines). Returns { line } (line null when
// no line matches up to the end of the file or `max` bytes), or { error: true } for an I/O error (file locked, access
// denied): the caller must not cache that.
export function readUntilLine(file, match, { chunk = 256, max = 64 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { error: true };
  }
  try {
    const buf = Buffer.alloc(max);
    let len = 0;
    let start = 0; // start of the current (not yet complete) line
    for (;;) {
      const room = max - len;
      const n = room > 0 ? fs.readSync(fd, buf, len, Math.min(chunk, room), len) : 0;
      const eof = n === 0 && room > 0; // the real end of the file, not the read limit
      len += n;
      for (;;) {
        const nl = buf.subarray(0, len).indexOf(0x0a, start);
        // The last line of the file may have no line break; a line cut by the read limit is never decoded
        const end = nl !== -1 ? nl : eof && start < len ? len : -1;
        if (end === -1) break;
        let line = buf.toString('utf8', start, end).replace(/\r$/, '');
        if (start === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
        if (match(line)) return { line };
        start = end + 1;
      }
      if (n === 0) return { line: null };
    }
  } catch {
    return { error: true };
  } finally {
    fs.closeSync(fd);
  }
}

// One project per folder: the newest lastSeenAt wins
export function dedupeProjects(list) {
  const byPath = new Map();
  for (const f of list) {
    const k = normPath(f.path);
    const prev = byPath.get(k);
    if (!prev) byPath.set(k, { ...f });
    else if ((f.lastSeenAt || 0) > (prev.lastSeenAt || 0)) prev.lastSeenAt = f.lastSeenAt;
  }
  return [...byPath.values()];
}

// Does <project>/.claude stand for a personal Claude folder (the Claude Code one, or ~/.claude that other tools
// read as personal)? Then its items are personal, not project items (same rule as the claude-code adapter).
export function isPersonalClaude(projectPath, ctx) {
  const base = normPath(path.join(projectPath, '.claude'));
  return base === normPath(ctx.claudeDir) || base === normPath(path.join(ctx.homeDir, '.claude'));
}

// ---------------- VS Code-style workspaces ----------------

// Working folders of a VS Code-style editor: <appData>/<appName>/User/workspaceStorage/<hash>/workspace.json.
// Only a single-folder workspace ("folder" file: URI) counts; a multi-root workspace ("workspace" key), remote and
// virtual folders are skipped. requireChat: only hash folders whose chatSessions/ or chatEditingSessions/ holds at
// least one entry (readdir only: no chat file is ever opened). lastSeenAt is the hash folder time.
// cache: a Map private to the caller, one per editor; workspace.json is re-read only when its time changes, and the
// entries of files that disappeared are dropped. A read that fails (file locked, access denied) is not cached: the
// file is read again on the next pass.
export function vscodeWorkspaces(appDataDir, appName, { requireChat = false, cache = new Map() } = {}) {
  const root = path.join(appDataDir, appName, 'User', 'workspaceStorage');
  const seen = new Set();
  const out = [];
  for (const hash of listDirs(root, { hidden: true })) {
    const dir = path.join(root, hash);
    const file = path.join(dir, 'workspace.json');
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    seen.add(file);
    let hit = cache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      const r = readJsonFile(file);
      if (r.error) continue;
      const j = r.value;
      hit = { mtimeMs: st.mtimeMs, folder: j && typeof j === 'object' && !Array.isArray(j) ? folderFromUri(j.folder) : null };
      cache.set(file, hit);
    }
    if (!hit.folder) continue;
    if (requireChat && !hasEntries(path.join(dir, 'chatSessions')) && !hasEntries(path.join(dir, 'chatEditingSessions'))) continue;
    out.push({ path: hit.folder, lastSeenAt: mtimeOf(dir) });
  }
  for (const f of cache.keys()) if (!seen.has(f)) cache.delete(f);
  return out;
}

// A JSON file: { value } (value null when the text is not JSON), or { error: true } when it cannot be read
export function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { error: true };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { value: null };
  }
}

// ---------------- items ----------------

export const PERSONAL = Object.freeze({ source: 'personal', category: 'personal', global: true });
export const BUILTIN = Object.freeze({ source: 'builtin', category: 'builtin', global: true });
export const PROJECT = Object.freeze({ source: 'project' });

// Folder listings in the item helpers below go through the lister of the current pass (listerOf(ctx)): a folder read
// by several tools (.agents/skills, .claude/skills, ~/.claude/agents) is listed once per pass.

// Skills: <dir>/*/SKILL.md (a skill is a folder holding SKILL.md; name = frontmatter name, else the folder name).
// depth > 1: SKILL.md folders up to that many levels deep (a folder holding SKILL.md is not descended into).
// skip: top-level folder names left out (e.g. "synced", ".system"). prefix: "<plugin>:" for plugin items.
export function skillItems(dir, ctx, extra, { depth = 1, skip = [], prefix = '' } = {}) {
  const ls = listerOf(ctx);
  const dirs = depth > 1 ? skillDirs(dir, depth, ls) : safeDirs(dir, ls).filter((d) => !skip.includes(d)).map((d) => path.join(dir, d));
  const out = [];
  for (const d of dirs) {
    if (skip.includes(path.basename(d))) continue;
    const file = path.join(d, 'SKILL.md');
    const fm = ctx.frontmatter(file);
    if (!fm) continue;
    out.push({ kind: 'skill', name: prefix + (fm.name || path.basename(d)), path: file, description: fm.description || '', ...extra });
  }
  return out;
}

// Markdown agents directly in a folder: files ending in one of the suffixes (README.md excluded). Name =
// frontmatter name, else the file name without the suffix ("x.agent.md" -> "x").
export function mdAgentItems(dir, ctx, extra, { suffixes = ['.md'], prefix = '' } = {}) {
  const out = [];
  for (const f of listFiles(dir, listerOf(ctx))) {
    const lower = f.toLowerCase();
    const suffix = suffixes.find((s) => lower.endsWith(s) && lower.length > s.length);
    if (!suffix || lower === 'readme.md') continue;
    const file = path.join(dir, f);
    const fm = ctx.frontmatter(file) || {};
    out.push({ kind: 'agent', name: prefix + (fm.name || f.slice(0, -suffix.length)), path: file, description: fm.description || '', ...extra });
  }
  return out;
}

// Agents as <dir>/*.md plus <dir>/<name>/agent.md (name = frontmatter name, else the folder name)
export function agentFolderItems(dir, ctx, extra) {
  const out = mdAgentItems(dir, ctx, extra);
  for (const d of safeDirs(dir, listerOf(ctx))) {
    const file = path.join(dir, d, 'agent.md');
    if (!exists(file)) continue;
    const fm = ctx.frontmatter(file) || {};
    out.push({ kind: 'agent', name: fm.name || d, path: file, description: fm.description || '', ...extra });
  }
  return out;
}

// One plugin of a tool other than Claude Code: the plugin item plus, when asked, the skills and agents inside it,
// named <plugin>:<item>. Such a plugin has no known on/off switch and no Claude Code plugin id (the actions layer
// only understands those): global, no pluginId, no enabled.
export function toolPluginItems(dir, name, toolId, ctx, { description = '', skills = true, agents = false } = {}) {
  const extra = { source: 'plugin', category: toolId, global: true };
  const out = [{ kind: 'plugin', name, path: dir, description, ...extra }];
  const inner = { ...extra, plugin: name };
  if (skills) out.push(...skillItems(path.join(dir, 'skills'), ctx, inner, { prefix: `${name}:` }));
  if (agents) out.push(...mdAgentItems(path.join(dir, 'agents'), ctx, inner, { prefix: `${name}:` }));
  return out;
}

// The string fields of a plugin manifest ({ name, description, ... } trimmed; others left out), read once; {} when
// the manifest is missing, unreadable or not a JSON object
export function manifestFields(file) {
  const j = readJsonFile(file).value;
  const out = {};
  if (j && typeof j === 'object' && !Array.isArray(j)) for (const [k, v] of Object.entries(j)) if (typeof v === 'string') out[k] = v.trim();
  return out;
}

// A manifest's string field, else ''
export function manifestText(file, key) {
  return manifestFields(file)[key] || '';
}
